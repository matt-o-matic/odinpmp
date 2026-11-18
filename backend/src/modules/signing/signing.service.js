import { randomInt, randomUUID } from 'node:crypto';

import { requireDecisionRights, resolveDecisionRights } from '../../lib/auth/decision-rights.js';
import { PROJECT_CAPABILITIES, requireProjectCapability } from '../../lib/auth/project-capabilities.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { publishProjectChanged } from '../../lib/events/project-live-events.js';
import { buildOperationLogContext, logBackendError } from '../../lib/logging/backend-logger.js';
import { signingChange } from '../changes/project-change-log.js';
import { queueSigningEmail } from '../mail/mail.service.js';
import { SIGNING_CODE_TEMPLATE_ID, SIGNING_REQUEST_TEMPLATE_ID, SIGNING_UPDATE_TEMPLATE_ID } from '../mail/mail.templates.js';
import { buildRequirementsPortalUrl, generateAccessToken, hashAccessToken } from '../requirements/requirements-access-links.js';
import { resolvePortalAccess } from '../requirements/requirements-portal.service.js';
import { certificateLines, renderTextPdf } from './signing-certificate.js';
import { canonicalJson, sha256Hex } from './signing-seal.js';

// Signature requests (docs/document-signing/plan.md), after invoice-gen's statement of work
// signing: the team freezes a package of document versions and a statement, names stakeholders
// as signers, and each signer signs in the client portal with a one-time code emailed to them.
// Every signature keeps a sealed evidence record; a completed request keeps a sealed manifest.

export const SIGNING_KINDS = Object.freeze(['acceptance', 'signoff']);
export const DEFAULT_STATEMENTS = Object.freeze({
  acceptance: 'I have reviewed the documents listed here and accept them on behalf of my organization.',
  signoff: 'I confirm that the work described here is complete and accepted, and I sign it off on behalf of my organization.',
});
export const CONSENT_VERSION = 'odin-esign-consent-v1';
export const CONSENT_TEXT = 'I agree to sign electronically. My typed name and this action have the same effect as my handwritten signature on what is listed here.';
const EVIDENCE_DISCLOSURE = 'Odin keeps your typed name, title and organization, the time, your IP address, your browser\'s user agent, language, time zone and platform, and how you verified your email, as evidence of this signature.';
export const CODE_TTL_MS = 15 * 60_000;
export const CODE_RESEND_MS = 60_000;
export const CODE_MAX_ATTEMPTS = 5;
const MAX_DOCUMENTS = 20;
const MAX_SIGNERS = 20;

const KIND_NAMES = { acceptance: 'acceptance', signoff: 'sign-off' };

/** The dependencies the signing service reads from the app's. */
export function signingDeps(deps) {
  return {
    assistantRepository: deps.assistantRepository,
    authRepository: deps.authRepository ?? null,
    clock: deps.requirementsClock ?? (() => new Date()),
    frontendAppUrl: deps.frontendAppUrl ?? '',
    governanceRepository: deps.governanceRepository ?? null,
    liveEventBus: deps.liveEventBus ?? null,
    mailRepository: deps.mailRepository ?? null,
    projectRepository: deps.projectRepository,
    requirementsRepository: deps.requirementsRepository,
    signingRepository: deps.signingRepository,
    signingSealer: deps.signingSealer,
    workspaceModulesRepository: deps.workspaceModulesRepository ?? null,
  };
}

const now = (deps) => (deps.clock ? deps.clock() : new Date());
const conflict = (message, code, details = {}) => new HttpError(409, message, { details: { code, ...details } });
const notFound = (message = 'Signature request not found.') => new HttpError(404, message, { details: { code: 'signing_request_not_found' } });

function tenantIdFor(user) {
  const tenantId = user?.memberships?.[0]?.tenantId ?? null;
  if (!tenantId) throw new HttpError(403, 'This account is not assigned to a tenant.');
  return tenantId;
}

function requireSealer(deps) {
  if (!deps.signingSealer?.configured) {
    throw new HttpError(503, 'Signing is not set up on this server yet: it needs a seal key.', { details: { code: 'signing_not_configured' } });
  }
}

