import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemoryResourceFinanceRepository } from '../src/modules/resource-finance/resource-finance.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';

// The project-scoped resource-planning routes the MCP and assistant tools call: logging, listing,
// changing and deleting time, listing time off, and adding, changing, removing and leveling
// allocations. Each holds records to the project in its path and keeps the CRUD routes' rules.

const today = new Date().toISOString().slice(0, 10);

async function fixture() {
  const users = [
    { id: 'admin', name: 'Admin', role: 'admin' },
    { id: 'manager', name: 'Manager', role: 'manager' },
    { id: 'member', name: 'Member', role: 'user' },
    { id: 'newbie', name: 'Nina Newbie', role: 'user' },
    { id: 'outsider', name: 'Olu Outsider', role: 'user' },
  ].map(({ id, name, role }) => ({ authMethod: 'basic', email: `${id}@example.com`, id, memberships: [{ role, tenantId: 'tenant-1' }], name, password: 'Secret123!' }));
  const authRepository = await createInMemoryAuthRepository({ disableDemoUser: true, tenants: [{ domains: ['example.com'], id: 'tenant-1', name: 'Tenant' }], users });
  const projectRepository = createInMemoryProjectsRepository({ authRepository, seed: {
    projectMemberships: { 'project-1': [{ id: 'member', role: 'member' }, { id: 'newbie', role: 'member' }], 'project-2': [] },
    projects: [
      { epics: [{ id: 'epic-accounts', name: 'Accounts', status: 'In Progress', stories: [{ id: 'story-login', name: 'Login page', status: 'In Progress', tasks: [{ id: 'task-form', name: 'Build the login form', status: 'Not Started' }] }] }], id: 'project-1', name: 'Launch', status: 'In Progress', tenantId: 'tenant-1' },
      { epics: [{ id: 'epic-erp', name: 'ERP', status: 'Not Started', stories: [{ id: 'story-erp', name: 'Ledger import', status: 'Not Started', tasks: [] }] }], id: 'project-2', name: 'ERP', status: 'At Risk', tenantId: 'tenant-1' },
    ],
  } });
  const tokenService = createTokenService({ issuer: 'test', secret: 'resource-finance-project-routes-secret-long-enough' });
  const sessionsRepository = createInMemorySessionsRepository();
  const tokens = new Map();
  for (const user of users) {
    const token = tokenService.signSessionToken(user);
    await sessionsRepository.createSession({ expiryDate: new Date(tokenService.verifySessionToken(token).exp * 1000), token, userId: user.id });
    tokens.set(user.id, `Bearer ${token}`);
  }
  const app = createApp({ agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0, authRepository, domainEventSweepIntervalMs: 0, projectRepository, resourceFinanceRepository: createInMemoryResourceFinanceRepository(), sessionsRepository, tokenService });
  const send = (method, path, as, body) => {
    const call = request(app)[method](`/api/resource-planning${path}`).set('Authorization', tokens.get(as));
    return body === undefined ? call : call.send(body);
  };
  const post = async (path, body, as = 'manager') => {
    const response = await send('post', path, as, body);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.value ?? response.body;
  };
  return { post, send };
}

