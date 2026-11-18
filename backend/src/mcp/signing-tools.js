import { z } from 'zod';

import { OdinApiError } from './api-client.js';

// Sharing files with stakeholders and asking them to sign, through
// Odin's routes and its rules: anyone who can change files marks a file internal or external;
// project and workspace admins and managers send, cancel and manage signature requests. Signers
// are the project's stakeholders. They sign in their portal with a code emailed to them, so a
// tool can ask for signatures but can never sign.

const DECISION_RIGHTS_MISSING = 'Only a project admin or manager (or a workspace admin or manager) can send or manage signature requests.';

function remap(error, mapping) {
  if (error instanceof OdinApiError && mapping[error.status] && error.code === `http_${error.status}`) {
    const [code, message] = mapping[error.status];
    throw new OdinApiError(error.status, code, message, { details: error.details, outcomeUnknown: error.outcomeUnknown });
  }
  throw error;
}

function presentRequest(request, { full = false } = {}) {
  return {
    id: request.id,
    kind: request.kind,
    title: request.title,
    status: request.status,
    subject: request.subject,
    progress: request.progress,
    createdAt: request.createdAt,
    createdBy: request.createdBy?.name ?? null,
    endedAt: request.endedAt ?? null,
    ...(request.endReason ? { endReason: request.endReason } : {}),
    documents: (request.documents ?? []).map((document) => ({ fileId: document.fileId, fileName: document.fileName, version: document.version, sha256: document.sha256 })),
    signers: (request.signers ?? []).map((signer) => ({
      id: signer.id,
      stakeholderId: signer.stakeholderId,
      name: signer.name,
      email: signer.email,
      status: signer.status,
      ...(signer.signedAt ? { signedAt: signer.signedAt, signedAs: [signer.signedName, signer.signedTitle, signer.signedOrganization].filter(Boolean).join(', ') } : {}),
      ...(signer.declinedAt ? { declinedAt: signer.declinedAt, ...(signer.declineReason ? { declineReason: signer.declineReason } : {}) } : {}),
      ...(signer.removedAt ? { removedAt: signer.removedAt } : {}),
      ...(signer.mail && signer.mail.status !== 'queued' ? { emailProblem: signer.mail.reason ?? signer.mail.status } : {}),
      ...(full && signer.evidence ? { evidence: { sealValid: signer.sealValid, verifiedBy: signer.evidence.verification?.method ?? null, sentTo: signer.evidence.verification?.sentTo ?? null, clientIp: signer.evidence.clientIp ?? null } } : {}),
    })),
    ...(full ? {
      statement: request.statement,
      message: request.message || null,
      packageHash: request.packageHash,
      ...(request.manifestHash ? { manifestHash: request.manifestHash, manifestValid: request.manifestValid ?? null } : {}),
      events: (request.events ?? []).map((event) => ({ action: event.action, at: event.at, by: event.actor?.name ?? event.actor?.id ?? null, ...(event.detail?.reason ? { reason: event.detail.reason } : {}) })),
    } : {}),
  };
}