function clean(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function maskEmail(email) {
  const [local = '', domain = ''] = String(email ?? '').split('@');
  if (!domain) return '';
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(1, Math.min(local.length - 1, 6)))}@${domain}`;
}

function codeHash(signerId, code) {
  return sha256Hex(`${signerId}:${code}`);
}

const portalBase = (deps, token) => buildRequirementsPortalUrl({ frontendAppUrl: deps.frontendAppUrl, token });
const signingUrl = (deps, token, requestId) => `${portalBase(deps, token)}/signing/${encodeURIComponent(requestId)}`;
const appRequestUrl = (deps, projectId, requestId) => {
  const url = new URL(`${String(deps.frontendAppUrl || 'http://localhost:5173/app').replace(/\/$/, '')}/projects/${encodeURIComponent(projectId)}`);
  url.searchParams.set('projectSettings', 'files');
  url.searchParams.set('signing', requestId);
  return url.toString();
};

function logMailFailure(error, context) {
  logBackendError({ context: buildOperationLogContext('signing.email', context), error, level: 'warn', message: 'Signing email could not be queued.' });
}

// --- presentation -------------------------------------------------------------------------

function subjectName(detail, { milestones = [], projectName = '' } = {}) {
  const { request, documents } = detail;
  if (request.subjectType === 'project') return projectName || 'The project';
  if (request.subjectType === 'milestone') return milestones.find((item) => item.id === request.subjectId)?.title ?? 'A milestone';
  return documents[0]?.fileName ?? 'A document';
}

function presentDocument(document) {
  return {
    contentType: document.contentType,
    fileId: document.fileId,
    fileName: document.fileName,
    fileSize: document.fileSize,
    position: document.position,
    sha256: document.sha256,
    version: document.version,
  };
}

function signerProgress(signers) {
  const counted = signers.filter((signer) => signer.status !== 'removed');
  return { signed: counted.filter((signer) => signer.status === 'signed').length, total: counted.length };
}

/** A request as the team sees it. `full` adds the audit trail and the evidence with seal checks. */
export function presentRequestForMember(deps, detail, { full = false, names = new Map(), subject = '' } = {}) {
  const { documents, events, request, signatures, signers } = detail;
  const sealer = deps.signingSealer;
  const signatureBySigner = new Map(signatures.map((signature) => [signature.signerId, signature]));
  return {
    createdAt: request.createdAt,
    createdBy: { id: request.createdBy.replace(/^user:/, ''), name: names.get(request.createdBy) ?? null },
    documents: documents.map(presentDocument),
    endReason: request.endReason ?? null,
    endedAt: request.endedAt,
    endedBy: request.endedBy ? { id: request.endedBy, name: names.get(request.endedBy) ?? null } : null,
    id: request.id,
    kind: request.kind,
    message: request.message,
    packageHash: request.packageHash,
    progress: signerProgress(signers),
    projectId: request.projectId,
    signers: signers.map((signer) => {
      const signature = signatureBySigner.get(signer.id);
      return {
        declineReason: signer.declineReason ?? null,
        declinedAt: signer.declinedAt,
        email: signer.email,
        id: signer.id,
        mail: signer.mailStatus ? { reason: signer.mailReason ?? null, status: signer.mailStatus } : null,
        name: signer.name,
        remindedAt: signer.remindedAt,
        removalReason: signer.removalReason ?? null,
        removedAt: signer.removedAt,
        signedAt: signer.signedAt,
        signedName: signer.signedName ?? null,
        signedOrganization: signer.signedOrganization ?? null,
        signedTitle: signer.signedTitle ?? null,
        stakeholderId: signer.stakeholderId,
        status: signer.status,
        ...(full && signature ? {
          evidence: JSON.parse(signature.evidenceJson),
          evidenceHash: signature.evidenceHash,
          sealKeyId: signature.sealKeyId,
          sealValid: Boolean(sealer?.verify(signature.evidenceJson, signature.seal, signature.sealKeyId))
            && sha256Hex(signature.evidenceJson) === signature.evidenceHash,
        } : {}),
      };
    }),
    statement: request.statement,
    status: request.status,
    subject: { id: request.subjectId, name: subject, type: request.subjectType },
    title: request.title,
    ...(request.manifestHash ? {
      manifestHash: request.manifestHash,
      ...(full ? {
        manifestValid: Boolean(sealer?.verify(request.manifestJson, request.seal, request.sealKeyId)) && sha256Hex(request.manifestJson) === request.manifestHash,
        sealKeyId: request.sealKeyId,
      } : {}),
    } : {}),
    ...(full ? {
      events: events.map((event) => ({ action: event.action, actor: { id: event.actor, name: names.get(event.actor) ?? null }, at: event.createdAt, detail: event.detail ?? null, signerId: event.signerId ?? null })),
      packageValid: sha256Hex(request.packageJson) === request.packageHash,
    } : {}),
  };
}

/** A request as a stakeholder sees it: names and progress, no emails or evidence (E-03). */
export function presentRequestForPortal(detail, { stakeholderId, subject = '' }) {
  const { documents, request, signers } = detail;
  const me = signers.find((signer) => signer.stakeholderId === stakeholderId) ?? null;
  return {
    createdAt: request.createdAt,
    documents: documents.map(presentDocument),
    endReason: request.status === 'cancelled' || request.status === 'declined' ? request.endReason ?? null : null,
    endedAt: request.endedAt,
    id: request.id,
    kind: request.kind,
    me: me ? {
      codeSentAt: me.codeSentAt,
      status: me.status,
    } : null,
    message: request.message,
    packageHash: request.packageHash,
    progress: signerProgress(signers),
    signers: signers.filter((signer) => signer.status !== 'removed').map((signer) => ({
      declinedAt: signer.declinedAt,
      isMe: signer.stakeholderId === stakeholderId,
      name: signer.status === 'signed' ? signer.signedName ?? signer.name : signer.name,
      organization: signer.signedOrganization ?? null,
      signedAt: signer.signedAt,
      status: signer.status,
      title: signer.signedTitle ?? null,
    })),
    statement: request.statement,
    status: request.status,
    subject: { name: subject, type: request.subjectType },
    title: request.title,
    ...(request.manifestHash ? { manifestHash: request.manifestHash } : {}),
  };
}

async function projectContext(deps, { projectId, tenantId }) {
  const [project, governance] = await Promise.all([
    deps.projectRepository.getProjectDetail({ projectId, tenantId }),
    deps.governanceRepository?.listSnapshot ? deps.governanceRepository.listSnapshot({ projectId, tenantId }).catch(() => null) : null,
  ]);
  return { milestones: governance?.milestones ?? [], project, projectName: project?.name ?? '' };
}

async function actorNames(deps, { details, projectId, tenantId }) {
  const names = new Map();
  const ids = new Set();
  for (const { events, request } of details) {
    ids.add(request.createdBy);
    if (request.endedBy) ids.add(request.endedBy);
    for (const event of events ?? []) ids.add(event.actor);
  }
  const stakeholders = await deps.assistantRepository.listProjectStakeholders({ projectId, tenantId }).catch(() => []);
  const stakeholderNames = new Map(stakeholders.map((stakeholder) => [stakeholder.id, stakeholder.name]));
  for (const id of ids) {
    if (!id) continue;
    if (id.startsWith('stakeholder:')) names.set(id, stakeholderNames.get(id.slice('stakeholder:'.length)) ?? 'Stakeholder');
    else if (id.startsWith('user:')) {
      const user = await deps.authRepository?.findUserById?.(id.slice(5)).catch(() => null);
      names.set(id, user?.name || user?.email || null);
    } else if (id === 'system') names.set(id, 'Odin');
  }
  return names;
}

// --- completion -------------------------------------------------------------------------

/** The changes that complete a request whose last pending signer just signed or was removed. */
function completionChanges(deps, current, { at, signerUpdates = [], signature = null }) {
  const signers = current.signers.map((signer) => ({ ...signer, ...(signerUpdates.find((update) => update.id === signer.id) ?? {}) }));
  const signatures = [...current.signatures, ...(signature ? [signature] : [])];
  const manifest = {
    completedAt: at,
    packageHash: current.request.packageHash,
    removedSigners: signers.filter((signer) => signer.status === 'removed').map((signer) => ({ reason: signer.removalReason ?? null, removedAt: signer.removedAt, removedBy: signer.removedBy, signerId: signer.id })),
    requestId: current.request.id,
    schemaVersion: 'odin-signing-manifest-v1',
    signatures: signatures.map((entry) => ({ evidenceHash: entry.evidenceHash, seal: entry.seal, sealKeyId: entry.sealKeyId, signedAt: entry.signedAt, signerId: entry.signerId })),
  };
  const manifestJson = canonicalJson(manifest);
  const sealed = deps.signingSealer.seal(manifestJson);
  return {
    request: { endedAt: at, endedBy: 'system', manifestHash: sha256Hex(manifestJson), manifestJson, seal: sealed.seal, sealKeyId: sealed.sealKeyId, status: 'completed', updatedAt: at },
    event: { action: 'completed', actor: 'system', createdAt: at, detail: { manifestHash: sha256Hex(manifestJson) }, projectId: current.request.projectId, requestId: current.request.id, tenantId: current.request.tenantId },
  };
}

const pendingAfter = (current, updates) => current.signers.filter((signer) => (updates.find((update) => update.id === signer.id)?.status ?? signer.status) === 'pending');

// --- emails -------------------------------------------------------------------------------

async function issueSignerToken(deps, { createdBy, projectId, purpose, stakeholderId, tenantId }) {
  const token = generateAccessToken();
  try {
    await deps.requirementsRepository.issueAccessToken({ createdBy, now: now(deps), projectId, purpose, stakeholderId, tenantId, tokenHash: hashAccessToken(token) });
    return token;
  } catch (error) {
    if (error?.details?.code === 'link_revoked') return null;
    throw error;
  }
}

/** Asks each signer to sign (or reminds them). Returns signer updates for mail status; never throws for mail. */
async function emailSigners(deps, { createdBy, detail, kind = 'request', projectName, senderName, signerIds }) {
  const { request } = detail;
  const updates = [];
  for (const signer of detail.signers.filter((entry) => signerIds.includes(entry.id))) {
    const status = (mailStatus, mailReason = null) => updates.push({ id: signer.id, mailReason, mailStatus, ...(kind === 'reminder' ? { remindedAt: now(deps).toISOString() } : {}) });
    try {
      if (!deps.mailRepository?.queueMail) {
        status('not-sent', 'mail-not-configured');
        continue;
      }
      const token = await issueSignerToken(deps, { createdBy, projectId: request.projectId, purpose: kind === 'reminder' ? 'reminder' : 'signing', stakeholderId: signer.stakeholderId, tenantId: request.tenantId });
      if (!token) {
        status('not-sent', 'link-revoked');
        continue;
      }
      await queueSigningEmail({
        mailRepository: deps.mailRepository,
        message: kind === 'request' ? request.message : '',
        recipientEmail: signer.email,
        targetId: randomUUID(),
        templateId: SIGNING_REQUEST_TEMPLATE_ID,
        vars: {
          intro: kind === 'reminder'
            ? `${senderName || 'The project team'} is still waiting for your ${KIND_NAMES[request.kind]} of "${request.title}" for ${projectName || 'your project'}.`
            : `${senderName || 'The project team'} asks for your ${KIND_NAMES[request.kind]} of "${request.title}" for ${projectName || 'your project'}.`,
          recipientName: signer.name || 'there',
          signingUrl: signingUrl(deps, token, request.id),
          subjectPrefix: kind === 'reminder' ? 'Reminder: please sign ' : 'Please sign: ',
          title: request.title,
        },
      });
      status('queued');
    } catch (error) {
      logMailFailure(error, { projectId: request.projectId, requestId: request.id, signerId: signer.id, tenantId: request.tenantId });
      status('not-sent', 'queue-failed');
    }
  }
  return updates;
}

/** Tells signers and the requester that a request completed, was declined, or was withdrawn. */
async function emailOutcome(deps, { detail, projectName }) {
  if (!deps.mailRepository?.queueMail) return;
  const { request, signers } = detail;
  const headline = { cancelled: 'Signature request withdrawn', completed: 'Signed by everyone', declined: 'Signature declined' }[request.status];
  if (!headline) return;
  const decliner = signers.find((signer) => signer.status === 'declined');
  const body = {
    cancelled: `"${request.title}" for ${projectName || 'your project'} no longer needs your signature.${request.endReason ? ` Reason: ${request.endReason}` : ''}`,
    completed: `Everyone has signed "${request.title}" for ${projectName || 'your project'}. The completion certificate is on the request page.`,
    declined: `${decliner?.name ?? 'A signer'} declined "${request.title}" for ${projectName || 'your project'}, so the request has stopped.${request.endReason ? ` Reason: ${request.endReason}` : ''}`,
  }[request.status];
  const recipients = request.status === 'completed'
    ? signers.filter((signer) => signer.status === 'signed')
    : signers.filter((signer) => signer.status === 'pending' || (request.status === 'declined' && signer.status === 'signed'));
  for (const signer of recipients) {
    try {
      const token = await issueSignerToken(deps, { createdBy: 'system:signing', projectId: request.projectId, purpose: 'signing', stakeholderId: signer.stakeholderId, tenantId: request.tenantId });
      // A turned-off link means the team cut this person off: no email with a link that will not open.
      if (!token) continue;
      await queueSigningEmail({
        mailRepository: deps.mailRepository,
        recipientEmail: signer.email,
        targetId: randomUUID(),
        templateId: SIGNING_UPDATE_TEMPLATE_ID,
        vars: { body, headline, linkLabel: 'Open the request', linkUrl: signingUrl(deps, token, request.id), title: request.title },
      });
    } catch (error) {
      logMailFailure(error, { projectId: request.projectId, requestId: request.id, signerId: signer.id, tenantId: request.tenantId });
    }
  }
  if (request.status === 'cancelled') return;
  const requester = await deps.authRepository?.findUserById?.(request.createdBy.replace(/^user:/, '')).catch(() => null);
  if (!requester?.email) return;
  try {
    await queueSigningEmail({
      mailRepository: deps.mailRepository,
      recipientEmail: requester.email,
      targetId: randomUUID(),
      templateId: SIGNING_UPDATE_TEMPLATE_ID,
      vars: { body, headline, linkLabel: 'Open in Odin', linkUrl: appRequestUrl(deps, request.projectId, request.id), title: request.title },
    });
  } catch (error) {
    logMailFailure(error, { projectId: request.projectId, requestId: request.id, tenantId: request.tenantId });
  }
}

async function recordMailStatus(deps, detail, updates) {
  if (!updates.length) return detail;
  const { current } = await deps.signingRepository.withRequest(
    { projectId: detail.request.projectId, requestId: detail.request.id, tenantId: detail.request.tenantId },
    async (latest) => ({ changes: latest ? { signers: updates.filter((update) => latest.signers.some((signer) => signer.id === update.id)) } : null }),
  );
  return current ?? detail;
}

// --- members ------------------------------------------------------------------------------

export async function listSigningRequestsForUser(deps, { fileId = null, projectId, status = null, user }) {
  const tenantId = tenantIdFor(user);
  await requireProjectCapability({ capability: PROJECT_CAPABILITIES.FILE_READ, projectId, repository: deps.projectRepository, tenantId, user });
  const details = await deps.signingRepository.listRequests({ fileId, projectId, status, tenantId });
  const context = await projectContext(deps, { projectId, tenantId });
  const names = await actorNames(deps, { details: details.map((detail) => ({ request: detail.request })), projectId, tenantId });
  // What the screen should offer: sending and managing requests needs decision rights.
  const { allowed: canManage } = await resolveDecisionRights({ projectId, repository: deps.projectRepository, tenantId, user });
  return { canManage, ok: true, requests: details.map((detail) => presentRequestForMember(deps, detail, { names, subject: subjectName(detail, context) })) };
}

export async function getSigningRequestForUser(deps, { projectId, requestId, user }) {
  const tenantId = tenantIdFor(user);
  await requireProjectCapability({ capability: PROJECT_CAPABILITIES.FILE_READ, projectId, repository: deps.projectRepository, tenantId, user });
  const detail = await deps.signingRepository.getRequest({ projectId, requestId, tenantId });
  if (!detail) throw notFound();
  const { allowed: canManage } = await resolveDecisionRights({ projectId, repository: deps.projectRepository, tenantId, user });
  return { ...(await presentDetail(deps, detail)), canManage };
}

async function presentDetail(deps, detail) {
  const { projectId, tenantId } = detail.request;
  const context = await projectContext(deps, { projectId, tenantId });
  const names = await actorNames(deps, { details: [detail], projectId, tenantId });
  return { ok: true, request: presentRequestForMember(deps, detail, { full: true, names, subject: subjectName(detail, context) }) };
}

export async function createSigningRequestForUser(deps, { input, projectId, user }) {
  const tenantId = tenantIdFor(user);
  await requireDecisionRights({ projectId, repository: deps.projectRepository, tenantId, user });
  requireSealer(deps);
  const context = await projectContext(deps, { projectId, tenantId });
  if (!context.project) throw new HttpError(404, 'Project not found.');

  const kind = input.kind;
  const fileIds = [...new Set((input.documents ?? []).map((document) => document.fileId))];
  if (fileIds.length !== (input.documents ?? []).length) throw new HttpError(400, 'Each file can be in a request once.', { details: { code: 'duplicate_document' } });
  if (fileIds.length > MAX_DOCUMENTS) throw new HttpError(400, `A request can hold ${MAX_DOCUMENTS} documents at most.`, { details: { code: 'too_many_documents' } });
  if (kind === 'acceptance' && !fileIds.length) throw new HttpError(400, 'An acceptance request needs at least one document.', { details: { code: 'documents_required' } });

  let subjectType;
  let subjectId;
  if (kind === 'acceptance') {
    subjectType = 'file';
    subjectId = fileIds[0];
  } else if (input.subjectType === 'milestone') {
    subjectType = 'milestone';
    subjectId = input.subjectId;
    if (!context.milestones.some((milestone) => milestone.id === subjectId)) throw new HttpError(400, 'That milestone is not in this project.', { details: { code: 'invalid_subject' } });
  } else {
    subjectType = 'project';
    subjectId = projectId;
  }

  const signerIds = [...new Set(input.signerStakeholderIds ?? [])];
  if (!signerIds.length) throw new HttpError(400, 'Choose at least one signer.', { details: { code: 'signers_required' } });
  if (signerIds.length > MAX_SIGNERS) throw new HttpError(400, `A request can have ${MAX_SIGNERS} signers at most.`, { details: { code: 'too_many_signers' } });
  const stakeholders = await deps.assistantRepository.listProjectStakeholders({ projectId, tenantId });
  const signers = [];
  for (const [position, stakeholderId] of signerIds.entries()) {
    const stakeholder = stakeholders.find((entry) => entry.id === stakeholderId);
    if (!stakeholder) throw new HttpError(400, 'Every signer must be a stakeholder on this project.', { details: { code: 'invalid_signer', stakeholderId } });
    const email = clean(stakeholder.email, 255).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new HttpError(400, `${stakeholder.name || 'A signer'} has no email address, so they cannot get a signing code.`, { details: { code: 'signer_without_email', stakeholderId } });
    const link = await deps.requirementsRepository.getAccessLinkForStakeholder?.({ projectId, stakeholderId, tenantId });
    if (link?.revokedAt) throw conflict(`${stakeholder.name || 'A signer'}'s portal link is turned off. Send them a new link first.`, 'stakeholder_link_revoked', { stakeholderId });
    signers.push({ email, name: clean(stakeholder.name, 255) || email, position, stakeholderId });
  }

  const documents = [];
  for (const [position, entry] of (input.documents ?? []).entries()) {
    const record = await deps.projectRepository.getFileRecord({ fileId: entry.fileId, tenantId });
    if (!record || record.projectId !== projectId) throw new HttpError(404, 'File not found in this project.', { details: { code: 'file_not_found', fileId: entry.fileId } });
    if (record.targetType === 'ticket') throw new HttpError(400, 'Files on tickets cannot be shared or signed.', { details: { code: 'ticket_file', fileId: entry.fileId } });
    // The SHA-256 stored when the file was scanned, so a large file is never read into memory. A
    // file whose scan has not passed is refused (409 file_scanning, file_infected, file_scan_failed).
    const source = await deps.projectRepository.getFileVersionSource({ fileId: entry.fileId, includeBytes: false, tenantId, version: entry.version ?? null });
    if (!source) throw new HttpError(404, 'That version of the file was not found.', { details: { code: 'file_version_not_found', fileId: entry.fileId } });
    const fileSize = source.bytes ? source.bytes.length : Number(source.fileSize ?? 0);
    const sha256 = source.sha256 ?? sha256Hex(source.bytes);
    documents.push({ contentType: source.contentType || 'application/octet-stream', fileId: entry.fileId, fileName: source.fileName, fileSize, position, sha256, storageKey: source.storageKey, version: source.version });
  }

  const title = clean(input.title, 240);
  const statement = String(input.statement ?? '').trim().slice(0, 4000) || DEFAULT_STATEMENTS[kind];
  const message = String(input.message ?? '').trim().slice(0, 4000);
  const pkg = {
    documents: documents.map(({ contentType, fileId, fileName, fileSize, position, sha256, version }) => ({ contentType, fileId, fileName, fileSize, position, sha256, version })),
    kind,
    projectId,
    schemaVersion: 'odin-signing-package-v1',
    statement,
    subject: { id: subjectId, type: subjectType },
    title,
  };
  const packageJson = canonicalJson(pkg);
  const at = now(deps).toISOString();
  const requestId = randomUUID();
  const actor = `user:${user.id}`;
  const request = {
    createdAt: at, createdBy: actor, endReason: null, endedAt: null, endedBy: null, id: requestId, kind, manifestHash: null, manifestJson: null, message,
    packageHash: sha256Hex(packageJson), packageJson, projectId, seal: null, sealKeyId: null, statement, status: 'pending', subjectId, subjectType, tenantId, title, updatedAt: at,
  };
  const created = await deps.signingRepository.createRequest({
    changes: [signingChange({ action: 'create', actorId: user.id, projectId, request, tenantId })],
    documents: documents.map((document) => ({ ...document, id: randomUUID(), projectId, requestId, tenantId })),
    events: [{ action: 'requested', actor, createdAt: at, detail: { documents: documents.length, packageHash: request.packageHash, signers: signers.length }, projectId, requestId, tenantId }],
    request,
    signers: signers.map((signer) => ({ ...signer, codeAttempts: 0, id: randomUUID(), mailStatus: null, projectId, requestId, status: 'pending', tenantId })),
  });

  // Signers must see what they sign, so the documents are shared with stakeholders.
  for (const document of documents) {
    await deps.projectRepository.setFileAudience({ audience: 'external', fileId: document.fileId, projectId, tenantId, user }).catch((error) => {
      logBackendError({ context: buildOperationLogContext('signing.shareDocument', { fileId: document.fileId, projectId, tenantId }), error, level: 'warn', message: 'A signed document could not be marked external.' });
    });
  }
  const mail = await emailSigners(deps, { createdBy: actor, detail: created, projectName: context.projectName, senderName: user.name ?? '', signerIds: created.signers.map((signer) => signer.id) });
  return presentDetail(deps, await recordMailStatus(deps, created, mail));
}

