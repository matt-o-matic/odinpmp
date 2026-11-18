// What a turn changed in Odin, and how to put it back. The turn's API client is wrapped: before
// each write to a route it knows, the recorder reads what the write will change; after the write
// succeeds it keeps the request that reverses it, and the version the write's reply gives each
// record it touched. Writes it cannot reverse are recorded too, so the user sees everything that
// changed. Undo skips anything changed since the turn's own write, or between two of its writes,
// rather than overwrite someone else's work, and reverses the rest in reverse order, as the user,
// through the same routes.

import { createHash } from 'node:crypto';

import { isTicketVisibleToAssistant } from '../../modules/assistant/assistant-ticket-visibility.js';
import { textMentionsSomeone } from '../mentions/mention-markup.js';

const PROJECT_ITEM_FIELDS = ['actualHours', 'assigneeId', 'assigneeName', 'boardColumn', 'description', 'estimateOverride', 'name', 'percentComplete', 'points', 'priority', 'progress', 'sprintId', 'sprintSortOrder', 'status', 'targetEndDate', 'targetHourEstimate', 'targetStartDate'];
const GOVERNANCE_FIELDS = ['description', 'dueDate', 'impact', 'kind', 'ownerId', 'probability', 'responsePlan', 'status', 'title'];
const MILESTONE_FIELDS = ['status', 'targetDate', 'title', 'workItemId'];
const DEPENDENCY_FIELDS = ['dependencyType', 'lagDays', 'predecessorId', 'successorId'];
const WORKING_CALENDAR_FIELDS = ['holidays', 'hoursPerDay', 'timezone', 'workingDays'];
const SPRINT_FIELDS = ['name', 'goal', 'startDate', 'endDate', 'status'];
const MEMBER_ROLES = ['admin', 'manager', 'user'];
const STAKEHOLDER_FIELDS = ['email', 'name', 'roleTitle'];
const TIME_FIELDS = ['billable', 'hours', 'note', 'periodId', 'projectId', 'resourceId', 'status', 'workDate', 'workItemId'];
const ALLOCATION_FIELDS = ['allocationPercent', 'billRate', 'endDate', 'hoursPerWeek', 'origin', 'projectId', 'resourceId', 'role', 'scenario', 'startDate', 'status'];
const TIME_OFF_FIELDS = ['endDate', 'entryType', 'hoursPerDay', 'note', 'resourceId', 'startDate', 'status', 'timezone', 'weekdays'];
const RESOURCE_PROFILE_FIELDS = ['capacityHoursPerWeek', 'email', 'location', 'name', 'roles'];
const FIELD_WORDS = { allocationPercent: 'share of the week', assigneeId: 'assignee', assigneeName: null, estimateOverride: 'estimate', lagDays: 'lag', parentId: 'parent', roleTitle: 'role', sprintId: 'sprint', sprintSortOrder: null, targetEndDate: 'end date', targetHourEstimate: 'hours', targetStartDate: 'start date', workDate: 'date' };
const TIME_OFF_WORDS = { holiday: 'a holiday', leave: 'time off', working_override: 'different working hours' };
const ROLE_WORDS = { admin: 'an admin', manager: 'a manager', user: 'a member' };

const PLANNING = '/api/resource-planning';
const enc = encodeURIComponent;
const projectPath = (projectId) => `/api/projects/${enc(projectId)}`;
const governancePath = (projectId) => `${projectPath(projectId)}/governance`;
const decode = (value) => decodeURIComponent(value);
const byId = (list, id) => (list ?? []).find((entry) => entry.id === id);
// A comment anywhere in a target's thread, replies included.
const findComment = (comments, id) => byId(comments, id) ?? (comments ?? []).reduce((found, comment) => found ?? findComment(comment.children, id), undefined);

function itemsOf(project = {}) {
  const rows = [];
  for (const epic of project.epics ?? []) {
    rows.push({ ...epic, itemType: 'epic', parentId: null });
    for (const story of epic.stories ?? []) {
      rows.push({ ...story, itemType: 'story', parentId: epic.id });
      for (const task of story.tasks ?? []) rows.push({ ...task, itemType: 'task', parentId: story.id });
    }
  }
  // Labels quote names, and a ticket from outside that nobody has validated stays unnamed.
  // The assistant can't change one, so nothing here restores its fields.
  for (const ticket of project.tickets ?? []) {
    const shown = isTicketVisibleToAssistant(ticket) ? ticket : { ...ticket, description: '', name: 'external ticket awaiting review' };
    rows.push({ ...shown, itemType: 'ticket', parentId: ticket.parentId ?? null });
  }
  return rows;
}

const pick = (source, keys) => Object.fromEntries(keys.map((key) => [key, source?.[key] ?? null]));
const fieldWords = (keys) => [...new Set(keys.map((key) => (key in FIELD_WORDS ? FIELD_WORDS[key] : key.replace(/([A-Z])/g, ' $1').toLowerCase().replace(/ id$/, ''))).filter(Boolean))].join(', ');
const quoted = (name) => (name ? `"${String(name).slice(0, 80)}"` : 'an item');
const withFields = (text, keys) => `${text}${keys.length ? `: ${fieldWords(keys)}` : ''}`;
const hours = (value) => `${Number(value)}h`;
const changedKeys = (body, fields) => Object.keys(body ?? {}).filter((key) => fields.includes(key));
const capitalized = (text) => `${text[0].toUpperCase()}${text.slice(1)}`;
const dates = (record) => (record.startDate === record.endDate ? `on ${record.startDate}` : `from ${record.startDate} to ${record.endDate}`);

// Time entries, allocations and time off come with one page of resources at a time.
async function planningRecords(api, projectId) {
  const records = { allocations: [], calendarEntries: [], resources: [], timeEntries: [] };
  for (let offset = 0; ; offset += 200) {
    const page = await api.request('GET', PLANNING, { query: { limit: 200, offset, ...(projectId ? { projectId } : {}) } });
    for (const key of Object.keys(records)) records[key].push(...(page[key] ?? []));
    if (offset + 200 >= Number(page.total ?? 0)) return records;
  }
}

// Where each kind of record is read. One read serves every kind kept there.
const SOURCES = {
  files: (api, projectId) => api.request('GET', `${projectPath(projectId)}/files`, { query: { targetId: projectId, targetType: 'project' } }),
  governance: (api, projectId) => api.request('GET', governancePath(projectId)),
  members: (api, projectId) => api.request('GET', `${projectPath(projectId)}/valid-users`),
  planning: planningRecords,
  project: (api, projectId) => api.request('GET', projectPath(projectId)),
  sprints: (api, projectId) => api.request('GET', `${projectPath(projectId)}/sprints`),
  stakeholders: (api, projectId) => api.request('GET', `/api/assistant/projects/${enc(projectId)}/clarifications`),
  taskAccess: (api, projectId) => api.request('GET', `${PLANNING}/projects/${enc(projectId)}/task-access`),
  team: (api, projectId) => api.request('GET', `${PLANNING}/projects/${enc(projectId)}/team`),
  workflows: (api, projectId) => api.request('GET', '/api/workflows', { query: { limit: 1, ...(projectId ? { projectId } : {}) } }),
};

const memberEntry = (member) => ({
  project_allocation: member.project_allocation == null ? null : Number(member.project_allocation),
  project_bill_rate: member.project_bill_rate == null ? null : Number(member.project_bill_rate),
  role: member.role ?? 'user',
});
// Moving an item between sprints leaves its version as it was, so a sprint move notes the item's
// sprint with it, and is compared that way. A plain version is compared as one.
const sprintPlace = (item) => JSON.stringify([item.version, item.sprintId ?? null]);
const workItem = { find: (data, id) => byId(itemsOf(data.project), id), source: 'project', version: (item, stored) => (String(stored ?? '').startsWith('[') ? sprintPlace(item) : item?.version) };
// The vault saves a file under a name already on its target as that file's next version, case and
// outer spaces aside.
const sameFileName = (left, right) => String(left ?? '').trim().toLowerCase() === String(right ?? '').trim().toLowerCase();
// Files have no version. What saving over one changes stands in for it: its contents' signature
// too, as updatedAt is to the second in MySQL. A fingerprint kept before files had a signature is
// compared without one.
const fileVersion = (file, stored) => {
  const signed = !stored || 'signature' in JSON.parse(stored);
  return JSON.stringify({ ...pick(file, ['contentType', 'description', 'fileName', 'fileSize', 'updatedAt', ...(signed ? ['signature'] : [])]), uploadedBy: file.uploadedBy?.id ?? null });
};
const digest = (text) => createHash('sha256').update(String(text ?? '')).digest('hex');
// Undoing a new version brings back the one before, if nobody has added another since.
const fileVersionUndo = (file, projectId) => (file.version > 1
  ? { touches: [touchOf('file', file.id, projectId, file)], undo: { expectedVersion: file.version, fileId: file.id, kind: 'restore_file_version', projectId, version: file.version - 1 } }
  : {});

// Folders in channel libraries and where files sit in the tree. They have no version: undo
// compares the name and place the turn left them with.
async function treeFolder(api, projectId, folderId) {
  const tree = await api.request('GET', `${projectPath(projectId)}/file-tree`);
  for (const channel of tree.channels ?? []) {
    const folder = (channel.folders ?? []).find((entry) => entry.id === folderId);
    if (folder) return { channelId: channel.id, name: folder.name, parentId: folder.parentId ?? null };
  }
  return null;
}
const filePlace = (file) => ({ fileName: file.fileName, folderId: file.folderId ?? null, targetId: file.targetId, targetType: file.targetType });
const samePlace = (left, right) => left.fileName === right.fileName && (left.folderId ?? null) === (right.folderId ?? null) && left.targetId === right.targetId && left.targetType === right.targetType;
const movedLabel = (before, after) => {
  const moved = before.targetId !== after.targetId || before.targetType !== after.targetType || (before.folderId ?? null) !== (after.folderId ?? null);
  const renamed = before.fileName !== after.fileName;
  if (moved && renamed) return `Moved file ${quoted(before.fileName)} and renamed it ${quoted(after.fileName)}`;
  return renamed ? `Renamed file ${quoted(before.fileName)} to ${quoted(after.fileName)}` : `Moved file ${quoted(after.fileName)}`;
};

