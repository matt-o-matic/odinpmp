import { INVITATION_LIFETIME_MS, requireOpenInvitation } from '../tenants/workspace-invitations.js';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { authenticator } from 'otplib';
import QRCode from 'qrcode';

import { HttpError } from '../../lib/errors/http-error.js';
import { renderEmailFromTemplate } from '../mail/mail.service.js';
import { SIGNUP_VERIFICATION_TEMPLATE_ID } from '../mail/mail.templates.js';
import { buildOperationLogContext, logBackendError } from '../../lib/logging/backend-logger.js';
import { DEMO_PASSWORD } from './auth.repository.js';

const DEVELOPMENT_DEMO_EMAIL = 'demo@odinpmp.local';
const DEVELOPMENT_DEMO_NAME = 'Demo User';
const DEVELOPMENT_DEMO_TENANT = 'OdinPMP Demo';

function normalizeAuthRedirectTarget(value) {
  const redirectTarget = String(value ?? '').trim();
  if (!redirectTarget || !redirectTarget.startsWith('/') || redirectTarget.startsWith('//')) {
    return '';
  }

  return redirectTarget;
}

function buildFrontendRedirectUrl(frontendAppUrl, path, searchParams) {
  const base = String(frontendAppUrl ?? '').trim().replace(/\/$/, '');
  const normalizedPath = String(path ?? '').startsWith('/') ? String(path) : `/${String(path ?? '')}`;
  const query = searchParams?.toString?.() ?? '';
  return `${base}${normalizedPath}${query ? `?${query}` : ''}`;
}

function appendAuthRedirect(searchParams, redirectTarget) {
  const normalizedRedirectTarget = normalizeAuthRedirectTarget(redirectTarget);
  if (normalizedRedirectTarget) {
    searchParams.set('redirect', normalizedRedirectTarget);
  }

  return searchParams;
}

function buildScopes(user) {
  return (user.memberships ?? [])
    .flatMap((membership) => {
      const scopes = [];

      if (membership.tenantId && membership.role) {
        scopes.push(`T${membership.tenantId}-${membership.role}`);
      }

      return scopes;
    });
}

function primaryMembership(user) {
  return user?.memberships?.[0] ?? null;
}

function getPrimaryMembership(user) {
  return user.memberships?.[0] ?? null;
}

function getEmailDomain(email) {
  return String(email ?? '').trim().split('@')[1]?.toLowerCase() ?? '';
}

function logAuthOperationFailure({ error, operation, user = null, extra = {} }) {
  logBackendError({
    context: buildOperationLogContext(operation, {
      tenantId: primaryMembership(user)?.tenantId ?? null,
      userId: user?.id ?? null,
      ...extra,
    }),
    error,
    level: 'warn',
    message: 'Auth operation failed.',
  });
}

export async function serializeAuthUser(user, repository, { activeTenantId = '' } = {}) {
  const membership = user.memberships?.find((item) => item.tenantId === activeTenantId)
    ?? getPrimaryMembership(user);
  const tenant = membership ? await repository.findTenantById(membership.tenantId) : null;
  const tenants = await Promise.all((user.memberships ?? []).map(async (item) => ({
    id: item.tenantId,
    name: (await repository.findTenantById(item.tenantId))?.name ?? item.tenantId,
    role: item.role,
  })));

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    authMethod: user.authMethod,
    picture: user.picture ?? '',
    tenantId: membership?.tenantId ?? null,
    tenantName: tenant?.name ?? null,
    tenants,
    role: membership?.role ?? null,
    scopes: buildScopes(user),
    preferences: {
      twoFactorEnabled: Boolean(user.preferences?.twoFactorEnabled),
    },
  };
}

function isBasicUser(user) {
  return user.authMethod === 'basic';
}

// A stakeholder's file-owner account has no sign-in of its own (see stakeholder-accounts.js).
function assertCanSignIn(user) {
  if (user?.loginDisabled) throw new HttpError(401, 'This account cannot sign in.');
}