export async function cancelSigningRequestForUser(deps, { input = {}, projectId, requestId, user }) {
  const tenantId = tenantIdFor(user);
  await requireDecisionRights({ projectId, repository: deps.projectRepository, tenantId, user });
  const at = now(deps).toISOString();
  const reason = clean(input.reason, 1000) || null;
  const { current } = await deps.signingRepository.withRequest({ projectId, requestId, tenantId }, async (latest) => {
    if (!latest) throw notFound();
    if (latest.request.status !== 'pending') throw conflict(`This request is already ${latest.request.status}.`, 'signing_request_not_pending', { status: latest.request.status });
    const request = { ...latest.request, endReason: reason, endedAt: at, endedBy: `user:${user.id}`, status: 'cancelled', updatedAt: at };
    return {
      changes: {
        events: [{ action: 'cancelled', actor: `user:${user.id}`, createdAt: at, detail: { reason }, projectId, requestId, tenantId }],
        projectChanges: [signingChange({ action: 'cancel', actorId: user.id, projectId, request, tenantId })],
        request: { endReason: reason, endedAt: at, endedBy: `user:${user.id}`, status: 'cancelled', updatedAt: at },
      },
    };
  });
  const { projectName } = await projectContext(deps, { projectId, tenantId });
  await emailOutcome(deps, { detail: current, projectName });
  return presentDetail(deps, current);
}

