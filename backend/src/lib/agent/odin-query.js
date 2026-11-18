import { Worker } from 'node:worker_threads';

import { isDoneStatus } from '../../mcp/project-overview.js';
import { isTicketVisibleToAssistant } from '../../modules/assistant/assistant-ticket-visibility.js';

// odin_query: read-only SQL (SQLite) over the user's Odin data, the agent's "pipes". Tables load
// through Odin's REST API as the user, so permissions apply exactly as in the UI; only the tables
// a query names are loaded, and each stays cached for the turn until something is written. The
// query runs in a worker thread on an in-memory copy, with a time limit.

const QUERY_TIMEOUT_MS = 5000;
const MAX_ROWS = 200;
const MAX_SCAN_ROWS = 100000;
const MAX_CELL_CHARS = 300;
const MAX_PROJECTS = 40;
const WORKER_URL = new URL('./odin-query-worker.js', import.meta.url);

const path = (projectId) => `/api/projects/${encodeURIComponent(projectId)}`;
const day = (value) => (value ? String(value).slice(0, 10) : null);
const number = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));

// An epic or story with children carries their total points and hours (work-estimates.js), so
// totals are summed over leaf rows only. estimateOverride is a flag, not an estimate.
function itemRows(projectId, project) {
  const rows = [];
  const add = (item, type, epicId, parentId, children) => rows.push([
    item.id, projectId, type, item.name ?? '', item.status ?? '', isDoneStatus(item.status) ? 1 : 0, children?.length ? 0 : 1, number(item.priority), number(item.points),
    number(item.targetHourEstimate), number(item.actualHours), number(item.percentComplete ?? item.progress),
    item.assigneeId || null, item.assigneeName || null, item.sprintId || null, epicId, parentId, day(item.targetStartDate), day(item.targetEndDate),
    item.boardColumn ?? null, item.updatedAt ?? null,
  ]);
  for (const epic of project.epics ?? []) {
    add(epic, 'epic', epic.id, null, epic.stories);
    for (const story of epic.stories ?? []) {
      add(story, 'story', epic.id, epic.id, story.tasks);
      for (const task of story.tasks ?? []) add(task, 'task', epic.id, story.id);
    }
  }
  return rows;
}

// Tickets submitted from outside the team that nobody has validated (D-027). A link to one, a
// relation, dependency or milestone, is left out of the tables like the ticket itself.
async function hiddenTicketIds(get, projectId) {
  const { project } = await get(path(projectId));
  return new Set((project?.tickets ?? []).filter((ticket) => !isTicketVisibleToAssistant(ticket)).map((ticket) => ticket.id));
}

