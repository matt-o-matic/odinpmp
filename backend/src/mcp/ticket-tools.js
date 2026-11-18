import { z } from 'zod';
import { OdinApiError } from './api-client.js';
import { isTicketVisibleToAssistant } from '../modules/assistant/assistant-ticket-visibility.js';
import { TICKET_CATEGORIES, TICKET_SEVERITIES, projectItemCreateSchema, projectItemDeleteSchema, ticketReviewDecisionSchema } from '../modules/projects/projects.schema.js';

// Tickets (defects, support requests, questions and change requests): create, triage and delete
// them, read the choices a ticket offers, and find people a comment can @mention. Listing and
// updating tickets is in workspace-tools.js, comments in catalog.js, links in relation-tools.js.
// A ticket submitted from outside the team stays hidden from agents until someone validates it
// (D-027, assistant-ticket-visibility.js). No tool here returns its content. Agents triage with
// Odin's automated check of each one (ticket-review-classifier.js) and validate only what it
// finds safe; anything else waits for a person. Odin enforces that when the validation is
// saved, against the content as it is then; the checks here only explain a refusal sooner.

const TICKET_FIELDS = ['id', 'name', 'status', 'category', 'severity', 'priority', 'assigneeId', 'assigneeName', 'parentId', 'environmentId', 'foundInReleaseId', 'buildVersion', 'version', 'updatedAt'];
const pick = (record, fields) => Object.fromEntries(fields.filter((key) => key in (record ?? {})).map((key) => [key, record[key]]));

const createInput = projectItemCreateSchema.shape.item.pick({
  actualResult: true, assigneeId: true, buildVersion: true, description: true, environmentId: true, expectedResult: true,
  foundInReleaseId: true, name: true, priority: true, reproSteps: true, targetEndDate: true,
}).extend({
  category: z.enum(TICKET_CATEGORIES).default('defect'),
  severity: z.enum(TICKET_SEVERITIES).default('S3').describe('S1 (critical) to S4 (minor).'),
  linkedItemId: z.string().trim().min(1).max(120).nullable().default(null).describe('The epic, story or task this ticket concerns, if any.'),
}).strict();

const CREATE_ERRORS = {
  400: ['http_400', 'Odin rejected the ticket. environmentId and foundInReleaseId must be active entries from odin_get_ticket_options, and linkedItemId an epic, story or task in this project.'],
  404: ['http_404', 'Project not found, or the user cannot add tickets to it: that takes plan-edit access.'],
  409: ['http_409', 'The project\'s ticket workflow refused the new ticket, for example a field its first state requires. Check odin_get_ticket_options.'],
};
const DELETE_ERRORS = {
  404: ['http_404', 'Ticket not found, or the user cannot delete it: that takes plan-edit access.'],
  409: ['http_409', 'Odin deletes a ticket only in a closing state (such as Closed, Rejected or Deferred) and unchanged since it was read. Close it with odin_update_ticket, or run this again.'],
  423: ['legal_hold', 'A legal hold on this workspace blocks deletes.'],
};
const REVIEW_ERRORS = {
  404: ['http_404', 'Ticket not found, or the user cannot review it: that takes plan-edit access.'],
  409: ['http_409', 'Odin refused the decision: the ticket changed since it was read, or, when validating, its comments or attachments changed during the automated check, something on it changed in the last five minutes (its submission may still be arriving: wait and try again), or the check no longer finds it safe. Run this again; if validating still fails, a person needs to review it in Odin\'s review queue (Tickets, Review queue).'],
};
const AWAITING_ERRORS = {
  404: ['http_404', 'Project not found, or the user cannot triage its tickets: that takes plan-edit access.'],
};
// What an agent may see of a ticket awaiting review: never its title, text or reporter.
const AWAITING_FIELDS = ['id', 'updatedAt', 'category', 'severity', 'source', 'version'];
const CLASSIFICATION_FIELDS = ['safety', 'recommendation', 'partial', 'probabilities'];
const PERSON_REVIEW = 'A person needs to review it in Odin\'s review queue (Tickets, Review queue); rejecting it is still allowed.';
const presentAwaiting = (ticket) => ({ ...pick(ticket, AWAITING_FIELDS), classification: ticket.classification ? pick(ticket.classification, CLASSIFICATION_FIELDS) : null });

