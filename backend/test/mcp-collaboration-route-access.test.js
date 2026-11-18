import assert from 'node:assert/strict';
import test from 'node:test';
import { requireMcpRouteAccess } from '../src/mcp/route-access.js';

// The MCP route allowlist for clarification ownership, stakeholder contacts and invitations,
// and project membership. A grant may save a topic's assignments only with the expected
// invitation recipients that Odin enforces as it saves, may create a stakeholder
// link only when Odin emails it, and stays inside its project restriction on
// both /api/projects and /api/assistant/projects paths. The end-to-end proof through the MCP
// dispatcher is in mcp-collaboration-e2e.test.js.

const PROJECT = 'project-1';
const REQ = `/api/projects/${PROJECT}/requirements`;
const ASSISTANT = `/api/assistant/projects/${PROJECT}`;
const readWrite = { projectIds: [], scopes: ['projects.read', 'projects.write'] };
const readOnly = { projectIds: [], scopes: ['projects.read'] };
const OUTSIDE = '403 This operation is outside the MCP grant.';
const SCOPE = '403 The MCP grant lacks the required scope.';

function check(method, originalUrl, { body, grant = readWrite } = {}) {
  try {
    requireMcpRouteAccess({ body, method, originalUrl }, grant);
    return 'allowed';
  } catch (error) {
    return `${error.statusCode} ${error.message}`;
  }
}

test('clarification, stakeholder, link and member reads are allowed for read grants', () => {
  for (const url of [`${REQ}/topics/topic-1`, `${ASSISTANT}/clarifications`, `${REQ}/links`, `/api/projects/${PROJECT}/valid-users`]) {
    assert.equal(check('GET', url, { grant: readOnly }), 'allowed', url);
    assert.equal(check('GET', url), 'allowed', url);
  }
});

test('writes need projects.write: assignments, contacts, emailed links, revoke, extend and membership', () => {
  const writes = [
    ['PATCH', `${REQ}/topics/topic-1`, { assignments: [], expectedInvitationRecipients: [] }],
    ['POST', `${ASSISTANT}/stakeholder-contacts`, { email: 'a@example.com', name: 'A' }],
    ['POST', `${REQ}/links`, { send: true, stakeholderId: 's-1' }],
    ['POST', `${REQ}/links/link-1/revoke`, undefined],
    ['POST', `${REQ}/links/link-1/extend`, { until: '2026-12-01T00:00:00Z' }],
    ['PUT', `/api/projects/${PROJECT}/permissions`, { validUsers: [] }],
  ];
  for (const [method, url, body] of writes) {
    assert.equal(check(method, url, { body }), 'allowed', `${method} ${url}`);
    assert.equal(check(method, url, { body, grant: readOnly }), SCOPE, `${method} ${url}`);
  }
});

test('a topic save carries assignments with expected invitation recipients, a dismiss or reopen, or text, never a mix, so no save emails anyone unconfirmed', () => {
  const precondition = { assignments: [], expectedInvitationRecipients: [] };
  for (const body of [precondition, { status: 'dismissed' }, { status: 'open' }, { prompt: 'Changed' }, { rationale: '', settles: 'x', suggestedOwnerRole: 'x' }]) {
    assert.equal(check('PATCH', `${REQ}/topics/topic-1`, { body }), 'allowed', JSON.stringify(body));
    assert.equal(check('PATCH', `${REQ}/topics/topic-1`, { body, grant: readOnly }), SCOPE, JSON.stringify(body));
  }
  for (const body of [
    undefined, {}, { assignments: [] }, { expectedInvitationRecipients: [] }, { assignments: [], expectedInvitationRecipients: 's-1' }, { assignments: {}, expectedInvitationRecipients: [] },
    { status: 'resolved' }, { status: 'answered' }, { status: 'dismissed', prompt: 'Changed' }, { prompt: 'Changed', assignments: [] },
    { ...precondition, status: 'dismissed' }, { ...precondition, prompt: 'Changed' }, { ...precondition, rationale: 'x' }, { ...precondition, settles: 'x' }, { ...precondition, suggestedOwnerRole: 'x' },
    { prompt: 'Changed', unknown: true },
  ]) {
    assert.equal(check('PATCH', `${REQ}/topics/topic-1`, { body }), OUTSIDE, JSON.stringify(body));
  }
});

