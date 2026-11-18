import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
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
import { createMermaidValidator } from '../src/modules/requirements/packages/mermaid-validator.js';
import { createInMemoryRequirementsRepository } from '../src/modules/requirements/requirements.repository.js';
import { createRequirementsPublicRateLimiter } from '../src/modules/requirements/requirements-rate-limit.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';
import { createStubSummaryAi, roundPackageFiles } from './helpers/requirements-rounds-app.js';
import { buildExampleZip, buildZip, makePng } from './helpers/review-packages.js';

// AC-14: an MCP client over HTTP with OAuth reads requirements context and round feedback,
// uploads the template package through a single-use URL, and sees a new draft version. It
// cannot close a round, and a member's grant cannot record a decision. Everything runs on disposable in-memory
// repositories behind a loopback listener.

const TENANT_ID = 'tenant-acme';
const PROJECT_ID = 'project-booking';
const OTHER_PROJECT_ID = 'project-other';
const TRACK = 'experience';
const USERS = {
  admin: { id: 'user-admin', name: 'Ada Admin', projectRole: null, tenantRole: 'admin' },
  manager: { id: 'user-manager', name: 'Pia Manager', projectRole: 'manager', tenantRole: 'user' },
  member: { id: 'user-member', name: 'Mona Member', projectRole: 'member', tenantRole: 'user' },
  reviewer: { id: 'user-reviewer', name: 'Ravi Reviewer', projectRole: 'member', tenantRole: 'user' },
  viewer: { id: 'user-viewer', name: 'Vic Viewer', projectRole: 'viewer', tenantRole: 'user' },
};
const BRIEF = {
  constraints: ['Bookings must work on phones without an app install'],
  name: 'Client booking',
  objective: 'Let clients book a visit without calling the office.',
  requirements: ['Clients can book a visit online', 'Clients can reschedule or cancel a visit'],
};
const style = { color: '#c2410c', stroke: 3 };

