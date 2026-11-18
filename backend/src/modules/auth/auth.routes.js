import { Router } from 'express';

import { createAuthMiddleware } from '../../lib/http/auth-middleware.js';
import {
  AUTH_COOKIE_NAMES,
  clearGoogleRegistrationCookie,
  clearSessionCookies,
  clearTwoFactorCookie,
  getAuthCookie,
  issueSessionCookies,
  issueGoogleRegistrationCookie,
  issueTwoFactorCookie,
  publicSessionResult,
  requireCsrfForCookieAuth,
} from '../../lib/auth/auth-cookies.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { getLocationNameForIp, getRequestIp, getRequestUserAgent } from '../../lib/http/request-meta.js';
import { buildRequestLogContext, logBackendError, logBackendEvent } from '../../lib/logging/backend-logger.js';
import {
  availabilitySchema,
  breakGlassStartSchema,
  breakGlassVerifySchema,
  loginSchema,
  invitedRegistrationSchema,
  refreshSessionSchema,
  registerSchema,
  switchTenantSchema,
  twoFactorCodeSchema,
  twoFactorVerifySchema,
  verifyRegistrationSchema,
} from './auth.schema.js';
import {
  disableTwoFactor,
  getWorkspaceInvitation,
  acceptWorkspaceInvitation,
  completePasswordRegistration,
  enableTwoFactor,
  getBackupCodes,
  getCurrentUser,
  getRegistrationAvailability,
  handleGoogleCallback,
  initializeTwoFactor,
  keepSessionAlive,
  loginWithPassword,
  refreshSessionWithToken,
  registerAccount,
  startPasswordRegistration,
  switchTenantSession,
  startBreakGlassLogin,
  verifyBreakGlassLogin,
  verifyTwoFactorLogin,
} from './auth.service.js';

function normalizeGoogleRedirectTarget(value) {
  const redirectTarget = String(value ?? '').trim();
  if (!redirectTarget || !redirectTarget.startsWith('/') || redirectTarget.startsWith('//')) {
    return '';
  }

  return redirectTarget;
}

function buildFrontendAuthUrl(frontendAppUrl, path, searchParams) {
  const base = String(frontendAppUrl ?? '').trim().replace(/\/$/, '');
  const normalizedPath = String(path ?? '').startsWith('/') ? String(path) : `/${String(path ?? '')}`;
  const query = searchParams?.toString?.() ?? '';
  return `${base}${normalizedPath}${query ? `?${query}` : ''}`;
}

function classifyGoogleCallbackRedirect(redirectTo, frontendAppUrl) {
  try {
    const redirectUrl = new URL(redirectTo, frontendAppUrl);
    const pathname = redirectUrl.pathname || '';

    if (pathname.endsWith('/register')) {
      return 'register';
    }

    if (pathname.endsWith('/oauth/callback')) {
      return redirectUrl.searchParams.has('requiresTwoFactor') ? 'two_factor' : 'session';
    }

    if (pathname.endsWith('/login')) {
      return 'login';
    }
  } catch (_error) {
    return 'unknown';
  }

  return 'unknown';
}

function wantsBearerResponse(request) {
  return String(request.headers?.['x-auth-response'] ?? '').trim().toLowerCase() === 'bearer';
}

async function attachResolvedCapabilities(result, identityRepository) {
  const user = result?.session?.user ?? result?.user;
  const tenantId = String(user?.tenantId ?? '').trim();
  user.capabilities = identityRepository?.resolveUserCapabilities && tenantId && user?.id
    ? await identityRepository.resolveUserCapabilities({ tenantId, userId: user.id })
    : [];
  return result;
}

async function sendSessionResult(request, response, status, result, tokenService, identityRepository) {
  await attachResolvedCapabilities(result, identityRepository);
  if (wantsBearerResponse(request)) {
    response.status(status).json(result);
    return;
  }
  issueSessionCookies(response, result.session, tokenService);
  response.status(status).json(publicSessionResult(result));
}

