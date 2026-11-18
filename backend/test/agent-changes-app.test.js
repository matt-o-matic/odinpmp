import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import request from 'supertest';

import { createChangeRecorder, snapshotVersions, undoChanges, undoSummary } from '../src/lib/agent/agent-changes.js';
import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemoryResourceFinanceRepository } from '../src/modules/resource-finance/resource-finance.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';

// The recorder and undo against Odin's real routes and in-memory repositories, so each reversal
// is checked against the request shape the route really takes.

async function fixture() {
  const users = [
    { authMethod: 'basic', email: 'admin@example.com', id: 'admin', memberships: [{ role: 'admin', tenantId: 'tenant-1' }], name: 'Ada Admin', password: 'Secret123!' },
    { authMethod: 'basic', email: 'member@example.com', id: 'member', memberships: [{ role: 'user', tenantId: 'tenant-1' }], name: 'Max Member', password: 'Secret123!' },
    { authMethod: 'basic', email: 'newcomer@example.com', id: 'newcomer', memberships: [{ role: 'user', tenantId: 'tenant-1' }], name: 'Nia Newcomer', password: 'Secret123!' },
  ];
  const authRepository = await createInMemoryAuthRepository({ disableDemoUser: true, tenants: [{ domains: ['example.com'], id: 'tenant-1', name: 'Tenant' }], users });
  const projectRepository = createInMemoryProjectsRepository({
    authRepository,
    seed: {
      projectMemberships: { 'project-1': [{ id: 'admin', role: 'admin' }, { id: 'member', role: 'user' }] },
      projects: [{
        endDate: '2026-12-31', epics: [{ id: 'epic-1', name: 'Checkout', stories: [{
          id: 'story-1', name: 'Pay by card', tasks: [{ id: 'task-1', name: 'Card form' }, { id: 'task-2', name: 'Card errors' }, { id: 'task-3', name: 'Receipts' }],
        }] }], id: 'project-1', name: 'Shop', startDate: '2026-07-01', status: 'In Progress', tenantId: 'tenant-1', updatedAt: '2026-07-01T00:00:00.000Z',
      }],
    },
  });
  const tokenService = createTokenService({ issuer: 'test', secret: 'agent-changes-test-secret-that-is-long-enough' });
  const sessionsRepository = createInMemorySessionsRepository();
  const tokens = new Map();
  for (const user of users) {
    const token = tokenService.signSessionToken(user);
    await sessionsRepository.createSession({ expiryDate: new Date(tokenService.verifySessionToken(token).exp * 1000), token, userId: user.id });
    tokens.set(user.id, token);
  }
  const app = createApp({ agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0, authRepository, domainEventSweepIntervalMs: 0, projectRepository, resourceFinanceRepository: createInMemoryResourceFinanceRepository(), sessionsRepository, tokenService });
  // An API client like the assistant's: Odin's routes as the user, failures thrown with their status.
  const api = (userId = 'admin') => ({
    async request(method, path, { body, query } = {}) {
      let call = request(app)[method.toLowerCase()](path).set('Authorization', `Bearer ${tokens.get(userId)}`);
      if (query) call = call.query(query);
      const response = await (body === undefined ? call : call.send(body));
      if (response.status >= 400 || response.body?.ok === false) throw Object.assign(new Error(`${method} ${path}: ${response.status} ${JSON.stringify(response.body).slice(0, 300)}`), { status: response.status });
      return response.body;
    },
  });
  return { api, projectRepository };
}

// Runs writes through a recorder as one turn, then returns what the turn changed, as stored.
async function turn(api, writes) {
  const recorder = createChangeRecorder({ api });
  for (const [method, path, body] of writes) await recorder.api.request(method, path, body === undefined ? {} : { body });
  const records = recorder.records();
  return { records, status: 'applied', versions: await snapshotVersions({ api, records }) };
}

const labels = (changes) => changes.records.map((record) => [record.label, record.undoable]);
const statuses = (changes) => changes.records.map((record) => record.status);

