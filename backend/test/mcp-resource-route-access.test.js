import assert from 'node:assert/strict';
import test from 'node:test';
import { requireMcpRouteAccess } from '../src/mcp/route-access.js';

// The MCP route allowlist for resources, allocations, time, time off and sprint capacity
// (resource-tools.js). Changes go through routes that name their project; time off belongs to a
// person, so only grants for every project reach it. The rest of resource planning stays outside.

const PROJECT = '/api/resource-planning/projects/project-1';
const ADD = `${PROJECT}/resources`;
const STAFFING = '/api/projects/project-1/sprints/sprint-1/staffing';
const readOnly = { projectIds: [], scopes: ['projects.read'] };
const readWrite = { projectIds: [], scopes: ['projects.read', 'projects.write'] };
const restricted = { projectIds: ['project-1'], scopes: ['projects.read', 'projects.write'] };
const elsewhere = { projectIds: ['project-2'], scopes: ['projects.read', 'projects.write'] };

function check(method, originalUrl, grant = readWrite, body = undefined) {
  try {
    requireMcpRouteAccess({ body, method, originalUrl }, grant);
    return 'allowed';
  } catch (error) {
    return `${error.statusCode} ${error.message}`;
  }
}

const WRITES = [
  ['POST', ADD], ['PATCH', `${ADD}/res-1`], ['PUT', `${PROJECT}/task-access/res-1`],
  ['POST', `${PROJECT}/allocations`], ['PATCH', `${PROJECT}/allocations/alloc-1`], ['DELETE', `${PROJECT}/allocations/alloc-1`], ['POST', `${PROJECT}/allocations/alloc-1/level`],
  ['POST', `${PROJECT}/time-entries`], ['PATCH', `${PROJECT}/time-entries/time-1`], ['DELETE', `${PROJECT}/time-entries/time-1`],
  ['PUT', STAFFING],
];
const TIME_OFF = [['GET', '/api/resource-planning/calendar-entries'], ['POST', '/api/resource-planning/calendar-entries'], ['DELETE', '/api/resource-planning/calendar-entries/cal-1']];

test('reads need projects.read; adding people, changing allocations, time, time off and sprint capacity need projects.write', () => {
  for (const url of [`${PROJECT}/team`, `${PROJECT}/task-access`, '/api/resource-planning/time-entries', '/api/resource-planning/time-entries?projectId=project-1&mine=true', '/api/resource-planning/calendar-entries?from=2026-12-01']) {
    assert.equal(check('GET', url, readOnly), 'allowed', url);
  }
  for (const [method, url] of [...WRITES, ...TIME_OFF.filter(([method]) => method !== 'GET')]) {
    assert.equal(check(method, url), 'allowed', `${method} ${url}`);
    assert.equal(check(method, url, readOnly), '403 The MCP grant lacks the required scope.', `${method} ${url}`);
  }
});

test('the rest of resource planning stays outside the grant', () => {
  for (const [method, url] of [
    ['GET', ADD], ['GET', '/api/resource-planning'], ['PUT', `${PROJECT}/team`],
    ['POST', '/api/resource-planning/resources'], ['PATCH', '/api/resource-planning/resources/resource-1'], ['DELETE', '/api/resource-planning/resources/resource-1'],
    // The workspace CRUD routes name no project; the tools use the project's own routes instead.
    ['POST', '/api/resource-planning/allocations'], ['PATCH', '/api/resource-planning/allocations/alloc-1'], ['DELETE', '/api/resource-planning/allocations/alloc-1'],
    ['POST', '/api/resource-planning/allocations/alloc-1/level'],
    ['POST', '/api/resource-planning/time-entries'], ['PATCH', '/api/resource-planning/time-entries/time-1'], ['DELETE', '/api/resource-planning/time-entries/time-1'],
    ['PATCH', '/api/resource-planning/calendar-entries/cal-1'], ['GET', '/api/resource-planning/calendar-entries/cal-1'],
    ['POST', '/api/resource-planning/financial-entries'], ['POST', '/api/resource-planning/timesheet-periods'], ['PATCH', '/api/resource-planning/timesheet-periods/period-1'],
    ['GET', `${PROJECT}/time-entries`], ['PUT', `${PROJECT}/allocations/alloc-1`], ['GET', `${PROJECT}/allocations`],
    ['POST', `${ADD}/extra`], ['DELETE', `${PROJECT}/time-entries/time-1/extra`], ['POST', `${PROJECT}/allocations/alloc-1/level/extra`],
    ['GET', STAFFING], ['POST', STAFFING], ['PUT', `${STAFFING}/extra`],
  ]) {
    assert.equal(check(method, url), '403 This operation is outside the MCP grant.', `${method} ${url}`);
  }
});

test('an access link goes only by email: a link to copy would hand the client a working credential', () => {
  const LINK = `${PROJECT}/task-access/res-1/link`;
  assert.equal(check('POST', LINK, readWrite, { delivery: 'email' }), 'allowed');
  assert.equal(check('POST', LINK, restricted, { delivery: 'email' }), 'allowed');
  assert.equal(check('POST', LINK, elsewhere, { delivery: 'email' }), '404 Project not found.');
  assert.equal(check('POST', LINK, readOnly, { delivery: 'email' }), '403 The MCP grant lacks the required scope.');
  for (const body of [{ delivery: 'manual' }, {}, undefined]) assert.equal(check('POST', LINK, readWrite, body), '403 This operation is outside the MCP grant.', JSON.stringify(body));
  // Turning a link off reaches every project its email has, so it stays in Odin.
  for (const url of ['/api/resource-planning/resources/res-1/access-link', '/api/resource-planning/resources/res-1/access-link/revoke']) {
    assert.equal(check(url.endsWith('revoke') ? 'POST' : 'GET', url), '403 This operation is outside the MCP grant.', url);
  }
});

test('project-restricted grants reach only their projects, and must name one to list time', () => {
  for (const [method, url] of [['GET', `${PROJECT}/team`], ...WRITES]) {
    assert.equal(check(method, url, restricted), 'allowed', `${method} ${url}`);
    assert.equal(check(method, url, elsewhere), '404 Project not found.', `${method} ${url}`);
  }
  assert.equal(check('GET', '/api/resource-planning/time-entries?projectId=project-1', restricted), 'allowed');
  assert.equal(check('GET', '/api/resource-planning/time-entries?projectId=project-1', elsewhere), '404 Project not found.');
  assert.equal(check('GET', '/api/resource-planning/time-entries', restricted), '404 Project not found.');
  assert.equal(check('GET', '/api/resource-planning/time-entries?resourceId=res-1', restricted), '404 Project not found.');
});

test('time off belongs to a person, so only grants for every project reach it', () => {
  for (const [method, url] of TIME_OFF) {
    assert.equal(check(method, url), 'allowed', `${method} ${url}`);
    assert.equal(check(method, url, restricted), '404 Project not found.', `${method} ${url}`);
  }
});