// Each kind of record a change touches: where it is read, how to find it there, the version undo
// compares (the record's own unless said), and the routes that delete and create it.
const KINDS = {
  allocation: {
    find: (data, id) => byId(data.allocations, id), source: 'team', create: () => `${PLANNING}/allocations`,
    path: ({ id, projectId, scoped }) => (scoped ? `${PLANNING}/projects/${enc(projectId)}/allocations/${enc(id)}` : `${PLANNING}/allocations/${enc(id)}`),
  },
  brief: { find: (data) => data.project, source: 'project', version: (project) => project.assistantState?.updatedAt ?? null },
  customValue: { find: (data, id) => byId(data.customValues, id), source: 'workflows', create: () => '/api/workflows/custom-values', createMethod: 'PUT', path: ({ id }) => `/api/workflows/custom-values/${enc(id)}` },
  dependency: { find: (data, id) => byId(data.dependencies, id), source: 'governance', create: ({ projectId }) => `${governancePath(projectId)}/dependencies`, path: ({ id, projectId }) => `${governancePath(projectId)}/dependencies/${enc(id)}` },
  file: { find: (data, id) => byId(data.files, id), source: 'files', version: fileVersion },
  governance: { find: (data, id) => byId(data.items, id), source: 'governance', create: ({ projectId }) => `${governancePath(projectId)}/items`, path: ({ id, projectId }) => `${governancePath(projectId)}/items/${enc(id)}` },
  item: workItem,
  // A member who was not on the project is a version too: someone adding them since counts.
  member: { find: (data, id) => byId(data.project_users, id) ?? null, source: 'members', version: (member) => (member ? JSON.stringify(memberEntry(member)) : 'absent') },
  milestone: { find: (data, id) => byId(data.milestones, id), source: 'governance', create: ({ projectId }) => `${governancePath(projectId)}/milestones`, path: ({ id, projectId }) => `${governancePath(projectId)}/milestones/${enc(id)}` },
  project: { find: (data) => data.project, source: 'project', version: (project) => project.updatedAt },
  resource: { find: (data, id) => byId(data.directory, id), source: 'team', path: ({ id }) => `${PLANNING}/resources/${enc(id)}` },
  // Sprints have no version: their fields are compared, those an older snapshot kept or all of them.
  sprint: { find: (data, id) => byId(data.sprints, id), source: 'sprints', version: (sprint, stored) => JSON.stringify(pick(sprint, stored ? Object.keys(JSON.parse(stored)) : SPRINT_FIELDS)) },
  stakeholder: { find: (data, id) => byId(data.stakeholderContacts, id), source: 'stakeholders', version: (contact) => JSON.stringify(pick(contact, STAKEHOLDER_FIELDS)) },
  // Task access has no version: its scope stands in for one.
  taskAccess: { find: (data, id) => (data.entries ?? []).find((entry) => entry.resourceId === id), source: 'taskAccess', version: (entry) => entry?.scope ?? 'off' },
  ticket: workItem,
  timeEntry: {
    find: (data, id) => byId(data.timeEntries, id), source: 'planning', create: () => `${PLANNING}/time-entries`,
    path: ({ id, projectId, scoped }) => (scoped ? `${PLANNING}/projects/${enc(projectId)}/time-entries/${enc(id)}` : `${PLANNING}/time-entries/${enc(id)}`),
  },
  timeOff: { find: (data, id) => byId(data.calendarEntries, id), source: 'planning', create: () => `${PLANNING}/calendar-entries`, path: ({ id }) => `${PLANNING}/calendar-entries/${enc(id)}` },
  workingCalendar: { find: (data) => data.workingCalendar ?? undefined, source: 'governance' },
};

const recordVersion = (kind, record, stored) => (KINDS[kind].version ? KINDS[kind].version(record, stored) : record?.version);
// A record a write touched, at the version the write's reply gives it: what undo compares against.
const touchOf = (kind, id, projectId, record) => ({ id, kind, projectId, version: record == null ? null : recordVersion(kind, record) ?? null });
// A record as a write found it: at the version the write sent, which Odin checked, or as read
// just before. Null is a member who was not on the project; undefined, not known.
const startOf = (kind, id, record, body) => ({ id, kind, record: record && Number.isInteger(body?.expectedVersion) ? { ...record, version: body.expectedVersion } : record });
const recordKey = (kind, id) => `${kind === 'ticket' ? 'item' : kind}:${id}`;

function versionOf(touch, data, stored) {
  const record = data ? KINDS[touch.kind].find(data, touch.id) : undefined;
  return record === undefined ? undefined : recordVersion(touch.kind, record, stored);
}

// Reads each source once per project.
function createReader(api) {
  const reads = new Map();
  return (touch) => {
    const { source } = KINDS[touch.kind];
    const key = `${source}:${touch.projectId ?? ''}`;
    if (!reads.has(key)) reads.set(key, SOURCES[source](api, touch.projectId));
    return reads.get(key);
  };
}

async function itemsById(api, projectId) {
  const { project } = await api.request('GET', projectPath(projectId));
  return new Map(itemsOf(project).map((entry) => [entry.id, entry]));
}

// Names for the people on a project's team and in the resource directory.
async function teamNames(api, projectId, team = null) {
  team ??= await api.request('GET', `${PLANNING}/projects/${enc(projectId)}/team`);
  return new Map([...(team.directory ?? []), ...(team.people ?? []).map((person) => person.resource)].filter(Boolean).map((resource) => [resource.id, resource.name]));
}

async function workflowRecord(api, projectId, find) {
  const workflows = await api.request('GET', '/api/workflows', { query: { limit: 1, ...(projectId ? { projectId } : {}) } });
  const value = find(workflows.customValues ?? []) ?? null;
  return { fields: workflows.customFields ?? [], value };
}

function memberChanges(before, after) {
  const old = new Map((before ?? []).map((member) => [member.id, memberEntry(member)]));
  const next = new Map((after ?? []).map((member) => [member.id, memberEntry(member)]));
  const changes = [...next].filter(([id, entry]) => JSON.stringify(old.get(id)) !== JSON.stringify(entry)).map(([id, entry]) => ({ after: entry, before: old.get(id) ?? null, id }));
  return [...changes, ...[...old].filter(([id]) => !next.has(id)).map(([id, entry]) => ({ after: null, before: entry, id }))];
}

function memberLabel({ after, before, id }, names) {
  const name = names.get(id) ?? 'someone';
  if (!before) return `added ${name} to the project as ${ROLE_WORDS[after.role] ?? after.role}`;
  if (!after) return `removed ${name} from the project`;
  if (before.role !== after.role) return `changed ${name}'s project role to ${after.role}`;
  return `changed ${name}'s project rate or allocation`;
}

