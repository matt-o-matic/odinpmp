import express from 'express';
import { HttpError } from '../../lib/errors/http-error.js';
import { LIVE_EVENT_CHANNELS } from '../../lib/events/live-event-bus.js';
import { recordWorkCompletionMetrics } from '../metrics/work-completion-metrics.js';

// Bug Reporter keeps each report and its Odin ticket in sync. The ticket reuses the
// report's UUID as its id, so lookups and retried creates need no separate link table.
export const STATUS_TO_ODIN = { New: 'new', Triaged: 'triage', 'In progress': 'in_progress', Resolved: 'resolved', Closed: 'closed' };
export const STATUS_FROM_ODIN = { new: 'New', triage: 'Triaged', open: 'Triaged', deferred: 'Triaged', in_progress: 'In progress', resolved: 'Resolved', closed: 'Closed', rejected: 'Closed' };
export const PRIORITY_TO_ODIN = { Urgent: 1, High: 2, Normal: 4, Low: 6 };
const SEVERITY = { Urgent: 'S1', High: 'S2', Normal: 'S3', Low: 'S4' };
export const priorityFromOdin = value => (value <= 1 ? 'Urgent' : value <= 3 ? 'High' : value <= 5 ? 'Normal' : 'Low');
// Bug Reporter has no Reopened status: reopening a report sends it back as New. A sync that moves a
// ticket Bug Reporter shows as Resolved or Closed back to New counts as one reopen. Once the ticket is
// New, a repeated or retried sync no longer matches, so one reopen is never counted twice.
const REOPENED_FROM = new Set(['Resolved', 'Closed']);
export const REOPEN_TRANSITION_KEY = 'bug_reporter_reopen';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_TYPES = new Set(['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/tiff', 'image/avif', 'image/heic']);
// Odin's item schema caps descriptions, and its editor resubmits the whole item.
const DESCRIPTION_LIMIT = 5000;
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Keeps paragraph and line breaks, which Odin's own plain-text helper collapses.
const commentText = html => String(html)
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, '\n').replace(/<[^>]*>/g, '')
  .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' }[name]))
  .replace(/\n{3,}/g, '\n\n').trim();
const flatten = comments => comments.flatMap(comment => [comment, ...flatten(comment.replies ?? comment.children ?? [])]);

