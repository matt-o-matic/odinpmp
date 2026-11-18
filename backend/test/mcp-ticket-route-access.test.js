import assert from 'node:assert/strict';
import test from 'node:test';
import { requireMcpRouteAccess } from '../src/mcp/route-access.js';

// The MCP route allowlist for tickets and mentions: a ticket's choices, people to mention, the
// external tickets awaiting triage, and triage of one with nothing but a decision. Creating,
// deleting, commenting on and linking tickets use the items, comments and relations routes in
// route-access.js.

const CONFIG = '/api/projects/project-1/ticket-config';
const MENTIONABLES = '/api/projects/project-1/mentionables';
const REVIEW = '/api/projects/project-1/items/ticket-1/review';
const AWAITING = '/api/projects/project-1/tickets/awaiting-review';
const readWrite = { projectIds: [], scopes: ['projects.read', 'projects.write'] };
const readOnly = { projectIds: [], scopes: ['projects.read'] };

function check(method, originalUrl, grant = readWrite, body) {
  try {
    requireMcpRouteAccess({ body, method, originalUrl }, grant);
    return 'allowed';
  } catch (error) {
    return `${error.statusCode} ${error.message}`;
  }
}

test('ticket options and people to mention need projects.read; triage needs projects.write', () => {
  assert.equal(check('GET', CONFIG, readOnly), 'allowed');
  assert.equal(check('GET', `${MENTIONABLES}?query=sam`, readOnly), 'allowed');
  assert.equal(check('GET', AWAITING, readOnly), 'allowed');
  assert.equal(check('GET', `${AWAITING}?itemId=ticket-1&limit=1`, readOnly), 'allowed');
  assert.equal(check('POST', REVIEW, readWrite, { expectedVersion: 3, state: 'validated' }), 'allowed');
  assert.equal(check('POST', REVIEW, readWrite, { expectedVersion: 3, state: 'rejected' }), 'allowed');
  assert.equal(check('POST', REVIEW, readWrite, { agentCheck: true, expectedVersion: 3, state: 'validated' }), 'allowed');
  assert.equal(check('POST', REVIEW, readOnly, { expectedVersion: 3, state: 'validated' }), '403 The MCP grant lacks the required scope.');
});

test('triage carries a decision, its version and the automated check, nothing else', () => {
  for (const body of [
    { expectedVersion: 3, state: 'pending' }, { expectedVersion: 3, state: 'not_external' }, { expectedVersion: 3 }, {}, { expectedVersion: 3, state: 'validated', patch: { status: 'closed' } },
    { agentCheck: false, expectedVersion: 3, state: 'validated' }, { agentCheck: 'yes', expectedVersion: 3, state: 'validated' }, { agentCheck: null, expectedVersion: 3, state: 'rejected' },
  ]) {
    assert.equal(check('POST', REVIEW, readWrite, body), '403 This operation is outside the MCP grant.', JSON.stringify(body));
  }
});

test('the patterns do not stretch to other verbs, shapes or ticket routes', () => {
  for (const [method, url] of [
    ['PUT', CONFIG], ['POST', MENTIONABLES], ['GET', REVIEW], ['PATCH', REVIEW], ['GET', `${CONFIG}/extra`],
    ['POST', AWAITING], ['DELETE', AWAITING], ['GET', `${AWAITING}/ticket-1`], ['GET', '/api/projects/tickets/awaiting-review'],
    ['GET', '/api/projects/project-1/ticket-intake-invitations'], ['POST', '/api/projects/project-1/ticket-intake-invitations'],
  ]) {
    assert.equal(check(method, url, readWrite, {}), '403 This operation is outside the MCP grant.', `${method} ${url}`);
  }
});

test('project-restricted grants reach these routes only for their projects', () => {
  const restricted = { projectIds: ['project-1'], scopes: ['projects.read', 'projects.write'] };
  assert.equal(check('GET', CONFIG, restricted), 'allowed');
  assert.equal(check('POST', REVIEW, restricted, { expectedVersion: 1, state: 'rejected' }), 'allowed');
  assert.equal(check('GET', '/api/projects/project-2/ticket-config', restricted), '404 Project not found.');
  assert.equal(check('GET', '/api/projects/project-2/mentionables', restricted), '404 Project not found.');
  assert.equal(check('GET', AWAITING, restricted), 'allowed');
  assert.equal(check('GET', '/api/projects/project-2/tickets/awaiting-review', restricted), '404 Project not found.');
  assert.equal(check('POST', '/api/projects/project-2/items/ticket-1/review', restricted, { expectedVersion: 1, state: 'rejected' }), '404 Project not found.');
});
