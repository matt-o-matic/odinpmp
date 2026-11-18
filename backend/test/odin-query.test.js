import assert from 'node:assert/strict';
import test from 'node:test';

import { createOdinQuery, querySchemaText, referencedTables } from '../src/lib/agent/odin-query.js';
import { applyProjectEstimateRollups } from '../src/lib/projects/work-estimates.js';

// Shaped like GET /api/projects/:id: every item carries estimateOverride, and parents roll up.
const SHOP = applyProjectEstimateRollups({
  epics: [{
    estimateOverride: false, id: 'epic-1', name: 'Checkout', status: 'In Progress',
    stories: [
      { assigneeId: 'user-ada', assigneeName: 'Ada', estimateOverride: false, id: 'story-1', name: 'Pay by card', sprintId: 'sprint-1', status: 'Completed', tasks: [
        { assigneeId: 'user-ada', assigneeName: 'Ada', estimateOverride: false, id: 'task-1', name: 'Card form', points: 2, status: 'Completed', targetHourEstimate: 3 },
        { assigneeId: 'user-grace', assigneeName: 'Grace', estimateOverride: false, id: 'task-2', name: 'Fraud rules', points: 3, status: 'In Progress', targetEndDate: '2026-01-15', targetHourEstimate: 5 },
      ] },
      { estimateOverride: false, id: 'story-2', name: 'Receipts', points: 3, status: 'Not Started', targetHourEstimate: 4, tasks: [] },
      { estimateOverride: true, id: 'story-3', name: 'Refunds', points: 8, status: 'Not Started', targetHourEstimate: 20, tasks: [
        { estimateOverride: false, id: 'task-3', name: 'Refund API', points: 2, status: 'Not Started', targetHourEstimate: 6 },
      ] },
    ],
  }],
  id: 'project-1', name: 'Shop',
});

function fakeApi({ projects = { 'project-1': SHOP } } = {}) {
  const requests = [];
  return {
    requests,
    async request(method, path) {
      requests.push(`${method} ${path}`);
      if (path === '/api/projects') return { projects: Object.values(projects).map((project) => ({ id: project.id, name: project.name, status: 'Active' })) };
      const id = path.match(/^\/api\/projects\/([^/]+)/)?.[1] ?? path.match(/projects\/([^/]+)\/team$/)?.[1];
      if (!projects[id]) throw Object.assign(new Error('Odin resource was not found or is not accessible to the current user.'), { status: 404 });
      if (path === `/api/projects/${id}`) return { project: projects[id] };
      if (path.endsWith('/sprints')) return { sprints: [{ endDate: '2026-11-07', id: 'sprint-1', name: 'Sprint 1', startDate: '2026-10-24', status: 'active' }] };
      if (path.endsWith('/team')) return { allocations: [{ hoursPerWeek: 20, resourceId: 'res-ada', role: 'Developer' }, { hoursPerWeek: 10, resourceId: 'res-grace', role: 'QA' }], canSeeRates: false, directory: [{ billRate: 150, id: 'res-ada', name: 'Ada', userId: 'user-ada' }, { id: 'res-grace', name: 'Grace', userId: 'user-grace' }] };
      if (path.endsWith('/relations')) return { relations: [{ fromItemId: 'task-2', id: 'rel-1', relationType: 'blocks', toItemId: 'story-2' }] };
      if (path.endsWith('/governance')) return { dependencies: [], items: [{ id: 'risk-1', kind: 'risk', status: 'open', title: 'Card provider delay' }], milestones: [] };
      if (path.endsWith('/tickets')) {
        return { tickets: ['not_external', 'validated', 'pending', 'rejected'].map((externalReviewState) => ({ externalReviewState, id: `ticket-${externalReviewState}`, name: externalReviewState, status: 'Open' })) };
      }
      throw new Error(`Unexpected ${method} ${path}`);
    },
  };
}