test('time is logged on a project in one call: the signed-in user\'s profile, today, the period holding the date, and a work item on the project', async () => {
  const { post, send } = await fixture();
  const mine = await post('/resources', { name: 'Member', userId: 'member' });
  const contractor = await post('/resources', { name: 'Casey Contractor' });
  const open = await post('/timesheet-periods', { endDate: '2099-12-31', name: 'Open', startDate: today });
  const locked = await post('/timesheet-periods', { endDate: '2001-01-31', name: 'January 2001', startDate: '2001-01-01', status: 'locked' });

  const logged = await send('post', '/projects/project-1/time-entries', 'member', { hours: 3, note: 'Wired up the form', workItemId: 'story-login' });
  assert.equal(logged.status, 201, JSON.stringify(logged.body));
  assert.deepEqual(
    [logged.body.value.resourceId, logged.body.value.workDate, logged.body.value.periodId, logged.body.value.status, logged.body.value.projectId, logged.body.value.workItemId],
    [mine.id, today, open.id, 'submitted', 'project-1', 'story-login'],
  );
  // A date outside every period has none; a locked period refuses the time.
  const unperioded = await send('post', '/projects/project-1/time-entries', 'member', { hours: 1, workDate: '2002-03-04' });
  assert.deepEqual([unperioded.status, unperioded.body.value.periodId], [201, null]);
  assert.equal((await send('post', '/projects/project-1/time-entries', 'member', { hours: 1, workDate: '2001-01-15' })).status, 423);

  // Work items come from this project; someone else's time needs a resource manager; no profile, nowhere to log.
  assert.equal((await send('post', '/projects/project-1/time-entries', 'member', { hours: 1, workItemId: 'story-erp' })).status, 404);
  assert.equal((await send('post', '/projects/project-1/time-entries', 'member', { hours: 1, resourceId: contractor.id })).status, 404);
  assert.equal((await send('post', '/projects/project-1/time-entries', 'newbie', { hours: 1 })).status, 422);
  assert.equal((await send('post', '/projects/project-2/time-entries', 'member', { hours: 1 })).status, 404);
  assert.equal((await send('post', '/projects/project-1/time-entries', 'member', { hours: 25 })).status, 400);
  const forContractor = await send('post', '/projects/project-1/time-entries', 'manager', { billable: true, hours: 6, resourceId: contractor.id, workDate: today, workItemId: 'task-form' });
  assert.equal(forContractor.status, 201);
  assert.equal(locked.status, 'locked');
});

test('time lists cover the user\'s projects, newest first, and show only their own time unless they manage resources', async () => {
  const { post, send } = await fixture();
  const mine = await post('/resources', { name: 'Member', userId: 'member' });
  const contractor = await post('/resources', { name: 'Casey Contractor' });
  await send('post', '/projects/project-1/time-entries', 'member', { hours: 2, workDate: '2026-07-01', workItemId: 'story-login' });
  await send('post', '/projects/project-1/time-entries', 'member', { hours: 1.5, workDate: '2026-07-03' });
  await send('post', '/projects/project-1/time-entries', 'manager', { billable: true, hours: 8, resourceId: contractor.id, workDate: '2026-07-02' });
  await send('post', '/projects/project-2/time-entries', 'manager', { hours: 4, resourceId: contractor.id, workDate: '2026-07-02' });

  const member = await send('get', '/time-entries', 'member');
  assert.equal(member.status, 200);
  assert.deepEqual(member.body.entries.map((entry) => [entry.workDate, entry.hours, entry.resourceName]), [['2026-07-03', 1.5, 'Member'], ['2026-07-01', 2, 'Member']]);
  assert.deepEqual([member.body.myResourceId, member.body.total, member.body.totals.hours, member.body.totals.submittedHours], [mine.id, 2, 3.5, 3.5]);
  assert.deepEqual([member.body.entries[1].workItemName, member.body.entries[1].projectName, typeof member.body.entries[1].version], ['Login page', 'Launch', 'number']);
  assert.equal(member.body.entries[0].tenantId, undefined);

  const manager = await send('get', '/time-entries?projectId=project-1&from=2026-07-02', 'manager');
  assert.deepEqual(manager.body.entries.map((entry) => [entry.workDate, entry.resourceName]), [['2026-07-03', 'Member'], ['2026-07-02', 'Casey Contractor']]);
  assert.equal(manager.body.totals.billableHours, 8);
  assert.equal((await send('get', `/time-entries?resourceId=${contractor.id}&to=2026-07-02`, 'manager')).body.total, 2);
  assert.equal((await send('get', '/time-entries?mine=true', 'manager')).body.total, 0);
  assert.equal((await send('get', '/time-entries?limit=1', 'manager')).body.entries.length, 1);
  assert.equal((await send('get', '/time-entries?projectId=project-2', 'member')).status, 404);
  assert.equal((await send('get', '/time-entries', 'newbie')).body.total, 0);
});

