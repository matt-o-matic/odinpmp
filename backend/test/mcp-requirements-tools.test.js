import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OdinApiError } from '../src/mcp/api-client.js';
import { CONTEXT_BUDGETS, CONTEXT_LIMITS, createCompactor } from '../src/mcp/requirements-tools.js';
import { createOdinMcpServer } from '../src/mcp/server.js';

// Requirements MCP tools against a fake Odin REST API: request composition, result shapes,
// truncation, pagination, error mapping and scope gating. The end-to-end flow over HTTP with
// OAuth is in mcp-requirements-e2e.test.js.

const PROJECT = 'project-1';
const BASE = `/api/projects/${PROJECT}/requirements`;
const ROUND = 'round-1';
const MARKER = /…\[\+\d+ chars\]$/;
const REQUIREMENTS_TOOLS = ['odin_create_package_upload', 'odin_get_package_status', 'odin_get_requirements_context', 'odin_get_round_feedback'];

function routes(overrides = {}) {
  return {
    [`GET ${BASE}`]: () => ({ ok: true, tracks: { experience: { stages: { brief: { coveredLines: 1, lines: [{ label: 'Requirement 1', ref: 'brief:requirements:0', section: 'requirements', text: 'Clients book online', topicCount: 1 }] } } } } }),
    [`GET ${BASE}/tracks/experience/topics`]: () => ({ counts: { decided: 1, dismissed: 0, open: 1, ready: 0, total: 2 }, ok: true, topics: [
      { evidence: { comments: 2, contributors: 2 }, id: 'topic-a', owner: { label: 'Jamie' }, prompt: 'Where does the price go?', sourceRef: 'brief:requirements:0', state: 'open', summary: {
        createdAt: '2026-10-07T10:00:00.000Z', id: 'summary-a', insufficientInput: false, proposedAnswer: 'A range on the home screen.',
        output: { aligned: [{ sources: ['comment:c1', 'comment:c2'], statement: 'A range helps.', supporterNames: ['Jamie', 'Ravi'], supporters: ['stakeholder:s1', 'user:u1'] }], divergent: [{ issue: 'Exact or range', positions: [{ actorNames: ['Casey'], actors: ['stakeholder:s2'], sources: ['comment:c3'], summary: 'Exact price.' }] }], insufficientInput: false, outstanding: [{ blocking: true, item: 'Tax display', suggestedOwnerRole: 'Finance' }], proposedAnswer: 'A range on the home screen.', proposedPreferences: [], underExplored: [{ area: 'Discounts', suggestedQuestion: 'Do discounts show?', why: 'Nobody asked.' }] },
      } },
      { decision: { decidedAt: '2026-10-02T00:00:00.000Z', id: 'decision-2', outcome: 'agreed', statement: 'One booking button.' }, evidence: { comments: 1, contributors: 1 }, id: 'topic-b', prompt: 'How many buttons?', state: 'decided', summary: null },
    ], track: 'experience' }),
    [`GET ${BASE}/tracks/experience/decisions`]: () => ({ ok: true, track: 'experience', decisions: [
      { decidedAt: '2026-10-03T00:00:00.000Z', decidedBy: { name: 'Pia' }, id: 'decision-3', kind: 'preference', outcome: 'agreed', preference: { dimension: 'hierarchy', stance: 'keep' }, statement: 'Keep the button first.', status: 'active' },
      { decidedAt: '2026-10-02T00:00:00.000Z', decidedBy: { name: 'Pia' }, id: 'decision-2', kind: 'topic', outcome: 'agreed', statement: 'One booking button.', status: 'active', topic: { id: 'topic-b', prompt: 'How many buttons?' }, topicId: 'topic-b' },
      { decidedAt: '2026-10-01T00:00:00.000Z', decidedBy: { name: 'Pia' }, id: 'decision-1', kind: 'topic', outcome: 'agreed', statement: 'Two buttons.', status: 'superseded', topicId: 'topic-b' },
    ] }),
    [`GET ${BASE}/rounds`]: () => ({ ok: true, rounds: [
      { counts: { required: 1, requiredSubmitted: 1, reviewers: 2, submitted: 1 }, id: 'round-0', number: 1, status: 'closed', track: 'experience' },
      { counts: { required: 1, requiredSubmitted: 1, reviewers: 2, submitted: 1 }, dueAt: '2026-10-14T00:00:00.000Z', id: ROUND, number: 2, packageId: 'package-2', packageVersion: 2, status: 'open', title: 'Booking v2', track: 'experience' },
    ] }),
    [`GET ${BASE}/rounds/${ROUND}/results`]: () => ({ ok: true,
      annotationCounts: { home: { carried: 1, open: 1, outdated: 0, resolved: 1, superseded: 0, total: 3 } },
      directions: [{ directionId: 'action-first', remixNotes: [{ actorRef: 'user:u1', name: 'Ravi', remix: 'Keep the card.' }], stances: [{ actorRef: 'user:u1', name: 'Ravi', stance: 'preferred' }], tallies: { acceptable: 0, preferred: 1, rejected: 0 }, title: 'Action first' }],
      grid: [{ actorRef: 'user:u1', name: 'Ravi', verdicts: { home: { overall: 'change' } } }, { actorRef: 'stakeholder:s1', name: 'Jamie', verdicts: { home: { overall: 'keep' }, booking: { overall: 'undecided' } } }],
      questions: [],
      reviewers: [
        { actorRef: 'user:u1', name: 'Ravi', progress: { done: 2, total: 3 }, required: true, submittedAt: '2026-10-05T00:00:00.000Z' },
        { actorRef: 'stakeholder:s1', name: 'Jamie', progress: { done: 1, total: 3 }, required: false, submittedAt: null },
        { actorRef: 'user:gone', name: 'Removed', removedAt: '2026-10-04T00:00:00.000Z' },
      ],
      round: { counts: { required: 1, requiredSubmitted: 1, reviewers: 2, submitted: 1 }, dueAt: '2026-10-14T00:00:00.000Z', id: ROUND, number: 2, packageId: 'package-2', packageVersion: 2, publishedAt: '2026-10-04T00:00:00.000Z', status: 'open', title: 'Booking v2', track: 'experience' },
      screens: [{ kind: 'image', screenId: 'home', title: 'Home' }, { directionId: 'action-first', kind: 'prototype', screenId: 'booking', title: 'Booking' }],
      summaries: { round: { current: null, status: { refreshPending: true } }, screens: { home: { current: { createdAt: '2026-10-06T00:00:00.000Z', id: 'summary-home', output: { aligned: [{ sources: ['annotation:a1'], statement: 'Price too loud.', supporterNames: ['Ravi'] }], divergent: [], insufficientInput: false, outstanding: [], proposedAnswer: '', underExplored: [] } }, status: {} }, booking: { current: null, status: {} } } },
    }),
    [`GET ${BASE}/rounds/${ROUND}/feedback`]: () => ({ schema: 'odin.round-feedback/v1', page: { annotationsTotal: 3, limit: 500, nextCursor: null }, reviewers: [], annotations: [
      { actorRef: 'user:u1', elementHint: { odinId: 'price', tag: 'p', text: '$40-$60' }, id: 'a1', screenId: 'home', shapes: [{ type: 'pin' }, { text: 'Too loud', type: 'text' }, { type: 'pin' }], snapshotUrl: null, stateKey: null, status: 'open', thread: [
        { actorRef: 'user:u1', body: 'one', createdAt: '1' }, { actorRef: 'stakeholder:s1', body: 'two', createdAt: '2' }, { actorRef: 'user:u1', body: 'three', createdAt: '3' }, { actorRef: 'stakeholder:s1', body: 'four', createdAt: '4' },
      ] },
      { actorRef: 'stakeholder:s1', id: 'a2', screenId: 'home', shapes: [{ type: 'box' }], snapshotUrl: 'https://odin.example/snap', status: 'carried', thread: [] },
      { actorRef: 'stakeholder:s9', id: 'a3', screenId: 'home', shapes: [{ type: 'box' }], status: 'resolved', thread: [] },
    ] }),
    [`GET ${BASE}/packages`]: () => ({ ok: true, packages: [
      { createdAt: '2026-10-01T00:00:00.000Z', id: 'package-1', source: 'ui', status: 'published', title: 'v1', version: 1 },
      { createdAt: '2026-10-03T00:00:00.000Z', id: 'package-3', source: 'mcp', status: 'withdrawn', title: 'v3', uploader: { name: 'Mona' }, version: 3 },
      { createdAt: '2026-10-02T00:00:00.000Z', id: 'package-2', source: 'ui', status: 'published', title: 'v2', version: 2 },
    ] }),
    [`GET ${BASE}/plans`]: () => ({ ok: true, plans: [
      { criteria: [{ decisionIds: ['decision-1'], id: 'E-01', scenario: 'Old.' }], id: 'plan-1', status: 'superseded', track: 'experience', version: 1 },
      { approvedAt: '2026-10-06T00:00:00.000Z', criteria: [{ decisionIds: ['decision-2', 'decision-3'], id: 'E-01', scenario: 'One button books a visit.' }], id: 'plan-2', objective: 'Book online.', owner: { id: 'u2', name: 'Pia' }, staleDecisionIds: [], status: 'approved', title: 'Experience plan v2', track: 'experience', version: 2 },
      { criteria: [], id: 'plan-3', status: 'draft', track: 'experience', version: 3 },
    ] }),
    ...overrides,
  };
}

