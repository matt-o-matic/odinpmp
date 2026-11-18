import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OdinApiError } from '../src/mcp/api-client.js';
import { PROJECT_MEMBER_ROLES } from '../src/mcp/member-tools.js';
import { createOdinMcpServer } from '../src/mcp/server.js';

// Clarification, stakeholder, invitation and member tools against a fake Odin REST API:
// request composition, owner/also-involve semantics, invitation recipient confirmation,
// token stripping, member list read-modify-write and error mapping. Nothing here can send
// mail. The end-to-end flow over HTTP with OAuth is in mcp-collaboration-e2e.test.js.

const PROJECT = 'project-1';
const REQ = `/api/projects/${PROJECT}/requirements`;
const ASSISTANT = `/api/assistant/projects/${PROJECT}`;
const SECRETS = { accessToken: 'secret-access-token-1', invitationToken: 'secret-invitation-token-1', replyToken: 'secret-reply-token-1' };
const SECRET_VALUES = [...Object.values(SECRETS), 'secret-link-token', 'https://app.example/requirements/secret-link-token', 'secret-hash'];
const COLLABORATION_TOOLS = {
  odin_add_stakeholder: { destructive: false, write: true },
  odin_assign_clarification: { destructive: true, write: true },
  odin_extend_stakeholder_link: { destructive: false, write: true },
  odin_get_clarification: { write: false },
  odin_list_clarifications: { write: false },
  odin_list_project_members: { write: false },
  odin_list_stakeholder_links: { write: false },
  odin_list_stakeholders: { write: false },
  odin_preview_clarification_assignment: { write: false },
  odin_preview_stakeholder_invitation: { write: false },
  odin_revoke_stakeholder_link: { destructive: true, write: true },
  odin_send_stakeholder_invitation: { destructive: false, write: true },
  odin_update_project_members: { destructive: true, write: true },
  odin_update_stakeholder: { destructive: true, write: true },
};

const assignment = (actorType, actorId, label, role, invitation = {}) => ({ actorId, actorType, id: `a-${actorId}`, label, role, ...invitation });
const userOwner = assignment('user', 'user-1', 'Una User', 'primary', { mailStatus: '' });
const samSent = assignment('stakeholder', 'stake-1', 'Sam Stake', 'collaborator', { mailStatus: 'sent' });

function topicRow(id, assignments) {
  return {
    assignments, commentsOpen: true, createdAt: '2026-10-01T00:00:00.000Z', decision: null, evidence: { comments: 1, contributors: 1 }, id,
    lastActivityAt: '2026-10-02T00:00:00.000Z', prompt: `Prompt for ${id}`, rationale: 'Why it matters', settles: 'Pricing', sourceRef: 'brief:requirements:0',
    state: 'open', status: 'open', suggestedOwnerRole: 'Finance', summary: { proposedAnswer: 'A range.' }, track: 'experience', updatedAt: '2026-10-02T00:00:00.000Z',
  };
}

function stakeholderState() {
  return {
    ok: true,
    stakeholderContacts: [],
    stakeholders: [
      { accessToken: SECRETS.accessToken, createdAt: '2026-09-01T00:00:00.000Z', email: 'sam@client.example', id: 'stake-1', name: 'Sam Stake', roleTitle: 'CFO' },
      { accessToken: 'secret-access-token-2', createdAt: '2026-09-02T00:00:00.000Z', email: 'tia@client.example', id: 'stake-2', name: 'Tia New', roleTitle: '' },
      { accessToken: 'secret-access-token-3', createdAt: '2026-09-03T00:00:00.000Z', email: 'pat@client.example', id: 'stake-3', name: 'Pat Pending', roleTitle: 'Ops' },
    ],
    clarifications: [
      { assignments: [{ ...userOwner, ...SECRETS }, { ...samSent, ...SECRETS, queuedAt: '2026-10-01T01:00:00.000Z', sentAt: '2026-10-01T01:01:00.000Z' }], id: 'topic-1', prompt: 'Prompt for topic-1', status: 'open' },
      // An invitation that was created but never queued: the next save re-sends it.
      { assignments: [{ ...assignment('stakeholder', 'stake-3', 'Pat Pending', 'primary', { mailStatus: 'pending', queuedAt: null }), ...SECRETS }], id: 'topic-2', prompt: 'Prompt for topic-2', status: 'open' },
    ],
  };
}

const link = (overrides = {}) => ({
  createdBy: { id: 'user-1', name: 'Una User', ref: 'user:user-1', type: 'user' }, expiresAt: null, extendedUntil: null, id: 'link-1', involvementActive: true,
  issuedAt: '2026-10-01T00:00:00.000Z', lastInvolvementEndedAt: null, lastUsedAt: null, linkRequest: null, revokedAt: null,
  stakeholder: { email: 'sam@client.example', id: 'stake-1', name: 'Sam Stake', roleTitle: 'CFO' }, status: 'active',
  tokenHash: 'secret-hash', tokens: [{ createdAt: '2026-10-01T00:00:00.000Z', id: 'token-1', lastUsedAt: null, purpose: 'invitation', revokedAt: null, tokenHash: 'secret-hash' }],
  ...overrides,
});

