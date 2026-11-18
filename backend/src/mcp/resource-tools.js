import { z } from 'zod';
import { OdinApiError } from './api-client.js';
import {
  projectAllocationCreateSchema, projectAllocationUpdateSchema, projectResourceAllocationSchema, projectResourceCreateSchema, projectResourceUpdateSchema,
  projectTaskAccessSchema, resourceCalendarEntryCreateSchema,
} from '../modules/resource-finance/resource-finance.schema.js';

// People, allocations, time and time off through Odin's resource-planning routes, and sprint
// capacity through the sprint staffing route. Odin checks every rule as it does for people: the
// workspace role for resources, allocations and others' time, plan-edit access to the project,
// open timesheet periods and the project rate floor. The changes go through routes that name
// their project, so a connection limited to some projects stays within them.

const input = projectResourceCreateSchema.extend({ allocation: projectResourceAllocationSchema.strict().default({}) }).strict();
const RESOURCE_FIELDS = ['id', 'version', 'name', 'email', 'roles', 'skills', 'location', 'capacityHoursPerWeek', 'billRate', 'costRate', 'currency', 'status', 'userId'];
const ALLOCATION_FIELDS = ['id', 'version', 'projectId', 'resourceId', 'hoursPerWeek', 'allocationPercent', 'role', 'startDate', 'endDate', 'status', 'billRate'];
const TIME_FIELDS = ['id', 'version', 'workDate', 'hours', 'billable', 'status', 'note', 'projectId', 'projectName', 'resourceId', 'resourceName', 'workItemId', 'workItemName', 'periodId', 'invoiced', 'invoice'];
const TIME_OFF_FIELDS = ['id', 'version', 'resourceId', 'resourceName', 'entryType', 'startDate', 'endDate', 'hoursPerDay', 'weekdays', 'timezone', 'status', 'note'];
const pick = (record, fields) => Object.fromEntries(fields.filter((key) => key in (record ?? {})).map((key) => [key, record[key]]));

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
const expectedVersion = z.number().int().positive();
const hours = z.number().finite().positive().max(24);
const workItem = z.string().trim().min(1).max(200).describe('The work item\'s id, or words from its name ("login story"). Matched against the project\'s epics, stories and tasks.');
const listShape = (id) => ({
  from: date.optional().describe('First day, YYYY-MM-DD.'),
  to: date.optional().describe('Last day, YYYY-MM-DD.'),
  resourceId: id.optional().describe('One person\'s resource id (from odin_get_project_team).'),
  mine: z.boolean().default(false).describe('Only the signed-in user\'s own.'),
  limit: z.number().int().min(1).max(500).default(100),
});
const listQuery = ({ from, limit, mine, resourceId, to }) => ({ from, limit, mine: mine ? 'true' : undefined, resourceId, to });