export function registerReportingTickets({ router, oauth, wrap, assigned, authRepository, assistantRepository, metricsRepository = null, projectRepository, workflowRepository, liveEventBus }) {
  // `oauth` must require projects.write. Synchronization is a service action, not a member session.
  const base = '/projects/:projectId/tickets';
  async function context(req) {
    const { application } = req.oauthAuth, { projectId, reportId } = req.params;
    if (req.oauthAuth.token.userId) throw new HttpError(403, 'Ticket synchronization requires an application token.');
    if (!application.projectIds.includes(projectId) || (reportId !== undefined && !UUID.test(reportId))) throw new HttpError(404, 'Ticket not found.');
    const project = await projectRepository.getProjectDetail({ projectId, tenantId: application.tenantId });
    if (!project) throw new HttpError(404, 'Ticket not found.');
    return { application, projectId, tenantId: application.tenantId, project };
  }
  // Only a current project member can be recorded as the Odin actor.
  async function member(userId, projectId, tenantId) {
    if (typeof userId !== 'string' || !userId) return null;
    const user = await authRepository.findUserById(userId);
    return await assigned(user, projectId, tenantId) ? user : null;
  }
  // A collaborator owns their own attachments, through the account that shares their stakeholder email.
  // The ticket names its reporter; only a stakeholder of this project and tenant counts. That account has
  // no membership, so it cannot sign in or act here (see stakeholder-accounts.js).
  async function stakeholderOwner(ticket, projectId, tenantId) {
    const stakeholderId = /^bug-reporter:(.+)$/.exec(ticket.reporterExternalId ?? '')?.[1];
    if (!stakeholderId || !assistantRepository || !authRepository.findOrCreateStakeholderOwner) return null;
    const stakeholder = await assistantRepository.findProjectStakeholderById({ projectId, stakeholderId, tenantId });
    return stakeholder?.email ? authRepository.findOrCreateStakeholderOwner({ email: stakeholder.email, name: stakeholder.name }) : null;
  }
  function ticketJson(ticket, extra = {}) {
    return {
      ticketId: ticket.id, version: Number(ticket.version ?? 1), status: STATUS_FROM_ODIN[ticket.status] ?? null, odinStatus: ticket.status,
      priority: priorityFromOdin(Number(ticket.priority ?? 4)), odinPriority: Number(ticket.priority ?? 4), assigneeId: ticket.assigneeId ?? null,
      title: ticket.name, updatedAt: ticket.updatedAt ?? null, reopenCount: Number(ticket.reopenCount ?? 0), ...extra,
    };
  }
  const find = (project, id) => (project.tickets ?? []).find(ticket => ticket.id === id && !ticket.deleted);
  const publish = (projectId, itemId, reason) => liveEventBus?.publish?.(LIVE_EVENT_CHANNELS.project(projectId), { actor: { id: 'bug-reporter', name: 'Bug Reporter' }, itemId, projectId, reason, type: 'project.assets.invalidated' });
  function description(body) {
    const link = `\n\n---\nReported by ${body.reporter.name} in Bug Reporter: ${body.reportUrl}`;
    let text = String(body.description ?? '').trim();
    if (text.length + link.length > DESCRIPTION_LIMIT) text = text.slice(0, Math.max(0, DESCRIPTION_LIMIT - link.length - 40)).trimEnd() + '\n\n(Full description in Bug Reporter.)';
    return text + link;
  }
  // The ticket workflow bound to this project, or null when tickets have none.
  async function workflowFor(projectId, tenantId) {
    if (!workflowRepository) return null;
    const snapshot = await workflowRepository.listSnapshot({ tenantId });
    const binding = snapshot.bindings.find(candidate => candidate.projectId === projectId && candidate.itemType === 'ticket');
    if (!binding) return null;
    // The same checks Odin's workflow service applies to a binding.
    const workflow = snapshot.workflows.find(candidate => candidate.id === binding.workflowId && candidate.status === 'active');
    if (!workflow) throw new HttpError(409, 'The ticket workflow binding references an inactive or missing workflow.');
    if (!workflow.itemTypes?.includes('ticket')) throw new HttpError(409, 'The bound workflow does not support ticket items.');
    return workflow;
  }
  // Odin orders status and assignee history by a timestamp with one-second precision.
  // Waiting until the ticket's last change is in an earlier second keeps the newest entry unambiguous.
  async function laterSecond(ticket) {
    const last = Math.floor(Date.parse(ticket.updatedAt ?? '') / 1000);
    if (!Number.isFinite(last)) return;
    const wait = (last + 1) * 1000 + 50 - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, Math.min(wait, 1100)));
  }
  // Shortest run of transitions a service may take on its own: no approvals, roles, or required fields.
  function route(workflow, from, to) {
    const open = transition => !transition.approvalRequired && !transition.allowedRoles?.length && !transition.requiredFields?.length
      && !workflow.states.find(state => state.key === transition.toState)?.requiredFields?.length;
    const queue = [[from, []]], seen = new Set([from]);
    while (queue.length) {
      const [state, path] = queue.shift();
      if (state === to) return path;
      for (const transition of workflow.transitions.filter(candidate => candidate.fromState === state && open(candidate)))
        if (!seen.has(transition.toState)) { seen.add(transition.toState); queue.push([transition.toState, [...path, transition]]); }
    }
    return null;
  }
  function validate(body, application, reportId) {
    const fields = body?.fields ?? {};
    let url;
    // A bounded link keeps room for the description under the item limit.
    if (typeof body?.reportUrl !== 'string' || body.reportUrl.length > 2048) throw new HttpError(400, 'Invalid report link.');
    try { url = new URL(body.reportUrl); } catch { throw new HttpError(400, 'Invalid report link.'); }
    if (!body || typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200 || /[\r\n]/.test(body.title) ||
      typeof body.description !== 'string' || body.description.length > 20000 ||
      !body.reporter || !['internal', 'collaborator'].includes(body.reporter.kind) || typeof body.reporter.id !== 'string' || body.reporter.id.length > 120 || typeof body.reporter.name !== 'string' || body.reporter.name.length > 200 ||
      (body.actorId !== undefined && body.actorId !== null && typeof body.actorId !== 'string') ||
      // Own-property checks, so inherited keys such as `toString` are not accepted as values.
      (fields.status !== undefined && !Object.hasOwn(STATUS_TO_ODIN, fields.status)) || (fields.priority !== undefined && !Object.hasOwn(PRIORITY_TO_ODIN, fields.priority)) ||
      (fields.assigneeId !== undefined && fields.assigneeId !== null && (typeof fields.assigneeId !== 'string' || !fields.assigneeId.trim() || fields.assigneeId.length > 120)) ||
      (fields.title !== undefined && (typeof fields.title !== 'string' || !fields.title.trim() || fields.title.length > 200 || /[\r\n]/.test(fields.title))))
      throw new HttpError(400, 'Invalid ticket synchronization request.');
    if (url.username || url.password || url.hash || url.searchParams.get('reportId') !== reportId || !application.redirectUris.some(uri => new URL(uri).origin === url.origin))
      throw new HttpError(403, 'Report link is not registered for this application.');
    return fields;
  }

  router.get(base, oauth, wrap(async (req, res) => {
    const { projectId, tenantId, project } = await context(req);
    const reportIds = String(req.query.reportIds ?? '').split(',').filter(Boolean);
    if (reportIds.length > 200 || reportIds.some(id => !UUID.test(id))) throw new HttpError(400, 'Invalid report list.');
    const tickets = [];
    for (const ticket of reportIds.map(id => find(project, id)).filter(Boolean)) {
      // The comment count lets Bug Reporter notice comments, which do not change the ticket version.
      const comments = flatten(await projectRepository.listComments({ projectId, targetId: ticket.id, targetType: 'ticket', tenantId }) ?? []);
      tickets.push({ ...ticketJson(ticket), comments: comments.length });
    }
    res.json({ tickets });
  }));

  // Creates the ticket, or applies only the fields Bug Reporter changed. The description is set once, at creation.
  // Status follows the project's ticket workflow one allowed step at a time; an unreachable status is reported, not forced.
  // The exception is a reopen, which always returns the ticket to New when the workflow has that state.
  router.put(base + '/:reportId', oauth, wrap(async (req, res) => {
    const { application, projectId, tenantId, project } = await context(req);
    const reportId = req.params.reportId, body = req.body, fields = validate(body, application, reportId);
    const actor = await member(body.actorId, projectId, tenantId) ?? await member(body.reporter.kind === 'internal' ? body.reporter.id : null, projectId, tenantId);
    const assignee = fields.assigneeId ? await member(fields.assigneeId, projectId, tenantId) : null;
    if (fields.assigneeId && !assignee) throw new HttpError(409, 'The assignee is not a member of this Odin project.');
    const workflow = await workflowFor(projectId, tenantId);
    let ticket = find(project, reportId), created = false, changed = false, statusBlocked = false;
    if (!ticket) {
      try {
        const result = await projectRepository.createProjectItem({ projectId, tenantId, user: actor, input: { itemType: 'ticket', parentId: null, item: {
          id: reportId, name: body.title.trim(), description: description(body), priority: PRIORITY_TO_ODIN[fields.priority ?? 'Normal'], severity: SEVERITY[fields.priority ?? 'Normal'],
          status: workflow?.states.find(state => state.initial)?.key ?? STATUS_TO_ODIN[fields.status ?? 'New'], assigneeId: fields.assigneeId ?? null, category: 'defect',
          reporterExternalId: body.reporter.kind === 'collaborator' ? `bug-reporter:${body.reporter.id}` : null,
          externalReviewState: body.reporter.kind === 'collaborator' ? 'pending' : 'not_external',
        } } });
        if (!result) throw new HttpError(404, 'Ticket not found.');
        ticket = result.item; created = true;
      } catch (error) {
        // A retried create after a lost response finds the ticket it already made.
        const latest = error.status === 409 || error.code === 'ER_DUP_ENTRY' ? find(await projectRepository.getProjectDetail({ projectId, tenantId }), reportId) : null;
        if (!latest) throw error.status === 409 || error.code === 'ER_DUP_ENTRY' ? new HttpError(409, 'An Odin item with this report ID already exists outside this project, or its ticket was deleted.') : error;
        ticket = latest;
      }
    }
    const patch = {};
    if (!created && fields.title !== undefined && ticket.name !== fields.title.trim()) patch.name = fields.title.trim();
    if (!created && fields.priority !== undefined && priorityFromOdin(Number(ticket.priority ?? 4)) !== fields.priority) patch.priority = PRIORITY_TO_ODIN[fields.priority];
    if (!created && fields.assigneeId !== undefined && (ticket.assigneeId ?? null) !== fields.assigneeId) patch.assigneeId = fields.assigneeId;
    const update = async (changes) => {
      if ('status' in changes || 'assigneeId' in changes) await laterSecond(ticket);
      const result = await projectRepository.updateProjectItem({ projectId, tenantId, itemId: reportId, user: actor, input: { expectedVersion: Number(ticket.version ?? 1), patch: changes } });
      if (!result) throw new HttpError(404, 'Ticket not found.');
      await recordWorkCompletionMetrics({ actorUserId: actor?.id ?? null, after: { tickets: [result.item] }, before: { tickets: [ticket] }, metricsRepository, projectId, tenantId, workflowRepository });
      ticket = result.item; changed = true;
    };
    if (Object.keys(patch).length) await update(patch);
    if (fields.status !== undefined && STATUS_FROM_ODIN[ticket.status] !== fields.status) {
      const target = STATUS_TO_ODIN[fields.status], from = ticket.status;
      const reopen = fields.status === 'New' && REOPENED_FROM.has(STATUS_FROM_ODIN[from])
        ? { reopenCount: Number(ticket.reopenCount ?? 0) + 1, lastReopenedAt: new Date().toISOString() } : null;
      if (!workflow) await update({ status: target, ...reopen });
      else {
        // The default workflow has no path back to New, so a reopen goes straight there as one recorded transition.
        const steps = route(workflow, from, target)
          ?? (reopen && workflow.states.some(state => state.key === target && !state.requiredFields?.length) ? [{ fromState: from, toState: target, key: REOPEN_TRANSITION_KEY }] : null);
        if (!steps) statusBlocked = true;
        else {
          // One status write, so its history entry is the newest; every step is still recorded as a transition.
          await update({ status: target, ...reopen });
          for (const step of steps)
            await workflowRepository.recordTransition({ fromState: step.fromState, itemId: reportId, itemType: 'ticket', projectId, tenantId, toState: step.toState, transitionKey: step.key, userId: actor?.id ?? `oauth-application:${application.id}` });
        }
      }
    }
    if (created || changed) publish(projectId, reportId, created ? 'project-item-created' : 'project-item-updated');
    res.status(created ? 201 : 200).json({ ticket: ticketJson(ticket, statusBlocked ? { statusBlocked: true } : {}) });
  }));

  router.get(base + '/:reportId/comments', oauth, wrap(async (req, res) => {
    const { projectId, tenantId, project } = await context(req);
    if (!find(project, req.params.reportId)) throw new HttpError(404, 'Ticket not found.');
    const comments = flatten(await projectRepository.listComments({ projectId, targetId: req.params.reportId, targetType: 'ticket', tenantId }) ?? []);
    res.json({ comments: comments.map(comment => ({
      id: comment.id, authorId: comment.userId ?? comment.author?.id ?? null, authorName: comment.author?.name ?? comment.authorName ?? '',
      body: commentText(comment.comment ?? ''), createdAt: comment.createdAt ?? null,
    })) });
  }));

  // Bug Reporter's internal comments are written by Odin project members.
  router.post(base + '/:reportId/comments', oauth, wrap(async (req, res) => {
    const { projectId, tenantId, project } = await context(req);
    const { authorId, body } = req.body ?? {};
    if (typeof body !== 'string' || !body.trim() || body.length > 20000) throw new HttpError(400, 'Invalid comment.');
    if (!find(project, req.params.reportId)) throw new HttpError(404, 'Ticket not found.');
    const author = await member(authorId, projectId, tenantId);
    if (!author) throw new HttpError(409, 'The comment author is not a member of this Odin project.');
    const html = body.trim().split(/\r?\n/).map(line => `<p>${escape(line)}</p>`).join('');
    const comment = await projectRepository.addComment({ comment: html, parentId: null, projectId, targetId: req.params.reportId, targetType: 'ticket', tenantId, user: author });
    publish(projectId, req.params.reportId, 'project-comment-created');
    res.status(201).json({ comment: { id: comment.id, authorId: author.id } });
  }));

  // Attachments arrive as raw bytes so they bypass Odin's small global JSON limit. Bug Reporter
  // accepts files under 25 MiB in all, so one file can be nearly that size.
  // Bug Reporter prefixes each name, so its files cannot replace ones people added in Odin.
  // A repeated upload of the same named file is skipped, so retries add no copies.
  // The file belongs to the internal reporter, else the reporting collaborator, else the application's creator.
  router.put(base + '/:reportId/files/:fileName', oauth, express.raw({ type: () => true, limit: 26 * 1024 * 1024 }), wrap(async (req, res) => {
    const { application, projectId, tenantId, project } = await context(req);
    const fileName = req.params.fileName, type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (!/^bug-reporter-\d{1,2}-./.test(fileName) || fileName.length > 240 || /[\\/\u0000-\u001f]/.test(fileName) || !FILE_TYPES.has(type) || !Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Invalid attachment.');
    const ticket = find(project, req.params.reportId);
    if (!ticket) throw new HttpError(404, 'Ticket not found.');
    const existing = (await projectRepository.listFiles({ projectId, targetId: req.params.reportId, targetType: 'ticket', tenantId })).find(item => item.fileName === fileName);
    if (existing) return res.json({ file: { id: existing.id, name: existing.fileName } });
    const owner = await authRepository.findUserById(application.createdBy);
    const uploader = await member(req.headers['x-bug-reporter-uploader'], projectId, tenantId)
      ?? await stakeholderOwner(ticket, projectId, tenantId)
      ?? (owner?.memberships?.some(membership => membership.tenantId === tenantId) ? owner : null);
    if (!uploader) throw new HttpError(409, 'No Odin user is available to own this attachment.');
    const file = await projectRepository.saveFile({ fileContentsBase64: req.body.toString('base64'), fileDescription: 'Attached in Bug Reporter', fileName, fileType: type, inlineImage: false, projectId, targetId: req.params.reportId, targetType: 'ticket', tenantId, user: uploader });
    publish(projectId, req.params.reportId, 'project-file-saved');
    res.json({ file: { id: file.id, name: file.fileName ?? fileName } });
  }));
}
