// The invoice-gen connection on Odin's side (docs/invoice-gen-connection/plan.md).
//  - The /api/v1 routes invoice-gen calls with its OAuth application (api-contract.md).
//  - The member routes behind the Billing panel, the story field and the MCP tools.
// Billing data follows finance visibility (E-08): project admins and managers, and workspace
// admins and managers. The same people change the story-to-milestone mapping (E-05).
import { HttpError } from '../../lib/errors/http-error.js';
import { PROJECT_CAPABILITIES, requireProjectCapability } from '../../lib/auth/project-capabilities.js';
import { resolveDecisionRights } from '../../lib/auth/decision-rights.js';
import { isTicketVisibleToAssistant } from '../assistant/assistant-ticket-visibility.js';
import { CONSULTING_MODULE } from '../workspace-modules/workspace-modules.repository.js';
import { requireModuleEnabled } from '../workspace-modules/workspace-modules.service.js';

const roundHours = (value) => Math.round(Number(value) * 100) / 100;
const sum = (entries) => roundHours(entries.reduce((total, entry) => total + Number(entry.hours), 0));

function tenantIdFor(user) {
  const tenantId = user?.memberships?.[0]?.tenantId;
  if (!tenantId) throw new HttpError(403, 'This account is not assigned to a tenant.');
  return tenantId;
}

// ---- change log -------------------------------------------------------------------------------------

// Billing rows hold no amounts: the change feed reaches every project reader, and billing data
// reaches only finance-visible people.
function billingChange({ action, actorId, detail = {}, entityId, itemId = null, projectId, tenantId }) {
  return { action, actorId, detail, entityId: String(entityId), entityType: 'billing', itemId, projectId, tenantId };
}

// ---- shapes -----------------------------------------------------------------------------------------

export function presentLink(link, projectId = link?.projectId) {
  if (!link) return null;
  return { agreement: link.agreement ?? null, customer: link.customer, lineOfBusiness: link.lineOfBusiness ?? null, projectId, sourceUpdatedAt: link.sourceUpdatedAt };
}

function presentInvoice(invoice) {
  return {
    currency: invoice.currency, dueDate: invoice.dueDate, externalInvoiceId: invoice.externalId, hours: invoice.hours, issueDate: invoice.issueDate,
    number: invoice.number, overdue: invoice.overdue, paidDate: invoice.paidDate, sourceUpdatedAt: invoice.sourceUpdatedAt, status: invoice.status,
    submittedDate: invoice.submittedDate, totalCents: invoice.totalCents, url: invoice.url,
  };
}

/**
 * Each work item by id: its type, title and the story it bills under (the item itself for a
 * story, the parent story for a task). A ticket nobody has validated is named only "Ticket" (D-027).
 */
export function workItemIndex(project) {
  const items = new Map();
  for (const epic of project?.epics ?? []) {
    items.set(epic.id, { id: epic.id, story: null, title: epic.name ?? '', type: 'epic' });
    for (const story of epic.stories ?? []) {
      const ref = { id: story.id, title: story.name ?? '' };
      items.set(story.id, { epicId: epic.id, epicTitle: epic.name ?? '', id: story.id, story: ref, title: ref.title, type: 'story' });
      for (const task of story.tasks ?? []) items.set(task.id, { id: task.id, story: ref, title: task.name ?? '', type: 'task' });
    }
  }
  for (const ticket of project?.tickets ?? []) {
    items.set(ticket.id, { id: ticket.id, story: null, title: isTicketVisibleToAssistant(ticket) ? ticket.name ?? '' : 'Ticket', type: 'ticket' });
  }
  return items;
}

function storiesOf(project) {
  return [...workItemIndex(project).values()].filter((item) => item.type === 'story');
}

/** The milestone ids the link's SOW has now; a mapping to any other id bills as "No SOW". */
function agreementMilestones(link) {
  return Array.isArray(link?.agreement?.milestones) ? link.agreement.milestones : [];
}

/**
 * Resolves each entry's story and milestone as they stand now (api-contract.md): the entry's
 * work item when it is a story, the story above a task, otherwise none; the milestone is that
 * story's mapping when the linked SOW still has it.
 */
function resolveEntries({ entries, link, mapping, project }) {
  const items = workItemIndex(project);
  const known = new Set(agreementMilestones(link).map((milestone) => milestone.id));
  const milestoneOf = new Map(mapping.filter((row) => known.has(row.milestoneId)).map((row) => [row.storyId, row.milestoneId]));
  return entries.map((entry) => {
    const item = entry.workItemId ? items.get(entry.workItemId) ?? null : null;
    const story = item?.story ?? null;
    return { ...entry, milestoneId: story ? milestoneOf.get(story.id) ?? null : null, story, workItem: item ? { id: item.id, title: item.title, type: item.type } : null };
  });
}