const NOT_YOURS = 'without a workspace admin or manager role, people log and change only their own time, while it is submitted';
const STALE = (read) => ['version_conflict', `It changed since it was read. Read it again with ${read} and use its current version.`];
const ERRORS = {
  resource: {
    400: ['http_400', 'Odin rejected the resource. The allocation must end on or after it starts, and the project rate cannot be below the person\'s minimum bill rate.'],
    403: ['outside_connection', 'Someone with this name already has a profile in projects this connection cannot see, so it cannot be reused from here. Ask someone with access to the whole workspace to add them, or add something that tells this person apart to the name, such as their company.'],
    404: ['http_404', 'Project not found, or the user cannot add resources to it: that takes a workspace admin or manager role and plan-edit access to the project.'],
    409: ['has_login', 'Someone with an Odin login in this workspace has this name, or the email belongs to a login or to another profile. Add a person with a login with odin_add_project_allocation (userId) or odin_update_project_members instead. For someone else, give their own email, which tells them apart; never put an email in the name.'],
  },
  profile: {
    400: ['http_400', 'Odin rejected the profile. A name is 1 to 240 characters and an email a full address.'],
    404: ['http_404', 'Person not found on this project, or the user cannot edit resources: that takes a workspace admin or manager role and plan-edit access. Resource ids come from odin_get_project_team (people).'],
    409: ['conflict', 'Odin refused the change: the profile changed since it was read (read it again with odin_get_project_team), the email belongs to a login or another profile, or the person has a login, whose name and email come from it.'],
  },
  taskAccess: {
    404: ['http_404', 'Project or person not found, or the user cannot manage task access: that takes a workspace admin or manager role and plan-edit access to the project.'],
    409: ['conflict', 'Odin refused: task access needs an active profile without a login, with an email, on the project (set the email with odin_update_project_resource), and sending the link needs task access turned on first.'],
  },
  allocation: {
    400: ['http_400', 'Odin rejected the allocation. It must end on or after it starts, and the project rate cannot be below the person\'s minimum bill rate.'],
    404: ['http_404', 'Project, person or allocation not found, or the user cannot staff this project: that takes a workspace admin or manager role and plan-edit access. Allocation ids and directory resource ids come from odin_get_project_team; inactive profiles cannot be added. A connection limited to some projects cannot see the workspace directory, so it can add or move hours to only people already on those projects.'],
    409: STALE('odin_get_project_team'),
  },
  time: {
    400: ['http_400', 'Odin rejected the time. Hours are more than 0 and at most 24 for one day, and dates are YYYY-MM-DD.'],
    404: ['http_404', `Project, work item or time entry not found, or not the user's to change: ${NOT_YOURS}.`],
    409: STALE('odin_list_time_entries'),
    422: ['no_resource_profile', 'The signed-in user has no resource profile in this workspace, so there is nowhere to log their time. A workspace admin or manager can add them to the project with odin_add_project_allocation (userId), then log again.'],
    423: ['period_locked', 'That date\'s timesheet period is locked or closed, so time in it cannot be added, changed or deleted. A workspace admin or manager can reopen the period in Odin.'],
  },
  timeList: {
    404: ['http_404', 'Project not found or not readable. A connection limited to certain projects must pass one of their projectIds.'],
  },
  timeOff: {
    400: ['http_400', 'Odin rejected the time off. It must end on or after it starts, hours per day are 0 to 24, and weekdays run 0 (Sunday) to 6.'],
    404: ['http_404', 'Person or time off not found, or the user cannot manage time off: that takes a workspace admin or manager role. Time off belongs to a person rather than a project, so a connection limited to certain projects cannot reach it.'],
    409: STALE('odin_list_time_off'),
  },
  sprint: {
    404: ['http_404', 'Project or sprint not found, or the user cannot edit the plan.'],
  },
};

// Odin's own refusals (http_<status>) become messages that say what to do next; errors a tool
// raised itself, such as the project-manager rule, pass through as they are.
function remap(error, mapping) {
  if (error instanceof OdinApiError && error.code === `http_${error.status}` && mapping[error.status]) {
    const [code, message] = mapping[error.status];
    throw new OdinApiError(error.status, code, message, { outcomeUnknown: error.outcomeUnknown });
  }
  throw error;
}

function projectItems(project) {
  const rows = [];
  for (const epic of project?.epics ?? []) {
    rows.push({ id: epic.id, itemType: 'epic', name: epic.name ?? '' });
    for (const story of epic.stories ?? []) {
      rows.push({ id: story.id, itemType: 'story', name: story.name ?? '' });
      for (const task of story.tasks ?? []) rows.push({ id: task.id, itemType: 'task', name: task.name ?? '' });
    }
  }
  return rows;
}

const ITEM_TYPES = ['epic', 'story', 'task'];
const FILLER = new Set(['a', 'an', 'the', 'on', 'for', 'item', 'work', ...ITEM_TYPES]);

/** The work items an id or name points at: the id itself, the exact name, or every word of it, narrowed by a type it names. */
export function matchWorkItems(items, text) {
  const byId = items.filter((item) => item.id === text);
  if (byId.length) return byId;
  const wanted = text.toLowerCase().trim();
  const exact = items.filter((item) => item.name.toLowerCase() === wanted);
  if (exact.length) return exact;
  const words = wanted.split(/\s+/).filter(Boolean);
  const meaningful = words.filter((word) => !FILLER.has(word));
  const matches = items.filter((item) => (meaningful.length ? meaningful : words).every((word) => item.name.toLowerCase().includes(word)));
  const types = words.filter((word) => ITEM_TYPES.includes(word));
  const typed = matches.filter((item) => types.includes(item.itemType));
  return typed.length ? typed : matches;
}