function sessionIdFromTokenPayload(payload) {
  return typeof payload?.jti === 'string' ? payload.jti : '';
}

function expiryDateFromTokenPayload(payload, fallbackMs = 60 * 60 * 24 * 1000) {
  return typeof payload?.exp === 'number'
    ? new Date(payload.exp * 1000)
    : new Date(Date.now() + fallbackMs);
}

function buildSignedSession(authUser, tokenService, sessionId) {
  const token = tokenService.signSessionToken(authUser, { sessionId });
  const refreshToken = tokenService.signRefreshToken(authUser, { sessionId });
  const refreshPayload = tokenService.verifyRefreshToken(refreshToken);

  return {
    expiryDate: expiryDateFromTokenPayload(refreshPayload),
    session: {
      refreshToken,
      token,
      user: authUser,
    },
  };
}

async function persistSessionToken({ expiryDate, id, ipAddr, locationName, sessionsRepository, token, userAgent, userId }) {
  await sessionsRepository.createSession({
    expiryDate,
    id,
    ipAddr,
    locationName,
    token,
    userAgent,
    userId,
  });
}

async function buildSession({ activeTenantId = '', ipAddr, locationName, repository, sessionsRepository, tokenService, user, userAgent }) {
  assertCanSignIn(user);
  const authUser = await serializeAuthUser(user, repository, { activeTenantId });
  const sessionId = randomUUID();
  const signedSession = buildSignedSession(authUser, tokenService, sessionId);

  await persistSessionToken({
    expiryDate: signedSession.expiryDate,
    id: sessionId,
    ipAddr,
    locationName,
    sessionsRepository,
    token: signedSession.session.refreshToken,
    userAgent,
    userId: authUser.id,
  });

  return signedSession.session;
}

export async function createEnterpriseSession({ activeTenantId, ipAddr = '', locationName = '', repository, sessionsRepository, tokenService, userId, userAgent = '' }) {
  const user = await repository.findUserById(userId);
  if (!user?.memberships?.some((membership) => membership.tenantId === activeTenantId)) throw new HttpError(401, 'Enterprise identity membership is unavailable.');
  return buildSession({ activeTenantId, ipAddr, locationName, repository, sessionsRepository, tokenService, user, userAgent });
}

async function rotateSession({
  activeTenantId = '',
  repository,
  sessionsRepository,
  sessionId,
  tokenService,
  user,
}) {
  const authUser = await serializeAuthUser(user, repository, { activeTenantId });
  const signedSession = buildSignedSession(authUser, tokenService, sessionId);
  const rotated = await sessionsRepository.rotateRefreshToken({
    expiryDate: signedSession.expiryDate,
    refreshToken: signedSession.session.refreshToken,
    sessionId,
    userId: user.id,
  });

  if (!rotated) {
    throw new HttpError(401, 'Session is no longer valid.');
  }

  return {
    ok: true,
    session: signedSession.session,
  };
}

export async function loginWithPassword(input, repository, tokenService, sessionsRepository, sessionMeta) {
  const user = await repository.findUserByEmail(input.email);

  if (!user) {
    return {
      code: 'needs_registration',
      ok: false,
    };
  }

  if (!isBasicUser(user)) {
    throw new HttpError(401, 'Authentication method mismatch.');
  }

  const passwordMatches = await bcrypt.compare(input.password, user.passwordHash ?? '');

  if (!passwordMatches) {
    throw new HttpError(401, 'Invalid email or password.');
  }

  const authUser = await serializeAuthUser(user, repository);

  if (authUser.preferences.twoFactorEnabled) {
    return {
      challengeToken: tokenService.signTwoFactorChallenge(authUser),
      ok: true,
      requiresTwoFactor: true,
    };
  }

  let session;

  try {
    session = await buildSession({
      ...sessionMeta,
      repository,
      sessionsRepository,
      tokenService,
      user,
    });
  } catch (error) {
    logAuthOperationFailure({
      error,
      extra: {
        authMethod: 'basic',
        emailDomain: getEmailDomain(input.email),
      },
      operation: 'auth.loginWithPassword',
      user,
    });
    throw error;
  }

  return {
    ok: true,
    session,
  };
}