test('milestones, dependencies, a governance item and the working calendar go back as they were', async () => {
  const { api } = await fixture();
  const odin = api();
  const governance = () => odin.request('GET', '/api/projects/project-1/governance');
  await odin.request('PUT', '/api/projects/project-1/governance/working-calendar', { body: { expectedVersion: null, hoursPerDay: 8 } });
  const launch = (await odin.request('POST', '/api/projects/project-1/governance/milestones', { body: { targetDate: '2026-10-01', title: 'Launch' } })).value;
  const old = (await odin.request('POST', '/api/projects/project-1/governance/dependencies', { body: { dependencyType: 'SS', lagDays: 2, predecessorId: 'task-2', successorId: 'task-3' } })).value;
  const kept = (await odin.request('POST', '/api/projects/project-1/governance/dependencies', { body: { predecessorId: 'task-1', successorId: 'task-3' } })).value;

  const changes = await turn(odin, [
    ['POST', '/api/projects/project-1/governance/milestones', { targetDate: '2026-11-01', title: 'Beta' }],
    ['PATCH', `/api/projects/project-1/governance/milestones/${launch.id}`, { expectedVersion: 1, status: 'at_risk', targetDate: '2026-10-15' }],
    ['POST', '/api/projects/project-1/governance/dependencies', { predecessorId: 'task-1', successorId: 'task-2' }],
    ['PATCH', `/api/projects/project-1/governance/dependencies/${kept.id}`, { dependencyType: 'FF', expectedVersion: 1, lagDays: 1, predecessorId: 'task-1', successorId: 'task-3' }],
    ['DELETE', `/api/projects/project-1/governance/dependencies/${old.id}`, { expectedVersion: 1 }],
    ['POST', '/api/projects/project-1/governance/items', { kind: 'risk', title: 'Card provider outage' }],
    ['PUT', '/api/projects/project-1/governance/working-calendar', { expectedVersion: 1, hoursPerDay: 6, workingDays: [1, 2, 3, 4] }],
  ]);
  assert.deepEqual(labels(changes), [
    ['Added milestone "Beta"', true],
    ['Updated milestone "Launch": status, target date', true],
    ['Made "Card errors" wait on "Card form"', true],
    ['Changed how "Receipts" waits on "Card form"', true],
    ['Removed the dependency of "Receipts" on "Card errors"', true],
    ['Logged risk "Card provider outage"', true],
    ['Changed the working calendar', true],
  ]);

  const undone = await undoChanges({ api: odin, changes });
  assert.deepEqual(statuses(undone), Array(7).fill('undone'), JSON.stringify(undone.records.map((record) => record.note)));
  const after = await governance();
  assert.deepEqual(after.milestones.map(({ status, targetDate, title }) => [title, status, targetDate]), [['Launch', 'planned', '2026-10-01']]);
  assert.deepEqual(after.dependencies.map(({ dependencyType, lagDays, predecessorId, successorId }) => [predecessorId, successorId, dependencyType, lagDays]).sort(), [['task-1', 'task-3', 'FS', 0], ['task-2', 'task-3', 'SS', 2]]);
  assert.deepEqual(after.items, []);
  assert.deepEqual([after.workingCalendar.hoursPerDay, after.workingCalendar.workingDays], [8, [1, 2, 3, 4, 5]]);
});

test('a milestone edited since the turn is left as it is', async () => {
  const { api } = await fixture();
  const odin = api();
  const changes = await turn(odin, [['POST', '/api/projects/project-1/governance/milestones', { targetDate: '2026-11-01', title: 'Beta' }]]);
  const beta = (await odin.request('GET', '/api/projects/project-1/governance')).milestones[0];
  await odin.request('PATCH', `/api/projects/project-1/governance/milestones/${beta.id}`, { body: { expectedVersion: 1, title: 'Public beta' } });
  const undone = await undoChanges({ api: odin, changes });
  assert.deepEqual(statuses(undone), ['kept']);
  assert.equal((await odin.request('GET', '/api/projects/project-1/governance')).milestones.length, 1);
});

test('starting and completing a sprint go back to planned; a new sprint and a ticket are said plainly', async () => {
  const { api } = await fixture();
  const odin = api();
  const sprint = (await odin.request('POST', '/api/projects/project-1/sprints', { body: { name: 'Sprint 1' } })).sprint;
  const changes = await turn(odin, [
    ['POST', '/api/projects/project-1/sprints', { name: 'Sprint 2' }],
    ['POST', `/api/projects/project-1/sprints/${sprint.id}/activate`],
    ['POST', `/api/projects/project-1/sprints/${sprint.id}/activate`],
    ['POST', `/api/projects/project-1/sprints/${sprint.id}/complete`],
    ['POST', '/api/projects/project-1/items', { item: { name: 'Card declined twice' }, itemType: 'ticket', parentId: null }],
  ]);
  assert.deepEqual(labels(changes), [
    ['Created sprint "Sprint 2"', false],
    ['Started sprint "Sprint 1"', true],
    ['Completed sprint "Sprint 1"', true],
    ['Created ticket "Card declined twice"', true],
  ], 'starting a sprint that was already active changed nothing');

  const undone = await undoChanges({ api: odin, changes });
  assert.deepEqual(statuses(undone), ['not_undoable', 'undone', 'undone', 'undone'], JSON.stringify(undone.records.map((record) => record.note)));
  const { sprints } = await odin.request('GET', '/api/projects/project-1/sprints');
  assert.deepEqual(sprints.map(({ name, status }) => [name, status]), [['Sprint 1', 'planned'], ['Sprint 2', 'planned']]);
  assert.deepEqual((await odin.request('GET', '/api/projects/project-1')).project.tickets ?? [], []);
});

