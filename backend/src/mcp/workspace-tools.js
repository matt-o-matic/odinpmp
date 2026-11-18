import { z } from 'zod';
import { OdinApiError } from './api-client.js';
import { buildProjectOverview, compactItem, flattenProjectItems, isDoneStatus } from './project-overview.js';
import {
  dependencyCreateSchema, governanceItemCreateSchema, milestoneCreateSchema, scheduleBaselineCreateSchema, workingCalendarWriteSchema,
} from '../modules/governance/governance.schema.js';
import { normalizeWorkingCalendar } from '../modules/governance/schedule-analysis.js';
import { INSIGHTS_DAY_OPTIONS } from '../modules/insights/insights.schema.js';
import { TICKET_CATEGORIES, TICKET_SEVERITIES } from '../modules/projects/projects.schema.js';
import { collectWorkItemDescriptionCoverageGaps } from '../lib/agent/work-item-quality.js';
import { isTicketVisibleToAssistant } from '../modules/assistant/assistant-ticket-visibility.js';

// Higher-level tools for the in-app assistant, most of them shared with MCP clients. Each one runs
// through Odin's REST routes as the signed-in user, like every catalog tool, but does the
// multi-step bookkeeping itself (versions, parent types, name lookups), so a mid-tier model can do
// in one call what would otherwise take several error-prone ones.

const projectPath = (projectId) => `/api/projects/${encodeURIComponent(projectId)}`;
const today = () => new Date().toISOString().slice(0, 10);
const AGENT_VISIBLE_REVIEW_STATES = ['not_external', 'validated'];
const LOOKS_LIKE_ID = /^(?:resource:)?[A-Za-z0-9_-]{8,}$/;
const CHILD_TYPE = { root: 'epic', epic: 'story', story: 'task' };

function truncate(value = '', max = 400) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// A story or epic given an assignee takes its open work along: the tasks under a story, and the
// stories and tasks under an epic, that had the parent's assignee or none. Work listed in the call,
// done, or someone else's keeps its own. Unassigning a parent leaves the work under it alone.
export function followingAssignees(updates, items) {
  const listed = new Set(updates.map((update) => update.itemId));
  const children = new Map();
  for (const item of items.values()) if (item.parentId) children.set(item.parentId, [...(children.get(item.parentId) ?? []), item]);
  const followers = [];
  for (const update of updates) {
    const parent = items.get(update.itemId);
    const assignee = update.patch?.assignee;
    if (!parent || !['epic', 'story'].includes(parent.itemType) || assignee == null || assignee === '') continue;
    const previous = parent.assigneeId || null;
    // Only work under a child that follows can follow too: a story kept by someone else keeps its tasks.
    const queue = [...(children.get(parent.id) ?? [])];
    while (queue.length) {
      const child = queue.shift();
      const owner = child.assigneeId || null;
      if (listed.has(child.id) || isDoneStatus(child.status) || (owner && owner !== previous)) continue;
      listed.add(child.id);
      followers.push({ followed: parent.id, itemId: child.id, patch: { assignee } });
      queue.push(...(children.get(child.id) ?? []));
    }
  }
  return followers;
}

// Keeps large API payloads readable for a model: bounded arrays, strings and depth, and no tenant ids.
export function compactPayload(value, { depth = 0, maxArray = 30, maxDepth = 5, maxString = 500 } = {}) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return truncate(value, maxString);
  if (depth >= maxDepth) return Array.isArray(value) ? `[${value.length} items]` : '[object]';
  if (Array.isArray(value)) {
    const items = value.slice(0, maxArray).map((entry) => compactPayload(entry, { depth: depth + 1, maxArray, maxDepth, maxString }));
    return value.length > maxArray ? [...items, `…${value.length - maxArray} more`] : items;
  }
  if (value instanceof Map) return compactPayload(Object.fromEntries(value), { depth, maxArray, maxDepth, maxString });
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'tenantId').map(([key, entry]) => [key, compactPayload(entry, { depth: depth + 1, maxArray, maxDepth, maxString })]));
}

// The API client keeps only the status of Odin's refusals. Say what each status means for the
// call and what to do next; the tools' own errors (codes other than http_<status>) pass through.
async function explained(run, messages) {
  try {
    return await run();
  } catch (error) {
    const entry = error instanceof OdinApiError && error.code === `http_${error.status}` ? messages[error.status] : null;
    if (!entry) throw error;
    throw new OdinApiError(error.status, entry[0], entry[1], { outcomeUnknown: error.outcomeUnknown });
  }
}

const GOVERNANCE_WRITE_ERRORS = {
  404: ['http_404', 'Project or record not found, or the user cannot change this project\'s governance: that takes plan-edit access to the project.'],
  409: ['version_conflict', 'Someone changed this record since it was read. Read it again with odin_get_governance and retry only if the change still makes sense.'],
};
const plain = ({ tenantId: _tenantId, projectId: _projectId, ...record } = {}) => record;
// Governance routes answer { ok, value }; older fakes and callers answer with the record itself.
const recordOf = (result, key) => result?.value ?? result?.[key] ?? result;
const presentCalendar = (calendar) => (calendar
  ? { holidays: calendar.holidays ?? [], hoursPerDay: calendar.hoursPerDay, timezone: calendar.timezone, updatedAt: calendar.updatedAt ?? null, version: calendar.version, workingDays: calendar.workingDays }
  : { ...normalizeWorkingCalendar(null), isDefault: true, version: null });
const presentBaseline = (baseline = {}) => ({
  id: baseline.id, name: baseline.name, note: baseline.note ?? '', capturedAt: baseline.capturedAt ?? null, createdBy: baseline.createdBy ?? null,
  covers: { dependencies: baseline.snapshot?.dependencies?.length ?? 0, items: baseline.snapshot?.items?.length ?? 0, milestones: baseline.snapshot?.milestones?.length ?? 0 },
});
// A create schema's fields as a patch: each optional and without its default, since a patch changes
// only what it names.
const patchOf = (schema) => z.object(Object.fromEntries(Object.entries(schema.shape).map(([key, field]) => [key, (field instanceof z.ZodDefault ? field.removeDefault() : field).optional()]))).strict();
const sameLink = (left, right) => left.predecessorId === right.predecessorId && left.successorId === right.successorId && left.dependencyType === right.dependencyType;
// A project's items by id, each with its place among its siblings (position), which is what an
// item update's position sets.
function itemsWithPositions(project) {
  const counts = new Map();
  return new Map(flattenProjectItems(project).map((item) => {
    const siblings = `${item.itemType}:${item.parentId ?? ''}`;
    const position = counts.get(siblings) ?? 0;
    counts.set(siblings, position + 1);
    return [item.id, { ...item, position }];
  }));
}
// The fields an item update sets (its parent and position included) that changed between two
// reads of the item, leaving out any that already hold the value the update wants.
const sameValue = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
function changedFields(before, after, { parentId, patch, position }) {
  const wanted = { ...patch, ...(parentId ? { parentId } : {}), ...(position !== undefined ? { position } : {}) };
  return Object.keys(wanted).filter((field) => !sameValue(before[field], after[field]) && !sameValue(after[field], wanted[field]));
}

// A revision as the fields it changed, rather than two full copies of the item.
const REVISION_NOISE = new Set(['stories', 'tasks', 'tenantId', 'updatedAt', 'version']);
function presentRevision(revision) {
  const before = revision.before?.node ?? null;
  const after = revision.after?.node ?? null;
  const base = { id: revision.id, action: revision.action, at: revision.createdAt, by: revision.actorUserId || null, versionBefore: revision.versionBefore ?? null, versionAfter: revision.versionAfter ?? null };
  if (!before || !after) {
    const node = after ?? before ?? {};
    return { ...base, item: { name: node.name ?? null, status: node.status ?? null, assignee: node.assigneeName || null } };
  }
  const changes = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!REVISION_NOISE.has(key) && JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null)) changes[key] = { from: before[key] ?? null, to: after[key] ?? null };
  }
  if ((revision.before.parentId ?? null) !== (revision.after.parentId ?? null)) changes.parentId = { from: revision.before.parentId ?? null, to: revision.after.parentId ?? null };
  return { ...base, changes };
}

