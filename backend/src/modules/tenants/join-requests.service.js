import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { HttpError } from '../../lib/errors/http-error.js';
import { buildOperationLogContext, logBackendError } from '../../lib/logging/backend-logger.js';
import { renderEmailFromTemplate } from '../mail/mail.service.js';
import {
  JOIN_REQUEST_ADMIN_TEMPLATE_ID,
  JOIN_REQUEST_APPROVED_TEMPLATE_ID,
  JOIN_REQUEST_CONFIRM_TEMPLATE_ID,
  JOIN_REQUEST_DECLINED_TEMPLATE_ID,
} from '../mail/workspace-access.templates.js';
import { findEmailOptOuts, isOptedOut } from '../users/notification-preferences.js';

// A signed-in person asks to join a workspace by its exact name. The request grants nothing:
// admins see it only after the requester proves the email address, and only an admin's
// approval adds the membership, as a role the admin picks.

export const JOIN_REQUEST_LIMITS = Object.freeze({
  attemptsPerHour: 10,
  confirmAttemptsPerHour: 30,
  declinedCooldownMs: 7 * 24 * 60 * 60 * 1000,
  historyMs: 30 * 24 * 60 * 60 * 1000,
  maxPending: 3,
  perDay: 5,
  resendIntervalMs: 5 * 60 * 1000,
  verificationLifetimeMs: 24 * 60 * 60 * 1000,
});

// Whether or not the name matches a workspace, the requester gets this answer.
const RECEIVED_MESSAGE = 'Request received. If a workspace has exactly that name, your request is listed below.';

/** Counts attempts per key in a sliding window. One per process, like the requirements limiter. */
export function createAttemptLimiter({ limit, now = () => Date.now(), windowMs = 60 * 60 * 1000, maxKeys = 10_000 }) {
  const attempts = new Map();
  return {
    take(key) {
      const at = now();
      const recent = (attempts.get(key) ?? []).filter((time) => at - time < windowMs);
      if (recent.length >= limit) {
        attempts.set(key, recent);
        return false;
      }
      if (!attempts.has(key) && attempts.size >= maxKeys) attempts.delete(attempts.keys().next().value);
      attempts.set(key, [...recent, at]);
      return true;
    },
  };
}

export function createJoinRequestLimiters(options = {}) {
  return {
    attempts: createAttemptLimiter({ limit: JOIN_REQUEST_LIMITS.attemptsPerHour, ...options }),
    confirmations: createAttemptLimiter({ limit: JOIN_REQUEST_LIMITS.confirmAttemptsPerHour, ...options }),
  };
}

function clockNow(deps) {
  return deps.clock ? deps.clock() : new Date();
}

function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function issueToken(now) {
  const token = randomBytes(32).toString('base64url');
  return { expiresAt: new Date(now.valueOf() + JOIN_REQUEST_LIMITS.verificationLifetimeMs), hash: hashToken(token), token };
}