// Each table: its columns (name, SQLite type, meaning) and how to load one project's rows with a
// memoized GET (the three governance tables share one read). "projects" covers the whole scope.
export const QUERY_TABLES = {
  projects: {
    columns: [['id', 'TEXT'], ['name', 'TEXT'], ['status', 'TEXT'], ['start_date', 'TEXT'], ['end_date', 'TEXT'], ['my_role', 'TEXT'], ['created_at', 'TEXT'], ['updated_at', 'TEXT']],
  },
  items: {
    columns: [['id', 'TEXT'], ['project_id', 'TEXT'], ['type', 'TEXT', "'epic', 'story' or 'task'"], ['name', 'TEXT'], ['status', 'TEXT'], ['done', 'INTEGER', '1 when the status counts as finished'],
      ['leaf', 'INTEGER', '1 for work with no children: every task, and stories or epics without any. Sum points and hours over leaf = 1 for totals'],
      ['priority', 'INTEGER', '1 highest to 7 lowest'], ['points', 'REAL', 'an epic or story with children shows their total unless set by hand'], ['estimate_hours', 'REAL', 'estimated hours; rolls up like points'],
      ['actual_hours', 'REAL', 'hours logged'], ['percent_complete', 'REAL'],
      ['assignee_id', 'TEXT'], ['assignee', 'TEXT', 'name'], ['sprint_id', 'TEXT', 'NULL = backlog'], ['epic_id', 'TEXT'], ['parent_id', 'TEXT', 'the epic of a story, the story of a task'],
      ['start_date', 'TEXT', 'YYYY-MM-DD'], ['due_date', 'TEXT', 'YYYY-MM-DD'], ['board_column', 'TEXT'], ['updated_at', 'TEXT']],
    async load(get, projectId) { const { project } = await get(path(projectId)); return itemRows(projectId, project ?? {}); },
  },
  sprints: {
    columns: [['id', 'TEXT'], ['project_id', 'TEXT'], ['name', 'TEXT'], ['status', 'TEXT', "'planned', 'active' or 'completed'"], ['goal', 'TEXT'], ['start_date', 'TEXT'], ['end_date', 'TEXT'], ['capacity_hours', 'REAL']],
    async load(get, projectId) {
      const { sprints = [] } = await get(`${path(projectId)}/sprints`);
      return sprints.map((sprint) => [sprint.id, projectId, sprint.name ?? '', sprint.status ?? sprint.sprintStatus ?? '', sprint.goal ?? null, day(sprint.startDate), day(sprint.endDate), number(sprint.summary?.capacityHours ?? sprint.capacityHours)]);
    },
  },
  team: {
    columns: [['project_id', 'TEXT'], ['resource_id', 'TEXT'], ['user_id', 'TEXT', 'matches items.assignee_id'], ['name', 'TEXT'], ['role', 'TEXT'], ['hours_per_week', 'REAL', 'allocated to this project'],
      ['allocation_percent', 'REAL'], ['capacity_hours_per_week', 'REAL', 'across all work'], ['bill_rate', 'REAL', 'NULL unless you may see rates'], ['cost_rate', 'REAL'], ['start_date', 'TEXT'], ['end_date', 'TEXT'], ['status', 'TEXT']],
    async load(get, projectId) {
      const team = await get(`/api/resource-planning/projects/${encodeURIComponent(projectId)}/team`);
      const directory = new Map((team.directory ?? []).map((resource) => [resource.id, resource]));
      const rates = team.canSeeRates !== false;
      return (team.allocations ?? []).map((allocation) => {
        const resource = directory.get(allocation.resourceId) ?? {};
        return [projectId, allocation.resourceId ?? null, resource.userId ?? null, resource.name ?? null, allocation.role ?? null, number(allocation.hoursPerWeek), number(allocation.allocationPercent),
          number(resource.capacityHoursPerWeek), rates ? number(allocation.billRate ?? resource.billRate) : null, rates ? number(resource.costRate) : null, day(allocation.startDate), day(allocation.endDate), allocation.status ?? null];
      });
    },
  },
  relations: {
    columns: [['project_id', 'TEXT'], ['id', 'TEXT'], ['from_id', 'TEXT', 'item id'], ['to_id', 'TEXT', 'item id'], ['type', 'TEXT', "from_id 'blocks', 'caused_by', 'affects' or 'duplicate_of' to_id"], ['created_at', 'TEXT']],
    async load(get, projectId) {
      const [{ relations = [] }, hidden] = await Promise.all([get(`${path(projectId)}/relations`), hiddenTicketIds(get, projectId)]);
      return relations.filter((relation) => !hidden.has(relation.fromItemId) && !hidden.has(relation.toItemId)).map((relation) => [projectId, relation.id, relation.fromItemId, relation.toItemId, relation.relationType, relation.createdAt ?? null]);
    },
  },
  dependencies: {
    columns: [['project_id', 'TEXT'], ['id', 'TEXT'], ['predecessor_id', 'TEXT', 'item id'], ['successor_id', 'TEXT', 'item id'], ['type', 'TEXT', 'finish_to_start and the like'], ['lag_days', 'REAL']],
    async load(get, projectId) {
      const [{ dependencies = [] }, hidden] = await Promise.all([get(`${path(projectId)}/governance`), hiddenTicketIds(get, projectId)]);
      return dependencies.filter((entry) => !hidden.has(entry.predecessorId) && !hidden.has(entry.successorId)).map((entry) => [projectId, entry.id, entry.predecessorId, entry.successorId, entry.dependencyType ?? null, number(entry.lagDays)]);
    },
  },
  governance: {
    columns: [['project_id', 'TEXT'], ['id', 'TEXT'], ['kind', 'TEXT', 'risk, issue, assumption, decision or change_request'], ['title', 'TEXT'], ['status', 'TEXT'], ['probability', 'TEXT'], ['impact', 'TEXT'],
      ['owner_id', 'TEXT'], ['due_date', 'TEXT'], ['created_at', 'TEXT'], ['updated_at', 'TEXT']],
    async load(get, projectId) {
      const { items = [] } = await get(`${path(projectId)}/governance`);
      return items.map((entry) => [projectId, entry.id, entry.kind ?? null, entry.title ?? '', entry.status ?? null, entry.probability ?? null, entry.impact ?? null, entry.ownerId ?? null, day(entry.dueDate), entry.createdAt ?? null, entry.updatedAt ?? null]);
    },
  },
  milestones: {
    columns: [['project_id', 'TEXT'], ['id', 'TEXT'], ['title', 'TEXT'], ['status', 'TEXT'], ['target_date', 'TEXT'], ['item_id', 'TEXT']],
    async load(get, projectId) {
      const [{ milestones = [] }, hidden] = await Promise.all([get(`${path(projectId)}/governance`), hiddenTicketIds(get, projectId)]);
      return milestones.map((entry) => [projectId, entry.id, entry.title ?? '', entry.status ?? null, day(entry.targetDate), hidden.has(entry.workItemId) ? null : entry.workItemId ?? null]);
    },
  },
  tickets: {
    columns: [['project_id', 'TEXT'], ['id', 'TEXT'], ['name', 'TEXT'], ['status', 'TEXT'], ['severity', 'TEXT'], ['category', 'TEXT'], ['priority', 'TEXT'], ['assignee_id', 'TEXT'], ['assignee', 'TEXT'], ['updated_at', 'TEXT']],
    async load(get, projectId) {
      const { tickets = [] } = await get(`${path(projectId)}/tickets`);
      return tickets.filter(isTicketVisibleToAssistant).map((ticket) => [projectId, ticket.id, ticket.name ?? '', ticket.status ?? null, ticket.severity ?? null, ticket.category ?? null, ticket.priority === null || ticket.priority === undefined ? null : String(ticket.priority), ticket.assigneeId ?? null, ticket.assigneeName ?? null, ticket.updatedAt ?? null]);
    },
  },
};

