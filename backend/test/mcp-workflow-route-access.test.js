import assert from 'node:assert/strict';
import test from 'node:test';
import { requireMcpRouteAccess } from '../src/mcp/route-access.js';

// The MCP route allowlist for approvals, custom-field values, item revisions, story splits and
// templates (access/workflow.js). Workflow and template administration stay outside the grant.

const readOnly = { projectIds: [], scopes: ['projects.read'] };
const readWrite = { projectIds: [], scopes: ['projects.read', 'projects.write'] };
const projectOne = { projectIds: ['project-1'], scopes: ['projects.read', 'projects.write'] };
const REQUEST = { fromState: 'Review', itemId: 'story-1', itemType: 'story', note: '', projectId: 'project-1', toState: 'Done', transitionKey: 'ship' };
const DECISION = { decisionNote: '', expectedVersion: 1, projectId: 'project-1', status: 'approved' };
const VALUE = { expectedVersion: null, fieldId: 'field-1', itemId: 'story-1', itemType: 'story', projectId: 'project-1', value: 'x' };

function check(method, originalUrl, grant = readWrite, body = undefined) {
  try {
    requireMcpRouteAccess({ body, method, originalUrl }, grant);
    return 'allowed';
  } catch (error) {
    return `${error.statusCode} ${error.message}`;
  }
}

test('reads need projects.read and the writes need projects.write', () => {
  for (const url of ['/api/workflows/templates', '/api/workflows/templates?kind=project&status=active', '/api/projects/project-1/items/story-1/revisions?limit=100']) {
    assert.equal(check('GET', url, readOnly), 'allowed', url);
  }
  for (const [method, url, body] of [
    ['POST', '/api/workflows/approvals', REQUEST],
    ['POST', '/api/workflows/approvals/approval-1/decision', DECISION],
    ['PUT', '/api/workflows/custom-values', VALUE],
    ['DELETE', '/api/workflows/custom-values/value-1', { expectedVersion: 1, projectId: 'project-1' }],
    ['POST', '/api/projects/project-1/items/story-1/restore', { expectedVersion: 3, revisionId: 'rev-1', state: 'after' }],
    ['POST', '/api/projects/project-1/stories/story-1/split', { name: 'Part 2', taskIds: ['task-1'] }],
  ]) {
    assert.equal(check(method, url, readWrite, body), 'allowed', `${method} ${url}`);
    assert.equal(check(method, url, readOnly, body), '403 The MCP grant lacks the required scope.', `${method} ${url}`);
  }
});

test('a decision or a custom-value delete must name its project', () => {
  assert.equal(check('POST', '/api/workflows/approvals/approval-1/decision', readWrite, { ...DECISION, projectId: undefined }), '403 This operation is outside the MCP grant.');
  assert.equal(check('DELETE', '/api/workflows/custom-values/value-1', readWrite, { expectedVersion: 1 }), '403 This operation is outside the MCP grant.');
  assert.equal(check('POST', '/api/workflows/approvals/approval-1/decision', readWrite, { ...DECISION, projectId: ['project-1'] }), '403 This operation is outside the MCP grant.');
});

test('workflow and template administration stay outside the grant', () => {
  for (const [method, url] of [
    ['POST', '/api/workflows/definitions'], ['GET', '/api/workflows/definitions/wf-1'], ['PATCH', '/api/workflows/definitions/wf-1'], ['DELETE', '/api/workflows/definitions/wf-1'],
    ['POST', '/api/workflows/bindings'], ['PATCH', '/api/workflows/bindings/binding-1'], ['DELETE', '/api/workflows/bindings/binding-1'],
    ['POST', '/api/workflows/baselines'], ['POST', '/api/workflows/custom-fields'], ['PATCH', '/api/workflows/custom-fields/field-1'], ['DELETE', '/api/workflows/custom-fields/field-1'],
    ['POST', '/api/workflows/templates'], ['PATCH', '/api/workflows/templates/tpl-1'], ['DELETE', '/api/workflows/templates/tpl-1'],
    ['GET', '/api/workflows/approvals'], ['PATCH', '/api/workflows/approvals/approval-1'], ['POST', '/api/workflows/approvals/approval-1/decision/extra'],
    ['GET', '/api/workflows/custom-values'], ['POST', '/api/workflows/custom-values'],
    ['GET', '/api/projects/project-1/items/story-1/restore'], ['POST', '/api/projects/project-1/items/story-1/revisions'],
    ['GET', '/api/projects/project-1/stories/story-1/split'], ['POST', '/api/projects/project-1/stories/story-1/split/extra'],
  ]) {
    assert.equal(check(method, url, readWrite, { projectId: 'project-1' }), '403 This operation is outside the MCP grant.', `${method} ${url}`);
  }
});

test('grants limited to some projects reach only those projects\' approvals, values, revisions and splits', () => {
  const allowed = [
    ['POST', '/api/workflows/approvals', REQUEST],
    ['POST', '/api/workflows/approvals/approval-1/decision', DECISION],
    ['PUT', '/api/workflows/custom-values', VALUE],
    ['DELETE', '/api/workflows/custom-values/value-1', { expectedVersion: 1, projectId: 'project-1' }],
    ['GET', '/api/projects/project-1/items/story-1/revisions', undefined],
    ['POST', '/api/projects/project-1/items/story-1/restore', {}],
    ['POST', '/api/projects/project-1/stories/story-1/split', {}],
  ];
  for (const [method, url, body] of allowed) assert.equal(check(method, url, projectOne, body), 'allowed', `${method} ${url}`);
  for (const [method, url, body] of [
    ['POST', '/api/workflows/approvals', { ...REQUEST, projectId: 'project-2' }],
    ['POST', '/api/workflows/approvals/approval-1/decision', { ...DECISION, projectId: 'project-2' }],
    ['PUT', '/api/workflows/custom-values', { ...VALUE, projectId: 'project-2' }],
    ['PUT', '/api/workflows/custom-values', { ...VALUE, projectId: undefined }],
    ['DELETE', '/api/workflows/custom-values/value-1', { expectedVersion: 1, projectId: 'project-2' }],
    ['GET', '/api/projects/project-2/items/story-1/revisions', undefined],
    ['POST', '/api/projects/project-2/items/story-1/restore', {}],
    ['POST', '/api/projects/project-2/stories/story-1/split', {}],
  ]) {
    assert.equal(check(method, url, projectOne, body), '404 Project not found.', `${method} ${url} ${JSON.stringify(body)}`);
  }
  // Templates belong to the whole workspace, so a limited grant cannot list them.
  assert.equal(check('GET', '/api/workflows/templates', projectOne), '404 Project not found.');
  assert.equal(check('GET', '/api/workflows/templates?projectId=project-1', projectOne), '404 Project not found.');
});