export async function removeSignerForUser(deps, { input = {}, projectId, requestId, signerId, user }) {
  const tenantId = tenantIdFor(user);
  await requireDecisionRights({ projectId, repository: deps.projectRepository, tenantId, user });
  const at = now(deps).toISOString();
  const reason = clean(input.reason, 1000) || null;
  let completed = false;
  const { current } = await deps.signingRepository.withRequest({ projectId, requestId, tenantId }, async (latest) => {
    if (!latest) throw notFound();
    if (latest.request.status !== 'pending') throw conflict(`This request is already ${latest.request.status}.`, 'signing_request_not_pending', { status: latest.request.status });
    const signer = latest.signers.find((entry) => entry.id === signerId);
    if (!signer) throw notFound('Signer not found on this request.');
    if (signer.status !== 'pending') throw conflict('Only a signer who has not signed can be removed.', 'signer_not_pending', { status: signer.status });
    if (latest.signers.filter((entry) => entry.status !== 'removed' && entry.id !== signerId).length === 0) throw conflict('A request needs at least one signer. Cancel the request instead.', 'last_signer');
    const update = { id: signerId, removalReason: reason, removedAt: at, removedBy: `user:${user.id}`, status: 'removed' };
    const events = [{ action: 'signer_removed', actor: `user:${user.id}`, createdAt: at, detail: { name: signer.name, reason }, projectId, requestId, signerId, tenantId }];
    const projectChanges = [];
    let request = null;
    if (pendingAfter(latest, [update]).length === 0) {
      const completion = completionChanges(deps, latest, { at, signerUpdates: [update] });
      request = completion.request;
      events.push(completion.event);
      projectChanges.push(signingChange({ action: 'complete', actorId: user.id, projectId, request: { ...latest.request, ...request }, tenantId }));
      completed = true;
    }
    return { changes: { events, projectChanges, request, signers: [update] } };
  });
  if (completed) {
    const { projectName } = await projectContext(deps, { projectId, tenantId });
    await emailOutcome(deps, { detail: current, projectName });
  }
  return presentDetail(deps, current);
}