const membership = () => ({
  ok: true,
  project_users: [
    { default_bill_rate: '120.00', email: 'una@acme.example', id: 'user-1', min_bill_rate: '90.00', name: 'Una User', project_allocation: '0.5', project_bill_rate: '150.00', role: 'admin' },
    { default_bill_rate: null, email: 'mo@acme.example', id: 'user-2', min_bill_rate: null, name: 'Mo Member', project_allocation: null, project_bill_rate: '99.50', role: 'user' },
  ],
  tenant_users: [
    { email: 'una@acme.example', id: 'user-1', name: 'Una User', role: 'admin' },
    { email: 'mo@acme.example', id: 'user-2', name: 'Mo Member', role: 'user' },
    { email: 'cat@acme.example', id: 'user-3', name: 'Cat Candidate', role: 'manager' },
    { email: 'dee@acme.example', id: 'user-4', name: 'Dee Candidate', role: 'user' },
  ],
  validStatusTypes: {},
  validTaskTypes: {},
});

function routes(overrides = {}) {
  return {
    [`GET ${REQ}/tracks/experience/topics`]: () => ({ counts: { total: 2 }, ok: true, topics: [topicRow('topic-1', [userOwner, samSent]), topicRow('topic-2', [assignment('stakeholder', 'stake-3', 'Pat Pending', 'primary', { mailStatus: 'pending' })])] }),
    [`GET ${REQ}/topics/topic-1`]: () => ({ ok: true, topic: { ...topicRow('topic-1', [userOwner, samSent]), comments: [{ body: 'Hello', id: 'c-1' }], decisions: [], files: [{ fileName: 'notes.pdf', id: 'f-1' }], summary: null, summaryStatus: { refreshPending: false } } }),
    [`GET ${REQ}/topics/topic-2`]: () => ({ ok: true, topic: topicRow('topic-2', [assignment('stakeholder', 'stake-3', 'Pat Pending', 'primary', { mailStatus: 'pending' })]) }),
    [`PATCH ${REQ}/topics/topic-1`]: ({ body }) => ({ ok: true, topic: topicRow('topic-1', body.assignments.map((entry) => ({ ...entry, id: `saved-${entry.actorId}`, mailStatus: entry.actorType === 'stakeholder' ? 'pending' : '' }))) }),
    [`PATCH ${REQ}/topics/topic-2`]: ({ body }) => ({ ok: true, topic: topicRow('topic-2', body.assignments) }),
    [`GET ${ASSISTANT}/clarifications`]: () => stakeholderState(),
    [`POST ${ASSISTANT}/stakeholder-contacts`]: ({ body }) => ({ contact: { ...body, accessToken: SECRETS.accessToken, createdAt: '2026-10-05T00:00:00.000Z', id: body.email === 'sam@client.example' ? 'stake-1' : 'stake-9' }, ok: true, stakeholders: [] }),
    [`PATCH ${ASSISTANT}/stakeholder-contacts/stake-1`]: ({ body }) => ({ contact: { accessToken: SECRETS.accessToken, createdAt: '2026-10-05T00:00:00.000Z', email: 'sam@client.example', id: 'stake-1', name: 'Sam Stake', roleTitle: '', ...body }, ok: true, stakeholders: [] }),
    [`GET ${REQ}/rounds`]: () => ({ ok: true, rounds: [{ dueAt: null, id: 'round-1', number: 1, reviewers: [{ actorId: 'stake-1', actorType: 'stakeholder', id: 'r-1', mailStatus: 'sent', required: true, submittedAt: null }, { actorId: 'user-1', actorType: 'user', id: 'r-2', mailStatus: 'sent', required: false, submittedAt: null }], status: 'open', title: 'Client booking', track: 'experience' }] }),
    [`GET ${REQ}/links`]: () => ({ links: [link()], ok: true }),
    [`POST ${REQ}/links`]: () => ({ email: { recipient: 'tia@client.example', sent: true }, link: link({ id: 'link-2', stakeholder: { email: 'tia@client.example', id: 'stake-2', name: 'Tia New', roleTitle: '' } }), ok: true, reactivated: false, regenerated: false, token: 'secret-link-token', tokenId: 'token-9', url: 'https://app.example/requirements/secret-link-token' }),
    [`POST ${REQ}/links/link-1/revoke`]: () => ({ link: link({ revokedAt: '2026-10-06T00:00:00.000Z', status: 'revoked' }), ok: true }),
    [`POST ${REQ}/links/link-1/extend`]: ({ body }) => ({ link: link({ extendedUntil: body.until }), ok: true }),
    [`GET /api/projects/${PROJECT}/valid-users`]: () => membership(),
    [`PUT /api/projects/${PROJECT}/permissions`]: ({ body }) => ({ message: 'Project permissions updated.', ok: true, project_users: body.validUsers.map((entry) => ({ ...membership().tenant_users.find((user) => user.id === entry.id), ...entry, default_bill_rate: '1.00' })) }),
    ...overrides,
  };
}

