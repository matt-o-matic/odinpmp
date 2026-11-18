import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryMcpOAuthRepository } from '../src/mcp/oauth.repository.js';
import { createInMemoryAssistantRepository } from '../src/modules/assistant/assistant.repository.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryMailRepository } from '../src/modules/mail/mail.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemoryRequirementsRepository } from '../src/modules/requirements/requirements.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';

// Requirements topic administration and decisions over MCP: OAuth MCP clients create, edit,
// move, comment on, dismiss, reopen and delete topics, read their Odin summaries, and record
// decisions through the real Odin routes on an in-process app over loopback HTTP. Odin's own
// checks still decide who may do what: a member's grant administers topics, and only a
// manager's grant (decision rights) dismisses, reopens or decides. Repositories are in memory.

const TENANT_ID = 'tenant-acme';
const PROJECT_ID = 'project-booking';
const PROPOSED_ANSWER = 'Accept cards and bank transfers at checkout.';
const USERS = {
  admin: { id: 'user-admin', name: 'Ada Admin', projectRole: null, tenantRole: 'admin' },
  manager: { id: 'user-manager', name: 'Pia Manager', projectRole: 'manager', tenantRole: 'user' },
  member: { id: 'user-member', name: 'Mona Member', projectRole: 'member', tenantRole: 'user' },
};

/** Summaries that always propose an answer and flag one blocking item, citing the first two sources. */
function proposingSummaryAi() {
  return {
    provider: 'stub',
    async summarize({ modelInput }) {
      const refs = modelInput.citableSourceRefs;
      return {
        model: 'stub-model',
        output: {
          aligned: [{ sources: refs.slice(0, 2), statement: 'Cards are expected.', supporters: [] }],
          divergent: [],
          feedbackThemes: [],
          insufficientInput: false,
          outstanding: [{ blocking: true, item: 'Confirm transfer fees with finance.', sources: refs.slice(0, 1), suggestedOwnerRole: 'Finance lead', waitingOn: [] }],
          proposedAnswer: PROPOSED_ANSWER,
          proposedAnswerSources: refs.slice(0, 1),
          proposedAnswerStatus: 'agreed',
          proposedPreferences: [],
          underExplored: [],
        },
      };
    },
  };
}