// One line per milestone in the SOW's order, then "No SOW" (milestoneId null).
function billingLines(entries, link) {
  const order = new Map(agreementMilestones(link).map((milestone, index) => [milestone.id, index]));
  const lines = new Map();
  for (const entry of entries) {
    const key = entry.milestoneId ?? 'none';
    const line = lines.get(key) ?? { hours: 0, milestoneId: entry.milestoneId, stories: new Map() };
    line.hours += Number(entry.hours);
    const storyKey = entry.story?.id ?? 'none';
    const story = line.stories.get(storyKey) ?? { hours: 0, id: entry.story?.id ?? null, title: entry.story?.title ?? 'No story' };
    story.hours += Number(entry.hours);
    line.stories.set(storyKey, story);
    lines.set(key, line);
  }
  return [...lines.values()]
    .sort((left, right) => (left.milestoneId == null) - (right.milestoneId == null) || (order.get(left.milestoneId) ?? 0) - (order.get(right.milestoneId) ?? 0))
    .map((line) => ({ hours: roundHours(line.hours), milestoneId: line.milestoneId, stories: [...line.stories.values()].map((story) => ({ ...story, hours: roundHours(story.hours) })) }));
}

const approvedUnclaimed = (entry) => entry.status === 'approved' && entry.billable && !entry.claim;

// ---- /api/v1 (invoice-gen) ------------------------------------------------------------------------------

/**
 * The project an application call names: inside its allowlist (404 otherwise, as for a missing
 * project), with the Consulting module on (403 module_disabled, E-12).
 */
export async function requireApplicationProject({ application, projectId, projectRepository, workspaceModulesRepository }) {
  if (!application.projectIds.includes(projectId)) throw new HttpError(404, 'Project not found.');
  await requireModuleEnabled(workspaceModulesRepository, application.tenantId, CONSULTING_MODULE);
  const kind = projectRepository.getProjectKind ? await projectRepository.getProjectKind({ projectId }) : { tenantId: application.tenantId };
  if (!kind || kind.tenantId !== application.tenantId) throw new HttpError(404, 'Project not found.');
  return { projectId, tenantId: application.tenantId };
}

export async function putBillingLinkForApplication({ actorId, billingRepository, input, projectId, tenantId }) {
  const result = await billingRepository.putLink({
    changeEntries: ({ created }) => [billingChange({ action: created ? 'link' : 'update', actorId, detail: { kind: 'link' }, entityId: `invoice-gen:link:${projectId}`, projectId, tenantId })],
    link: input, projectId, tenantId,
  });
  return result.ignored ? { data: presentLink(result.link, projectId), ignored: true } : { data: presentLink(result.link, projectId) };
}

export async function deleteBillingLinkForApplication({ actorId, billingRepository, projectId, tenantId }) {
  const deleted = await billingRepository.deleteLink({
    changeEntries: () => [billingChange({ action: 'unlink', actorId, detail: { kind: 'link' }, entityId: `invoice-gen:link:${projectId}`, projectId, tenantId })],
    projectId, tenantId,
  });
  return { data: { deleted } };
}

/** The approved, billable, unclaimed entries in the period, plus every entry `includeInvoice` holds. */
export async function getBillableTimeForApplication({ billingRepository, input, projectId, projectRepository, tenantId }) {
  const [entries, project, mapping, link] = await Promise.all([
    billingRepository.listProjectTimeEntries({ projectId, tenantId }),
    projectRepository.getProjectDetail({ projectId, tenantId }),
    billingRepository.listStoryMilestones({ projectId, tenantId }),
    billingRepository.getLink({ projectId, tenantId }),
  ]);
  const chosen = entries.filter((entry) => (approvedUnclaimed(entry) && entry.workDate >= input.from && entry.workDate <= input.to)
    || (input.includeInvoice && entry.claim?.externalInvoiceId === input.includeInvoice));
  const resolved = resolveEntries({ entries: chosen, link, mapping, project });
  return {
    data: {
      entries: resolved.map((entry) => ({
        claimedBy: entry.claim?.externalInvoiceId ?? null,
        hours: entry.hours,
        id: entry.id,
        milestoneId: entry.milestoneId,
        note: entry.note,
        person: { name: entry.resourceName ?? '', resourceId: entry.resourceId },
        story: entry.story,
        workDate: entry.workDate,
        workItem: entry.workItem,
      })),
      from: input.from,
      lines: billingLines(resolved, link),
      projectId,
      to: input.to,
      totalHours: sum(resolved),
    },
  };
}