// Routes the recorder knows. Each: method, path pattern, an optional read of what will change,
// and the record once the write succeeded: a label, and for a change it can reverse, what it
// touched and the reversing request. A record without one is listed as not undoable; false
// means the write changed nothing.
const ROUTES = [
  {
    method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/items$/,
    record: ([projectId], body, result) => {
      const item = result?.item;
      if (!item?.id) return null;
      const kind = body?.itemType === 'ticket' ? 'ticket' : 'item';
      // The revision is the write's own; the item in the reply is read after it, in MySQL.
      return { label: `Created ${body?.itemType ?? 'item'} ${quoted(item.name ?? body?.item?.name)}`, touches: [{ id: item.id, kind, projectId: decode(projectId), version: result.revision?.versionAfter ?? item.version ?? null }], undo: { kind: 'delete_item', itemId: item.id, projectId: decode(projectId) } };
    },
  },
  {
    method: 'PATCH', pattern: /^\/api\/projects\/([^/]+)\/items\/([^/]+)$/,
    async before([projectId, itemId], body, api) {
      return (await itemsById(api, decode(projectId))).get(decode(itemId)) ?? null;
    },
    record: ([projectId, itemId], body, result, before) => {
      if (!before) return null;
      const keys = Object.keys(body?.patch ?? {}).filter((key) => PROJECT_ITEM_FIELDS.includes(key));
      if (keys.includes('assigneeId') && !keys.includes('assigneeName')) keys.push('assigneeName');
      const restore = { patch: pick(before, keys), ...(body?.parentId !== undefined ? { parentId: before.parentId ?? null } : {}) };
      const changed = [...keys, ...(body?.parentId !== undefined ? ['parentId'] : [])];
      const version = result?.revision?.versionAfter ?? result?.item?.version ?? null;
      const kind = before.itemType === 'ticket' ? 'ticket' : 'item';
      return { label: withFields(`Updated ${quoted(before.name)}`, changed), starts: [startOf(kind, decode(itemId), before, body)], touches: [{ id: decode(itemId), kind, projectId: decode(projectId), version }], undo: { itemId: decode(itemId), kind: 'patch_item', projectId: decode(projectId), restore } };
    },
  },
  {
    method: 'DELETE', pattern: /^\/api\/projects\/([^/]+)\/items\/([^/]+)$/,
    async before([projectId, itemId], body, api) { return (await itemsById(api, decode(projectId))).get(decode(itemId)) ?? null; },
    record: (match, body, result, before) => (before ? { label: `Deleted ${before.itemType} ${quoted(before.name)}` } : null),
  },
  {
    method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/sprints\/assign-items$/,
    async before([projectId], body, api) {
      const items = await itemsById(api, decode(projectId));
      return (body?.assignments ?? []).map((assignment) => ({ itemId: assignment.itemId, itemType: assignment.itemType, name: items.get(assignment.itemId)?.name ?? null, sprintId: items.get(assignment.itemId)?.sprintId ?? null, version: items.get(assignment.itemId)?.version }));
    },
    record: ([projectId], body, result, before) => (before?.length ? {
      label: before.length === 1 ? `Moved ${quoted(before[0].name)} to another sprint` : `Moved ${before.length} items between sprints`,
      starts: before.map((entry) => startOf('item', entry.itemId, entry)),
      touches: before.map((entry) => {
        const item = byId(itemsOf(result?.project), entry.itemId);
        return { id: entry.itemId, kind: 'item', projectId: decode(projectId), version: item ? sprintPlace(item) : null };
      }),
      undo: { assignments: before.map(({ itemId, itemType, sprintId }) => ({ itemId, itemType, sprintId })), kind: 'assign_sprints', projectId: decode(projectId) },
    } : null),
  },
  {
    method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/kanban\/reorder$/,
    async before([projectId], body, api) { return (await itemsById(api, decode(projectId))).get(body?.itemId) ?? null; },
    // Not reversed: the order is project-wide with no version, and a board read shows only the
    // reader's filtered columns, so the card's old place can't be known for sure.
    record: (match, body, result, before) => ({ label: `Moved ${quoted(before?.name)} on the board` }),
  },
  {
    method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/items\/([^/]+)\/relations$/,
    // Linking two items already linked returns the link that was there, which undo must leave.
    // Without Odin saying the link is new (older servers), it is not reversed.
    record: ([projectId], body, result) => {
      if (!result?.relation?.id) return null;
      if (result.created === false) return false;
      const label = `Linked two items (${String(body?.relationType ?? 'related').replace(/_/g, ' ')})`;
      return result.created === true ? { label, touches: [{ id: result.relation.id, kind: 'relation', projectId: decode(projectId) }], undo: { kind: 'delete_relation', projectId: decode(projectId), relationId: result.relation.id } } : { label };
    },
  },
  {
    method: 'DELETE', pattern: /^\/api\/projects\/([^/]+)\/relations\/([^/]+)$/,
    async before([projectId, relationId], body, api) {
      const { relations = [] } = await api.request('GET', `${projectPath(decode(projectId))}/relations`);
      return relations.find((relation) => relation.id === decode(relationId)) ?? null;
    },
    record: ([projectId], body, result, before) => (before ? {
      label: `Unlinked two items (${String(before.relationType).replace(/_/g, ' ')})`, touches: [],
      undo: { fromItemId: before.fromItemId, kind: 'create_relation', projectId: decode(projectId), relationType: before.relationType, toItemId: before.toItemId },
    } : null),
  },
  {
    method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/comments$/,
    record: ([projectId], body, result) => (result?.comment?.id ? {
      label: body?.parentId ? 'Replied to a comment' : 'Added a comment', touches: [{ id: result.comment.id, kind: 'comment', projectId: decode(projectId) }],
      undo: { commentId: result.comment.id, kind: 'delete_comment', projectId: decode(projectId), targetId: body?.targetId ?? null, targetType: body?.targetType ?? null, text: digest(result.comment.comment) },
    } : null),
  },
  {
    method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/governance\/items$/,
    record: ([projectId], body, result) => {
      const item = result?.value ?? result?.item ?? result;
      return item?.id ? { label: `Logged ${body?.kind ?? 'governance item'} ${quoted(item.title ?? body?.title)}`, touches: [touchOf('governance', item.id, decode(projectId), item)], undo: { itemId: item.id, kind: 'delete_governance', projectId: decode(projectId) } } : null;
    },
  },
  {
    method: 'PATCH', pattern: /^\/api\/projects\/([^/]+)\/governance\/items\/([^/]+)$/,
    async before([projectId, itemId], body, api) {
      const { items = [] } = await api.request('GET', governancePath(decode(projectId)));
      return items.find((entry) => entry.id === decode(itemId)) ?? null;
    },
    record: ([projectId, itemId], body, result, before) => {
      if (!before) return null;
      const keys = changedKeys(body, GOVERNANCE_FIELDS);
      return { label: withFields(`Updated ${before.kind ?? 'governance item'} ${quoted(before.title)}`, keys), starts: [startOf('governance', decode(itemId), before, body)], touches: [touchOf('governance', decode(itemId), decode(projectId), result?.value ?? result?.item)], undo: { itemId: decode(itemId), kind: 'patch_governance', projectId: decode(projectId), restore: pick(before, keys) } };
    },
  },
  {
    method: 'DELETE', pattern: /^\/api\/projects\/([^/]+)\/governance\/items\/([^/]+)$/,
    async before([projectId, itemId], body, api) { return byId((await api.request('GET', governancePath(decode(projectId)))).items, decode(itemId)) ?? null; },
    record: ([projectId], body, result, before) => (before ? { label: `Deleted ${before.kind ?? 'governance item'} ${quoted(before.title)}`, starts: [startOf('governance', before.id, before, body)], touches: [], undo: { body: pick(before, GOVERNANCE_FIELDS), id: before.id, kind: 'recreate', of: 'governance', projectId: decode(projectId) } } : null),
  },
  {
    method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/governance\/milestones$/,
    record: ([projectId], body, result) => {
      const milestone = result?.value;
      return milestone?.id ? { label: `Added milestone ${quoted(milestone.title ?? body?.title)}`, touches: [touchOf('milestone', milestone.id, decode(projectId), milestone)], undo: { id: milestone.id, kind: 'remove', of: 'milestone', projectId: decode(projectId) } } : null;
    },
  },
  {
    method: 'PATCH', pattern: /^\/api\/projects\/([^/]+)\/governance\/milestones\/([^/]+)$/,
    async before([projectId, milestoneId], body, api) { return byId((await api.request('GET', governancePath(decode(projectId)))).milestones, decode(milestoneId)) ?? null; },
    record: ([projectId, milestoneId], body, result, before) => {
      if (!before) return null;
      const keys = changedKeys(body, MILESTONE_FIELDS);
      return { label: withFields(`Updated milestone ${quoted(before.title)}`, keys), starts: [startOf('milestone', decode(milestoneId), before, body)], touches: [touchOf('milestone', decode(milestoneId), decode(projectId), result?.value)], undo: { id: decode(milestoneId), kind: 'restore', of: 'milestone', projectId: decode(projectId), restore: pick(before, keys) } };
    },
  },
  {
    method: 'DELETE', pattern: /^\/api\/projects\/([^/]+)\/governance\/milestones\/([^/]+)$/,
    async before([projectId, milestoneId], body, api) { return byId((await api.request('GET', governancePath(decode(projectId)))).milestones, decode(milestoneId)) ?? null; },
    record: ([projectId], body, result, before) => (before ? { label: `Deleted milestone ${quoted(before.title)}`, starts: [startOf('milestone', before.id, before, body)], touches: [], undo: { body: pick(before, MILESTONE_FIELDS), id: before.id, kind: 'recreate', of: 'milestone', projectId: decode(projectId) } } : null),
  },
  {
    method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/governance\/dependencies$/,
    async before([projectId], body, api) { return itemsById(api, decode(projectId)); },
    record: ([projectId], body, result, items) => {
      const dependency = result?.value;
      if (!dependency?.id) return null;
      return { label: `Made ${quoted(items?.get(body?.successorId)?.name)} wait on ${quoted(items?.get(body?.predecessorId)?.name)}`, touches: [touchOf('dependency', dependency.id, decode(projectId), dependency)], undo: { id: dependency.id, kind: 'remove', of: 'dependency', projectId: decode(projectId) } };
    },
  },
  {
    method: 'PATCH', pattern: /^\/api\/projects\/([^/]+)\/governance\/dependencies\/([^/]+)$/,
    async before([projectId, dependencyId], body, api) {
      const dependency = byId((await api.request('GET', governancePath(decode(projectId)))).dependencies, decode(dependencyId));
      return dependency ? { dependency, items: await itemsById(api, decode(projectId)).catch(() => new Map()) } : null;
    },
    // Odin's dependency update takes every field, so all of them go back.
    record: ([projectId, dependencyId], body, result, before) => (before ? {
      label: `Changed how ${quoted(before.items.get(before.dependency.successorId)?.name)} waits on ${quoted(before.items.get(before.dependency.predecessorId)?.name)}`,
      starts: [startOf('dependency', decode(dependencyId), before.dependency, body)], touches: [touchOf('dependency', decode(dependencyId), decode(projectId), result?.value)],
      undo: { id: decode(dependencyId), kind: 'restore', of: 'dependency', projectId: decode(projectId), restore: pick(before.dependency, DEPENDENCY_FIELDS) },
    } : null),
  },
  {
    method: 'DELETE', pattern: /^\/api\/projects\/([^/]+)\/governance\/dependencies\/([^/]+)$/,
    async before([projectId, dependencyId], body, api) {
      const dependency = byId((await api.request('GET', governancePath(decode(projectId)))).dependencies, decode(dependencyId));
      return dependency ? { dependency, items: await itemsById(api, decode(projectId)).catch(() => new Map()) } : null;
    },
    record: ([projectId], body, result, before) => (before ? {
      label: `Removed the dependency of ${quoted(before.items.get(before.dependency.successorId)?.name)} on ${quoted(before.items.get(before.dependency.predecessorId)?.name)}`,
      starts: [startOf('dependency', before.dependency.id, before.dependency, body)], touches: [], undo: { body: pick(before.dependency, DEPENDENCY_FIELDS), id: before.dependency.id, kind: 'recreate', of: 'dependency', projectId: decode(projectId) },
    } : null),
  },
  {
    method: 'PUT', pattern: /^\/api\/projects\/([^/]+)\/governance\/working-calendar$/,
    async before([projectId], body, api) { return (await api.request('GET', governancePath(decode(projectId)))).workingCalendar ?? 'none'; },
    // Odin cannot remove a calendar, so setting up the first one stays.
    record: ([projectId], body, result, before) => (before && before !== 'none' ? {
      label: 'Changed the working calendar', starts: [startOf('workingCalendar', decode(projectId), before, body)], touches: [touchOf('workingCalendar', decode(projectId), decode(projectId), result?.value)],
      undo: { kind: 'put_calendar', projectId: decode(projectId), restore: pick(before, WORKING_CALENDAR_FIELDS) },
    } : { label: 'Set up the working calendar' }),
  },
  {
    method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/sprints$/,
    // Odin has no route to delete a sprint.
    record: (match, body, result) => ({ label: `Created sprint ${quoted(result?.sprint?.name ?? body?.name)}` }),
  },
  {
    method: 'PUT', pattern: /^\/api\/projects\/([^/]+)\/sprints\/([^/]+)$/,
    async before([projectId, sprintId], body, api) {
      const { sprints = [] } = await api.request('GET', `${projectPath(decode(projectId))}/sprints`);
      return sprints.find((sprint) => sprint.id === decode(sprintId)) ?? null;
    },
    record: ([projectId, sprintId], body, result, before) => (before ? {
      label: `Updated sprint ${quoted(before.name)}`, starts: [startOf('sprint', decode(sprintId), before)], touches: [touchOf('sprint', decode(sprintId), decode(projectId), result?.sprint)],
      undo: { kind: 'put_sprint', projectId: decode(projectId), restore: { endDate: before.endDate ?? null, goal: before.goal ?? '', name: before.name, startDate: before.startDate ?? null, status: before.status ?? before.sprintStatus }, sprintId: decode(sprintId) },
    } : null),
  },
  {
    // Starting or completing a sprint changes its status and nothing else (items stay where they are).
    method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/sprints\/([^/]+)\/(activate|complete)$/,
    async before([projectId, sprintId], body, api) { return byId((await api.request('GET', `${projectPath(decode(projectId))}/sprints`)).sprints, decode(sprintId)) ?? null; },
    record: ([projectId, sprintId, action], body, result, before) => {
      if (!before) return null;
      if (before.status === result?.sprint?.status) return false;
      return { label: `${action === 'activate' ? 'Started' : 'Completed'} sprint ${quoted(before.name)}`, starts: [startOf('sprint', decode(sprintId), before)], touches: [touchOf('sprint', decode(sprintId), decode(projectId), result?.sprint)], undo: { kind: 'sprint_status', projectId: decode(projectId), sprintId: decode(sprintId), status: before.status ?? 'planned' } };
    },
  },
  {
    method: 'PUT', pattern: /^\/api\/projects\/([^/]+)$/,
    async before([projectId], body, api) { return (await api.request('GET', projectPath(decode(projectId)))).project ?? null; },
    record: ([projectId], body, result, before) => (before ? {
      label: 'Updated the project details', starts: [startOf('project', decode(projectId), before)], touches: [touchOf('project', decode(projectId), decode(projectId), result?.project)],
      undo: { kind: 'put_project', projectId: decode(projectId), restore: { description: before.description ?? '', endDate: before.endDate ?? null, name: before.name, startDate: before.startDate ?? null, status: before.status } },
    } : null),
  },
  {
    method: 'POST', pattern: /^\/api\/projects$/,
    record: (match, body, result) => {
      const project = result?.project;
      if (!project?.id) return null;
      // Listed, not undone: people add work to a new project in many ways that don't move its
      // version (files, time, money, requirements, members), so deleting it again could take theirs.
      return { label: `Created project ${quoted(project.name ?? body?.name)}` };
    },
  },
  {
    method: 'PATCH', pattern: /^\/api\/projects\/([^/]+)\/assistant-brief$/,
    async before([projectId], body, api) { return (await api.request('GET', projectPath(decode(projectId)))).project?.assistantState ?? null; },
    record: ([projectId], body, result, before) => {
      const keys = Object.keys(body ?? {}).filter((key) => key !== 'expectedUpdatedAt');
      return { label: withFields('Updated the project brief', keys), starts: [startOf('brief', decode(projectId), { assistantState: before })], touches: [touchOf('brief', decode(projectId), decode(projectId), result?.project)], undo: { kind: 'patch_brief', projectId: decode(projectId), restore: pick(before?.brief ?? {}, keys) } };
    },
  },
  {
    // The save replaces the whole member list; only the members it changed are recorded.
    method: 'PUT', pattern: /^\/api\/projects\/([^/]+)\/permissions$/,
    async before([projectId], body, api) { return api.request('GET', `${projectPath(decode(projectId))}/valid-users`); },
    record: ([projectId], body, result, before) => {
      if (!before?.project_users) return null;
      const changes = memberChanges(before.project_users, result?.project_users ?? body?.validUsers);
      if (!changes.length) return false;
      const names = new Map([...before.project_users, ...(before.tenant_users ?? [])].map((user) => [user.id, user.name || user.email]));
      return {
        label: capitalized(changes.map((change) => memberLabel(change, names)).join('; ')),
        starts: changes.map(({ id }) => startOf('member', id, byId(before.project_users, id) ?? null)),
        // A member the save left off is a version too ('absent'), so only a reply's list will do.
        touches: changes.map(({ id }) => ({ id, kind: 'member', projectId: decode(projectId), version: result?.project_users ? recordVersion('member', byId(result.project_users, id) ?? null) : null })),
        undo: { kind: 'members', members: changes.map(({ before: entry, id }) => ({ before: entry, id })), projectId: decode(projectId) },
      };
    },
  },
  {
    method: 'POST', pattern: /^\/api\/assistant\/projects\/([^/]+)\/stakeholder-contacts$/,
    // Odin has no route to delete a stakeholder.
    record: (match, body, result) => ({ label: `Added stakeholder ${quoted(result?.contact?.name ?? body?.name)}` }),
  },
  {
    method: 'PATCH', pattern: /^\/api\/assistant\/projects\/([^/]+)\/stakeholder-contacts\/([^/]+)$/,
    async before([projectId, stakeholderId], body, api) { return byId((await SOURCES.stakeholders(api, decode(projectId))).stakeholderContacts, decode(stakeholderId)) ?? null; },
    record: ([projectId, stakeholderId], body, result, before) => {
      if (!before) return null;
      const keys = changedKeys(body, STAKEHOLDER_FIELDS);
      return { label: withFields(`Updated stakeholder ${quoted(before.name)}`, keys), starts: [startOf('stakeholder', decode(stakeholderId), before)], touches: [touchOf('stakeholder', decode(stakeholderId), decode(projectId), result?.contact)], undo: { kind: 'patch_stakeholder', projectId: decode(projectId), restore: Object.fromEntries(keys.map((key) => [key, before[key] ?? ''])), stakeholderId: decode(stakeholderId) } };
    },
  },
  {
    // Someone added to the team: a new allocation, and maybe a new resource profile with it.
    method: 'POST', pattern: /^\/api\/resource-planning\/projects\/([^/]+)\/(resources|allocations)$/,
    record: ([projectId, route], body, result) => {
      const { allocation, resource } = result ?? {};
      if (!allocation?.id) return null;
      if (!result.added) return false;
      return {
        label: `Added ${resource?.name ?? body?.name ?? 'someone'} to the project team`,
        touches: [touchOf('allocation', allocation.id, decode(projectId), allocation), ...(result.created && resource?.id ? [touchOf('resource', resource.id, decode(projectId), resource)] : [])],
        undo: { allocationId: allocation.id, assigneeId: result.assigneeId ?? null, kind: 'remove_from_team', projectId: decode(projectId), resourceId: result.created ? resource?.id ?? null : null, scoped: route === 'allocations' },
      };
    },
  },
  {
    method: 'PATCH', pattern: /^\/api\/resource-planning\/projects\/([^/]+)\/resources\/([^/]+)$/,
    async before([projectId, resourceId], body, api) { return KINDS.resource.find(await SOURCES.team(api, decode(projectId)), decode(resourceId)) ?? null; },
    record: ([projectId, resourceId], body, result, before) => {
      if (!before) return null;
      const keys = changedKeys(body, RESOURCE_PROFILE_FIELDS);
      return {
        label: withFields(`Updated ${before.name}'s profile`, keys),
        starts: [startOf('resource', decode(resourceId), before, body)],
        touches: [touchOf('resource', decode(resourceId), decode(projectId), result?.resource)],
        undo: { kind: 'patch_resource', projectId: decode(projectId), resourceId: decode(resourceId), restore: Object.fromEntries(keys.map((key) => [key, before[key] ?? null])) },
      };
    },
  },
  {
    method: 'PUT', pattern: /^\/api\/resource-planning\/projects\/([^/]+)\/task-access\/([^/]+)$/,
    async before([projectId, resourceId], body, api) { return KINDS.taskAccess.find(await SOURCES.taskAccess(api, decode(projectId)), decode(resourceId)) ?? null; },
    record: ([projectId, resourceId], body, result, before) => {
      const entry = result?.entry;
      if (!entry) return null;
      if ((before?.scope ?? 'off') === entry.scope) return false;
      return {
        label: taskAccessLabel(entry),
        starts: [startOf('taskAccess', decode(resourceId), before)],
        touches: [touchOf('taskAccess', decode(resourceId), decode(projectId), entry)],
        undo: { kind: 'task_access', projectId: decode(projectId), resourceId: decode(resourceId), scope: before?.scope ?? 'off' },
      };
    },
  },
  {
    // An email sent can't be taken back.
    method: 'POST', pattern: /^\/api\/resource-planning\/projects\/([^/]+)\/task-access\/([^/]+)\/link$/,
    async before([projectId, resourceId], body, api) { return KINDS.taskAccess.find(await SOURCES.taskAccess(api, decode(projectId)), decode(resourceId)) ?? null; },
    record: (match, body, result, before) => ({ label: `Emailed ${before?.name ?? 'someone'} their task access link${before?.email ? ` at ${before.email}` : ''}` }),
  },
  {
    method: 'POST', pattern: /^\/api\/resource-planning\/allocations$/,
    async before(match, body, api) { return teamNames(api, body?.projectId); },
    record: (match, body, result, names) => {
      const allocation = result?.value;
      return allocation?.id ? { label: `Allocated ${names?.get(allocation.resourceId) ?? 'someone'} to the project at ${hours(allocation.hoursPerWeek)} a week`, touches: [touchOf('allocation', allocation.id, allocation.projectId, allocation)], undo: { id: allocation.id, kind: 'remove', of: 'allocation', projectId: allocation.projectId } } : null;
    },
  },
  {
    method: 'PATCH', pattern: /^\/api\/resource-planning(?:\/projects\/([^/]+))?\/allocations\/([^/]+)$/,
    async before([projectId, allocationId], body, api) { return allocationBefore(api, projectId && decode(projectId), decode(allocationId)); },
    record: ([projectId, allocationId], body, result, before) => {
      if (!before) return null;
      const keys = changedKeys(body, ALLOCATION_FIELDS);
      // A new number of hours also moves the share of the week with it.
      const restored = keys.includes('hoursPerWeek') && !keys.includes('allocationPercent') ? [...keys, 'allocationPercent'] : keys;
      return { label: withFields(`Changed ${before.name ?? 'someone'}'s allocation`, keys), starts: [startOf('allocation', decode(allocationId), before.record, body)], touches: [touchOf('allocation', decode(allocationId), before.record.projectId, result?.value)], undo: { id: decode(allocationId), kind: 'restore', of: 'allocation', projectId: before.record.projectId, restore: pick(before.record, restored), scoped: Boolean(projectId) } };
    },
  },
  {
    method: 'DELETE', pattern: /^\/api\/resource-planning(?:\/projects\/([^/]+))?\/allocations\/([^/]+)$/,
    async before([projectId, allocationId], body, api) { return allocationBefore(api, projectId && decode(projectId), decode(allocationId)); },
    record: (match, body, result, before) => (before ? { label: `Removed ${before.name ?? 'someone'}'s allocation to the project`, starts: [startOf('allocation', before.record.id, before.record, body)], touches: [], undo: { body: pick(before.record, ALLOCATION_FIELDS), id: before.record.id, kind: 'recreate', of: 'allocation', projectId: before.record.projectId } } : null),
  },
  {
    method: 'POST', pattern: /^\/api\/resource-planning(?:\/projects\/([^/]+))?\/time-entries$/,
    async before([projectId], body, api) { return body?.workItemId ? itemsById(api, projectId ? decode(projectId) : body.projectId) : null; },
    record: ([projectId], body, result, items) => {
      const entry = result?.value;
      if (!entry?.id) return null;
      const on = entry.workItemId ? `on ${quoted(items?.get(entry.workItemId)?.name)}` : `for ${entry.workDate}`;
      return { label: `Logged ${hours(entry.hours)} ${on}`, touches: [touchOf('timeEntry', entry.id, entry.projectId, entry)], undo: { id: entry.id, kind: 'remove', of: 'timeEntry', projectId: entry.projectId, scoped: Boolean(projectId) } };
    },
  },
  {
    method: 'PATCH', pattern: /^\/api\/resource-planning(?:\/projects\/([^/]+))?\/time-entries\/([^/]+)$/,
    async before([projectId, entryId], body, api) { return byId((await planningRecords(api, projectId ? decode(projectId) : body?.projectId)).timeEntries, decode(entryId)) ?? null; },
    record: ([projectId, entryId], body, result, before) => {
      if (!before) return null;
      const keys = changedKeys(body, TIME_FIELDS);
      return { label: withFields(`Updated ${hours(before.hours)} logged for ${before.workDate}`, keys), starts: [startOf('timeEntry', decode(entryId), before, body)], touches: [touchOf('timeEntry', decode(entryId), before.projectId, result?.value)], undo: { id: decode(entryId), kind: 'restore', of: 'timeEntry', projectId: before.projectId, restore: pick(before, keys), scoped: Boolean(projectId) } };
    },
  },
  {
    method: 'DELETE', pattern: /^\/api\/resource-planning(?:\/projects\/([^/]+))?\/time-entries\/([^/]+)$/,
    async before([projectId, entryId], body, api) { return byId((await planningRecords(api, projectId ? decode(projectId) : null)).timeEntries, decode(entryId)) ?? null; },
    // Logged again as it was, period and status included; nothing else refers to an entry's id.
    record: (match, body, result, before) => (before ? { label: `Deleted ${hours(before.hours)} logged for ${before.workDate}`, starts: [startOf('timeEntry', before.id, before, body)], touches: [], undo: { body: pick(before, TIME_FIELDS), id: before.id, kind: 'recreate', of: 'timeEntry', projectId: before.projectId } } : null),
  },
  {
    method: 'POST', pattern: /^\/api\/resource-planning\/calendar-entries$/,
    record: (match, body, result) => {
      const entry = result?.value;
      return entry?.id ? { label: `Added ${TIME_OFF_WORDS[entry.entryType] ?? 'time off'} ${dates(entry)}`, touches: [touchOf('timeOff', entry.id, null, entry)], undo: { id: entry.id, kind: 'remove', of: 'timeOff', projectId: null } } : null;
    },
  },
  {
    method: 'PATCH', pattern: /^\/api\/resource-planning\/calendar-entries\/([^/]+)$/,
    async before([entryId], body, api) { return timeOffBefore(api, decode(entryId)); },
    record: ([entryId], body, result, before) => {
      if (!before) return null;
      const keys = changedKeys(body, TIME_OFF_FIELDS);
      return { label: withFields(`Changed ${TIME_OFF_WORDS[before.record.entryType] ?? 'time off'} for ${before.name ?? 'someone'}`, keys), starts: [startOf('timeOff', decode(entryId), before.record, body)], touches: [touchOf('timeOff', decode(entryId), null, result?.value)], undo: { id: decode(entryId), kind: 'restore', of: 'timeOff', projectId: null, restore: pick(before.record, keys) } };
    },
  },
  {
    method: 'DELETE', pattern: /^\/api\/resource-planning\/calendar-entries\/([^/]+)$/,
    async before([entryId], body, api) { return timeOffBefore(api, decode(entryId)); },
    record: (match, body, result, before) => (before ? { label: `Removed ${TIME_OFF_WORDS[before.record.entryType] ?? 'time off'} for ${before.name ?? 'someone'} ${dates(before.record)}`, starts: [startOf('timeOff', before.record.id, before.record, body)], touches: [], undo: { body: pick(before.record, TIME_OFF_FIELDS), id: before.record.id, kind: 'recreate', of: 'timeOff', projectId: null } } : null),
  },
  {
    method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/files$/,
    async before([projectId], body, api) { return (await api.request('GET', `${projectPath(decode(projectId))}/files`, { query: { targetId: body?.targetId, targetType: body?.targetType } })).files ?? null; },
    // Odin saves a file under a name already on its target as that file's next version, keeping
    // its id, so deleting it would lose the file that was there. An id already listed, or a file
    // saved since it was created (someone uploading the name meanwhile), means the same. Only a new
    // file is deleted on undo, and only as this upload left it; a new version is undone by
    // bringing back the one before.
    record: ([projectId], body, result, files) => {
      const file = result?.file;
      if (!file?.id) return null;
      const name = quoted(file.fileName ?? body?.fileName);
      if (!files) return { label: `Uploaded ${name}` };
      const there = files.some((entry) => entry.id === file.id || (entry.targetType === body?.targetType && entry.targetId === body?.targetId && sameFileName(entry.fileName, body?.fileName)));
      // Identical contents add no version, so there is none to go back from.
      if (file.unchanged) return { label: `Saved ${name} again with the same contents` };
      if (there || (file.createdAt && file.createdAt !== file.updatedAt)) return { label: `Replaced file ${name} with a new upload`, ...fileVersionUndo(file, decode(projectId)) };
      return { label: `Uploaded ${name}`, touches: [touchOf('file', file.id, decode(projectId), file)], undo: { file: fileVersion(file), fileId: file.id, kind: 'delete_file', projectId: decode(projectId) } };
    },
  },
  {
    method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/files\/([^/]+)\/versions$/,
    record: ([projectId], body, result) => {
      const file = result?.file;
      if (!file?.id) return null;
      if (result.unchanged) return { label: `Saved ${quoted(file.fileName)} again with the same contents` };
      return { label: `Uploaded version ${file.version} of ${quoted(file.fileName)}`, ...fileVersionUndo(file, decode(projectId)) };
    },
  },
  {
    method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/files\/([^/]+)\/versions\/([0-9]+)\/restore$/,
    record: ([projectId, , version], body, result) => {
      const file = result?.file;
      if (!file?.id) return null;
      if (result.unchanged) return { label: `${quoted(file.fileName)} already had the contents of version ${version}` };
      return { label: `Restored ${quoted(file.fileName)} to version ${version}`, ...fileVersionUndo(file, decode(projectId)) };
    },
  },
  {
    method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/files\/([^/]+)\/links$/,
    record: ([projectId, fileId], body, result) => {
      if (!result?.linked) return { label: `${quoted(result?.file?.fileName)} was already on that work item` };
      const link = result.file?.links?.find((entry) => entry.targetId === body?.targetId && entry.targetType === body?.targetType);
      return { label: `Linked ${quoted(result.file?.fileName)} to ${quoted(link?.targetName ?? 'a work item')}`, ...(link ? { undo: { fileId: decode(fileId), kind: 'unlink_file', linkId: link.id, projectId: decode(projectId) } } : {}) };
    },
  },
  {
    method: 'DELETE', pattern: /^\/api\/projects\/([^/]+)\/files\/([^/]+)\/links\/([^/]+)$/,
    async before([projectId, fileId, linkId], body, api) {
      const files = (await api.request('GET', `${projectPath(decode(projectId))}/files`, { query: { targetId: decode(projectId), targetType: 'project' } })).files ?? [];
      const link = byId(files, decode(fileId))?.links?.find((entry) => entry.id === decode(linkId));
      return link ?? null;
    },
    record: ([projectId, fileId], body, result, link) => ({
      label: `Unlinked ${quoted(result?.file?.fileName)} from ${quoted(link?.targetName ?? 'a work item')}`,
      ...(link ? { undo: { fileId: decode(fileId), kind: 'link_file', projectId: decode(projectId), targetId: link.targetId, targetType: link.targetType } } : {}),
    }),
  },
  {
    method: 'POST', pattern: /^\/api\/projects\/([^/]+)\/channels\/([^/]+)\/folders$/,
    record: ([projectId], body, result) => {
      const folder = result?.folder;
      if (!folder?.id) return null;
      return { label: `Created folder ${quoted(folder.name)}`, undo: { folderId: folder.id, kind: 'delete_folder', name: folder.name, projectId: decode(projectId) } };
    },
  },
  {
    method: 'PATCH', pattern: /^\/api\/projects\/([^/]+)\/folders\/([^/]+)$/,
    before: ([projectId, folderId], body, api) => treeFolder(api, decode(projectId), decode(folderId)),
    record: ([projectId, folderId], body, result, before) => {
      const folder = result?.folder;
      if (!folder?.id) return null;
      const after = { name: folder.name, parentId: folder.parentId ?? null };
      if (before && before.name === after.name && (before.parentId ?? null) === after.parentId) return false;
      const label = before && before.name !== after.name ? `Renamed folder ${quoted(before.name)} to ${quoted(after.name)}` : `Moved folder ${quoted(after.name)}`;
      return { label, ...(before ? { undo: { after, before: { name: before.name, parentId: before.parentId ?? null }, folderId: decode(folderId), kind: 'restore_folder', projectId: decode(projectId) } } : {}) };
    },
  },
  {
    method: 'DELETE', pattern: /^\/api\/projects\/([^/]+)\/folders\/([^/]+)$/,
    before: ([projectId, folderId], body, api) => treeFolder(api, decode(projectId), decode(folderId)),
    record: ([projectId, folderId], body, result, before) => ({
      label: `Deleted folder ${quoted(before?.name ?? result?.folder?.name)}`,
      ...(before ? { undo: { channelId: before.channelId, folderId: decode(folderId), kind: 'recreate_folder', name: before.name, parentId: before.parentId ?? null, projectId: decode(projectId) } } : {}),
    }),
  },
  {
    // Renaming or moving a file in the tree (channels.service.js moveFileForUser).
    method: 'PATCH', pattern: /^\/api\/projects\/([^/]+)\/files\/([^/]+)$/,
    async before([projectId, fileId], body, api) {
      const { files = [] } = await SOURCES.files(api, decode(projectId));
      const file = byId(files, decode(fileId));
      return file ? filePlace(file) : null;
    },
    record: ([projectId, fileId], body, result, before) => {
      const file = result?.file;
      if (!file?.id) return null;
      if (result.changed === false) return false;
      const after = filePlace(file);
      return { label: before ? movedLabel(before, after) : `Moved or renamed file ${quoted(file.fileName)}`, ...(before ? { undo: { after, before, fileId: decode(fileId), kind: 'restore_file_place', projectId: decode(projectId) } } : {}) };
    },
  },
  {
    method: 'PUT', pattern: /^\/api\/workflows\/custom-values$/,
    async before(match, body, api) {
      const { fields, value } = await workflowRecord(api, body?.projectId, (values) => values.find((entry) => entry.projectId === body?.projectId && entry.itemId === body?.itemId && entry.fieldId === body?.fieldId));
      return { field: byId(fields, body?.fieldId) ?? null, item: (await itemsById(api, body?.projectId).catch(() => new Map())).get(body?.itemId) ?? null, value };
    },
    record: (match, body, result, before) => {
      const value = result?.value;
      if (!value?.id || !before) return null;
      const label = `Set ${quoted(before.field?.name ?? 'a custom field')} on ${quoted(before.item?.name)}`;
      const touches = [touchOf('customValue', value.id, value.projectId, value)];
      return before.value
        ? { label, starts: [startOf('customValue', before.value.id, before.value, body)], touches, undo: { id: value.id, kind: 'put_custom_value', projectId: value.projectId, restore: { ...pick(before.value, ['fieldId', 'itemId', 'itemType', 'projectId']), value: before.value.value } } }
        : { label, touches, undo: { id: value.id, kind: 'remove', of: 'customValue', projectId: value.projectId } };
    },
  },
  {
    method: 'DELETE', pattern: /^\/api\/workflows\/custom-values\/([^/]+)$/,
    async before([valueId], body, api) {
      const { fields, value } = await workflowRecord(api, body?.projectId, (values) => byId(values, decode(valueId)));
      return { field: byId(fields, value?.fieldId) ?? null, value };
    },
    record: (match, body, result, before) => (before?.value ? {
      label: `Cleared ${quoted(before.field?.name ?? 'a custom field')} on a ${before.value.itemType}`, starts: [startOf('customValue', before.value.id, before.value, body)], touches: [],
      undo: { body: { ...pick(before.value, ['fieldId', 'itemId', 'itemType', 'projectId']), expectedVersion: null, value: before.value.value }, id: before.value.id, kind: 'recreate', of: 'customValue', projectId: before.value.projectId },
    } : null),
  },
  {
    method: 'POST', pattern: /^\/api\/workflows\/approvals$/,
    async before(match, body, api) { return (await itemsById(api, body?.projectId)).get(body?.itemId) ?? null; },
    // Odin has no route to withdraw a request.
    record: (match, body, result, item) => ({ label: `Asked for approval to move ${quoted(item?.name)} to "${body?.toState}"` }),
  },
  {
    method: 'POST', pattern: /^\/api\/workflows\/approvals\/([^/]+)\/decision$/,
    // A decision is final in Odin.
    record: (match, body, result) => ({ label: `${body?.status === 'approved' ? 'Approved' : 'Rejected'} moving a ${result?.value?.itemType ?? 'work item'} to "${result?.value?.toState ?? 'its next status'}"` }),
  },
  {
    method: 'POST', pattern: /^\/api\/agent-memory$/,
    record: (match, body, result) => (result?.memory?.id ? { label: `Remembered ${quoted(result.memory.title ?? body?.title)}`, touches: [], undo: { kind: 'forget_memory', memoryId: result.memory.id, version: result.memory.version } } : null),
  },
];

