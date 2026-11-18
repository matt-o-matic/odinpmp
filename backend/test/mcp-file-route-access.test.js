import assert from 'node:assert/strict';
import test from 'node:test';
import { requireMcpRouteAccess } from '../src/mcp/route-access.js';

// The MCP route allowlist in access/files.js: project files, My items, and editing or deleting
// one's own topic comment. Memory and goal routes refuse MCP credentials before this list.

const FILES = '/api/projects/project-1/files';
const REQ = '/api/projects/project-1/requirements';
const COMMENT = `${REQ}/topics/topic-1/comments/comment-1`;
const readWrite = { projectIds: [], scopes: ['projects.read', 'projects.write'] };
const readOnly = { projectIds: [], scopes: ['projects.read'] };
const upload = { fileContentsBase64: 'aGk=', fileDescription: '', fileName: 'notes.md', fileType: 'text/markdown', targetId: 'project-1', targetType: 'project' };

function check(method, originalUrl, { body, grant = readWrite } = {}) {
  try {
    requireMcpRouteAccess({ body, method, originalUrl }, grant);
    return 'allowed';
  } catch (error) {
    return `${error.statusCode} ${error.message}`;
  }
}

test('reads need projects.read; uploads, deletes and comment changes need projects.write', () => {
  for (const url of [`${FILES}?targetId=project-1&targetType=project`, `${FILES}?targetId=project-1&targetType=project&agentView=1`, `${FILES}/file-1/text?offset=0&maxChars=100&agentView=1`, `${REQ}/my-items`]) {
    assert.equal(check('GET', url, { grant: readOnly }), 'allowed', url);
  }
  for (const [method, url, body] of [['POST', FILES, upload], ['DELETE', `${FILES}/file-1?agentView=1`], ['PATCH', COMMENT, { body: 'Reworded.' }], ['DELETE', COMMENT]]) {
    assert.equal(check(method, url, { body }), 'allowed', `${method} ${url}`);
    assert.equal(check(method, url, { body, grant: readOnly }), '403 The MCP grant lacks the required scope.', `${method} ${url}`);
  }
});

test('versions, downloads and links are admitted with their known fields only', () => {
  const version = { expectedVersion: 1, fileContentsBase64: 'aGk=', fileName: 'v2.md', fileType: 'text/markdown', note: 'Scope' };
  for (const url of [`${FILES}/file-1/versions?agentView=1`, `${FILES}/file-1/download?inline=1&version=2`]) {
    assert.equal(check('GET', url, { grant: readOnly }), 'allowed', url);
  }
  for (const [method, url, body] of [
    ['POST', `${FILES}/file-1/versions`, version],
    ['POST', `${FILES}/file-1/versions/2/restore`, { expectedVersion: 3 }],
    ['POST', `${FILES}/file-1/links`, { targetId: 'story-1', targetType: 'story' }],
    ['POST', `${FILES}/file-1/links`, { targetId: 'ticket-1', targetType: 'ticket' }],
    ['DELETE', `${FILES}/file-1/links/link-1`],
  ]) {
    assert.equal(check(method, url, { body }), 'allowed', `${method} ${url}`);
    assert.equal(check(method, url, { body, grant: readOnly }), '403 The MCP grant lacks the required scope.', `${method} ${url}`);
  }
  for (const [url, body] of [
    [`${FILES}/file-1/versions`, { ...version, fileType: 'text/html' }],
    [`${FILES}/file-1/versions`, { ...version, fileType: undefined }],
    [`${FILES}/file-1/versions`, { ...version, inlineImage: true }],
    [`${FILES}/file-1/versions`, { ...version, expectedVersion: '1' }],
    [`${FILES}/file-1/versions/2/restore`, { expectedVersion: 3, extra: true }],
    [`${FILES}/file-1/links`, { targetId: 'topic-1', targetType: 'clarification' }],
    [`${FILES}/file-1/links`, { targetId: 'project-1', targetType: 'project' }],
  ]) {
    assert.notEqual(check('POST', url, { body }), 'allowed', JSON.stringify(body));
  }
  assert.notEqual(check('GET', '/api/files/file-1/content', { grant: readOnly }), 'allowed', 'a grant reaches a file only by its project');
});