test('a stakeholder link can be created only with send: true', () => {
  for (const body of [undefined, {}, { stakeholderId: 's-1' }, { send: false, stakeholderId: 's-1' }, { send: 'true', stakeholderId: 's-1' }]) {
    assert.equal(check('POST', `${REQ}/links`, { body }), OUTSIDE, JSON.stringify(body));
  }
});

test('neighbouring assistant, project administration and topic routes stay closed', () => {
  const denied = [
    ['GET', '/api/assistant/settings'],
    ['GET', '/api/assistant/sessions'],
    ['POST', '/api/assistant/sessions'],
    ['GET', '/api/assistant/sessions/session-1'],
    ['POST', '/api/assistant/sessions/session-1/turn'],
    ['POST', '/api/assistant/sessions/session-1/stakeholder-contacts'],
    ['PATCH', '/api/assistant/sessions/session-1/clarifications/c-1'],
    ['POST', '/api/assistant/sessions/session-1/synthesize-clarifications'],
    ['POST', '/api/assistant/sessions/session-1/commit'],
    ['GET', `${ASSISTANT}/stakeholder-contacts`],
    ['DELETE', `${ASSISTANT}/stakeholder-contacts/s-1`],
    ['PUT', `${ASSISTANT}/clarifications`],
    ['GET', `${ASSISTANT}/clarifications/extra`],
    ['PUT', `/api/projects/${PROJECT}/valid-users`],
    ['GET', `/api/projects/${PROJECT}/permissions`],
    ['PATCH', `/api/projects/${PROJECT}/permissions`],
    ['PUT', `/api/projects/${PROJECT}/tree`],
    ['POST', `/api/projects/${PROJECT}/ticket-intake-invitations`],
    // Fixed routes beside /api/projects/:id are not project reads: the review queue holds unreviewed tickets.
    ['GET', '/api/projects/ticket-review-queue'], ['GET', '/api/projects/deleted'], ['PUT', '/api/projects/tickets'], ['PUT', '/api/projects/import'],
    ['GET', '/api/tenants/invites'],
    ['POST', '/api/tenants/invites'],
    ['POST', '/api/identity/groups/group-1/members'],
    ['PUT', `${REQ}/topics/topic-1`],
    ['GET', `${REQ}/topics/topic-1/extra`],
    ['DELETE', `${REQ}/links/link-1`],
    ['GET', `${REQ}/links/link-1`],
    ['POST', `${REQ}/links/link-1/other`],
  ];
  for (const [method, url] of denied) {
    assert.equal(check(method, url, { body: { assignments: [], expectedInvitationRecipients: [], send: true } }), OUTSIDE, `${method} ${url}`);
  }
});

test('project-restricted grants reach these routes only for their projects, including assistant paths', () => {
  const restricted = { projectIds: [PROJECT], scopes: ['projects.read', 'projects.write'] };
  assert.equal(check('GET', `${ASSISTANT}/clarifications`, { grant: restricted }), 'allowed');
  assert.equal(check('PUT', `/api/projects/${PROJECT}/permissions`, { grant: restricted }), 'allowed');
  for (const [method, url, body] of [
    ['GET', '/api/assistant/projects/project-2/clarifications'],
    ['POST', '/api/assistant/projects/project-2/stakeholder-contacts'],
    ['GET', '/api/projects/project-2/valid-users'],
    ['PUT', '/api/projects/project-2/permissions'],
    ['PATCH', '/api/projects/project-2/requirements/topics/topic-1', { assignments: [], expectedInvitationRecipients: [] }],
    ['POST', '/api/projects/project-2/requirements/links', { send: true, stakeholderId: 's-1' }],
  ]) {
    assert.equal(check(method, url, { body, grant: restricted }), '404 Project not found.', `${method} ${url}`);
  }
});