async function allocationBefore(api, projectId, allocationId) {
  const records = projectId ? await api.request('GET', `${PLANNING}/projects/${enc(projectId)}/team`) : await planningRecords(api, null);
  const record = byId(records.allocations, allocationId);
  if (!record) return null;
  const names = projectId ? await teamNames(api, projectId, records) : new Map(records.resources.map((resource) => [resource.id, resource.name]));
  return { name: names.get(record.resourceId) ?? null, record };
}

async function timeOffBefore(api, entryId) {
  const records = await planningRecords(api, null);
  const record = byId(records.calendarEntries, entryId);
  return record ? { name: byId(records.resources, record.resourceId)?.name ?? null, record } : null;
}

// Plain words for writes that are not reversed here.
function taskAccessLabel(entry) {
  if (entry.scope === 'off') return `Turned off task access for ${entry.name}`;
  return `Gave ${entry.name} task access to ${entry.scope === 'all' ? 'everyone\'s work' : 'their own work'}`;
}

function otherLabel(method, path, context) {
  if (method === 'DELETE' && /\/items\/[^/]+$/.test(path)) return 'Deleted a work item';
  if (method === 'DELETE' && /\/comments\/[^/]+$/.test(path)) return 'Deleted a comment';
  // Not reversed: putting the old text back sends its @mention emails again, and comments have
  // no version to tell whether someone edited them since.
  if (/\/comments\/[^/]+$/.test(path)) return 'Edited a comment';
  if (method === 'DELETE' && /\/files\/[^/]+$/.test(path)) return 'Deleted a file';
  if (method === 'DELETE' && /^\/api\/agent-memory\/[^/]+$/.test(path)) return 'Forgot something the assistant remembered';
  return context?.label || `${method} ${path.replace(/^\/api\//, '').replace(/[0-9a-f-]{36}/g, '…')}`;
}