test('member changes are undone member by member, and a member someone changed since is left alone', async () => {
  const { api } = await fixture();
  const odin = api();
  const members = async () => (await odin.request('GET', '/api/projects/project-1/valid-users')).project_users.map(({ id, role }) => [id, role]).sort();
  const changes = await turn(odin, [['PUT', '/api/projects/project-1/permissions', { validUsers: [{ id: 'admin', role: 'admin' }, { id: 'member', role: 'manager' }, { id: 'newcomer', role: 'user' }] }]]);
  assert.deepEqual(labels(changes), [['Changed Max Member\'s project role to manager; added Nia Newcomer to the project as a member', true]]);
  assert.deepEqual(statuses(await undoChanges({ api: odin, changes })), ['undone']);
  assert.deepEqual(await members(), [['admin', 'admin'], ['member', 'user']]);

  const removal = await turn(odin, [['PUT', '/api/projects/project-1/permissions', { validUsers: [{ id: 'admin', role: 'admin' }] }]]);
  assert.deepEqual(labels(removal), [['Removed Max Member from the project', true]]);
  await odin.request('PUT', '/api/projects/project-1/permissions', { body: { validUsers: [{ id: 'admin', role: 'admin' }, { id: 'member', role: 'manager' }] } });
  const undone = await undoChanges({ api: odin, changes: removal });
  assert.deepEqual(statuses(undone), ['kept']);
  assert.deepEqual(await members(), [['admin', 'admin'], ['member', 'manager']]);
});

test('someone added to the team leaves with their new profile, unless they own work by then', async () => {
  const { api } = await fixture();
  const odin = api();
  const team = () => odin.request('GET', '/api/resource-planning/projects/project-1/team');
  const changes = await turn(odin, [['POST', '/api/resource-planning/projects/project-1/resources', { allocation: { hoursPerWeek: 20 }, name: 'Casey Contractor' }]]);
  assert.deepEqual(labels(changes), [['Added Casey Contractor to the project team', true]]);
  assert.deepEqual(statuses(await undoChanges({ api: odin, changes })), ['undone']);
  const after = await team();
  assert.deepEqual([after.allocations, after.directory.filter((resource) => resource.name === 'Casey Contractor')], [[], []]);

  const again = await turn(odin, [['POST', '/api/resource-planning/projects/project-1/resources', { allocation: { hoursPerWeek: 20 }, name: 'Dana Designer' }]]);
  const { project } = await odin.request('GET', '/api/projects/project-1');
  const task = project.epics[0].stories[0].tasks[0];
  const assigneeId = (await team()).people[0].assigneeId;
  await odin.request('PATCH', '/api/projects/project-1/items/task-1', { body: { expectedVersion: Number(task.version), patch: { assigneeId } } });
  const undone = await undoChanges({ api: odin, changes: again });
  assert.deepEqual([statuses(undone), undone.records[0].note], [['kept'], 'They own work on the project now, so they were left on the team.']);
  assert.equal((await team()).allocations.length, 1);
});

test('a profile edit and task access go back as they were; an emailed link is listed but stays sent', async () => {
  const { api } = await fixture();
  const odin = api();
  const base = '/api/resource-planning/projects/project-1';
  const { resource } = await odin.request('POST', `${base}/resources`, { body: { name: 'Casey Contractor' } });
  const access = async () => (await odin.request('GET', `${base}/task-access`)).entries.map(({ email, name, scope }) => [name, email, scope]);

  const changes = await turn(odin, [
    ['PATCH', `${base}/resources/${resource.id}`, { email: 'casey@vendor.example', expectedVersion: resource.version, name: 'Casey C.' }],
    ['PUT', `${base}/task-access/${resource.id}`, { scope: 'own' }],
    ['PUT', `${base}/task-access/${resource.id}`, { scope: 'own' }],
    ['POST', `${base}/task-access/${resource.id}/link`, { delivery: 'email' }],
  ]);
  // Setting the scope it already had changes nothing, so it isn't listed.
  assert.deepEqual(labels(changes), [
    ['Updated Casey Contractor\'s profile: email, name', true],
    ['Gave Casey C. task access to their own work', true],
    ['Emailed Casey C. their task access link at casey@vendor.example', false],
  ]);
  assert.deepEqual(await access(), [['Casey C.', 'casey@vendor.example', 'own']]);
  const undone = await undoChanges({ api: odin, changes });
  assert.deepEqual(statuses(undone), ['undone', 'undone', 'not_undoable'], JSON.stringify(undone.records.map((record) => record.note)));
  assert.deepEqual(await access(), [['Casey Contractor', null, 'off']]);

  // Access someone changed since is left as it is.
  const again = await turn(odin, [['PUT', `${base}/task-access/${resource.id}`, { scope: 'off' }]]);
  assert.deepEqual(labels(again), []);
  const { resource: current } = await odin.request('PATCH', `${base}/resources/${resource.id}`, { body: { email: 'casey@vendor.example', expectedVersion: (await odin.request('GET', `${base}/team`)).people[0].resource.version } });
  const granted = await turn(odin, [['PUT', `${base}/task-access/${current.id}`, { scope: 'all' }]]);
  await odin.request('PUT', `${base}/task-access/${current.id}`, { body: { scope: 'own' } });
  assert.deepEqual(statuses(await undoChanges({ api: odin, changes: granted })), ['kept']);
  assert.deepEqual(await access(), [['Casey Contractor', 'casey@vendor.example', 'own']]);
});

