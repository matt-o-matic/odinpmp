// Channel guests.
//
// A guest is an outside person invited to one or more channels. Who they are:
// - per project, a stakeholder record (project_stakeholders), made or reused at the invite;
// - per workspace, one access link (access_links) for their email, the identity their sign-in
//   codes and sessions hang on (migration 0098).
// What they reach is worked out again on every request from project_channel_guests by
// guestMemberships() below, the one function every guest route and every live event goes
// through: the channels their email is a guest of now, in projects that still exist, leaving out
// engagements while the Consulting module is off. Anything else answers 404, as missing.
//
// Guests post, reply, mention, upload (up to the same 1 GB limit), download, preview, add versions,
// comment on files and mark files as editing in their channels. They cannot see other channels,
// the member list beyond their channels, the plan, workspace search or the assistant.
import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

import { generateGuestToken, hashGuestToken } from '../../lib/auth/guest-token.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { publishProjectChanged, publishWorkspaceChanged } from '../../lib/events/project-live-events.js';
import { LIVE_EVENT_CHANNELS } from '../../lib/events/live-event-bus.js';
import { buildOperationLogContext, logBackendError } from '../../lib/logging/backend-logger.js';
import { PROJECT_KIND_ENGAGEMENT } from '../../lib/projects/project-kind.js';
import { normalizeAccessEmail } from '../access/access-links.js';
import { publishChannelUpdated } from '../channels/channel-events.js';
import { channelArchivedError } from '../channels/channel-library.js';
import { channelAccess, guestChannelUrl, presentChannel, requireFile } from '../channels/channels.service.js';
import { queueSigningEmail } from '../mail/mail.service.js';
import { GUEST_INVITATION_TEMPLATE_ID, GUEST_SIGN_IN_CODE_TEMPLATE_ID } from '../mail/mail.templates.js';
import { CODE_MAX_ATTEMPTS, CODE_RESEND_MS, CODE_TTL_MS } from '../signing/signing.service.js';
import { sha256Hex } from '../signing/signing-seal.js';
import { getPreviewUrl } from '../vault/file-preview.service.js';
import { cancelUpload, completeUpload, describeUpload, findOwnUpload, getDownloadUrl, signUploadParts, startUpload } from '../vault/large-files.service.js';
import { CONSULTING_MODULE } from '../workspace-modules/workspace-modules.repository.js';
import { isModuleEnabled } from '../workspace-modules/workspace-modules.service.js';
import { NO_GUEST_TASKS } from './guest-tasks.js';

export { CODE_MAX_ATTEMPTS, CODE_RESEND_MS, CODE_TTL_MS };
/** A session lasts 30 days after its last use. */
export const GUEST_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const GUEST_EVENTS = Object.freeze({ changed: 'guest.changed', ended: 'guest.ended' });

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const nowOf = (deps) => (deps.guestClock ? deps.guestClock() : new Date());
const notFound = (message = 'Not found.') => new HttpError(404, message);