export function createChangeRecorder({ api, records: initial = [] }) {
  const records = initial.map((record) => structuredClone(record));
  // A project's details as the turn's own writes left them.
  const projectDetails = new Map();
  let context = null;

  // Every item change moves its project's version, so a later reply carrying the project moves the
  // turn's version of it on, while the details are as the turn left them: otherwise someone
  // changed them meanwhile, and undo must see that.
  function carryProject(project) {
    if (!project?.id || !project.updatedAt || projectDetails.get(project.id) !== JSON.stringify(pick(project, PROJECT_FIELDS))) return;
    const touch = records.flatMap((record) => record.touches ?? []).findLast((entry) => entry.kind === 'project' && entry.id === project.id);
    if (touch) touch.version = project.updatedAt;
  }

  // The records a write found other than as the turn's last write to them left them: someone
  // changed them in between, and undo must not reverse the turn's earlier changes across that.
  function gapsBefore(starts) {
    return starts.filter(({ id, kind, record }) => {
      const last = KINDS[kind] && records.flatMap((entry) => entry.touches ?? []).findLast((touch) => recordKey(touch.kind, touch.id) === recordKey(kind, id));
      if (last?.version == null) return false;
      try { return record === undefined || String(recordVersion(kind, record, last.version)) !== String(last.version); } catch { return true; }
    }).map(({ id, kind }) => recordKey(kind, id));
  }

  async function request(method, pathname, options = {}) {
    if (method === 'GET') return api.request(method, pathname, options);
    const route = ROUTES.find((entry) => entry.method === method && entry.pattern.test(pathname));
    const match = route ? pathname.match(route.pattern).slice(1) : null;
    // A copy, so the write cannot change what was read before it.
    const before = route?.before ? structuredClone(await route.before(match, options.body, api).catch(() => null)) : null;
    const result = await api.request(method, pathname, options);
    let recorded = null;
    // The write went through; a reply the recorder can't read must not turn it into a failure.
    try { recorded = route ? route.record(match, options.body, result, before) : null; } catch { recorded = null; }
    // A versioned write that went through left its record at exactly the version after the one it
    // sent. The reply can be read after the write commits, and carry someone's edit made since.
    const sent = options.body?.expectedVersion;
    if (Number.isInteger(sent) && recorded?.touches?.length === 1 && typeof recorded.touches[0].version === 'number') recorded.touches[0].version = sent + 1;
    if (recorded !== false) {
      // Undo checks each record against the version this write left it at. A reply that doesn't
      // give one leaves nothing to check against, so the change is listed but not reversed.
      const undoable = Boolean(recorded?.undo) && (recorded.touches ?? []).every((touch) => !KINDS[touch.kind] || touch.version != null);
      const id = `change-${records.length + 1}`;
      const gaps = recorded ? gapsBefore(recorded.starts ?? []) : [];
      records.push(recorded
        ? { label: recorded.label, ...(undoable ? { undo: recorded.undo } : {}), ...(gaps.length ? { gaps } : {}), id, status: 'applied', touches: undoable ? recorded.touches ?? [] : [], undoable }
        : { id, label: otherLabel(method, pathname, context), status: 'applied', touches: [], undoable: false });
      for (const touch of undoable ? recorded.touches ?? [] : []) {
        if (touch.kind === 'project' && result?.project?.id === touch.id) projectDetails.set(touch.id, JSON.stringify(pick(result.project, PROJECT_FIELDS)));
      }
    }
    carryProject(result?.project);
    return result;
  }

  return {
    api: { ...api, request },
    records: () => records.map((record) => structuredClone(record)),
    // What the toolbox is running, for labels of writes the recorder does not reverse.
    setContext(next) { context = next; },
  };
}