test('time logged, changed and deleted is put back, deleted time logged again as it was', async () => {
  const { api } = await fixture();
  const odin = api();
  const resource = (await odin.request('POST', '/api/resource-planning/resources', { body: { name: 'Ada Admin', userId: 'admin' } })).value;
  const entries = async () => (await odin.request('GET', '/api/resource-planning', { query: { projectId: 'project-1' } })).timeEntries.map(({ hours, note, status, workDate, workItemId }) => [workDate, hours, note, status, workItemId]).sort();
  const first = (await odin.request('POST', '/api/resource-planning/time-entries', { body: { hours: 2, note: 'Pairing', projectId: 'project-1', resourceId: resource.id, status: 'approved', workDate: '2026-07-06' } })).value;
  const second = (await odin.request('POST', '/api/resource-planning/time-entries', { body: { hours: 1, projectId: 'project-1', resourceId: resource.id, workDate: '2026-07-07' } })).value;
  const before = await entries();

  const changes = await turn(odin, [
    ['POST', '/api/resource-planning/time-entries', { hours: 3, projectId: 'project-1', resourceId: resource.id, workDate: '2026-07-08', workItemId: 'task-1' }],
    ['PATCH', `/api/resource-planning/time-entries/${second.id}`, { expectedVersion: 1, hours: 1.5, note: 'Longer than planned' }],
    ['DELETE', `/api/resource-planning/time-entries/${first.id}`, { expectedVersion: 1 }],
  ]);
  assert.deepEqual(labels(changes), [
    ['Logged 3h on "Card form"', true],
    ['Updated 1h logged for 2026-07-07: hours, note', true],
    ['Deleted 2h logged for 2026-07-06', true],
  ]);
  const undone = await undoChanges({ api: odin, changes });
  assert.deepEqual(statuses(undone), ['undone', 'undone', 'undone'], JSON.stringify(undone.records.map((record) => record.note)));
  assert.deepEqual(await entries(), before);
  assert.equal(undoSummary(undone), 'Undid 3 changes.');
});

test('creating a project is listed but never undone: work can arrive in it without moving its version', async () => {
  const { api } = await fixture();
  const odin = api();
  const changes = await turn(odin, [['POST', '/api/projects', { name: 'Loyalty', status: 'Planned' }]]);
  assert.deepEqual(labels(changes), [['Created project "Loyalty"', false]]);
  const undone = await undoChanges({ api: odin, changes });
  assert.deepEqual(statuses(undone), ['not_undoable']);
  assert.ok((await odin.request('GET', '/api/projects')).projects.some((project) => project.name === 'Loyalty'));
});

// A client that lets a person's edit land once, right after undo's first read of `path`: after
// undo has checked the record, before it writes.
function editAfterRead(api, path, edit) {
  let pending = edit;
  return {
    async request(method, pathname, options) {
      const result = await api.request(method, pathname, options);
      if (pending && method === 'GET' && pathname === path) {
        const run = pending;
        pending = null;
        await run();
      }
      return result;
    },
  };
}