function escapeText(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

// Subjects are plain-text headers, so the escaping the template needed is undone.
function plainSubject(value) {
  return String(value ?? '').replace(/&(lt|gt|quot|#39|amp);/g, (match, entity) => ({ amp: '&', '#39': "'", gt: '>', lt: '<', quot: '"' })[entity]);
}

function appBase(deps) {
  return String(deps.frontendAppUrl || 'http://localhost:5173/app').replace(/\/$/, '');
}

function requireSignedIn(user) {
  if (!user?.id) throw new HttpError(401, 'Authentication required.');
  return user;
}

function requireAdminTenant(user) {
  const membership = user?.memberships?.[0];
  if (!membership?.tenantId) throw new HttpError(403, 'This account is not assigned to a tenant.');
  if (membership.role !== 'admin') throw new HttpError(403, 'Forbidden');
  return membership.tenantId;
}

function logMailFailure(error, operation, extra) {
  logBackendError({ context: buildOperationLogContext(operation, extra), error, level: 'warn', message: 'A workspace access email could not be queued.' });
}

async function queueTemplate(deps, { recipientEmail, targetId, templateId, vars }) {
  const escaped = Object.fromEntries(Object.entries(vars).map(([key, value]) => [key, escapeText(value)]));
  const rendered = await renderEmailFromTemplate({ mailRepository: deps.mailRepository, templateId, vars: escaped });
  return deps.mailRepository.queueMail({ body: rendered.body, recipientEmail, subject: plainSubject(rendered.subject), targetId, templateId });
}

async function sendConfirmation(deps, { request, token }) {
  if (!deps.mailRepository?.queueMail) return false;
  try {
    // The token rides in the fragment, which browsers never send to a server or put in a Referer.
    return await queueTemplate(deps, {
      recipientEmail: request.email,
      // A fresh target per link: the queue skips a second email with the same target.
      targetId: randomUUID(),
      templateId: JOIN_REQUEST_CONFIRM_TEMPLATE_ID,
      vars: { confirmUrl: `${appBase(deps)}/workspace-access/confirm#${token}`, requesterName: request.name || 'there', workspaceName: request.workspaceName },
    });
  } catch (error) {
    logMailFailure(error, 'workspaceAccess.sendConfirmation', { requestId: request.id });
    return false;
  }
}

async function notifyAdmins(deps, request) {
  if (!deps.mailRepository?.queueMail) return;
  try {
    const admins = await deps.joinRequestsRepository.listWorkspaceAdmins({ tenantId: request.tenantId });
    const optOuts = await findEmailOptOuts({ kind: 'attention', read: deps.authRepository?.listUserPreferences?.bind(deps.authRepository), userIds: admins.map((admin) => admin.id) });
    for (const admin of admins.filter((entry) => entry.email && !isOptedOut(optOuts, { userId: entry.id }))) {
      await queueTemplate(deps, {
        recipientEmail: admin.email,
        targetId: request.id,
        templateId: JOIN_REQUEST_ADMIN_TEMPLATE_ID,
        vars: {
          requestsUrl: `${appBase(deps)}/admin?section=user-management&tab=requests`,
          requesterEmail: request.email,
          requesterName: request.name || request.email,
          workspaceName: request.workspaceName,
        },
      });
    }
  } catch (error) {
    logMailFailure(error, 'workspaceAccess.notifyAdmins', { requestId: request.id, tenantId: request.tenantId });
  }
}

async function notifyRequester(deps, request) {
  if (!deps.mailRepository?.queueMail) return;
  try {
    await queueTemplate(deps, {
      recipientEmail: request.email,
      targetId: request.id,
      templateId: request.status === 'approved' ? JOIN_REQUEST_APPROVED_TEMPLATE_ID : JOIN_REQUEST_DECLINED_TEMPLATE_ID,
      vars: { appUrl: `${appBase(deps)}/`, requesterName: request.name || 'there', role: request.grantedRole ?? 'user', workspaceName: request.workspaceName },
    });
  } catch (error) {
    logMailFailure(error, 'workspaceAccess.notifyRequester', { requestId: request.id });
  }
}

function presentOwnRequest(request) {
  return {
    decidedAt: request.decidedAt,
    email: request.email,
    emailConfirmed: Boolean(request.emailVerifiedAt),
    grantedRole: request.status === 'approved' ? request.grantedRole : null,
    id: request.id,
    requestedAt: request.requestedAt,
    status: request.status,
    // Only a workspace the requester now belongs to is identified beyond the name they typed.
    tenantId: request.status === 'approved' ? request.tenantId : null,
    verificationSentAt: request.verificationSentAt,
    workspaceName: request.workspaceName,
  };
}

function presentAdminRequest(request) {
  return {
    email: request.email,
    emailVerifiedAt: request.emailVerifiedAt,
    id: request.id,
    name: request.name,
    requestedAt: request.requestedAt,
    verificationMethod: request.verificationMethod,
  };
}

export async function listOwnJoinRequests(deps, { user }) {
  requireSignedIn(user);
  const since = new Date(clockNow(deps).valueOf() - JOIN_REQUEST_LIMITS.historyMs);
  const requests = await deps.joinRequestsRepository.listForRequester({ since, userId: user.id });
  return { limits: { maxPending: JOIN_REQUEST_LIMITS.maxPending }, ok: true, requests: requests.map(presentOwnRequest) };
}

export async function createJoinRequest(deps, { user, workspaceName }) {
  requireSignedIn(user);
  if (!deps.limiters.attempts.take(`user:${user.id}`)) {
    throw new HttpError(429, 'Too many requests to join workspaces. Try again in an hour.');
  }
  const now = clockNow(deps);
  // Limits that depend only on the requester are checked before the name is looked up, so
  // they answer the same for names that exist and names that don't.
  const own = await deps.joinRequestsRepository.listForRequester({ since: new Date(now.valueOf() - JOIN_REQUEST_LIMITS.historyMs), userId: user.id });
  if (own.filter((row) => row.status === 'pending').length >= JOIN_REQUEST_LIMITS.maxPending) throw tooManyPending();
  const dayAgo = now.valueOf() - 24 * 60 * 60 * 1000;
  if (own.filter((row) => Date.parse(row.requestedAt) >= dayAgo).length >= JOIN_REQUEST_LIMITS.perDay) throw dailyLimit();

  const workspaces = await deps.joinRequestsRepository.findWorkspacesByName(workspaceName);
  if (workspaces.length > 1) {
    throw new HttpError(409, 'More than one workspace has that name, so a request can’t reach the right one. Ask someone in the workspace for an invitation.');
  }
  if (!workspaces.length) return { message: RECEIVED_MESSAGE, ok: true };
  const [workspace] = workspaces;

  const alreadyVerified = await deps.joinRequestsRepository.hasVerifiedEmail({ email: user.email, userId: user.id });
  const token = alreadyVerified ? null : issueToken(now);
  const result = await deps.joinRequestsRepository.createRequest({
    email: String(user.email).toLowerCase(),
    limits: {
      declinedSince: new Date(now.valueOf() - JOIN_REQUEST_LIMITS.declinedCooldownMs),
      maxPending: JOIN_REQUEST_LIMITS.maxPending,
      perPeriod: JOIN_REQUEST_LIMITS.perDay,
      since: new Date(dayAgo),
    },
    name: String(user.name ?? '').trim() || String(user.email),
    now,
    tenantId: workspace.id,
    token: token ? { expiresAt: token.expiresAt, hash: token.hash } : null,
    userId: user.id,
    verification: alreadyVerified ? { method: 'earlier_confirmation', verifiedAt: now.toISOString() } : null,
  });
  if (result.outcome === 'too_many_pending') throw tooManyPending();
  if (result.outcome === 'rate_limited') throw dailyLimit();
  if (result.outcome === 'recently_declined') {
    throw new HttpError(409, 'An admin of that workspace declined your request in the last 7 days. Ask someone there for an invitation instead.');
  }
  if (result.outcome !== 'created') return { message: RECEIVED_MESSAGE, ok: true };

  const request = { ...result.request, workspaceName: workspace.name };
  if (alreadyVerified) await notifyAdmins(deps, request);
  else await sendConfirmation(deps, { request, token: token.token });
  return { message: RECEIVED_MESSAGE, ok: true };
}

function tooManyPending() {
  return new HttpError(409, `You already have ${JOIN_REQUEST_LIMITS.maxPending} requests waiting. Cancel one before asking to join another workspace.`);
}

function dailyLimit() {
  return new HttpError(429, `You can ask to join at most ${JOIN_REQUEST_LIMITS.perDay} workspaces a day. Try again tomorrow.`);
}

async function requireOwnPending(deps, { requestId, user }) {
  const request = await deps.joinRequestsRepository.findById({ requestId });
  if (!request || request.userId !== user.id || request.status !== 'pending') throw new HttpError(404, 'Request not found.');
  return request;
}

export async function resendJoinRequestConfirmation(deps, { requestId, user }) {
  requireSignedIn(user);
  const request = await requireOwnPending(deps, { requestId, user });
  if (request.emailVerifiedAt) throw new HttpError(409, 'Your email is already confirmed for this request.');
  const now = clockNow(deps);
  if (request.verificationSentAt && Date.parse(request.verificationSentAt) + JOIN_REQUEST_LIMITS.resendIntervalMs > now.valueOf()) {
    throw new HttpError(429, 'We just sent a confirmation email. Wait a few minutes before asking for another.');
  }
  if (!deps.limiters.attempts.take(`user:${user.id}`)) {
    throw new HttpError(429, 'Too many requests to join workspaces. Try again in an hour.');
  }
  const token = issueToken(now);
  if (!await deps.joinRequestsRepository.replaceVerificationToken({ expiresAt: token.expiresAt, now, requestId, tokenHash: token.hash, userId: user.id })) {
    throw new HttpError(404, 'Request not found.');
  }
  const queued = await sendConfirmation(deps, { request, token: token.token });
  if (!queued) throw new HttpError(503, 'We couldn’t send the confirmation email. Try again in a moment.');
  return { message: `We sent a new confirmation link to ${request.email}. Earlier links no longer work.`, ok: true };
}

export async function cancelJoinRequest(deps, { requestId, user }) {
  requireSignedIn(user);
  if (!await deps.joinRequestsRepository.cancel({ now: clockNow(deps), requestId, userId: user.id })) {
    throw new HttpError(404, 'Request not found.');
  }
  return { message: 'Request cancelled.', ok: true };
}

const LINK_UNUSABLE = 'This confirmation link has expired or was already used. Open your requests in OdinPMP to send a new one.';

export async function confirmJoinRequestEmail(deps, { ipAddress, token }) {
  if (!deps.limiters.confirmations.take(`ip:${ipAddress || 'unknown'}`)) {
    throw new HttpError(429, 'Too many attempts. Try again later.');
  }
  const tokenHash = hashToken(token);
  const request = await deps.joinRequestsRepository.findPendingByTokenHash({ tokenHash });
  const now = clockNow(deps);
  if (!request || request.emailVerifiedAt || Date.parse(request.verificationExpiresAt) <= now.valueOf()) throw new HttpError(410, LINK_UNUSABLE);
  // The link proves the address it was sent to, so it is void once the account uses another.
  const account = await deps.authRepository.findUserById(request.userId);
  if (!account || String(account.email).toLowerCase() !== String(request.email).toLowerCase()) throw new HttpError(410, LINK_UNUSABLE);
  if (!await deps.joinRequestsRepository.markVerified({ method: 'email_link', now, requestId: request.id, tokenHash })) {
    throw new HttpError(410, LINK_UNUSABLE);
  }
  await notifyAdmins(deps, request);
  return { ok: true, workspaceName: request.workspaceName };
}

export async function listJoinRequestsForAdmin(deps, { user }) {
  const tenantId = requireAdminTenant(user);
  const requests = await deps.joinRequestsRepository.listPendingForTenant({ tenantId });
  return { ok: true, requests: requests.map(presentAdminRequest) };
}

export async function decideJoinRequest(deps, { actor, decision, ipAddress, requestId, role = 'user', user }) {
  const tenantId = requireAdminTenant(user);
  const existing = await deps.joinRequestsRepository.findById({ requestId });
  if (!existing || existing.tenantId !== tenantId || existing.status !== 'pending' || !existing.emailVerifiedAt) {
    throw new HttpError(404, 'Request not found or already decided.');
  }
  const decidedBy = (actor ?? user).id;
  const result = await deps.joinRequestsRepository.decide({
    auditEvent: {
      action: `tenant.join_request.${decision}`,
      detail: {
        effectiveUserId: user.id,
        requestId,
        requesterEmail: existing.email,
        requesterUserId: existing.userId,
        role: decision === 'approved' ? role : null,
        source: 'workspace-access',
        verificationMethod: existing.verificationMethod,
      },
      ipAddress: ipAddress || 'unknown',
      projectId: null,
      result: 'success',
      tenantId,
      userId: decidedBy,
    },
    auditWriter: deps.auditWriter,
    decidedBy,
    decision,
    now: clockNow(deps),
    requestId,
    role,
    tenantId,
  });
  if (!result) throw new HttpError(404, 'Request not found or already decided.');
  const request = { ...result.request, workspaceName: existing.workspaceName };
  await notifyRequester(deps, request);
  return {
    message: decision === 'approved' ? `${request.name || request.email} joined as ${role}.` : 'Request declined.',
    ok: true,
  };
}
