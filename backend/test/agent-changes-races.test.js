import assert from 'node:assert/strict';
import test from 'node:test';

import { createChangeRecorder, snapshotVersions, undoChanges } from '../src/lib/agent/agent-changes.js';

const conflict = () => { throw Object.assign(new Error('conflict'), { status: 409 }); };

// A client through which a person's edits land once undo has read everything: at its first
// write, or at its first read of something it has read already.
function racing(api, edit) {
  const seen = new Set();
  let pending = edit;
  return {
    async request(method, path, options = {}) {
      const key = `${method} ${path} ${JSON.stringify(options.query ?? {})}`;
      if (pending && (method !== 'GET' || seen.has(key))) {
        pending();
        pending = null;
      }
      seen.add(key);
      return api.request(method, path, options);
    },
  };
}

const record = (id, touches, undo) => ({ id, label: id, status: 'applied', touches, undo, undoable: true });

test('a person\'s edit landing between undo\'s check and its write is never overwritten, whatever it edited', async () => {
  const story = { id: 'story-1', name: 'Pay', sprintId: 'sprint-2', tasks: [], version: 3 };
  const state = {
    allocations: [{ hoursPerWeek: 10, id: 'alloc-1', projectId: 'p1', resourceId: 'res-1', version: 2 }, { hoursPerWeek: 20, id: 'alloc-2', projectId: 'p1', resourceId: 'res-2', version: 2 }],
    calendar: { hoursPerDay: 6, version: 2 },
    calendarEntries: [{ id: 'cal-1', note: 'Off', resourceId: 'res-1', version: 2 }],
    contacts: [{ email: 'jo@example.com', id: 'sh-1', name: 'Jo', roleTitle: 'Owner' }],
    members: [{ id: 'me', role: 'admin' }, { id: 'max', role: 'manager' }],
    project: { assistantState: { brief: { summary: 'new' }, updatedAt: 'b2' }, description: '', epics: [{ id: 'epic-1', name: 'Checkout', stories: [story], version: 1 }], id: 'p1', name: 'Shop 2', status: 'Active', updatedAt: 'u2' },
    scratch: { epics: [], id: 'p2', name: 'Scratch', updatedAt: 'p2-1' },
    sprints: [{ endDate: null, goal: '', id: 's-1', name: 'Sprint 1b', startDate: null, status: 'active' }],
    timeEntries: [{ hours: 2, id: 'time-1', projectId: 'p1', version: 2, workDate: '2026-07-06' }],
    values: [{ fieldId: 'f-1', id: 'v-1', itemId: 'story-1', itemType: 'story', projectId: 'p1', value: 'high', version: 2 }],
  };
  const landed = [];
  const check = (name, expected, actual) => {
    if (String(expected) !== String(actual)) conflict();
    landed.push(name);
    return { ok: true };
  };
  const land = (name) => () => { landed.push(name); return { ok: true }; };
  const routes = {
    'GET /api/projects/p1': () => ({ project: state.project }),
    'GET /api/projects/p2': () => ({ permissions: { projectRole: 'admin' }, project: state.scratch }),
    'GET /api/projects/p1/valid-users': () => ({ project_users: state.members, tenant_users: [{ id: 'me' }, { id: 'max' }] }),
    'GET /api/projects/p2/valid-users': () => ({ project_users: [{ id: 'me', role: 'admin' }], tenant_users: [{ id: 'me' }] }),
    'GET /api/projects/p2/files': () => ({ files: [] }),
    'GET /api/projects/p2/comments': () => ({ comments: [] }),
    'GET /api/projects/p2/governance': () => ({ dependencies: [], items: [], milestones: [], scheduleBaselines: [], workingCalendar: null }),
    'GET /api/projects/p2/sprints': () => ({ sprints: [] }),
    'GET /api/projects/p2/requirements/tracks/experience/topics': () => ({ counts: { dismissed: 0, total: 0 } }),
    'GET /api/projects/p2/requirements/tracks/architecture/topics': () => ({ counts: { dismissed: 0, total: 0 } }),
    'GET /api/resource-planning/projects/p2/team': () => ({ allocations: [] }),
    'GET /api/resource-planning/time-entries': () => ({ entries: [] }),
    'GET /api/projects/p1/governance': () => ({ workingCalendar: state.calendar }),
    'GET /api/projects/p1/sprints': () => ({ sprints: state.sprints }),
    'GET /api/assistant/projects/p1/clarifications': () => ({ stakeholderContacts: state.contacts }),
    'GET /api/workflows': () => ({ customFields: [], customValues: state.values }),
    'GET /api/resource-planning/projects/p1/team': () => ({ allocations: state.allocations, directory: [], people: [] }),
    'GET /api/resource-planning': () => ({ allocations: [], calendarEntries: state.calendarEntries, resources: [], timeEntries: state.timeEntries, total: 1 }),
    'PUT /api/projects/p1': (body) => check('project', body.expectedUpdatedAt, state.project.updatedAt),
    'PATCH /api/projects/p1/assistant-brief': (body) => check('brief', body.expectedUpdatedAt, state.project.assistantState.updatedAt),
    'PUT /api/projects/p1/governance/working-calendar': (body) => check('calendar', body.expectedVersion, state.calendar.version),
    'PUT /api/workflows/custom-values': (body) => check('custom value', body.expectedVersion, state.values[0].version),
    'PATCH /api/resource-planning/projects/p1/allocations/alloc-1': (body) => check('allocation', body.expectedVersion, state.allocations[0].version),
    'PATCH /api/resource-planning/calendar-entries/cal-1': (body) => check('time off', body.expectedVersion, state.calendarEntries[0].version),
    'DELETE /api/resource-planning/time-entries/time-1': (body) => check('time entry', body.expectedVersion, state.timeEntries[0].version),
    'DELETE /api/resource-planning/projects/p1/allocations/alloc-2': (body) => check('team', body.expectedVersion, state.allocations[1].version),
    'PUT /api/projects/p1/sprints/s-1': land('sprint'),
    'PATCH /api/assistant/projects/p1/stakeholder-contacts/sh-1': land('stakeholder'),
    'PUT /api/projects/p1/permissions': land('members'),
    'POST /api/projects/p1/sprints/assign-items': land('sprint move'),
    'DELETE /api/projects/p2': land('project deleted'),
  };
  const api = {
    async request(method, path, { body, query } = {}) {
      const route = routes[`${method} ${path}`];
      if (!route) throw new Error(`Unexpected ${method} ${path}`);
      // A copy, as over HTTP: what undo read must not change under it.
      return structuredClone(route(body, query));
    },
  };
  const project = { id: 'p1', projectId: 'p1' };
  const records = [
    record('project details', [{ ...project, kind: 'project' }], { kind: 'put_project', projectId: 'p1', restore: { description: '', endDate: null, name: 'Shop', startDate: null, status: 'Active' } }),
    record('brief', [{ ...project, kind: 'brief' }], { kind: 'patch_brief', projectId: 'p1', restore: { summary: 'old' } }),
    record('calendar', [{ ...project, kind: 'workingCalendar' }], { kind: 'put_calendar', projectId: 'p1', restore: { hoursPerDay: 8 } }),
    record('custom value', [{ id: 'v-1', kind: 'customValue', projectId: 'p1' }], { id: 'v-1', kind: 'put_custom_value', projectId: 'p1', restore: { fieldId: 'f-1', itemId: 'story-1', itemType: 'story', projectId: 'p1', value: 'low' } }),
    record('allocation', [{ id: 'alloc-1', kind: 'allocation', projectId: 'p1' }], { id: 'alloc-1', kind: 'restore', of: 'allocation', projectId: 'p1', restore: { hoursPerWeek: 20 }, scoped: true }),
    record('time off', [{ id: 'cal-1', kind: 'timeOff', projectId: null }], { id: 'cal-1', kind: 'restore', of: 'timeOff', projectId: null, restore: { note: 'Trip' } }),
    record('time entry', [{ id: 'time-1', kind: 'timeEntry', projectId: 'p1' }], { id: 'time-1', kind: 'remove', of: 'timeEntry', projectId: 'p1', scoped: false }),
    record('team', [{ id: 'alloc-2', kind: 'allocation', projectId: 'p1' }], { allocationId: 'alloc-2', assigneeId: null, kind: 'remove_from_team', projectId: 'p1', resourceId: null, scoped: true }),
    record('sprint', [{ id: 's-1', kind: 'sprint', projectId: 'p1' }], { kind: 'put_sprint', projectId: 'p1', restore: { endDate: null, goal: '', name: 'Sprint 1', startDate: null, status: 'active' }, sprintId: 's-1' }),
    record('stakeholder', [{ id: 'sh-1', kind: 'stakeholder', projectId: 'p1' }], { kind: 'patch_stakeholder', projectId: 'p1', restore: { roleTitle: 'Sponsor' }, stakeholderId: 'sh-1' }),
    record('members', [{ id: 'max', kind: 'member', projectId: 'p1' }], { kind: 'members', members: [{ before: { project_allocation: null, project_bill_rate: null, role: 'user' }, id: 'max' }], projectId: 'p1' }),
    record('sprint move', [{ id: 'story-1', kind: 'item', projectId: 'p1' }], { assignments: [{ itemId: 'story-1', itemType: 'story', sprintId: null }], kind: 'assign_sprints', projectId: 'p1' }),
  ];
  const changes = { records, status: 'applied', versions: await snapshotVersions({ api, records }) };
  const person = () => {
    Object.assign(state.project, { name: 'Shop 3', updatedAt: 'u3' });
    state.project.assistantState.updatedAt = 'b3';
    state.calendar.version = 3;
    state.values[0].version = 3;
    state.allocations[0].version = 3;
    state.allocations[1].version = 3;
    state.calendarEntries[0].version = 3;
    state.timeEntries[0].version = 3;
    state.sprints[0].name = 'Sprint One';
    state.contacts[0].email = 'jo@new.example.com';
    state.members[1].role = 'admin';
    // A sprint move leaves an item's version as it was.
    story.sprintId = 'sprint-3';
  };
  const undone = await undoChanges({ api: racing(api, person), changes });
  assert.deepEqual(undone.records.map((entry) => [entry.id, entry.status, entry.note]), records.map((entry) => [entry.id, 'kept', 'Changed since, so it was left as it is.']));
  assert.deepEqual(landed, []);
});