async function session(t, handlers = routes(), { authorizeTool } = {}) {
  const calls = [];
  const api = {
    async request(method, path, options = {}) {
      calls.push({ method, path, ...options });
      const handler = handlers[`${method} ${path}`];
      if (!handler) throw new OdinApiError(404, 'http_404', 'Odin resource was not found or is not accessible to the current user.');
      return handler(options);
    },
  };
  const server = createOdinMcpServer({ api, ...(authorizeTool ? { authorizeTool } : {}) });
  const client = new Client({ name: 'requirements-tools-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name, args = {}) => {
    const result = await client.callTool({ arguments: args, name }, undefined, { timeout: 5000 });
    const data = JSON.parse(result.content[0].text);
    assert.deepEqual(result.structuredContent, data);
    return { data, isError: result.isError === true };
  };
  return { call, calls, client };
}

test('requirements tools: strict schemas, read and write annotations, and descriptions that state limits and the publish boundary', async (t) => {
  const { client } = await session(t, {});
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  for (const name of REQUIREMENTS_TOOLS) {
    assert.ok(byName[name], name);
    assert.equal(byName[name].inputSchema.additionalProperties, false, name);
  }
  assert.equal(byName.odin_create_package_upload.annotations.readOnlyHint, false);
  assert.equal(byName.odin_create_package_upload.annotations.destructiveHint, true, 'a replacement upload withdraws a draft');
  for (const name of ['odin_get_requirements_context', 'odin_get_round_feedback', 'odin_get_package_status']) assert.equal(byName[name].annotations.readOnlyHint, true, name);
  assert.deepEqual(byName.odin_get_requirements_context.inputSchema.required.sort(), ['projectId', 'track']);
  assert.deepEqual(byName.odin_get_requirements_context.inputSchema.properties.track.enum, ['experience', 'architecture']);
  assert.deepEqual(byName.odin_get_round_feedback.inputSchema.required.sort(), ['projectId', 'roundId']);
  assert.deepEqual(byName.odin_create_package_upload.inputSchema.required.sort(), ['projectId'], 'review is project-wide, so no track is needed');
  assert.deepEqual(byName.odin_get_package_status.inputSchema.required.sort(), ['projectId', 'uploadId']);
  assert.match(byName.odin_get_requirements_context.description, /KB/);
  assert.match(byName.odin_get_requirements_context.description, /…\[\+N chars\]/);
  assert.match(byName.odin_get_round_feedback.description, /odin\.round-feedback\/v1/);
  assert.match(byName.odin_create_package_upload.description, /10 minutes/);
  assert.match(byName.odin_create_package_upload.description, /Content-Type: application\/zip/);
  assert.match(byName.odin_create_package_upload.description, /never publishes/);
  assert.match(byName.odin_create_package_upload.description, /replacesPackageId/);
  assert.deepEqual(Object.keys(byName.odin_create_package_upload.inputSchema.properties).sort(), ['dryRun', 'projectId', 'replacesPackageId', 'track']);
  assert.match(client.getInstructions(), /publish draft packages as rounds and change round reviewers \(members or stakeholders\) after confirming who is emailed; people close rounds in Odin/);
});

test('context composes the track reads, labels decisions D-NN in decision-time order, and digests the latest round', async (t) => {
  const { call, calls } = await session(t);
  const { data, isError } = await call('odin_get_requirements_context', { projectId: PROJECT, track: 'experience' });
  assert.equal(isError, false, JSON.stringify(data));
  assert.deepEqual(calls.map(({ method, path, query }) => [method, path.replace(BASE, ''), query ?? null]), [
    ['GET', '/tracks/experience/topics', { include: 'summaries' }],
    ['GET', '/tracks/experience/decisions', null],
    ['GET', '', null],
    // Review is project-wide: rounds and packages are read for the whole project.
    ['GET', '/rounds', null],
    ['GET', '/packages', null],
    ['GET', '/plans', { track: 'experience' }],
    ['GET', `/rounds/${ROUND}/results`, null],
    ['GET', `/rounds/${ROUND}/feedback`, { limit: CONTEXT_LIMITS.feedbackPage }],
  ]);
  assert.deepEqual([data.ok, data.schema, data.projectId, data.track, data.truncated], [true, 'odin.requirements-context/v1', PROJECT, 'experience', true]);
  assert.deepEqual(data.brief, { coveredLines: 1, items: [{ label: 'Requirement 1', ref: 'brief:requirements:0', text: 'Clients book online', topicCount: 1 }], total: 1 });

  const [open, decided] = data.topics.items;
  assert.deepEqual(open.summary.aligned, [{ sources: ['comment:c1', 'comment:c2'], statement: 'A range helps.', supporters: ['Jamie', 'Ravi'] }]);
  assert.deepEqual(open.summary.divergent, [{ issue: 'Exact or range', positions: [{ actors: ['Casey'], sources: ['comment:c3'], summary: 'Exact price.' }] }]);
  assert.deepEqual(open.summary.outstanding, [{ blocking: true, item: 'Tax display' }]);
  assert.deepEqual(open.summary.underExplored, [{ area: 'Discounts', suggestedQuestion: 'Do discounts show?' }]);
  assert.equal(open.summary.proposedAnswer, 'A range on the home screen.');
  assert.equal(open.owner, 'Jamie');
  assert.deepEqual(decided.decision, { id: 'decision-2', label: 'D-02', outcome: 'agreed', statement: 'One booking button.' });
  assert.equal(data.topics.nextCursor, null);

  // Labels count every decision in the track (superseded ones too), oldest first; lists hold active ones, newest first.
  assert.deepEqual(data.decisions, { items: [{ decidedAt: '2026-10-02T00:00:00.000Z', decidedBy: 'Pia', id: 'decision-2', kind: 'topic', label: 'D-02', outcome: 'agreed', statement: 'One booking button.', topic: 'How many buttons?', topicId: 'topic-b' }], total: 1 });
  assert.deepEqual(data.preferences.items.map((item) => [item.label, item.dimension, item.stance]), [['D-03', 'hierarchy', 'keep']]);

  const round = data.latestRound;
  assert.deepEqual([round.id, round.number, round.status, round.dueAt, round.packageVersion], [ROUND, 2, 'open', '2026-10-14T00:00:00.000Z', 2]);
  assert.deepEqual(round.progress, { required: 1, requiredSubmitted: 1, reviewers: 2, submitted: 1 });
  assert.deepEqual(round.reviewers.items.map((reviewer) => [reviewer.name, reviewer.done, reviewer.of]), [['Ravi', 2, 3], ['Jamie', 1, 3]], 'removed reviewers are left out');
  assert.deepEqual(round.verdictGrid, { items: [{ actorRef: 'user:u1', name: 'Ravi', verdicts: ['change', null] }, { actorRef: 'stakeholder:s1', name: 'Jamie', verdicts: ['keep', 'undecided'] }], screens: ['home', 'booking'], total: 2 });
  assert.deepEqual(round.screens.items[0].verdicts, { change: 1, keep: 1, 'keep-with-changes': 0, undecided: 0 });
  assert.deepEqual(round.screens.items[0].annotations, { carried: 1, open: 1, resolved: 1, total: 3 });
  assert.deepEqual(round.screens.items[0].summary.aligned, [{ statement: 'Price too loud.' }], 'screen summaries carry statements only');
  assert.equal(round.screens.items[1].summary, null);
  assert.deepEqual(round.roundSummary, { pending: true });
  assert.deepEqual(round.directions, { items: [{ acceptable: 0, directionId: 'action-first', preferred: 1, rejected: 0, remix: [{ name: 'Ravi', remix: 'Keep the card.' }], title: 'Action first' }], total: 1 });

  assert.equal(round.openAnnotations.total, 2, 'open and carried annotations count, resolved ones do not');
  const [first, carried] = round.openAnnotations.items;
  assert.deepEqual(first.marks, ['pin', 'text']);
  assert.deepEqual(first.labels, ['Too loud']);
  assert.deepEqual(first.element, { odinId: 'price', tag: 'p', text: '$40-$60' });
  assert.deepEqual(first.thread.map((comment) => [comment.author, comment.body]), [['Ravi', 'one'], ['Ravi', 'three'], ['Jamie', 'four']]);
  assert.equal(first.threadTotal, 4);
  assert.deepEqual([carried.status, carried.author, carried.snapshotUrl, carried.threadTotal], ['carried', 'Jamie', 'https://odin.example/snap', undefined]);
  assert.equal(round.openAnnotations.note, undefined);

  assert.deepEqual(data.packages, { latest: { createdAt: '2026-10-03T00:00:00.000Z', id: 'package-3', source: 'mcp', status: 'withdrawn', title: 'v3', uploader: 'Mona', version: 3 }, nextVersion: 4, total: 3 });
  assert.deepEqual(data.plan, { approvedAt: '2026-10-06T00:00:00.000Z', criteria: { items: [{ decisions: ['D-02', 'D-03'], id: 'E-01', scenario: 'One button books a visit.' }], total: 1 }, id: 'plan-2', objective: 'Book online.', owner: 'Pia', title: 'Experience plan v2', version: 2 });
  assert.ok(data.nextSteps.some((step) => step.includes('validate.mjs') && step.includes('--track experience')));
});

test('context without rounds, packages or plans skips the round reads and starts at version 1', async (t) => {
  const { call, calls } = await session(t, routes({
    [`GET ${BASE}/rounds`]: () => ({ ok: true, rounds: [] }),
    [`GET ${BASE}/packages`]: () => ({ ok: true, packages: [] }),
    [`GET ${BASE}/plans`]: () => ({ ok: true, plans: [] }),
    [`GET ${BASE}/tracks/architecture/topics`]: () => ({ counts: { total: 0 }, ok: true, topics: [] }),
    [`GET ${BASE}/tracks/architecture/decisions`]: () => ({ decisions: [], ok: true }),
  }));
  const { data } = await call('odin_get_requirements_context', { projectId: PROJECT, track: 'architecture' });
  assert.equal(data.latestRound, null);
  assert.deepEqual(data.packages, { latest: null, nextVersion: 1, total: 0 });
  assert.equal(data.plan, null);
  assert.deepEqual(data.brief, { coveredLines: 0, items: [], total: 0 });
  assert.equal(data.truncated, false);
  assert.equal(calls.some((entry) => /results|feedback/.test(entry.path)), false);
  assert.ok(calls.every((entry) => entry.method === 'GET'));
});

function long(length, seed = 'x') {
  return seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
}

/** Every list and string at or past what Odin stores, to bound the context size. */
function worstCaseRoutes(topicCount = 120) {
  const refs = Array.from({ length: 50 }, (_, index) => `comment:${long(36, String(index))}`);
  const names = Array.from({ length: 20 }, (_, index) => `Person ${index} ${long(80)}`);
  const output = {
    aligned: Array.from({ length: 10 }, () => ({ sources: refs, statement: long(2000), supporterNames: names })),
    divergent: Array.from({ length: 10 }, () => ({ issue: long(2000), positions: Array.from({ length: 10 }, () => ({ actorNames: names, sources: refs, summary: long(2000) })) })),
    insufficientInput: false,
    outstanding: Array.from({ length: 10 }, () => ({ blocking: true, item: long(2000) })),
    proposedAnswer: long(5000),
    underExplored: Array.from({ length: 10 }, () => ({ area: long(2000), suggestedQuestion: long(2000) })),
  };
  const screens = Array.from({ length: 80 }, (_, index) => ({ kind: 'image', screenId: `screen-${index}-${long(40)}`, title: long(120) }));
  const decisions = Array.from({ length: 300 }, (_, index) => ({ decidedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(), decidedBy: { name: long(200) }, id: `decision-${index}`, kind: index % 2 ? 'preference' : 'topic', outcome: 'agreed', preference: { dimension: long(80), stance: 'keep' }, statement: long(10_000), status: 'active', topic: { prompt: long(2000) }, topicId: `topic-${index}` }));
  const thread = Array.from({ length: 50 }, () => ({ actorRef: 'user:u1', body: long(10_000), createdAt: '2026-10-01T00:00:00.000Z' }));
  return routes({
    [`GET ${BASE}`]: () => ({ tracks: { experience: { stages: { brief: { coveredLines: 0, lines: Array.from({ length: 140 }, (_, index) => ({ label: long(60), ref: `brief:requirements:${index}`, text: long(5000), topicCount: 9 })) } } } } }),
    [`GET ${BASE}/tracks/experience/topics`]: () => ({ counts: { total: topicCount }, topics: Array.from({ length: topicCount }, (_, index) => ({
      decision: { id: `decision-${index * 2}`, outcome: 'agreed', statement: long(10_000) }, evidence: { comments: 999, contributors: 99 }, id: `topic-${index}`,
      owner: { label: long(255) }, prompt: long(2000), settles: long(400), sourceRef: `brief:requirements:${index}`, state: 'open',
      summary: { createdAt: '2026-10-01T00:00:00.000Z', id: `summary-${index}`, output },
    })) }),
    [`GET ${BASE}/tracks/experience/decisions`]: () => ({ decisions }),
    [`GET ${BASE}/rounds/${ROUND}/results`]: () => ({
      annotationCounts: Object.fromEntries(screens.map((screen) => [screen.screenId, { open: 10, total: 10 }])),
      directions: Array.from({ length: 30 }, (_, index) => ({ directionId: `direction-${index}`, remixNotes: Array.from({ length: 100 }, () => ({ name: long(200), remix: long(2000) })), tallies: { acceptable: 1, preferred: 1, rejected: 1 }, title: long(120) })),
      grid: Array.from({ length: 100 }, (_, index) => ({ actorRef: `user:${index}`, name: long(200), verdicts: Object.fromEntries(screens.map((screen) => [screen.screenId, { overall: 'keep-with-changes' }])) })),
      reviewers: Array.from({ length: 100 }, (_, index) => ({ actorRef: `user:${index}`, name: long(200), progress: { done: 1, total: 99 }, required: true, submittedAt: '2026-10-01T00:00:00.000Z' })),
      round: { counts: {}, id: ROUND, number: 2, status: 'open', title: long(500) },
      screens,
      summaries: { round: { current: { id: 'r', output } }, screens: Object.fromEntries(screens.map((screen) => [screen.screenId, { current: { id: 's', output } }])) },
    }),
    [`GET ${BASE}/rounds/${ROUND}/feedback`]: () => ({ annotations: Array.from({ length: 500 }, (_, index) => ({
      actorRef: 'user:u1', category: long(64), elementHint: { odinId: long(64), tag: long(40), text: long(200) }, id: `annotation-${index}-${long(30)}`, screenId: screens[0].screenId,
      shapes: Array.from({ length: 50 }, () => ({ text: long(2000), type: 'text' })), snapshotUrl: `https://odin.example/${long(200)}`, stateKey: long(512), status: 'open', thread,
    })), page: { annotationsTotal: 900, limit: 500, nextCursor: 'next' } }),
    [`GET ${BASE}/packages`]: () => ({ packages: [{ id: 'package-9', title: long(500), uploader: { name: long(200) }, version: 9 }] }),
    [`GET ${BASE}/plans`]: () => ({ plans: [{ criteria: Array.from({ length: 60 }, (_, index) => ({ decisionIds: decisions.slice(0, 20).map((decision) => decision.id), id: `E-${index}`, scenario: long(1000) })), id: 'plan', objective: long(1000), staleDecisionIds: ['decision-0'], status: 'approved', title: 'Plan', version: 1 }] }),
  });
}

test('context clips long text, cuts lists by count and size with totals, degrades summaries with a detail marker, and stays under 110 KB', async (t) => {
  const { call } = await session(t, worstCaseRoutes());
  const { data } = await call('odin_get_requirements_context', { projectId: PROJECT, track: 'experience' });
  const sizeOf = (value) => Buffer.byteLength(JSON.stringify(value ?? null));
  const bytes = sizeOf(data);
  const sections = { ...Object.fromEntries(['brief', 'topics', 'decisions', 'preferences', 'plan'].map((key) => [key, sizeOf(data[key])])), ...Object.fromEntries(Object.entries(data.latestRound).map(([key, value]) => [`latestRound.${key}`, sizeOf(value)]).filter(([, size]) => size > 1024)) };
  t.diagnostic(`worst case by section (bytes): ${JSON.stringify(sections)}`);
  assert.ok(bytes < 110 * 1024, `default page: ${bytes} bytes`);
  assert.equal(data.truncated, true);

  // Section budgets hold, and every cut list reports its full total.
  const B = CONTEXT_BUDGETS;
  const round = data.latestRound;
  for (const [label, value, budget] of [
    ['brief', data.brief.items, B.brief], ['decisions', data.decisions.items, B.decisions], ['preferences', data.preferences.items, B.preferences],
    ['criteria', data.plan.criteria.items, B.criteria], ['reviewers', round.reviewers.items, B.reviewers], ['grid', round.verdictGrid.items, B.grid],
    ['directions', round.directions.items, B.directions], ['screens', round.screens.items, B.screens], ['annotations', round.openAnnotations.items, B.openAnnotations],
  ]) assert.ok(sizeOf(value) <= budget, `${label}: ${sizeOf(value)} > ${budget}`);
  for (const topic of data.topics.items) assert.ok(sizeOf(topic) <= B.topic, `topic ${topic.id}: ${sizeOf(topic)}`);
  for (const screen of round.screens.items) assert.ok(sizeOf(screen) <= B.screen, `screen ${screen.screenId}: ${sizeOf(screen)}`);
  assert.ok(sizeOf(round.roundSummary) <= B.roundSummary);
  for (const [list, total] of [[data.brief, 140], [data.decisions, 150], [data.preferences, 150], [data.plan.criteria, 60], [round.reviewers, 100], [round.verdictGrid, 100], [round.directions, 30], [round.screens, 80]]) {
    assert.equal(list.total, total);
    assert.ok(list.items.length >= 1 && list.items.length < total);
  }
  assert.deepEqual([data.topics.total, data.topics.items.length], [120, CONTEXT_LIMITS.topicsDefault]);
  assert.ok(data.topics.nextCursor);
  assert.equal(round.verdictGrid.screens.length, CONTEXT_LIMITS.screens);
  assert.equal(data.decisions.items[0].label, 'D-299', 'newest first');
  assert.deepEqual(data.plan.staleDecisions, ['D-01']);

  // Clipped text carries its marker; summaries this large drop to counts only and say so.
  assert.match(data.brief.items[0].text, MARKER);
  assert.equal(data.brief.items[0].text.length, CONTEXT_LIMITS.briefText + `…[+${5000 - CONTEXT_LIMITS.briefText} chars]`.length);
  const topic = data.topics.items[0];
  assert.match(topic.prompt, MARKER);
  assert.match(topic.decision.statement, MARKER);
  t.diagnostic(`summary forms: topic ${topic.summary.detail}, round ${round.roundSummary.detail}, first screen ${round.screens.items[0].summary.detail}`);
  assert.equal(topic.summary.detail, 'counts-only', 'next to a long prompt and decision, the topic keeps counts only');
  assert.deepEqual(topic.summary.counts, { aligned: 10, divergent: 10, outstanding: 10, underExplored: 10 });
  assert.match(topic.summary.proposedAnswer, MARKER);
  assert.equal(round.roundSummary.detail, 'statements-only');
  assert.deepEqual(round.roundSummary.omitted, { aligned: 8, divergent: 8, outstanding: 8, underExplored: 8 });
  const screenSummary = round.screens.items[0].summary;
  assert.equal(screenSummary.detail, 'counts-only', 'a screen summary this large keeps counts only');
  assert.deepEqual(screenSummary.counts, { aligned: 10, divergent: 10, outstanding: 10, underExplored: 10 });

  assert.equal(round.openAnnotations.total, 800);
  assert.ok(round.openAnnotations.items.length <= CONTEXT_LIMITS.openAnnotations);
  assert.equal(round.openAnnotations.note, undefined, 'the first page already held enough open annotations');
  assert.equal(round.feedback.annotationsTotal, 900);
  const annotation = round.openAnnotations.items[0];
  assert.equal(annotation.thread.length, CONTEXT_LIMITS.threadComments);
  assert.equal(annotation.threadTotal, 50);
  assert.match(annotation.thread[0].body, MARKER);
  assert.deepEqual([annotation.labels.length, annotation.labels.at(-1)], [4, '+47 more']);
  assert.match(annotation.element.text, MARKER);
  assert.equal(round.directions.items[0].remix.length, CONTEXT_LIMITS.remixNotes);

  const widest = await call('odin_get_requirements_context', { projectId: PROJECT, topicLimit: CONTEXT_LIMITS.topicsMax, track: 'experience' });
  const widestBytes = sizeOf(widest.data);
  const perTopic = (widestBytes - bytes) / (CONTEXT_LIMITS.topicsMax - CONTEXT_LIMITS.topicsDefault);
  assert.ok(perTopic <= B.topic, `per topic: ${perTopic} bytes`);
  t.diagnostic(`worst case: ${bytes} bytes at the default page, ${widestBytes} bytes at topicLimit ${CONTEXT_LIMITS.topicsMax}, about ${Math.round(perTopic)} bytes per topic`);
});

test('summaries keep names and source refs when they fit, mark cut lists, and fall back to statements only', async (t) => {
  const names = Array.from({ length: 20 }, (_, index) => `Reviewer ${index}`);
  const refs = Array.from({ length: 50 }, (_, index) => `comment:c${index}`);
  const wide = { aligned: Array.from({ length: 5 }, (_, index) => ({ sources: refs, statement: `Point ${index}`, supporterNames: names })), divergent: [], insufficientInput: false, outstanding: [], proposedAnswer: 'Yes.', underExplored: [] };
  const verbose = { ...wide, aligned: Array.from({ length: 8 }, () => ({ sources: refs, statement: long(600), supporterNames: names })), divergent: Array.from({ length: 8 }, () => ({ issue: long(600), positions: Array.from({ length: 6 }, () => ({ actorNames: names, sources: refs, summary: long(600) })) })) };
  const topicsRoute = () => ({ counts: {}, topics: [
    { evidence: {}, id: 'wide', prompt: 'Wide', state: 'open', summary: { createdAt: 'c', id: 's1', output: wide } },
    { evidence: {}, id: 'verbose', prompt: 'Verbose', state: 'open', summary: { createdAt: 'c', id: 's2', output: verbose } },
  ] });
  const { call } = await session(t, routes({ [`GET ${BASE}/tracks/experience/topics`]: topicsRoute }));
  const { data } = await call('odin_get_requirements_context', { projectId: PROJECT, track: 'experience' });
  const [full, lean] = data.topics.items;
  assert.equal(full.summary.detail, undefined, 'the full form fits');
  assert.equal(full.summary.aligned.length, 3);
  assert.deepEqual(full.summary.omitted, { aligned: 2 });
  assert.deepEqual(full.summary.aligned[0].supporters, ['Reviewer 0', 'Reviewer 1', 'Reviewer 2', `+${20 - CONTEXT_LIMITS.people} more`]);
  assert.deepEqual(full.summary.aligned[0].sources, ['comment:c0', 'comment:c1', 'comment:c2', `+${50 - CONTEXT_LIMITS.refs} more`]);
  assert.equal(lean.summary.detail, 'statements-only');
  assert.equal(lean.summary.aligned[0].supporters, undefined);
  assert.equal(lean.summary.aligned[0].sources, undefined);
  assert.match(lean.summary.aligned[0].statement, MARKER);
  assert.deepEqual(lean.summary.omitted, { aligned: 6, divergent: 6 });
  assert.equal(data.truncated, true);
});

test('the compactor never splits a surrogate pair and leaves short text alone', () => {
  const c = createCompactor();
  assert.equal(c.clip('short', 10), 'short');
  assert.equal(c.truncated, false);
  const clipped = c.clip(`ab${'😀'.repeat(5)}`, 3);
  assert.equal(clipped, 'ab…[+10 chars]');
  assert.equal(c.truncated, true);
  assert.deepEqual(c.ends([1, 2, 3, 4, 5], 3), [1, 4, 5]);
});

test('the round digest reads feedback a page at a time, stops when it has enough, and degrades with a note instead of failing', async (t) => {
  let annotations = [];
  let failFrom = null;
  const feedback = ({ query }) => {
    const offset = query.cursor ? Number(query.cursor) : 0;
    if (failFrom !== null && offset >= failFrom) throw new OdinApiError(413, 'response_too_large', 'Odin response is too large. Narrow the query.');
    const next = offset + query.limit;
    return { annotations: annotations.slice(offset, next), page: { annotationsTotal: annotations.length, limit: query.limit, nextCursor: next < annotations.length ? String(next) : null } };
  };
  const make = (count, openFrom) => Array.from({ length: count }, (_, index) => ({ actorRef: 'user:u1', id: `a${index}`, screenId: 'home', shapes: [], status: index >= openFrom ? 'open' : 'resolved', thread: [] }));
  const { call, calls } = await session(t, routes({ [`GET ${BASE}/rounds/${ROUND}/feedback`]: feedback }));
  const feedbackQueries = () => calls.filter((entry) => entry.path.endsWith('/feedback')).splice(0).map((entry) => entry.query);
  const digest = async () => (await call('odin_get_requirements_context', { projectId: PROJECT, track: 'experience' })).data.latestRound;

  // Open annotations past the scan limit: five pages, then a note.
  annotations = make(600, 550);
  let round = await digest();
  assert.deepEqual(feedbackQueries(), [{ limit: 100 }, { cursor: '100', limit: 100 }, { cursor: '200', limit: 100 }, { cursor: '300', limit: 100 }, { cursor: '400', limit: 100 }]);
  assert.equal(round.openAnnotations.items.length, 0);
  assert.match(round.openAnnotations.note, /first 500 annotations were scanned.*odin_get_round_feedback/);
  assert.equal(round.feedback.annotationsTotal, 600);

  // Enough open annotations on the second page: the scan stops there.
  calls.length = 0;
  annotations = make(600, 150);
  round = await digest();
  assert.equal(feedbackQueries().length, 2);
  assert.deepEqual(round.openAnnotations.items.map((annotation) => annotation.id).slice(0, 2), ['a150', 'a151']);
  assert.equal(round.openAnnotations.note, undefined);

  // A page over the API size limit keeps what was read and says why the rest is missing.
  calls.length = 0;
  annotations = make(300, 95);
  failFrom = 100;
  round = await digest();
  assert.deepEqual(round.openAnnotations.items.map((annotation) => annotation.id), ['a95', 'a96', 'a97', 'a98', 'a99']);
  assert.match(round.openAnnotations.note, /too large.*smaller limit/);

  // Topic summaries over the API size limit: the topics come back without them, with a note.
  const plainTopics = routes()[`GET ${BASE}/tracks/experience/topics`];
  const { call: callTopics } = await session(t, routes({ [`GET ${BASE}/tracks/experience/topics`]: ({ query } = {}) => {
    if (query?.include) throw new OdinApiError(413, 'response_too_large', 'Odin response is too large. Narrow the query.');
    const listed = plainTopics();
    return { ...listed, topics: listed.topics.map(({ summary, ...row }) => ({ ...row, summary: summary && { createdAt: summary.createdAt, id: summary.id, insufficientInput: false, proposedAnswer: summary.proposedAnswer } })) };
  } }));
  const fallback = (await callTopics('odin_get_requirements_context', { projectId: PROJECT, track: 'experience' })).data;
  assert.match(fallback.topics.note, /too large/);
  assert.deepEqual(fallback.topics.items[0].summary, { createdAt: '2026-10-07T10:00:00.000Z', id: 'summary-a', insufficientInput: false, proposedAnswer: 'A range on the home screen.' });
  assert.equal(fallback.truncated, true);
});

test('topic pages continue by cursor with only the topics section, and reject changed or malformed cursors', async (t) => {
  let extra = [];
  const base = routes();
  const listTopics = () => { const listed = base[`GET ${BASE}/tracks/experience/topics`](); return { ...listed, topics: [...listed.topics, ...extra] }; };
  const handlers = {
    ...base,
    [`GET ${BASE}/tracks/experience/topics`]: listTopics,
    [`GET ${BASE}/tracks/architecture/topics`]: listTopics,
    [`GET ${BASE}/tracks/architecture/decisions`]: base[`GET ${BASE}/tracks/experience/decisions`],
  };
  const { call, calls } = await session(t, handlers);
  const first = (await call('odin_get_requirements_context', { projectId: PROJECT, topicLimit: 1, track: 'experience' })).data;
  assert.deepEqual([first.topics.total, first.topics.items.map((topic) => topic.id)], [2, ['topic-a']]);
  const before = calls.length;
  const next = (await call('odin_get_requirements_context', { projectId: PROJECT, topicCursor: first.topics.nextCursor, topicLimit: 1, track: 'experience' })).data;
  assert.deepEqual(Object.keys(next).sort(), ['ok', 'projectId', 'schema', 'topics', 'track', 'truncated']);
  assert.deepEqual(next.topics.items.map((topic) => topic.id), ['topic-b']);
  assert.equal(next.topics.items[0].decision.label, 'D-02');
  assert.equal(next.topics.nextCursor, null);
  assert.deepEqual(calls.slice(before).map((entry) => entry.path.replace(BASE, '')), ['/tracks/experience/topics', '/tracks/experience/decisions']);

  // The same topics under another track still invalidate the cursor: it is bound to its scope.
  const otherTrack = await call('odin_get_requirements_context', { projectId: PROJECT, topicCursor: first.topics.nextCursor, topicLimit: 1, track: 'architecture' });
  assert.deepEqual([otherTrack.isError, otherTrack.data.error.code], [true, 'stale_cursor']);
  extra = [{ evidence: {}, id: 'topic-c', prompt: 'New', state: 'open' }];
  const stale = await call('odin_get_requirements_context', { projectId: PROJECT, topicCursor: first.topics.nextCursor, topicLimit: 1, track: 'experience' });
  assert.deepEqual([stale.isError, stale.data.error.code], [true, 'stale_cursor']);
  const malformed = await call('odin_get_requirements_context', { projectId: PROJECT, topicCursor: 'not-a-cursor', track: 'experience' });
  assert.deepEqual([malformed.isError, malformed.data.error.code], [true, 'invalid_cursor']);
});

test('round feedback forwards limit and cursor, returns the section 8 shape, and maps errors', async (t) => {
  const feedback = { schema: 'odin.round-feedback/v1', round: { id: ROUND, number: 2 }, reviewers: [], directions: [], verdicts: [], annotations: [], answers: [], summaries: { screens: {} }, page: { annotationsTotal: 0, limit: 50, nextCursor: null } };
  let failure = null;
  const { call, calls } = await session(t, { [`GET ${BASE}/rounds/${ROUND}/feedback`]: () => { if (failure) throw failure; return feedback; } });
  const result = await call('odin_get_round_feedback', { projectId: PROJECT, roundId: ROUND });
  assert.deepEqual(result.data, { ok: true, ...feedback });
  assert.deepEqual(calls[0], { method: 'GET', path: `${BASE}/rounds/${ROUND}/feedback`, query: { cursor: undefined, limit: 50 } });
  await call('odin_get_round_feedback', { cursor: 'bzoyMDA', limit: 200, projectId: PROJECT, roundId: ROUND });
  assert.deepEqual(calls[1].query, { cursor: 'bzoyMDA', limit: 200 });

  failure = new OdinApiError(400, 'http_400', 'Odin rejected the request.');
  assert.equal((await call('odin_get_round_feedback', { cursor: 'bzoyMDA', projectId: PROJECT, roundId: ROUND })).data.error.code, 'invalid_cursor');
  failure = new OdinApiError(404, 'http_404', 'Not found.');
  const missing = (await call('odin_get_round_feedback', { projectId: PROJECT, roundId: ROUND })).data.error;
  assert.deepEqual([missing.code, missing.status], ['round_not_found', 404]);
  assert.match(missing.message, /latestRound\.id/);
  failure = new OdinApiError(413, 'response_too_large', 'Odin response is too large. Narrow the query.');
  const tooLarge = (await call('odin_get_round_feedback', { limit: 200, projectId: PROJECT, roundId: ROUND })).data.error;
  assert.deepEqual([tooLarge.code, tooLarge.status], ['response_too_large', 413]);
  assert.match(tooLarge.message, /smaller limit/);
  failure = new OdinApiError(403, 'http_403', 'Odin denied this operation for the current user.');
  assert.equal((await call('odin_get_round_feedback', { projectId: PROJECT, roundId: ROUND })).data.error.code, 'http_403');

  const count = calls.length;
  for (const args of [{ limit: 201 }, { limit: 0 }, { cursor: 'has spaces' }, { cursor: 'x'.repeat(41) }, { roundId: '../rounds' }, { extra: true }]) {
    const invalid = await call('odin_get_round_feedback', { projectId: PROJECT, roundId: ROUND, ...args });
    assert.deepEqual([invalid.isError, invalid.data.error.code], [true, 'validation_error'], JSON.stringify(args));
  }
  assert.equal(calls.length, count, 'invalid input never reaches Odin');
});

test('create package upload posts the track, returns the URL with PUT instructions, previews without calls, and explains 404', async (t) => {
  const created = { expiresAt: '2026-10-07T10:10:00.000Z', ok: true, track: 'architecture', uploadId: 'upload-1', url: 'https://odin.example/api/public/requirements-uploads/odin_pkgup_secret' };
  let failure = null;
  const { call, calls } = await session(t, { [`POST ${BASE}/packages/upload-urls`]: () => { if (failure) throw failure; return created; } });
  const { data } = await call('odin_create_package_upload', { projectId: PROJECT, track: 'architecture' });
  assert.deepEqual(calls, [{ body: {}, method: 'POST', path: `${BASE}/packages/upload-urls` }], 'a track is accepted and ignored');
  assert.deepEqual([data.ok, data.uploadId, data.url, data.expiresAt, data.track], [true, 'upload-1', created.url, created.expiresAt, 'architecture']);
  assert.deepEqual([data.upload.method, data.upload.contentType, data.upload.singleUse, data.upload.expiresInMinutes], ['PUT', 'application/zip', true, 10]);
  assert.equal(data.upload.curl, `curl --fail-with-body -X PUT -H "Content-Type: application/zip" --data-binary @package.zip "${created.url}"`);
  assert.match(data.upload.responses[404], /odin_create_package_upload/);
  assert.ok(data.nextSteps.some((step) => step.includes('odin_get_package_status')));
  assert.ok(data.nextSteps.some((step) => step.includes('--track experience')));
  assert.ok(data.nextSteps.some((step) => /odin_publish_round/.test(step)));

  const preview = (await call('odin_create_package_upload', { dryRun: true, projectId: PROJECT, track: 'experience' })).data;
  assert.deepEqual(preview, { authorizationChecked: false, dryRun: true, ok: true, request: { body: {}, method: 'POST', path: `${BASE}/packages/upload-urls` }, validation: 'schema_only' });
  assert.equal(calls.length, 1, 'a dry run makes no API call');
  for (const args of [{ track: 'design' }, { track: 'experience', url: 'https://evil.example' }, { projectId: '../x', track: 'experience' }]) {
    assert.equal((await call('odin_create_package_upload', { projectId: PROJECT, ...args })).data.error.code, 'validation_error');
  }

  failure = new OdinApiError(404, 'http_404', 'Odin resource was not found or is not accessible to the current user.');
  const denied = (await call('odin_create_package_upload', { projectId: PROJECT, track: 'experience' })).data.error;
  assert.deepEqual([denied.status, denied.code], [404, 'http_404']);
  assert.match(denied.message, /member access/);
  failure = new OdinApiError(null, 'timeout', 'Odin request timed out.', { outcomeUnknown: true });
  assert.equal((await call('odin_create_package_upload', { projectId: PROJECT, track: 'experience' })).data.error.outcomeUnknown, true);
});

test('create package upload can name a draft to replace, and explains a stale or mismatched draft', async (t) => {
  const created = {
    expiresAt: '2026-10-07T10:10:00.000Z', ok: true, replaces: { packageId: 'pkg-draft', version: 4 }, track: 'experience',
    uploadId: 'upload-2', url: 'https://odin.example/api/public/requirements-uploads/odin_pkgup_secret',
  };
  let failure = null;
  const { call, calls } = await session(t, { [`POST ${BASE}/packages/upload-urls`]: () => { if (failure) throw failure; return created; } });
  const { data } = await call('odin_create_package_upload', { projectId: PROJECT, replacesPackageId: 'pkg-draft', track: 'experience' });
  assert.deepEqual(calls, [{ body: { replacesPackageId: 'pkg-draft' }, method: 'POST', path: `${BASE}/packages/upload-urls` }]);
  assert.deepEqual(data.replaces, { packageId: 'pkg-draft', version: 4 });
  assert.match(data.upload.responses[201], /draft version 4 is withdrawn/);
  assert.match(data.upload.responses[409], /Draft version 4 was published, withdrawn, or replaced first/);

  const preview = (await call('odin_create_package_upload', { dryRun: true, projectId: PROJECT, replacesPackageId: 'pkg-draft', track: 'experience' })).data;
  assert.deepEqual(preview.request.body, { replacesPackageId: 'pkg-draft' });
  assert.equal(calls.length, 1, 'a dry run makes no API call');
  assert.equal((await call('odin_create_package_upload', { projectId: PROJECT, replacesPackageId: '../x', track: 'experience' })).data.error.code, 'validation_error');

  failure = new OdinApiError(409, 'http_409', 'Odin rejected the request because the resource changed.');
  const stale = (await call('odin_create_package_upload', { projectId: PROJECT, replacesPackageId: 'pkg-draft', track: 'experience' })).data.error;
  assert.deepEqual([stale.status, stale.code], [409, 'package_not_draft']);
  assert.match(stale.message, /odin_get_requirements_context/);
  failure = new OdinApiError(400, 'http_400', 'Odin rejected the request.');
  const mismatch = (await call('odin_create_package_upload', { projectId: PROJECT, replacesPackageId: 'pkg-draft', track: 'architecture' })).data.error;
  assert.deepEqual([mismatch.status, mismatch.code], [400, 'package_track_mismatch']);
});

test('package status names the replaced draft, and a stale replacement says to re-read the packages', async (t) => {
  const statuses = {
    accepted: { expiresAt: 'e', ok: true, package: { changes: null, createdAt: 'c', fileCount: 5, id: 'p5', sizeBytes: 900, source: 'mcp', status: 'draft', title: 'v5', track: 'experience', uploader: { name: 'Mona' }, version: 5 }, replacesPackageId: 'p4', state: 'accepted', track: 'experience', uploadId: 'up-a', warnings: [] },
    rejected: { errors: [{ code: 'package_not_draft', file: '', message: 'Version 4 is no longer a draft.', path: '' }], expiresAt: 'e', ok: true, replacesPackageId: 'p4', state: 'rejected', track: 'experience', uploadId: 'up-r', warnings: [] },
  };
  const handlers = Object.fromEntries(Object.values(statuses).map((status) => [`GET ${BASE}/packages/uploads/${status.uploadId}`, () => status]));
  const { call } = await session(t, handlers);

  const accepted = (await call('odin_get_package_status', { projectId: PROJECT, uploadId: 'up-a' })).data;
  assert.equal(accepted.replacesPackageId, 'p4');
  assert.match(accepted.nextStep, /draft version 5 of the project's review package, replacing the draft it named, which is now withdrawn/);
  const rejected = (await call('odin_get_package_status', { projectId: PROJECT, uploadId: 'up-r' })).data;
  assert.deepEqual([rejected.state, rejected.replacesPackageId, rejected.errors[0].code], ['rejected', 'p4', 'package_not_draft']);
  assert.match(rejected.nextStep, /odin_get_requirements_context/);
});

test('package status reports accepted, rejected, expired and pending uploads with next steps, and explains unknown ids', async (t) => {
  const manifest = { sections: Array.from({ length: 7 }, () => ({ body: 'x'.repeat(4000) })) };
  const statuses = {
    accepted: { expiresAt: 'e', ok: true, package: { changes: { baseline: { packageId: 'p1', roundId: 'r1', roundNumber: 1, title: 'v1', version: 1 }, counts: { changed: 1, new: 0, removed: 1, unchanged: 1 }, screens: [{ change: 'changed', screenId: 'home', title: 'Home' }, { change: 'removed', screenId: 'gone', title: 'Gone' }] }, createdAt: 'c', fileCount: 6, id: 'p2', manifest, screens: [{ contentHash: 'h' }], sizeBytes: 900, source: 'mcp', status: 'draft', title: 'v2', track: 'experience', uploader: { name: 'Mona' }, version: 2, warnings: [] }, state: 'accepted', track: 'experience', uploadId: 'up-a', warnings: [{ code: 'stale_base_round', file: 'manifest.json', message: 'Old round.', path: '/basedOnRoundId' }] },
    expired: { expiresAt: 'e', ok: true, state: 'expired', track: 'experience', uploadId: 'up-e' },
    pending: { expiresAt: 'e', ok: true, state: 'pending', track: 'experience', uploadId: 'up-p' },
    rejected: { errors: Array.from({ length: 130 }, (_, index) => ({ code: 'path_invalid', file: `f${index}`, message: 'Bad path.', path: '' })), expiresAt: 'e', ok: true, state: 'rejected', track: 'architecture', uploadId: 'up-r', warnings: [] },
  };
  const handlers = Object.fromEntries(Object.values(statuses).map((status) => [`GET ${BASE}/packages/uploads/${status.uploadId}`, () => status]));
  const { call } = await session(t, handlers);

  const accepted = (await call('odin_get_package_status', { projectId: PROJECT, uploadId: 'up-a' })).data;
  assert.deepEqual([accepted.state, accepted.status, accepted.package.version, accepted.package.uploader, accepted.package.manifest, accepted.package.screens], ['accepted', 'accepted', 2, 'Mona', undefined, undefined]);
  assert.deepEqual(accepted.package.changes, { baseline: { roundNumber: 1, version: 1 }, counts: { changed: 1, new: 0, removed: 1, unchanged: 1 }, screens: [{ change: 'changed', screenId: 'home', title: 'Home' }, { change: 'removed', screenId: 'gone', title: 'Gone' }] });
  assert.deepEqual(accepted.warnings, statuses.accepted.warnings);
  assert.match(accepted.nextStep, /draft version 2 of the project's review package/);
  assert.ok(Buffer.byteLength(JSON.stringify(accepted)) < 4096, 'the manifest stays out of the result');

  const rejected = (await call('odin_get_package_status', { projectId: PROJECT, uploadId: 'up-r' })).data;
  assert.deepEqual([rejected.state, rejected.status, rejected.errors.length, rejected.errorsTotal], ['rejected', 'rejected', 100, 130]);
  assert.deepEqual(rejected.errors[0], { code: 'path_invalid', file: 'f0', message: 'Bad path.', path: '' });
  assert.deepEqual(rejected.warnings, []);
  assert.match(rejected.nextStep, /validate\.mjs <package\.zip> --track experience/);

  const expired = (await call('odin_get_package_status', { projectId: PROJECT, uploadId: 'up-e' })).data;
  assert.deepEqual([expired.state, expired.status, expired.errors], ['expired', undefined, undefined]);
  assert.match(expired.nextStep, /odin_create_package_upload/);
  const pending = (await call('odin_get_package_status', { projectId: PROJECT, uploadId: 'up-p' })).data;
  assert.match(pending.nextStep, /PUT the zip/);

  const unknown = await call('odin_get_package_status', { projectId: PROJECT, uploadId: 'up-missing' });
  assert.deepEqual([unknown.isError, unknown.data.error.code, unknown.data.error.status], [true, 'upload_not_found', 404]);
  assert.match(unknown.data.error.message, /odin_create_package_upload/);
});

test('a read-only grant runs the read tools and gets insufficient_scope from the upload tool, including its dry run', async (t) => {
  const handlers = { ...routes(), [`POST ${BASE}/packages/upload-urls`]: () => { throw new Error('A read-only grant must not reach Odin.'); }, [`GET ${BASE}/packages/uploads/up-1`]: () => ({ ok: true, state: 'pending', track: 'experience', uploadId: 'up-1' }), [`GET ${BASE}/rounds/${ROUND}/feedback`]: () => ({ schema: 'odin.round-feedback/v1' }) };
  // The same gate http.js applies for a projects.read grant.
  const authorizeTool = ({ write }) => { if (write) throw new OdinApiError(403, 'insufficient_scope', 'The MCP grant lacks the required scope.'); };
  const { call, calls } = await session(t, handlers, { authorizeTool });
  assert.equal((await call('odin_get_requirements_context', { projectId: PROJECT, track: 'experience' })).isError, false);
  assert.equal((await call('odin_get_round_feedback', { projectId: PROJECT, roundId: ROUND })).isError, false);
  assert.equal((await call('odin_get_package_status', { projectId: PROJECT, uploadId: 'up-1' })).isError, false);
  for (const args of [{ projectId: PROJECT, track: 'experience' }, { dryRun: true, projectId: PROJECT, track: 'experience' }]) {
    const denied = await call('odin_create_package_upload', args);
    assert.deepEqual([denied.isError, denied.data.error.code, denied.data.error.status], [true, 'insufficient_scope', 403]);
  }
  assert.ok(calls.every((entry) => entry.method === 'GET'));
});

test('upstream failures in the context stay classified and never echo raw upstream text', async (t) => {
  const { call } = await session(t, routes({ [`GET ${BASE}/plans`]: () => { throw new Error('secret-upstream-detail stack'); } }));
  const failed = await call('odin_get_requirements_context', { projectId: PROJECT, track: 'experience' });
  assert.deepEqual([failed.isError, failed.data.error.code], [true, 'internal_error']);
  assert.equal(JSON.stringify(failed.data).includes('secret-upstream-detail'), false);
  const { call: callMissing } = await session(t, routes({ [`GET ${BASE}`]: () => { throw new OdinApiError(404, 'http_404', 'Odin resource was not found or is not accessible to the current user.'); } }));
  assert.equal((await callMissing('odin_get_requirements_context', { projectId: PROJECT, track: 'experience' })).data.error.status, 404);
});