async function fixture(t) {
  const users = Object.values(USERS);
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['acme.example'], id: TENANT_ID, name: 'Disposable workspace' }],
    users: users.map((user) => ({ authMethod: 'basic', email: `${user.id}@acme.example`, id: user.id, memberships: [{ role: user.tenantRole, tenantId: TENANT_ID }], name: user.name, password: 'Fixture-password-123!', preferences: { twoFactorEnabled: false } })),
  });
  const projectRepository = createInMemoryProjectsRepository({ authRepository, seed: {
    projectMemberships: {
      [OTHER_PROJECT_ID]: [{ id: USERS.member.id, role: 'member' }],
      [PROJECT_ID]: users.filter((user) => user.projectRole).map((user) => ({ id: user.id, role: user.projectRole })),
    },
    projects: [PROJECT_ID, OTHER_PROJECT_ID].map((id) => ({ epics: [], id, name: id, status: 'In Progress', tenantId: TENANT_ID })),
  } });
  const assistantRepository = createInMemoryAssistantRepository();
  const requirementsRepository = createInMemoryRequirementsRepository({ assistantRepository });
  const sessionsRepository = createInMemorySessionsRepository();
  const tokenService = createTokenService({ issuer: 'mcp-requirements-fixture', secret: 'disposable-requirements-fixture-secret' });
  const mermaidValidator = createMermaidValidator();
  const clock = { offsetMs: 0 };
  const generous = () => createRequirementsPublicRateLimiter({ ip: { capacity: 10_000, refillPerSecond: 1_000 }, link: { capacity: 10_000, refillPerSecond: 1_000 } });

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
    mermaidValidator,
    requirementsAiService: createStubSummaryAi(),
    requirementsClock: () => new Date(Date.now() + clock.offsetMs),
    requirementsRateLimiter: generous(),
    requirementsReviewRateLimiter: generous(),
    requirementsUploadRateLimiter: generous(),
    reviewGrantSecret: 'disposable-review-grant-secret-0123456789abcdef',
    reviewPublicUrl: 'http://127.0.0.1:3902',
  });
  http.on('request', app);
  t.after(async () => {
    mermaidValidator.close();
    app.locals.requirementsSummaries?.stop?.();
    await app.locals.beginDrain({ timeoutMs: 1000 });
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
    assert.equal(http.listening, false);
  });

  const sessions = {};
  for (const [key, user] of Object.entries(USERS)) {
    const token = tokenService.signSessionToken({ email: `${user.id}@acme.example`, id: user.id, name: user.name, preferences: { twoFactorEnabled: false }, role: user.tenantRole, tenantId: TENANT_ID });
    await sessionsRepository.createSession({ expiryDate: new Date(tokenService.verifySessionToken(token).exp * 1000), ipAddr: '127.0.0.1', locationName: 'Loopback', token, userAgent: 'fixture', userId: user.id });
    sessions[key] = token;
  }

  async function send(path, { body, contentType, headers = {}, method = 'GET', token } = {}) {
    const raw = Buffer.isBuffer(body);
    const response = await fetch(`${origin}${path}`, {
      body: body === undefined ? undefined : raw ? body : contentType === 'form' ? new URLSearchParams(body) : JSON.stringify(body),
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': raw ? (contentType ?? 'application/zip') : contentType === 'form' ? 'application/x-www-form-urlencoded' : 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      method,
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* binary or empty */ }
    return { body: json, headers: response.headers, status: response.status };
  }
  const requirements = `/api/projects/${PROJECT_ID}/requirements`;
  const as = (role) => ({
    get: (path) => send(`${requirements}${path}`, { token: sessions[role] }),
    post: (path, body = {}) => send(`${requirements}${path}`, { body, method: 'POST', token: sessions[role] }),
    put: (path, body = {}) => send(`${requirements}${path}`, { body, method: 'PUT', token: sessions[role] }),
    raw: (path, bytes, contentType) => send(`${requirements}${path}`, { body: bytes, contentType, method: 'POST', token: sessions[role] }),
  });

  async function register(scopes) {
    const response = await send('/api/mcp/clients', { body: { name: 'Disposable coding agent', projectIds: [], redirectUris: ['http://127.0.0.1:54321/callback'], scopes }, method: 'POST', token: sessions.admin });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body;
  }
  async function grant(client, role) {
    const verifier = 'v'.repeat(64);
    const params = { client_id: client.client_id, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', redirect_uri: client.redirect_uris[0], resource, response_type: 'code', scope: client.scope, state: 'fixture-state' };
    const approved = await send('/api/mcp/oauth/authorize', { body: { ...params, approved: true }, method: 'POST', token: sessions[role] });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const code = new URL(approved.body.redirectTo).searchParams.get('code');
    const exchanged = await send('/api/mcp/oauth/token', { body: { client_id: client.client_id, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: params.redirect_uri, resource }, contentType: 'form', method: 'POST' });
    assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));
    return exchanged.body;
  }
  async function connect(tokens) {
    const client = new Client({ name: 'requirements-agent-fixture', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(resource), { reconnectionOptions: { maxRetries: 0 }, requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } });
    t.after(() => client.close());
    await client.connect(transport, { timeout: 10_000 });
    return {
      accessToken: tokens.access_token,
      client,
      async call(name, args = {}, expectedStatus) {
        const result = await client.callTool({ arguments: args, name }, undefined, { timeout: 60_000 });
        const data = JSON.parse(result.content[0].text);
        assert.deepEqual(result.structuredContent, data);
        if (expectedStatus) {
          assert.equal(result.isError, true, JSON.stringify(data));
          assert.equal(data.error.status, expectedStatus, JSON.stringify(data));
        } else {
          assert.equal(result.isError, undefined, JSON.stringify(data));
        }
        return data;
      },
    };
  }

  /** A REST call made the way the MCP dispatcher makes it: MCP token plus internal proof. */
  async function asMcpDispatcher(accessToken, method, path, body) {
    const proof = tokenService.signMcpInternalProof({ method, path, token: accessToken });
    return send(path, { body, headers: { 'X-Odin-MCP-Internal': proof }, method, token: accessToken });
  }

  return { app, as, asMcpDispatcher, assistantRepository, clock, connect, grant, origin, register, requirementsRepository, send, sessions };
}