/** All or nothing (api-contract.md). The 409 lists every entry that blocked the claim. */
export async function claimEntriesForApplication({ actorId, applicationId, billingRepository, idempotencyKey, input, projectId, tenantId }) {
  const add = [...new Set(input.add)];
  const remove = [...new Set(input.remove)];
  const result = await billingRepository.claimEntries({
    add, applicationId, externalInvoiceId: input.externalInvoiceId, idempotencyKey, projectId, remove, tenantId,
    changeEntries: ({ added, removed }) => [billingChange({ action: 'claim', actorId, detail: { added: added.length, kind: 'claims', removed: removed.length }, entityId: `invoice-gen:invoice:${input.externalInvoiceId}`, projectId, tenantId })],
  });
  if (result.conflicts) {
    return { body: { code: 'time_entries_claimed', conflicts: result.conflicts, error: 'Some time entries are already invoiced.' }, status: 409 };
  }
  return { body: { data: { entryIds: result.entryIds, externalInvoiceId: input.externalInvoiceId, hours: result.hours } }, status: 200 };
}

export async function releaseClaimsForApplication({ actorId, billingRepository, externalInvoiceId, projectId, tenantId }) {
  const released = await billingRepository.releaseClaims({
    changeEntries: ({ released: count }) => [billingChange({ action: 'release', actorId, detail: { kind: 'claims', released: count }, entityId: `invoice-gen:invoice:${externalInvoiceId}`, projectId, tenantId })],
    externalInvoiceId, projectId, tenantId,
  });
  return { data: { released } };
}

export async function putInvoiceForApplication({ actorId, billingRepository, externalInvoiceId, input, projectId, tenantId }) {
  const result = await billingRepository.putInvoice({
    changeEntries: ({ invoice, previousStatus, released }) => [billingChange({
      action: previousStatus ? 'update' : 'create', actorId, detail: { kind: 'invoice', released, status: invoice.status }, entityId: `invoice-gen:invoice:${externalInvoiceId}`, projectId, tenantId,
    })],
    externalId: externalInvoiceId, projectId, summary: input, tenantId,
  });
  const body = { data: presentInvoice(result.invoice), released: result.released };
  return result.ignored ? { ...body, ignored: true } : body;
}

export async function deleteInvoiceForApplication({ actorId, billingRepository, externalInvoiceId, projectId, tenantId }) {
  const result = await billingRepository.deleteInvoice({
    changeEntries: ({ released }) => [billingChange({ action: 'delete', actorId, detail: { kind: 'invoice', released }, entityId: `invoice-gen:invoice:${externalInvoiceId}`, projectId, tenantId })],
    externalId: externalInvoiceId, projectId, tenantId,
  });
  return { data: { deleted: result.deleted, released: result.released } };
}

// ---- member routes ----------------------------------------------------------------------------------

/**
 * Finance-visible people only (E-08). Someone who can read the project but not its billing is
 * told so (403 billing_not_allowed); anyone else gets the 404 a missing project gets.
 */
export async function requireBillingAccess({ projectId, projectRepository, user }) {
  const tenantId = tenantIdFor(user);
  await requireProjectCapability({ capability: PROJECT_CAPABILITIES.READ, projectId, repository: projectRepository, tenantId, user });
  const decision = await resolveDecisionRights({ projectId, repository: projectRepository, tenantId, user });
  if (!decision.allowed) {
    throw new HttpError(403, 'Billing is shown to project admins and managers, and workspace admins and managers.', { details: { code: 'billing_not_allowed' } });
  }
  return { tenantId };
}

const BILLED_STATUSES = new Set(['submitted', 'paid']);