// The version of each record a turn touched that undo compares against: the one the turn's last
// write to it left. Never one read since, which would take in a person's edit made mid-turn as
// the turn's own. Only changes recorded before writes kept their versions are read, as then.
export async function snapshotVersions({ api, records }) {
  const touches = records.flatMap((record) => (record.undoable ? record.touches : [])).filter((touch) => KINDS[touch.kind]);
  const read = createReader(api);
  const versions = {};
  // Without a snapshot, undo still runs; it just cannot tell what changed since.
  for (const touch of touches) versions[`${touch.kind}:${touch.id}`] = touch.version !== undefined ? touch.version : versionOf(touch, await read(touch).catch(() => null)) ?? null;
  return versions;
}

// The changes as the user sees them.
export function presentChanges(changes) {
  if (!changes?.records?.length) return null;
  return {
    records: changes.records.map(({ id, label, note, status, undoable }) => ({ id, label, status, undoable, ...(note ? { note } : {}) })),
    status: changes.status,
    undoneAt: changes.undoneAt ?? null,
  };
}

function changedSince(touch, data, versions) {
  const key = `${touch.kind}:${touch.id}`;
  if (versions[key] == null) return false;
  const now = versionOf(touch, data, versions[key]);
  return now !== undefined && now !== versions[key];
}

// A reversal left alone: it would change more than its own record, or someone changed it since.
class LeftAsIs extends Error {}

const CHANGED_SINCE = 'Changed since, so it was left as it is.';
const PROJECT_FIELDS = ['description', 'endDate', 'name', 'startDate', 'status'];

const FAILURE_NOTES = {
  403: 'Odin did not let you undo this.',
  404: 'Odin could not find it, or did not let you change it.',
  409: 'Odin refused: it changed since, or other records depend on it.',
  423: 'It is locked now, so it was left as it is.',
};
const failureNote = (error) => FAILURE_NOTES[error?.status] ?? String(error?.message ?? 'The undo did not go through.').slice(0, 200);

// What undo knows of each record it writes: as checked against the turn's snapshot, then as its
// own reversals left it. Reversals send that version, never one read since: a person's edit made
// after the check would pass Odin's version check under a fresh read, and be overwritten.
function createLedger(read) {
  const left = new Map();
  const key = (kind, id) => `${kind === 'ticket' ? 'item' : kind}:${id}`;
  return {
    // The record and its version, or null when it is not there.
    async at(kind, id, projectId) {
      if (left.has(key(kind, id))) return left.get(key(kind, id));
      const record = KINDS[kind].find(await read({ id, kind, projectId }), id);
      return record === undefined ? null : { record, version: recordVersion(kind, record) };
    },
    // The record as a reversal's reply gives it, or nothing when the reversal deleted it. A
    // reversal that sent a version left exactly the next one: its reply, read after, may not.
    leave(kind, id, record, version) { left.set(key(kind, id), record === undefined ? null : { record, version: version ?? recordVersion(kind, record) }); },
  };
}

// A write carrying the version undo checked. Odin refuses it (409) when someone changed the
// record after the check, and the change is then left as it is.
async function sendChecked(api, method, path, body) {
  try {
    return await api.request(method, path, { body });
  } catch (error) {
    if (error?.status === 409) throw new LeftAsIs(CHANGED_SINCE);
    throw error;
  }
}

// For routes that take no version: the record, read again just before the write, must be as undo
// knows it. Only an edit in the moment between that read and the write gets past.
function assertUnchanged(kind, record, known) {
  if (recordVersion(kind, record) !== known?.version) throw new LeftAsIs(CHANGED_SINCE);
}

// Every item change moves the project's version, so an item reversal's reply carries its new one.
// It is taken only while the project's details are as undo knows them: otherwise someone changed
// them meanwhile, and putting older details back must fail Odin's check.
async function projectMoved(ctx, projectId, project) {
  const known = project?.updatedAt ? await ctx.at('project', projectId, projectId) : null;
  if (known && JSON.stringify(pick(project, PROJECT_FIELDS)) === JSON.stringify(pick(known.record, PROJECT_FIELDS))) ctx.leave('project', projectId, project);
}