/** Brief, topics with discussion, a decision, a preference, a published round with feedback, and an approved plan. */
async function seedProject(env) {
  const now = new Date().toISOString();
  await env.assistantRepository.saveProjectAssistantState({ projectId: PROJECT_ID, tenantId: TENANT_ID, value: { brief: { ...BRIEF, committedAt: now }, updatedAt: now } });
  // The template package's questions cite these topic ids; the upload validates them.
  await env.requirementsRepository.createTopics({ projectId: PROJECT_ID, tenantId: TENANT_ID, topics: [
    { id: 'topic-exp-01', prompt: 'Where should the price first appear?', sourceRef: 'brief:requirements:0', topicOrigin: 'manual', track: TRACK },
    { id: 'topic-exp-03', prompt: 'How much notice do clients need to reschedule?', sourceRef: 'brief:requirements:1', topicOrigin: 'manual', track: TRACK },
  ] });
  assert.equal((await env.as('member').post('/topics/topic-exp-01/comments', { body: 'Show a price range on the home screen.' })).status, 201);
  assert.equal((await env.as('reviewer').post('/topics/topic-exp-01/comments', { body: 'Agreed, a range before the time is picked.' })).status, 201);

  const decision = await env.as('manager').post('/decisions', { outcome: 'agreed', statement: 'Clients can reschedule up to 24 hours before a visit.', topicId: 'topic-exp-03' });
  assert.equal(decision.status, 201, JSON.stringify(decision.body));
  // D-labels follow decision time; keep the two decisions in distinct milliseconds.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const preference = await env.as('manager').post('/preferences/accept', { dimension: 'hierarchy', stance: 'keep', statement: 'Keep the booking button first.', track: TRACK });
  assert.equal(preference.status, 201, JSON.stringify(preference.body));

  const uploaded = await env.as('member').raw(`/packages/upload?track=${TRACK}`, await buildZip(roundPackageFiles({ priceTopicId: 'topic-exp-01' })), 'application/zip');
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
  const published = await env.as('member').post('/rounds', {
    dueAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    packageId: uploaded.body.package.id,
    reviewers: [{ actorId: USERS.reviewer.id, actorType: 'user', required: true }, { actorId: USERS.manager.id, actorType: 'user' }],
  });
  assert.equal(published.status, 201, JSON.stringify(published.body));
  const round = published.body.round;
  const review = (role) => ({
    post: (path, body) => env.as(role).post(`/rounds/${round.id}/review${path}`, body),
    put: (path, body) => env.as(role).put(`/rounds/${round.id}/review${path}`, body),
    raw: (path, bytes) => env.as(role).raw(`/rounds/${round.id}/review${path}`, bytes, 'image/png'),
  });
  const ravi = review('reviewer');
  const pia = review('manager');
  assert.equal((await ravi.put('/screens/home/verdict', { change: 'Make the price smaller.', overall: 'keep-with-changes', stay: 'One booking button.' })).status, 200);
  assert.equal((await ravi.put('/screens/booking/verdict', { overall: 'change' })).status, 200);
  assert.equal((await pia.put('/screens/home/verdict', { overall: 'keep' })).status, 200);
  assert.equal((await ravi.put('/directions/action-first', { remix: 'Keep the price card.', stance: 'preferred' })).status, 200);
  assert.equal((await ravi.put('/questions/price-placement/answer', { value: 'range-on-home' })).status, 200);

  // An open annotation on a prototype snapshot with a four-comment thread, and a resolved one.
  const snapshot = await ravi.raw('/snapshots?screenId=booking&stateKey=start', makePng(1280, 800, [240, 240, 240]));
  assert.equal(snapshot.status, 201, JSON.stringify(snapshot.body));
  const openId = randomUUID();
  const opened = await ravi.put(`/annotations/${openId}`, {
    category: 'hierarchy',
    elementHint: { odinId: 'title', tag: 'h1', text: 'Book a visit' },
    screenId: 'booking',
    shapes: [{ number: 1, schemaVersion: 1, style, type: 'pin', x: 40, y: 40 }, { fontSize: 14, h: 30, schemaVersion: 1, style, text: 'Too loud', type: 'text', w: 120, x: 60, y: 60 }],
    snapshotFileId: snapshot.body.snapshotFileId,
    stateKey: 'start',
  });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  const first = await ravi.post(`/annotations/${openId}/comments`, { body: 'The heading competes with the price.' });
  for (const [role, body] of [['manager', 'Agree, tone it down.'], ['reviewer', 'Maybe 20px instead of 28px.'], ['manager', 'Try 22px in the next version.']]) {
    assert.equal((await review(role).post(`/annotations/${openId}/comments`, { body, parentCommentId: first.body.comment.id })).status, 201);
  }
  const resolvedId = randomUUID();
  assert.equal((await ravi.put(`/annotations/${resolvedId}`, { screenId: 'home', shapes: [{ h: 40, schemaVersion: 1, style, type: 'box', w: 60, x: 10, y: 10 }] })).status, 201);
  assert.equal((await ravi.post(`/annotations/${resolvedId}/status`, { status: 'resolved' })).status, 200);
  assert.equal((await ravi.post('/submit', {})).status, 200);
  await env.app.locals.requirementsSummaries.flush();

  const plans = env.app.locals.plansRepository;
  const draft = await plans.insertPlanVersion({ plan: {
    body: '# Experience plan', content: { nonGoals: [], objective: 'Let clients book online.', scope: [] }, createdBy: `user:${USERS.manager.id}`,
    criteria: [{ decisionIds: [decision.body.decision.id], id: 'E-01', scenario: 'A client reschedules a visit 24 hours ahead without calling.' }], track: TRACK,
  }, projectId: PROJECT_ID, tenantId: TENANT_ID });
  await plans.approvePlan({ approvedBy: `user:${USERS.manager.id}`, approvedByName: USERS.manager.name, expectedRevision: draft.revision, now: new Date(), planId: draft.id, projectId: PROJECT_ID, tenantId: TENANT_ID });
  return { decisionId: decision.body.decision.id, openId, packageId: uploaded.body.package.id, preferenceId: preference.body.decision.id, resolvedId, round, snapshotId: snapshot.body.snapshotFileId };
}