// The caller never picks a role or names a workspace to join. A new workspace's creator is its admin.
// Joining without an invitation needs a verified Google email on the workspace's domain, and joins as a user.
async function checkRegistration(input, repository, { googleVerifiedEmail = '' } = {}) {
  if (input.authMethod === 'google') {
    if (!googleVerifiedEmail) {
      throw new HttpError(401, 'Sign in with Google before creating a Google account.');
    }
    if (googleVerifiedEmail.toLowerCase() !== input.email.toLowerCase()) {
      throw new HttpError(403, 'The Google account email does not match this registration.');
    }
  }
  const existingWorkspace = await repository.findTenantByDomain(getEmailDomain(input.email));
  if (input.createTenant && existingWorkspace) {
    throw new HttpError(409, input.authMethod === 'google'
      ? 'This email domain already has a workspace. Join that workspace instead.'
      : 'This email domain already has a workspace. Ask one of its admins for an invitation.');
  }
  if (!input.createTenant) {
    if (input.authMethod !== 'google') {
      throw new HttpError(403, 'Ask a workspace admin for an invitation to join an existing workspace.');
    }
    if (!existingWorkspace || existingWorkspace.name.toLowerCase() !== input.tenantName.toLowerCase()) {
      throw new HttpError(403, 'Your Google account cannot join this workspace.');
    }
  }
  if (await repository.findUserByEmail(input.email)) {
    throw new HttpError(409, 'Email is already in use.');
  }
  return {
    ...input,
    role: input.createTenant ? 'admin' : 'user',
    tenantId: input.createTenant ? null : existingWorkspace.id,
  };
}

async function createAccount(input, passwordHash, { repository, sessionMeta, sessionsRepository, tokenService }) {
  let registration;
  let session;

  try {
    registration = await repository.createRegistration({ ...input, passwordHash });
    session = await buildSession({
      ...sessionMeta,
      repository,
      sessionsRepository,
      tokenService,
      user: registration.user,
    });
  } catch (error) {
    logAuthOperationFailure({
      error,
      extra: {
        authMethod: input.authMethod,
        createTenant: Boolean(input.createTenant),
        emailDomain: getEmailDomain(input.email),
        role: input.role ?? null,
        tenantName: input.tenantName ?? null,
      },
      operation: 'auth.registerAccount',
      user: registration?.user ?? null,
    });
    throw error;
  }

  return {
    ok: true,
    session,
  };
}

export async function registerAccount(input, repository, tokenService, sessionsRepository, sessionMeta, { googleVerifiedEmail = '' } = {}) {
  const registration = await checkRegistration(input, repository, { googleVerifiedEmail });
  if (registration.authMethod === 'basic' && registration.password.length < 8) {
    throw new HttpError(400, 'Password must be at least 8 characters.');
  }
  const passwordHash = await bcrypt.hash(registration.password || randomBytes(24).toString('hex'), 10);
  return createAccount(registration, passwordHash, { repository, sessionMeta, sessionsRepository, tokenService });
}

const SIGNUP_VERIFICATION_LIFETIME_MS = 24 * 60 * 60 * 1000;

function hashSignupToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function escapeEmailText(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

// A password sign-up creates nothing until its emailed link is used; see completePasswordRegistration.
export async function startPasswordRegistration(input, { frontendAppUrl, mailRepository, repository }) {
  const registration = await checkRegistration({ ...input, authMethod: 'basic' }, repository);
  if (registration.password.length < 8) {
    throw new HttpError(400, 'Password must be at least 8 characters.');
  }
  if (!mailRepository?.queueMail) {
    throw new HttpError(503, 'Sign-up email is unavailable. Please try again later.');
  }
  if (await mailRepository.isOptedOut?.({ email: registration.email })) {
    throw new HttpError(409, 'Email delivery to this address is blocked after an opt-out or delivery failure.');
  }

  const token = randomBytes(32).toString('base64url');
  const pending = await repository.savePendingRegistration({
    email: registration.email,
    expiresAt: new Date(Date.now() + SIGNUP_VERIFICATION_LIFETIME_MS),
    name: registration.name,
    passwordHash: await bcrypt.hash(registration.password, 10),
    tenantName: registration.tenantName,
    tokenHash: hashSignupToken(token),
  });
  const base = String(frontendAppUrl || 'http://localhost:5173/app').replace(/\/$/, '');
  // The token travels in the URL fragment, so it stays out of server logs and Referer headers.
  const rendered = await renderEmailFromTemplate({
    mailRepository,
    templateId: SIGNUP_VERIFICATION_TEMPLATE_ID,
    vars: {
      name: escapeEmailText(registration.name),
      verificationUrl: escapeEmailText(`${base}/verify-email#${token}`),
      workspaceName: escapeEmailText(registration.tenantName),
    },
  });
  try {
    await mailRepository.queueMail({
      ...rendered,
      recipientEmail: registration.email,
      targetId: `signup:${pending.id}`,
      templateId: SIGNUP_VERIFICATION_TEMPLATE_ID,
    });
  } catch (error) {
    logAuthOperationFailure({ error, extra: { emailDomain: getEmailDomain(registration.email) }, operation: 'auth.startPasswordRegistration' });
    throw new HttpError(503, 'We couldn’t send the confirmation email. Try again in a moment.');
  }

  return {
    email: registration.email,
    ok: true,
    verificationRequired: true,
  };
}

export async function completePasswordRegistration(token, { repository, sessionMeta, sessionsRepository, tokenService }) {
  const pending = await repository.takePendingRegistration(hashSignupToken(token));
  if (!pending || pending.expiresAt <= new Date()) {
    throw new HttpError(410, 'This link has expired or was already used. Sign up again to get a new one.');
  }
  // Checked again because the email or its domain may have been claimed since the sign-up started.
  const registration = await checkRegistration({
    authMethod: 'basic',
    createTenant: true,
    email: pending.email,
    name: pending.name,
    password: '',
    tenantName: pending.tenantName,
  }, repository);
  return createAccount(registration, pending.passwordHash, { repository, sessionMeta, sessionsRepository, tokenService });
}

export async function ensureDevelopmentDemoUser(repository) {
  if (!repository?.findUserByEmail || !repository?.createRegistration) {
    return {
      created: false,
      user: null,
    };
  }

  const existingUser = await repository.findUserByEmail(DEVELOPMENT_DEMO_EMAIL);
  if (existingUser) {
    return {
      created: false,
      user: existingUser,
    };
  }

  const existingTenant = await repository.findTenantByName?.(DEVELOPMENT_DEMO_TENANT);

  const registration = await repository.createRegistration({
    authMethod: 'basic',
    createTenant: !existingTenant,
    email: DEVELOPMENT_DEMO_EMAIL,
    name: DEVELOPMENT_DEMO_NAME,
    passwordHash: await bcrypt.hash(DEMO_PASSWORD, 10),
    role: 'admin',
    tenantId: existingTenant?.id ?? null,
    tenantName: existingTenant?.name ?? DEVELOPMENT_DEMO_TENANT,
  });

  return {
    created: true,
    user: registration.user,
  };
}

export async function getRegistrationAvailability(input, repository) {
  const emailAvailable = await repository.isEmailAvailable(input.email);
  const domain = input.email.split('@')[1]?.toLowerCase() ?? '';
  const tenant = domain ? await repository.findTenantByDomain(domain) : null;
  const tenantNameAvailable = input.tenantName
    ? await repository.isTenantNameAvailable(input.tenantName)
    : true;

  return {
    ok: true,
    availability: {
      domain,
      emailAvailable,
      tenant: tenant
        ? {
            id: tenant.id,
            name: tenant.name,
            status: 'claimed',
          }
        : {
            id: null,
            name: input.tenantName || domain.replace(/\.[^.]+$/, ''),
            status: 'unclaimed',
          },
      tenantNameAvailable,
    },
  };
}

export async function getCurrentUser(userId, repository, { activeTenantId = '' } = {}) {
  const user = await repository.findUserById(userId);

  if (!user) {
    throw new HttpError(404, 'User not found.');
  }

  return {
    ok: true,
    user: await serializeAuthUser(user, repository, { activeTenantId }),
  };
}

export async function keepSessionAlive(userId, tokenService, repository, sessionsRepository, currentToken) {
  const currentPayload = tokenService.verifySessionToken(currentToken);
  const sessionId = sessionIdFromTokenPayload(currentPayload);
  const user = await repository.findUserById(userId);

  if (!user) {
    throw new HttpError(401, 'Session is no longer valid.');
  }

  const authUser = await serializeAuthUser(user, repository, { activeTenantId: currentPayload.tenantId });
  if (sessionId) {
    const sessionRecord = await sessionsRepository.validateSession({ sessionId, userId });

    if (!sessionRecord.ok || !sessionRecord.session) {
      throw new HttpError(401, 'Session is no longer valid.');
    }

    if (!tokenService.shouldRefreshSession(currentToken)) {
      return {
        ok: true,
        session: {
          refreshToken: sessionRecord.session.token,
          token: currentToken,
          user: authUser,
        },
      };
    }

    try {
      return await rotateSession({
        repository,
        sessionId,
        sessionsRepository,
        tokenService,
        user,
      });
    } catch (error) {
      logAuthOperationFailure({
        error,
        extra: {
          currentTokenPresent: Boolean(currentToken),
          refreshedSession: true,
        },
        operation: 'auth.keepSessionAlive',
        user,
      });
      throw error;
    }
  }

  let token = currentToken;

  if (tokenService.shouldRefreshSession(currentToken)) {
    try {
      token = tokenService.signSessionToken(authUser);
      const refreshed = tokenService.verifySessionToken(token);
      const newExpiryDate = expiryDateFromTokenPayload(refreshed, 60 * 60 * 1000);

      await sessionsRepository.refreshToken({
        newExpiryDate,
        newToken: token,
        oldToken: currentToken,
        userId,
      });
    } catch (error) {
      logAuthOperationFailure({
        error,
        extra: {
          currentTokenPresent: Boolean(currentToken),
          refreshedSession: true,
        },
        operation: 'auth.keepSessionAlive',
        user,
      });
      throw error;
    }
  }

  return {
    ok: true,
    session: {
      token,
      user: authUser,
    },
  };
}

export async function refreshSessionWithToken(input, repository, tokenService, sessionsRepository) {
  let refreshPayload;

  try {
    refreshPayload = tokenService.verifyRefreshToken(input.refreshToken);
  } catch (_error) {
    throw new HttpError(401, 'Refresh token is invalid or expired.');
  }

  const sessionId = sessionIdFromTokenPayload(refreshPayload);

  if (!sessionId) {
    throw new HttpError(401, 'Refresh token is invalid or expired.');
  }

  const sessionRecord = await sessionsRepository.validateRefreshToken({
    refreshToken: input.refreshToken,
    sessionId,
    userId: refreshPayload.sub,
  });

  if (!sessionRecord.ok || !sessionRecord.session) {
    throw new HttpError(401, 'Session is no longer valid.');
  }

  const user = await repository.findUserById(refreshPayload.sub);

  if (!user) {
    throw new HttpError(401, 'Session is no longer valid.');
  }

  // The token this session just replaced (REFRESH_GRACE_SECONDS): another refresh won the race,
  // or its answer was lost. Hand back the session's current refresh token with a new access
  // token, without rotating again, so every racer ends up with the same cookies.
  if (sessionRecord.grace) {
    const authUser = await serializeAuthUser(user, repository, { activeTenantId: refreshPayload.tenantId });
    return {
      ok: true,
      session: {
        refreshToken: sessionRecord.session.token,
        token: tokenService.signSessionToken(authUser, { sessionId }),
        user: authUser,
      },
    };
  }

  try {
    return await rotateSession({
      activeTenantId: refreshPayload.tenantId,
      repository,
      sessionId,
      sessionsRepository,
      tokenService,
      user,
    });
  } catch (error) {
    logAuthOperationFailure({
      error,
      extra: {
        refreshedSession: true,
        sessionId,
      },
      operation: 'auth.refreshSessionWithToken',
      user,
    });
    throw error;
  }
}

export async function switchTenantSession({
  repository,
  sessionId,
  sessionsRepository,
  tenantId,
  tokenService,
  userId,
}) {
  if (!sessionId) {
    throw new HttpError(401, 'Session is no longer valid.');
  }
  const user = await repository.findUserById(userId);
  if (!user?.memberships?.some((membership) => membership.tenantId === tenantId)) {
    throw new HttpError(404, 'Tenant membership not found.');
  }
  const result = await rotateSession({
    activeTenantId: tenantId,
    repository,
    sessionId,
    sessionsRepository,
    tokenService,
    user,
  });
  return { ...result, switchedTenantId: tenantId };
}

export async function initializeTwoFactor(userId, repository) {
  const user = await repository.findUserById(userId);

  if (!user) {
    throw new HttpError(404, 'User not found.');
  }

  const secret = authenticator.generateSecret();
  const otpAuthUrl = authenticator.keyuri(user.email, 'OdinPMP', secret);
  const qrCodeData = await QRCode.toDataURL(otpAuthUrl);

  try {
    await repository.setPendingTwoFactorSecret(userId, secret);
  } catch (error) {
    logAuthOperationFailure({
      error,
      extra: {
        emailDomain: getEmailDomain(user.email),
      },
      operation: 'auth.initializeTwoFactor',
      user,
    });
    throw error;
  }

  return {
    ok: true,
    qrCodeData,
  };
}

function generateBackupCode() {
  return randomBytes(5).toString('hex').toUpperCase();
}

export async function enableTwoFactor(userId, code, repository) {
  const secret = await repository.getPendingTwoFactorSecret(userId);

  if (!secret) {
    throw new HttpError(400, 'No 2FA setup is pending for this account.');
  }

  if (!authenticator.check(code, secret)) {
    throw new HttpError(400, 'Invalid 2FA code.');
  }

  const backupCodes = Array.from({ length: 8 }, () => generateBackupCode());
  const user = await repository.findUserById?.(userId);

  try {
    await repository.enableTwoFactor(userId, {
      backupCodes,
      secret,
    });
  } catch (error) {
    logAuthOperationFailure({
      error,
      extra: {
        backupCodeCount: backupCodes.length,
      },
      operation: 'auth.enableTwoFactor',
      user,
    });
    throw error;
  }

  return {
    ok: true,
    backupCodes,
  };
}

export async function getBackupCodes(userId, repository) {
  return {
    ok: true,
    backupCodes: await repository.getBackupCodes(userId),
  };
}

export async function disableTwoFactor(userId, repository) {
  const user = await repository.findUserById?.(userId);

  try {
    await repository.disableTwoFactor(userId);
  } catch (error) {
    logAuthOperationFailure({
      error,
      operation: 'auth.disableTwoFactor',
      user,
    });
    throw error;
  }

  return {
    ok: true,
  };
}

export async function verifyTwoFactorLogin(input, repository, tokenService, sessionsRepository, sessionMeta) {
  let challenge;

  try {
    challenge = tokenService.verifyTwoFactorChallenge(input.challengeToken);
  } catch (_error) {
    throw new HttpError(401, 'Two-factor challenge is invalid or expired.');
  }

  const user = await repository.findUserById(challenge.sub);

  if (!user) {
    throw new HttpError(401, 'Two-factor challenge is invalid or expired.');
  }

  const secret = await verifyUserTwoFactorCode(user.id, input.code, repository);

  let session;

  try {
    session = await buildSession({
      ...sessionMeta,
      repository,
      sessionsRepository,
      tokenService,
      user,
    });
  } catch (error) {
    logAuthOperationFailure({
      error,
      extra: {
        backupCodeAttempt: !secret || !authenticator.check(input.code, secret),
      },
      operation: 'auth.verifyTwoFactorLogin',
      user,
    });
    throw error;
  }

  return {
    ok: true,
    session,
  };
}

async function verifyUserTwoFactorCode(userId, code, repository) {
  const secret = await repository.getTwoFactorSecret(userId);
  if ((secret && authenticator.check(code, secret)) || await repository.consumeBackupCode(userId, code)) return secret;
  throw new HttpError(400, 'Invalid two-factor code.');
}

function assertBreakGlassEligibility({ policy, tenantId, user }) {
  const membership = user?.memberships?.find((item) => item.tenantId === tenantId);
  if (
    !policy?.enabled
    || !policy.userIds?.includes(user?.id)
    || user?.authMethod !== 'basic'
    || membership?.role !== 'admin'
    || !user?.preferences?.twoFactorEnabled
  ) {
    throw new HttpError(403, 'Emergency access is unavailable for this account.');
  }
}

export async function startBreakGlassLogin({ input, identityRepository, repository, tokenService }) {
  const user = await repository.findUserByEmail(input.email);
  if (!user || !await bcrypt.compare(input.password, user.passwordHash ?? '')) throw new HttpError(401, 'Invalid email or password.');
  const candidates = [];
  for (const membership of user.memberships ?? []) {
    if (input.tenantId && membership.tenantId !== input.tenantId) continue;
    const policy = await identityRepository.getBreakGlassPolicy({ tenantId: membership.tenantId });
    if (policy?.enabled && policy.userIds?.includes(user.id)) candidates.push({ policy, tenantId: membership.tenantId });
  }
  if (candidates.length > 1) throw new HttpError(400, 'Specify the tenantId for emergency access.');
  const { policy = null, tenantId = '' } = candidates[0] ?? {};
  assertBreakGlassEligibility({ policy, tenantId, user });
  const authUser = await serializeAuthUser(user, repository, { activeTenantId: tenantId });
  return {
    challengeToken: tokenService.signBreakGlassChallenge(authUser, { policyVersion: policy.version, reason: input.reason }),
    ok: true,
    requiresTwoFactor: true,
  };
}

export async function verifyBreakGlassLogin({ input, identityRepository, repository, sessionMeta, sessionsRepository, tokenService }) {
  let challenge;
  try { challenge = tokenService.verifyBreakGlassChallenge(input.challengeToken); }
  catch { throw new HttpError(401, 'Emergency access challenge is invalid or expired.'); }
  const user = await repository.findUserById(challenge.sub);
  const tenantId = String(challenge.tenantId ?? '');
  const policy = tenantId ? await identityRepository.getBreakGlassPolicy({ tenantId }) : null;
  assertBreakGlassEligibility({ policy, tenantId, user });
  if (policy.version !== challenge.policyVersion) throw new HttpError(401, 'Emergency access policy changed; restart authentication.');
  await verifyUserTwoFactorCode(user.id, input.code, repository);
  const authUser = await serializeAuthUser(user, repository, { activeTenantId: tenantId });
  authUser.capabilities = await identityRepository.resolveUserCapabilities({ tenantId, userId: user.id });
  const sessionId = randomUUID();
  const expiresInSeconds = policy.maxSessionMinutes * 60;
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
  const token = tokenService.signBreakGlassSessionToken(authUser, { expiresInSeconds, policyVersion: policy.version, reason: challenge.reason, sessionId });
  await sessionsRepository.createSession({ expiryDate: expiresAt, id: sessionId, token: '', userId: user.id, ...sessionMeta });
  return {
    breakGlass: { expiresAt: expiresAt.toISOString(), policyVersion: policy.version, reason: challenge.reason },
    ok: true,
    session: { token, user: authUser },
  };
}

export async function handleGoogleCallback({
  assertLoginAllowed = null,
  code,
  frontendAppUrl,
  googleOAuthClient,
  redirectTarget,
  repository,
  sessionsRepository,
  sessionMeta,
  tokenService,
}) {
  let profile;

  try {
    profile = await googleOAuthClient.getUserInfoFromCode(code);
  } catch (error) {
    if (!error?.googleOAuthStage) {
      error.googleOAuthStage = 'oauth_exchange';
    }
    throw error;
  }

  if (!profile?.email || profile.emailVerified !== true) {
    const error = new Error('Google did not provide a verified email address.');
    error.googleOAuthStage = 'profile_email';
    throw error;
  }
  await assertLoginAllowed?.(profile.email);

  let user;
  try {
    user = await repository.findUserByEmail(profile.email);
  } catch (error) {
    error.googleOAuthStage = error?.googleOAuthStage || 'user_lookup';
    throw error;
  }

  if (!user) {
    const searchParams = appendAuthRedirect(
      new URLSearchParams({
        auth: 'google',
        email: profile.email,
        name: profile.name,
      }),
      redirectTarget,
    );
    return {
      registrationProfile: { email: profile.email },
      redirectTo: buildFrontendRedirectUrl(frontendAppUrl, '/register', searchParams),
    };
  }
  // Before any two-factor challenge, which would otherwise be issued for the account.
  assertCanSignIn(user);

  let authUser;
  try {
    authUser = await serializeAuthUser(user, repository);
  } catch (error) {
    error.googleOAuthStage = error?.googleOAuthStage || 'session_user';
    throw error;
  }

  if (authUser.preferences.twoFactorEnabled) {
    const challengeToken = tokenService.signTwoFactorChallenge(authUser);
    const searchParams = appendAuthRedirect(
      new URLSearchParams({
        requiresTwoFactor: '1',
      }),
      redirectTarget,
    );
    return {
      challengeToken,
      redirectTo: buildFrontendRedirectUrl(frontendAppUrl, '/oauth/callback', searchParams),
    };
  }

  let session;
  try {
    session = await buildSession({
      ...sessionMeta,
      repository,
      sessionsRepository,
      tokenService,
      user,
    });
  } catch (error) {
    logAuthOperationFailure({
      error,
      extra: {
        authMethod: 'google',
        emailDomain: getEmailDomain(profile.email),
        googleOAuthStage: error?.googleOAuthStage || 'session_persist',
        redirectTarget: normalizeAuthRedirectTarget(redirectTarget) || null,
      },
      operation: 'auth.handleGoogleCallback',
      user,
    });
    error.googleOAuthStage = error?.googleOAuthStage || 'session_persist';
    throw error;
  }

  const searchParams = appendAuthRedirect(new URLSearchParams(), redirectTarget);
  return {
    redirectTo: buildFrontendRedirectUrl(frontendAppUrl, '/oauth/callback', searchParams),
    session,
  };
}

export async function getWorkspaceInvitation(inviteToken, tenantsRepository, authRepository) {
  const invitation = requireOpenInvitation(await tenantsRepository?.findInviteByToken({ inviteToken }));
  return { ok: true, invitation: {
    email: invitation.email, role: invitation.role, workspaceName: invitation.tenantName,
    expiresAt: new Date(new Date(invitation.invitedAt).getTime() + INVITATION_LIFETIME_MS).toISOString(),
    accountExists: Boolean(await authRepository.findUserByEmail(invitation.email)),
  } };
}

export async function acceptWorkspaceInvitation({ inviteToken, registration, user, tenantsRepository, authRepository, tokenService, sessionsRepository, sessionMeta }) {
  const input = registration ? { name: registration.name, passwordHash: await bcrypt.hash(registration.password, 10) } : undefined;
  const accepted = await tenantsRepository.acceptInvite({ inviteToken, registration: input, userId: user?.id });
  const joinedUser = await authRepository.findUserById(accepted.userId);
  const session = await buildSession({ ...sessionMeta, activeTenantId: accepted.tenantId, repository: authRepository, sessionsRepository, tokenService, user: joinedUser });
  return { ok: true, session };
}