test('an edit someone makes after undo checks a record, before it writes, is left as they made it', async () => {
  const { api } = await fixture();
  const odin = api();
  const launch = (await odin.request('POST', '/api/projects/project-1/governance/milestones', { body: { targetDate: '2026-10-01', title: 'Launch' } })).value;
  const task = (await odin.request('GET', '/api/projects/project-1')).project.epics[0].stories[0].tasks[0];
  const changes = await turn(odin, [
    ['PATCH', `/api/projects/project-1/governance/milestones/${launch.id}`, { expectedVersion: 1, targetDate: '2026-10-15' }],
    ['PATCH', '/api/projects/project-1/items/task-1', { expectedVersion: Number(task.version), patch: { name: 'Card form v2' } }],
  ]);
  assert.deepEqual(changes.versions[`milestone:${launch.id}`], 2);

  const person = api('admin');
  const racing = editAfterRead(editAfterRead(odin,
    '/api/projects/project-1/governance', () => person.request('PATCH', `/api/projects/project-1/governance/milestones/${launch.id}`, { body: { expectedVersion: 2, targetDate: '2026-12-01' } })),
    '/api/projects/project-1', () => person.request('PATCH', '/api/projects/project-1/items/task-1', { body: { expectedVersion: Number(task.version) + 1, patch: { name: 'Card form, final' } } }));
  const undone = await undoChanges({ api: racing, changes });
  assert.deepEqual(undone.records.map((record) => [record.status, record.note]), Array(2).fill(['kept', 'Changed since, so it was left as it is.']));
  const milestone = (await odin.request('GET', '/api/projects/project-1/governance')).milestones[0];
  assert.deepEqual([milestone.targetDate, milestone.version], ['2026-12-01', 3]);
  assert.equal((await odin.request('GET', '/api/projects/project-1')).project.epics[0].stories[0].tasks[0].name, 'Card form, final');
});

test('changes to the same record are reversed in turn, each on the version the one before left', async () => {
  const { api } = await fixture();
  const odin = api();
  const launch = (await odin.request('POST', '/api/projects/project-1/governance/milestones', { body: { targetDate: '2026-10-01', title: 'Launch' } })).value;
  const task = (await odin.request('GET', '/api/projects/project-1')).project.epics[0].stories[0].tasks[0];
  const shop = (await odin.request('GET', '/api/projects/project-1')).project;
  const changes = await turn(odin, [
    ['PUT', '/api/projects/project-1', { description: '', endDate: '2026-12-31', expectedUpdatedAt: shop.updatedAt, name: 'Shop 2', startDate: '2026-07-01', status: 'In Progress' }],
    ['PATCH', `/api/projects/project-1/governance/milestones/${launch.id}`, { expectedVersion: 1, status: 'at_risk' }],
    ['PATCH', `/api/projects/project-1/governance/milestones/${launch.id}`, { expectedVersion: 2, targetDate: '2026-10-15' }],
    ['PATCH', '/api/projects/project-1/items/task-1', { expectedVersion: Number(task.version), patch: { name: 'Card form v2' } }],
    ['PATCH', '/api/projects/project-1/items/task-1', { expectedVersion: Number(task.version) + 1, patch: { priority: 1 } }],
    ['POST', '/api/projects/project-1/items', { item: { name: 'Wallets' }, itemType: 'epic', parentId: null }],
  ]);
  const undone = await undoChanges({ api: odin, changes });
  // Each item reversal moves the project's version; the details go back on the one it left.
  assert.deepEqual(statuses(undone), Array(6).fill('undone'), JSON.stringify(undone.records.map((record) => record.note)));
  const milestone = (await odin.request('GET', '/api/projects/project-1/governance')).milestones[0];
  assert.deepEqual([milestone.status, milestone.targetDate], ['planned', '2026-10-01']);
  const { project } = await odin.request('GET', '/api/projects/project-1');
  assert.deepEqual([project.name, project.epics.length, project.epics[0].stories[0].tasks[0].name, project.epics[0].stories[0].tasks[0].priority], ['Shop', 1, 'Card form', task.priority]);
});

test('an upload Odin keeps as a new file is deleted on undo', async () => {
  const { api } = await fixture();
  const odin = api();
  const upload = { fileContentsBase64: Buffer.from('# Notes').toString('base64'), fileName: 'notes.md', fileType: 'text/markdown', targetId: 'project-1', targetType: 'project' };
  const changes = await turn(odin, [['POST', '/api/projects/project-1/files', upload]]);
  assert.deepEqual(labels(changes), [['Uploaded "notes.md"', true]]);
  const [file] = (await odin.request('GET', '/api/projects/project-1/files', { query: { targetId: 'project-1', targetType: 'project' } })).files;
  assert.equal(file.signature, createHash('md5').update('# Notes').digest('hex'), 'the contents\' signature, as MySQL keeps it');
  assert.deepEqual(statuses(await undoChanges({ api: odin, changes })), ['undone']);
  assert.deepEqual((await odin.request('GET', '/api/projects/project-1/files', { query: { targetId: 'project-1', targetType: 'project' } })).files, []);
});