test('changing and deleting time keeps it on its project, in an open period, and with Odin\'s own rules for who may', async () => {
  const { post, send } = await fixture();
  await post('/resources', { name: 'Member', userId: 'member' });
  const locked = await post('/timesheet-periods', { endDate: '2001-01-31', name: 'January 2001', startDate: '2001-01-01' });
  const entry = (await send('post', '/projects/project-1/time-entries', 'member', { hours: 2, workDate: '2001-01-10' })).body.value;
  assert.equal(entry.periodId, locked.id);
  const patch = (body, as = 'member', projectId = 'project-1', id = entry.id) => send('patch', `/projects/${projectId}/time-entries/${id}`, as, body);

  const edited = await patch({ expectedVersion: 1, hours: 3, workItemId: 'task-form' });
  assert.deepEqual([edited.status, edited.body.value.hours, edited.body.value.workItemId], [200, 3, 'task-form']);
  // Moving the date out of the period takes the entry out of it.
  const moved = await patch({ expectedVersion: 2, workDate: '2002-05-05' });
  assert.deepEqual([moved.status, moved.body.value.periodId], [200, null]);
  assert.equal((await patch({ expectedVersion: 3, status: 'approved' })).status, 404);
  assert.equal((await patch({ expectedVersion: 1, hours: 4 })).status, 409);
  assert.equal((await patch({ expectedVersion: 3, hours: 4 }, 'member', 'project-2')).status, 404);
  assert.equal((await patch({ expectedVersion: 3, workItemId: 'story-erp' })).status, 404);
  assert.equal((await patch({ expectedVersion: 3, status: 'approved' }, 'manager')).body.value.status, 'approved');
  // Approved time is no longer the member's to change.
  assert.equal((await patch({ expectedVersion: 4, hours: 1 })).status, 404);

  // Locking the period freezes the time in it.
  const second = (await send('post', '/projects/project-1/time-entries', 'member', { hours: 1, workDate: '2001-01-11' })).body.value;
  assert.equal((await send('patch', `/timesheet-periods/${locked.id}`, 'manager', { expectedVersion: 1, status: 'locked' })).status, 200);
  assert.equal((await patch({ expectedVersion: 1, workDate: '2002-01-01' }, 'member', 'project-1', second.id)).status, 423);
  assert.equal((await patch({ expectedVersion: 4, workDate: '2001-01-12' }, 'manager')).status, 423);
  assert.equal((await send('delete', `/projects/project-1/time-entries/${second.id}`, 'manager', { expectedVersion: 1 })).status, 423);

  const remove = (as, projectId, id, expectedVersion) => send('delete', `/projects/${projectId}/time-entries/${id}`, as, { expectedVersion });
  assert.equal((await remove('member', 'project-1', entry.id, 4)).status, 404);
  assert.equal((await remove('manager', 'project-2', entry.id, 4)).status, 404);
  assert.equal((await remove('manager', 'project-1', entry.id, 4)).status, 200);
  assert.equal((await send('get', '/time-entries', 'manager')).body.total, 1);
});

test('time off lists by person and dates, and people without a resource manager\'s role see only their own', async () => {
  const { post, send } = await fixture();
  const mine = await post('/resources', { name: 'Member', userId: 'member' });
  const other = await post('/resources', { name: 'Casey Contractor' });
  await post('/calendar-entries', { endDate: '2026-08-14', entryType: 'leave', hoursPerDay: 8, resourceId: mine.id, startDate: '2026-08-10' });
  await post('/calendar-entries', { endDate: '2026-12-25', entryType: 'holiday', hoursPerDay: 8, resourceId: other.id, startDate: '2026-12-25' });

  const all = await send('get', '/calendar-entries', 'manager');
  assert.deepEqual(all.body.entries.map((entry) => [entry.resourceName, entry.entryType, entry.startDate]), [['Member', 'leave', '2026-08-10'], ['Casey Contractor', 'holiday', '2026-12-25']]);
  assert.equal(all.body.entries[0].tenantId, undefined);
  assert.equal((await send('get', '/calendar-entries?from=2026-08-14&to=2026-09-01', 'manager')).body.total, 1);
  assert.equal((await send('get', '/calendar-entries?from=2026-08-15&to=2026-12-24', 'manager')).body.total, 0);
  assert.equal((await send('get', `/calendar-entries?resourceId=${other.id}`, 'manager')).body.total, 1);
  const member = await send('get', '/calendar-entries', 'member');
  assert.deepEqual([member.body.total, member.body.myResourceId, member.body.entries[0].resourceId], [1, mine.id, mine.id]);
  assert.equal((await send('get', `/calendar-entries?resourceId=${other.id}`, 'member')).body.total, 0);
});