test('AC-14 an OAuth MCP client reads requirements context and feedback, uploads a package draft, and cannot close rounds, or decide without decision rights', { timeout: 180_000 }, async (t) => {
  const env = await fixture(t);
  const seeded = await seedProject(env);
  const reader = await env.connect(await env.grant(await env.register(['projects.read']), 'member'));
  const writeClient = await env.register(['projects.read', 'projects.write']);
  const agent = await env.connect(await env.grant(writeClient, 'member'));

  await t.test('discovery lists the four requirements tools with their OAuth scopes and nothing that closes rounds or approves', async () => {
    const { tools } = await agent.client.listTools({}, { timeout: 10_000 });
    assert.equal(tools.length, 151);
    const scopes = Object.fromEntries(tools.filter((tool) => /requirements_context|round_feedback|package/.test(tool.name)).map((tool) => [tool.name, tool._meta.securitySchemes[0].scopes]));
    assert.deepEqual(scopes, {
      odin_create_package_upload: ['projects.read', 'projects.write'],
      odin_get_package_status: ['projects.read'],
      odin_get_requirements_context: ['projects.read'],
      odin_get_round_feedback: ['projects.read'],
    });
    assert.equal(tools.some((tool) => /approve|accept|preference|close|propose/.test(tool.name)), false);
    assert.deepEqual(tools.find((tool) => tool.name === 'odin_record_requirement_decision')._meta.securitySchemes[0].scopes, ['projects.read', 'projects.write']);
  });

  let context;
  await t.test('projects.read: the context tool returns the brief, topics with summaries, D-labelled decisions, the round digest, packages and the plan', async () => {
    context = await reader.call('odin_get_requirements_context', { projectId: PROJECT_ID, track: TRACK });
    assert.equal(context.schema, 'odin.requirements-context/v1');
    assert.equal(context.truncated, true, 'the four-comment thread is trimmed');
    const size = Buffer.byteLength(JSON.stringify(context));
    t.diagnostic(`context size for this fixture: ${size} bytes`);
    assert.ok(size < 12 * 1024, `${size} bytes`);
    assert.deepEqual(context.brief.items.slice(0, 2).map((line) => [line.ref, line.text, line.topicCount]), [
      ['brief:requirements:0', 'Clients can book a visit online', 1],
      ['brief:requirements:1', 'Clients can reschedule or cancel a visit', 1],
    ]);
    assert.equal(context.brief.total, 4);

    const price = context.topics.items.find((topic) => topic.id === 'topic-exp-01');
    assert.equal(price.state, 'open');
    assert.equal(price.sourceRef, 'brief:requirements:0');
    assert.ok(price.summary, JSON.stringify(price));
    assert.equal(price.summary.insufficientInput, false);
    assert.ok(price.summary.aligned[0].supporters.every((name) => Object.values(USERS).some((user) => user.name === name)), JSON.stringify(price.summary));
    assert.ok(price.summary.aligned[0].sources.length > 0);
    const notice = context.topics.items.find((topic) => topic.id === 'topic-exp-03');
    assert.equal(notice.state, 'decided');
    assert.deepEqual([notice.decision.id, notice.decision.label, notice.decision.outcome], [seeded.decisionId, 'D-01', 'agreed']);
    assert.deepEqual(context.decisions.items.map((decision) => [decision.label, decision.kind, decision.topicId, decision.decidedBy]), [['D-01', 'topic', 'topic-exp-03', USERS.manager.name]]);
    assert.deepEqual(context.preferences.items.map((decision) => [decision.label, decision.dimension, decision.stance, decision.statement]), [['D-02', 'hierarchy', 'keep', 'Keep the booking button first.']]);

    const round = context.latestRound;
    assert.deepEqual([round.id, round.number, round.status, round.packageVersion], [seeded.round.id, 1, 'open', 1]);
    assert.ok(round.dueAt);
    assert.deepEqual(round.progress, { required: 1, requiredSubmitted: 1, reviewers: 2, submitted: 1 });
    assert.deepEqual(round.verdictGrid.screens, ['home', 'booking', 'gone']);
    const grid = Object.fromEntries(round.verdictGrid.items.map((row) => [row.name, row.verdicts]));
    assert.deepEqual(grid, { [USERS.manager.name]: ['keep', null, null], [USERS.reviewer.name]: ['keep-with-changes', 'change', null] });
    assert.deepEqual(round.screens.items.find((screen) => screen.screenId === 'home').verdicts, { change: 0, keep: 1, 'keep-with-changes': 1, undecided: 0 });
    assert.deepEqual(round.directions.items.find((direction) => direction.directionId === 'action-first').remix, [{ name: USERS.reviewer.name, remix: 'Keep the price card.' }]);
    assert.ok(round.screens.items.find((screen) => screen.screenId === 'home').summary?.aligned, 'screen summaries are included');
    assert.ok(round.roundSummary?.aligned, 'the round summary is included');

    assert.equal(round.openAnnotations.total, 1, 'resolved annotations are left out');
    const [annotation] = round.openAnnotations.items;
    assert.deepEqual([annotation.id, annotation.screenId, annotation.status, annotation.stateKey, annotation.category, annotation.author], [seeded.openId, 'booking', 'open', 'start', 'hierarchy', USERS.reviewer.name]);
    assert.equal(annotation.snapshotUrl, `${env.origin}/api/projects/${PROJECT_ID}/requirements/rounds/${seeded.round.id}/snapshots/${seeded.snapshotId}`);
    assert.deepEqual(annotation.marks, ['pin', 'text']);
    assert.deepEqual(annotation.labels, ['Too loud']);
    assert.deepEqual(annotation.element, { odinId: 'title', tag: 'h1', text: 'Book a visit' });
    assert.equal(annotation.threadTotal, 4);
    assert.deepEqual(annotation.thread.map((comment) => [comment.author, comment.body]), [
      [USERS.reviewer.name, 'The heading competes with the price.'],
      [USERS.reviewer.name, 'Maybe 20px instead of 28px.'],
      [USERS.manager.name, 'Try 22px in the next version.'],
    ]);

    assert.deepEqual(context.packages.latest && [context.packages.latest.version, context.packages.latest.status, context.packages.latest.source], [1, 'published', 'ui']);
    assert.equal(context.packages.nextVersion, 2);
    assert.deepEqual(context.plan.criteria.items, [{ decisions: ['D-01'], id: 'E-01', scenario: 'A client reschedules a visit 24 hours ahead without calling.' }]);
    assert.equal(context.plan.owner, USERS.manager.name);
  });

  await t.test('projects.read: round feedback comes back in the package-spec section 8 shape, paged by cursor', async () => {
    const first = await reader.call('odin_get_round_feedback', { limit: 1, projectId: PROJECT_ID, roundId: seeded.round.id });
    assert.equal(first.schema, 'odin.round-feedback/v1');
    assert.deepEqual([first.round.id, first.round.number, first.round.packageVersion, first.round.status], [seeded.round.id, 1, 1, 'open']);
    assert.equal(first.page.annotationsTotal, 2);
    assert.equal(first.annotations.length, 1);
    assert.ok(first.page.nextCursor);
    assert.ok(first.verdicts.some((verdict) => verdict.screenId === 'home' && verdict.overall === 'keep-with-changes' && verdict.change === 'Make the price smaller.'));
    assert.deepEqual(first.answers.map((answer) => [answer.questionId, answer.value]), [['price-placement', 'range-on-home']]);
    const second = await reader.call('odin_get_round_feedback', { cursor: first.page.nextCursor, limit: 1, projectId: PROJECT_ID, roundId: seeded.round.id });
    assert.equal(second.page.nextCursor, null);
    assert.deepEqual(new Set([...first.annotations, ...second.annotations].map((annotation) => annotation.id)), new Set([seeded.openId, seeded.resolvedId]));
    const open = [...first.annotations, ...second.annotations].find((annotation) => annotation.id === seeded.openId);
    assert.equal(open.thread.length, 4, 'the feedback tool returns whole threads');
    assert.equal(open.shapes[0].type, 'pin');
    const missing = await reader.call('odin_get_round_feedback', { projectId: PROJECT_ID, roundId: randomUUID() }, 404);
    assert.equal(missing.error.code, 'round_not_found');
    assert.equal((await reader.call('odin_get_round_feedback', { cursor: 'not-a-cursor', projectId: PROJECT_ID, roundId: seeded.round.id }, 400)).error.code, 'invalid_cursor');
  });

  await t.test('snapshot URLs open for an Odin session but not for the MCP credential', async () => {
    const path = new URL(context.latestRound.openAnnotations.items[0].snapshotUrl).pathname;
    const withSession = await env.send(path, { token: env.sessions.member });
    assert.equal(withSession.status, 200);
    assert.equal(withSession.headers.get('content-type'), 'image/png');
    assert.equal((await env.send(path, { token: reader.accessToken })).status, 401);
    assert.equal((await env.asMcpDispatcher(reader.accessToken, 'GET', path)).status, 403);
  });

  await t.test('projects.read cannot create an upload URL, even as a dry run', async () => {
    for (const args of [{ projectId: PROJECT_ID, track: TRACK }, { dryRun: true, projectId: PROJECT_ID, track: TRACK }]) {
      assert.equal((await reader.call('odin_create_package_upload', args, 403)).error.code, 'insufficient_scope');
    }
  });

  // Builds and imports two packages, which can pass the suite's 10s limit when the machine is busy.
  await t.test('an expired upload URL returns 404, the status tool says to request a new one, and a new URL uploads the template as draft version 2', { timeout: 60_000 }, async () => {
    const zip = await buildExampleZip('fieldwork-round-2');
    const expired = await agent.call('odin_create_package_upload', { projectId: PROJECT_ID, track: TRACK });
    env.clock.offsetMs = 11 * 60 * 1000;
    try {
      const late = await env.send(new URL(expired.url).pathname, { body: zip, method: 'PUT' });
      assert.equal(late.status, 404);
      const status = await agent.call('odin_get_package_status', { projectId: PROJECT_ID, uploadId: expired.uploadId });
      assert.equal(status.state, 'expired');
      assert.match(status.nextStep, /odin_create_package_upload/);
    } finally {
      env.clock.offsetMs = 0;
    }

    const upload = await agent.call('odin_create_package_upload', { projectId: PROJECT_ID, track: TRACK });
    assert.notEqual(upload.uploadId, expired.uploadId);
    assert.equal(new URL(upload.url).origin, env.origin);
    assert.match(upload.url, /\/api\/public\/requirements-uploads\/odin_pkgup_/);
    assert.ok(Date.parse(upload.expiresAt) - Date.now() <= 10 * 60 * 1000);
    assert.equal(upload.upload.method, 'PUT');
    assert.equal(upload.upload.contentType, 'application/zip');
    assert.ok(upload.upload.curl.includes(`"${upload.url}"`));
    assert.ok(upload.upload.curl.includes('Content-Type: application/zip'));
    assert.equal((await agent.call('odin_get_package_status', { projectId: PROJECT_ID, uploadId: upload.uploadId })).state, 'pending');

    const put = await env.send(new URL(upload.url).pathname, { body: zip, method: 'PUT' });
    assert.equal(put.status, 201, JSON.stringify(put.body));
    assert.equal((await env.send(new URL(upload.url).pathname, { body: zip, method: 'PUT' })).status, 404, 'upload URLs work once');

    const status = await agent.call('odin_get_package_status', { projectId: PROJECT_ID, uploadId: upload.uploadId });
    assert.deepEqual([status.state, status.status, status.package.version, status.package.status, status.package.source, status.package.uploader], ['accepted', 'accepted', 2, 'draft', 'mcp', USERS.member.name]);
    assert.equal(status.package.manifest, undefined, 'the manifest stays out of the tool result');
    assert.equal(status.package.changes.baseline.version, 1);
    assert.deepEqual(status.warnings.map((warning) => warning.code), ['stale_base_round']);
    assert.match(status.nextStep, /draft version 2/);

    const after = await reader.call('odin_get_requirements_context', { projectId: PROJECT_ID, track: TRACK });
    assert.deepEqual([after.packages.latest.version, after.packages.latest.status, after.packages.latest.source, after.packages.nextVersion], [2, 'draft', 'mcp', 3]);
    assert.equal(after.latestRound.id, seeded.round.id, 'the draft does not publish a round');
  });

  await t.test('a rejected upload reports per-file errors in the package-spec section 7 shape', async () => {
    const upload = await agent.call('odin_create_package_upload', { projectId: PROJECT_ID, track: TRACK });
    const put = await env.send(new URL(upload.url).pathname, { body: await buildZip({ 'notes.txt': 'No manifest here.' }), method: 'PUT' });
    assert.equal(put.status, 422);
    const status = await agent.call('odin_get_package_status', { projectId: PROJECT_ID, uploadId: upload.uploadId });
    assert.deepEqual([status.state, status.status], ['rejected', 'rejected']);
    assert.ok(status.errors.some((error) => error.code === 'manifest_missing'));
    for (const error of status.errors) assert.deepEqual(Object.keys(error).sort(), ['code', 'file', 'message', 'path']);
    assert.match(status.nextStep, /validate\.mjs/);
    assert.equal((await agent.call('odin_get_package_status', { projectId: PROJECT_ID, uploadId: randomUUID() }, 404)).error.code, 'upload_not_found');
  });

  await t.test('an agent replaces its unpublished draft: version 3 replaces draft version 2, and a stale replacement stores nothing', async () => {
    const before = await reader.call('odin_get_requirements_context', { projectId: PROJECT_ID, track: TRACK });
    const draft = before.packages.latest;
    assert.deepEqual([draft.version, draft.status], [2, 'draft']);

    const upload = await agent.call('odin_create_package_upload', { projectId: PROJECT_ID, replacesPackageId: draft.id, track: TRACK });
    assert.deepEqual(upload.replaces, { packageId: draft.id, version: 2 });
    const put = await env.send(new URL(upload.url).pathname, { body: await buildExampleZip('fieldwork-round-2'), method: 'PUT' });
    assert.equal(put.status, 201, JSON.stringify(put.body));
    const status = await agent.call('odin_get_package_status', { projectId: PROJECT_ID, uploadId: upload.uploadId });
    assert.deepEqual([status.state, status.replacesPackageId, status.package.version, status.package.status], ['accepted', draft.id, 3, 'draft']);
    assert.match(status.nextStep, /now withdrawn/);
    const after = await reader.call('odin_get_requirements_context', { projectId: PROJECT_ID, track: TRACK });
    assert.deepEqual([after.packages.latest.version, after.packages.latest.status, after.packages.nextVersion], [3, 'draft', 4]);
    assert.equal(after.latestRound.id, seeded.round.id, 'replacing a draft publishes nothing');

    // The replaced draft cannot be named again, and a published package never can.
    for (const replacesPackageId of [draft.id, seeded.packageId]) {
      assert.equal((await agent.call('odin_create_package_upload', { projectId: PROJECT_ID, replacesPackageId, track: TRACK }, 409)).error.code, 'package_not_draft');
    }
  });

  await t.test('a viewer\'s write grant reads context but cannot create upload URLs', async () => {
    const viewer = await env.connect(await env.grant(writeClient, 'viewer'));
    assert.equal((await viewer.call('odin_get_requirements_context', { projectId: PROJECT_ID, track: TRACK })).latestRound.id, seeded.round.id);
    assert.equal((await viewer.call('odin_create_package_upload', { projectId: PROJECT_ID, track: TRACK }, 404)).error.code, 'http_404');
  });

  await t.test('MCP credentials cannot close rounds, publish by closing the open one, edit or supersede decisions directly, accept preferences, or approve and propose plans', async () => {
    const rounds = `/api/projects/${PROJECT_ID}/requirements/rounds`;
    const reqs = `/api/projects/${PROJECT_ID}/requirements`;
    const attempts = [
      ['POST', rounds, { closePrevious: { outcome: 'abandoned' }, packageId: seeded.packageId, reviewers: [{ actorId: USERS.reviewer.id, actorType: 'user' }] }],
      ['POST', `${rounds}/${seeded.round.id}/close`, { outcome: 'changes-requested' }],
      ['POST', `${rounds}/${seeded.round.id}/review/submit`, {}],
      ['POST', `${reqs}/decisions`, { outcome: 'superseded', statement: 'Superseded by an agent.', topicId: 'topic-exp-01' }],
      ['PATCH', `${reqs}/decisions/${seeded.decisionId}`, { statement: 'Edited by an agent.', version: 1 }],
      ['POST', `${reqs}/preferences/accept`, { dimension: 'type', stance: 'keep', statement: 'Accepted by an agent.', track: TRACK }],
      ['POST', `${reqs}/plans/${TRACK}/draft`, {}],
      ['POST', `${reqs}/plans/${randomUUID()}/approve`, {}],
      ['POST', `${reqs}/plans/${randomUUID()}/propose-work`, {}],
      ['POST', `${reqs}/packages/upload?track=${TRACK}`, {}],
      ['DELETE', `${reqs}/packages/${seeded.packageId}`, undefined],
      ['POST', `${reqs}/packages/${seeded.packageId}/replace`, {}],
      ['POST', `${reqs}/links`, { stakeholderId: 'stakeholder-1' }],
    ];
    for (const [method, path, body] of attempts) {
      const response = await env.asMcpDispatcher(agent.accessToken, method, path, body);
      assert.equal(response.status, 403, `${method} ${path}: ${JSON.stringify(response.body)}`);
      assert.match(response.body.error, /outside the MCP grant/);
      assert.equal((await env.send(path, { body, method, token: agent.accessToken })).status, 401, `direct REST use of an MCP token: ${method} ${path}`);
    }
    // The same dispatcher path does reach the allowed routes, so the denials above are the allowlist.
    assert.equal((await env.asMcpDispatcher(agent.accessToken, 'POST', `${reqs}/packages/upload-urls`, { track: TRACK })).status, 201);
    assert.equal((await env.asMcpDispatcher(reader.accessToken, 'POST', `${reqs}/packages/upload-urls`, { track: TRACK })).status, 403);
    // Recording a decision is open to MCP, but Odin still requires decision rights, which a member lacks.
    const refused = await agent.call('odin_record_requirement_decision', { outcome: 'decided', projectId: PROJECT_ID, statement: 'Decided by an agent.', topicId: 'topic-exp-01' }, 404);
    assert.equal(refused.error.code, 'topic_not_found');
    assert.match(refused.error.message, /decision rights/);
    // Nothing changed: the round is still open, one active topic decision, one preference.
    const after = await reader.call('odin_get_requirements_context', { projectId: PROJECT_ID, track: TRACK });
    assert.equal(after.latestRound.status, 'open');
    assert.deepEqual(after.decisions.items.map((decision) => decision.id), [seeded.decisionId]);
    assert.deepEqual(after.preferences.items.map((decision) => decision.id), [seeded.preferenceId]);
  });

  await t.test('an agent assigns a stakeholder to the open round, then publishes the next draft with stakeholder reviewers after confirming who is emailed', async () => {
    const contact = await env.send(`/api/assistant/projects/${PROJECT_ID}/stakeholder-contacts`, { body: { email: 'sam@client.example', name: 'Sam Stakeholder', roleTitle: 'Ops lead' }, method: 'POST', token: env.sessions.admin });
    assert.equal(contact.status, 201, JSON.stringify(contact.body));
    const sam = { actorId: contact.body.contact.id, actorType: 'stakeholder' };
    const samRef = `stakeholder:${sam.actorId}`;
    const roundId = seeded.round.id;
    const change = { addReviewers: [{ ...sam, required: true }], projectId: PROJECT_ID, removeReviewers: [{ actorId: USERS.manager.id, actorType: 'user' }], roundId };

    const preview = await agent.call('odin_preview_round_reviewers', change);
    assert.deepEqual(preview.problems, []);
    assert.deepEqual(preview.confirmInvitationEmails, [samRef]);
    assert.deepEqual([preview.invitationEmails[0].name, preview.invitationEmails[0].email], ['Sam Stakeholder', 'sam@client.example']);
    const unconfirmed = await agent.call('odin_update_round_reviewers', change, 409);
    assert.equal(unconfirmed.error.code, 'invitation_confirmation_required');
    assert.deepEqual(unconfirmed.error.details.confirmInvitationEmails, [samRef]);
    const updated = await agent.call('odin_update_round_reviewers', { ...change, confirmInvitationEmails: [samRef] });
    assert.deepEqual(updated.round.reviewers.map((reviewer) => [reviewer.actorType, reviewer.actorId, reviewer.required]).sort(), [['stakeholder', sam.actorId, true], ['user', USERS.reviewer.id, true]]);
    const again = await agent.call('odin_preview_round_reviewers', { addReviewers: [sam], projectId: PROJECT_ID, roundId });
    assert.deepEqual([again.confirmInvitationEmails, again.alreadyReviewing.map((person) => person.actorId)], [[], [sam.actorId]]);
    const stranger = await agent.call('odin_update_round_reviewers', { addReviewers: [{ actorId: 'nobody', actorType: 'stakeholder' }], projectId: PROJECT_ID, roundId }, 400);
    assert.equal(stranger.error.details.problems[0].code, 'unknown_stakeholder');

    const draft = (await reader.call('odin_get_requirements_context', { projectId: PROJECT_ID, track: TRACK })).packages.latest;
    assert.equal(draft.status, 'draft');
    const publish = { packageId: draft.id, projectId: PROJECT_ID, reviewers: [{ ...sam, required: true }, { actorId: USERS.reviewer.id, actorType: 'user' }] };
    const blocked = await agent.call('odin_preview_round_publish', publish);
    assert.deepEqual(blocked.problems.map((problem) => problem.code), ['round_open']);
    assert.equal((await env.as('manager').post(`/rounds/${roundId}/close`, { outcome: 'changes-requested' })).status, 200);

    const ready = await agent.call('odin_preview_round_publish', publish);
    assert.deepEqual(ready.problems, []);
    assert.deepEqual(ready.confirmInvitationEmails, [samRef, `user:${USERS.reviewer.id}`]);
    assert.equal((await agent.call('odin_publish_round', { ...publish, confirmInvitationEmails: [samRef] }, 409)).error.code, 'invitation_confirmation_required');
    const published = await agent.call('odin_publish_round', { ...publish, confirmInvitationEmails: ready.confirmInvitationEmails });
    assert.deepEqual([published.round.number, published.round.status, published.round.package.id], [2, 'open', draft.id]);
    assert.deepEqual(published.round.reviewers.map((reviewer) => reviewer.actorId).sort(), [sam.actorId, USERS.reviewer.id].sort());
    // The stakeholder list shows Sam's reviews in both rounds, the open one first in the round list order.
    const listed = await agent.call('odin_list_stakeholders', { projectId: PROJECT_ID });
    const samReviews = listed.items.find((stakeholder) => stakeholder.id === sam.actorId).reviews;
    assert.deepEqual(samReviews.map((review) => [review.number, review.roundStatus, review.required, review.submittedAt]), [[2, 'open', true, null], [1, 'closed', true, null]]);
    const rounds = await env.as('member').get('/rounds');
    assert.ok(rounds.body.rounds.every((round) => round.reviewers.every((reviewer) => !('removedAt' in reviewer))), 'removed reviewers are left out');
    assert.equal((await reader.call('odin_publish_round', { ...publish, confirmInvitationEmails: ready.confirmInvitationEmails }, 403)).error.code, 'insufficient_scope');
  });
});