/** The Billing panel: the link, each milestone's hours, the invoices, and when invoice-gen last called. */
export async function getProjectBillingForUser({ billingRepository, invoiceGenBaseUrl = '', projectId, projectRepository, user }) {
  const { tenantId } = await requireBillingAccess({ projectId, projectRepository, user });
  const [link, invoices, entries, mapping, project, heardAt] = await Promise.all([
    billingRepository.getLink({ projectId, tenantId }),
    billingRepository.listInvoices({ projectId, tenantId }),
    billingRepository.listProjectTimeEntries({ projectId, tenantId }),
    billingRepository.listStoryMilestones({ projectId, tenantId }),
    projectRepository.getProjectDetail({ projectId, tenantId }),
    billingRepository.lastHeardAt({ projectId, tenantId }),
  ]);
  const statusOf = new Map(invoices.map((invoice) => [invoice.externalId, invoice.status]));
  const resolved = resolveEntries({ entries, link, mapping, project });
  const known = new Set(agreementMilestones(link).map((milestone) => milestone.id));
  const storyCounts = new Map();
  for (const row of mapping) if (known.has(row.milestoneId)) storyCounts.set(row.milestoneId, (storyCounts.get(row.milestoneId) ?? 0) + 1);
  const hoursFor = (milestoneId) => {
    const own = resolved.filter((entry) => entry.milestoneId === milestoneId);
    const claimed = own.filter((entry) => entry.claim);
    const billed = claimed.filter((entry) => BILLED_STATUSES.has(statusOf.get(entry.claim.externalInvoiceId)));
    return {
      approvedUnclaimedHours: sum(own.filter(approvedUnclaimed)),
      billedHours: sum(billed),
      claimedUnbilledHours: sum(claimed.filter((entry) => !billed.includes(entry))),
    };
  };
  return {
    canManage: true,
    heardAt,
    invoiceGenUrl: invoiceGenBaseUrl || null,
    invoices: invoices
      .map((invoice) => ({ ...presentInvoice(invoice), overdue: invoice.overdue && invoice.status === 'submitted' }))
      .sort((left, right) => String(right.issueDate ?? right.sourceUpdatedAt).localeCompare(String(left.issueDate ?? left.sourceUpdatedAt))),
    link: presentLink(link, projectId),
    milestones: agreementMilestones(link).map((milestone) => ({
      budgetHours: milestone.hours, id: milestone.id, name: milestone.name, shortLabel: milestone.shortLabel ?? '', storyCount: storyCounts.get(milestone.id) ?? 0, ...hoursFor(milestone.id),
    })),
    noSow: hoursFor(null),
    ok: true,
  };
}

/** Each story with its milestone, and the SOW's milestones, for the Milestones section and the story field. */
export async function getStoryMilestonesForUser({ billingRepository, projectId, projectRepository, user }) {
  const { tenantId } = await requireBillingAccess({ projectId, projectRepository, user });
  const [link, mapping, project] = await Promise.all([
    billingRepository.getLink({ projectId, tenantId }),
    billingRepository.listStoryMilestones({ projectId, tenantId }),
    projectRepository.getProjectDetail({ projectId, tenantId }),
  ]);
  const milestones = agreementMilestones(link);
  const known = new Set(milestones.map((milestone) => milestone.id));
  const milestoneOf = new Map(mapping.filter((row) => known.has(row.milestoneId)).map((row) => [row.storyId, row.milestoneId]));
  return {
    agreement: link?.agreement ? { id: link.agreement.id, status: link.agreement.status, title: link.agreement.title, url: link.agreement.url ?? '' } : null,
    canManage: true,
    milestones: milestones.map(({ hours, id, name, shortLabel }) => ({ hours, id, name, shortLabel: shortLabel ?? '' })),
    ok: true,
    stories: storiesOf(project).map((story) => ({ epicId: story.epicId, epicTitle: story.epicTitle, id: story.id, milestoneId: milestoneOf.get(story.id) ?? null, title: story.title })),
  };
}

/** Sets or clears the milestone of each story named; a story holds at most one (E-05). */
export async function setStoryMilestonesForUser({ billingRepository, input, projectId, projectRepository, user }) {
  const { tenantId } = await requireBillingAccess({ projectId, projectRepository, user });
  const [link, project] = await Promise.all([
    billingRepository.getLink({ projectId, tenantId }),
    projectRepository.getProjectDetail({ projectId, tenantId }),
  ]);
  if (!link?.agreement) {
    throw new HttpError(409, 'This project has no SOW linked from invoice-gen, so there are no milestones to assign.', { details: { code: 'billing_not_linked' } });
  }
  const storyIds = new Set(storiesOf(project).map((story) => story.id));
  const milestoneIds = new Set(agreementMilestones(link).map((milestone) => milestone.id));
  const seen = new Set();
  const problems = [];
  for (const { milestoneId, storyId } of input.assignments) {
    if (seen.has(storyId)) problems.push({ code: 'duplicate_story', storyId });
    seen.add(storyId);
    if (!storyIds.has(storyId)) problems.push({ code: 'story_not_found', storyId });
    if (milestoneId != null && !milestoneIds.has(milestoneId)) problems.push({ code: 'milestone_not_found', milestoneId, storyId });
  }
  if (problems.length) {
    throw new HttpError(400, 'Some assignments name a story that is not on this project, a milestone the SOW does not have, or the same story twice.', { details: { code: 'invalid_assignments', problems } });
  }
  const { changed } = await billingRepository.setStoryMilestones({
    assignments: input.assignments,
    changeEntries: ({ changed: rows }) => rows.map((row) => billingChange({
      action: 'update', actorId: user.id, detail: { from: row.from, kind: 'story_milestone', to: row.to }, entityId: `story-milestone:${row.storyId}`, itemId: row.storyId, projectId, tenantId,
    })),
    projectId, tenantId, userId: user.id,
  });
  const result = await getStoryMilestonesForUser({ billingRepository, projectId, projectRepository, user });
  return { ...result, changed };
}
