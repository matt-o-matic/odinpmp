// The pursuit board, settings and insights of the engagements fixture.
// Install after installEngagementsApi: Playwright tries the latest route first, and this one
// passes on everything it does not own.
const API_ORIGIN = 'http://localhost:3001';
const COLUMNS = ['Not Started', 'In Progress', 'Review', 'Completed'].map((status) => ({ defaultStatus: status, key: status.toLowerCase().replace(/\s+/g, '-'), name: status, statuses: [status] }));

function json(route, body, status = 200) {
  return route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status });
}

function addDays(days) {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

export async function installPursuitApi(page, { projectId = 'eng-northwind', sowLinked = true } = {}) {
  const calls = [];
  let insightsLoads = 0;
  let settings = { guestsSeeBoard: false, updatedAt: null, updatedBy: null, version: 0 };
  const tasks = [
    { assigneeId: 'user-pat', assigneeName: 'Pat Seller', description: '', id: 'task-deck', name: 'Kickoff deck', priority: 2, pursuit: true, status: 'In Progress', targetEndDate: addDays(3), version: 2 },
    { assigneeId: 'resource:res-casey', assigneeName: 'Casey Contractor', description: 'Current network diagrams from the customer.', id: 'task-diagrams', name: 'Network diagrams', priority: 4, pursuit: true, status: 'Not Started', targetEndDate: addDays(-1), version: 1 },
    { assigneeId: null, assigneeName: '', description: '', id: 'task-pricing', name: 'Pricing model', priority: 4, pursuit: true, status: 'Completed', targetEndDate: null, version: 3 },
  ];
  const story = () => ({ description: '', id: 'story-pursuit', name: 'Pursuit tasks', pursuit: true, status: 'Not Started', tasks: structuredClone(tasks) });
  const pursuitProject = () => ({ epics: [{ description: '', id: 'epic-pursuit', name: 'Pursuit', pursuit: true, status: 'Not Started', stories: [story()] }], id: projectId, tickets: [] });
  const card = (task) => ({ ...task, columnKey: COLUMNS.find((column) => column.statuses.includes(task.status))?.key ?? null, epicId: 'epic-pursuit', epicName: 'Pursuit', issueType: 'task', parentId: 'story-pursuit', parentName: 'Pursuit tasks', sprintId: null, storyId: 'story-pursuit', storyName: 'Pursuit tasks' });
  const insights = () => {
    const open = tasks.filter((task) => task.status !== 'Completed');
    return {
      asOf: '2026-11-14T12:00:00.000Z',
      cards: {
        activity: { data: { channels: [{ files: [0, 0, 1, 2, 0, 1, 3, 2], id: 'files', name: 'Files', posts: [0, 0, 0, 0, 0, 0, 0, 0] }], lastActivityAt: '2026-11-14T10:00:00.000Z', weeks: ['2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09'] }, message: '', status: 'ready' },
        age: { data: { daysOpen: 13, daysSinceActivity: 0, lastActivityAt: '2026-11-14T10:00:00.000Z', openedAt: '2026-11-01T10:00:00.000Z' }, message: '', status: 'ready' },
        people: { data: { counts: { active30: 2, active7: 1, guests: 1, members: 2 }, people: [{ active30: true, active7: true, id: 'user-pat', kind: 'member', lastActiveOn: '2026-11-14', name: 'Pat Seller' }, { active30: true, active7: false, id: 'user-synthetic', kind: 'member', lastActiveOn: '2026-11-02', name: 'Synthetic Demo' }, { active30: false, active7: false, id: 'stakeholder-ida', kind: 'guest', lastActiveOn: null, name: 'Ida Customer' }] }, message: '', status: 'ready' },
        sow: sowLinked
          ? { data: { history: [{ at: '2026-11-03T10:00:00.000Z', label: 'Drafting', state: 'drafting' }, { at: '2026-11-08T10:00:00.000Z', label: 'Shared for review', state: 'shared_for_review' }, { at: '2026-11-12T10:00:00.000Z', label: 'Awaiting signature', state: 'awaiting_signature' }], label: 'Awaiting signature', linked: true, state: 'awaiting_signature', title: 'Northwind data platform SOW', url: 'https://invoice.example/sows/41' }, message: '', status: 'ready' }
          : { data: { linked: false }, message: 'No SOW is linked to this engagement.', status: 'empty' },
        tasks: {
          data: {
            burnup: [{ date: '2026-11-01', done: 0, scope: 1 }, { date: '2026-11-05', done: 0, scope: 2 }, { date: '2026-11-09', done: 1, scope: 3 }, { date: '2026-11-14', done: tasks.length - open.length, scope: tasks.length }],
            counts: { done: tasks.length - open.length, open: open.length, overdue: open.filter((task) => task.targetEndDate && task.targetEndDate < addDays(0)).length, total: tasks.length },
            nextDue: open.filter((task) => task.targetEndDate && task.targetEndDate >= addDays(0)).map((task) => ({ assigneeName: task.assigneeName, dueDate: task.targetEndDate, id: task.id, name: task.name, status: task.status })),
          },
          message: '',
          status: 'ready',
        },
      },
      ok: true,
      project: { createdAt: '2026-11-01T10:00:00.000Z', id: projectId, kind: 'engagement', name: 'Northwind data platform' },
    };
  };

  await page.route(`${API_ORIGIN}/**`, async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const path = url.pathname;
    const body = () => request.postDataJSON() ?? {};
    const base = `/api/projects/${projectId}`;
    if (!path.startsWith(base) && path !== `/api/resource-planning/projects/${projectId}/team`) return route.fallback();
    const action = path.slice(base.length);

    if (path === `/api/resource-planning/projects/${projectId}/team`) {
      return json(route, { allocations: [], canManage: true, canSeeRates: false, directory: [{ id: 'res-casey', name: 'Casey Contractor', roles: [], status: 'active', userId: null, version: 1 }], people: [], projectId, users: [] });
    }
    if (method === 'GET' && action === '/pursuit') {
      return json(route, { epicId: 'epic-pursuit', ok: true, outsideAssignees: [{ guest: true, id: 'stakeholder:sh-gina', name: 'Gina Guest' }], project: pursuitProject(), settings, storyId: 'story-pursuit', taskCount: tasks.length, viewer: { canEdit: true, canManageSettings: true } });
    }
    if (action === '/kanban/config') {
      if (method === 'PUT') { calls.push({ body: body(), method, path: `${path}${url.search}` }); return json(route, { config: body(), ok: true }); }
      return json(route, { config: { assigneeIds: [], columns: COLUMNS, hideDone: false, includeBacklog: true, issueTypes: [], presets: [], search: '', selectedSprintIds: [], statusValues: [], swimlane: 'none' }, ok: true });
    }
    if (method === 'GET' && action === '/kanban') {
      calls.push({ method, path: `${path}${url.search}` });
      return json(route, { board: { cards: tasks.map(card), columns: COLUMNS, filters: {}, members: [], scope: 'pursuit', sprints: [], swimlane: 'none' }, ok: true });
    }
    if (method === 'POST' && action === '/kanban/reorder') {
      calls.push({ body: body(), method, path: `${path}${url.search}` });
      return json(route, { ok: true });
    }
    if (method === 'POST' && action === '/items') {
      const input = body();
      calls.push({ body: input, method, path });
      const task = { ...input.item, assigneeName: input.item.assigneeName ?? '', pursuit: true, version: 1 };
      tasks.push(task);
      return json(route, { item: task, ok: true, project: pursuitProject() }, 201);
    }
    const item = /^\/items\/([^/]+)$/.exec(action);
    if (method === 'PATCH' && item) {
      const input = body();
      calls.push({ body: input, method, path });
      const task = tasks.find((entry) => entry.id === item[1]);
      if (input.expectedVersion !== task.version) return json(route, { details: { code: 'project_item_version_conflict' }, error: 'Conflict', ok: false }, 409);
      Object.assign(task, input.patch, { version: task.version + 1 });
      return json(route, { item: task, ok: true, project: pursuitProject() });
    }
    if (action === '/settings') {
      if (method === 'PUT') {
        const input = body();
        calls.push({ body: input, method, path });
        if (input.expectedVersion !== settings.version) return json(route, { details: { code: 'settings_version_conflict' }, error: 'Conflict', ok: false }, 409);
        const { expectedVersion: _version, ...changes } = input;
        settings = { ...settings, ...changes, updatedBy: 'user-synthetic', version: settings.version + 1 };
        return json(route, { canManage: true, ok: true, settings });
      }
      return json(route, { canManage: true, ok: true, settings });
    }
    if (method === 'GET' && action === '/insights/pursuit') {
      insightsLoads += 1;
      return json(route, insights());
    }
    if (method === 'GET' && action === '/comments') return json(route, { comments: [], ok: true });
    if (method === 'GET' && action === '/files' && url.searchParams.get('targetType') === 'task') return json(route, { canWrite: true, files: [], ok: true });
    return route.fallback();
  });

  return {
    calls,
    get insightsLoads() { return insightsLoads; },
    get settings() { return settings; },
    task: (id) => tasks.find((task) => task.id === id),
  };
}