export async function remindSignersForUser(deps, { input = {}, projectId, requestId, user }) {
  const tenantId = tenantIdFor(user);
  await requireDecisionRights({ projectId, repository: deps.projectRepository, tenantId, user });
  const detail = await deps.signingRepository.getRequest({ projectId, requestId, tenantId });
  if (!detail) throw notFound();
  if (detail.request.status !== 'pending') throw conflict(`This request is already ${detail.request.status}.`, 'signing_request_not_pending', { status: detail.request.status });
  const pending = detail.signers.filter((signer) => signer.status === 'pending' && (!input.signerId || signer.id === input.signerId));
  if (input.signerId && !pending.length) throw conflict('That signer is not waiting to sign.', 'signer_not_pending');
  const { projectName } = await projectContext(deps, { projectId, tenantId });
  const updates = await emailSigners(deps, { createdBy: `user:${user.id}`, detail, kind: 'reminder', projectName, senderName: user.name ?? '', signerIds: pending.map((signer) => signer.id) });
  const at = now(deps).toISOString();
  const { current } = await deps.signingRepository.withRequest({ projectId, requestId, tenantId }, async (latest) => ({
    changes: latest ? {
      events: [{ action: 'reminded', actor: `user:${user.id}`, createdAt: at, detail: { signers: updates.map((update) => update.id) }, projectId, requestId, tenantId }],
      signers: updates.filter((update) => latest.signers.some((signer) => signer.id === update.id)),
    } : null,
  }));
  return { ...(await presentDetail(deps, current ?? detail)), reminded: updates.filter((update) => update.mailStatus === 'queued').length };
}