test('a person\'s edit landing after the assistant\'s write, while the turn goes on, is kept on undo', async () => {
  const { api } = await fixture();
  const odin = api();
  const person = api('admin');
  const story = async () => (await odin.request('GET', '/api/projects/project-1')).project.epics[0].stories[0];
  const resource = (await odin.request('POST', '/api/resource-planning/resources', { body: { name: 'Ada Admin', userId: 'admin' } })).value;
  const entry = (await odin.request('POST', '/api/resource-planning/time-entries', { body: { hours: 2, projectId: 'project-1', resourceId: resource.id, workDate: '2026-07-06' } })).value;
  const launch = (await odin.request('POST', '/api/projects/project-1/governance/milestones', { body: { targetDate: '2026-10-01', title: 'Launch' } })).value;

  const recorder = createChangeRecorder({ api: odin });
  await recorder.api.request('PATCH', '/api/projects/project-1/items/story-1', { body: { expectedVersion: Number((await story()).version), patch: { name: 'Pay by card or wallet' } } });
  await recorder.api.request('PATCH', `/api/projects/project-1/governance/milestones/${launch.id}`, { body: { expectedVersion: 1, targetDate: '2026-10-15' } });
  await recorder.api.request('PATCH', `/api/resource-planning/time-entries/${entry.id}`, { body: { expectedVersion: 1, hours: 3 } });
  // Before the turn ends, someone changes each record again.
  await person.request('PATCH', '/api/projects/project-1/items/story-1', { body: { expectedVersion: Number((await story()).version), patch: { name: 'Pay any way' } } });
  await person.request('PATCH', `/api/projects/project-1/governance/milestones/${launch.id}`, { body: { expectedVersion: 2, targetDate: '2026-12-01' } });
  await person.request('PATCH', `/api/resource-planning/time-entries/${entry.id}`, { body: { expectedVersion: 2, hours: 4 } });
  const records = recorder.records();
  const changes = { records, status: 'applied', versions: await snapshotVersions({ api: odin, records }) };

  const undone = await undoChanges({ api: odin, changes });
  assert.deepEqual(undone.records.map((record) => [record.status, record.note]), Array(3).fill(['kept', 'Changed since, so it was left as it is.']));
  assert.equal((await story()).name, 'Pay any way');
  assert.equal((await odin.request('GET', '/api/projects/project-1/governance')).milestones[0].targetDate, '2026-12-01');
  const { timeEntries } = await odin.request('GET', '/api/resource-planning', { query: { projectId: 'project-1' } });
  assert.equal(timeEntries.find((record) => record.id === entry.id).hours, 4);
});

test('linking items someone already linked changes nothing, and undo leaves their link', async () => {
  const { api } = await fixture();
  const odin = api();
  const blocks = { relationType: 'blocks', toItemId: 'task-2' };
  const theirs = await odin.request('POST', '/api/projects/project-1/items/task-1/relations', { body: blocks });
  assert.equal(theirs.created, true);
  const changes = await turn(odin, [
    ['POST', '/api/projects/project-1/items/task-1/relations', blocks],
    ['POST', '/api/projects/project-1/items/task-2/relations', { relationType: 'blocks', toItemId: 'task-3' }],
  ]);
  assert.deepEqual(labels(changes), [['Linked two items (blocks)', true]]);
  assert.deepEqual(statuses(await undoChanges({ api: odin, changes })), ['undone']);
  const { relations } = await odin.request('GET', '/api/projects/project-1/relations');
  assert.deepEqual(relations.map(({ id }) => id), [theirs.relation.id]);
});

test('a comment someone answered or edited since stays on undo, replies and all', async () => {
  const { api } = await fixture();
  // An admin moderates comments: their delete would take the replies with it.
  const odin = api();
  const target = { targetId: 'story-1', targetType: 'story' };
  const thread = async () => (await odin.request('GET', '/api/projects/project-1/comments', { query: target })).comments;
  const changes = await turn(odin, [
    ['POST', '/api/projects/project-1/comments', { ...target, comment: 'Card payments wait on the vendor.' }],
    ['POST', '/api/projects/project-1/comments', { ...target, comment: 'Receipts can wait.' }],
    ['POST', '/api/projects/project-1/comments', { ...target, comment: 'Nothing else for now.' }],
  ]);
  const [answered, edited] = changes.records.map((record) => record.undo.commentId);
  await api('member').request('POST', '/api/projects/project-1/comments', { body: { ...target, comment: 'Which vendor?', parentId: answered } });
  await odin.request('PUT', `/api/projects/project-1/comments/${edited}`, { body: { comment: 'Receipts can wait a sprint.' } });

  const undone = await undoChanges({ api: odin, changes });
  assert.deepEqual(undone.records.map((record) => [record.status, record.note ?? null]), [['kept', 'Changed since, so it was left as it is.'], ['kept', 'Changed since, so it was left as it is.'], ['undone', null]]);
  assert.deepEqual((await thread()).map(({ children, id }) => [id, children.length]), [[answered, 1], [edited, 0]]);
});