async function session(t, overrides) {
  const table = routes(overrides);
  const calls = [];
  const api = {
    async request(method, path, options = {}) {
      calls.push({ body: options.body, method, path, query: options.query });
      const handler = table[`${method} ${path}`];
      if (!handler) throw new Error(`Unexpected ${method} ${path}`);
      return handler(options);
    },
  };
  const server = createOdinMcpServer({ api, oauth: true });
  const client = new Client({ name: 'collaboration-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  async function call(name, args = {}) {
    const result = await client.callTool({ arguments: args, name }, undefined, { timeout: 2000 });
    const data = JSON.parse(result.content[0].text);
    assert.deepEqual(result.structuredContent, data);
    return { data, isError: result.isError === true };
  }
  return {
    calls,
    client,
    writes: () => calls.filter((entry) => entry.method !== 'GET'),
    async ok(name, args) {
      const { data, isError } = await call(name, args);
      assert.equal(isError, false, JSON.stringify(data));
      return data;
    },
    async fails(name, args, code) {
      const { data, isError } = await call(name, args);
      assert.equal(isError, true, JSON.stringify(data));
      assert.equal(data.error.code, code, JSON.stringify(data));
      return data.error;
    },
  };
}

function assertNoSecrets(value) {
  const text = JSON.stringify(value);
  for (const secret of SECRET_VALUES) assert.equal(text.includes(secret), false, `leaked ${secret}`);
  assert.doesNotMatch(text, /accessToken|invitationToken|replyToken|tokenHash|"token"|"url"/);
}

test('discovery lists the clarification, stakeholder and member tools with accurate annotations and scopes', async (t) => {
  const { client } = await session(t);
  const { tools } = await client.listTools();
  for (const [name, expected] of Object.entries(COLLABORATION_TOOLS)) {
    const tool = tools.find((entry) => entry.name === name);
    assert.ok(tool, name);
    assert.equal(tool.inputSchema.additionalProperties, false, name);
    assert.equal(tool.annotations.readOnlyHint, !expected.write, name);
    assert.equal(tool.annotations.destructiveHint, Boolean(expected.destructive), name);
    assert.deepEqual(tool._meta.securitySchemes[0].scopes, expected.write ? ['projects.read', 'projects.write'] : ['projects.read'], name);
  }
});

test('clarification reads present the single owner and also-involved people, with stakeholder invitation status', async (t) => {
  const env = await session(t);
  const list = await env.ok('odin_list_clarifications', { projectId: PROJECT, search: 'price', track: 'experience', view: 'open', limit: 1 });
  assert.deepEqual(env.calls[0].query, { q: 'price', view: 'open' });
  assert.equal(list.total, 2);
  assert.deepEqual(list.items[0].owner, { actorId: 'user-1', actorType: 'user', label: 'Una User' });
  assert.deepEqual(list.items[0].alsoInvolve, [{ actorId: 'stake-1', actorType: 'stakeholder', invitationStatus: 'sent', label: 'Sam Stake' }]);
  assert.equal(list.items[0].proposedAnswer, 'A range.');
  assert.equal(list.items[0].assignments, undefined);
  const next = await env.ok('odin_list_clarifications', { projectId: PROJECT, search: 'price', track: 'experience', view: 'open', limit: 1, cursor: list.nextCursor });
  assert.equal(next.items[0].owner.actorId, 'stake-3');
  assert.equal(next.nextCursor, null);

  const one = await env.ok('odin_get_clarification', { clarificationId: 'topic-1', projectId: PROJECT });
  assert.equal(one.clarification.owner.actorId, 'user-1');
  assert.deepEqual(one.clarification.comments, [{ body: 'Hello', id: 'c-1' }]);
  assert.deepEqual(one.clarification.files, [{ fileName: 'notes.pdf', id: 'f-1' }]);
  assert.equal(env.writes().length, 0);

  const missing = await session(t, { [`GET ${REQ}/topics/topic-1`]: () => { throw new OdinApiError(404, 'http_404', 'Not found'); } });
  await missing.fails('odin_get_clarification', { clarificationId: 'topic-1', projectId: PROJECT }, 'clarification_not_found');

  // The single-topic read nests the proposed answer under summary.output; list rows carry it directly.
  const summarized = await session(t, { [`GET ${REQ}/topics/topic-1`]: () => ({ ok: true, topic: { ...topicRow('topic-1', [userOwner]), summary: { current: true, id: 'summary-1', output: { proposedAnswer: 'Show a range on the home screen.' } } } }) });
  assert.equal((await summarized.ok('odin_get_clarification', { clarificationId: 'topic-1', projectId: PROJECT })).clarification.proposedAnswer, 'Show a range on the home screen.');
});

test('stakeholder reads keep names, emails, roles and invitation status, and drop every token', async (t) => {
  const env = await session(t);
  const result = await env.ok('odin_list_stakeholders', { projectId: PROJECT });
  assertNoSecrets(result);
  assert.deepEqual(result.items.map((stakeholder) => stakeholder.id), ['stake-1', 'stake-2', 'stake-3']);
  assert.deepEqual(result.items[0].clarifications, [{
    clarificationId: 'topic-1', invitation: { lastInboundAt: null, queuedAt: '2026-10-01T01:00:00.000Z', scheduledAt: null, sentAt: '2026-10-01T01:01:00.000Z', status: 'sent' }, prompt: 'Prompt for topic-1', role: 'alsoInvolve', status: 'open',
  }]);
  assert.equal(result.items[2].clarifications[0].role, 'owner');
  assert.deepEqual(result.items[0].reviews, [{ dueAt: null, invitationStatus: 'sent', number: 1, required: true, roundId: 'round-1', roundStatus: 'open', submittedAt: null, title: 'Client booking', track: 'experience' }]);
  assert.deepEqual(result.items[1].reviews, []);
  assert.deepEqual((await env.ok('odin_list_stakeholders', { projectId: PROJECT, search: 'OPS' })).items.map((stakeholder) => stakeholder.id), ['stake-3']);
});

test('a stakeholder edit sends only the changed fields and returns the contact without its token', async (t) => {
  const env = await session(t);
  const result = await env.ok('odin_update_stakeholder', { name: 'Samantha Stake', projectId: PROJECT, roleTitle: 'Ops lead', stakeholderId: 'stake-1' });
  assertNoSecrets(result);
  assert.deepEqual([result.stakeholder.name, result.stakeholder.roleTitle, result.stakeholder.email], ['Samantha Stake', 'Ops lead', 'sam@client.example']);
  assert.equal(result.previous.name, 'Sam Stake');
  assert.deepEqual(env.writes().map((call) => [call.method, call.path, call.body]), [['PATCH', `${ASSISTANT}/stakeholder-contacts/stake-1`, { name: 'Samantha Stake', roleTitle: 'Ops lead' }]]);
  await env.fails('odin_update_stakeholder', { projectId: PROJECT, stakeholderId: 'stake-1' }, 'invalid_stakeholder');
  await env.fails('odin_update_stakeholder', { name: 'X', projectId: PROJECT, stakeholderId: 'nobody' }, 'stakeholder_not_found');
});

test('preview computes the saved people and exactly who would be emailed, without writing', async (t) => {
  const env = await session(t);
  const preview = await env.ok('odin_preview_clarification_assignment', { clarificationId: 'topic-1', owner: { actorId: 'stake-2', actorType: 'stakeholder' }, projectId: PROJECT });
  assertNoSecrets(preview);
  assert.equal(env.writes().length, 0);
  assert.equal(preview.writePermissionChecked, false);
  assert.deepEqual(preview.proposed.owner, { actorId: 'stake-2', actorType: 'stakeholder', label: 'Tia New' });
  assert.deepEqual(preview.proposed.alsoInvolve.map((person) => person.actorId), ['stake-1'], 'omitted alsoInvolve keeps the current list');
  assert.deepEqual(preview.changes, {
    added: [{ actorId: 'stake-2', actorType: 'stakeholder', as: 'owner', label: 'Tia New' }],
    removed: [{ actorId: 'user-1', actorType: 'user', label: 'Una User', was: 'owner' }],
    roleChanged: [],
  });
  // Sam already has a sent invitation on this clarification, so only Tia is invited.
  assert.deepEqual(preview.invitationEmails.map(({ digest: _digest, ...recipient }) => recipient), [{ email: 'tia@client.example', name: 'Tia New', reason: 'new-invitation', stakeholderId: 'stake-2' }]);
  assert.equal(preview.invitationEmails[0].digest.otherWaitingTopics, 0);
  assert.ok(Math.abs(Date.parse(preview.invitationEmails[0].digest.sendsAfter) - (Date.now() + 20 * 60_000)) < 5000, 'saving now restarts the 20-minute quiet period');
  assert.deepEqual([preview.delivery.mode, preview.delivery.quietMinutes], ['digest', 20]);
  assert.deepEqual(preview.confirmInvitationEmails, ['stake-2']);

  const unsent = await env.ok('odin_preview_clarification_assignment', { alsoInvolve: [{ actorId: 'user-1', actorType: 'user' }], clarificationId: 'topic-2', projectId: PROJECT });
  assert.deepEqual(unsent.invitationEmails.map(({ digest: _digest, ...recipient }) => recipient), [{ email: 'pat@client.example', name: 'Pat Pending', reason: 'unsent-invitation', stakeholderId: 'stake-3' }]);

  const unknown = await env.ok('odin_preview_clarification_assignment', { alsoInvolve: [{ actorId: 'stake-404', actorType: 'stakeholder' }], clarificationId: 'topic-1', projectId: PROJECT });
  assert.deepEqual(unknown.problems.map((problem) => [problem.code, problem.actorId]), [['unknown_stakeholder', 'stake-404']]);
  assert.match(unknown.nextStep, /Fix the problems/);
  await env.fails('odin_preview_clarification_assignment', { clarificationId: 'topic-1', projectId: PROJECT }, 'invalid_assignment');
  assert.equal(env.writes().length, 0);
});

test('assigning saves only when confirmInvitationEmails matches the recipients, and sends the native assignment list', async (t) => {
  const env = await session(t);
  const change = { clarificationId: 'topic-1', owner: { actorId: 'stake-2', actorType: 'stakeholder' }, projectId: PROJECT };

  const unconfirmed = await env.fails('odin_assign_clarification', change, 'invitation_confirmation_required');
  assert.equal(unconfirmed.status, 409);
  assert.deepEqual(unconfirmed.details.confirmInvitationEmails, ['stake-2']);
  assert.equal(unconfirmed.details.invitationEmails[0].email, 'tia@client.example');
  await env.fails('odin_assign_clarification', { ...change, confirmInvitationEmails: ['stake-2', 'stake-1'] }, 'invitation_confirmation_required');
  assert.equal(env.writes().length, 0, 'nothing is saved without the exact confirmation');

  const saved = await env.ok('odin_assign_clarification', { ...change, confirmInvitationEmails: ['stake-2'] });
  assert.deepEqual(env.writes().map(({ body, method, path }) => ({ body, method, path })), [{ method: 'PATCH', path: `${REQ}/topics/topic-1`, body: { assignments: [
    { actorId: 'stake-2', actorType: 'stakeholder', label: 'Tia New', role: 'primary' },
    { actorId: 'stake-1', actorType: 'stakeholder', label: 'Sam Stake', role: 'collaborator' },
  ], expectedInvitationRecipients: ['stake-2'] } }], 'the confirmed recipients travel with the save, for Odin to enforce');
  assert.equal(saved.changed, true);
  assert.equal(saved.clarification.owner.actorId, 'stake-2');
  assert.deepEqual(saved.invitationEmails.map((recipient) => recipient.stakeholderId), ['stake-2']);
  assertNoSecrets(saved);

  // Odin's own check at save time (state changed after the tool's reads) maps to the same code and is not an unknown outcome.
  const changedMeanwhile = await session(t, { [`PATCH ${REQ}/topics/topic-1`]: () => { throw new OdinApiError(409, 'http_409', 'Conflict'); } });
  const conflict = await changedMeanwhile.fails('odin_assign_clarification', { ...change, confirmInvitationEmails: ['stake-2'] }, 'invitation_confirmation_required');
  assert.deepEqual([conflict.status, conflict.outcomeUnknown], [409, false]);
  assert.match(conflict.message, /Nothing was saved or scheduled/);
});

test('required people are their own list: marking someone required moves them out of also-involve and emails nobody new', async (t) => {
  const env = await session(t);
  const saved = await env.ok('odin_assign_clarification', { clarificationId: 'topic-1', projectId: PROJECT, required: [{ actorId: 'stake-1', actorType: 'stakeholder' }] });
  assert.deepEqual(env.writes().at(-1).body.assignments.map(({ actorId, role }) => [actorId, role]), [['user-1', 'primary'], ['stake-1', 'required']]);
  assert.deepEqual(saved.changes.roleChanged.map(({ actorId, from, to }) => [actorId, from, to]), [['stake-1', 'alsoInvolve', 'required']]);
  assert.deepEqual(saved.invitationEmails, []);

  // The owner is never also required, and someone listed in both lists is required.
  const preview = await env.ok('odin_preview_clarification_assignment', {
    alsoInvolve: [{ actorId: 'stake-2', actorType: 'stakeholder' }],
    clarificationId: 'topic-1',
    projectId: PROJECT,
    required: [{ actorId: 'user-1', actorType: 'user' }, { actorId: 'stake-2', actorType: 'stakeholder' }],
  });
  assert.deepEqual(preview.proposed.required.map((person) => person.actorId), ['stake-2']);
  assert.deepEqual(preview.proposed.alsoInvolve, []);
});

test('assignment semantics: owner moves out of also-involve, clearing needs no confirmation, unchanged lists are not saved', async (t) => {
  const env = await session(t);
  // Promoting Sam (already involved, invitation sent) to owner moves Sam out of alsoInvolve and emails nobody.
  const promoted = await env.ok('odin_assign_clarification', { alsoInvolve: [{ actorId: 'stake-1', actorType: 'stakeholder' }, { actorId: 'user-1', actorType: 'user' }], clarificationId: 'topic-1', owner: { actorId: 'stake-1', actorType: 'stakeholder' }, projectId: PROJECT });
  assert.deepEqual(env.writes().at(-1).body.assignments.map(({ actorId, role }) => [actorId, role]), [['stake-1', 'primary'], ['user-1', 'collaborator']]);
  assert.deepEqual(promoted.changes.roleChanged.map(({ actorId, from, to }) => [actorId, from, to]), [['stake-1', 'alsoInvolve', 'owner'], ['user-1', 'owner', 'alsoInvolve']]);
  assert.deepEqual(promoted.invitationEmails, []);

  await env.ok('odin_assign_clarification', { alsoInvolve: [], clarificationId: 'topic-1', owner: null, projectId: PROJECT });
  assert.deepEqual(env.writes().at(-1).body, { assignments: [], expectedInvitationRecipients: [] });

  const before = env.writes().length;
  const unchanged = await env.ok('odin_assign_clarification', { alsoInvolve: [{ actorId: 'stake-1', actorType: 'stakeholder' }], clarificationId: 'topic-1', owner: { actorId: 'user-1', actorType: 'user' }, projectId: PROJECT });
  assert.equal(unchanged.changed, false);
  assert.equal(env.writes().length, before);

  await env.fails('odin_assign_clarification', { alsoInvolve: [{ actorId: 'stake-404', actorType: 'stakeholder' }], clarificationId: 'topic-1', projectId: PROJECT }, 'invalid_assignment');
  const dryRun = await env.ok('odin_assign_clarification', { clarificationId: 'topic-1', dryRun: true, owner: null, projectId: PROJECT });
  assert.equal(dryRun.validation, 'schema_only');
  assert.equal(env.writes().length, before);

  const rejected = await session(t, { [`PATCH ${REQ}/topics/topic-1`]: () => { throw new OdinApiError(400, 'http_400', 'Bad'); } });
  await rejected.fails('odin_assign_clarification', { clarificationId: 'topic-1', owner: { actorId: 'user-9', actorType: 'user' }, projectId: PROJECT }, 'invalid_assignment');
  const unknownOutcome = await session(t, { [`PATCH ${REQ}/topics/topic-1`]: () => { throw new OdinApiError(null, 'timeout', 'Timed out', { outcomeUnknown: true }); } });
  const timeout = await unknownOutcome.fails('odin_assign_clarification', { clarificationId: 'topic-1', owner: { actorId: 'user-9', actorType: 'user' }, projectId: PROJECT }, 'timeout');
  assert.equal(timeout.outcomeUnknown, true);
});

test('adding a stakeholder reports an email match and never returns tokens', async (t) => {
  const env = await session(t);
  const dryRun = await env.ok('odin_add_stakeholder', { dryRun: true, input: { email: 'new@client.example', name: 'New Person' }, projectId: PROJECT });
  assert.deepEqual(dryRun.request, { body: { email: 'new@client.example', name: 'New Person', roleTitle: '' }, method: 'POST', path: `${ASSISTANT}/stakeholder-contacts` });
  assert.equal(env.calls.length, 0);

  const created = await env.ok('odin_add_stakeholder', { input: { email: 'new@client.example', name: 'New Person', roleTitle: 'COO' }, projectId: PROJECT });
  assert.deepEqual([created.stakeholder.id, created.updatedExisting, created.previous], ['stake-9', false, null]);
  const updated = await env.ok('odin_add_stakeholder', { input: { email: 'SAM@client.example', name: 'Samuel Stake' }, projectId: PROJECT });
  assert.equal(updated.updatedExisting, true);
  assert.equal(updated.previous.name, 'Sam Stake');
  assertNoSecrets([created, updated]);
  await env.fails('odin_add_stakeholder', { input: { email: 'not-an-email', name: 'X' }, projectId: PROJECT }, 'validation_error');

  const denied = await session(t, { [`POST ${ASSISTANT}/stakeholder-contacts`]: () => { throw new OdinApiError(403, 'http_403', 'x'); } });
  assert.match((await denied.fails('odin_add_stakeholder', { input: { email: 'a@client.example', name: 'A' }, projectId: PROJECT }, 'http_403')).message, /admins and managers/);
});

test('stakeholder links: list, preview and send never expose link tokens, and send requires the current recipient', async (t) => {
  const env = await session(t);
  const links = await env.ok('odin_list_stakeholder_links', { projectId: PROJECT });
  assertNoSecrets(links);
  assert.deepEqual(links.items[0].tokens, [{ createdAt: '2026-10-01T00:00:00.000Z', id: 'token-1', lastUsedAt: null, purpose: 'invitation', revokedAt: null }]);

  const fresh = await env.ok('odin_preview_stakeholder_invitation', { projectId: PROJECT, stakeholderId: 'stake-2' });
  assert.deepEqual([fresh.outcome, fresh.recipient, fresh.confirmRecipientEmail, fresh.link], ['create-link', 'tia@client.example', 'tia@client.example', null]);
  assert.equal((await env.ok('odin_preview_stakeholder_invitation', { projectId: PROJECT, stakeholderId: 'stake-1' })).outcome, 'issue-additional-token');
  const revoked = await session(t, { [`GET ${REQ}/links`]: () => ({ links: [link({ revokedAt: '2026-10-03T00:00:00.000Z', status: 'revoked' })], ok: true }) });
  assert.equal((await revoked.ok('odin_preview_stakeholder_invitation', { projectId: PROJECT, stakeholderId: 'stake-1' })).outcome, 'reactivate-link');
  await env.fails('odin_preview_stakeholder_invitation', { projectId: PROJECT, stakeholderId: 'stake-404' }, 'stakeholder_not_found');
  assert.equal(env.writes().length, 0);

  const mismatch = await env.fails('odin_send_stakeholder_invitation', { confirmRecipientEmail: 'someone@else.example', projectId: PROJECT, stakeholderId: 'stake-2' }, 'recipient_mismatch');
  assert.equal(mismatch.details.recipient, 'tia@client.example');
  assert.equal(env.writes().length, 0, 'a mismatched recipient sends nothing');

  const dryRun = await env.ok('odin_send_stakeholder_invitation', { confirmRecipientEmail: 'tia@client.example', dryRun: true, projectId: PROJECT, stakeholderId: 'stake-2' });
  assert.deepEqual(dryRun.request.body, { send: true, stakeholderId: 'stake-2' });
  assert.equal(env.writes().length, 0);

  const sent = await env.ok('odin_send_stakeholder_invitation', { confirmRecipientEmail: 'TIA@client.example', projectId: PROJECT, stakeholderId: 'stake-2' });
  assert.deepEqual(env.writes().map(({ body, method, path }) => ({ body, method, path })), [{ body: { send: true, stakeholderId: 'stake-2' }, method: 'POST', path: `${REQ}/links` }]);
  assert.deepEqual([sent.email, sent.outcome, sent.tokenId, sent.link.id], [{ recipient: 'tia@client.example', sent: true }, 'created-link', 'token-9', 'link-2']);
  assertNoSecrets(sent);

  const queueFailed = await session(t, { [`POST ${REQ}/links`]: () => ({ email: { reason: 'queue-failed', recipient: 'tia@client.example', sent: false }, link: link(), ok: true, reactivated: true, regenerated: true, token: 'secret-link-token', tokenId: 'token-10', url: 'https://app.example/requirements/secret-link-token' }) });
  const failed = await queueFailed.ok('odin_send_stakeholder_invitation', { confirmRecipientEmail: 'tia@client.example', projectId: PROJECT, stakeholderId: 'stake-2' });
  assert.deepEqual([failed.email.sent, failed.email.reason, failed.outcome], [false, 'queue-failed', 'reactivated-link']);
  assert.match(failed.nextStep, /could not queue the email/);
  assertNoSecrets(failed);

  const noRights = await session(t, { [`GET ${REQ}/links`]: () => { throw new OdinApiError(404, 'http_404', 'x'); } });
  assert.match((await noRights.fails('odin_list_stakeholder_links', { projectId: PROJECT }, 'http_404')).message, /decision rights/);
});

test('revoking and extending a link use the native routes and map their errors', async (t) => {
  const env = await session(t);
  assert.equal((await env.ok('odin_revoke_stakeholder_link', { linkId: 'link-1', projectId: PROJECT })).link.status, 'revoked');
  const until = '2026-12-01T00:00:00+00:00';
  assert.equal((await env.ok('odin_extend_stakeholder_link', { linkId: 'link-1', projectId: PROJECT, until })).link.extendedUntil, until);
  assert.deepEqual(env.writes().map(({ body, path }) => [path, body]), [[`${REQ}/links/link-1/revoke`, undefined], [`${REQ}/links/link-1/extend`, { until }]]);
  await env.fails('odin_extend_stakeholder_link', { linkId: 'link-1', projectId: PROJECT, until: 'next week' }, 'validation_error');
  assert.equal((await env.ok('odin_revoke_stakeholder_link', { dryRun: true, linkId: 'link-1', projectId: PROJECT })).validation, 'schema_only');
  assert.equal(env.writes().length, 2);

  const conflict = await session(t, { [`POST ${REQ}/links/link-1/extend`]: () => { throw new OdinApiError(409, 'http_409', 'x'); } });
  await conflict.fails('odin_extend_stakeholder_link', { linkId: 'link-1', projectId: PROJECT, until }, 'link_revoked');
  const missing = await session(t, { [`POST ${REQ}/links/link-1/revoke`]: () => { throw new OdinApiError(404, 'http_404', 'x'); } });
  await missing.fails('odin_revoke_stakeholder_link', { linkId: 'link-1', projectId: PROJECT }, 'link_not_found');
});

test('member reads list members, candidates and roles without allocation or bill rates', async (t) => {
  const env = await session(t);
  const result = await env.ok('odin_list_project_members', { limit: 1, projectId: PROJECT });
  assert.deepEqual(result.members, [
    { email: 'mo@acme.example', name: 'Mo Member', role: 'user', tenantRole: 'user', userId: 'user-2' },
    { email: 'una@acme.example', name: 'Una User', role: 'admin', tenantRole: 'admin', userId: 'user-1' },
  ]);
  assert.deepEqual(result.candidates, [{ email: 'cat@acme.example', name: 'Cat Candidate', tenantRole: 'manager', userId: 'user-3' }]);
  assert.equal(result.candidatesTotal, 2);
  assert.doesNotMatch(JSON.stringify(result), /bill_rate|allocation|150\.00|99\.50/);
  assert.deepEqual(result.roles.map((role) => role.role), PROJECT_MEMBER_ROLES);
  assert.deepEqual(PROJECT_MEMBER_ROLES, ['admin', 'manager', 'user']);
  assert.deepEqual(result.roles.map((role) => [role.role, role.decisionRights, role.capabilities.includes('project.admin'), role.capabilities.includes('project.plan.edit')]), [
    ['admin', true, true, true], ['manager', true, false, true], ['user', false, false, false],
  ]);
  const page2 = await env.ok('odin_list_project_members', { cursor: result.nextCursor, limit: 1, projectId: PROJECT });
  assert.deepEqual(page2.candidates.map((user) => user.userId), ['user-4']);
  assert.deepEqual((await env.ok('odin_list_project_members', { projectId: PROJECT, search: 'una' })).members.map((member) => member.userId), ['user-1']);
});

test('member updates apply the delta to the current list and send everyone else back unchanged', async (t) => {
  const env = await session(t);
  const result = await env.ok('odin_update_project_members', { input: { remove: [], upsert: [{ role: 'manager', userId: 'user-3' }, { role: 'manager', userId: 'user-2' }] }, projectId: PROJECT });
  assert.deepEqual(env.writes().map(({ body, method, path }) => ({ body, method, path })), [{ method: 'PUT', path: `/api/projects/${PROJECT}/permissions`, body: { validUsers: [
    { id: 'user-1', project_allocation: '0.5', project_bill_rate: '150.00', role: 'admin' },
    { id: 'user-2', project_allocation: null, project_bill_rate: '99.50', role: 'manager' },
    { id: 'user-3', project_allocation: null, project_bill_rate: null, role: 'manager' },
  ] } }]);
  assert.deepEqual(result.changes, { added: [{ role: 'manager', userId: 'user-3' }], removed: [], roleChanged: [{ from: 'user', to: 'manager', userId: 'user-2' }] });
  assert.doesNotMatch(JSON.stringify(result), /bill_rate|allocation/);

  await env.ok('odin_update_project_members', { input: { remove: ['user-2'] }, projectId: PROJECT });
  assert.deepEqual(env.writes().at(-1).body.validUsers.map((entry) => entry.id), ['user-1']);

  const before = env.writes().length;
  assert.equal((await env.ok('odin_update_project_members', { input: { upsert: [{ role: 'admin', userId: 'user-1' }] }, projectId: PROJECT })).changed, false);
  const invalid = await env.fails('odin_update_project_members', { input: { remove: ['user-3'], upsert: [{ role: 'user', userId: 'user-404' }] }, projectId: PROJECT }, 'invalid_member_change');
  assert.deepEqual(invalid.details, { notInWorkspace: ['user-404'], notMembers: ['user-3'] });
  await env.fails('odin_update_project_members', { input: { remove: ['user-2'], upsert: [{ role: 'user', userId: 'user-2' }] }, projectId: PROJECT }, 'invalid_member_change');
  await env.fails('odin_update_project_members', { input: {}, projectId: PROJECT }, 'invalid_member_change');
  await env.fails('odin_update_project_members', { input: { upsert: [{ role: 'owner', userId: 'user-3' }] }, projectId: PROJECT }, 'validation_error');
  const dryRun = await env.ok('odin_update_project_members', { dryRun: true, input: { upsert: [{ role: 'user', userId: 'user-3' }] }, projectId: PROJECT });
  assert.equal(dryRun.authorizationChecked, false);
  assert.equal(env.writes().length, before);

  // The save never changes an unmentioned member: a stored role it rejects, or a member who
  // left the workspace (whom MySQL would drop), must be named in upsert or remove.
  const legacy = await session(t, { [`GET /api/projects/${PROJECT}/valid-users`]: () => {
    const base = membership();
    return {
      ...base,
      project_users: [...base.project_users, { email: 'vi@acme.example', id: 'user-5', name: 'Vi Viewer', role: 'viewer' }, { email: 'gone@acme.example', id: 'user-6', name: 'Gone User', role: 'user' }],
      tenant_users: [...base.tenant_users, { email: 'vi@acme.example', id: 'user-5', name: 'Vi Viewer', role: 'user' }],
    };
  } });
  assert.equal((await legacy.ok('odin_list_project_members', { projectId: PROJECT })).members.find((member) => member.userId === 'user-6').tenantRole, null);
  const refused = await legacy.fails('odin_update_project_members', { input: { upsert: [{ role: 'user', userId: 'user-3' }] }, projectId: PROJECT }, 'members_need_explicit_change');
  assert.deepEqual(refused.details, { outsideWorkspace: [{ role: 'user', userId: 'user-6' }], unsupportedRoles: [{ role: 'viewer', userId: 'user-5' }] });
  await legacy.fails('odin_update_project_members', { input: { upsert: [{ role: 'user', userId: 'user-6' }] }, projectId: PROJECT }, 'invalid_member_change');
  assert.equal(legacy.writes().length, 0);
  const explicit = await legacy.ok('odin_update_project_members', { input: { remove: ['user-6'], upsert: [{ role: 'user', userId: 'user-5' }] }, projectId: PROJECT });
  assert.deepEqual(explicit.changes, { added: [], removed: [{ role: 'user', userId: 'user-6' }], roleChanged: [{ from: 'viewer', to: 'user', userId: 'user-5' }] });
  assert.deepEqual(legacy.writes()[0].body.validUsers.map((entry) => `${entry.id}:${entry.role}`), ['user-1:admin', 'user-2:user', 'user-5:user']);

  const notAdmin = await session(t, { [`PUT /api/projects/${PROJECT}/permissions`]: () => { throw new OdinApiError(404, 'http_404', 'x'); } });
  assert.match((await notAdmin.fails('odin_update_project_members', { input: { upsert: [{ role: 'user', userId: 'user-3' }] }, projectId: PROJECT }, 'http_404')).message, /project admin rights/);
});

test('digest state: scheduled invitations, pending digests, delivery estimates, and a scheduled stakeholder is not invited again', async (t) => {
  const scheduledAt = '2026-10-10T09:00:00.000Z';
  const scheduledState = () => {
    const state = stakeholderState();
    state.invitationDigest = { quietMinutes: 30 };
    // Tia was assigned to topic-2 and waits in her digest.
    state.clarifications[1].assignments.push({ ...assignment('stakeholder', 'stake-2', 'Tia New', 'collaborator', { mailStatus: 'pending', queuedAt: null, scheduledAt }), ...SECRETS });
    return state;
  };
  const env = await session(t, {
    [`GET ${ASSISTANT}/clarifications`]: () => scheduledState(),
    [`GET ${REQ}/tracks/experience/topics`]: () => ({ ok: true, topics: [topicRow('topic-2', [assignment('stakeholder', 'stake-2', 'Tia New', 'collaborator', { mailStatus: 'pending', scheduledAt })])] }),
  });

  const listed = await env.ok('odin_list_clarifications', { projectId: PROJECT, track: 'experience' });
  assert.equal(listed.items[0].alsoInvolve[0].invitationStatus, 'scheduled');

  const stakeholders = await env.ok('odin_list_stakeholders', { projectId: PROJECT });
  assertNoSecrets(stakeholders);
  assert.deepEqual(stakeholders.invitationDigest, { quietMinutes: 30 });
  const tia = stakeholders.items.find((item) => item.id === 'stake-2');
  assert.deepEqual(tia.pendingDigest, { sendsAfter: '2026-10-10T09:30:00.000Z', topics: 1 });
  assert.deepEqual(tia.clarifications[0].invitation, { lastInboundAt: null, queuedAt: null, scheduledAt, sentAt: null, status: 'scheduled' });
  assert.equal(stakeholders.items.find((item) => item.id === 'stake-1').pendingDigest, null, 'a sent invitation is not pending');

  // Tia, already waiting in a digest, is not a new recipient when topic-1 is saved without her; adding her to topic-1 is.
  const preview = await env.ok('odin_preview_clarification_assignment', { alsoInvolve: [{ actorId: 'stake-2', actorType: 'stakeholder' }], clarificationId: 'topic-1', projectId: PROJECT });
  assert.deepEqual(preview.confirmInvitationEmails, ['stake-2']);
  assert.equal(preview.invitationEmails[0].digest.otherWaitingTopics, 1, 'her digest already holds topic-2');
  assert.match(preview.delivery.note, /30 minutes pass without another new assignment/);
  assert.match(preview.delivery.note, /no maximum wait/);

  const link = await env.ok('odin_preview_stakeholder_invitation', { projectId: PROJECT, stakeholderId: 'stake-2' });
  assert.deepEqual(link.pendingDigest, { sendsAfter: '2026-10-10T09:30:00.000Z', topics: 1 });
  assert.ok(link.effects.some((effect) => /still emailed after its quiet period/.test(effect)));
  assert.equal(env.writes().length, 0);

  const { tools } = await env.client.listTools();
  const describe = (name) => tools.find((tool) => tool.name === name).description;
  assert.match(describe('odin_assign_clarification'), /invitation digest/);
  assert.match(describe('odin_send_stakeholder_invitation'), /does not send, cancel or delay a pending clarification digest/);
  assert.match(env.client.getInstructions(), /invitation digest/);
});