export async function getCertificateForUser(deps, { projectId, requestId, user }) {
  const tenantId = tenantIdFor(user);
  await requireProjectCapability({ capability: PROJECT_CAPABILITIES.FILE_READ, projectId, repository: deps.projectRepository, tenantId, user });
  return renderCertificate(deps, await deps.signingRepository.getRequest({ projectId, requestId, tenantId }));
}

export async function getRequestDocumentForUser(deps, { position, projectId, requestId, user }) {
  const tenantId = tenantIdFor(user);
  await requireProjectCapability({ capability: PROJECT_CAPABILITIES.FILE_READ, projectId, repository: deps.projectRepository, tenantId, user });
  return readRequestDocument(deps, await deps.signingRepository.getRequest({ projectId, requestId, tenantId }), position);
}

async function renderCertificate(deps, detail) {
  if (!detail) throw notFound();
  if (detail.request.status !== 'completed') throw conflict('The certificate is ready once everyone has signed.', 'signing_request_not_completed', { status: detail.request.status });
  const context = await projectContext(deps, { projectId: detail.request.projectId, tenantId: detail.request.tenantId });
  const bytes = renderTextPdf({ lines: certificateLines({ detail, projectName: context.projectName, subjectName: subjectName(detail, context) }), title: `${detail.request.title} certificate` });
  return { bytes, contentType: 'application/pdf', fileName: `${detail.request.title.replace(/[^\w .-]+/g, '').trim() || 'Signature'} certificate.pdf` };
}

async function readRequestDocument(deps, detail, position) {
  if (!detail) throw notFound();
  const document = detail.documents.find((entry) => entry.position === position);
  if (!document) throw new HttpError(404, 'Document not found on this request.');
  // Streamed where the repository can, so a large document is not held in memory.
  if (deps.projectRepository.openStoredObject) {
    const { size, stream } = await deps.projectRepository.openStoredObject(document.storageKey);
    return { contentType: document.contentType, fileName: document.fileName, size, stream };
  }
  const bytes = await deps.projectRepository.readStoredObject(document.storageKey);
  return { bytes, contentType: document.contentType, fileName: document.fileName };
}

export { assertFilesNotUnderSignature } from './signing-guards.js';

// --- stakeholders (portal) ------------------------------------------------------------------

async function portalAccess(deps, token) {
  const access = await resolvePortalAccess({
    assistantRepository: deps.assistantRepository,
    clock: deps.clock,
    projectRepository: deps.projectRepository,
    requirementsRepository: deps.requirementsRepository,
    workspaceModulesRepository: deps.workspaceModulesRepository,
  }, { token });
  return { ...access, actor: `stakeholder:${access.stakeholder.id}` };
}

/** External files on the project, each with the requests it is in, and every request (E-03). */
export async function listPortalDocuments(deps, { token }) {
  const access = await portalAccess(deps, token);
  const { projectId, tenantId } = access;
  const files = await deps.projectRepository.listFiles({ projectId, targetId: projectId, targetType: 'project', tenantId });
  const details = await deps.signingRepository.listRequests({ projectId, tenantId });
  const context = await projectContext(deps, { projectId, tenantId });
  const requests = details.map((detail) => presentRequestForPortal(detail, { stakeholderId: access.stakeholder.id, subject: subjectName(detail, context) }));
  const shared = files.filter((file) => file.audience === 'external' && file.targetType !== 'ticket');
  return {
    awaitingMe: requests.filter((request) => request.status === 'pending' && request.me?.status === 'pending').map((request) => request.id),
    documents: shared.map((file) => ({
      contentType: file.contentType,
      description: file.description ?? '',
      fileName: file.fileName,
      fileSize: file.fileSize,
      id: file.id,
      requestIds: requests.filter((request) => request.documents.some((document) => document.fileId === file.id)).map((request) => request.id),
      updatedAt: file.versionUploadedAt ?? file.updatedAt,
      version: file.version ?? 1,
    })),
    ok: true,
    requests,
  };
}