export function createAuthRouter({
  authRepository,
  enterpriseOidcService,
  frontendAppUrl,
  googleOAuthClient,
  identityRepository,
  mailRepository,
  sessionsRepository,
  signupCaptcha = null,
  tenantsRepository,
  tokenService,
}) {
  const router = Router();
  const requireAuth = createAuthMiddleware({ authRepository, tokenService });

  // Runs before any sign-up does work. Returns the payload without the guard fields.
  async function assertHumanSignup(request, { recaptchaToken, website, ...payload }) {
    if (website) {
      logBackendEvent({ context: buildRequestLogContext(request), level: 'warn', message: 'Sign-up rejected: honeypot field was filled.' });
      throw new HttpError(400, 'We couldn’t process this sign-up.');
    }
    await signupCaptcha?.verify({ remoteIp: getRequestIp(request), token: recaptchaToken });
    return payload;
  }

  function sessionMetaFor(request) {
    const ipAddr = getRequestIp(request);
    return { ipAddr, locationName: getLocationNameForIp(ipAddr), userAgent: getRequestUserAgent(request) };
  }

  router.get('/invites/:inviteToken', async (request, response, next) => {
    try {
      response.set('Cache-Control', 'no-store').json(await getWorkspaceInvitation(request.params.inviteToken, tenantsRepository, authRepository));
    } catch (error) { next(error); }
  });

  async function acceptInvitation(request, response, next, registration) {
    try {
      if (request.auth?.impersonation || request.auth?.breakGlass) throw new HttpError(403, 'Use your own regular sign-in session to accept an invitation.');
      const info = await getWorkspaceInvitation(request.params.inviteToken, tenantsRepository, authRepository);
      if (registration) {
        await enterpriseOidcService?.assertPasswordLoginAllowed({ email: info.invitation.email });
        const invitation = await tenantsRepository.findInviteByToken({ inviteToken: request.params.inviteToken });
        const policy = await identityRepository?.getPolicy?.({ tenantId: invitation.tenantId });
        if (policy?.loginEnforcement === 'required' && policy.ssoMode !== 'none') throw new HttpError(403, 'This workspace requires enterprise SSO. Sign in with SSO to accept the invitation.');
      }
      const ipAddr = getRequestIp(request);
      const result = await acceptWorkspaceInvitation({
        inviteToken: request.params.inviteToken, registration, user: request.auth?.user,
        tenantsRepository, authRepository, tokenService, sessionsRepository,
        sessionMeta: { ipAddr, locationName: getLocationNameForIp(ipAddr), userAgent: getRequestUserAgent(request) },
      });
      response.set('Cache-Control', 'no-store');
      await sendSessionResult(request, response, registration ? 201 : 200, result, tokenService, identityRepository);
    } catch (error) { next(error); }
  }
  router.post('/invites/:inviteToken/register', async (request, response, next) => {
    try { await acceptInvitation(request, response, next, await assertHumanSignup(request, invitedRegistrationSchema.parse(request.body))); }
    catch (error) { next(error); }
  });
  router.post('/invites/:inviteToken/accept', requireAuth, (request, response, next) => acceptInvitation(request, response, next));

  router.post('/break-glass/start', async (request, response, next) => {
    try {
      const result = await startBreakGlassLogin({ input: breakGlassStartSchema.parse(request.body), identityRepository, repository: authRepository, tokenService });
      response.set('Cache-Control', 'no-store').status(202).json(result);
    } catch (error) { next(error); }
  });

  router.post('/break-glass/verify', async (request, response, next) => {
    try {
      const ipAddr = getRequestIp(request);
      const result = await verifyBreakGlassLogin({
        identityRepository,
        input: breakGlassVerifySchema.parse(request.body),
        repository: authRepository,
        sessionMeta: { ipAddr, locationName: getLocationNameForIp(ipAddr), userAgent: getRequestUserAgent(request) },
        sessionsRepository,
        tokenService,
      });
      await request.app.locals.auditWriter?.append?.({ action: 'auth.break_glass.activated', detail: { dataClassification: 'restricted', expiresAt: result.breakGlass.expiresAt, reason: result.breakGlass.reason, requestId: request.id ?? null, source: 'auth' }, ipAddress: ipAddr || 'unknown', projectId: null, result: 'success:200', tenantId: result.session.user.tenantId, userId: result.session.user.id });
      logBackendEvent({ context: buildRequestLogContext(request, { tenantId: result.session.user.tenantId, userId: result.session.user.id }), level: 'warn', message: 'Break-glass emergency access session activated.' });
      response.set('Cache-Control', 'no-store').json(result);
    } catch (error) { next(error); }
  });

  router.post('/login', async (request, response, next) => {
    try {
      const payload = loginSchema.parse(request.body);
      await enterpriseOidcService?.assertPasswordLoginAllowed({ email: payload.email });
      const ipAddr = getRequestIp(request);
      const result = await loginWithPassword(
        payload,
        authRepository,
        tokenService,
        sessionsRepository,
        {
          ipAddr,
          locationName: getLocationNameForIp(ipAddr),
          userAgent: getRequestUserAgent(request),
        },
      );

      if (result.code === 'needs_registration') {
        response.status(409).json({
          ok: false,
          code: 'needs_registration',
          error: 'No account exists for this email yet.',
        });
        return;
      }

      if (result.requiresTwoFactor) {
        if (wantsBearerResponse(request)) {
          response.status(202).json(result);
          return;
        }
        issueTwoFactorCookie(response, result.challengeToken, tokenService);
        response.status(202).json({
          ok: result.ok,
          requiresTwoFactor: true,
        });
        return;
      }

      await sendSessionResult(request, response, 200, result, tokenService, identityRepository);
    } catch (error) {
      next(error);
    }
  });

  router.post('/register/availability', async (request, response, next) => {
    try {
      const payload = availabilitySchema.parse(request.body);
      const result = await getRegistrationAvailability(payload, authRepository);
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/register/config', (_request, response) => {
    response.set('Cache-Control', 'no-store').json({ ok: true, recaptchaSiteKey: signupCaptcha?.siteKey || null });
  });

  router.post('/register', async (request, response, next) => {
    try {
      const payload = await assertHumanSignup(request, registerSchema.parse(request.body));
      await enterpriseOidcService?.assertPasswordLoginAllowed({ email: payload.email });
      // Password sign-ups wait for the emailed link (POST /register/verify); Google has already verified the email.
      if (payload.authMethod !== 'google') {
        const result = await startPasswordRegistration(payload, { frontendAppUrl, mailRepository, repository: authRepository });
        response.status(202).json(result);
        return;
      }
      const proof = getAuthCookie(request, AUTH_COOKIE_NAMES.googleRegistration);
      let googleVerifiedEmail;
      try {
        googleVerifiedEmail = tokenService.verifyGoogleRegistrationProof(proof).email;
      } catch (_error) {
        throw new HttpError(401, 'Google sign-in expired. Sign in with Google again.');
      }
      const result = await registerAccount(payload, authRepository, tokenService, sessionsRepository, sessionMetaFor(request), { googleVerifiedEmail });
      clearGoogleRegistrationCookie(response);
      await sendSessionResult(request, response, 201, result, tokenService, identityRepository);
    } catch (error) {
      next(error);
    }
  });

  router.post('/register/verify', async (request, response, next) => {
    try {
      const { token } = verifyRegistrationSchema.parse(request.body);
      const result = await completePasswordRegistration(token, {
        repository: authRepository,
        sessionMeta: sessionMetaFor(request),
        sessionsRepository,
        tokenService,
      });
      response.set('Cache-Control', 'no-store');
      await sendSessionResult(request, response, 201, result, tokenService, identityRepository);
    } catch (error) {
      next(error);
    }
  });

  router.get('/google/start', (request, response, next) => {
    try {
      const redirectTarget = normalizeGoogleRedirectTarget(request.query.redirect);
      response.redirect(302, googleOAuthClient.getAuthorizationUrl({
        state: redirectTarget || undefined,
      }));
    } catch (error) {
      const searchParams = new URLSearchParams({
        error: 'google_unavailable',
      });
      const redirectTarget = normalizeGoogleRedirectTarget(request.query.redirect);
      if (redirectTarget) {
        searchParams.set('redirect', redirectTarget);
      }
      response.redirect(302, buildFrontendAuthUrl(frontendAppUrl, '/login', searchParams));
    }
  });

  router.get('/google/callback', async (request, response, next) => {
    const redirectTarget = normalizeGoogleRedirectTarget(request.query.state);
    const providerError = typeof request.query.error === 'string' ? request.query.error : '';
    const providerErrorDescription = typeof request.query.error_description === 'string'
      ? request.query.error_description
      : '';

    try {
      if (providerError) {
        logBackendEvent({
          context: buildRequestLogContext(request, {
            googleError: providerError,
            googleErrorDescription: providerErrorDescription,
            redirectTarget,
          }),
          level: 'warn',
          message: 'Google OAuth provider redirected back with an error.',
        });

        const searchParams = new URLSearchParams({
          error: 'google_callback_failed',
        });
        if (redirectTarget) {
          searchParams.set('redirect', redirectTarget);
        }
        response.redirect(302, buildFrontendAuthUrl(frontendAppUrl, '/login', searchParams));
        return;
      }

      const code = typeof request.query.code === 'string' ? request.query.code : '';

      if (!code) {
        throw new HttpError(400, 'Google OAuth callback is missing the authorization code.');
      }

      const ipAddr = getRequestIp(request);
      const result = await handleGoogleCallback({
        assertLoginAllowed: (email) => enterpriseOidcService?.assertPasswordLoginAllowed({ email }),
        code,
        frontendAppUrl,
        googleOAuthClient,
        redirectTarget,
        repository: authRepository,
        sessionsRepository,
        sessionMeta: {
          ipAddr,
          locationName: getLocationNameForIp(ipAddr),
          userAgent: getRequestUserAgent(request),
        },
        tokenService,
      });

      if (result.session) {
        issueSessionCookies(response, result.session, tokenService);
      } else if (result.challengeToken) {
        issueTwoFactorCookie(response, result.challengeToken, tokenService);
      }
      if (result.registrationProfile) {
        issueGoogleRegistrationCookie(response, result.registrationProfile, tokenService);
      }

      logBackendEvent({
        context: buildRequestLogContext(request, {
          googleOutcome: classifyGoogleCallbackRedirect(result.redirectTo, frontendAppUrl),
          redirectTarget,
        }),
        message: 'Google OAuth callback completed.',
      });

      response.redirect(302, result.redirectTo);
    } catch (error) {
      if (error instanceof HttpError && error.statusCode < 500) {
        next(error);
        return;
      }

      logBackendError({
        context: buildRequestLogContext(request, {
          redirectTarget,
        }),
        error,
        level: 'error',
        message: 'Google OAuth callback failed.',
      });

      const searchParams = new URLSearchParams({
        error: 'google_callback_failed',
      });
      searchParams.set(
        'stage',
        typeof error?.googleOAuthStage === 'string' && error.googleOAuthStage
          ? error.googleOAuthStage
          : 'callback_unclassified',
      );
      if (typeof error?.googleOAuthProviderError === 'string' && error.googleOAuthProviderError) {
        searchParams.set('providerError', error.googleOAuthProviderError);
      }
      if (redirectTarget) {
        searchParams.set('redirect', redirectTarget);
      }
      response.redirect(302, buildFrontendAuthUrl(frontendAppUrl, '/login', searchParams));
    }
  });

  router.get('/me', requireAuth, async (request, response, next) => {
    try {
      const result = await getCurrentUser(request.auth.user.id, authRepository, {
        activeTenantId: request.auth.tokenPayload.tenantId,
      });
      result.user.capabilities = request.auth.user.capabilities ?? [];
      result.impersonation = request.auth.impersonation ?? null;
      result.breakGlass = request.auth.breakGlass ?? null;
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/switch-tenant', requireAuth, async (request, response, next) => {
    try {
      const payload = switchTenantSchema.parse(request.body);
      const result = await switchTenantSession({
        repository: authRepository,
        sessionId: request.auth.sessionId,
        sessionsRepository,
        tenantId: payload.tenantId,
        tokenService,
        userId: request.auth.user.id,
      });
      await sendSessionResult(request, response, 200, result, tokenService, identityRepository);
    } catch (error) {
      next(error);
    }
  });

  router.post('/refresh', async (request, response, next) => {
    try {
      const cookieRefreshToken = getAuthCookie(request, AUTH_COOKIE_NAMES.refresh);
      const payload = refreshSessionSchema.parse({
        ...request.body,
        refreshToken: request.body?.refreshToken || cookieRefreshToken || undefined,
      });
      if (cookieRefreshToken && payload.refreshToken === cookieRefreshToken) {
        let refreshPayload;
        try {
          refreshPayload = tokenService.verifyRefreshToken(cookieRefreshToken);
        } catch (_error) {
          clearSessionCookies(response);
          throw new HttpError(401, 'Refresh token is invalid or expired.');
        }
        requireCsrfForCookieAuth(request, tokenService, {
          sessionId: typeof refreshPayload?.jti === 'string' ? refreshPayload.jti : '',
          userId: typeof refreshPayload?.sub === 'string' ? refreshPayload.sub : '',
        });
      }
      const result = await refreshSessionWithToken(
        payload,
        authRepository,
        tokenService,
        sessionsRepository,
      );
      await attachResolvedCapabilities(result, identityRepository);
      if (cookieRefreshToken && payload.refreshToken === cookieRefreshToken) {
        issueSessionCookies(response, result.session, tokenService);
        response.status(200).json(publicSessionResult(result));
        return;
      }
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/keep-alive', requireAuth, async (request, response, next) => {
    try {
      const result = await keepSessionAlive(
        request.auth.user.id,
        tokenService,
        authRepository,
        sessionsRepository,
        request.auth.token,
      );
      result.session.user.capabilities = request.auth.user.capabilities ?? [];
      if (request.auth.credentialSource === 'cookie') {
        issueSessionCookies(response, result.session, tokenService);
        response.status(200).json(publicSessionResult(result));
        return;
      }
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/two-factor/init', requireAuth, async (request, response, next) => {
    try {
      const result = await initializeTwoFactor(request.auth.user.id, authRepository);
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/two-factor/enable', requireAuth, async (request, response, next) => {
    try {
      const payload = twoFactorCodeSchema.parse(request.body);
      const result = await enableTwoFactor(request.auth.user.id, payload.code, authRepository);
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/two-factor/backup-codes', requireAuth, async (request, response, next) => {
    try {
      const result = await getBackupCodes(request.auth.user.id, authRepository);
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/two-factor/verify', async (request, response, next) => {
    try {
      const cookieChallengeToken = getAuthCookie(request, AUTH_COOKIE_NAMES.twoFactor);
      const payload = twoFactorVerifySchema.parse({
        ...request.body,
        challengeToken: request.body?.challengeToken || cookieChallengeToken,
      });
      const ipAddr = getRequestIp(request);
      const result = await verifyTwoFactorLogin(
        payload,
        authRepository,
        tokenService,
        sessionsRepository,
        {
          ipAddr,
          locationName: getLocationNameForIp(ipAddr),
          userAgent: getRequestUserAgent(request),
        },
      );
      clearTwoFactorCookie(response);
      await sendSessionResult(request, response, 200, result, tokenService, identityRepository);
    } catch (error) {
      next(error);
    }
  });

  router.post('/two-factor/disable', requireAuth, async (request, response, next) => {
    try {
      const result = await disableTwoFactor(request.auth.user.id, authRepository);
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/logout', requireAuth, async (request, response, next) => {
    try {
      if (request.auth.sessionId) {
        await sessionsRepository.killSession({
          tokenId: request.auth.sessionId,
          userId: request.auth.user.id,
        });
      } else {
        await sessionsRepository.revokeToken({ token: request.auth.token });
      }
      clearSessionCookies(response);
      response.status(200).json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