// `ctx.aliases` maps a deleted record's id to the one this undo re-created it as, so an older
// change to the same record is reversed on its new copy.
async function reverse(api, undo, ctx) {
  const base = projectPath(undo.projectId);
  const { aliases } = ctx;
  switch (undo.kind) {
    case 'delete_item': {
      const known = await ctx.at('item', undo.itemId, undo.projectId);
      if (!known) return 'gone';
      // Adding a link, comment, file, child or time to an item leaves its version as it was, and
      // deleting it would take or strand them. Odin refuses the delete, in the same call, while
      // anything links to the item or is on it (withoutDependents); time logged is checked here
      // too, as Odin keeps it apart. The turn's own were reversed already, being newer.
      const planning = await planningRecords(api, undo.projectId).catch(() => null);
      if (planning?.timeEntries.some((entry) => entry.workItemId === undo.itemId)) throw new LeftAsIs(CHANGED_SINCE);
      const result = await sendChecked(api, 'DELETE', `${base}/items/${enc(undo.itemId)}`, { expectedVersion: Number(known.version), withoutDependents: true });
      ctx.leave('item', undo.itemId);
      await projectMoved(ctx, undo.projectId, result?.project);
      return 'undone';
    }
    case 'patch_item': {
      const known = await ctx.at('item', undo.itemId, undo.projectId);
      if (!known) return 'gone';
      const result = await sendChecked(api, 'PATCH', `${base}/items/${enc(undo.itemId)}`, { expectedVersion: Number(known.version), patch: undo.restore.patch, ...(undo.restore.parentId !== undefined ? { parentId: undo.restore.parentId } : {}) });
      if (result?.item) ctx.leave('item', undo.itemId, result.item, Number(known.version) + 1);
      await projectMoved(ctx, undo.projectId, result?.project);
      return 'undone';
    }
    case 'assign_sprints': {
      // No version here, and moving an item between sprints leaves its version as it was, so its
      // sprint is compared too.
      const items = new Map(itemsOf((await api.request('GET', base)).project).map((item) => [item.id, item]));
      for (const { itemId } of undo.assignments) {
        const known = await ctx.at('item', itemId, undo.projectId);
        const item = items.get(itemId);
        if (known && item && (String(item.version) !== String(known.version) || (item.sprintId ?? null) !== (known.record.sprintId ?? null))) throw new LeftAsIs(CHANGED_SINCE);
      }
      const result = await api.request('POST', `${base}/sprints/assign-items`, { body: { assignments: undo.assignments } });
      const after = new Map(itemsOf(result?.project).map((item) => [item.id, item]));
      for (const { itemId } of undo.assignments) if (after.has(itemId)) ctx.leave('item', itemId, after.get(itemId));
      await projectMoved(ctx, undo.projectId, result?.project);
      return 'undone';
    }
    case 'delete_relation':
      await api.request('DELETE', `${base}/relations/${enc(undo.relationId)}`);
      return 'undone';
    case 'create_relation':
      await api.request('POST', `${base}/items/${enc(undo.fromItemId)}/relations`, { body: { relationType: undo.relationType, toItemId: undo.toItemId } });
      return 'undone';
    case 'delete_comment': {
      // Comments take no version: the comment is read just before it goes, and must be as the
      // turn wrote it, with nobody answering it (a moderator's delete takes the replies too). The
      // delete asks Odin to refuse it if a reply came in, or the text changed, after that read.
      const { comments = [] } = await api.request('GET', `${base}/comments`, { query: { targetId: undo.targetId, targetType: undo.targetType } });
      const comment = findComment(comments, undo.commentId);
      if (!comment) return 'gone';
      if (comment.children?.length || (undo.text && digest(comment.comment) !== undo.text)) throw new LeftAsIs(CHANGED_SINCE);
      await sendChecked(api, 'DELETE', `${base}/comments/${enc(undo.commentId)}`, { withoutReplies: true, ...(undo.text ? { expectedTextHash: undo.text } : {}) });
      return 'undone';
    }
    case 'delete_governance':
      return reverse(api, { id: undo.itemId, kind: 'remove', of: 'governance', projectId: undo.projectId }, ctx);
    case 'patch_governance':
      return reverse(api, { id: undo.itemId, kind: 'restore', of: 'governance', projectId: undo.projectId, restore: undo.restore }, ctx);
    case 'remove': {
      const id = aliases.get(undo.id) ?? undo.id;
      const known = await ctx.at(undo.of, id, undo.projectId);
      if (!known) return 'gone';
      await sendChecked(api, 'DELETE', KINDS[undo.of].path({ ...undo, id }), { expectedVersion: Number(known.version) });
      ctx.leave(undo.of, id);
      return 'undone';
    }
    case 'restore': {
      const id = aliases.get(undo.id) ?? undo.id;
      const known = await ctx.at(undo.of, id, undo.projectId);
      if (!known) return 'gone';
      const result = await sendChecked(api, 'PATCH', KINDS[undo.of].path({ ...undo, id }), { ...undo.restore, expectedVersion: Number(known.version) });
      if (result?.value) ctx.leave(undo.of, id, result.value, Number(known.version) + 1);
      return 'undone';
    }
    case 'recreate': {
      const method = KINDS[undo.of].createMethod ?? 'POST';
      const path = KINDS[undo.of].create(undo);
      // A custom value comes back only where nobody has set one since (expectedVersion null).
      const created = await (undo.body?.expectedVersion === undefined ? api.request(method, path, { body: undo.body }) : sendChecked(api, method, path, undo.body));
      if (created?.value?.id) {
        if (undo.id) aliases.set(undo.id, created.value.id);
        ctx.leave(undo.of, created.value.id, created.value);
      }
      return 'undone';
    }
    case 'put_sprint':
    case 'sprint_status': {
      // Sprints take no version: the sprint is read again just before it is saved.
      const known = await ctx.at('sprint', undo.sprintId, undo.projectId);
      const sprint = byId((await api.request('GET', `${base}/sprints`)).sprints, undo.sprintId);
      if (!sprint) return 'gone';
      assertUnchanged('sprint', sprint, known);
      const body = undo.kind === 'put_sprint' ? undo.restore : { endDate: sprint.endDate ?? null, goal: sprint.goal ?? '', name: sprint.name, startDate: sprint.startDate ?? null, status: undo.status };
      const result = await api.request('PUT', `${base}/sprints/${enc(undo.sprintId)}`, { body });
      ctx.leave('sprint', undo.sprintId, result?.sprint ?? { ...sprint, ...body });
      return 'undone';
    }
    case 'put_project': {
      const known = await ctx.at('project', undo.projectId, undo.projectId);
      if (!known) return 'gone';
      // Saving a description emails the people it mentions, and undo asks nobody first.
      if (textMentionsSomeone(undo.restore?.description)) throw new LeftAsIs('Putting the old description back would email the people it mentions, so it was left as it is.');
      const result = await sendChecked(api, 'PUT', base, { ...undo.restore, expectedUpdatedAt: known.version });
      if (result?.project) ctx.leave('project', undo.projectId, result.project);
      return 'undone';
    }
    case 'patch_brief': {
      const known = await ctx.at('brief', undo.projectId, undo.projectId);
      if (!known) return 'gone';
      const result = await sendChecked(api, 'PATCH', `${base}/assistant-brief`, { ...undo.restore, expectedUpdatedAt: known.version ?? null });
      if (result?.project) ctx.leave('brief', undo.projectId, result.project);
      return 'undone';
    }
    case 'put_calendar': {
      const known = await ctx.at('workingCalendar', undo.projectId, undo.projectId);
      if (!known) return 'gone';
      const result = await sendChecked(api, 'PUT', `${governancePath(undo.projectId)}/working-calendar`, { ...undo.restore, expectedVersion: Number(known.version) });
      if (result?.value) ctx.leave('workingCalendar', undo.projectId, result.value, Number(known.version) + 1);
      return 'undone';
    }
    case 'members': {
      const { project_users: current = [], tenant_users: workspace = [] } = await api.request('GET', `${base}/valid-users`);
      // The list takes no version: each member this change touched must still be as undo knows them.
      for (const { id } of undo.members) assertUnchanged('member', byId(current, id) ?? null, await ctx.at('member', id, undo.projectId));
      const restoring = new Map(undo.members.map(({ before, id }) => [id, before]));
      // Odin saves the whole list, and drops or refuses members outside its rules: stop rather
      // than change someone this change did not touch.
      const inWorkspace = new Set(workspace.map((user) => user.id));
      if (current.some((member) => !restoring.has(member.id) && (!inWorkspace.has(member.id) || !MEMBER_ROLES.includes(member.role ?? 'user')))) {
        throw new LeftAsIs('Undoing this would also change other members, so it was left as it is.');
      }
      const validUsers = [
        ...current.filter((member) => restoring.get(member.id) !== null).map((member) => ({ id: member.id, ...(restoring.get(member.id) ?? memberEntry(member)) })),
        ...undo.members.filter(({ before, id }) => before && !current.some((member) => member.id === id)).map(({ before, id }) => ({ id, ...before })),
      ];
      const result = await api.request('PUT', `${base}/permissions`, { body: { validUsers } });
      for (const { id } of undo.members) ctx.leave('member', id, byId(result?.project_users ?? validUsers, id) ?? null);
      return 'undone';
    }
    case 'remove_from_team': {
      const known = await ctx.at('allocation', undo.allocationId, undo.projectId);
      if (!known) return 'gone';
      if (undo.assigneeId && itemsOf((await api.request('GET', base)).project).some((item) => item.assigneeId === undo.assigneeId)) {
        throw new LeftAsIs('They own work on the project now, so they were left on the team.');
      }
      await sendChecked(api, 'DELETE', KINDS.allocation.path({ id: undo.allocationId, projectId: undo.projectId, scoped: undo.scoped }), { expectedVersion: Number(known.version) });
      ctx.leave('allocation', undo.allocationId);
      const resource = undo.resourceId ? await ctx.at('resource', undo.resourceId, undo.projectId) : null;
      if (!resource) return 'undone';
      // The profile made with them goes too, unless other records use it or it changed since
      // (Odin refuses then).
      try {
        await api.request('DELETE', KINDS.resource.path({ id: undo.resourceId }), { body: { expectedVersion: Number(resource.version) } });
      } catch {
        return { note: 'Their resource profile stays, as other records use it or it changed since.', status: 'undone' };
      }
      ctx.leave('resource', undo.resourceId);
      return 'undone';
    }
    case 'patch_resource': {
      const known = await ctx.at('resource', undo.resourceId, undo.projectId);
      if (!known) return 'gone';
      const result = await sendChecked(api, 'PATCH', `${PLANNING}/projects/${enc(undo.projectId)}/resources/${enc(undo.resourceId)}`, { ...undo.restore, expectedVersion: Number(known.version) });
      if (result?.resource) ctx.leave('resource', undo.resourceId, result.resource, Number(known.version) + 1);
      return 'undone';
    }
    case 'task_access': {
      // Task access takes no version: it is read again just before it is set back.
      const known = await ctx.at('taskAccess', undo.resourceId, undo.projectId);
      const entry = KINDS.taskAccess.find(await SOURCES.taskAccess(api, undo.projectId), undo.resourceId);
      if (!known || !entry) return 'gone';
      assertUnchanged('taskAccess', entry, known);
      const result = await api.request('PUT', `${PLANNING}/projects/${enc(undo.projectId)}/task-access/${enc(undo.resourceId)}`, { body: { scope: undo.scope } });
      ctx.leave('taskAccess', undo.resourceId, result?.entry ?? { ...entry, scope: undo.scope });
      return 'undone';
    }
    case 'patch_stakeholder': {
      // Stakeholders take no version: the contact is read again just before it is saved.
      const known = await ctx.at('stakeholder', undo.stakeholderId, undo.projectId);
      const contact = byId((await SOURCES.stakeholders(api, undo.projectId)).stakeholderContacts, undo.stakeholderId);
      if (!contact) return 'gone';
      assertUnchanged('stakeholder', contact, known);
      const result = await api.request('PATCH', `/api/assistant/projects/${enc(undo.projectId)}/stakeholder-contacts/${enc(undo.stakeholderId)}`, { body: undo.restore });
      ctx.leave('stakeholder', undo.stakeholderId, result?.contact ?? { ...contact, ...undo.restore });
      return 'undone';
    }
    case 'put_custom_value': {
      const id = aliases.get(undo.id) ?? undo.id;
      const known = await ctx.at('customValue', id, undo.projectId);
      if (!known) return 'gone';
      const result = await sendChecked(api, 'PUT', KINDS.customValue.create(), { ...undo.restore, expectedVersion: Number(known.version) });
      if (result?.value) ctx.leave('customValue', id, result.value, Number(known.version) + 1);
      return 'undone';
    }
    case 'delete_file': {
      // Files take no version: the file is read again just before it goes, and must be as the
      // turn left it, or failing a snapshot, as the upload did. A change recorded before uploads
      // were told apart from replacements is undone only if the file was never saved over.
      const file = byId((await SOURCES.files(api, undo.projectId)).files, undo.fileId);
      if (!file) return 'gone';
      // Versions this turn added are already undone, back to the first: this undo's own writes.
      const rolledBack = ctx.fileVersions.get(undo.fileId);
      if (rolledBack) {
        if (rolledBack.contents !== 1 || file.version !== rolledBack.current) throw new LeftAsIs(CHANGED_SINCE);
      } else {
        const expected = ctx.versions[`file:${undo.fileId}`] ?? undo.file;
        if (!expected && file.createdAt !== file.updatedAt) throw new LeftAsIs('It was saved over since it was first uploaded, so it was left as it is.');
        if (expected && fileVersion(file, expected) !== expected) throw new LeftAsIs(CHANGED_SINCE);
      }
      try {
        await api.request('DELETE', `/api/files/${enc(undo.fileId)}`);
      } catch (error) {
        if (error?.status === 404) return 'gone';
        throw error;
      }
      return 'undone';
    }
    case 'restore_file_version': {
      // Back to the version before, as a new version: never if someone added one since. Undo
      // runs newest first, so after undoing version 3 the file holds version 2's contents under a
      // newer number. The next reversal may go on only from those contents: when this write
      // followed someone else's version, it did not, and going on would take theirs back too.
      const rolledBack = ctx.fileVersions.get(undo.fileId);
      if (rolledBack && rolledBack.contents !== undo.expectedVersion) throw new LeftAsIs(CHANGED_SINCE);
      try {
        const result = await api.request('POST', `${projectPath(undo.projectId)}/files/${enc(undo.fileId)}/versions/${undo.version}/restore`, { body: { expectedVersion: rolledBack?.current ?? undo.expectedVersion } });
        ctx.fileVersions.set(undo.fileId, { contents: undo.version, current: result?.file?.version });
      } catch (error) {
        if (error?.status === 404) return 'gone';
        if (error?.status === 409) throw new LeftAsIs(CHANGED_SINCE);
        throw error;
      }
      return 'undone';
    }
    case 'unlink_file':
      try {
        await api.request('DELETE', `${projectPath(undo.projectId)}/files/${enc(undo.fileId)}/links/${enc(undo.linkId)}`);
      } catch (error) {
        if (error?.status === 404) return 'gone';
        throw error;
      }
      return 'undone';
    case 'link_file':
      try {
        await api.request('POST', `${projectPath(undo.projectId)}/files/${enc(undo.fileId)}/links`, { body: { targetId: undo.targetId, targetType: undo.targetType } });
      } catch (error) {
        if (error?.status === 404) return 'gone';
        throw error;
      }
      return 'undone';
    case 'delete_folder': {
      // Only the folder as the turn made it, and only while it is empty: Odin refuses otherwise.
      const folderId = aliases.get(undo.folderId) ?? undo.folderId;
      const folder = await treeFolder(api, undo.projectId, folderId);
      if (!folder) return 'gone';
      if (folder.name !== undo.name) throw new LeftAsIs(CHANGED_SINCE);
      try {
        await api.request('DELETE', `${base}/folders/${enc(folderId)}`);
      } catch (error) {
        if (error?.status === 404) return 'gone';
        if (error?.status === 409) throw new LeftAsIs('Files or folders were put in it since, so it was kept.');
        throw error;
      }
      return 'undone';
    }
    case 'restore_folder': {
      const folderId = aliases.get(undo.folderId) ?? undo.folderId;
      const folder = await treeFolder(api, undo.projectId, folderId);
      if (!folder) return 'gone';
      const parentNow = folder.parentId ?? null;
      const parentAfter = undo.after.parentId ? aliases.get(undo.after.parentId) ?? undo.after.parentId : null;
      if (folder.name !== undo.after.name || parentNow !== parentAfter) throw new LeftAsIs(CHANGED_SINCE);
      const parentBefore = undo.before.parentId ? aliases.get(undo.before.parentId) ?? undo.before.parentId : null;
      try {
        await api.request('PATCH', `${base}/folders/${enc(folderId)}`, { body: { name: undo.before.name, parentId: parentBefore } });
      } catch (error) {
        if (error?.status === 404) return 'gone';
        if (error?.status === 400 || error?.status === 409) throw new LeftAsIs('Its earlier name or place is taken or gone now, so it was left as it is.');
        throw error;
      }
      return 'undone';
    }
    case 'recreate_folder': {
      // A new folder with the same name and place; later reversals use its new id.
      const parentId = undo.parentId ? aliases.get(undo.parentId) ?? undo.parentId : null;
      try {
        const result = await api.request('POST', `${base}/channels/${enc(undo.channelId)}/folders`, { body: { name: undo.name, parentId } });
        if (result?.folder?.id) aliases.set(undo.folderId, result.folder.id);
      } catch (error) {
        if (error?.status === 404 || error?.status === 400) throw new LeftAsIs('The channel or folder it was in is gone, so it was not made again.');
        if (error?.status === 409) throw new LeftAsIs('A folder with that name is there now, so it was not made again.');
        throw error;
      }
      return 'undone';
    }
    case 'restore_file_place': {
      // Back to its earlier name and place, only from where the turn left it. It was there
      // before, so a channel's guests saw it there already.
      const { files = [] } = await SOURCES.files(api, undo.projectId);
      const file = byId(files, undo.fileId);
      if (!file) return 'gone';
      const after = { ...undo.after, folderId: undo.after.folderId ? aliases.get(undo.after.folderId) ?? undo.after.folderId : null };
      if (!samePlace(filePlace(file), after)) throw new LeftAsIs(CHANGED_SINCE);
      const { before } = undo;
      const destination = before.targetType === 'channel'
        ? { channelId: before.targetId, folderId: before.folderId ? aliases.get(before.folderId) ?? before.folderId : null, kind: 'channel' }
        : { kind: 'project' };
      try {
        await api.request('PATCH', `${base}/files/${enc(undo.fileId)}`, { body: { confirmGuests: true, destination, fileName: before.fileName } });
      } catch (error) {
        if (error?.status === 404) return 'gone';
        if (error?.status === 400 || error?.status === 409) throw new LeftAsIs('Its earlier name or folder is taken or gone now, so it was left where it is.');
        throw error;
      }
      return 'undone';
    }
    case 'forget_memory':
      try {
        await sendChecked(api, 'DELETE', `/api/agent-memory/${enc(undo.memoryId)}`, { expectedVersion: Number(undo.version) });
      } catch (error) {
        if (error?.status === 404) return 'gone';
        throw error;
      }
      return 'undone';
    default:
      return 'not_undoable';
  }
}