test('a delete that must not take replies with it is refused, in the same call, once someone replies', async () => {
  const { api, projectRepository } = await fixture();
  const odin = api();
  const target = { targetId: 'story-1', targetType: 'story' };
  const { comment } = await odin.request('POST', '/api/projects/project-1/comments', { body: { ...target, comment: 'Card payments wait on the vendor.' } });
  await api('member').request('POST', '/api/projects/project-1/comments', { body: { ...target, comment: 'Which vendor?', parentId: comment.id } });
  const admin = { id: 'admin', memberships: [{ role: 'admin', tenantId: 'tenant-1' }] };
  const remove = (withoutReplies) => projectRepository.deleteComment({ commentId: comment.id, projectId: 'project-1', tenantId: 'tenant-1', user: admin, withoutReplies });
  await assert.rejects(remove(true), (error) => error.statusCode === 409 && error.details?.code === 'comment_has_replies');
  assert.equal((await odin.request('GET', '/api/projects/project-1/comments', { query: target })).comments[0].children.length, 1);
  assert.equal(await remove(false), true);
  assert.deepEqual((await odin.request('GET', '/api/projects/project-1/comments', { query: target })).comments, []);
});

test('project details someone changes mid-turn are kept, though the turn\'s item writes move the project on', async () => {
  const { api } = await fixture();
  const odin = api();
  const shop = async () => (await odin.request('GET', '/api/projects/project-1')).project;
  const details = (project, name) => ({ description: '', endDate: project.endDate, expectedUpdatedAt: project.updatedAt, name, startDate: project.startDate, status: project.status });
  const recorder = createChangeRecorder({ api: odin });
  await recorder.api.request('PUT', '/api/projects/project-1', { body: details(await shop(), 'Shop 2') });
  await api('admin').request('PUT', '/api/projects/project-1', { body: details(await shop(), 'Storefront') });
  await recorder.api.request('POST', '/api/projects/project-1/items', { body: { item: { name: 'Wallets' }, itemType: 'epic', parentId: null } });
  const records = recorder.records();
  const undone = await undoChanges({ api: odin, changes: { records, status: 'applied', versions: await snapshotVersions({ api: odin, records }) } });
  assert.deepEqual(statuses(undone), ['kept', 'undone']);
  const project = await shop();
  assert.deepEqual([project.name, project.epics.length], ['Storefront', 1]);
});

test('an item someone moved to another sprint since the turn stays where they put it', async () => {
  const { api } = await fixture();
  const odin = api();
  const [first, second] = [(await odin.request('POST', '/api/projects/project-1/sprints', { body: { name: 'Sprint 1' } })).sprint, (await odin.request('POST', '/api/projects/project-1/sprints', { body: { name: 'Sprint 2' } })).sprint];
  const move = (sprintId) => ({ assignments: [{ itemId: 'task-1', itemType: 'task', sprintId }] });
  const changes = await turn(odin, [['POST', '/api/projects/project-1/sprints/assign-items', move(first.id)]]);
  // A sprint move leaves the item's version as it was.
  await odin.request('POST', '/api/projects/project-1/sprints/assign-items', { body: move(second.id) });
  assert.deepEqual(statuses(await undoChanges({ api: odin, changes })), ['kept']);
  assert.equal((await odin.request('GET', '/api/projects/project-1')).project.epics[0].stories[0].tasks[0].sprintId, second.id);
});

test('someone\'s edit between two of the turn\'s writes to a record stays: only the turn\'s later change goes back', async () => {
  const { api } = await fixture();
  const odin = api();
  const person = api('admin');
  const task = async () => (await odin.request('GET', '/api/projects/project-1')).project.epics[0].stories[0].tasks[0];
  const start = await task();
  const launch = (await odin.request('POST', '/api/projects/project-1/governance/milestones', { body: { targetDate: '2026-10-01', title: 'Launch' } })).value;
  const recorder = createChangeRecorder({ api: odin });
  await recorder.api.request('PATCH', '/api/projects/project-1/items/task-1', { body: { expectedVersion: Number(start.version), patch: { name: 'Card form v2' } } });
  await recorder.api.request('PATCH', `/api/projects/project-1/governance/milestones/${launch.id}`, { body: { expectedVersion: 1, status: 'at_risk' } });
  await person.request('PATCH', '/api/projects/project-1/items/task-1', { body: { expectedVersion: Number(start.version) + 1, patch: { name: 'Card entry form' } } });
  await person.request('PATCH', `/api/projects/project-1/governance/milestones/${launch.id}`, { body: { expectedVersion: 2, status: 'missed' } });
  await recorder.api.request('PATCH', '/api/projects/project-1/items/task-1', { body: { expectedVersion: Number(start.version) + 2, patch: { priority: 1 } } });
  // Deleted after their edit: brought back as they left it, and not taken back past it.
  await recorder.api.request('DELETE', `/api/projects/project-1/governance/milestones/${launch.id}`, { body: { expectedVersion: 3 } });
  const records = recorder.records();
  const undone = await undoChanges({ api: odin, changes: { records, status: 'applied', versions: await snapshotVersions({ api: odin, records }) } });
  const kept = ['kept', 'Changed since, so it was left as it is.'];
  assert.deepEqual(undone.records.map((record) => [record.status, record.note ?? null]), [kept, kept, ['undone', null], ['undone', null]]);
  const after = await task();
  assert.deepEqual([after.name, after.priority], ['Card entry form', start.priority]);
  const { milestones } = await odin.request('GET', '/api/projects/project-1/governance');
  assert.deepEqual(milestones.map(({ status, title }) => [title, status]), [['Launch', 'missed']]);
});