// Remaps Odin's own refusals (http_<status>) into what to do next; other errors pass through.
const remap = (messages) => (error) => {
  if (error instanceof OdinApiError && error.code === `http_${error.status}` && messages[error.status]) {
    const [code, message] = messages[error.status];
    throw new OdinApiError(error.status, code, message, { outcomeUnknown: error.outcomeUnknown });
  }
  throw error;
};

/** Registers the ticket tools on createOdinToolCatalog's `tool` helper. */
export function registerTicketTools({ api, dryRun, id, tool }) {
  const projectPath = (projectId) => `/api/projects/${encodeURIComponent(projectId)}`;
  const itemPath = (projectId, itemId) => `${projectPath(projectId)}/items/${encodeURIComponent(itemId)}`;
  const preview = (method, path, body) => ({ ok: true, dryRun: true, validation: 'schema_only', authorizationChecked: false, request: { method, path, ...(body ? { body } : {}) } });

  async function readTicket(projectId, itemId, { unreviewed = false } = {}) {
    const { project } = await api.request('GET', projectPath(projectId));
    const ticket = (project.tickets ?? []).find((entry) => entry.id === itemId);
    if (!ticket || (!unreviewed && !isTicketVisibleToAssistant(ticket))) {
      throw new OdinApiError(404, 'ticket_not_found', 'Ticket not found in this project. A ticket submitted from outside the team stays hidden until someone validates it.');
    }
    return ticket;
  }

  // The workflow bound to the project's tickets. Bindings come with their page of workflows.
  async function ticketWorkflow(projectId) {
    for (let offset = 0; offset < 1000; offset += 200) {
      const { bindings = [], total = 0, workflows = [] } = await api.request('GET', '/api/workflows', { query: { projectId, limit: 200, offset } });
      const binding = bindings.find((entry) => entry.projectId === projectId && entry.itemType === 'ticket');
      const workflow = binding && workflows.find((entry) => entry.id === binding.workflowId);
      if (workflow) return workflow;
      if (offset + 200 >= total) break;
    }
    return null;
  }
  const initialStatus = (workflow) => workflow?.states?.find((state) => state.initial)?.key ?? 'new';
  const awaitingReview = (projectId, query) => api.request('GET', `${projectPath(projectId)}/tickets/awaiting-review`, { query }).catch(remap(AWAITING_ERRORS));

  tool('odin_get_ticket_options', [
    'Read the choices for a ticket in this project: categories, severities, the ticket workflow\'s statuses (closes marks the closing ones) and the state new tickets start in,',
    'and the active environments and releases (ids for environmentId and foundInReleaseId).',
  ].join(' '), z.object({ projectId: id }).strict(), async ({ projectId }) => {
    const [config, workflow] = await Promise.all([api.request('GET', `${projectPath(projectId)}/ticket-config`), ticketWorkflow(projectId)]);
    const active = (entries = []) => entries.filter((entry) => entry.status === 'active').map(({ id: entryId, name }) => ({ id: entryId, name }));
    return {
      ok: true,
      categories: TICKET_CATEGORIES,
      severities: TICKET_SEVERITIES,
      statuses: workflow ? workflow.states.map(({ key, label, terminal }) => ({ key, label, closes: Boolean(terminal) })) : null,
      initialStatus: initialStatus(workflow),
      environments: active(config.environments),
      releases: active(config.releases),
    };
  }, { purpose: 'See the choices for a ticket: categories, severities, statuses, environments and releases.' });

  tool('odin_create_ticket', [
    'Log a ticket in a project: a defect, support request, question or change request. It starts in the first state of the project\'s ticket workflow (usually New), outside any sprint.',
    'Give a name, and as known: description, severity, repro steps, expected and actual results, build, and environment and found-in release ids from odin_get_ticket_options.',
    'linkedItemId ties it to the epic, story or task it concerns. Change it later with odin_update_ticket.',
  ].join(' '), z.object({ projectId: id, input: createInput, dryRun }).strict(), async (args) => {
    const { linkedItemId, ...fields } = args.input;
    const path = `${projectPath(args.projectId)}/items`;
    const body = (status) => projectItemCreateSchema.parse({ item: { ...fields, status }, itemType: 'ticket', parentId: linkedItemId });
    if (args.dryRun) return preview('POST', path, body('new'));
    const status = initialStatus(await ticketWorkflow(args.projectId));
    const result = await api.request('POST', path, { body: body(status) }).catch(remap(CREATE_ERRORS));
    return { ok: true, ticket: pick(result.item, TICKET_FIELDS) };
  }, { write: true, purpose: 'Log a new ticket: a bug or defect, support request, question or change request.' });

  tool('odin_delete_ticket', [
    'Delete a ticket. Odin deletes it only in a closing state of the ticket workflow (such as Closed, Rejected or Deferred); close it first with odin_update_ticket.',
    'expectedVersion is read for you when omitted. Odin keeps the revision, and a legal hold blocks it.',
  ].join(' '), z.object({ projectId: id, itemId: id, expectedVersion: z.number().int().positive().optional(), dryRun }).strict(), async (args) => {
    const path = itemPath(args.projectId, args.itemId);
    if (args.dryRun) return preview('DELETE', path, args.expectedVersion ? { expectedVersion: args.expectedVersion } : undefined);
    const ticket = await readTicket(args.projectId, args.itemId);
    const body = projectItemDeleteSchema.parse({ expectedVersion: args.expectedVersion ?? Number(ticket.version) });
    await api.request('DELETE', path, { body }).catch(remap(DELETE_ERRORS));
    return { ok: true, deleted: { id: ticket.id, name: ticket.name } };
  }, { write: true, destructive: true, confirm: true, purpose: 'Delete a ticket.' });

  tool('odin_list_tickets_awaiting_review', [
    'List tickets submitted from outside the team (through a ticket intake link or Bug Reporter) that nobody has validated or rejected yet, oldest first.',
    'Their title, text and reporter stay hidden from agents until a person validates them; each comes with Odin\'s automated check instead:',
    'safety (safe, caution or unsafe), a recommendation (validate, reject, or person: a person should review it) and the probabilities behind them (genuine, aimsAtAI, harmful).',
    'partial means the check could not read all of the ticket or its readable files (too long, too many, or a file that is damaged or not really text), so it is never safe. classification is null when the check could not run. Triage them with odin_review_ticket.',
  ].join(' '), z.object({ projectId: id, limit: z.number().int().min(1).max(25).default(10) }).strict(), async ({ limit, projectId }) => {
    const { tickets = [], total = 0 } = await awaitingReview(projectId, { limit });
    return { ok: true, tickets: tickets.map(presentAwaiting), total, note: 'Content stays hidden from agents until someone validates the ticket.' };
  }, { purpose: 'See which tickets from outside the team await triage, with Odin\'s automated safety check of each.' });

  tool('odin_review_ticket', [
    'Triage a ticket submitted from outside the team (through a ticket intake link or Bug Reporter): validated lets agents read it, rejected keeps it hidden. It never returns the ticket\'s content.',
    'Odin checks each such ticket automatically (see odin_list_tickets_awaiting_review). Leave decision out to follow the check\'s recommendation;',
    'when it says a person should look, or the check could not run, the ticket stays pending for a person to review in Odin. An agent can validate only a ticket the check found safe; rejecting always works.',
    'Odin keeps the ticket either way; its status, assignee and scheduling are unchanged.',
  ].join(' '), z.object({
    projectId: id, itemId: id, decision: z.enum(['validated', 'rejected']).optional().describe('Leave out to follow the automated check\'s recommendation.'), dryRun,
  }).strict(), async (args) => {
    const path = `${itemPath(args.projectId, args.itemId)}/review`;
    if (args.dryRun) return preview('POST', path, args.decision ? { state: args.decision } : undefined);
    const ticket = await readTicket(args.projectId, args.itemId, { unreviewed: true });
    const reviewState = ticket.externalReviewState ?? 'not_external';
    if (reviewState === 'not_external') {
      throw new OdinApiError(409, 'not_external', 'Only tickets submitted from outside the team need review. This one was logged in Odin.');
    }
    const current = { id: args.itemId, externalReviewState: reviewState, version: Number(ticket.version) };
    if (reviewState !== 'pending' && (!args.decision || args.decision === reviewState)) {
      return { ok: true, changed: false, ticket: current, message: `This ticket was already ${reviewState}.` };
    }
    // Only pending tickets are checked, so validating one already rejected takes a person. A
    // check of another version doesn't count: the reporter may have changed the ticket since.
    const checked = reviewState === 'pending' ? (await awaitingReview(args.projectId, { itemId: args.itemId, limit: 1 })).tickets?.[0] : null;
    const classification = checked && Number(checked.version) === current.version ? presentAwaiting(checked).classification : null;
    const decision = args.decision ?? { reject: 'rejected', validate: 'validated' }[classification?.recommendation];
    if (!decision) {
      const reason = classification ? 'Odin\'s automated check says a person should look at this ticket, so it stays pending.' : 'Odin could not check this ticket automatically, so it stays pending.';
      return { ok: true, changed: false, needsPerson: true, ticket: current, classification, message: `${reason} ${PERSON_REVIEW}` };
    }
    if (decision === 'validated' && classification?.safety !== 'safe') {
      const message = reviewState !== 'pending' ? `This ticket was ${reviewState}, so only a person can validate it, in Odin.`
        : `${classification ? `Odin's automated check did not find this ticket safe (safety: ${classification.safety}), so an agent cannot validate it.` : 'Odin could not check this ticket automatically, so an agent cannot validate it.'} ${PERSON_REVIEW}`;
      throw new OdinApiError(409, 'needs_person', message, { details: { classification } });
    }
    const body = ticketReviewDecisionSchema.parse({ agentCheck: true, expectedVersion: Number(ticket.version), state: decision });
    const result = await api.request('POST', path, { body }).catch(remap(REVIEW_ERRORS));
    return { ok: true, changed: true, ticket: { id: args.itemId, externalReviewState: result.item?.externalReviewState ?? decision, version: result.item?.version ?? null }, classification };
  }, { write: true, destructive: true, confirm: true, purpose: 'Triage a ticket submitted from outside the team: mark it valid or reject it, guided by Odin\'s automated safety check.' });

  tool('odin_list_mentionable_people', [
    'Find people who can be @mentioned in a comment (everyone in the workspace), with their user id, name and email.',
    'Pass their ids as mentions to odin_add_comment or odin_update_comment; Odin emails each person mentioned.',
  ].join(' '), z.object({ projectId: id, search: z.string().trim().max(200).optional(), limit: z.number().int().min(1).max(100).default(25) }).strict(), async ({ limit, projectId, search }) => {
    const { users = [] } = await api.request('GET', `${projectPath(projectId)}/mentionables`, { query: { query: search || undefined } });
    return { ok: true, people: users.slice(0, limit).map(({ email, id: userId, name }) => ({ id: userId, name, email })), total: users.length };
  }, { purpose: 'Find people to @mention in a comment, and their user ids.' });
}