/** Registers the resource, allocation, time, time off and sprint capacity tools on createOdinToolCatalog's `tool` helper. */
export function registerResourceTools({ api, dryRun, id, tool }) {
  const planning = '/api/resource-planning';
  const projectPlanning = (projectId) => `${planning}/projects/${encodeURIComponent(projectId)}`;
  const preview = (method, path, body, extra = {}) => ({ ok: true, dryRun: true, validation: 'schema_only', authorizationChecked: false, request: { method, path, ...(body ? { body } : {}), ...extra } });
  async function call(method, path, options, errors) {
    try {
      return await api.request(method, path, options);
    } catch (error) {
      return remap(error, errors);
    }
  }

  async function findWorkItem(projectId, text) {
    const { project } = await call('GET', `/api/projects/${encodeURIComponent(projectId)}`, {}, ERRORS.timeList);
    const matches = matchWorkItems(projectItems(project), text);
    if (matches.length === 1) return matches[0];
    if (!matches.length) throw new OdinApiError(404, 'work_item_not_found', `No epic, story or task on this project matches "${text}". Find it with odin_find_items and pass its id.`);
    throw new OdinApiError(400, 'work_item_ambiguous', `"${text}" matches ${matches.length} work items. Pass one of their ids.`, {
      details: { matches: matches.slice(0, 8).map((item) => pick(item, ['id', 'itemType', 'name'])) },
    });
  }

  tool('odin_add_project_resource', [
    'Add someone without an Odin login to a project as a resource: a contractor, a vendor\'s engineer, or a role not filled yet.',
    'Creates their resource profile with no login and allocates them to the project, so they show on its Resources tab, count toward capacity and rates,',
    'and can own work items through the returned assigneeId (resource:<id>). email is where their task access link goes: put it in email, never in the name.',
    'Adding them sends no email and gives them no access to Odin; odin_set_task_access and odin_send_task_access_link do that.',
    'An active profile without a login with the same email, or else the same name, is reused rather than duplicated, keeping its details (one with no email takes the email given); created says which happened,',
    'and added is false when they were already on the project. allocation dates default to the project\'s, hoursPerWeek to 0, status to active;',
    'allocation.billRate is this project\'s rate for them (null uses their profile rate). For people already in Odin, use odin_add_project_allocation.',
    'A name like a workspace member\'s is refused unless email is given. Needs a workspace admin or manager role and plan-edit access to the project.',
  ].join(' '), z.object({ projectId: id, input, dryRun }).strict(), async (args) => {
    const path = `${projectPlanning(args.projectId)}/resources`;
    if (args.dryRun) return preview('POST', path, args.input);
    const result = await call('POST', path, { body: args.input }, ERRORS.resource);
    return {
      ok: true,
      added: Boolean(result.added),
      created: Boolean(result.created),
      assigneeId: result.assigneeId,
      resource: pick(result.resource, RESOURCE_FIELDS),
      allocation: pick(result.allocation, ALLOCATION_FIELDS),
    };
  }, { write: true, purpose: 'Add someone without an Odin login (a contractor, vendor or unfilled role) to the project as a resource who can own work.' });

  const profileChanges = projectResourceUpdateSchema.refine((value) => Object.keys(value).some((key) => key !== 'expectedVersion'), 'Give at least one change.');
  tool('odin_update_project_resource', [
    'Change the profile of someone without an Odin login on a project: name, email (where their task access link goes; null removes it), roles, location or capacityHoursPerWeek.',
    'Use the resource id and version from odin_get_project_team (people). A new email takes effect for the next link sent; a link already sent to the old address keeps working until turned off.',
    'People with a login take their name and email from it. Needs a workspace admin or manager role and plan-edit access to the project.',
  ].join(' '), z.object({ projectId: id, resourceId: id, input: profileChanges, dryRun }).strict(), async (args) => {
    const path = `${projectPlanning(args.projectId)}/resources/${encodeURIComponent(args.resourceId)}`;
    if (args.dryRun) return preview('PATCH', path, args.input);
    const result = await call('PATCH', path, { body: args.input }, ERRORS.profile);
    return { ok: true, resource: pick(result.resource, RESOURCE_FIELDS) };
  }, { write: true, purpose: 'Change the name, email, roles or capacity of someone without an Odin login on the project.' });

  // ---- Task access for people without a login ----
  const ACCESS_FIELDS = ['resourceId', 'name', 'email', 'scope', 'link'];
  tool('odin_get_task_access', [
    'List the people without an Odin login on a project with their task access: scope off, own (they see and update their own work from a link) or all',
    '(they also see everyone else\'s), their email, and their access link\'s state (null when none was sent). Links themselves are never returned.',
    'Needs a workspace admin or manager role and plan-edit access to the project.',
  ].join(' '), z.object({ projectId: id }).strict(), async (args) => {
    const result = await call('GET', `${projectPlanning(args.projectId)}/task-access`, {}, ERRORS.taskAccess);
    return { ok: true, people: (result.entries ?? []).map((entry) => pick(entry, ACCESS_FIELDS)) };
  }, { purpose: 'See which people without a login can see and update their work on the project from a link.' });

  tool('odin_set_task_access', [
    'Turn task access on or off for someone without an Odin login on a project. scope own lets them see the epics, stories and tasks assigned to them and update those',
    '(status, remaining hours, comments, time) and add tasks under their stories, from a link without signing in; all also shows everyone else\'s work, read-only; off removes the project from their link.',
    'Needs an active profile with an email, allocated to the project. Sends no email: odin_send_task_access_link does that. If they already hold a link from another project, it opens this one at once.',
    'Needs a workspace admin or manager role and plan-edit access to the project.',
  ].join(' '), z.object({ projectId: id, resourceId: id, scope: projectTaskAccessSchema.shape.scope, dryRun }).strict(), async (args) => {
    const path = `${projectPlanning(args.projectId)}/task-access/${encodeURIComponent(args.resourceId)}`;
    if (args.dryRun) return preview('PUT', path, { scope: args.scope });
    const result = await call('PUT', path, { body: { scope: args.scope } }, ERRORS.taskAccess);
    return { ok: true, person: pick(result.entry, ACCESS_FIELDS) };
  }, { write: true, purpose: 'Let someone without a login see and update their work on the project from a link, or stop them.' });

  tool('odin_send_task_access_link', [
    'Email someone without an Odin login their access link, which opens every project where their task access is on, and any client portals for their email.',
    'Turn task access on first with odin_set_task_access. Every call issues another link and sends another email (links sent earlier keep working): never retry blindly.',
    'emailed is false when Odin could not queue the email.',
    'Needs a workspace admin or manager role and plan-edit access to the project.',
  ].join(' '), z.object({ projectId: id, resourceId: id, dryRun }).strict(), async (args) => {
    const path = `${projectPlanning(args.projectId)}/task-access/${encodeURIComponent(args.resourceId)}/link`;
    if (args.dryRun) return preview('POST', path, { delivery: 'email' });
    const result = await call('POST', path, { body: { delivery: 'email' } }, ERRORS.taskAccess);
    return { ok: true, emailed: Boolean(result.emailed) };
  }, { write: true, confirm: true, purpose: 'Email someone without a login the link to their work on the project.' });

  // ---- Allocations ----
  const allocationInput = projectAllocationCreateSchema.innerType().strict()
    .refine((value) => Boolean(value.resourceId) !== Boolean(value.userId), { message: 'Give a resourceId or a userId.', path: ['resourceId'] });
  tool('odin_add_project_allocation', [
    'Allocate someone already in Odin to a project: a resource from the directory (resourceId, from odin_get_project_team\'s directory) or a workspace user (userId, from odin_list_project_members\' candidates or members).',
    'A user without a resource profile gets one linked to their login, as the Resources tab makes it; created says so. added is false, and nothing changes, when they are already on the project.',
    'Dates default to the project\'s, hoursPerWeek to 0 and status to active; allocationPercent follows from the hours and their weekly capacity unless given.',
    'billRate is this project\'s rate for them (null uses their profile rate) and cannot go below their minimum. This adds no project access: use odin_update_project_members for that.',
    'For someone without a login, use odin_add_project_resource. Needs a workspace admin or manager role and plan-edit access to the project.',
  ].join(' '), z.object({ projectId: id, input: allocationInput, dryRun }).strict(), async (args) => {
    const path = `${projectPlanning(args.projectId)}/allocations`;
    if (args.dryRun) return preview('POST', path, args.input);
    const result = await call('POST', path, { body: args.input }, ERRORS.allocation);
    return { ok: true, added: Boolean(result.added), created: Boolean(result.created), assigneeId: result.assigneeId, resource: pick(result.resource, RESOURCE_FIELDS), allocation: pick(result.allocation, ALLOCATION_FIELDS) };
  }, { write: true, purpose: 'Add someone already in Odin (a resource or a workspace user) to the project with weekly hours, dates, role and rate.' });

  const allocationChanges = projectAllocationUpdateSchema.strict().refine((value) => Object.keys(value).some((key) => key !== 'expectedVersion'), 'Give at least one change.');
  tool('odin_update_project_allocation', [
    'Change someone\'s allocation on a project: hoursPerWeek, allocationPercent, dates, role, status or billRate (this project\'s rate; null uses their profile rate, and it cannot go below their minimum).',
    'New hours without a new allocationPercent keep the percent in step with their weekly capacity. To end an allocation, set endDate to its last day and, once it is over, status completed.',
    'Use the allocation id and version from odin_get_project_team. Needs a workspace admin or manager role and plan-edit access to the project.',
  ].join(' '), z.object({ projectId: id, allocationId: id, input: allocationChanges, dryRun }).strict(), async (args) => {
    const path = `${projectPlanning(args.projectId)}/allocations/${encodeURIComponent(args.allocationId)}`;
    if (args.dryRun) return preview('PATCH', path, args.input);
    const result = await call('PATCH', path, { body: args.input }, ERRORS.allocation);
    return { ok: true, allocation: pick(result.value, ALLOCATION_FIELDS) };
  }, { write: true, destructive: true, purpose: 'Change someone\'s hours, dates, role or rate on the project, or end their allocation.' });

  tool('odin_remove_project_allocation', [
    'Delete one allocation, taking that person off the project\'s resources for its dates. Their work items, logged time and project access stay;',
    'someone who still owns work may be allocated again when the plan is next saved. To keep the history, end the allocation with odin_update_project_allocation instead.',
    'Use the allocation id and version from odin_get_project_team. Needs a workspace admin or manager role and plan-edit access to the project.',
  ].join(' '), z.object({ projectId: id, allocationId: id, expectedVersion, dryRun }).strict(), async (args) => {
    const path = `${projectPlanning(args.projectId)}/allocations/${encodeURIComponent(args.allocationId)}`;
    if (args.dryRun) return preview('DELETE', path, { expectedVersion: args.expectedVersion });
    await call('DELETE', path, { body: { expectedVersion: args.expectedVersion } }, ERRORS.allocation);
    return { ok: true, deleted: true, allocationId: args.allocationId };
  }, { write: true, destructive: true, confirm: true, purpose: 'Take someone off the project\'s resources by removing their allocation.' });

  tool('odin_move_allocation_hours', [
    'Move some or all of one allocation\'s weekly hours on a project to another active resource (targetResourceId), for the same dates and role (resource leveling).',
    'Moving every hour hands the allocation over; fewer splits it. Use the allocation id and version from odin_get_project_team.',
    'Needs a workspace admin or manager role and plan-edit access to the project.',
  ].join(' '), z.object({ projectId: id, allocationId: id, expectedVersion, hours: z.number().finite().positive().max(168), targetResourceId: id, dryRun }).strict(), async (args) => {
    const path = `${projectPlanning(args.projectId)}/allocations/${encodeURIComponent(args.allocationId)}/level`;
    const body = { expectedVersion: args.expectedVersion, hours: args.hours, targetResourceId: args.targetResourceId };
    if (args.dryRun) return preview('POST', path, body);
    const { value } = await call('POST', path, { body }, ERRORS.allocation);
    return { ok: true, movedHours: value.movedHours ?? args.hours, from: value.sourceAllocation ? pick(value.sourceAllocation, ALLOCATION_FIELDS) : null, to: pick(value.targetAllocation, ALLOCATION_FIELDS) };
  }, { write: true, destructive: true, purpose: 'Move some or all of someone\'s weekly hours on the project to another person (resource leveling).' });

  // ---- Time ----
  tool('odin_log_time', [
    'Log hours worked on a project in one call, such as 3 hours on the login story today. The time is the signed-in user\'s unless resourceId names someone else,',
    'which takes a workspace admin or manager role. workItem is matched by id or name; workDate defaults to today (UTC), so pass the user\'s own date when you know it.',
    'Odin files it in the timesheet period holding the date, which must be open, and records it as submitted.',
  ].join(' '), z.object({
    projectId: id,
    hours,
    workItem: workItem.optional(),
    workDate: date.optional(),
    note: z.string().trim().max(2000).default(''),
    billable: z.boolean().default(false),
    resourceId: id.optional().describe('Someone else\'s resource id (from odin_get_project_team).'),
    dryRun,
  }).strict(), async (args) => {
    const path = `${projectPlanning(args.projectId)}/time-entries`;
    const body = { billable: args.billable, hours: args.hours, note: args.note, ...(args.resourceId ? { resourceId: args.resourceId } : {}), ...(args.workDate ? { workDate: args.workDate } : {}) };
    if (args.dryRun) return preview('POST', path, body, args.workItem ? { workItem: args.workItem, resolves: 'The work item is matched by id or name when applied.' } : {});
    const item = args.workItem ? await findWorkItem(args.projectId, args.workItem) : null;
    const { value } = await call('POST', path, { body: { ...body, workItemId: item?.id ?? null } }, ERRORS.time);
    return { ok: true, entry: { ...pick(value, TIME_FIELDS), workItemName: item?.name ?? null } };
  }, { write: true, purpose: 'Log hours someone worked on a project, such as 3 hours on the login story today.' });

  tool('odin_list_time_entries', [
    'List logged time, newest first, with totals by status: on one project or every project the user can see, for one person, the signed-in user (mine), and dates.',
    'Without a workspace admin or manager role, people see only their own time. Entries carry the id and version that odin_update_time_entry and odin_delete_time_entry need;',
    'an entry with invoiced true is on an invoice (its number, or draft) and nobody can change or delete it;',
    'myResourceId is the signed-in user\'s resource profile (null when they have none).',
  ].join(' '), z.object({ projectId: id.optional(), ...listShape(id) }).strict(), async (args) => {
    const result = await call('GET', `${planning}/time-entries`, { query: { ...listQuery(args), projectId: args.projectId } }, ERRORS.timeList);
    return { ok: true, entries: (result.entries ?? []).map((entry) => pick(entry, TIME_FIELDS)), total: result.total, totals: result.totals, myResourceId: result.myResourceId ?? null };
  }, { purpose: 'See logged hours (timesheets): who logged what, on which project and work item, over a date range.' });

  const timeChanges = z.object({
    expectedVersion,
    hours: hours.optional(),
    workDate: date.optional(),
    note: z.string().trim().max(2000).optional(),
    billable: z.boolean().optional(),
    status: z.enum(['submitted', 'approved', 'rejected']).optional().describe('Approving or rejecting takes a workspace admin or manager role.'),
    workItem: workItem.nullable().optional().describe('The work item\'s id or words from its name; null takes the time off any work item.'),
  }).strict().refine((value) => Object.keys(value).some((key) => key !== 'expectedVersion'), 'Give at least one change.');
  tool('odin_update_time_entry', [
    'Change a time entry on a project: hours, date, note, billable, work item, or its status (approve or reject, for a workspace admin or manager).',
    'Use the id and version from odin_list_time_entries. A new date moves it to that date\'s timesheet period; time in a locked or closed period cannot change.',
    `As with logging, ${NOT_YOURS}.`,
  ].join(' '), z.object({ projectId: id, timeEntryId: id, input: timeChanges, dryRun }).strict(), async (args) => {
    const path = `${projectPlanning(args.projectId)}/time-entries/${encodeURIComponent(args.timeEntryId)}`;
    const { workItem: wanted, ...changes } = args.input;
    if (args.dryRun) return preview('PATCH', path, changes, wanted ? { workItem: wanted, resolves: 'The work item is matched by id or name when applied.' } : {});
    const item = wanted ? await findWorkItem(args.projectId, wanted) : null;
    const body = { ...changes, ...(wanted !== undefined ? { workItemId: item?.id ?? null } : {}) };
    const { value } = await call('PATCH', path, { body }, ERRORS.time);
    // The entry names its work item only if it is one of the project's epics, stories or tasks: an id
    // stored for anything else could be a ticket from outside that nobody has validated.
    const named = item ?? (value?.workItemId
      ? projectItems((await call('GET', `/api/projects/${encodeURIComponent(args.projectId)}`, {}, ERRORS.timeList)).project).find((entry) => entry.id === value.workItemId) ?? null
      : null);
    return { ok: true, entry: { ...pick(value, TIME_FIELDS), workItemId: named?.id ?? null, ...(named ? { workItemName: named.name } : {}) } };
  }, { write: true, destructive: true, purpose: 'Change logged hours, their date, note or work item, or approve or reject someone\'s time.' });

  tool('odin_delete_time_entry', [
    'Delete a time entry on a project. Use the id and version from odin_list_time_entries. Time in a locked or closed timesheet period stays.',
    'People can delete their own time while it is still submitted and its timesheet period is open; anyone else\'s time, or approved or rejected time, takes a workspace admin or manager role.',
  ].join(' '), z.object({ projectId: id, timeEntryId: id, expectedVersion, dryRun }).strict(), async (args) => {
    const path = `${projectPlanning(args.projectId)}/time-entries/${encodeURIComponent(args.timeEntryId)}`;
    if (args.dryRun) return preview('DELETE', path, { expectedVersion: args.expectedVersion });
    await call('DELETE', path, { body: { expectedVersion: args.expectedVersion } }, {
      ...ERRORS.time, 404: ['http_404', 'Time entry not found on this project, or not the user\'s to delete: people delete only their own time while it is still submitted; anything else takes a workspace admin or manager role.'],
    });
    return { ok: true, deleted: true, timeEntryId: args.timeEntryId };
  }, { write: true, destructive: true, confirm: true, purpose: 'Delete a time entry logged by mistake.' });

  // ---- Time off ----
  tool('odin_list_time_off', [
    'List time off and working-hour changes overlapping some dates, soonest first: leave, holidays and working_override entries (different hours on some days).',
    'Approved entries reduce the person\'s capacity by hoursPerDay on each of their weekdays (0 is Sunday). Without a workspace admin or manager role, people see only their own.',
    'myResourceId is the signed-in user\'s resource profile.',
  ].join(' '), z.object(listShape(id)).strict(), async (args) => {
    const result = await call('GET', `${planning}/calendar-entries`, { query: listQuery(args) }, ERRORS.timeOff);
    return { ok: true, entries: (result.entries ?? []).map((entry) => pick(entry, TIME_OFF_FIELDS)), total: result.total, myResourceId: result.myResourceId ?? null };
  }, { purpose: 'See who is on leave or holiday, or works different hours, over some dates.' });

  const timeOffInput = resourceCalendarEntryCreateSchema.innerType().extend({
    hoursPerDay: z.number().finite().min(0).max(24).optional().describe('Hours off each day for leave and holidays (default 8, a full day); hours worked each day for working_override.'),
  }).strict()
    .refine((value) => value.endDate >= value.startDate, { message: 'End date must be on or after start date.', path: ['endDate'] })
    .refine((value) => value.entryType !== 'working_override' || value.hoursPerDay !== undefined, { message: 'Give the hours they work each day.', path: ['hoursPerDay'] });
  tool('odin_add_time_off', [
    'Record leave, a holiday, or different working hours (working_override) for one person, by their resource id (from odin_get_project_team or odin_list_time_off).',
    'It applies on the given weekdays (default Monday to Friday; 0 is Sunday) between the dates. Approved entries (the default) change their capacity on every project.',
    'Needs a workspace admin or manager role.',
  ].join(' '), z.object({ input: timeOffInput, dryRun }).strict(), async (args) => {
    const path = `${planning}/calendar-entries`;
    const body = { ...args.input, hoursPerDay: args.input.hoursPerDay ?? 8 };
    if (args.dryRun) return preview('POST', path, body);
    const { value } = await call('POST', path, { body }, ERRORS.timeOff);
    return { ok: true, timeOff: pick(value, TIME_OFF_FIELDS) };
  }, { write: true, purpose: 'Record leave, a holiday or different working hours for a person.' });

  tool('odin_delete_time_off', 'Delete one leave, holiday or working-hours entry, by the id and version from odin_list_time_off. Needs a workspace admin or manager role.', z.object({ calendarEntryId: id, expectedVersion, dryRun }).strict(), async (args) => {
    const path = `${planning}/calendar-entries/${encodeURIComponent(args.calendarEntryId)}`;
    if (args.dryRun) return preview('DELETE', path, { expectedVersion: args.expectedVersion });
    await call('DELETE', path, { body: { expectedVersion: args.expectedVersion } }, ERRORS.timeOff);
    return { ok: true, deleted: true, calendarEntryId: args.calendarEntryId };
  }, { write: true, destructive: true, confirm: true, purpose: 'Remove someone\'s leave, holiday or working-hours entry.' });

  // ---- Sprint capacity ----
  const sprintsPath = (projectId) => `/api/projects/${encodeURIComponent(projectId)}/sprints`;
  async function readSprints(projectId) {
    const result = await call('GET', sprintsPath(projectId), {}, ERRORS.sprint);
    const names = new Map((result.members ?? []).map((member) => [member.id, member.name ?? '']));
    const staffing = (entries) => (entries ?? []).map((entry) => ({ userId: entry.userId, name: names.get(entry.userId) ?? '', capacityHours: entry.capacityHours ?? null, allocationPctOverride: entry.allocationPctOverride ?? null, notes: entry.notes ?? '' }));
    const sprints = (result.sprints ?? []).map((sprint) => ({
      id: sprint.id, name: sprint.name, status: sprint.status, startDate: sprint.startDate ?? null, endDate: sprint.endDate ?? null,
      capacityHours: sprint.summary?.capacityHours ?? 0, plannedHours: sprint.summary?.totalHours ?? 0, plannedPoints: sprint.summary?.totalPoints ?? 0, plannedItems: sprint.summary?.totalItems ?? 0,
      staffing: staffing(sprint.staffing),
    }));
    return { members: [...names].map(([userId, name]) => ({ userId, name })), names, sprints };
  }

  tool('odin_get_sprint_capacity', [
    'Read sprint capacity: each member\'s hours for the sprint (and any allocation percent override or note), the sprint\'s total, and the hours, points and items planned in it.',
    'Without sprintId, covers the active and planned sprints. members lists who can be given capacity.',
  ].join(' '), z.object({ projectId: id, sprintId: id.optional() }).strict(), async ({ projectId, sprintId }) => {
    const { members, sprints } = await readSprints(projectId);
    const shown = sprints.filter((sprint) => (sprintId ? sprint.id === sprintId : ['active', 'planned'].includes(String(sprint.status).toLowerCase())));
    if (sprintId && !shown.length) throw new OdinApiError(404, 'sprint_not_found', 'No sprint with that id on this project. Call odin_get_sprint_capacity without sprintId to list them.');
    return { ok: true, projectId, sprints: shown, members };
  }, { purpose: 'Read each member\'s hours available in a sprint against the work planned in it.' });

  const staffingEntry = z.object({
    userId: id,
    capacityHours: z.number().finite().min(0).max(100000).nullable(),
    allocationPctOverride: z.number().finite().min(0).max(1000).nullable().optional(),
    notes: z.string().trim().max(1000).optional(),
  }).strict();
  tool('odin_set_sprint_capacity', [
    'Set members\' hours for one sprint: set adds or changes their capacityHours (and optional allocationPctOverride or notes), remove takes members out of the sprint\'s capacity.',
    'Everyone else keeps what they have. Only project members (odin_get_sprint_capacity members) can have capacity. Odin keeps no version for capacity, so the last save wins.',
    'Changing sprints takes a project admin or manager.',
  ].join(' '), z.object({ projectId: id, sprintId: id, set: z.array(staffingEntry).max(200).default([]), remove: z.array(id).max(200).default([]), dryRun }).strict(), async (args) => {
    if (!args.set.length && !args.remove.length) throw new OdinApiError(400, 'nothing_to_change', 'Give set, remove or both.');
    const path = `${sprintsPath(args.projectId)}/${encodeURIComponent(args.sprintId)}/staffing`;
    if (args.dryRun) return preview('PUT', path, null, { change: { set: args.set, remove: args.remove }, note: 'The saved list is built from the sprint\'s current capacity when applied.' });
    const { names, sprints } = await readSprints(args.projectId);
    const sprint = sprints.find((entry) => entry.id === args.sprintId);
    if (!sprint) throw new OdinApiError(404, 'sprint_not_found', 'No sprint with that id on this project. Use odin_get_sprint_capacity to list them.');
    const strangers = args.set.map((entry) => entry.userId).filter((userId) => !names.has(userId));
    if (strangers.length) throw new OdinApiError(400, 'not_project_member', `Only project members can have sprint capacity; not members: ${strangers.join(', ')}. Add them with odin_update_project_members first.`);
    const byUser = new Map(sprint.staffing.map(({ name: _name, ...entry }) => [entry.userId, entry]));
    for (const userId of args.remove) byUser.delete(userId);
    for (const entry of args.set) byUser.set(entry.userId, { ...byUser.get(entry.userId), ...entry });
    const staffing = [...byUser.values()].map((entry) => ({ allocationPctOverride: entry.allocationPctOverride ?? null, capacityHours: entry.capacityHours ?? null, notes: entry.notes ?? '', userId: entry.userId }));
    const result = await call('PUT', path, { body: { staffing } }, ERRORS.sprint);
    const saved = (result.staffing ?? []).map((entry) => ({ userId: entry.userId, name: names.get(entry.userId) ?? '', capacityHours: entry.capacityHours ?? null, allocationPctOverride: entry.allocationPctOverride ?? null, notes: entry.notes ?? '' }));
    return { ok: true, sprintId: args.sprintId, capacityHours: saved.reduce((sum, entry) => sum + (Number(entry.capacityHours) || 0), 0), staffing: saved };
  }, { write: true, destructive: true, purpose: 'Set how many hours each member has for a sprint.' });
}