export async function getPortalDocumentContent(deps, { fileId, token }) {
  const { projectId, tenantId } = await portalAccess(deps, token);
  const record = await deps.projectRepository.getFileRecord({ fileId, tenantId });
  if (!record || record.projectId !== projectId || record.audience !== 'external' || record.targetType === 'ticket') throw new HttpError(404, 'File not found.');
  if (deps.projectRepository.openFileContent) {
    const opened = await deps.projectRepository.openFileContent({ fileId, tenantId });
    if (!opened) throw new HttpError(404, 'File not found.');
    return { contentType: opened.contentType, fileName: opened.fileName ?? record.fileName, size: opened.size, stream: opened.stream };
  }
  const asset = await deps.projectRepository.getFileAsset({ fileId, tenantId });
  if (!asset) throw new HttpError(404, 'File not found.');
  return { bytes: Buffer.from(asset.bytes), contentType: asset.contentType, fileName: asset.file?.fileName ?? record.fileName };
}

export async function getPortalSigningRequest(deps, { requestId, token }) {
  const access = await portalAccess(deps, token);
  const detail = await deps.signingRepository.getRequest({ projectId: access.projectId, requestId, tenantId: access.tenantId });
  if (!detail) throw notFound();
  const context = await projectContext(deps, { projectId: access.projectId, tenantId: access.tenantId });
  return {
    consent: { text: CONSENT_TEXT, version: CONSENT_VERSION },
    disclosure: EVIDENCE_DISCLOSURE,
    ok: true,
    request: presentRequestForPortal(detail, { stakeholderId: access.stakeholder.id, subject: subjectName(detail, context) }),
    signer: { email: maskEmail(access.stakeholder.email), name: access.stakeholder.name ?? '' },
  };
}

export async function getPortalRequestDocument(deps, { position, requestId, token }) {
  const access = await portalAccess(deps, token);
  return readRequestDocument(deps, await deps.signingRepository.getRequest({ projectId: access.projectId, requestId, tenantId: access.tenantId }), position);
}

export async function getPortalCertificate(deps, { requestId, token }) {
  const access = await portalAccess(deps, token);
  return renderCertificate(deps, await deps.signingRepository.getRequest({ projectId: access.projectId, requestId, tenantId: access.tenantId }));
}

function myPendingSigner(latest, stakeholderId) {
  if (!latest) throw notFound();
  if (latest.request.status !== 'pending') throw conflict(`This request is already ${latest.request.status}.`, 'signing_request_not_pending', { status: latest.request.status });
  const signer = latest.signers.find((entry) => entry.stakeholderId === stakeholderId);
  if (!signer) throw new HttpError(403, 'You are not a signer on this request.', { details: { code: 'not_a_signer' } });
  if (signer.status !== 'pending') throw conflict(`You have already ${signer.status === 'signed' ? 'signed' : signer.status === 'declined' ? 'declined' : 'been removed from'} this request.`, 'signer_not_pending', { status: signer.status });
  return signer;
}

export async function sendSigningCode(deps, { requestId, token }) {
  const access = await portalAccess(deps, token);
  const { projectId, stakeholder, tenantId } = access;
  const at = now(deps);
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  if (!deps.mailRepository?.queueMail) throw new HttpError(503, 'Email is not set up on this server, so no code can be sent.', { details: { code: 'mail_not_configured' } });
  const { result } = await deps.signingRepository.withRequest({ projectId, requestId, tenantId }, async (latest) => {
    const signer = myPendingSigner(latest, stakeholder.id);
    const lastSent = signer.codeSentAt ? Date.parse(signer.codeSentAt) : 0;
    if (lastSent && at.valueOf() - lastSent < CODE_RESEND_MS) {
      throw new HttpError(429, 'A code was sent a moment ago. Check your email, or ask again in a minute.', { details: { code: 'code_recently_sent', retryAfterSeconds: Math.ceil((CODE_RESEND_MS - (at.valueOf() - lastSent)) / 1000) } });
    }
    return {
      changes: {
        events: [{ action: 'code_sent', actor: access.actor, createdAt: at.toISOString(), projectId, requestId, signerId: signer.id, tenantId }],
        signers: [{ codeAttempts: 0, codeHash: codeHash(signer.id, code), codeSentAt: at.toISOString(), id: signer.id }],
      },
      result: { email: signer.email, title: latest.request.title },
    };
  });
  try {
    await queueSigningEmail({ mailRepository: deps.mailRepository, recipientEmail: result.email, targetId: randomUUID(), templateId: SIGNING_CODE_TEMPLATE_ID, vars: { code, title: result.title } });
  } catch (error) {
    // The code never left, so it must not count against the signer: they can ask again at once.
    logMailFailure(error, { projectId, requestId, tenantId });
    await deps.signingRepository.withRequest({ projectId, requestId, tenantId }, async (latest) => {
      const signer = latest?.signers.find((entry) => entry.stakeholderId === stakeholder.id);
      return { changes: signer?.codeHash === codeHash(signer.id, code) ? { signers: [{ codeHash: null, codeSentAt: null, id: signer.id }] } : null };
    });
    throw new HttpError(503, 'The code could not be emailed. Try again in a moment.', { details: { code: 'code_not_sent' } });
  }
  return { expiresAt: new Date(at.valueOf() + CODE_TTL_MS).toISOString(), ok: true, resendAfter: new Date(at.valueOf() + CODE_RESEND_MS).toISOString(), sentTo: maskEmail(result.email) };
}