test('an upload goes to the project or an item or topic, with a type a browser will not run as a page', () => {
  for (const targetType of ['project', 'epic', 'story', 'task', 'clarification']) {
    assert.equal(check('POST', FILES, { body: { ...upload, targetType } }), 'allowed', targetType);
  }
  for (const fileType of ['application/pdf', 'image/png', 'text/csv', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']) {
    assert.equal(check('POST', FILES, { body: { ...upload, fileType } }), 'allowed', fileType);
  }
  for (const guard of [{ createOnly: true }, { expectedSignature: 'd41d8cd98f00b204e9800998ecf8427e' }, { expectedSignature: null }]) {
    assert.equal(check('POST', FILES, { body: { ...upload, ...guard } }), 'allowed', JSON.stringify(guard));
  }
  for (const body of [
    { ...upload, targetType: 'ticket' },
    { ...upload, fileType: 'text/html' },
    { ...upload, fileType: 'image/svg+xml' },
    { ...upload, fileType: 'application/javascript' },
    { ...upload, fileType: 'application/octet-stream' },
    { ...upload, inlineImage: true },
    { ...upload, fileContentsBase64: 42 },
    { ...upload, projectId: 'project-2' },
    { ...upload, createOnly: 'yes' },
    { ...upload, expectedSignature: 42 },
    {},
  ]) {
    assert.equal(check('POST', FILES, { body }), '403 This operation is outside the MCP grant.', JSON.stringify(body));
  }
});

test('a comment edit tags no stakeholder and carries only the text', () => {
  assert.equal(check('PATCH', COMMENT, { body: { body: 'Over to @[Ada](user:user-1).' } }), 'allowed');
  for (const body of [
    { body: 'Over to @[Sam](stakeholder:sh-1).' },
    { body: 'Reworded.', parentCommentId: 'comment-2' },
    { body: 7 },
    {},
  ]) {
    assert.equal(check('PATCH', COMMENT, { body }), '403 This operation is outside the MCP grant.', JSON.stringify(body));
  }
});

test('other file routes, comment votes, memory and goals stay outside the grant', () => {
  for (const [method, url] of [
    ['GET', '/api/files/file-1/content'], ['DELETE', '/api/files/file-1'], ['GET', `${FILES}/file-1/content`],
    ['GET', `${FILES}/file-1`], ['PUT', `${FILES}/file-1`], ['PATCH', `${FILES}/file-1`], ['GET', `${FILES}/file-1/text/extra`],
    ['POST', `${COMMENT}/vote`], ['PUT', COMMENT], ['POST', `${REQ}/my-items`],
    ['GET', '/api/agent-memory?query=x'], ['PATCH', '/api/agent-memory/memory-1'], ['DELETE', '/api/agent-memory/memory-1'],
    ['GET', '/api/agent-goals'], ['POST', '/api/agent-goals'], ['POST', '/api/agent-goals/goal-1/monitors'], ['PATCH', '/api/agent-goals/monitors/monitor-1'],
  ]) {
    assert.equal(check(method, url, { body: {} }), '403 This operation is outside the MCP grant.', `${method} ${url}`);
  }
});

test('grants limited to some projects reach files and comments only in those projects', () => {
  const restricted = { projectIds: ['project-1'], scopes: ['projects.read', 'projects.write'] };
  assert.equal(check('GET', `${FILES}?targetId=project-1&targetType=project`, { grant: restricted }), 'allowed');
  assert.equal(check('POST', FILES, { body: upload, grant: restricted }), 'allowed');
  for (const [method, url, body] of [
    ['GET', '/api/projects/project-2/files?targetId=project-2&targetType=project'],
    ['GET', '/api/projects/project-2/files/file-1/text'],
    ['POST', '/api/projects/project-2/files', { ...upload, targetId: 'project-2' }],
    ['DELETE', '/api/projects/project-2/files/file-1'],
    ['GET', '/api/projects/project-2/requirements/my-items'],
    ['PATCH', '/api/projects/project-2/requirements/topics/topic-1/comments/comment-1', { body: 'Reworded.' }],
    ['DELETE', '/api/projects/project-2/requirements/topics/topic-1/comments/comment-1'],
  ]) {
    assert.equal(check(method, url, { body, grant: restricted }), '404 Project not found.', `${method} ${url}`);
  }
});