test('an item the turn made stays on undo once someone links to it, comments on it, attaches a file or logs time on it', async () => {
  const { api } = await fixture();
  const odin = api();
  const resource = (await odin.request('POST', '/api/resource-planning/resources', { body: { name: 'Ada Admin', userId: 'admin' } })).value;
  const task = (name) => ['POST', '/api/projects/project-1/items', { item: { name }, itemType: 'task', parentId: 'story-1' }];
  const changes = await turn(odin, [task('Linked'), task('Discussed'), task('Attached'), task('Timed'), task('Untouched')]);
  const [linked, discussed, attached, timed] = changes.records.map((record) => record.undo.itemId);
  const link = await odin.request('POST', '/api/projects/project-1/items/task-1/relations', { body: { relationType: 'blocks', toItemId: linked } });
  await api('member').request('POST', '/api/projects/project-1/comments', { body: { comment: 'Which card types?', targetId: discussed, targetType: 'task' } });
  await odin.request('POST', '/api/projects/project-1/files', { body: { fileContentsBase64: Buffer.from('# Mockup').toString('base64'), fileName: 'mockup.md', fileType: 'text/markdown', targetId: attached, targetType: 'task' } });
  await odin.request('POST', '/api/resource-planning/time-entries', { body: { hours: 1, projectId: 'project-1', resourceId: resource.id, workDate: '2026-07-06', workItemId: timed } });

  const undone = await undoChanges({ api: odin, changes });
  assert.deepEqual(undone.records.map((record) => [record.status, record.note ?? null]), [...Array(4).fill(['kept', 'Changed since, so it was left as it is.']), ['undone', null]]);
  const { project } = await odin.request('GET', '/api/projects/project-1');
  assert.deepEqual(project.epics[0].stories[0].tasks.map((entry) => entry.name), ['Card form', 'Card errors', 'Receipts', 'Linked', 'Discussed', 'Attached', 'Timed']);
  assert.deepEqual((await odin.request('GET', '/api/projects/project-1/relations')).relations.map(({ id }) => id), [link.relation.id]);
});

test('a comment someone edits after undo checks it, before it goes, stays as they wrote it', async () => {
  const { api } = await fixture();
  const odin = api();
  const target = { targetId: 'story-1', targetType: 'story' };
  const changes = await turn(odin, [['POST', '/api/projects/project-1/comments', { ...target, comment: 'Receipts can wait.' }]]);
  const { commentId } = changes.records[0].undo;
  const racing = editAfterRead(odin, '/api/projects/project-1/comments', () => odin.request('PUT', `/api/projects/project-1/comments/${commentId}`, { body: { comment: 'Receipts can wait a sprint.' } }));
  const undone = await undoChanges({ api: racing, changes });
  assert.deepEqual(undone.records.map((record) => [record.status, record.note]), [['kept', 'Changed since, so it was left as it is.']]);
  const { comments } = await odin.request('GET', '/api/projects/project-1/comments', { query: target });
  assert.deepEqual(comments.map(({ id }) => id), [commentId]);
  assert.match(comments[0].comment, /a sprint/);
});


test('a member undoes time the assistant logged for them', async () => {
  const { api } = await fixture();
  const admin = api('admin');
  const member = api('member');
  await admin.request('POST', '/api/resource-planning/resources', { body: { name: 'Max Member', userId: 'member' } });
  const changes = await turn(member, [['POST', '/api/resource-planning/projects/project-1/time-entries', { hours: 2, workDate: '2026-07-02', workItemId: 'task-1' }]]);
  assert.equal(changes.records[0].undoable, true, JSON.stringify(changes.records));
  assert.deepEqual(statuses(await undoChanges({ api: member, changes })), ['undone']);
  const { entries } = await member.request('GET', '/api/resource-planning/time-entries', { query: { projectId: 'project-1' } });
  assert.deepEqual(entries, []);
});
