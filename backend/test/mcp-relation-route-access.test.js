import assert from 'node:assert/strict';
import test from 'node:test';
import { requireMcpRouteAccess } from '../src/mcp/route-access.js';

// The MCP route allowlist for item relations: list and create on an item, delete by id.

const ITEM = '/api/projects/project-1/items/story-1/relations';
const RELATION = '/api/projects/project-1/relations/0b7f3c2e-4f7a-4a51-9c8e-1d2b3c4d5e6f';
const readWrite = { projectIds: [], scopes: ['projects.read', 'projects.write'] };
const readOnly = { projectIds: [], scopes: ['projects.read'] };

function check(method, originalUrl, grant = readWrite) {
  try {
    requireMcpRouteAccess({ method, originalUrl }, grant);
    return 'allowed';
  } catch (error) {
    return `${error.statusCode} ${error.message}`;
  }
}

test('reading relations needs projects.read; linking and unlinking need projects.write', () => {
  assert.equal(check('GET', ITEM, readOnly), 'allowed');
  assert.equal(check('POST', ITEM), 'allowed');
  assert.equal(check('DELETE', RELATION), 'allowed');
  assert.equal(check('POST', ITEM, readOnly), '403 The MCP grant lacks the required scope.');
  assert.equal(check('DELETE', RELATION, readOnly), '403 The MCP grant lacks the required scope.');
});

test('relation patterns do not stretch to other verbs or shapes', () => {
  for (const [method, url] of [
    ['PUT', ITEM], ['DELETE', ITEM], ['GET', RELATION], ['PATCH', RELATION],
    ['GET', `${ITEM}/extra`], ['GET', '/api/projects/project-1/relations'],
  ]) {
    assert.equal(check(method, url), '403 This operation is outside the MCP grant.', `${method} ${url}`);
  }
});

test('project-restricted grants reach relation routes only for their projects', () => {
  const restricted = { projectIds: ['project-1'], scopes: ['projects.read', 'projects.write'] };
  assert.equal(check('POST', ITEM, restricted), 'allowed');
  assert.equal(check('POST', '/api/projects/project-2/items/story-1/relations', restricted), '404 Project not found.');
  assert.equal(check('DELETE', '/api/projects/project-2/relations/relation-1', restricted), '404 Project not found.');
});