test('one query answers what would take many reads: open and done work per person, exactly', async () => {
  const api = fakeApi();
  const query = createOdinQuery({ api, projectId: 'project-1' });
  const result = await query.run({ sql: "SELECT COALESCE(assignee, 'Unassigned') AS person, SUM(done = 1) AS done, SUM(done = 0) AS open, SUM(points) AS points FROM items WHERE type <> 'epic' GROUP BY person ORDER BY person" });
  assert.deepEqual(result.columns, ['person', 'done', 'open', 'points']);
  assert.deepEqual(result.rows, [['Ada', 2, 0, 7], ['Grace', 0, 1, 3], ['Unassigned', 0, 3, 13]]);
  assert.equal(result.rowCount, 3);
  assert.deepEqual(api.requests, ['GET /api/projects/project-1'], 'only the tables the query names are loaded');
});

test('tables join: load against allocation, what blocks what, sprint and late work', async () => {
  const query = createOdinQuery({ api: fakeApi(), projectId: 'project-1' });
  const load = await query.run({ sql: 'SELECT t.name, t.hours_per_week, t.bill_rate, SUM(i.points) AS open_points FROM team t LEFT JOIN items i ON i.assignee_id = t.user_id AND i.done = 0 GROUP BY t.name ORDER BY t.name' });
  assert.deepEqual(load.rows, [['Ada', 20, null, null], ['Grace', 10, null, 3]], 'rates stay hidden when the user may not see them');
  const blocked = await query.run({ sql: 'SELECT b.name AS blocker, x.name AS blocked FROM relations r JOIN items b ON b.id = r.from_id JOIN items x ON x.id = r.to_id WHERE r.type = \'blocks\'' });
  assert.deepEqual(blocked.rows, [['Fraud rules', 'Receipts']]);
  const late = await query.run({ sql: "SELECT i.name, s.name AS sprint FROM items i LEFT JOIN sprints s ON s.id = i.sprint_id WHERE i.done = 0 AND i.due_date < date('now')" });
  assert.deepEqual(late.rows, [['Fraud rules', null]]);
  const risks = await query.run({ sql: "SELECT title FROM governance WHERE kind = 'risk' AND status = 'open'" });
  assert.deepEqual(risks.rows, [['Card provider delay']]);
});

test('hours are each item\'s estimate, not its override flag, and leaf rows total without double counting', async () => {
  const query = createOdinQuery({ api: fakeApi(), projectId: 'project-1' });
  const items = await query.run({ sql: 'SELECT id, leaf, points, estimate_hours FROM items ORDER BY id' });
  assert.deepEqual(items.rows, [
    ['epic-1', 0, 16, 32],
    ['story-1', 0, 5, 8],
    ['story-2', 1, 3, 4],
    ['story-3', 0, 8, 20],
    ['task-1', 1, 2, 3],
    ['task-2', 1, 3, 5],
    ['task-3', 1, 2, 6],
  ], 'a story set by hand keeps its own estimate; the rest roll up from their children');
  const totals = await query.run({ sql: 'SELECT SUM(estimate_hours), SUM(points), SUM(estimate_hours) FILTER (WHERE done = 0) FROM items WHERE leaf = 1' });
  assert.deepEqual(totals.rows, [[18, 10, 15]]);
});