function maskEmail(email) {
  const [local = '', domain = ''] = String(email ?? '').split('@');
  if (!domain) return '';
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(1, Math.min(local.length - 1, 6)))}@${domain}`;
}

function appBase(deps) {
  const base = String(deps.frontendAppUrl ?? '').trim().replace(/\/$/, '');
  return base || '/app';
}

// --- audit -------------------------------------------------------------------------------------

/**
 * Guest invitations, removals, sign-ins, uploads and downloads go to the audit trail. A guest is
 * recorded as `guest:<access link id>`. Never fails the request.
 */
export async function auditGuest(deps, { action, detail = {}, ipAddress = '', projectId = null, result = 'success', tenantId, userId }) {
  if (!deps.auditWriter?.append) return;
  try {
    await deps.auditWriter.append({ action, detail: { source: 'guests', ...detail }, ipAddress: ipAddress || 'unknown', projectId, result, tenantId, userId });
  } catch (error) {
    logBackendError({ context: buildOperationLogContext('guests.audit', { action, projectId, tenantId }), error, level: 'error', message: 'Failed to append a guest audit event.' });
  }
}

const guestActor = (guest) => `guest:${guest.accessLinkId}`;

// --- who a guest is, and what they reach ---------------------------------------------------------

async function projectVisible(deps, projectId, tenantId, moduleOn) {
  const header = await deps.projectRepository.getProjectHeader?.({ projectId, tenantId });
  if (!header || header.tenantId !== tenantId) return null;
  if (header.kind === PROJECT_KIND_ENGAGEMENT && !await moduleOn()) return null;
  return header;
}

/**
 * The channels the email is a guest of in the workspace right now, each with its channel, its
 * project and the stakeholder record it goes through. The one place guest access is decided:
 * a removed guest, a deleted project or channel, a stakeholder record that moved projects, or an
 * engagement with the Consulting module off all drop out here.
 */
export async function guestMemberships(deps, { email, tenantId }) {
  const address = normalizeAccessEmail(email);
  if (!address || !tenantId) return [];
  const stakeholders = (await deps.assistantRepository.listStakeholdersByEmail({ email: address, tenantId })) ?? [];
  if (!stakeholders.length) return [];
  const byId = new Map(stakeholders.map((stakeholder) => [stakeholder.id, stakeholder]));
  const rows = await deps.projectRepository.listGuestMemberships({ stakeholderIds: [...byId.keys()], tenantId });
  let moduleState = null;
  const moduleOn = async () => {
    moduleState ??= await isModuleEnabled(deps.workspaceModulesRepository, tenantId, CONSULTING_MODULE);
    return moduleState;
  };
  const projects = new Map();
  const memberships = [];
  for (const row of rows) {
    const stakeholder = byId.get(row.stakeholderId);
    if (!stakeholder || stakeholder.projectId !== row.projectId) continue;
    if (!projects.has(row.projectId)) projects.set(row.projectId, await projectVisible(deps, row.projectId, tenantId, moduleOn));
    const project = projects.get(row.projectId);
    if (!project) continue;
    const channel = await deps.projectRepository.getChannel({ channelId: row.channelId, projectId: row.projectId, tenantId });
    if (!channel) continue;
    memberships.push({ channel, channelId: channel.id, invitedAt: row.invitedAt ?? null, project, projectId: project.id, stakeholder });
  }
  return memberships;
}

/** The account a guest's files and editing marker name, as Bug Reporter's collaborators have. */
async function fileActorFor(deps, guest, name) {
  const owner = await deps.authRepository?.findOrCreateStakeholderOwner?.({ email: guest.email, name });
  if (!owner?.id) throw new HttpError(503, 'Files are not available to guests on this server.', { details: { code: 'guest_files_unavailable' } });
  return { id: owner.id, name: name || owner.name || '' };
}

/**
 * The channels service's context for a guest in one project (channels.service.js): only their
 * channels there, writing as their stakeholder, never with decision rights. A lost engagement
 * is read-only for them too. 404 when they are in no channel of the project.
 */
export async function guestProjectContext(deps, guest, projectId, { memberships = null, needsFiles = false } = {}) {
  const current = memberships ?? await guestMemberships(deps, guest);
  const here = current.filter((membership) => membership.projectId === projectId);
  if (!here.length) throw notFound();
  const { project, stakeholder } = here[0];
  const readOnly = project.kind === PROJECT_KIND_ENGAGEMENT && project.engagementStatus === 'lost';
  return {
    // The guest's workspace identity, which their notifications are kept under (guest-notifications.js).
    accessLinkId: guest.accessLinkId ?? null,
    canCollaborate: !readOnly,
    canDecide: false,
    canManageChannels: false,
    canWriteFiles: !readOnly,
    channelIds: new Set(here.map((membership) => membership.channelId)),
    fileActor: needsFiles ? await fileActorFor(deps, guest, stakeholder.name) : { id: '', name: stakeholder.name ?? '' },
    guest: true,
    kind: project.kind,
    principal: { id: stakeholder.id, name: stakeholder.name || 'Guest', timezone: 'UTC', type: 'stakeholder' },
    project,
    projectId,
    readOnly,
    tenantId: guest.tenantId,
    user: null,
  };
}

/** A channel the guest is in, with the context for its project; 404 for any other. */
export async function requireGuestChannel(deps, guest, channelId, options = {}) {
  const memberships = options.memberships ?? await guestMemberships(deps, guest);
  const membership = memberships.find((entry) => entry.channelId === channelId);
  if (!membership) throw notFound('Channel not found.');
  const ctx = await guestProjectContext(deps, guest, membership.projectId, { ...options, memberships });
  return { channel: membership.channel, ctx, membership };
}

/**
 * A pursuit task the guest sees (guest-tasks.js), with the context for its project. With
 * `change` ('status', 'comment' or 'attachment'), one of their own: 403 `not_your_task` for a task
 * they see but don't own. `projectId` narrows the search; otherwise every project the guest is in
 * is tried, since a task id names no project. 404 for any task they don't see.
 */
async function requireGuestTask(deps, guest, taskId, { change = null, needsFiles = false, projectId = null } = {}) {
  const source = deps.guestTaskSource ?? NO_GUEST_TASKS;
  if (typeof source.requireTaskForGuest !== 'function') throw notFound('Task not found.');
  const memberships = guest.memberships ?? await guestMemberships(deps, guest);
  const projectIds = [...new Set(memberships.map((membership) => membership.projectId))].filter((id) => !projectId || id === projectId);
  for (const id of projectIds) {
    const ctx = await guestProjectContext(deps, guest, id, { memberships, needsFiles });
    try {
      const { task } = await source.requireTaskForGuest({ change, projectId: id, stakeholderIds: [ctx.principal.id], taskId, tenantId: guest.tenantId });
      return { ctx, task };
    } catch (error) {
      if (error?.status !== 404) throw error;
    }
  }
  throw notFound('Task not found.');
}

function guestTaskActor(ctx) {
  return { name: ctx.principal.name, stakeholderId: ctx.principal.id };
}

/**
 * A file the guest may read: in one of their channels' libraries, or attached to a pursuit task
 * they see. 404 for any other. Only channel files take comments, versions and the editing marker
 * (requireGuestFile).
 */
async function requireGuestReadableFile(deps, guest, fileId, options = {}) {
  const record = await deps.projectRepository.getFileRecord({ fileId, tenantId: guest.tenantId });
  if (record?.targetType !== 'task') return requireGuestFile(deps, guest, fileId, options);
  const { ctx } = await requireGuestTask(deps, guest, record.targetId, { projectId: record.projectId }).catch((error) => {
    throw error?.status === 404 ? notFound('File not found.') : error;
  });
  return { channel: null, ctx, file: record, taskId: record.targetId };
}

/** A file in one of the guest's channels' libraries; 404 for any other. */
export async function requireGuestFile(deps, guest, fileId, options = {}) {
  const record = await deps.projectRepository.getFileRecord({ fileId, tenantId: guest.tenantId });
  if (!record || record.targetType !== 'channel') throw notFound('File not found.');
  const { channel, ctx } = await requireGuestChannel(deps, guest, record.targetId, options);
  const file = await requireFile(deps, ctx, fileId);
  return { channel, ctx, file };
}

// --- live events -----------------------------------------------------------------------------

/** Tells a guest's open streams that what they reach changed, or that their access ended. */
export function publishGuestChanged(liveEventBus, accessLinkId, { ended = false } = {}) {
  if (!liveEventBus || !accessLinkId) return;
  liveEventBus.publish(LIVE_EVENT_CHANNELS.guest(accessLinkId), { type: ended ? GUEST_EVENTS.ended : GUEST_EVENTS.changed });
}

/** channel.updated for a guest's write, as the member routes publish theirs. */
export function publishGuestWrite(deps, ctx, { area, channelId, fileId = null, originClientId = null, workspace = false }) {
  publishChannelUpdated(deps.liveEventBus, { actor: { id: ctx.principal.id, name: ctx.principal.name, type: 'guest' }, area, channelId, fileId, originClientId, projectId: ctx.projectId });
  if (workspace) publishWorkspaceChanged(deps.liveEventBus, ctx.tenantId, { area: 'projects', originClientId });
}

// --- sign-in ------------------------------------------------------------------------------------

function codeHash(accessLinkId, code) {
  return sha256Hex(`${accessLinkId}:${code}`);
}

function sameHash(left, right) {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

function validEmail(value) {
  const email = normalizeAccessEmail(value);
  if (!EMAIL_PATTERN.test(email) || email.length > 255) throw new HttpError(400, 'Enter your email address.', { details: { code: 'invalid_email' } });
  return email;
}

/**
 * The access link a sign-in for this email opens: in the workspace asked for, or else the one
 * where the email was most recently invited to a channel. Null when the email is a guest nowhere
 * (or not in that workspace); the caller answers exactly as for a guest, so nothing tells.
 */
async function resolveGuestLink(deps, { email, workspace = '' }) {
  const links = (await deps.accessRepository.listLinksByEmail?.({ email })) ?? [];
  let best = null;
  for (const link of links) {
    if (link.revokedAt || (workspace && link.tenantId !== workspace)) continue;
    const memberships = await guestMemberships(deps, { email, tenantId: link.tenantId });
    if (!memberships.length) continue;
    const latest = memberships.reduce((max, entry) => (String(entry.invitedAt ?? '') > max ? String(entry.invitedAt ?? '') : max), '');
    if (!best || latest > best.latest) best = { latest, link, memberships };
  }
  return best;
}

/**
 * Codes asked for an email that is a guest nowhere. They are never sent, but they age, refuse a
 * resend and count wrong tries exactly as real ones do, so the answers for an unknown address
 * match a guest's. In memory and bounded: the oldest go first.
 */
export function createPhantomCodes({ maxEntries = 10_000 } = {}) {
  const entries = new Map();
  return {
    get(key) {
      return entries.get(key) ?? null;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    },
  };
}

function recentlySent(sentAt, at) {
  const elapsed = at.valueOf() - Date.parse(sentAt);
  if (!(elapsed >= 0 && elapsed < CODE_RESEND_MS)) return null;
  return new HttpError(429, 'A code was sent a moment ago. Check your email, or ask again in a minute.', { details: { code: 'code_recently_sent', retryAfterSeconds: Math.ceil((CODE_RESEND_MS - elapsed) / 1000) } });
}

function codeSentAnswer(email) {
  return { expiresInSeconds: CODE_TTL_MS / 1000, ok: true, resendAfterSeconds: CODE_RESEND_MS / 1000, sentTo: maskEmail(email) };
}

/**
 * Step one of signing in: email a 6-digit code to a guest. Every address gets the same answer,
 * whether or not it is a guest, so the page does not tell who is invited.
 */
export async function requestSignInCode(deps, { email: rawEmail, ipAddress = '', workspace = '' }) {
  const email = validEmail(rawEmail);
  const at = nowOf(deps);
  const target = await resolveGuestLink(deps, { email, workspace });
  if (!target) {
    const key = `${workspace}:${email}`;
    const phantom = deps.phantomCodes.get(key);
    const tooSoon = phantom && recentlySent(phantom.sentAt, at);
    if (tooSoon) throw tooSoon;
    deps.phantomCodes.set(key, { attempts: 0, sentAt: at.toISOString() });
    return codeSentAnswer(email);
  }
  const { link } = target;
  const existing = await deps.guestSessionsRepository.getSignInCode({ accessLinkId: link.id });
  const tooSoon = existing && !existing.usedAt && recentlySent(existing.sentAt, at);
  if (tooSoon) throw tooSoon;
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await deps.guestSessionsRepository.saveSignInCode({ accessLinkId: link.id, codeHash: codeHash(link.id, code), sentAt: at, tenantId: link.tenantId });
  try {
    const workspaceName = (await deps.authRepository?.findTenantById?.(link.tenantId))?.name ?? 'Odin';
    await queueSigningEmail({ mailRepository: deps.mailRepository, recipientEmail: email, targetId: randomUUID(), templateId: GUEST_SIGN_IN_CODE_TEMPLATE_ID, vars: { code, workspaceName } });
  } catch (error) {
    // The answer stays the same; the guest asks again after a minute.
    logBackendError({ context: buildOperationLogContext('guests.signInCode', { tenantId: link.tenantId }), error, level: 'warn', message: 'A guest sign-in code could not be queued.' });
  }
  return codeSentAnswer(email);
}

function codeError(error, remaining = null) {
  const messages = {
    code_expired: 'That code has expired. Ask for a new one.',
    code_invalid: 'That code is not right. Check the email and try again.',
    code_locked: 'Too many wrong codes. Ask for a new one.',
    code_required: 'Ask for a code first.',
  };
  return new HttpError(400, messages[error], { details: { code: error, ...(remaining == null ? {} : { remaining }) } });
}

// The checks a code goes through before its hash is compared, for real and phantom codes alike.
function codeStateError(record, at) {
  if (!record || record.usedAt) return codeError('code_required');
  if (at.valueOf() - Date.parse(record.sentAt) > CODE_TTL_MS) return codeError('code_expired');
  if ((record.attempts ?? 0) >= CODE_MAX_ATTEMPTS) return codeError('code_locked');
  return null;
}

/**
 * Step two: a correct code starts a session and returns its token, which the route sets
 * as the guest's cookie. Wrong codes count; the fifth locks the code. Unknown addresses get the
 * same answers.
 */
export async function signInWithCode(deps, { code: rawCode, email: rawEmail, ipAddress = '', userAgent = '', workspace = '' }) {
  const email = validEmail(rawEmail);
  const code = String(rawCode ?? '').replace(/\s+/g, '');
  const at = nowOf(deps);
  const target = await resolveGuestLink(deps, { email, workspace });
  if (!target) {
    const phantom = deps.phantomCodes.get(`${workspace}:${email}`);
    const stateError = codeStateError(phantom, at);
    if (stateError) throw stateError;
    phantom.attempts += 1;
    throw codeError(phantom.attempts >= CODE_MAX_ATTEMPTS ? 'code_locked' : 'code_invalid', Math.max(0, CODE_MAX_ATTEMPTS - phantom.attempts));
  }
  const { link, memberships } = target;
  const record = await deps.guestSessionsRepository.getSignInCode({ accessLinkId: link.id });
  const stateError = codeStateError(record, at);
  if (stateError) throw stateError;
  const audit = { ipAddress, tenantId: link.tenantId, userId: `guest:${link.id}` };
  if (!/^\d{6}$/.test(code) || !sameHash(codeHash(link.id, code), record.codeHash)) {
    const attempts = (await deps.guestSessionsRepository.recordCodeAttempt({ accessLinkId: link.id, codeHash: record.codeHash })) ?? CODE_MAX_ATTEMPTS;
    if (attempts >= CODE_MAX_ATTEMPTS) await auditGuest(deps, { ...audit, action: 'guest.sign_in_locked', result: 'failure:400' });
    throw codeError(attempts >= CODE_MAX_ATTEMPTS ? 'code_locked' : 'code_invalid', Math.max(0, CODE_MAX_ATTEMPTS - attempts));
  }
  // Used once: a second request with the same code finds it gone.
  if (!await deps.guestSessionsRepository.useSignInCode({ accessLinkId: link.id, at, codeHash: record.codeHash, maxAttempts: CODE_MAX_ATTEMPTS })) throw codeError('code_required');
  const token = generateGuestToken();
  const session = await deps.guestSessionsRepository.createSession({
    accessLinkId: link.id,
    createdAt: at,
    expiresAt: new Date(at.valueOf() + GUEST_SESSION_TTL_MS),
    id: randomUUID(),
    ip: ipAddress,
    lastSeenAt: at,
    tenantId: link.tenantId,
    tokenHash: hashGuestToken(token),
    userAgent,
  });
  await deps.accessRepository.touchLink?.({ linkId: link.id, now: at });
  await auditGuest(deps, { ...audit, action: 'guest.sign_in', detail: { sessionId: session.id } });
  return { expiresAt: session.expiresAt, guest: { email, name: memberships[0]?.stakeholder?.name ?? '' }, ok: true, session, token };
}

/**
 * The session behind a token, if it still works: not revoked, not past its expiry, its access
 * link not revoked. Moves the expiry to 30 days from now when `touch` is set.
 */
export async function resolveGuestSession(deps, token, { touch = true } = {}) {
  if (!token) return null;
  const session = await deps.guestSessionsRepository.findSessionByTokenHash({ tokenHash: hashGuestToken(token) });
  const at = nowOf(deps);
  if (!session || session.revokedAt || Date.parse(session.expiresAt) <= at.valueOf()) return null;
  const link = await deps.accessRepository.findLinkById?.({ linkId: session.accessLinkId });
  if (!link || link.revokedAt || link.tenantId !== session.tenantId) return null;
  if (touch) {
    const expiresAt = new Date(at.valueOf() + GUEST_SESSION_TTL_MS);
    if (!await deps.guestSessionsRepository.touchSession({ at, expiresAt, id: session.id })) return null;
    session.expiresAt = expiresAt.toISOString();
    session.lastSeenAt = at.toISOString();
  }
  return { accessLinkId: link.id, email: link.email, session, sessionId: session.id, tenantId: link.tenantId };
}

export async function signOutGuest(deps, guest) {
  if (guest?.sessionId) await deps.guestSessionsRepository.revokeSession({ at: nowOf(deps), id: guest.sessionId });
  return { ok: true };
}

/**
 * Ends every session of the email in the workspace once it is a guest of no channel there,
 * and tells open streams. Returns whether access ended.
 */
async function endAccessIfNoChannels(deps, { email, tenantId }) {
  const link = await deps.accessRepository.findLinkByEmail?.({ email, tenantId });
  if (!link) return false;
  const ended = !(await guestMemberships(deps, { email, tenantId })).length;
  if (ended) await deps.guestSessionsRepository.revokeSessionsForLink({ accessLinkId: link.id, at: nowOf(deps) });
  publishGuestChanged(deps.liveEventBus, link.id, { ended });
  return ended;
}

// --- what a guest sees ---------------------------------------------------------------------------

function presentProject(project) {
  return { customer: project.customer ?? '', id: project.id, kind: project.kind, name: project.name, readOnly: project.kind === PROJECT_KIND_ENGAGEMENT && project.engagementStatus === 'lost' };
}

/** Who is signed in and in which workspace. */
export async function describeGuest(deps, guest) {
  const memberships = guest.memberships ?? await guestMemberships(deps, guest);
  const tenant = await deps.authRepository?.findTenantById?.(guest.tenantId);
  const name = memberships[0]?.stakeholder?.name ?? '';
  const owner = memberships.length ? await deps.authRepository?.findOrCreateStakeholderOwner?.({ email: guest.email, name }) : null;
  return {
    guest: { email: guest.email, fileActorId: owner?.id ?? null, name },
    ok: true,
    session: { expiresAt: guest.session?.expiresAt ?? null },
    workspace: { id: guest.tenantId, name: tenant?.name ?? '' },
  };
}

/** The guest's engagements and projects, each with only the channels they are in and unread counts. */
export async function listGuestEngagements(deps, guest) {
  const memberships = guest.memberships ?? await guestMemberships(deps, guest);
  const byProject = new Map();
  for (const membership of memberships) {
    const entry = byProject.get(membership.projectId) ?? { memberships: [], project: membership.project };
    entry.memberships.push(membership);
    byProject.set(membership.projectId, entry);
  }
  const projects = [];
  for (const { memberships: here, project } of byProject.values()) {
    const ctx = await guestProjectContext(deps, guest, project.id, { memberships });
    const unread = await deps.projectRepository.countUnread({ channelIds: here.map((entry) => entry.channelId), principalId: ctx.principal.id, principalType: 'stakeholder', tenantId: guest.tenantId });
    const channels = here
      .map((entry) => presentChannel(entry.channel, ctx, entry.channel.archivedAt ? 0 : unread.get(entry.channelId) ?? 0))
      .sort((left, right) => Number(right.isGeneral) - Number(left.isGeneral) || Number(Boolean(left.archivedAt)) - Number(Boolean(right.archivedAt)) || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
    projects.push({ ...presentProject(project), channels, unreadCount: channels.reduce((sum, channel) => sum + channel.unreadCount, 0) });
  }
  projects.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
  return { ok: true, projects };
}

export async function getGuestChannel(deps, guest, channelId) {
  const { channel, ctx } = await requireGuestChannel(deps, guest, channelId, { memberships: guest.memberships });
  const unread = await deps.projectRepository.countUnread({ channelIds: [channelId], principalId: ctx.principal.id, principalType: 'stakeholder', tenantId: guest.tenantId });
  return {
    channel: presentChannel(channel, ctx, channel.archivedAt ? 0 : unread.get(channelId) ?? 0),
    ok: true,
    project: presentProject(ctx.project),
  };
}

// What a guest sees of a file: no links to work items and no audience, which are the team's.
const GUEST_FILE_FIELDS = ['contentType', 'createdAt', 'description', 'editing', 'fileName', 'fileSize', 'folderId', 'folderPath', 'id', 'projectId', 'scanStatus', 'sha256', 'targetId', 'targetType', 'updatedAt', 'uploadedBy', 'version', 'versionNote', 'versionUploadedAt'];

export function presentGuestFile(file) {
  if (!file) return null;
  const view = Object.fromEntries(GUEST_FILE_FIELDS.filter((key) => key in file).map((key) => [key, file[key]]));
  if (view.uploadedBy) view.uploadedBy = { id: view.uploadedBy.id ?? null, name: view.uploadedBy.name ?? '' };
  return view;
}

export async function listGuestChannelFiles(deps, guest, channelId) {
  const { channel, ctx } = await requireGuestChannel(deps, guest, channelId, { memberships: guest.memberships });
  const files = await deps.projectRepository.listFiles({ projectId: ctx.projectId, targetId: channelId, targetType: 'channel', tenantId: guest.tenantId });
  return { canWrite: ctx.canWriteFiles && !channel.archivedAt, files: files.map(presentGuestFile), ok: true };
}

export async function listGuestFileVersions(deps, guest, fileId) {
  const { file } = await requireGuestFile(deps, guest, fileId, { memberships: guest.memberships });
  const versions = await deps.projectRepository.listFileVersions({ fileId, tenantId: guest.tenantId });
  if (!versions) throw notFound('File not found.');
  return { file: presentGuestFile(file), ok: true, versions: versions.map((version) => ({ ...version, uploadedBy: version.uploadedBy ? { id: version.uploadedBy.id ?? null, name: version.uploadedBy.name ?? '' } : null })) };
}

export async function getGuestDownloadUrl(deps, large, guest, fileId, options, { ipAddress = '' } = {}) {
  const { ctx } = await requireGuestReadableFile(deps, guest, fileId, { memberships: guest.memberships });
  const result = await getDownloadUrl(large, { fileId, tenantId: guest.tenantId }, options);
  await auditGuest(deps, { action: options.inline ? 'guest.file_view' : 'guest.download', detail: { fileId, version: result.version }, ipAddress, projectId: ctx.projectId, tenantId: guest.tenantId, userId: guestActor(guest) });
  return result;
}

export async function getGuestPreviewUrl(deps, large, guest, fileId, options, { ipAddress = '' } = {}) {
  const { ctx } = await requireGuestReadableFile(deps, guest, fileId, { memberships: guest.memberships });
  const result = await getPreviewUrl(large, { fileId, tenantId: guest.tenantId }, options);
  if (result.url) await auditGuest(deps, { action: 'guest.file_view', detail: { fileId, version: result.version }, ipAddress, projectId: ctx.projectId, tenantId: guest.tenantId, userId: guestActor(guest) });
  return result;
}

// --- uploads ------------------------------------------------------------------------------------

function requireWritableChannel(ctx, channel) {
  if (!ctx.canWriteFiles) throw new HttpError(403, 'This engagement is read-only.', { details: { code: 'engagement_closed' } });
  if (channel?.archivedAt) throw channelArchivedError();
}

/**
 * Starts an upload into one of the guest's channels, a new version of a file in one, or a new
 * attachment on a pursuit task of their own.
 */
export async function startGuestUpload(deps, large, guest, input) {
  if (!input.fileId && input.targetType === 'task' && input.targetId) {
    const { ctx, task } = await requireGuestTask(deps, guest, input.targetId, { change: 'attachment', needsFiles: true });
    requireWritableChannel(ctx, null);
    return startUpload(large, { projectId: ctx.projectId, tenantId: guest.tenantId, user: ctx.fileActor }, { ...input, folderId: null, targetId: task.id, targetType: 'task' });
  }
  let place;
  if (input.fileId) {
    place = await requireGuestFile(deps, guest, input.fileId, { memberships: guest.memberships, needsFiles: true });
  } else {
    if (input.targetType !== 'channel' || !input.targetId) throw new HttpError(400, 'Choose one of your channels for the file.', { details: { code: 'target_required' } });
    place = await requireGuestChannel(deps, guest, input.targetId, { memberships: guest.memberships, needsFiles: true });
  }
  requireWritableChannel(place.ctx, place.channel);
  return startUpload(large, { projectId: place.ctx.projectId, tenantId: guest.tenantId, user: place.ctx.fileActor }, { ...input, targetId: place.channel.id, targetType: 'channel' });
}

// The guest's own upload, still into a channel they are in or onto a pursuit task of their own.
async function requireGuestUpload(deps, guest, uploadId) {
  const owner = await deps.authRepository?.findOrCreateStakeholderOwner?.({ email: guest.email, name: '' });
  if (!owner?.id) throw notFound('Upload not found.');
  const upload = await findOwnUpload(deps, { tenantId: guest.tenantId, uploadId, userId: owner.id });
  if (upload.targetType === 'task') {
    const { ctx } = await requireGuestTask(deps, guest, upload.targetId, { change: 'attachment', needsFiles: true, projectId: upload.projectId }).catch(() => {
      throw notFound('Upload not found.');
    });
    return { channel: null, ctx, taskId: upload.targetId, upload };
  }
  if (upload.targetType !== 'channel') throw notFound('Upload not found.');
  const place = await requireGuestChannel(deps, guest, upload.targetId, { memberships: guest.memberships, needsFiles: true }).catch(() => {
    throw notFound('Upload not found.');
  });
  return { ...place, upload };
}

export async function getGuestUpload(deps, large, guest, uploadId) {
  const { upload } = await requireGuestUpload(deps, guest, uploadId);
  return describeUpload(large, { upload });
}

export async function signGuestUploadParts(deps, large, guest, uploadId, input) {
  const { channel, ctx, upload } = await requireGuestUpload(deps, guest, uploadId);
  requireWritableChannel(ctx, channel);
  return signUploadParts(large, { tenantId: guest.tenantId, upload }, input);
}

export async function completeGuestUpload(deps, large, guest, uploadId, input, { ipAddress = '' } = {}) {
  const { channel, ctx, taskId = null, upload } = await requireGuestUpload(deps, guest, uploadId);
  requireWritableChannel(ctx, channel);
  const result = await completeUpload(large, { tenantId: guest.tenantId, upload, user: ctx.fileActor }, input);
  await auditGuest(deps, { action: 'guest.upload', detail: { fileId: result.file?.id ?? null, size: result.file?.fileSize ?? null, taskId, uploadId, version: result.file?.version ?? null }, ipAddress, projectId: ctx.projectId, tenantId: guest.tenantId, userId: guestActor(guest) });
  // A task attachment tells the members' board; a channel file tells the channel (the route).
  if (taskId) publishProjectChanged(deps.liveEventBus, ctx.projectId, { actor: { id: ctx.principal.id, name: ctx.principal.name }, itemId: taskId, reason: 'guest-task-attached' });
  return { ...result, channelId: channel?.id ?? null, ctx, file: presentGuestFile(result.file), taskId };
}

export async function cancelGuestUpload(deps, large, guest, uploadId) {
  const { upload } = await requireGuestUpload(deps, guest, uploadId);
  return cancelUpload(large, { tenantId: guest.tenantId, upload });
}

// --- tasks ---------------------------------------------------------------------------------------

/**
 * The tasks a guest sees on a project they are in, from the task
 * source the pursuit board supplies (guest-tasks.js). Without one, none.
 */
export async function listGuestTasks(deps, guest, projectId) {
  const ctx = await guestProjectContext(deps, guest, projectId, { memberships: guest.memberships });
  const source = deps.guestTaskSource ?? NO_GUEST_TASKS;
  const stakeholderIds = [ctx.principal.id];
  const result = await source.listTasksForGuest({ accessLinkId: guest.accessLinkId, email: guest.email, projectId, stakeholderIds, tenantId: guest.tenantId });
  return { available: source.available !== false, ok: true, readOnly: ctx.readOnly, statuses: result?.statuses ?? [], tasks: result?.tasks ?? [], wholeBoard: Boolean(result?.wholeBoard) };
}

export async function updateGuestTask(deps, guest, projectId, taskId, input) {
  const ctx = await guestProjectContext(deps, guest, projectId, { memberships: guest.memberships });
  if (ctx.readOnly) throw new HttpError(403, 'This engagement is read-only.', { details: { code: 'engagement_closed' } });
  const source = deps.guestTaskSource ?? NO_GUEST_TASKS;
  if (typeof source.updateTaskForGuest !== 'function') throw notFound('Task not found.');
  const result = await source.updateTaskForGuest({ accessLinkId: guest.accessLinkId, actor: guestTaskActor(ctx), email: guest.email, input, projectId, stakeholderIds: [ctx.principal.id], taskId, tenantId: guest.tenantId });
  if (!result) throw notFound('Task not found.');
  return { ok: true, task: result.task ?? result };
}

/** Comments on a pursuit task the guest sees, oldest first. */
export async function listGuestTaskComments(deps, guest, projectId, taskId) {
  const ctx = await guestProjectContext(deps, guest, projectId, { memberships: guest.memberships });
  const source = deps.guestTaskSource ?? NO_GUEST_TASKS;
  if (typeof source.listTaskCommentsForGuest !== 'function') throw notFound('Task not found.');
  const result = await source.listTaskCommentsForGuest({ actor: guestTaskActor(ctx), projectId, stakeholderIds: [ctx.principal.id], taskId, tenantId: guest.tenantId });
  return { canComment: result.canComment && !ctx.readOnly, comments: result.comments, ok: true };
}

/** A comment on a pursuit task of the guest's own. */
export async function addGuestTaskComment(deps, guest, projectId, taskId, input) {
  const ctx = await guestProjectContext(deps, guest, projectId, { memberships: guest.memberships });
  if (ctx.readOnly) throw new HttpError(403, 'This engagement is read-only.', { details: { code: 'engagement_closed' } });
  const source = deps.guestTaskSource ?? NO_GUEST_TASKS;
  if (typeof source.addTaskCommentForGuest !== 'function') throw notFound('Task not found.');
  const result = await source.addTaskCommentForGuest({ actor: guestTaskActor(ctx), input, projectId, stakeholderIds: [ctx.principal.id], taskId, tenantId: guest.tenantId });
  return { comment: result.comment, ok: true };
}

/** The files attached to a pursuit task the guest sees, and whether they may add one. */
export async function listGuestTaskFiles(deps, guest, projectId, taskId) {
  const { ctx, task } = await requireGuestTask(deps, guest, taskId, { projectId });
  const files = await deps.projectRepository.listFiles({ projectId, targetId: taskId, targetType: 'task', tenantId: guest.tenantId });
  return { canWrite: ctx.canWriteFiles && task.canChange.includes('attachment'), files: files.map(presentGuestFile), ok: true };
}

// --- members: inviting and removing guests ------------------------------------------------------

async function requireMemberChannel(deps, user, projectId, channelId) {
  const ctx = await channelAccess(deps, user, projectId);
  const channel = await deps.projectRepository.getChannel({ channelId, projectId, tenantId: ctx.tenantId });
  if (!channel) throw notFound('Channel not found.');
  return { channel, ctx };
}

function requireInviteRights(ctx) {
  if (!ctx.canDecide) throw new HttpError(403, 'Only a project admin or manager can invite or remove guests.', { details: { code: 'decision_rights_required' } });
}

/** The channel's guests, with when each last used Odin. Every member sees them; decision rights manage them. */
export async function listChannelGuestsForUser(deps, user, projectId, channelId) {
  const { channel, ctx } = await requireMemberChannel(deps, user, projectId, channelId);
  const guests = await deps.projectRepository.listChannelGuests({ channelId, tenantId: ctx.tenantId });
  const stakeholders = new Map(((await deps.assistantRepository.listProjectStakeholders({ projectId, tenantId: ctx.tenantId })) ?? []).map((entry) => [entry.id, entry]));
  const links = new Map();
  for (const guest of guests) {
    const email = stakeholders.get(guest.stakeholderId)?.email ?? guest.email;
    const link = email ? await deps.accessRepository.findLinkByEmail?.({ email, tenantId: ctx.tenantId }) : null;
    if (link) links.set(guest.stakeholderId, link.id);
  }
  const lastSeen = await deps.guestSessionsRepository.lastSeenByLinks({ accessLinkIds: [...new Set(links.values())] });
  // Guests of the project's other channels, to add here with one step.
  const elsewhere = new Map();
  for (const row of await deps.projectRepository.listProjectChannelGuests?.({ projectId, tenantId: ctx.tenantId }) ?? []) {
    if (row.channelId !== channelId && !guests.some((guest) => guest.stakeholderId === row.stakeholderId) && stakeholders.has(row.stakeholderId)) elsewhere.set(row.stakeholderId, stakeholders.get(row.stakeholderId));
  }
  const person = (stakeholder, fallback = {}) => ({ email: stakeholder?.email ?? fallback.email ?? '', name: stakeholder?.name ?? fallback.name ?? '', organization: stakeholder?.roleTitle ?? '', stakeholderId: stakeholder?.id ?? fallback.stakeholderId });
  return {
    canManage: ctx.canDecide && !channel.archivedAt,
    guests: guests
      .map((guest) => ({ ...person(stakeholders.get(guest.stakeholderId), guest), invitedAt: guest.invitedAt ?? null, lastSeenAt: lastSeen.get(links.get(guest.stakeholderId)) ?? null }))
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })),
    ok: true,
    otherGuests: [...elsewhere.values()].map((stakeholder) => person(stakeholder)).sort((left, right) => left.name.localeCompare(right.name)),
  };
}

/**
 * Invites a guest to a channel by name, email and organization: reuses or
 * makes their stakeholder record on the project and their access link for the workspace, adds
 * them to the channel and queues the invitation. Inviting someone already in the channel changes
 * nothing and sends nothing. Workspace members are added to the project instead.
 */
export async function inviteChannelGuestForUser(deps, user, projectId, channelId, input, { ipAddress = '' } = {}) {
  const { channel, ctx } = await requireMemberChannel(deps, user, projectId, channelId);
  requireInviteRights(ctx);
  if (channel.archivedAt) throw channelArchivedError();
  const email = validEmail(input.email);
  const member = await deps.authRepository?.findUserByEmail?.(email);
  if (member?.memberships?.some((membership) => membership.tenantId === ctx.tenantId)) {
    throw new HttpError(409, 'This person is a member of the workspace. Add them to the project instead.', { details: { code: 'guest_is_member' } });
  }
  const stakeholders = (await deps.assistantRepository.listProjectStakeholders({ projectId, tenantId: ctx.tenantId })) ?? [];
  let stakeholder = stakeholders.find((entry) => normalizeAccessEmail(entry.email) === email) ?? null;
  const name = String(input.name ?? '').trim();
  const organization = String(input.organization ?? '').trim();
  if (!stakeholder) {
    if (!name) throw new HttpError(400, 'Enter the guest’s name.', { details: { code: 'guest_name_required' } });
    // Their organization goes in the stakeholder's role or title, which the team already sees.
    stakeholder = await deps.assistantRepository.createProjectStakeholder({ projectId, tenantId: ctx.tenantId, value: { email, name, roleTitle: organization } });
  }
  const at = nowOf(deps);
  const link = await deps.accessRepository.ensureLink({ createdBy: user.id, email, now: at, tenantId: ctx.tenantId });
  const { added } = await deps.projectRepository.addChannelGuest({ channel, invitedBy: user.id, stakeholder: { email, id: stakeholder.id, name: stakeholder.name } });
  let invitationQueued = false;
  if (added) {
    try {
      const project = await deps.projectRepository.getProjectHeader?.({ projectId, tenantId: ctx.tenantId });
      const workspaceName = (await deps.authRepository?.findTenantById?.(ctx.tenantId))?.name ?? 'Odin';
      const channelUrl = `${guestChannelUrl(deps, { channelId })}?workspace=${encodeURIComponent(ctx.tenantId)}`;
      invitationQueued = Boolean(await queueSigningEmail({
        mailRepository: deps.mailRepository,
        recipientEmail: email,
        targetId: `${channelId}:${stakeholder.id}:${at.valueOf()}`,
        templateId: GUEST_INVITATION_TEMPLATE_ID,
        vars: { channelName: `#${channel.name}`, channelUrl, projectName: project?.name ?? 'a project', recipientName: stakeholder.name || 'there', senderName: user.name || 'Someone', workspaceName },
      }));
    } catch (error) {
      logBackendError({ context: buildOperationLogContext('guests.invite', { projectId, tenantId: ctx.tenantId, userId: user.id }), error, level: 'warn', message: 'A guest invitation could not be queued; the guest was added.' });
    }
    await auditGuest(deps, { action: 'guest.invite', detail: { accessLinkId: link.id, channelId, stakeholderId: stakeholder.id }, ipAddress, projectId, tenantId: ctx.tenantId, userId: user.id });
    publishGuestChanged(deps.liveEventBus, link.id);
  }
  return { added, guest: { email, name: stakeholder.name, organization: stakeholder.roleTitle ?? organization, stakeholderId: stakeholder.id }, invitationQueued, ok: true };
}

/** Removes a guest from a channel. Their next request there is refused; with no channel left in the workspace, their sessions end. */
export async function removeChannelGuestForUser(deps, user, projectId, channelId, stakeholderId, { ipAddress = '' } = {}) {
  const { channel, ctx } = await requireMemberChannel(deps, user, projectId, channelId);
  // A lost engagement is read-only, but its guests can still be removed.
  requireInviteRights({ canDecide: ctx.decisionRights });
  const stakeholder = await deps.assistantRepository.findProjectStakeholderById?.({ projectId, stakeholderId, tenantId: ctx.tenantId });
  const removed = await deps.projectRepository.removeChannelGuest({ channel, removedBy: user.id, stakeholderId });
  if (!removed) throw notFound('That guest is not in this channel.');
  let accessEnded = false;
  if (stakeholder?.email) accessEnded = await endAccessIfNoChannels(deps, { email: stakeholder.email, tenantId: ctx.tenantId });
  await auditGuest(deps, { action: 'guest.remove', detail: { accessEnded, channelId, stakeholderId }, ipAddress, projectId, tenantId: ctx.tenantId, userId: user.id });
  return { accessEnded, ok: true, removed: true };
}