// The schema as the model sees it, in odin_query's description.
export function querySchemaText() {
  return Object.entries(QUERY_TABLES).map(([name, table]) => `${name}(${table.columns.map(([column, , meaning]) => (meaning ? `${column}: ${meaning}` : column)).join(', ')})`).join('\n');
}

export function referencedTables(sql) {
  return Object.keys(QUERY_TABLES).filter((name) => new RegExp(`\\b${name}\\b`, 'i').test(sql));
}

function checkSql(sql) {
  const body = String(sql ?? '').replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, '').trim().replace(/;\s*$/, '');
  if (!/^(select|with)\b/i.test(body)) return { error: 'Only a single SELECT (or WITH … SELECT) query is allowed.' };
  if (body.includes(';')) return { error: 'Send one statement at a time.' };
  return { body };
}

function runInWorker(workerData, timeoutMs) {
  return new Promise((resolve) => {
    const worker = new Worker(WORKER_URL, { execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 256 }, workerData });
    const timer = setTimeout(() => { worker.terminate(); resolve({ error: `The query took longer than ${timeoutMs / 1000} s and was stopped. Simplify it or narrow it with WHERE`, ok: false }); }, timeoutMs);
    timer.unref?.();
    worker.once('message', (message) => { clearTimeout(timer); worker.terminate(); resolve(message); });
    worker.once('error', (error) => { clearTimeout(timer); resolve({ error: String(error?.message ?? error), ok: false }); });
  });
}

export function createOdinQuery({ api, projectId = null, timeoutMs = QUERY_TIMEOUT_MS }) {
  let reads = new Map();

  // GETs are shared within the turn until something is written. Governance is read in the agent
  // view, which leaves out links to tickets nobody has validated, deleted ones too (D-027).
  function get(pathname) {
    const query = pathname.endsWith('/governance') ? { agentView: 1 } : undefined;
    if (!reads.has(pathname)) reads.set(pathname, api.request('GET', pathname, query ? { query } : undefined).catch((error) => { reads.delete(pathname); throw error; }));
    return reads.get(pathname);
  }
  const listProjects = async () => (await get('/api/projects')).projects ?? [];

  async function scopeFor({ allProjects = false, projectIds = [] }) {
    if (projectIds.length) return [...new Set(projectIds)].slice(0, MAX_PROJECTS);
    if (projectId && !allProjects) return [projectId];
    return (await listProjects()).map((project) => project.id).slice(0, MAX_PROJECTS);
  }

  async function tableRows(name, projectIds) {
    if (name === 'projects') {
      const wanted = new Set(projectIds);
      return (await listProjects()).filter((project) => wanted.has(project.id))
        .map((project) => [project.id, project.name ?? '', project.status ?? null, day(project.startDate), day(project.endDate), project.role ?? null, project.createdAt ?? null, project.updatedAt ?? null]);
    }
    return (await Promise.all(projectIds.map((id) => QUERY_TABLES[name].load(get, id)))).flat();
  }

  return {
    // After a write the cached tables may be stale.
    invalidate() { reads = new Map(); },

    async run({ allProjects = false, projectIds = [], sql }) {
      const checked = checkSql(sql);
      if (checked.error) return { ok: false, error: { code: 'invalid_query', message: checked.error } };
      const names = referencedTables(checked.body);
      if (!names.length) return { ok: false, error: { code: 'invalid_query', message: `Query at least one table: ${Object.keys(QUERY_TABLES).join(', ')}.` } };
      const scope = await scopeFor({ allProjects, projectIds });
      if (!scope.length) return { ok: false, error: { code: 'no_projects', message: 'There are no projects to query.' } };
      const tables = {};
      for (const name of names) tables[name] = { columns: QUERY_TABLES[name].columns.map(([column, type]) => [column, type]), rows: await tableRows(name, scope) };
      const result = await runInWorker({ maxCellChars: MAX_CELL_CHARS, maxRows: MAX_ROWS, maxScanRows: MAX_SCAN_ROWS, sql: checked.body, tables }, timeoutMs);
      if (!result.ok) return { ok: false, error: { code: 'query_error', message: `${result.error}. Tables: ${names.map((name) => `${name}(${QUERY_TABLES[name].columns.map(([column]) => column).join(', ')})`).join('; ')}` } };
      const shown = result.rows.length;
      return {
        ok: true,
        columns: result.columns,
        rows: result.rows,
        rowCount: result.rowCount,
        projects: scope.length,
        ...(shown < result.rowCount || result.more ? { note: `Showing ${shown} of ${result.more ? `more than ${result.rowCount}` : result.rowCount} rows. Aggregate, filter or add LIMIT for the rest.` } : {}),
      };
    },
  };
}