test('queries are read-only, one statement, and say what is wrong', async () => {
  const query = createOdinQuery({ api: fakeApi(), projectId: 'project-1' });
  for (const sql of ['DELETE FROM items', 'UPDATE items SET status = 1', 'SELECT 1; DROP TABLE items', 'PRAGMA table_info(items)']) {
    const result = await query.run({ sql });
    assert.equal(result.ok, false, sql);
    assert.equal(result.error.code, 'invalid_query', sql);
  }
  assert.match((await query.run({ sql: 'SELECT 1' })).error.message, /Query at least one table: projects, items/);
  const typo = await query.run({ sql: 'SELECT owner FROM items' });
  assert.match(typo.error.message, /no such column: owner\. Tables: items\(id, project_id, type/);
  assert.ok((await query.run({ sql: '-- open work\nSELECT COUNT(*) FROM items WHERE done = 0;' })).ok, 'a comment and a trailing semicolon are fine');
});

test('a runaway query is stopped, and big results come back capped with a note', async () => {
  const query = createOdinQuery({ api: fakeApi(), projectId: 'project-1', timeoutMs: 600 });
  const started = Date.now();
  const runaway = await query.run({ sql: 'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT COUNT(*) FROM n, items' });
  assert.equal(runaway.ok, false);
  assert.match(runaway.error.message, /took longer than 0\.6 s and was stopped/);
  assert.ok(Date.now() - started < 3000);
  const many = await query.run({ sql: 'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 500) SELECT x, (SELECT COUNT(*) FROM items) AS items FROM n' });
  assert.equal(many.rows.length, 200);
  assert.equal(many.rowCount, 500);
  assert.match(many.note, /Showing 200 of 500 rows/);
});

test('reads are shared within a turn until a write, and scope can cover every project the user sees', async () => {
  const api = fakeApi({ projects: { 'project-1': SHOP, 'project-2': { epics: [{ id: 'epic-9', name: 'Ops', status: 'Not Started', stories: [] }], id: 'project-2', name: 'Ops' } } });
  const query = createOdinQuery({ api, projectId: 'project-1' });
  await query.run({ sql: 'SELECT COUNT(*) FROM items' });
  await query.run({ sql: 'SELECT name FROM items' });
  assert.equal(api.requests.filter((request) => request === 'GET /api/projects/project-1').length, 1);
  query.invalidate();
  await query.run({ sql: 'SELECT name FROM items' });
  assert.equal(api.requests.filter((request) => request === 'GET /api/projects/project-1').length, 2);

  const everywhere = await query.run({ allProjects: true, sql: 'SELECT p.name, COUNT(i.id) FROM projects p LEFT JOIN items i ON i.project_id = p.id GROUP BY p.name ORDER BY p.name' });
  assert.deepEqual(everywhere.rows, [['Ops', 1], ['Shop', 7]]);
  assert.equal(everywhere.projects, 2);
  const denied = await createOdinQuery({ api, projectId: 'project-1' }).run({ projectIds: ['project-x'], sql: 'SELECT * FROM items' }).catch((error) => error);
  assert.match(String(denied?.message ?? ''), /not accessible/);
});

test('the schema the model sees names every table and the meaning of the less obvious columns', () => {
  const schema = querySchemaText();
  for (const table of ['projects', 'items', 'sprints', 'team', 'relations', 'dependencies', 'governance', 'milestones', 'tickets']) assert.match(schema, new RegExp(`^${table}\\(`, 'm'));
  assert.match(schema, /done: 1 when the status counts as finished/);
  assert.deepEqual(referencedTables('select * from Items join TEAM using (x)'), ['items', 'team']);
});

test('the tickets table leaves out external tickets nobody has validated', async () => {
  const query = createOdinQuery({ api: fakeApi(), projectId: 'project-1' });
  const result = await query.run({ sql: 'SELECT id FROM tickets ORDER BY id' });
  assert.deepEqual(result.rows, [['ticket-not_external'], ['ticket-validated']]);
});

test('governance tables are read in the agent view, which leaves out links to hidden tickets', async () => {
  const api = fakeApi();
  const queries = [];
  const request = api.request.bind(api);
  api.request = async (method, path, options) => { queries.push([path, options?.query ?? null]); return request(method, path, options); };
  await createOdinQuery({ api, projectId: 'project-1' }).run({ sql: 'SELECT COUNT(*) FROM milestones' });
  assert.deepEqual(queries.find(([path]) => path.endsWith('/governance')), ['/api/projects/project-1/governance', { agentView: 1 }]);
});