test('allocating someone already in Odin: a directory resource, or a workspace user who gets a linked profile, once per project', async () => {
  const { post, send } = await fixture();
  const add = (body, as = 'manager', projectId = 'project-1') => send('post', `/projects/${projectId}/allocations`, as, body);
  const contractor = await post('/resources', { billRate: 120, capacityHoursPerWeek: 30, minBillRate: 100, name: 'Casey Contractor' });

  const added = await add({ billRate: 110, hoursPerWeek: 15, resourceId: contractor.id, role: 'QA' });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.deepEqual(
    [added.body.added, added.body.created, added.body.assigneeId, added.body.allocation.allocationPercent, added.body.allocation.status, added.body.allocation.startDate],
    [true, false, `resource:${contractor.id}`, 50, 'active', today],
  );
  const again = await add({ hoursPerWeek: 40, resourceId: contractor.id });
  assert.deepEqual([again.body.added, again.body.allocation.id, again.body.allocation.hoursPerWeek], [false, added.body.allocation.id, 15]);
  assert.equal((await add({ billRate: 90, resourceId: contractor.id }, 'manager', 'project-2')).status, 400);

  // A workspace user without a profile gets one linked to their login, on the project's dates by default.
  const user = await add({ endDate: '2027-03-31', hoursPerWeek: 20, startDate: '2027-01-01', userId: 'outsider' });
  assert.equal(user.status, 201, JSON.stringify(user.body));
  assert.deepEqual([user.body.created, user.body.resource.userId, user.body.resource.name, user.body.assigneeId, user.body.allocation.allocationPercent], [true, 'outsider', 'Olu Outsider', 'outsider', 50]);
  const elsewhere = await add({ userId: 'outsider' }, 'manager', 'project-2');
  assert.deepEqual([elsewhere.body.created, elsewhere.body.resource.id], [false, user.body.resource.id]);

  // A refused allocation leaves no profile behind; strangers, both ids, non-managers and plan readers add no one.
  assert.equal((await add({ endDate: '2027-01-01', startDate: '2027-02-01', userId: 'newbie' })).status, 400);
  assert.equal((await add({ userId: 'nobody' })).status, 404);
  assert.equal((await add({ resourceId: contractor.id, userId: 'newbie' })).status, 400);
  assert.equal((await add({ userId: 'newbie' }, 'member')).status, 404);
  assert.equal((await add({ resourceId: 'missing' })).status, 404);
  const workspace = await send('get', '/', 'manager');
  assert.deepEqual(workspace.body.resources.map((resource) => resource.name).sort(), ['Casey Contractor', 'Olu Outsider']);
});

test('changing, ending, leveling and removing an allocation stays on its project and keeps the rate floor', async () => {
  const { post, send } = await fixture();
  const contractor = await post('/resources', { capacityHoursPerWeek: 40, minBillRate: 100, name: 'Casey Contractor' });
  const backup = await post('/resources', { name: 'Bea Backup' });
  const allocation = (await send('post', '/projects/project-1/allocations', 'manager', { hoursPerWeek: 20, resourceId: contractor.id })).body.allocation;
  const other = (await send('post', '/projects/project-2/allocations', 'manager', { hoursPerWeek: 10, resourceId: contractor.id })).body.allocation;
  const patch = (body, as = 'manager', projectId = 'project-1', id = allocation.id) => send('patch', `/projects/${projectId}/allocations/${id}`, as, body);

  const changed = await patch({ expectedVersion: 1, hoursPerWeek: 30, role: 'Lead QA' });
  assert.deepEqual([changed.status, changed.body.value.hoursPerWeek, changed.body.value.allocationPercent, changed.body.value.role], [200, 30, 75, 'Lead QA']);
  assert.equal((await patch({ billRate: 99, expectedVersion: 2 })).status, 400);
  assert.equal((await patch({ billRate: 100, expectedVersion: 2 })).body.value.billRate, 100);
  assert.equal((await patch({ expectedVersion: 3, hoursPerWeek: 5 }, 'manager', 'project-1', other.id)).status, 404);
  assert.equal((await patch({ expectedVersion: 3, hoursPerWeek: 5 }, 'member')).status, 404);
  assert.equal((await patch({ endDate: '2000-01-01', expectedVersion: 3 })).status, 400);
  assert.equal((await patch({ expectedVersion: 2, hoursPerWeek: 5 })).status, 409);
  const ended = await patch({ endDate: today, expectedVersion: 3, status: 'completed' });
  assert.deepEqual([ended.body.value.endDate, ended.body.value.status], [today, 'completed']);

  const level = (body, projectId = 'project-2') => send('post', `/projects/${projectId}/allocations/${other.id}/level`, 'manager', body);
  assert.equal((await level({ expectedVersion: 1, hours: 4, targetResourceId: backup.id }, 'project-1')).status, 404);
  const split = await level({ expectedVersion: 1, hours: 4, targetResourceId: backup.id });
  assert.deepEqual([split.status, split.body.value.sourceAllocation.hoursPerWeek, split.body.value.targetAllocation.resourceId], [200, 6, backup.id]);

  const remove = (projectId, id, expectedVersion, as = 'manager') => send('delete', `/projects/${projectId}/allocations/${id}`, as, { expectedVersion });
  assert.equal((await remove('project-1', other.id, 2)).status, 404);
  assert.equal((await remove('project-2', other.id, 2, 'member')).status, 404);
  assert.equal((await remove('project-2', other.id, 2)).status, 200);
  const team = await send('get', '/projects/project-2/team', 'manager');
  assert.deepEqual(team.body.people.map((person) => person.resource.name), ['Bea Backup']);
});