/** Registers the file sharing and signature request tools on createOdinToolCatalog's `tool` helper. */
export function registerSigningTools({ api, dryRun, id, page, pageShape, tool }) {
  const projectPath = (projectId) => `/api/projects/${encodeURIComponent(projectId)}`;
  const signingPath = (projectId, requestId = '') => `${projectPath(projectId)}/signing-requests${requestId ? `/${encodeURIComponent(requestId)}` : ''}`;
  const requestId = id.describe('Signature request id from odin_list_signing_requests.');
  const reason = z.string().trim().max(1000).optional();
  const notFound = ['signing_request_not_found', 'No signature request with that id in this project, or the user cannot see the project\'s files.'];

  async function readStakeholders(projectId) {
    const state = await api.request('GET', `/api/assistant/projects/${encodeURIComponent(projectId)}/clarifications`);
    return (state.stakeholders ?? state.stakeholderContacts ?? []).map((entry) => ({ id: entry.id, name: entry.name ?? '', email: entry.email ?? '' }));
  }

  tool('odin_set_file_audience', [
    'Mark a project file internal (the team only) or external (shared with the project\'s stakeholders, who see it in their client portal).',
    'Every file starts internal. Files on tickets cannot be shared. A file in a pending or completed signature request stays external (file_under_signature). Needs the right to change files.',
  ].join(' '), z.object({ projectId: id, fileId: id.describe('File id from odin_list_project_files.'), audience: z.enum(['internal', 'external']), dryRun }).strict(), async (args) => {
    const path = `${projectPath(args.projectId)}/files/${encodeURIComponent(args.fileId)}/audience`;
    if (args.dryRun) return { ok: true, dryRun: true, validation: 'schema_only', authorizationChecked: false, request: { method: 'PATCH', path, body: { audience: args.audience } } };
    try {
      const result = await api.request('PATCH', path, { body: { audience: args.audience } });
      return { ok: true, changed: result.changed === true, file: { id: result.file.id, fileName: result.file.fileName, audience: result.file.audience } };
    } catch (error) {
      return remap(error, {
        400: ['ticket_file', 'Files on tickets cannot be shared with stakeholders.'],
        404: ['file_not_found', 'File not found in this project, or the user cannot change files on it.'],
        409: ['file_under_signature', 'This file is in a pending or completed signature request, so it stays external and cannot be made internal.'],
      });
    }
  }, { write: true, confirm: (args) => args?.audience === 'external', purpose: 'Share a document with the client\'s stakeholders, or make it internal again.' });

  tool('odin_list_signing_requests', [
    'List a project\'s signature requests, newest first: document acceptances and sign-offs, with their status (pending, completed, declined, cancelled), documents, and each signer\'s status.',
    'Give fileId for the requests a file is in. Paginated local snapshots; restart on stale_cursor.',
  ].join(' '), z.object({ projectId: id, fileId: id.optional(), status: z.enum(['pending', 'completed', 'declined', 'cancelled']).optional(), ...pageShape }).strict(), async (args) => {
    let result;
    try {
      result = await api.request('GET', signingPath(args.projectId), { query: { fileId: args.fileId, status: args.status } });
    } catch (error) {
      return remap(error, { 404: ['http_404', 'Project not found, or the user cannot see its files.'] });
    }
    const requests = (result.requests ?? []).map((request) => presentRequest(request));
    return { ok: true, ...page(requests, args, { tool: 'signing', projectId: args.projectId, fileId: args.fileId, status: args.status }) };
  }, { purpose: 'See which documents and sign-offs are out for signature, who has signed, and who has not.' });

  tool('odin_get_signing_request', 'Read one signature request in full: the statement, the frozen documents with their SHA-256 hashes, each signer with how they verified and whether their sealed evidence checks out, and the audit trail.',
    z.object({ projectId: id, requestId }).strict(), async (args) => {
      try {
        const { request } = await api.request('GET', signingPath(args.projectId, args.requestId));
        return { ok: true, request: presentRequest(request, { full: true }) };
      } catch (error) {
        return remap(error, { 404: notFound });
      }
    }, { purpose: 'Check the details and history of one signature request.' });

  const requestInput = z.object({
    projectId: id,
    kind: z.enum(['acceptance', 'signoff']).describe('acceptance: stakeholders accept documents. signoff: stakeholders sign off the project or a milestone.'),
    milestoneId: id.optional().describe('For a sign-off of one milestone (from odin_get_governance). Omit to sign off the project.'),
    documents: z.array(z.object({ fileId: id, version: z.number().int().min(1).optional().describe('Omit for the current version.') }).strict()).max(20).default([])
      .describe('Files to sign, from odin_list_project_files. At least one for an acceptance; optional supporting files for a sign-off. They become external.'),
    stakeholderIds: z.array(id).min(1).max(20).describe('Signers: project stakeholders with an email, from odin_list_stakeholders.'),
    title: z.string().trim().min(1).max(240),
    statement: z.string().trim().max(4000).optional().describe('What signers agree to. Omit for Odin\'s default for the kind.'),
    message: z.string().trim().max(4000).optional().describe('A note included in the email to signers.'),
    dryRun,
  }).strict();

  tool('odin_request_signatures', [
    'Send documents for acceptance, or the project or a milestone for sign-off: Odin freezes the exact file versions (SHA-256), shares them with stakeholders, and emails each signer a link to sign in their portal.',
    'Signers sign with a one-time code emailed to them; tools cannot sign. Not idempotent: every call creates a request and emails every signer. Use dryRun first to see the recipients. Needs decision rights.',
  ].join(' '), requestInput, async (args) => {
    if (args.kind === 'acceptance' && !args.documents.length) throw new OdinApiError(400, 'documents_required', 'An acceptance request needs at least one document.');
    const body = {
      kind: args.kind,
      title: args.title,
      documents: args.documents,
      signerStakeholderIds: args.stakeholderIds,
      ...(args.kind === 'signoff' ? (args.milestoneId ? { subjectType: 'milestone', subjectId: args.milestoneId } : { subjectType: 'project' }) : {}),
      ...(args.statement ? { statement: args.statement } : {}),
      ...(args.message ? { message: args.message } : {}),
    };
    const path = signingPath(args.projectId);
    if (args.dryRun) {
      const stakeholders = await readStakeholders(args.projectId);
      const recipients = args.stakeholderIds.map((stakeholderId) => stakeholders.find((entry) => entry.id === stakeholderId) ?? { id: stakeholderId, missing: true });
      return { ok: true, dryRun: true, validation: 'schema_and_recipients', authorizationChecked: false, request: { method: 'POST', path, body }, emails: recipients };
    }
    try {
      const { request } = await api.request('POST', path, { body });
      return { ok: true, request: presentRequest(request) };
    } catch (error) {
      return remap(error, {
        400: ['invalid_request', 'Odin refused the request: a signer is not a stakeholder on this project or has no email, a file is on a ticket, a file or version is not in the project, or the milestone is not in the project. Check with odin_list_stakeholders, odin_list_project_files and odin_get_governance.'],
        404: ['http_404', `${DECISION_RIGHTS_MISSING} Or a file or version was not found.`],
        409: ['stakeholder_link_revoked', "A signer's portal link is turned off, so they could not open the request. Send them a new link (odin_send_stakeholder_invitation) first."],
        503: ['signing_not_configured', 'Signing is not set up on this server yet (it needs a seal key). Nothing was sent.'],
      });
    }
  }, { write: true, confirm: true, purpose: 'Send a document out for the client to accept, or ask stakeholders to sign off the project or a milestone.' });

  tool('odin_cancel_signing_request', 'Withdraw a pending signature request. Signatures already given stay in its history but no longer count, and signers who have not signed are emailed that it was withdrawn. Needs decision rights.',
    z.object({ projectId: id, requestId, reason, dryRun }).strict(), async (args) => {
      const path = `${signingPath(args.projectId, args.requestId)}/cancel`;
      if (args.dryRun) return { ok: true, dryRun: true, validation: 'schema_only', authorizationChecked: false, request: { method: 'POST', path, body: { reason: args.reason } } };
      try {
        const { request } = await api.request('POST', path, { body: args.reason ? { reason: args.reason } : {} });
        return { ok: true, request: presentRequest(request) };
      } catch (error) {
        return remap(error, { 404: ['http_404', `${notFound[1]} ${DECISION_RIGHTS_MISSING}`], 409: ['not_pending', 'Nothing changed: the request is no longer pending, the signer has already signed, declined or been removed, or they are the last signer (cancel the request instead). Read it again with odin_get_signing_request.'], });
      }
    }, { write: true, destructive: true, confirm: true, purpose: 'Withdraw a signature request that is still waiting for signatures.' });

  tool('odin_remove_signer', 'Take a signer who has not signed off a pending request. At least one signer must remain. If everyone left has signed, the request completes and everyone is emailed. Needs decision rights.',
    z.object({ projectId: id, requestId, signerId: id.describe('Signer id from odin_get_signing_request (not the stakeholder id).'), reason, dryRun }).strict(), async (args) => {
      const path = `${signingPath(args.projectId, args.requestId)}/signers/${encodeURIComponent(args.signerId)}/remove`;
      if (args.dryRun) return { ok: true, dryRun: true, validation: 'schema_only', authorizationChecked: false, request: { method: 'POST', path, body: { reason: args.reason } } };
      try {
        const { request } = await api.request('POST', path, { body: args.reason ? { reason: args.reason } : {} });
        return { ok: true, request: presentRequest(request) };
      } catch (error) {
        return remap(error, { 404: ['http_404', `${notFound[1]} ${DECISION_RIGHTS_MISSING}`], 409: ['not_pending', 'Nothing changed: the request is no longer pending, the signer has already signed, declined or been removed, or they are the last signer (cancel the request instead). Read it again with odin_get_signing_request.'], });
      }
    }, { write: true, destructive: true, confirm: true, purpose: 'Remove someone who no longer needs to sign a request.' });

  tool('odin_remind_signers', 'Email a reminder to the signers of a pending request who have not signed yet, or to one of them. Odin never reminds on its own. Every call sends email. Needs decision rights.',
    z.object({ projectId: id, requestId, signerId: id.optional().describe('One signer from odin_get_signing_request. Omit for every pending signer.'), dryRun }).strict(), async (args) => {
      const path = `${signingPath(args.projectId, args.requestId)}/remind`;
      const body = args.signerId ? { signerId: args.signerId } : {};
      if (args.dryRun) return { ok: true, dryRun: true, validation: 'schema_only', authorizationChecked: false, request: { method: 'POST', path, body } };
      try {
        const result = await api.request('POST', path, { body });
        return { ok: true, reminded: result.reminded ?? 0, request: presentRequest(result.request) };
      } catch (error) {
        return remap(error, { 404: ['http_404', `${notFound[1]} ${DECISION_RIGHTS_MISSING}`], 409: ['not_pending', 'Nothing changed: the request is no longer pending, the signer has already signed, declined or been removed, or they are the last signer (cancel the request instead). Read it again with odin_get_signing_request.'], });
      }
    }, { write: true, confirm: true, purpose: 'Nudge stakeholders who still need to sign.' });
}