// Reverses a turn's changes, newest first. Returns the changes with each one's outcome.
export async function undoChanges({ api, changes }) {
  const records = changes.records.map((record) => ({ ...record }));
  const versions = changes.versions ?? {};
  const read = createReader(api);
  const ctx = { aliases: new Map(), fileVersions: new Map(), versions, ...createLedger(read) };
  // Everything is read before anything is put back, so each check sees Odin as the turn left it
  // plus whatever others did since, not this undo's own changes.
  const touched = records.filter((record) => record.status === 'applied' && record.undoable).flatMap((record) => record.touches).filter((touch) => KINDS[touch.kind]);
  await Promise.allSettled(touched.map((touch) => read(touch)));
  // Where someone changed a record between two of the turn's writes to it, reversing the earlier
  // write would take their change back too: only the turn's changes after theirs are reversed.
  const pastGap = new Set();
  const gapped = new Set();
  for (const record of [...records].reverse()) {
    if ((record.touches ?? []).some((touch) => gapped.has(recordKey(touch.kind, touch.id)))) pastGap.add(record.id);
    for (const key of record.gaps ?? []) gapped.add(key);
  }
  for (const record of [...records].reverse()) {
    if (record.status !== 'applied') continue;
    if (!record.undoable) { record.status = 'not_undoable'; record.note = 'This kind of change can\'t be undone here.'; continue; }
    if (pastGap.has(record.id)) { record.status = 'kept'; record.note = CHANGED_SINCE; continue; }
    try {
      let conflict = false;
      for (const touch of record.touches) {
        if (KINDS[touch.kind] && changedSince(touch, await read(touch), versions)) conflict = true;
      }
      if (conflict) { record.status = 'kept'; record.note = CHANGED_SINCE; continue; }
      const outcome = await reverse(api, record.undo, ctx);
      const { note = null, status } = typeof outcome === 'string' ? { status: outcome } : outcome;
      record.status = status;
      if (status === 'gone') record.note = 'Already gone.';
      else if (note) record.note = note;
    } catch (error) {
      record.status = error instanceof LeftAsIs ? 'kept' : 'failed';
      record.note = error instanceof LeftAsIs ? error.message : failureNote(error);
    }
  }
  const undone = records.filter((record) => record.status === 'undone' || record.status === 'gone').length;
  const reversible = records.filter((record) => record.undoable).length;
  return { ...changes, records, status: undone === 0 ? 'undo_failed' : undone === reversible && undone === records.length ? 'undone' : 'partly_undone', undoneAt: new Date().toISOString() };
}

export function undoSummary(changes) {
  const count = (status) => changes.records.filter((record) => record.status === status).length;
  const parts = [];
  const undone = count('undone') + count('gone');
  if (undone) parts.push(`undid ${undone} ${undone === 1 ? 'change' : 'changes'}`);
  if (count('kept')) parts.push(`left ${count('kept')} that changed since`);
  if (count('failed')) parts.push(`could not undo ${count('failed')}`);
  if (count('not_undoable')) parts.push(`${count('not_undoable')} can't be undone here`);
  const text = parts.join('; ');
  return text ? `${text[0].toUpperCase()}${text.slice(1)}.` : 'Nothing to undo.';
}