const itemFields = {
  name: z.string().trim().min(1).max(200),
  description: z.string().max(5000).optional().describe('Markdown. Stories: user story, acceptance criteria, business rules. Epics: summary, outcome, scope, out of scope, success criteria.'),
  status: z.string().trim().min(1).max(80).optional(),
  priority: z.number().int().min(1).max(7).optional().describe('1 is highest, 7 lowest, 4 normal.'),
  points: z.number().int().min(0).max(999).nullable().optional(),
  targetHourEstimate: z.number().int().min(0).max(100000).nullable().optional(),
  targetStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  targetEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  assignee: z.string().trim().max(200).nullable().optional().describe('Person who owns the item: a userId, resource:<id>, name or email of a project member or allocated resource. null clears it.'),
  sprintId: z.string().trim().max(120).nullable().optional(),
};
const taskNode = z.object(itemFields).strict();
const storyNode = z.object({ ...itemFields, children: z.array(taskNode).max(40).optional().describe('Tasks under this story.') }).strict();
const epicNode = z.object({ ...itemFields, children: z.array(storyNode).max(40).optional().describe('Stories under this epic, each with optional task children.') }).strict();

export function registerWorkspaceTools({ api, dryRun, extended = true, id, tool: register }) {
  // The assistant gets every tool here; MCP clients only those registered with { mcp: true }, whose
  // routes are allowed in access/workspace.js. Memory stays with the assistant.
  const tool = (name, description, schema, handler, options = {}) => {
    if (extended || options.mcp) register(name, description, schema, handler, options);
  };
  // Pursuit work is read on an engagement (`auto`), or on any project with `include`: by item id,
  // or when asked for the Pursuit board (lib/projects/pursuit.js, PURSUIT_READS). Sprint planning
  // reads delivery work only.
  async function readProject(projectId, pursuit = 'auto') {
    const { project } = await api.request('GET', projectPath(projectId), { query: { pursuit } });
    return project;
  }
  async function readSprints(projectId) {
    return (await api.request('GET', `${projectPath(projectId)}/sprints`).catch(() => ({ sprints: [] }))).sprints ?? [];
  }

  // Resolves a person given as an id, resource:<id>, name or email to an assignee id. Project
  // people (members, allocated resources, current owners) win over other workspace users, who
  // can also own work: assigning one gives them a resource allocation on the project.
  async function assigneeResolver(projectId) {
    let tiers = null;
    async function load() {
      if (tiers) return tiers;
      const [members, team, project, pursuitBoard] = await Promise.all([
        api.request('GET', `${projectPath(projectId)}/valid-users`).catch(() => ({ project_users: [], tenant_users: [] })),
        api.request('GET', `/api/resource-planning/projects/${encodeURIComponent(projectId)}/team`).catch(() => ({ people: [] })),
        readProject(projectId).catch(() => null),
        // The engagement's guests and stakeholders, whom a pursuit task is often for.
        api.request('GET', `${projectPath(projectId)}/pursuit`).catch(() => ({ outsideAssignees: [] })),
      ]);
      const owners = project ? flattenProjectItems(project).filter((item) => item.assigneeId && item.assigneeName).map((item) => ({ email: '', id: item.assigneeId, name: item.assigneeName })) : [];
      tiers = [
        [
          ...(members.project_users ?? []).map((user) => ({ email: user.email ?? '', id: user.id, name: user.name ?? '' })),
          ...(team.people ?? []).filter((person) => person.assigneeId && person.resource).map((person) => ({ email: '', id: person.assigneeId, name: person.resource.name ?? '' })),
          ...owners,
          ...(pursuitBoard.outsideAssignees ?? []).map((person) => ({ email: '', id: person.id, name: person.name ?? '' })),
        ],
        (members.tenant_users ?? []).map((user) => ({ email: user.email ?? '', id: user.id, name: user.name ?? '' })),
      ];
      return tiers;
    }
    const matches = (list, lower) => {
      const exact = list.filter((person) => person.name.toLowerCase() === lower || person.email.toLowerCase() === lower);
      const found = exact.length ? exact : list.filter((person) => person.name.toLowerCase().includes(lower));
      return [...new Map(found.map((person) => [person.id, person])).values()];
    };
    return async (value) => {
      if (value === undefined) return undefined;
      if (value === null || value === '') return null;
      const text = String(value).trim();
      if (LOOKS_LIKE_ID.test(text) && !text.includes(' ')) return text;
      const lower = text.toLowerCase();
      for (const list of await load()) {
        const unique = matches(list, lower);
        if (unique.length === 1) return unique[0].id;
        if (unique.length > 1) throw new OdinApiError(400, 'assignee_ambiguous', `"${text}" matches ${unique.map((person) => person.name).join(', ')}. Use one of their ids.`);
      }
      throw new OdinApiError(400, 'assignee_not_found', `No one in this workspace matches "${text}". Use odin_get_project_team to see who can own work.`);
    };
  }

  function qualityNotes(itemType, item) {
    if (!['epic', 'story'].includes(itemType)) return [];
    return collectWorkItemDescriptionCoverageGaps(itemType, item.description ?? '').slice(0, 6);
  }

  tool('odin_project_overview', [
    'Start here for any question about one project. Returns status counts, points and hours, each owner\'s open work, overdue and unassigned work,',
    'the active sprint with its open items, every sprint, and per-epic progress, in one call. Use odin_find_items for specific item lists.',
  ].join(' '), z.object({ projectId: id }).strict(), async ({ projectId }) => {
    const [project, sprints] = await Promise.all([readProject(projectId), readSprints(projectId)]);
    return { ok: true, overview: buildProjectOverview(project, sprints, { today: today() }) };
  }, { mcp: true });

  tool('odin_find_items', [
    'Find epics, stories and tasks in a project by any mix of filters: text in the name or description, status, assignee (name, email or id, or "unassigned"),',
    'sprint (id, name, "active" or "backlog"), item type, parent, open or done, and overdue. Returns compact rows with ids and versions.',
    'Set includeDescriptions when you need item content.',
  ].join(' '), z.object({
    projectId: id,
    text: z.string().trim().max(200).optional(),
    status: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
    assignee: z.string().trim().max(200).optional(),
    sprint: z.string().trim().max(200).optional(),
    itemType: z.enum(['epic', 'story', 'task']).optional(),
    parentId: id.optional(),
    state: z.enum(['open', 'done', 'any']).default('any'),
    overdue: z.boolean().optional(),
    includeDescriptions: z.boolean().default(false),
    limit: z.number().int().min(1).max(200).default(60),
    pursuitBoard: z.boolean().optional().describe('True also reads the Pursuit board of a project that was an engagement. An engagement\'s pursuit tasks are always read; they carry pursuit: true.'),
  }).strict(), async (args) => {
    const [project, sprints] = await Promise.all([readProject(args.projectId, args.pursuitBoard ? 'include' : 'auto'), readSprints(args.projectId)]);
    const sprintNames = new Map(sprints.map((sprint) => [sprint.id, sprint.name]));
    let sprintFilter;
    if (args.sprint) {
      const wanted = args.sprint.toLowerCase();
      if (wanted === 'backlog' || wanted === 'none') sprintFilter = null;
      else {
        const match = sprints.find((sprint) => (wanted === 'active' ? sprint.status === 'active' : sprint.id === args.sprint || sprint.name.toLowerCase() === wanted))
          ?? sprints.find((sprint) => sprint.name.toLowerCase().includes(wanted));
        if (!match) throw new OdinApiError(404, 'sprint_not_found', `No sprint matches "${args.sprint}". Sprints: ${sprints.map((sprint) => `${sprint.name} (${sprint.status})`).join(', ') || 'none'}.`);
        sprintFilter = match.id;
      }
    }
    const statuses = args.status?.map((status) => status.toLowerCase());
    const text = args.text?.toLowerCase();
    const assignee = args.assignee?.toLowerCase();
    const day = today();
    const rows = flattenProjectItems(project).filter((item) => {
      if (args.itemType && item.itemType !== args.itemType) return false;
      if (args.parentId && item.parentId !== args.parentId) return false;
      if (statuses && !statuses.includes(String(item.status ?? '').toLowerCase())) return false;
      if (args.state === 'open' && isDoneStatus(item.status)) return false;
      if (args.state === 'done' && !isDoneStatus(item.status)) return false;
      if (sprintFilter !== undefined && (item.sprintId ?? null) !== sprintFilter) return false;
      if (args.overdue && !(item.targetEndDate && String(item.targetEndDate).slice(0, 10) < day && !isDoneStatus(item.status))) return false;
      if (assignee) {
        if (assignee === 'unassigned') { if (item.assigneeId || item.assigneeName) return false; }
        else if (!(String(item.assigneeId ?? '').toLowerCase() === assignee || String(item.assigneeName ?? '').toLowerCase().includes(assignee))) return false;
      }
      if (text && !`${item.name} ${item.description ?? ''}`.toLowerCase().includes(text)) return false;
      return true;
    });
    return {
      ok: true,
      total: rows.length,
      items: rows.slice(0, args.limit).map((item) => compactItem(item, { description: args.includeDescriptions, sprintNames })),
      ...(rows.length > args.limit ? { note: `Showing ${args.limit} of ${rows.length}. Narrow the filters or raise limit.` } : {}),
    };
  }, { mcp: true });

  tool('odin_create_plan_items', [
    'Create several work items in one call, including whole branches: epics with their stories and tasks. Without parentId, items are epics;',
    'under an epic they are stories; under a story they are tasks. Each item\'s children are the next level down. Parents are resolved for you.',
    'Assignees may be names. The result lists every created id and any description gaps to fix (stories need acceptance criteria).',
  ].join(' '), z.object({
    projectId: id,
    parentId: id.nullable().default(null).describe('Existing epic (to add stories) or story (to add tasks). Omit to add epics.'),
    items: z.array(epicNode).min(1).max(40),
    dryRun,
  }).strict(), async (args) => {
    const project = await readProject(args.projectId, 'include');
    const all = flattenProjectItems(project);
    const parent = args.parentId ? all.find((item) => item.id === args.parentId) : null;
    if (args.parentId && !parent) throw new OdinApiError(404, 'parent_not_found', 'The parent item was not found in this project. Use odin_find_items to get its id.');
    if (parent?.itemType === 'task') throw new OdinApiError(400, 'invalid_parent', 'Tasks cannot have children. Choose a story or epic as the parent.');
    const count = (nodes) => nodes.reduce((total, node) => total + 1 + count(node.children ?? []), 0);
    if (!args.dryRun) await api.checkItemLimit?.(args.projectId, count(args.items));
    const resolve = await assigneeResolver(args.projectId);
    const created = [];
    const failed = [];
    const notes = [];
    async function createLevel(nodes, parentId, parentType) {
      const itemType = CHILD_TYPE[parentType];
      for (const node of nodes) {
        const { children = [], assignee, ...fields } = node;
        if (!itemType) { failed.push({ name: node.name, error: 'Tasks cannot have children; this item was skipped.' }); continue; }
        if (args.dryRun) {
          created.push({ id: null, itemType, name: node.name, parentId });
          await createLevel(children, null, itemType);
          continue;
        }
        try {
          const assigneeId = await resolve(assignee);
          const result = await api.request('POST', `${projectPath(args.projectId)}/items`, {
            body: { itemType, parentId, item: { ...fields, ...(assigneeId !== undefined ? { assigneeId } : {}) } },
          });
          const item = result.item ?? {};
          created.push({ id: item.id, itemType, name: item.name ?? node.name, parentId });
          const gaps = qualityNotes(itemType, fields);
          if (gaps.length) notes.push({ id: item.id, name: item.name ?? node.name, missing: gaps });
          if (children.length) await createLevel(children, item.id, itemType);
        } catch (error) {
          failed.push({ name: node.name, error: error.message, ...(children.length ? { skippedChildren: children.length } : {}) });
        }
      }
    }
    await createLevel(args.items, parent?.id ?? null, parent?.itemType ?? 'root');
    return { ok: failed.length === 0, dryRun: Boolean(args.dryRun), created, failed, ...(notes.length ? { descriptionGaps: notes } : {}) };
  }, { mcp: true, write: true });

  const patchShape = z.object({
    ...Object.fromEntries(Object.entries(itemFields).map(([key, field]) => [key, key === 'name' ? field.optional() : field])),
    boardColumn: z.string().trim().max(80).nullable().optional(),
    percentComplete: z.number().int().min(0).max(100).nullable().optional(),
    actualHours: z.number().min(0).max(100000).nullable().optional(),
  }).strict();
  tool('odin_update_items', [
    'Update one or many epics, stories or tasks in one call. Versions are read for you, so no expectedVersion is needed. Each update is a patch:',
    'only the fields you send change. Assignees may be names. Use parentId to move an item under another parent. Returns each result.',
    'Giving a story or epic an assignee also gives it to the open work under it that had the same assignee as the parent, or none: a story\'s tasks, an epic\'s stories',
    'and their tasks. Those results carry followed (the parent\'s id); say in your reply that they moved too. childAssignees keep leaves the work under it as it is.',
    'An item that changes while the call runs is still updated unless someone changed a field the update sets; then it is left alone and comes back with changed: true',
    'and its current values.',
  ].join(' '), z.object({
    projectId: id,
    updates: z.array(z.object({ itemId: id, patch: patchShape, parentId: id.optional(), position: z.number().int().min(0).max(100000).optional() }).strict()).min(1).max(100),
    childAssignees: z.enum(['follow', 'keep']).default('follow').describe('follow: open work under a reassigned story or epic that had its old assignee, or none, gets the new one too. keep: only the items listed change.'),
    dryRun,
  }).strict(), async (args) => {
    // Every update is based on, and checked against, this first read, even after a conflict reads
    // the project again.
    const items = itemsWithPositions(await readProject(args.projectId, 'include'));
    const updates = args.childAssignees === 'follow' ? [...args.updates, ...followingAssignees(args.updates, items)] : args.updates;
    if (!args.dryRun) await api.checkItemLimit?.(args.projectId, updates.length);
    const resolve = await assigneeResolver(args.projectId);
    const results = [];
    for (const update of updates) {
      const current = items.get(update.itemId);
      if (!current) { results.push({ itemId: update.itemId, ok: false, error: 'Item not found in this project.' }); continue; }
      try {
        const { assignee, ...patch } = update.patch;
        const assigneeId = await resolve(assignee);
        if (assigneeId !== undefined) patch.assigneeId = assigneeId;
        const body = { expectedVersion: Number(current.version), patch, ...(update.parentId ? { parentId: update.parentId } : {}), ...(update.position !== undefined ? { position: update.position } : {}) };
        const followed = update.followed ? { followed: update.followed, itemType: current.itemType } : {};
        if (args.dryRun) { results.push({ itemId: update.itemId, ok: true, dryRun: true, request: body, ...followed }); continue; }
        let result;
        try {
          result = await api.request('PATCH', `${projectPath(args.projectId)}/items/${encodeURIComponent(update.itemId)}`, { body });
        } catch (error) {
          if (error.status !== 409) throw error;
          // The item changed while this call ran, by someone else or by this call's own earlier
          // writes (a story's completion completes its tasks). The update goes ahead on the new
          // version only if nobody changed the fields it sets; otherwise it is left alone, so it
          // never overwrites a person's edit. A 409 with the version unchanged is another refusal
          // (a status change that needs an approval) and stands.
          const fresh = itemsWithPositions(await readProject(args.projectId, 'include')).get(update.itemId);
          if (!fresh || Number(fresh.version) === body.expectedVersion) throw error;
          const moved = changedFields(current, fresh, body);
          if (moved.length) {
            results.push({
              itemId: update.itemId, ok: false, changed: true, name: fresh.name ?? current.name,
              error: `Not changed: ${moved.join(', ')} changed while this call was running, so this update was left alone. current has the new values; send the update again if it still applies.`,
              current: { ...Object.fromEntries(moved.map((field) => [field, fresh[field] ?? null])), version: Number(fresh.version) },
              ...followed,
            });
            continue;
          }
          body.expectedVersion = Number(fresh.version);
          result = await api.request('PATCH', `${projectPath(args.projectId)}/items/${encodeURIComponent(update.itemId)}`, { body });
        }
        // No descriptionGaps on edits: the model took them as a cue to rewrite whole descriptions
        // into the template when it had only changed a date in the text.
        const item = result.item ?? {};
        results.push({ itemId: update.itemId, ok: true, name: item.name ?? current.name, status: item.status ?? current.status, version: item.version ?? null, ...followed });
      } catch (error) {
        results.push({ itemId: update.itemId, ok: false, name: current.name, error: error.message, ...(update.followed ? { followed: update.followed } : {}) });
      }
    }
    return { ok: results.every((entry) => entry.ok), results };
  }, { mcp: true, write: true });

  tool('odin_assign_items_to_sprint', 'Move stories and tasks into a sprint, or back to the backlog with sprintId null.', z.object({
    projectId: id, sprintId: id.nullable(), itemIds: z.array(id).min(1).max(200), dryRun,
  }).strict(), async (args) => {
    const items = new Map(flattenProjectItems(await readProject(args.projectId, 'none')).map((item) => [item.id, item]));
    const assignments = [];
    const skipped = [];
    for (const itemId of args.itemIds) {
      const item = items.get(itemId);
      if (!item || item.itemType === 'epic') skipped.push({ itemId, reason: item ? 'Epics are not planned into sprints.' : 'Not found.' });
      else assignments.push({ itemId, itemType: item.itemType, sprintId: args.sprintId });
    }
    if (!assignments.length) throw new OdinApiError(400, 'nothing_to_assign', 'None of the items can be assigned to a sprint.', { details: { skipped } });
    if (args.dryRun) return { ok: true, dryRun: true, assignments, skipped };
    await api.request('POST', `${projectPath(args.projectId)}/sprints/assign-items`, { body: { assignments } });
    return { ok: true, assigned: assignments.length, skipped };
  }, { mcp: true, purpose: 'Move work items into a sprint or out of one.', write: true });

  tool('odin_check_plan_quality', [
    'Review epic and story descriptions against Odin\'s planning rubric and list what each is missing (acceptance criteria, scope, outcome and so on).',
    'Advisory only: use it when asked about plan readiness or after writing items.',
  ].join(' '), z.object({ projectId: id, itemIds: z.array(id).max(200).optional() }).strict(), async ({ projectId, itemIds }) => {
    const wanted = itemIds?.length ? new Set(itemIds) : null;
    const findings = flattenProjectItems(await readProject(projectId))
      .filter((item) => ['epic', 'story'].includes(item.itemType) && (!wanted || wanted.has(item.id)))
      .map((item) => ({ id: item.id, itemType: item.itemType, name: item.name, missing: qualityNotes(item.itemType, item) }))
      .filter((entry) => entry.missing.length);
    return { ok: true, itemsWithGaps: findings.length, findings: findings.slice(0, 60) };
  }, { mcp: true });

  // Revisions copy the item's content, so a ticket's are read only while agents may see it (D-027).
  // A deleted item is judged by its revisions (an item never changes type): one that was a ticket
  // needs its newest snapshot to say it was never external or was validated.
  tool('odin_list_item_revisions', 'Read the revision history of one epic, story, task or ticket, newest first: who (a user id) changed which fields from what to what, and when.', z.object({
    projectId: id, itemId: id, limit: z.number().int().min(1).max(50).default(15),
  }).strict(), async ({ projectId, itemId, limit }) => {
    const [project, result] = await Promise.all([
      readProject(projectId),
      api.request('GET', `${projectPath(projectId)}/items/${encodeURIComponent(itemId)}/revisions`, { query: { limit } }),
    ]);
    const revisions = result.revisions ?? [];
    const ticket = (project.tickets ?? []).find((entry) => entry.id === itemId);
    const latest = revisions[0]?.after ?? revisions[0]?.before;
    const wasTicket = revisions.some((revision) => [revision.itemType, revision.after?.itemType, revision.before?.itemType].includes('ticket'));
    const visible = ticket ? isTicketVisibleToAssistant(ticket)
      : !wasTicket || (latest?.node?.externalReviewState !== undefined && isTicketVisibleToAssistant(latest.node));
    if (!visible) throw new OdinApiError(404, 'item_not_found', 'Item not found in this project. A ticket submitted from outside the team stays hidden until someone validates it.');
    return { ok: true, itemId, ...compactPayload({ revisions: revisions.map(presentRevision) }, { maxArray: limit, maxString: 300 }) };
  }, { mcp: true, purpose: 'Read a work item\'s change history: who changed what and when.' });

  const ticketQuery = {
    search: z.string().trim().max(200).optional(),
    statusValues: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
    severities: z.array(z.enum(TICKET_SEVERITIES)).max(4).optional(),
    categories: z.array(z.enum(TICKET_CATEGORIES)).max(4).optional(),
    assigneeIds: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
    reopened: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).default(40),
  };
  const presentTicket = (ticket) => ({
    id: ticket.id, projectId: ticket.projectId ?? null, projectName: ticket.projectName ?? undefined, name: ticket.name, status: ticket.status,
    severity: ticket.severity ?? null, category: ticket.category ?? null, priority: ticket.priority ?? null, assignee: ticket.assigneeName || null,
    assigneeId: ticket.assigneeId || null, reporter: ticket.reporterName ?? ticket.reporterExternalId ?? null, updatedAt: ticket.updatedAt ?? null,
    version: ticket.version ?? null, description: truncate(ticket.description, 600),
  });
  tool('odin_list_tickets', 'List or search tickets (defects, support requests, questions, change requests) in one project, or across every project you can see when projectId is omitted.', z.object({
    projectId: id.optional(), ...ticketQuery,
  }).strict(), async ({ projectId, ...query }) => {
    const path = projectId ? `${projectPath(projectId)}/tickets` : '/api/projects/tickets';
    // External tickets nobody has validated stay out of agents' sight (D-027).
    const result = await explained(() => api.request('GET', path, { query: { ...query, externalReviewStates: AGENT_VISIBLE_REVIEW_STATES } }), projectId ? {} : {
      404: ['http_404', 'Odin refused the list across projects. A connection limited to some projects must name one of them: pass its projectId.'],
    });
    return { ok: true, tickets: (result.tickets ?? []).filter(isTicketVisibleToAssistant).map(presentTicket), nextCursor: result.nextCursor ?? null };
  }, { mcp: true });
  tool('odin_update_ticket', [
    'Update a ticket: status, assignee, priority, severity, category, title or details. The version is read for you. Assignees may be names.',
    'A status change emails the reporter when the ticket came in through a reporting link.',
  ].join(' '), z.object({
    projectId: id,
    itemId: id,
    patch: z.object({
      name: z.string().trim().min(1).max(200).optional(), description: z.string().max(5000).optional(), status: z.string().trim().min(1).max(80).optional(),
      priority: z.number().int().min(1).max(7).optional(), assignee: z.string().trim().max(200).nullable().optional(),
      severity: z.enum(TICKET_SEVERITIES).optional(), category: z.enum(TICKET_CATEGORIES).optional(),
      reproSteps: z.string().max(8000).optional(), expectedResult: z.string().max(8000).optional(), actualResult: z.string().max(8000).optional(),
    }).strict(),
    dryRun,
  }).strict(), async ({ projectId, itemId, patch, dryRun: preview }) => {
    let ticket = null;
    let cursor = '';
    for (let pageIndex = 0; pageIndex < 10 && !ticket; pageIndex += 1) {
      const result = await api.request('GET', `${projectPath(projectId)}/tickets`, { query: { externalReviewStates: AGENT_VISIBLE_REVIEW_STATES, limit: 200, ...(cursor ? { cursor } : {}) } });
      ticket = (result.tickets ?? []).find((entry) => entry.id === itemId && isTicketVisibleToAssistant(entry)) ?? null;
      cursor = result.nextCursor ?? '';
      if (!cursor) break;
    }
    if (!ticket) throw new OdinApiError(404, 'ticket_not_found', 'Ticket not found in this project.');
    const { assignee, ...rest } = patch;
    const assigneeId = await (await assigneeResolver(projectId))(assignee);
    const body = { expectedVersion: Number(ticket.version), patch: { ...rest, ...(assigneeId !== undefined ? { assigneeId } : {}) } };
    if (preview) return { ok: true, dryRun: true, request: body };
    const result = await api.request('PATCH', `${projectPath(projectId)}/items/${encodeURIComponent(itemId)}`, { body });
    return { ok: true, ticket: presentTicket(result.item ?? { ...ticket, ...body.patch }) };
  }, { confirm: (args) => args?.patch?.status !== undefined, mcp: true, write: true });

  // Governance: the RAID log, milestones, scheduled dependencies, the working calendar and schedule
  // baselines. Odin needs plan-edit for every write; change-scope.js leaves all but the RAID log to
  // the project's admins and managers.
  // Every governance call asks for Odin's agent view, which leaves out the tickets agents may not
  // see (D-027) from what it reads and from what each write answers with.
  const agentView = { agentView: 1 };
  const governanceRequest = (method, path, options = {}) => api.request(method, path, { ...options, query: agentView });
  const readGovernance = (projectId) => governanceRequest('GET', `${projectPath(projectId)}/governance`);
  const governancePath = (projectId, collection, recordId) => `${projectPath(projectId)}/governance/${collection}${recordId ? `/${encodeURIComponent(recordId)}` : ''}`;
  const GOVERNANCE_RECORDS = { dependencies: ['dependency_not_found', 'Dependency'], items: ['governance_item_not_found', 'Governance item'], milestones: ['milestone_not_found', 'Milestone'] };
  async function governanceRecord(projectId, collection, recordId) {
    const snapshot = await readGovernance(projectId);
    const record = (snapshot[collection] ?? []).find((entry) => entry.id === recordId);
    const [code, label] = GOVERNANCE_RECORDS[collection];
    if (!record) throw new OdinApiError(404, code, `${label} not found. Use odin_get_governance to list them.`);
    return { record, snapshot };
  }

  // Governance links take any id, so check that each new one (ids) names an epic, story or task in
  // the project: a milestone made with a mistyped id tracked nothing. Ids a record already holds
  // (held) are named but not checked, so a record whose item was deleted can still be changed or
  // removed. A ticket agents may not see (D-027) is never named and its id never shown: hides says
  // whether a record links one, and link gives a link as agents may see it.
  async function workItemsNamed(projectId, ids, held = []) {
    const wanted = ids.filter(Boolean);
    if (![...wanted, ...held].some(Boolean)) return { hides: () => false, label: () => null, link: () => null };
    const project = await readProject(projectId);
    const items = new Map(flattenProjectItems(project).map((item) => [item.id, item]));
    const missing = wanted.filter((itemId) => !items.has(itemId));
    if (missing.length) throw new OdinApiError(400, 'work_item_not_found', `No work item in this project has the id ${missing.join(', ')}. Use odin_find_items for the right id.`);
    const tickets = project.tickets ?? [];
    for (const ticket of tickets.filter(isTicketVisibleToAssistant)) items.set(ticket.id, { ...ticket, itemType: 'ticket' });
    const hidden = new Set(tickets.filter((ticket) => !isTicketVisibleToAssistant(ticket)).map((ticket) => ticket.id));
    return {
      hides: (...itemIds) => itemIds.some((itemId) => hidden.has(itemId)),
      label: (itemId) => (hidden.has(itemId) ? null : items.has(itemId) ? `${items.get(itemId).itemType} "${items.get(itemId).name}"` : `deleted item ${itemId}`),
      link: (itemId) => (itemId && !hidden.has(itemId) ? itemId : null),
    };
  }
  const presentMilestone = (result, names) => { const record = plain(recordOf(result, 'milestone')); return { ...record, workItemId: names.link(record.workItemId) }; };
  const presentDependency = (result, names) => { const record = plain(recordOf(result, 'dependency')); return { ...record, predecessorId: names.link(record.predecessorId), successorId: names.link(record.successorId) }; };
  const DEPENDENCY_NOT_FOUND = () => new OdinApiError(404, 'dependency_not_found', 'Dependency not found. Use odin_get_governance to list them.');

  tool('odin_get_governance', [
    'Read a project\'s risks, issues, assumptions, decisions and change requests, its milestones, scheduled dependencies, working calendar and schedule baselines,',
    'with the ids the update and delete tools take. Linked work items are named. A calendar marked isDefault was never set.',
  ].join(' '), z.object({ projectId: id }).strict(), async ({ projectId }) => {
    const [snapshot, project] = await Promise.all([readGovernance(projectId), readProject(projectId).catch(() => null)]);
    // A link to a ticket agents may not see (D-027) is left out: a dependency on one is not listed,
    // and a milestone tracking one shows no work item. Without the project to check, no link shows.
    const tickets = project?.tickets ?? [];
    const hidden = new Set(tickets.filter((ticket) => !isTicketVisibleToAssistant(ticket)).map((ticket) => ticket.id));
    const items = [...flattenProjectItems(project ?? {}), ...tickets.filter(isTicketVisibleToAssistant).map((ticket) => ({ ...ticket, itemType: 'ticket' }))];
    const names = new Map(items.map((item) => [item.id, `${item.itemType} "${item.name}"`]));
    const linked = (itemId) => (project && itemId && !hidden.has(itemId) ? itemId : null);
    const named = (itemId) => (linked(itemId) ? names.get(itemId) ?? `deleted item ${itemId}` : null);
    return {
      ok: true,
      ...compactPayload({
        items: (snapshot.items ?? []).map(plain),
        milestones: (snapshot.milestones ?? []).map((milestone) => ({ ...plain(milestone), workItemId: linked(milestone.workItemId), workItem: named(milestone.workItemId) })),
        dependencies: (snapshot.dependencies ?? []).filter((dependency) => !hidden.has(dependency.predecessorId) && !hidden.has(dependency.successorId)).map((dependency) => ({
          ...plain(dependency), predecessorId: linked(dependency.predecessorId), successorId: linked(dependency.successorId), predecessor: named(dependency.predecessorId), successor: named(dependency.successorId),
        })),
        workingCalendar: presentCalendar(snapshot.workingCalendar),
        scheduleBaselines: (snapshot.scheduleBaselines ?? []).map(presentBaseline),
      }, { maxArray: 100, maxString: 600 }),
    };
  }, { mcp: true, purpose: 'Read the project\'s risks, issues, assumptions, change requests, milestones, dependencies, working calendar and schedule baselines.' });
  tool('odin_get_schedule_analysis', 'Analyze a project\'s schedule: critical path, float, late and at-risk items, milestone forecasts and movement from the newest baseline, based on dates, estimates, dependencies and the working calendar.', z.object({ projectId: id }).strict(), async ({ projectId }) => {
    const result = await governanceRequest('GET', `${projectPath(projectId)}/governance/schedule-analysis`);
    return { ok: true, ...compactPayload(result, { maxArray: 40, maxString: 400 }) };
  }, { mcp: true, purpose: 'Analyze the schedule: critical path, slack, late and at-risk items.' });
  tool('odin_create_governance_item', 'Log a risk, issue, assumption, decision or change request on a project.', z.object({
    projectId: id, input: governanceItemCreateSchema.strict(), dryRun,
  }).strict(), async ({ projectId, input, dryRun: preview }) => {
    if (preview) return { ok: true, dryRun: true, request: input };
    const result = await explained(() => governanceRequest('POST', governancePath(projectId, 'items'), { body: input }), GOVERNANCE_WRITE_ERRORS);
    return { ok: true, item: plain(recordOf(result, 'item')) };
  }, { mcp: true, write: true });
  tool('odin_update_governance_item', 'Update a risk, issue, assumption, decision or change request, or close one with status closed or resolved. Only the fields you send change; the version is read for you.', z.object({
    projectId: id, itemId: id, patch: patchOf(governanceItemCreateSchema), dryRun,
  }).strict(), async ({ projectId, itemId, patch, dryRun: preview }) => {
    const { record: current } = await governanceRecord(projectId, 'items', itemId);
    const body = { ...patch, expectedVersion: Number(current.version) };
    if (preview) return { ok: true, dryRun: true, request: body };
    const result = await explained(() => governanceRequest('PATCH', governancePath(projectId, 'items', itemId), { body }), GOVERNANCE_WRITE_ERRORS);
    return { ok: true, item: plain(recordOf(result, 'item')) };
  }, { mcp: true, write: true });
  tool('odin_delete_governance_item', [
    'Delete a risk, issue, assumption, decision or change request for good.',
    'To close one and keep its record, set its status to closed or resolved with odin_update_governance_item instead.',
  ].join(' '), z.object({ projectId: id, itemId: id, dryRun }).strict(), async ({ projectId, itemId, dryRun: preview }) => {
    const { record: current } = await governanceRecord(projectId, 'items', itemId);
    const body = { expectedVersion: Number(current.version) };
    const deleted = { id: itemId, kind: current.kind, title: current.title };
    if (preview) return { ok: true, dryRun: true, request: body, deletes: deleted };
    await explained(() => governanceRequest('DELETE', governancePath(projectId, 'items', itemId), { body }), GOVERNANCE_WRITE_ERRORS);
    return { ok: true, deleted };
  }, { confirm: true, destructive: true, mcp: true, purpose: 'Delete a risk, issue, assumption, decision or change request from the project.', write: true });

  tool('odin_create_milestone', [
    'Add a milestone (a launch, a go-live, a sign-off) with a target date. Link it to the work item that delivers it with workItemId:',
    'schedule analysis and Insights then forecast the milestone from that item and show whether it lands on its date.',
  ].join(' '), z.object({ projectId: id, input: milestoneCreateSchema.strict(), dryRun }).strict(), async ({ projectId, input, dryRun: preview }) => {
    const linked = await workItemsNamed(projectId, [input.workItemId]);
    if (preview) return { ok: true, dryRun: true, request: input };
    const result = await explained(() => governanceRequest('POST', governancePath(projectId, 'milestones'), { body: input }), GOVERNANCE_WRITE_ERRORS);
    return { ok: true, milestone: presentMilestone(result, linked), ...(input.workItemId ? { linkedTo: linked.label(input.workItemId) } : {}) };
  }, { mcp: true, purpose: 'Add a milestone, such as a launch, go-live or sign-off, with a target date.', write: true });
  tool('odin_update_milestone', 'Change a milestone\'s title, target date, status or linked work item. Only the fields you send change; the version is read for you.', z.object({
    projectId: id, milestoneId: id, patch: patchOf(milestoneCreateSchema), dryRun,
  }).strict(), async ({ projectId, milestoneId, patch, dryRun: preview }) => {
    const { record: current } = await governanceRecord(projectId, 'milestones', milestoneId);
    const linked = await workItemsNamed(projectId, [patch.workItemId], [current.workItemId]);
    const body = { ...patch, expectedVersion: Number(current.version) };
    if (preview) return { ok: true, dryRun: true, request: body };
    const result = await explained(() => governanceRequest('PATCH', governancePath(projectId, 'milestones', milestoneId), { body }), GOVERNANCE_WRITE_ERRORS);
    return { ok: true, milestone: presentMilestone(result, linked), ...(patch.workItemId ? { linkedTo: linked.label(patch.workItemId) } : {}) };
  }, { mcp: true, purpose: 'Change a milestone\'s date, status or name.', write: true });
  tool('odin_delete_milestone', 'Delete a milestone for good. To keep its record, set its status to achieved or missed with odin_update_milestone instead.', z.object({
    projectId: id, milestoneId: id, dryRun,
  }).strict(), async ({ projectId, milestoneId, dryRun: preview }) => {
    const { record: current } = await governanceRecord(projectId, 'milestones', milestoneId);
    const body = { expectedVersion: Number(current.version) };
    const deleted = { id: milestoneId, title: current.title, targetDate: current.targetDate ?? null };
    if (preview) return { ok: true, dryRun: true, request: body, deletes: deleted };
    await explained(() => governanceRequest('DELETE', governancePath(projectId, 'milestones', milestoneId), { body }), GOVERNANCE_WRITE_ERRORS);
    return { ok: true, deleted };
  }, { confirm: true, destructive: true, mcp: true, purpose: 'Delete a milestone from the project.', write: true });

  // Odin's own rule (no item waits on itself) with strict fields at the tool boundary.
  const dependencyInput = dependencyCreateSchema.innerType().strict().refine((value) => dependencyCreateSchema.safeParse(value).success, { message: 'A work item cannot depend on itself.', path: ['successorId'] });
  const DEPENDENCY_CONFLICT = ['dependency_conflict', 'Another dependency already links these items this way, or this one changed since it was read. Read them again with odin_get_governance before retrying.'];
  tool('odin_create_dependency', [
    'Make one work item wait on another in the schedule: finish-to-start (FS) by default, or SS, FF or SF, with optional lag in working days.',
    'Schedule analysis builds its critical path from these dependencies; the Insights timeline also follows "blocks" links (odin_link_work_items).',
  ].join(' '), z.object({ projectId: id, input: dependencyInput, dryRun }).strict(), async ({ projectId, input, dryRun: preview }) => {
    const [named, snapshot] = await Promise.all([workItemsNamed(projectId, [input.predecessorId, input.successorId]), readGovernance(projectId).catch(() => null)]);
    const existing = (snapshot?.dependencies ?? []).find((dependency) => sameLink(dependency, input));
    if (existing) throw new OdinApiError(409, 'dependency_exists', `${named.label(input.successorId)} already waits on ${named.label(input.predecessorId)} (${input.dependencyType}, dependencyId ${existing.id}). Change it with odin_update_dependency.`);
    if (preview) return { ok: true, dryRun: true, request: input };
    const result = await explained(() => governanceRequest('POST', governancePath(projectId, 'dependencies'), { body: input }), { ...GOVERNANCE_WRITE_ERRORS, 409: DEPENDENCY_CONFLICT });
    return { ok: true, dependency: presentDependency(result, named), waits: `${named.label(input.successorId)} waits on ${named.label(input.predecessorId)}` };
  }, { mcp: true, purpose: 'Make one work item wait on another in the schedule (finish-to-start and the like).', write: true });
  tool('odin_update_dependency', [
    'Change a scheduled dependency: which item waits on which, its type (FS, SS, FF or SF) or its lag in working days.',
    'Only the fields you send change; the version is read for you. odin_get_governance lists dependency ids.',
  ].join(' '), z.object({ projectId: id, dependencyId: id, patch: patchOf(dependencyCreateSchema.innerType()), dryRun }).strict(), async ({ projectId, dependencyId, patch, dryRun: preview }) => {
    const { record: current, snapshot } = await governanceRecord(projectId, 'dependencies', dependencyId);
    const named = await workItemsNamed(projectId, [patch.predecessorId, patch.successorId], [current.predecessorId, current.successorId]);
    if (named.hides(current.predecessorId, current.successorId)) throw DEPENDENCY_NOT_FOUND();
    const next = { dependencyType: current.dependencyType, lagDays: current.lagDays, predecessorId: current.predecessorId, successorId: current.successorId, ...patch };
    if (next.predecessorId === next.successorId) throw new OdinApiError(400, 'self_dependency', 'A work item cannot depend on itself.');
    const clash = (snapshot.dependencies ?? []).find((dependency) => dependency.id !== dependencyId && sameLink(dependency, next));
    if (clash) throw new OdinApiError(409, 'dependency_exists', `Dependency ${clash.id} already makes ${named.label(next.successorId)} wait on ${named.label(next.predecessorId)} (${next.dependencyType}). Delete one of the two instead.`);
    const body = { ...next, expectedVersion: Number(current.version) };
    if (preview) return { ok: true, dryRun: true, request: body };
    const result = await explained(() => governanceRequest('PATCH', governancePath(projectId, 'dependencies', dependencyId), { body }), { ...GOVERNANCE_WRITE_ERRORS, 409: DEPENDENCY_CONFLICT });
    return { ok: true, dependency: presentDependency(result, named), waits: `${named.label(next.successorId)} waits on ${named.label(next.predecessorId)}` };
  }, { destructive: true, mcp: true, purpose: 'Change a schedule dependency between two work items: its type, its lag, or which items it links.', write: true });
  tool('odin_delete_dependency', 'Remove a scheduled dependency, so one work item no longer waits on the other. odin_get_governance lists dependency ids.', z.object({
    projectId: id, dependencyId: id, dryRun,
  }).strict(), async ({ projectId, dependencyId, dryRun: preview }) => {
    const { record: current } = await governanceRecord(projectId, 'dependencies', dependencyId);
    const named = await workItemsNamed(projectId, [], [current.predecessorId, current.successorId]);
    if (named.hides(current.predecessorId, current.successorId)) throw DEPENDENCY_NOT_FOUND();
    const body = { expectedVersion: Number(current.version) };
    const deleted = { id: dependencyId, was: `${named.label(current.successorId)} waited on ${named.label(current.predecessorId)} (${current.dependencyType})` };
    if (preview) return { ok: true, dryRun: true, request: body, deletes: deleted };
    await explained(() => governanceRequest('DELETE', governancePath(projectId, 'dependencies', dependencyId), { body }), GOVERNANCE_WRITE_ERRORS);
    return { ok: true, deleted };
  }, { confirm: true, destructive: true, mcp: true, purpose: 'Remove a schedule dependency so one work item no longer waits on another.', write: true });

  const calendarFields = workingCalendarWriteSchema.innerType().shape;
  const dateList = calendarFields.holidays.removeDefault();
  tool('odin_update_working_calendar', [
    'Change the project\'s working calendar, which schedule analysis, the timeline and dependency lag count working days in: the weekdays worked,',
    'hours per day, timezone and holidays. Only the fields you send change; the version is read for you. odin_get_governance shows the calendar.',
  ].join(' '), z.object({
    projectId: id,
    patch: z.object({
      workingDays: calendarFields.workingDays.removeDefault().describe('Weekdays worked, 0 for Sunday to 6 for Saturday. Replaces the list.'),
      hoursPerDay: calendarFields.hoursPerDay.removeDefault(),
      timezone: calendarFields.timezone.removeDefault().describe('IANA timezone, such as America/New_York.'),
      holidays: dateList.describe('Every non-working date (YYYY-MM-DD), replacing the list. To change a few, use addHolidays or removeHolidays.'),
      addHolidays: dateList.describe('Dates (YYYY-MM-DD) to add to the holidays.'),
      removeHolidays: dateList.describe('Dates (YYYY-MM-DD) to take off the holidays.'),
    }).strict(),
    dryRun,
  }).strict(), async ({ projectId, patch, dryRun: preview }) => {
    const { addHolidays = [], removeHolidays = [], ...fields } = patch;
    const current = (await readGovernance(projectId)).workingCalendar ?? null;
    const merged = { ...normalizeWorkingCalendar(current), ...fields };
    const removed = new Set(removeHolidays);
    const parsed = workingCalendarWriteSchema.safeParse({
      ...merged, expectedVersion: current?.version ?? null, holidays: [...new Set([...merged.holidays, ...addHolidays])].filter((day) => !removed.has(day)).sort(),
    });
    if (!parsed.success) throw new OdinApiError(400, 'invalid_calendar', parsed.error.issues.map((issue) => issue.message).join(' '));
    if (preview) return { ok: true, dryRun: true, request: parsed.data };
    const result = await explained(() => governanceRequest('PUT', `${projectPath(projectId)}/governance/working-calendar`, { body: parsed.data }), GOVERNANCE_WRITE_ERRORS);
    return { ok: true, workingCalendar: presentCalendar(recordOf(result, 'workingCalendar')) };
  }, { destructive: true, mcp: true, purpose: 'Change which weekdays and hours the project works, its timezone and its holidays, which every schedule date counts in.', write: true });
  // Asks first: a baseline cannot be removed, and the newest one becomes what every slip is measured against.
  tool('odin_create_schedule_baseline', [
    'Save the project\'s schedule as it stands as a baseline: every work item\'s dates, the milestones, dependencies and working calendar.',
    'Schedule analysis then reports how far items, milestones and the finish have moved from the newest baseline. Baselines cannot be edited or deleted,',
    'so save one when a plan is agreed, not after every change. odin_get_governance lists them.',
  ].join(' '), z.object({ projectId: id, input: scheduleBaselineCreateSchema.strict(), dryRun }).strict(), async ({ projectId, input, dryRun: preview }) => {
    if (preview) return { ok: true, dryRun: true, request: input };
    const result = await explained(() => governanceRequest('POST', `${projectPath(projectId)}/governance/schedule-baselines`, { body: input }), GOVERNANCE_WRITE_ERRORS);
    return { ok: true, baseline: presentBaseline(recordOf(result, 'baseline')) };
  }, { confirm: true, mcp: true, purpose: 'Save the current schedule as a baseline (an agreed plan) to measure slips against.', write: true });

  tool('odin_get_timeline', [
    'Read the Insights timeline (Gantt) the user sees: when each epic and story is planned to start and finish, what holds each story there',
    '(its target dates, its sprint, a blocker, or its person being busy with another story), and the critical chain to the finish.',
    'Each person works one open story at a time, so one person\'s open stories with overlapping dates run one after another; finished stories stay at their dates.',
    'Check it after changing dates, links or owners to confirm the plan lands where the user wants.',
  ].join(' '), z.object({ projectId: id }).strict(), async ({ projectId }) => {
    const result = await api.request('GET', `${projectPath(projectId)}/insights`, { query: { agentView: 1, days: 30 } });
    const card = result.cards?.gantt ?? {};
    const data = card.data;
    if (!data?.rows?.length) return { ok: true, status: card.status ?? 'empty', message: card.message ?? 'Nothing is on the timeline yet.' };
    const names = new Map(data.rows.map((row) => [row.id, row.name]));
    const people = new Map((data.resources ?? []).map((person) => [person.id, person.name]));
    const heldBy = (driver = {}) => {
      if (driver.kind === 'dates') return 'its target start date';
      if (driver.kind === 'sprint') return 'its sprint';
      if (driver.kind === 'blocker') return `waits for "${names.get(driver.itemId) ?? driver.itemId}" (${driver.source === 'relation' ? 'blocks link' : `${driver.type} dependency`})`;
      if (driver.kind === 'resource') return `waits for ${people.get(driver.assigneeId) ?? 'its person'} to finish "${names.get(driver.itemId) ?? driver.itemId}"`;
      return 'the start of the plan';
    };
    const finish = data.rows.filter((row) => row.finishDate).map((row) => row.finishDate).sort().at(-1) ?? null;
    // Said outright: given only "waits for Matthew", the model reported a launch a week late as
    // a caveat instead of moving the stories that overlapped.
    const waiting = data.rows.filter((row) => row.leaf && !row.done && row.driver?.kind === 'resource');
    const advice = waiting.length
      ? `${waiting.map((row) => `"${row.name}"`).join(', ')} ${waiting.length === 1 ? 'starts' : 'start'} later than ${waiting.length === 1 ? 'its' : 'their'} dates because ${[...new Set(waiting.map((row) => people.get(row.driver.assigneeId) ?? 'their person'))].join(' and ')} ${waiting.length === 1 ? 'is' : 'are'} busy with another story then. One person works one open story at a time here, so give each person's open stories back-to-back dates, in the order they should run, to bring them forward.`
      : null;
    return {
      ok: true,
      planStart: data.anchorDate ?? null,
      planFinish: finish,
      ...(advice ? { advice } : {}),
      counts: data.counts,
      notes: card.notes ?? [],
      rows: data.rows.map((row) => ({
        id: row.id, type: row.type, name: row.name, ...(row.leaf ? {} : { epic: true }),
        start: row.startDate ?? `day ${row.start + 1}`, finish: row.finishDate ?? `day ${row.finish}`,
        done: Boolean(row.done), ...(row.critical ? { critical: true } : {}), ...(row.late ? { late: true } : {}),
        ...(row.leaf ? { heldBy: heldBy(row.driver), length: `${row.finish - row.start} working day${row.finish - row.start === 1 ? '' : 's'} from ${row.durationSource}` } : {}),
      })),
      ...(data.unscheduled?.length ? { notOnTimeline: data.unscheduled.map((entry) => entry.name) } : {}),
    };
  }, { mcp: true, purpose: 'See the project timeline (Gantt): when each story will start and finish given dates, blockers and each person\'s workload, and the critical path to launch or finish.' });

  // Odin offers 30, 90 and 180 days; a window in between rounds up rather than failing the call.
  const insightDays = z.number().int().min(7).max(365).default(30).describe('Days of history: 30, 90 or 180. Others round up.')
    .transform((days) => INSIGHTS_DAY_OPTIONS.find((option) => option >= days) ?? INSIGHTS_DAY_OPTIONS.at(-1));
  tool('odin_get_insights', 'Read a project\'s Insights: delivery health, throughput and trends, schedule, budget and team signals, and report results.', z.object({
    projectId: id, days: insightDays,
  }).strict(), async ({ projectId, days }) => {
    const result = await api.request('GET', `${projectPath(projectId)}/insights`, { query: { agentView: 1, days } });
    return { ok: true, ...compactPayload(result, { maxArray: 20, maxDepth: 5, maxString: 300 }) };
  }, { mcp: true, purpose: 'Read project health metrics: throughput, trends, budget and forecast.' });

  tool('odin_get_project_team', 'Read who is on a project: allocated resources with hours per week and project rates (when you may see rates), linked logins, and who can own work items. Needs only read access to the project.', z.object({ projectId: id }).strict(), async ({ projectId }) => {
    const { directoryLimited, ...result } = await api.request('GET', `/api/resource-planning/projects/${encodeURIComponent(projectId)}/team`);
    return {
      ok: true,
      ...compactPayload(result, { maxArray: 80 }),
      ...(directoryLimited ? { note: 'This connection is limited to some projects, so it cannot see the workspace directory: directory and users list only the people on those projects. To add anyone else, use a connection to every project or Odin\'s Resources tab.' } : {}),
    };
  }, { mcp: true, purpose: 'Read who is on the project, their weekly hours, allocations and rates (workload and capacity).' });

  tool('odin_get_my_work', 'Read the signed-in user\'s home: focus items, assignments, tickets, approvals and alerts across all their projects, plus sprint status.', z.object({}).strict(), async () => {
    // Odin's agent view of Home is built without tickets from outside the team that nobody has
    // validated (D-027), so no card, blocker, approval or count comes from one.
    const result = await explained(() => api.request('GET', '/api/home', { query: { agentView: 1 } }), {
      404: ['needs_every_project', 'Home spans every project, and this connection is limited to some of them. Use odin_find_items with assignee and state "open" in each of its projects instead.'],
    });
    return {
      ok: true,
      ...compactPayload({ focus: result.focus, items: result.items, counts: result.rail?.counts, sprints: result.rail?.sprints, viewer: result.viewer }, { maxArray: 30, maxString: 300 }),
    };
  }, { mcp: true });

  const memoryTypes = ['decision', 'risk', 'change', 'meeting', 'preference', 'outcome', 'episode', 'fact'];
  tool('odin_search_memory', 'Search what the assistant remembers: decisions, preferences, outcomes, meetings and facts recorded for a project or the user, with how confident and how fresh each one is.', z.object({
    query: z.string().trim().min(1).max(1000), projectId: id.optional(), types: z.array(z.enum(memoryTypes)).max(8).optional(), limit: z.number().int().min(1).max(50).default(15),
  }).strict(), async ({ limit, projectId, query, types }) => {
    const result = await api.request('GET', '/api/agent-memory', { query: { limit, query, ...(projectId ? { projectIds: [projectId] } : {}), ...(types?.length ? { types } : {}) } });
    return { ok: true, ...compactPayload(result, { maxArray: limit, maxString: 800 }) };
  }, { purpose: 'Recall things the assistant was asked to remember earlier (decisions, preferences, facts).' });
  tool('odin_remember', 'Record something worth remembering for later chats: a decision, preference, outcome, meeting note or fact, on a project or just for the user. Only record what the user said or what tools showed.', z.object({
    title: z.string().trim().min(1).max(255),
    content: z.string().trim().min(1).max(20000),
    memoryType: z.enum(memoryTypes),
    projectId: id.nullable().optional(),
    sensitivity: z.enum(['public', 'internal', 'confidential', 'restricted']).default('internal'),
    dryRun,
  }).strict(), async ({ dryRun: preview, ...input }) => {
    const body = { ...input, projectId: input.projectId ?? null, provenance: { sourceType: 'assistant_chat' }, sourceAt: new Date().toISOString() };
    if (preview) return { ok: true, dryRun: true, request: body };
    const result = await api.request('POST', '/api/agent-memory', { body });
    return { ok: true, memory: compactPayload(result.memory ?? result, { maxString: 400 }) };
  }, { purpose: 'Save a fact, decision or preference for the assistant to remember later.', write: true });

  // Semantic search (docs/semantic-search/plan.md): matches by meaning as well as by words.
  const SEARCH_TYPES = ['project', 'epic', 'story', 'task', 'comment', 'file', 'post', 'channel', 'milestone', 'risk', 'issue', 'decision', 'assumption', 'change_request'];
  tool('odin_search', [
    'Search the workspace by meaning as well as by words: projects, epics, stories and tasks, comments on them, the text inside uploaded files',
    '(PDF, Word, Excel, PowerPoint and text files), channel posts, risks, issues, decisions and other governance records, milestones,',
    'and portfolio items and objectives. Describe what you are looking for in plain words; the exact wording need not match.',
    'Returns each match\'s type, id, title, project, link and the passage that matched. A file match also gives fileId, so you can read more of the file.',
    'Pass projectId to search one project, and types to search only some kinds of record.',
  ].join(' '), z.object({
    query: z.string().trim().min(1).max(500), projectId: id.optional(), limit: z.number().int().min(1).max(50).default(20),
    types: z.array(z.enum(SEARCH_TYPES)).max(SEARCH_TYPES.length).optional(),
  }).strict(), async ({ query, projectId, limit, types }) => {
    const result = await explained(() => api.request('GET', '/api/reporting/search', { query: { query, limit, ...(projectId ? { projectId } : {}), ...(types?.length ? { types: types.join(',') } : {}) } }), {
      404: ['http_404', 'Project not found or not accessible. A connection limited to some projects searches one of them at a time: pass its projectId.'],
    });
    const records = (result.records ?? []).map((record) => ({
      type: record.documentType,
      // A passage of a long file or item is reported as the record it belongs to.
      id: String(record.sourceId ?? '').split('#')[0],
      title: record.title,
      projectId: record.projectId ?? null,
      snippet: record.content,
      url: record.url ?? null,
      updatedAt: record.updatedAt ?? null,
      ...(record.retrievalMode ? { matchedBy: record.retrievalMode } : {}),
      ...(record.documentType === 'file' && record.facets?.fileId ? { fileId: record.facets.fileId } : {}),
    }));
    return { ok: true, total: result.total ?? records.length, ...compactPayload({ records }, { maxArray: limit, maxString: 600 }) };
  }, { mcp: true });
}