export async function signRequest(deps, { input, ipAddress = '', requestId, token, userAgent = '' }) {
  const access = await portalAccess(deps, token);
  requireSealer(deps);
  const { projectId, stakeholder, tenantId } = access;
  const at = now(deps);
  const signedAt = at.toISOString();
  const fullName = clean(input.fullName, 255);
  const title = clean(input.title, 255);
  const organization = clean(input.organization, 255);
  const browser = {
    language: clean(input.browser?.language, 40),
    platform: clean(input.browser?.platform, 100),
    timeZone: clean(input.browser?.timeZone, 100),
  };
  const { result } = await deps.signingRepository.withRequest({ projectId, requestId, tenantId }, async (latest) => {
    const signer = myPendingSigner(latest, stakeholder.id);
    if (!signer.codeHash || !signer.codeSentAt) throw new HttpError(400, 'Ask for a code first.', { details: { code: 'code_required' } });
    if (at.valueOf() - Date.parse(signer.codeSentAt) > CODE_TTL_MS) throw new HttpError(400, 'That code has expired. Ask for a new one.', { details: { code: 'code_expired' } });
    if ((signer.codeAttempts ?? 0) >= CODE_MAX_ATTEMPTS) throw new HttpError(400, 'Too many wrong codes. Ask for a new one.', { details: { code: 'code_locked' } });
    if (codeHash(signer.id, input.code) !== signer.codeHash) {
      const attempts = (signer.codeAttempts ?? 0) + 1;
      return {
        changes: {
          events: [{ action: 'code_failed', actor: access.actor, createdAt: signedAt, detail: { attempts }, projectId, requestId, signerId: signer.id, tenantId }],
          signers: [{ codeAttempts: attempts, id: signer.id }],
        },
        result: { error: attempts >= CODE_MAX_ATTEMPTS ? 'code_locked' : 'code_invalid', remaining: Math.max(0, CODE_MAX_ATTEMPTS - attempts) },
      };
    }
    const evidence = {
      browser: { ...browser, digest: sha256Hex(canonicalJson(browser)) },
      clientIp: String(ipAddress ?? '').slice(0, 100),
      consent: { accepted: true, text: CONSENT_TEXT, version: CONSENT_VERSION },
      disclosure: EVIDENCE_DISCLOSURE,
      documents: latest.documents.map((document) => ({ fileId: document.fileId, position: document.position, sha256: document.sha256, version: document.version })),
      organization,
      packageHash: latest.request.packageHash,
      portal: { linkId: access.link.id, tokenId: access.tokenId },
      projectId,
      requestId,
      schemaVersion: 'odin-signature-evidence-v1',
      signedAt,
      signer: { assignedEmail: signer.email, assignedName: signer.name, signerId: signer.id, stakeholderId: stakeholder.id },
      statement: latest.request.statement,
      title,
      typedName: fullName,
      userAgent: String(userAgent ?? '').slice(0, 1000),
      verification: { codeSentAt: signer.codeSentAt, codeVerifiedAt: signedAt, method: 'email_code', sentTo: signer.email },
    };
    const evidenceJson = canonicalJson(evidence);
    const sealed = deps.signingSealer.seal(evidenceJson);
    const signature = { evidenceHash: sha256Hex(evidenceJson), evidenceJson, projectId, requestId, seal: sealed.seal, sealKeyId: sealed.sealKeyId, signedAt, signerId: signer.id, tenantId };
    const update = { codeHash: null, id: signer.id, signedAt, signedName: fullName, signedOrganization: organization, signedTitle: title, status: 'signed' };
    const events = [{ action: 'signed', actor: access.actor, createdAt: signedAt, detail: { evidenceHash: signature.evidenceHash }, projectId, requestId, signerId: signer.id, tenantId }];
    const projectChanges = [signingChange({ action: 'sign', actorId: access.actor, detail: { signer: fullName }, projectId, request: latest.request, tenantId })];
    let request = null;
    const completed = pendingAfter(latest, [update]).length === 0;
    if (completed) {
      const completion = completionChanges(deps, latest, { at: signedAt, signature, signerUpdates: [update] });
      request = completion.request;
      events.push(completion.event);
      projectChanges.push(signingChange({ action: 'complete', actorId: access.actor, projectId, request: { ...latest.request, ...request }, tenantId }));
    }
    return { changes: { events, projectChanges, request, signature, signers: [update] }, result: { completed } };
  });
  if (result?.error) {
    throw new HttpError(400, result.error === 'code_locked' ? 'Too many wrong codes. Ask for a new one.' : 'That code is not right. Check the email and try again.', { details: { code: result.error, remaining: result.remaining } });
  }
  publishProjectChanged(deps.liveEventBus, projectId, { actor: { id: access.actor, name: stakeholder.name ?? '' }, reason: 'signing-changed' });
  const detail = await deps.signingRepository.getRequest({ projectId, requestId, tenantId });
  if (result.completed) await emailOutcome(deps, { detail, projectName: (await projectContext(deps, { projectId, tenantId })).projectName });
  return getPortalSigningRequest(deps, { requestId, token });
}

export async function declineRequest(deps, { input = {}, requestId, token }) {
  const access = await portalAccess(deps, token);
  const { projectId, stakeholder, tenantId } = access;
  const at = now(deps).toISOString();
  const reason = clean(input.reason, 1000) || null;
  const { current } = await deps.signingRepository.withRequest({ projectId, requestId, tenantId }, async (latest) => {
    const signer = myPendingSigner(latest, stakeholder.id);
    const request = { endReason: reason, endedAt: at, endedBy: access.actor, status: 'declined', updatedAt: at };
    return {
      changes: {
        events: [{ action: 'declined', actor: access.actor, createdAt: at, detail: { reason }, projectId, requestId, signerId: signer.id, tenantId }],
        projectChanges: [signingChange({ action: 'decline', actorId: access.actor, projectId, request: { ...latest.request, ...request }, tenantId })],
        request,
        signers: [{ codeHash: null, declineReason: reason, declinedAt: at, id: signer.id, status: 'declined' }],
      },
    };
  });
  publishProjectChanged(deps.liveEventBus, projectId, { actor: { id: access.actor, name: stakeholder.name ?? '' }, reason: 'signing-changed' });
  await emailOutcome(deps, { detail: current, projectName: (await projectContext(deps, { projectId, tenantId })).projectName });
  return getPortalSigningRequest(deps, { requestId, token });
}