test('a time list names only epics, stories and tasks: an id stored for anything else is left out', async () => {
  const { post, send } = await fixture();
  const contractor = await post('/resources', { name: 'Casey Contractor' });
  // The generic route takes any work item id, such as a ticket's.
  await post('/time-entries', { hours: 2, projectId: 'project-1', resourceId: contractor.id, workDate: '2026-07-01', workItemId: 'ticket-from-outside' });
  await send('post', '/projects/project-1/time-entries', 'manager', { hours: 1, resourceId: contractor.id, workDate: '2026-07-02', workItemId: 'story-login' });
  const listed = await send('get', '/time-entries?projectId=project-1', 'manager');
  assert.deepEqual(listed.body.entries.map((entry) => [entry.workDate, entry.workItemId, entry.workItemName]), [['2026-07-02', 'story-login', 'Login page'], ['2026-07-01', null, null]]);
});

test('people delete their own time while it is submitted and its period open; anything else takes a resource manager', async () => {
  const { post, send } = await fixture();
  const mine = await post('/resources', { name: 'Member', userId: 'member' });
  const contractor = await post('/resources', { name: 'Casey Contractor' });
  const log = async (body, as = 'member') => (await send('post', '/projects/project-1/time-entries', as, { hours: 1, workDate: '2026-07-01', ...body })).body.value;
  const remove = (entry, as, path = `/projects/project-1/time-entries/${entry.id}`) => send('delete', path, as, { expectedVersion: entry.version });

  // Through the project route and the general one alike.
  assert.equal((await remove(await log({}), 'member')).status, 200);
  const viaGeneral = await log({});
  assert.equal((await send('delete', `/time-entries/${viaGeneral.id}`, 'member', { expectedVersion: viaGeneral.version })).status, 200);

  // Not someone else's, not once it is approved, and not in a period that has been locked since.
  const theirs = await log({ resourceId: contractor.id }, 'manager');
  assert.equal((await remove(theirs, 'member')).status, 404);
  const approved = await log({});
  const approvedNow = (await send('patch', `/projects/project-1/time-entries/${approved.id}`, 'manager', { expectedVersion: approved.version, status: 'approved' })).body.value;
  assert.equal((await remove(approvedNow, 'member')).status, 404);
  const period = await post('/timesheet-periods', { endDate: '2026-08-31', name: 'August', startDate: '2026-08-01' });
  const august = await log({ workDate: '2026-08-03' });
  assert.equal(august.periodId, period.id);
  await send('patch', `/timesheet-periods/${period.id}`, 'manager', { expectedVersion: period.version, status: 'locked' });
  assert.equal((await remove(august, 'member')).status, 423);

  // A resource manager still deletes anyone's time.
  assert.equal((await remove(theirs, 'manager')).status, 200);
  assert.equal(mine.userId, 'member');
});
