import assert from 'node:assert/strict';
import test from 'node:test';
import { requireMcpRouteAccess } from '../src/mcp/route-access.js';

// The MCP route allowlist for the change tools (change-tools.js): the project change feed, item
// details and a batch of checked changes, each held to the grant's projects.

const BASE = '/api/projects/project-1';
const readOnly = { projectIds: [], scopes: ['projects.read'] };
const readWrite = { projectIds: [], scopes: ['projects.read', 'projects.write'] };
const restricted = { projectIds: ['project-1'], scopes: ['projects.read', 'projects.write'] };
const elsewhere = { projectIds: ['project-2'], scopes: ['projects.read', 'projects.write'] };

function check(method, originalUrl, grant = readWrite) {
  try {
    requireMcpRouteAccess({ body: {}, method, originalUrl }, grant);
    return 'allowed';
  } catch (error) {
    return `${error.statusCode} ${error.message}`;
  }
}

test('reads need projects.read and the batch of changes projects.write, on the grant\'s projects only', () => {
  for (const url of [`${BASE}/changes?cursor=c1.x`, `${BASE}/item-details?ids=a,b`]) {
    assert.equal(check('GET', url, readOnly), 'allowed', url);
    assert.equal(check('GET', url, restricted), 'allowed', url);
    assert.equal(check('GET', url, elsewhere), '404 Project not found.', url);
  }
  assert.equal(check('POST', `${BASE}/item-changes`), 'allowed');
  assert.equal(check('POST', `${BASE}/item-changes`, readOnly), '403 The MCP grant lacks the required scope.');
  assert.equal(check('POST', `${BASE}/item-changes`, elsewhere), '404 Project not found.');
});

test('nothing next to them is reachable', () => {
  for (const [method, url] of [
    ['POST', `${BASE}/changes`], ['POST', `${BASE}/item-details`], ['GET', `${BASE}/item-changes`], ['PUT', `${BASE}/item-changes`],
    ['GET', `${BASE}/item-details/extra`], ['POST', `${BASE}/item-changes/extra`],
  ]) {
    assert.equal(check(method, url), '403 This operation is outside the MCP grant.', `${method} ${url}`);
  }
});