async function fixture(t) {
  const users = Object.values(USERS);
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['acme.example'], id: TENANT_ID, name: 'Disposable workspace' }],
    users: users.map((user) => ({ authMethod: 'basic', email: `${user.id}@acme.example`, id: user.id, memberships: [{ role: user.tenantRole, tenantId: TENANT_ID }], name: user.name, password: 'Fixture-password-123!', preferences: { twoFactorEnabled: false } })),
  });
  const projectRepository = createInMemoryProjectsRepository({ authRepository, seed: {
    projectMemberships: { [PROJECT_ID]: users.filter((user) => user.projectRole).map((user) => ({ id: user.id, role: user.projectRole })) },
    projects: [{ epics: [], id: PROJECT_ID, name: PROJECT_ID, status: 'In Progress', tenantId: TENANT_ID }],
  } });
  const assistantRepository = createInMemoryAssistantRepository();
  const requirementsRepository = createInMemoryRequirementsRepository({ assistantRepository });
  const sessionsRepository = createInMemorySessionsRepository();
  const tokenService = createTokenService({ issuer: 'mcp-topics-fixture', secret: 'disposable-topics-fixture-secret' });

  const http = createServer();
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${http.address().port}`;
  const resource = `${origin}/mcp`;
  const app = createApp({
    accessReviewCampaignSweepIntervalMs: 0, agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0, domainEventSweepIntervalMs: 0,
    reportSubscriptionSweepIntervalMs: 0, reportingWarehouseSweepIntervalMs: 0, webhookSweepIntervalMs: 0, workflowAutomationSweepIntervalMs: 0,
    assistantRepository, authRepository, projectRepository, requirementsRepository, sessionsRepository, tokenService,
    backendPublicUrl: origin,
    frontendAppUrl: 'https://frontend-fixture.example/app',
    mailRepository: createInMemoryMailRepository(),
    mcpOAuthRepository: createInMemoryMcpOAuthRepository(),
    mcpPublicUrl: resource,
    requirementsAiService: proposingSummaryAi(),
  });
  http.on('request', app);
  t.after(async () => {
    app.locals.requirementsSummaries?.stop?.();
    await app.locals.beginDrain({ timeoutMs: 1000 });
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  });

  const sessions = {};
  for (const [key, user] of Object.entries(USERS)) {
    const token = tokenService.signSessionToken({ email: `${user.id}@acme.example`, id: user.id, name: user.name, preferences: { twoFactorEnabled: false }, role: user.tenantRole, tenantId: TENANT_ID });
    await sessionsRepository.createSession({ expiryDate: new Date(tokenService.verifySessionToken(token).exp * 1000), ipAddr: '127.0.0.1', locationName: 'Loopback', token, userAgent: 'fixture', userId: user.id });
    sessions[key] = token;
  }

  async function send(path, { body, contentType, headers = {}, method = 'GET', token } = {}) {
    const response = await fetch(`${origin}${path}`, {
      body: body === undefined ? undefined : contentType === 'form' ? new URLSearchParams(body) : JSON.stringify(body),
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': contentType === 'form' ? 'application/x-www-form-urlencoded' : 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      method,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* empty */ }
    return { body: json, status: response.status };
  }

  async function connect(role, scopes = ['projects.read', 'projects.write']) {
    const registered = await send('/api/mcp/clients', { body: { name: 'Disposable agent', projectIds: [], redirectUris: ['http://127.0.0.1:54321/callback'], scopes }, method: 'POST', token: sessions.admin });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    const verifier = 'v'.repeat(64);
    const params = { client_id: registered.body.client_id, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', redirect_uri: registered.body.redirect_uris[0], resource, response_type: 'code', scope: registered.body.scope, state: 'fixture-state' };
    const approved = await send('/api/mcp/oauth/authorize', { body: { ...params, approved: true }, method: 'POST', token: sessions[role] });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const code = new URL(approved.body.redirectTo).searchParams.get('code');
    const tokens = await send('/api/mcp/oauth/token', { body: { client_id: registered.body.client_id, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: params.redirect_uri, resource }, contentType: 'form', method: 'POST' });
    assert.equal(tokens.status, 200, JSON.stringify(tokens.body));
    const client = new Client({ name: `${role}-topics-fixture`, version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(resource), { reconnectionOptions: { maxRetries: 0 }, requestInit: { headers: { Authorization: `Bearer ${tokens.body.access_token}` } } });
    t.after(() => client.close());
    await client.connect(transport, { timeout: 10_000 });
    async function call(name, args) {
      const result = await client.callTool({ arguments: { projectId: PROJECT_ID, ...args }, name }, undefined, { timeout: 30_000 });
      const data = JSON.parse(result.content[0].text);
      assert.deepEqual(result.structuredContent, data);
      return { data, isError: result.isError === true };
    }
    return {
      accessToken: tokens.body.access_token,
      async ok(name, args) {
        const { data, isError } = await call(name, args);
        assert.equal(isError, false, `${name}: ${JSON.stringify(data)}`);
        return data;
      },
      async fails(name, args, code, status) {
        const { data, isError } = await call(name, args);
        assert.equal(isError, true, `${name}: ${JSON.stringify(data)}`);
        assert.equal(data.error.code, code, `${name}: ${JSON.stringify(data)}`);
        if (status) assert.equal(data.error.status, status);
        return data.error;
      },
    };
  }

  /** A REST call made the way the MCP dispatcher makes it: MCP token plus internal proof. */
  async function asMcpDispatcher(accessToken, method, path, body) {
    const proof = tokenService.signMcpInternalProof({ method, path, token: accessToken });
    return send(path, { body, headers: { 'X-Odin-MCP-Internal': proof }, method, token: accessToken });
  }

  return { app, asMcpDispatcher, connect };
}

test('OAuth MCP clients administer Requirements topics and record decisions with Odin\'s own permission checks', { timeout: 120_000 }, async (t) => {
  const env = await fixture(t);
  const member = await env.connect('member');
  const manager = await env.connect('manager');
  const reader = await env.connect('manager', ['projects.read']);
  const reqs = `/api/projects/${PROJECT_ID}/requirements`;
  let topicId;

  await t.test('a member creates, edits and moves a topic between tracks', async () => {
    const preview = await member.ok('odin_create_requirement_topic', { dryRun: true, prompt: 'Which payment methods do clients use?', track: 'experience' });
    assert.deepEqual([preview.dryRun, preview.request.method, preview.request.path], [true, 'POST', `${reqs}/tracks/experience/topics`]);

    const created = await member.ok('odin_create_requirement_topic', {
      prompt: 'Which payment methods do clients use?', rationale: 'Checkout depends on it.', settles: 'Checkout', suggestedOwnerRole: 'Finance lead', track: 'experience',
    });
    topicId = created.clarification.id;
    assert.deepEqual([created.clarification.track, created.clarification.state, created.clarification.owner, created.clarification.settles], ['experience', 'open', null, 'Checkout']);

    const edited = await member.ok('odin_update_requirement_topic', { rationale: 'Checkout and invoicing depend on it.', topicId });
    assert.equal(edited.clarification.rationale, 'Checkout and invoicing depend on it.');
    assert.equal(edited.clarification.prompt, 'Which payment methods do clients use?');
    await member.fails('odin_update_requirement_topic', { topicId }, 'invalid_topic', 400);

    const moved = await member.ok('odin_move_requirement_topic', { topicId, track: 'architecture' });
    assert.deepEqual([moved.moved, moved.from, moved.clarification.track], [true, 'experience', 'architecture']);
    assert.equal((await member.ok('odin_move_requirement_topic', { topicId, track: 'architecture' })).moved, false);
    assert.equal((await member.ok('odin_move_requirement_topic', { topicId, track: 'experience' })).clarification.track, 'experience');
  });

  await t.test('a member comments and replies; stakeholders cannot be tagged; comments and Odin summaries read back', async () => {
    const first = await member.ok('odin_add_requirement_topic_comment', { body: `Most clients pay by card. @[${USERS.manager.name}](user:${USERS.manager.id}) can you confirm?`, topicId });
    assert.ok(first.comment.id);
    const reply = await manager.ok('odin_add_requirement_topic_comment', { body: 'Yes, and some pay by bank transfer.', parentCommentId: first.comment.id, topicId });
    assert.equal(reply.comment.parentCommentId, first.comment.id);
    await member.fails('odin_add_requirement_topic_comment', { body: 'Over to @[Sam](stakeholder:stakeholder-1).', topicId }, 'stakeholder_mention', 400);
    const direct = await env.asMcpDispatcher(member.accessToken, 'POST', `${reqs}/topics/${topicId}/comments`, { body: 'Over to @[Sam](stakeholder:stakeholder-1).' });
    assert.equal(direct.status, 403);
    await member.fails('odin_add_requirement_topic_comment', { body: 'A reply to nothing.', parentCommentId: 'missing-comment', topicId }, 'invalid_parent_comment', 400);

    await env.app.locals.requirementsSummaries.flush();
    const { clarification } = await reader.ok('odin_get_clarification', { clarificationId: topicId });
    assert.equal(clarification.comments.length, 1);
    assert.deepEqual(clarification.comments[0].children.map((comment) => comment.body), ['Yes, and some pay by bank transfer.']);
    assert.equal(clarification.summary.output.proposedAnswer, PROPOSED_ANSWER);
    assert.equal(clarification.proposedAnswer, PROPOSED_ANSWER);

    const history = await reader.ok('odin_list_requirement_topic_summaries', { topicId });
    assert.ok(history.runs.length >= 1);
    assert.equal(history.runs.find((run) => run.current)?.id, clarification.summary.id);
    assert.equal(history.currentSummaryId, clarification.summary.id);
    assert.equal(history.runs[0].output.proposedAnswer, PROPOSED_ANSWER);
  });

  await t.test('dismissing and reopening need decision rights and follow the topic state', async () => {
    await member.fails('odin_dismiss_requirement_topic', { topicId }, 'topic_not_found', 404);
    const dismissed = await manager.ok('odin_dismiss_requirement_topic', { topicId });
    assert.equal(dismissed.clarification.state, 'dismissed');
    await manager.fails('odin_dismiss_requirement_topic', { topicId }, 'topic_state', 409);
    await member.fails('odin_add_requirement_topic_comment', { body: 'One more thought.', topicId }, 'comments_closed', 409);
    const reopened = await manager.ok('odin_reopen_requirement_topic', { topicId });
    assert.notEqual(reopened.clarification.state, 'dismissed');
    await manager.fails('odin_reopen_requirement_topic', { topicId }, 'topic_state', 409);
    // A grant cannot resolve a topic without a decision, or mix a status change with text.
    for (const body of [{ status: 'resolved' }, { prompt: 'Changed', status: 'dismissed' }]) {
      assert.equal((await env.asMcpDispatcher(manager.accessToken, 'PATCH', `${reqs}/topics/${topicId}`, body)).status, 403, JSON.stringify(body));
    }
  });

  await t.test('a manager defers, then records agreed from the Odin proposed answer by superseding the deferral', async () => {
    await member.fails('odin_record_requirement_decision', { outcome: 'decided', statement: 'Cards only.', topicId }, 'topic_not_found', 404);
    await reader.fails('odin_record_requirement_decision', { outcome: 'decided', statement: 'Cards only.', topicId }, 'insufficient_scope', 403);

    const deferred = await manager.ok('odin_record_requirement_decision', { outcome: 'deferred', statement: 'Wait for the finance review.', topicId });
    assert.deepEqual([deferred.decision.outcome, deferred.decision.statement, deferred.statementSource], ['deferred', 'Wait for the finance review.', 'provided']);
    assert.notEqual(deferred.clarification.state, 'decided', 'a deferral keeps the topic open');

    const exists = await manager.fails('odin_record_requirement_decision', { outcome: 'agreed', topicId }, 'decision_exists', 409);
    assert.equal(exists.details.activeDecision.id, deferred.decision.id);

    const agreed = await manager.ok('odin_record_requirement_decision', { outcome: 'agreed', supersedesDecisionId: deferred.decision.id, topicId });
    assert.deepEqual([agreed.decision.outcome, agreed.decision.statement, agreed.statementSource], ['agreed', PROPOSED_ANSWER, 'summary-proposed-answer']);
    assert.equal(agreed.decision.supersedesId, deferred.decision.id);
    assert.ok(agreed.decision.sourceSummaryId);
    assert.ok(agreed.decision.sources.length > 0, 'the summary\'s source refs are attached');
    // A deferral keeps the topic open, so its blocking item still warns; recording the deferral scheduled a summary refresh.
    assert.deepEqual(agreed.warnings, [
      '1 blocking item still open in the Odin summary.',
      'An Odin summary refresh is pending, so the summary may not reflect the newest comments.',
    ]);
    assert.equal(agreed.clarification.state, 'decided');

    assert.ok((await member.ok('odin_add_requirement_topic_comment', { body: 'Noted for the invoice template.', topicId })).comment.id, 'a decided topic stays open for discussion');
    await manager.fails('odin_dismiss_requirement_topic', { topicId }, 'topic_state', 409);
    await manager.fails('odin_record_requirement_decision', { outcome: 'decided', statement: 'Cards only.', supersedesDecisionId: deferred.decision.id, topicId }, 'decision_exists', 409);
    assert.equal((await env.asMcpDispatcher(manager.accessToken, 'POST', `${reqs}/decisions`, { outcome: 'superseded', statement: 'Gone.', topicId })).status, 403);
  });

  await t.test('a topic without a proposed answer needs a statement, and only untouched topics can be deleted', async () => {
    const fresh = (await member.ok('odin_create_requirement_topic', { prompt: 'Do clients need receipts by email?', track: 'architecture' })).clarification;
    await manager.fails('odin_record_requirement_decision', { outcome: 'agreed', topicId: fresh.id }, 'statement_required', 400);
    const deleted = await member.ok('odin_delete_requirement_topic', { topicId: fresh.id });
    assert.deepEqual(deleted.deleted, { id: fresh.id, track: 'architecture' });
    await member.fails('odin_get_clarification', { clarificationId: fresh.id }, 'clarification_not_found', 404);
    await member.fails('odin_delete_requirement_topic', { topicId }, 'topic_has_activity', 409);
    // A new topic from a grant names nobody; people are assigned with confirmed invitations.
    const withPeople = await env.asMcpDispatcher(member.accessToken, 'POST', `${reqs}/tracks/experience/topics`, { assignments: [{ actorId: USERS.manager.id, actorType: 'user' }], prompt: 'Sneaky' });
    assert.equal(withPeople.status, 403);
  });
});