test('a reversal with no reply to go on leaves the next change to that record to Odin\'s check', async () => {
  // Odin answered the first reversal without the milestone, so the second sends the version undo
  // checked, which Odin refuses: kept, not overwritten with a version read since.
  const milestone = { id: 'm-1', status: 'at_risk', targetDate: '2026-10-15', title: 'Launch', version: 3 };
  const sent = [];
  const api = {
    async request(method, path, { body } = {}) {
      if (method === 'GET' && path === '/api/projects/p1/governance') return structuredClone({ milestones: [milestone] });
      if (method === 'PATCH' && path === '/api/projects/p1/governance/milestones/m-1') {
        sent.push(body);
        if (body.expectedVersion !== milestone.version) conflict();
        Object.assign(milestone, body, { version: milestone.version + 1 });
        return { ok: true };
      }
      throw new Error(`Unexpected ${method} ${path}`);
    },
  };
  const touches = [{ id: 'm-1', kind: 'milestone', projectId: 'p1' }];
  const records = [
    record('status', touches, { id: 'm-1', kind: 'restore', of: 'milestone', projectId: 'p1', restore: { status: 'planned' } }),
    record('date', touches, { id: 'm-1', kind: 'restore', of: 'milestone', projectId: 'p1', restore: { targetDate: '2026-10-01' } }),
  ];
  const undone = await undoChanges({ api, changes: { records, status: 'applied', versions: { 'milestone:m-1': 3 } } });
  assert.deepEqual(undone.records.map((entry) => entry.status), ['kept', 'undone']);
  assert.deepEqual(sent.map((body) => body.expectedVersion), [3, 3]);
});

test('a reply carrying someone\'s edit made just after a write is never taken as the write\'s own', async () => {
  // MySQL can read a record back once its write has committed, so an edit landing in between
  // comes back in the reply. A write that sent a version left exactly the next one.
  const milestone = { id: 'm-1', status: 'planned', targetDate: '2026-10-01', title: 'Launch', version: 1 };
  const sent = [];
  let edit = null;
  const api = {
    async request(method, path, { body } = {}) {
      if (method === 'GET' && path === '/api/projects/p1/governance') return structuredClone({ milestones: [milestone] });
      if (method === 'PATCH' && path === '/api/projects/p1/governance/milestones/m-1') {
        sent.push(body.expectedVersion);
        if (body.expectedVersion !== milestone.version) conflict();
        const { expectedVersion: _expectedVersion, ...fields } = body;
        Object.assign(milestone, fields, { version: milestone.version + 1 });
        edit?.();
        edit = null;
        return structuredClone({ ok: true, value: milestone });
      }
      throw new Error(`Unexpected ${method} ${path}`);
    },
  };
  const person = (fields) => () => Object.assign(milestone, fields, { version: milestone.version + 1 });
  const patch = (body) => ['/api/projects/p1/governance/milestones/m-1', { body }];
  const turn = async (...bodies) => {
    const recorder = createChangeRecorder({ api });
    for (const body of bodies) await recorder.api.request('PATCH', ...patch(body));
    const records = recorder.records();
    return { records, status: 'applied', versions: await snapshotVersions({ api, records }) };
  };

  edit = person({ status: 'missed' });
  const first = await turn({ expectedVersion: 1, status: 'at_risk' });
  assert.equal(first.versions['milestone:m-1'], 2);
  assert.deepEqual((await undoChanges({ api, changes: first })).records.map((record) => record.status), ['kept']);
  assert.equal(milestone.status, 'missed');

  // Two changes to one record: the reply to undo's first reversal carries an edit made just after it.
  Object.assign(milestone, { status: 'planned', version: 10 });
  const second = await turn({ expectedVersion: 10, status: 'at_risk' }, { expectedVersion: 11, targetDate: '2026-10-15' });
  sent.length = 0;
  edit = person({ status: 'achieved' });
  assert.deepEqual((await undoChanges({ api, changes: second })).records.map((record) => record.status), ['kept', 'undone']);
  assert.deepEqual(sent, [12, 13]);
  assert.deepEqual([milestone.status, milestone.targetDate], ['achieved', '2026-10-01']);
});
