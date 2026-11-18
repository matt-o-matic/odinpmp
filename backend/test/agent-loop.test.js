import assert from 'node:assert/strict';
import test from 'node:test';

import { OdinApiError } from '../src/mcp/api-client.js';
import { createOdinToolCatalog } from '../src/mcp/catalog.js';
import { createAgentDecisions, decisionEvidence, heuristicTriage, triageTurn } from '../src/lib/agent/agent-decisions.js';
import { normalizeAgentMarkdown } from '../src/lib/agent/agent-markdown.js';
import { buildAgentInstructions, buildTurnContext } from '../src/lib/agent/agent-prompt.js';
import { CORE_TOOL_NAMES, createAgentToolbox, toolActivityLabel } from '../src/lib/agent/agent-tools.js';
import { createTurnState, runAgentTurn } from '../src/lib/agent/odin-agent.js';
import { normalizeWorkingCalendar } from '../src/modules/governance/schedule-analysis.js';
import { buildGanttCard } from '../src/modules/insights/insights-gantt.js';
import { scriptedOpenAi } from './helpers/agent-test-utils.js';

const PROJECT = {
  epics: [{
    description: '', id: 'epic-1', name: 'Checkout', status: 'In Progress', version: 1,
    stories: [{ description: '', id: 'story-1', name: 'Pay by card', status: 'Not Started', tasks: [], version: 3 }],
  }],
  id: 'project-1',
  name: 'Shop',
  status: 'Active',
  updatedAt: '2026-10-20T00:00:00.000Z',
};

// A stand-in for Odin's REST API: a route table plus a log of every request.
function fakeApi(routes = {}) {
  const requests = [];
  return {
    requests,
    async request(method, path, options = {}) {
      requests.push({ body: options.body, method, path, query: options.query });
      const handler = routes[`${method} ${path}`];
      if (handler) return typeof handler === 'function' ? handler(options) : handler;
      if (method === 'GET' && path === '/api/projects/project-1') return { project: PROJECT };
      if (method === 'GET' && path === '/api/projects/project-1/sprints') return { sprints: [] };
      throw new OdinApiError(404, 'http_404', 'Odin resource was not found or is not accessible to the current user.');
    },
  };
}

async function runTurn({ api = fakeApi(), budget = {}, checks = null, collect = [], resume = null, state = null, steps, ...options }) {
  const scripted = scriptedOpenAi({ steps });
  const toolbox = createAgentToolbox({ api, projectId: 'project-1' });
  const turnState = state ?? createTurnState({ input: [{ content: 'Hi', role: 'user' }], toolNames: toolbox.toolNames(), ...budget });
  const result = await runAgentTurn({
    checks,
    client: scripted.client,
    emit: async (type, payload) => { collect.push({ payload, type }); },
    instructions: 'Test.',
    model: 'gpt-6-luna',
    resume,
    state: turnState,
    toolbox,
    ...options,
  });
  return { api, result, scripted, toolbox };
}

test('a step cut off while thinking runs again with less reasoning instead of ending the turn', async () => {
  const api = fakeApi({ 'PATCH /api/projects/project-1/items/story-1': ({ body }) => ({ item: { id: 'story-1', name: 'Pay by card', ...body.patch, version: 4 } }) });
  const { result, scripted } = await runTurn({
    api,
    reasoningEffort: 'max',
    steps: [
      { incomplete: 'max_output_tokens' },
      { calls: [{ args: { projectId: 'project-1', updates: [{ itemId: 'story-1', patch: { targetEndDate: '2026-10-30' } }] }, name: 'odin_update_items' }] },
      { text: 'Set [Pay by card](odin://item/story-1) to finish Oct 30.' },
    ],
  });
  assert.deepEqual(scripted.calls.responses.map((request) => request.reasoning?.effort), ['max', 'high', 'high']);
  assert.match(scripted.calls.responses[1].input.at(-1).content, /ran out of output space/);
  assert.ok(api.requests.some((entry) => entry.method === 'PATCH'));
  assert.equal(result.text, 'Set [Pay by card](odin://item/story-1) to finish Oct 30.');
});

test('a plain answer streams and keeps its line breaks', async () => {
  const events = [];
  const { result, scripted } = await runTurn({ collect: events, steps: [{ text: '## Summary\n\n- one\n- two' }] });
  assert.equal(result.status, 'completed');
  assert.equal(result.text, '## Summary\n\n- one\n- two');
  assert.equal(events.filter((event) => event.type === 'assistant.delta').map((event) => event.payload.delta).join(''), '## Summary\n\n- one\n- two');
  const request = scripted.calls.responses[0];
  assert.equal(request.stream, true);
  assert.equal(request.parallel_tool_calls, true);
  assert.equal(request.store, false);
  assert.deepEqual(request.reasoning, { effort: 'max' });
  assert.ok(request.tools.some((tool) => tool.name === 'odin_operations'));
  assert.ok(request.tools.some((tool) => tool.name === 'update_plan'));
});

test('reads in one step run together and their results go back to the model', async () => {
  const { api, result, scripted } = await runTurn({ steps: [
    { calls: [{ args: { projectId: 'project-1' }, name: 'odin_project_overview' }, { args: { projectId: 'project-1', text: 'card' }, name: 'odin_find_items' }] },
    { text: 'One story matches.' },
  ] });
  assert.equal(result.text, 'One story matches.');
  assert.deepEqual(result.activity.map((entry) => entry.label), ['Read the project overview', 'Found 1 item matching "card"']);
  const followUp = scripted.calls.responses[1].input;
  assert.equal(followUp.filter((item) => item.type === 'function_call_output').length, 2);
  assert.ok(api.requests.every((entry) => entry.method === 'GET'));
});

test('a plan grows the pooled budget by one task per step, up to the ceiling', async () => {
  const events = [];
  const { result } = await runTurn({
    budget: { maxToolCalls: 100, toolCallsPerTask: 40 },
    collect: events,
    steps: [
      { calls: [{ args: { steps: [{ title: 'Read' }, { title: 'Write' }] }, name: 'update_plan' }] },
      { calls: [{ args: { steps: [{ title: 'Read', status: 'done' }, { title: 'Write' }, { title: 'Check' }, { title: 'Report' }] }, name: 'update_plan' }] },
      { text: 'Done.' },
    ],
  });
  const plans = events.filter((event) => event.type === 'plan.updated').map((event) => event.payload.budget.pool);
  assert.deepEqual(plans, [80, 100]);
  assert.equal(result.state.budget.used, 0, 'updating the plan costs nothing');
  assert.equal(result.plan.length, 4);
  assert.equal(result.activity.length, 0, 'plan updates are not activity');
});

test('calls past the budget are not run and the model is made to answer', async () => {
  const { api, result, scripted } = await runTurn({
    budget: { maxToolCalls: 2, toolCallsPerTask: 2 },
    steps: [
      { calls: [1, 2, 3].map((index) => ({ args: { projectId: 'project-1', text: `t${index}` }, name: 'odin_find_items' })) },
      { text: 'Here is what I found before the budget ran out.' },
    ],
  });
  assert.equal(api.requests.filter((entry) => entry.path === '/api/projects/project-1').length, 2);
  assert.equal(result.activity.filter((entry) => entry.error?.includes('budget')).length, 1);
  const last = scripted.calls.responses.at(-1);
  assert.equal(last.tool_choice, 'none');
  assert.match(last.input.at(-1).content, /budget for this turn \(2 calls\) is used up/);
  assert.equal(result.text, 'Here is what I found before the budget ran out.');
});

test('an identical failing call may be retried, but not a fourth time', async () => {
  const failing = { args: { itemId: 'missing', projectId: 'project-1' }, name: 'odin_get_item' };
  const { api, result } = await runTurn({ steps: [{ calls: [failing] }, { calls: [failing] }, { calls: [failing] }, { calls: [failing] }, { text: 'That item does not exist.' }] });
  const errors = result.activity.map((entry) => entry.error ?? '');
  assert.equal(errors.length, 4);
  assert.match(errors[3], /failed 3 times/);
  assert.equal(api.requests.filter((entry) => entry.path === '/api/projects/project-1').length, 3, 'the fourth identical call is not sent');
});

test('a repeated read is stopped only when its result keeps coming back the same', async () => {
  let counter = 0;
  const api = fakeApi({ 'GET /api/projects/project-1/governance': () => ({ ok: true, items: [{ id: 'risk', status: counter++ < 10 ? `polled-${counter}` : 'same' }] }) });
  const call = { args: { args: { projectId: 'project-1' }, operation: 'odin_get_governance' }, name: 'odin_run' };
  const changing = await runTurn({ api, steps: [{ calls: [call] }, { calls: [call] }, { calls: [call] }, { calls: [call] }, { text: 'Status changed each time.' }] });
  assert.ok(changing.result.activity.every((entry) => entry.ok), 'changing results keep running');

  const steady = await runTurn({ steps: [1, 2, 3, 4].map(() => ({ calls: [{ args: { projectId: 'project-1' }, name: 'odin_project_overview' }] })).concat([{ text: 'Done.' }]) });
  const last = steady.result.activity.at(-1);
  assert.equal(last.ok, false);
  assert.match(last.error, /same result 3 times/);
});

test('a write the user did not ask for is held back by the Decisions check', async () => {
  const scripted = scriptedOpenAi({ decide: (name) => (name === 'write_0' ? 0.05 : null) });
  const checks = createAgentDecisions({ client: scripted.client });
  const { api, result } = await runTurn({
    checks,
    steps: [
      { calls: [{ args: { projectId: 'project-1', updates: [{ itemId: 'story-1', patch: { status: 'Completed' } }] }, name: 'odin_update_items' }] },
      { text: 'I have not changed anything; shall I mark it completed?' },
    ],
  });
  assert.equal(api.requests.some((entry) => entry.method === 'PATCH'), false);
  assert.match(result.activity[0].error, /outside what the user asked for/);
  const check = scripted.calls.decisions[0];
  assert.match(check.questions[0].instructions, /Update 1 item \(odin_update_items: sets status on 1 item; for example \{"status":"Completed"\}\); affects story "Pay by card"\./);
  assert.equal(check.input.some((item) => item.type?.startsWith('function_call')), false, 'the write check reads the conversation, not tool results');
});

test('writes the user asked for run directly, with versions filled in', async () => {
  const api = fakeApi({ 'PATCH /api/projects/project-1/items/story-1': ({ body }) => ({ item: { id: 'story-1', name: 'Pay by card', status: body.patch.status, version: 4 } }) });
  const scripted = scriptedOpenAi();
  const { result } = await runTurn({
    api,
    checks: createAgentDecisions({ client: scripted.client }),
    steps: [
      { calls: [{ args: { projectId: 'project-1', updates: [{ itemId: 'story-1', patch: { status: 'Completed' } }] }, name: 'odin_update_items' }] },
      { text: 'Marked [Pay by card](odin://item/story-1) completed.' },
    ],
  });
  const patch = api.requests.find((entry) => entry.method === 'PATCH');
  assert.deepEqual(patch.body, { expectedVersion: 3, patch: { status: 'Completed' } });
  assert.equal(result.writes.length, 1);
});

test('an item id the model garbles is corrected before the call runs, and in the reply', async () => {
  // From a live chat: the story's id with another story's tail glued on.
  const story = '97042a21-9906-4f14-bb17-4bfe6b213021';
  const garbled = '97042a21-9906-4f5a-bc9b-6bbb81a9cec2';
  const project = { ...PROJECT, epics: [{ ...PROJECT.epics[0], stories: [{ ...PROJECT.epics[0].stories[0], id: story }] }] };
  const api = fakeApi({
    'GET /api/projects/project-1': { project },
    [`PATCH /api/projects/project-1/items/${story}`]: ({ body }) => ({ item: { id: story, name: 'Pay by card', status: body.patch.status, version: 4 } }),
  });
  const { result, scripted } = await runTurn({
    api,
    steps: [
      { calls: [{ args: { projectId: 'project-1', updates: [{ itemId: garbled, patch: { status: 'Completed' } }] }, name: 'odin_update_items' }] },
      { text: `Marked [Pay by card](odin://item/${garbled}) completed.` },
    ],
  });
  assert.ok(api.requests.some((entry) => entry.method === 'PATCH' && entry.path.endsWith(story)));
  assert.equal(result.writes[0].args.updates[0].itemId, story);
  const output = JSON.parse(scripted.calls.responses[1].input.find((item) => item.type === 'function_call_output').output);
  assert.deepEqual(output.idsCorrected.ids, [{ given: garbled, used: story }]);
  assert.equal(result.text, `Marked [Pay by card](odin://item/${story}) completed.`);
});

test('a delete pauses for confirmation, then runs or is declined', async () => {
  const api = fakeApi({ 'DELETE /api/projects/project-1/items/story-1': { ok: true } });
  const events = [];
  const paused = await runTurn({
    api,
    collect: events,
    steps: [{ calls: [{ args: { args: { itemId: 'story-1', projectId: 'project-1' }, operation: 'odin_delete_item' }, name: 'odin_run' }], text: 'Deleting it.' }],
  });
  assert.equal(paused.result.status, 'awaiting_confirmation');
  assert.equal(paused.result.pending.name, 'odin_delete_item');
  assert.equal(api.requests.some((entry) => entry.method === 'DELETE'), false);
  assert.ok(events.some((event) => event.type === 'confirm.requested'));

  const approved = await runTurn({
    api,
    resume: { approved: true, args: paused.result.pending.args, callId: paused.result.pending.callId, name: paused.result.pending.name },
    state: paused.result.state,
    steps: [{ text: 'Deleted.' }],
  });
  assert.equal(approved.result.text, 'Deleted.');
  const deleted = api.requests.find((entry) => entry.method === 'DELETE');
  assert.equal(deleted.body.expectedVersion, 3);

  const declinedApi = fakeApi();
  const again = await runTurn({ api: declinedApi, steps: [{ calls: [{ args: { args: { itemId: 'story-1', projectId: 'project-1' }, operation: 'odin_delete_item' }, name: 'odin_run' }] }] });
  const declined = await runTurn({
    api: declinedApi,
    resume: { approved: false, args: again.result.pending.args, callId: again.result.pending.callId, name: again.result.pending.name },
    state: again.result.state,
    steps: [{ text: 'Okay, I left it.' }],
  });
  assert.equal(declinedApi.requests.some((entry) => entry.method === 'DELETE'), false);
  assert.equal(declined.result.text, 'Okay, I left it.');
});

test('the completion check makes the model finish or correct an unsupported claim', async () => {
  let checksMade = 0;
  const scripted = scriptedOpenAi({ decide: (name) => (name === 'unverified_claim' ? (checksMade++ === 0 ? 0.9 : 0.02) : null) });
  const events = [];
  const { result } = await runTurn({
    checks: createAgentDecisions({ client: scripted.client }),
    collect: events,
    steps: [{ text: 'I marked the story completed.' }, { text: 'I have not changed the story yet.' }],
  });
  assert.equal(result.text, 'I have not changed the story yet.');
  assert.ok(events.some((event) => event.type === 'assistant.reset'));
});

test('a transient read failure is retried once without the model seeing it', async () => {
  let calls = 0;
  const api = fakeApi({ 'GET /api/projects/project-1/governance': () => { calls += 1; if (calls === 1) throw new OdinApiError(503, 'http_503', 'Unavailable'); return { ok: true, items: [] }; } });
  const { result } = await runTurn({ api, steps: [{ calls: [{ args: { args: { projectId: 'project-1' }, operation: 'odin_get_governance' }, name: 'odin_run' }] }, { text: 'No risks.' }] });
  assert.equal(calls, 2);
  assert.equal(result.activity[0].ok, true);
});

test('every MCP tool is reachable from the assistant, and operations can be found, described and run', async () => {
  const toolbox = createAgentToolbox({ api: fakeApi(), projectId: 'project-1' });
  // A core tool, or found by odin_operations (and so runnable with odin_run).
  for (const tool of createOdinToolCatalog({ api: {} })) {
    if (toolbox.toolNames().includes(tool.name)) continue;
    const found = await toolbox.run('odin_operations', { query: tool.name.replace(/^odin_/, '').replace(/_/g, ' ') });
    assert.ok(found.result.operations.some((operation) => operation.name === tool.name), `${tool.name} is reachable`);
  }
  for (const name of CORE_TOOL_NAMES) assert.ok(toolbox.toolNames().includes(name));

  const found = await toolbox.run('odin_operations', { query: 'sprint' });
  assert.ok(found.result.operations.some((operation) => operation.name === 'odin_list_sprints'));
  const described = await toolbox.run('odin_describe', { operation: 'odin_create_sprint' });
  assert.equal(described.result.writes, true);
  assert.equal(described.result.inputSchema.type, 'object');
  const unknown = await toolbox.run('odin_list_sprintz', {});
  assert.match(unknown.result.error.message, /Did you mean/);
});

test('triage uses the Decisions API when it can and simple word rules when it cannot', async () => {
  const toolbox = createAgentToolbox({ api: fakeApi(), projectId: 'project-1' });
  const scripted = scriptedOpenAi({ decide: (name, question) => (question.instructions.includes('"odin_list_tickets"') ? 0.9 : name === 'simple' ? 0.2 : null) });
  const decided = await triageTurn({ decisions: createAgentDecisions({ client: scripted.client }), evidence: decisionEvidence([{ content: 'Which tickets are open?', role: 'user' }]), message: 'Which tickets are open?', toolbox });
  assert.equal(decided.source, 'decisions');
  assert.equal(decided.simple, false);
  assert.ok(decided.promoted.includes('odin_list_tickets'));

  const offline = scriptedOpenAi({ decisionsAvailable: false });
  const fallback = await triageTurn({ decisions: createAgentDecisions({ client: offline.client }), evidence: [], message: 'Add a task for the card form', toolbox });
  assert.equal(fallback.source, 'heuristic');
  assert.equal(fallback.change, true);
  assert.deepEqual(heuristicTriage('What is left in sprint 1?'), { change: false, multiStep: false, research: false, simple: true, visuals: [] });
  assert.equal(heuristicTriage('Break down every epic into stories and tasks').multiStep, true);
});

test('the reply cleanup adds missing line breaks and leaves code alone', () => {
  assert.equal(
    normalizeAgentMarkdown('## Summary **Purpose:** Plan it. **Approach:** Build it.'),
    '## Summary\n\n**Purpose:** Plan it.\n\n**Approach:** Build it.',
  );
  assert.equal(normalizeAgentMarkdown('Items:\n- a\n- b\n```\n## not a heading\n```'), 'Items:\n\n- a\n- b\n```\n## not a heading\n```');
});

test('the reply cleanup drops citation markup the model wrote as text', () => {
  assert.equal(normalizeAgentMarkdown('Started a week ago. citenone\n\n**Recorded:** 40 h'), 'Started a week ago.\n\n**Recorded:** 40 h');
  assert.equal(normalizeAgentMarkdown('Rates rose citeturn0finance0 this year.'), 'Rates rose this year.');
  assert.equal(normalizeAgentMarkdown('A stray  mark.'), 'A stray  mark.');
});

test('the turn notes say what the user\'s role lets them change', () => {
  const notes = (standing, projectSnapshot = { project: { id: 'project-1', name: 'Shop' } }) => buildTurnContext({ projectSnapshot, standing, user: { name: 'Ada Lovelace' } });
  assert.match(notes({ canEditPlan: true, canManage: true, canManageMembers: true, projectRole: 'admin', workspaceRole: 'user' }), /- Ada's role: admin of this project, and workspace user\. They run the project and can change anything in it, including its dates, schedule, scope, estimates and members\./);
  assert.match(notes({ canEditPlan: true, canManage: true, canManageMembers: false, projectRole: 'manager', workspaceRole: 'user' }), /- Ada's role: manager of this project, and workspace user\. They run the project and can change anything in it \(its dates, schedule, scope and estimates\) except who its members are\./);
  assert.match(notes({ canEditPlan: true, canManage: false, canManageMembers: false, projectRole: 'editor', workspaceRole: 'user' }), /- Ada's role: editor of this project, and workspace user\. They can change individual work items, but project-wide changes \(.*more than 10 work items at once\) need a project admin or manager, and Odin refuses them\./);
  assert.match(notes({ canEditPlan: false, canManage: false, canManageMembers: false, projectRole: 'user', workspaceRole: 'user' }), /- Ada's role: user of this project, and workspace user\. They cannot change work items or the plan; Odin refuses those changes\./);
  assert.match(notes({ canEditPlan: true, canManage: true, canManageMembers: true, projectRole: null, workspaceRole: 'admin' }), /- Ada's role: workspace admin, not a member of this project\. They run the project/);
  assert.match(notes({ workspaceRole: 'manager' }, null), /- Ada's role: workspace manager\. Workspace admins and managers can change every project\./);
  assert.doesNotMatch(buildTurnContext({ user: { name: 'Ada Lovelace' } }), /role:/);
});

test('the Decisions evidence always keeps the conversation, however many tools ran', () => {
  const input = [
    { content: 'Which cards mention Reese?', role: 'user' },
    { content: 'Two cards credit Reese: Workshop and Triage.', role: 'assistant' },
    { content: 'Please update those card descriptions to remove Reese.', role: 'user' },
  ];
  for (let index = 0; index < 30; index += 1) {
    input.push({ encrypted_content: 'x', id: `rs_${index}`, summary: [], type: 'reasoning' });
    input.push({ arguments: '{}', call_id: `c${index}`, name: 'odin_get_item', type: 'function_call' });
    input.push({ call_id: `c${index}`, output: '{"ok":true}', type: 'function_call_output' });
  }
  input.push({ arguments: '{}', call_id: 'pending', name: 'odin_update_items', type: 'function_call' });
  const evidence = decisionEvidence(input);
  assert.deepEqual(evidence.filter((item) => item.role).map((item) => item.content), [
    'Which cards mention Reese?',
    'Two cards credit Reese: Workshop and Triage.',
    'Please update those card descriptions to remove Reese.',
  ]);
  assert.equal(evidence.filter((item) => item.type === 'function_call').length, 7, 'the latest complete tool calls');
  assert.equal(evidence.some((item) => item.call_id === 'pending'), false, 'a call about to run is not evidence');
  assert.equal(evidence.some((item) => item.type === 'reasoning'), false);
  assert.equal(decisionEvidence(input, { toolItems: 0 }).some((item) => item.type), false, 'toolItems: 0 keeps none');
});

test('judgments read what the user is looking at from the turn notes, and none of the rest', () => {
  const notes = buildTurnContext({
    pageContext: { view: 'project Board' },
    projectSnapshot: { project: { id: 'project-1', name: 'Shop' }, counts: { open: 12 } },
    promoted: [{ inputs: { type: 'object' }, name: 'odin_update_sprint', purpose: 'Rename a sprint.', writes: true }],
    selectedItem: { id: 'story-1', name: 'Pay by card' },
    user: { name: 'Ada Lovelace' },
  });
  const evidence = decisionEvidence([
    { content: 'Summary of the earlier conversation (older messages were condensed to save space):\nAda planned checkout.', role: 'developer' },
    { content: notes, role: 'developer' },
    { content: 'mark this done', role: 'user' },
    { content: 'Tool budget: 20 of 40 calls used this turn.', role: 'developer' },
  ]);
  assert.deepEqual(evidence.map((item) => item.content), [
    'Summary of the earlier conversation (older messages were condensed to save space):\nAda planned checkout.',
    '- Ada is looking at: project Board.\n- The item on screen ("this item", "this story"): {"id":"story-1","name":"Pay by card"}',
    'mark this done',
  ]);
});

test('a limit above the maximum is brought down instead of failing the call', async () => {
  const api = fakeApi({ 'GET /api/reporting/search': ({ query }) => ({ ok: true, records: [], query }) });
  const { result } = await runTurn({ api, steps: [{ calls: [{ args: { limit: 60, query: 'Kelly' }, name: 'odin_search' }] }, { text: 'Nothing found.' }] });
  assert.equal(result.activity[0].ok, true);
  assert.equal(api.requests.find((entry) => entry.path === '/api/reporting/search').query.limit, 50);
});

test('triage picks the visual formats a request calls for, and the prompt suggests them', async () => {
  const toolbox = createAgentToolbox({ api: fakeApi(), projectId: 'project-1' });
  const scripted = scriptedOpenAi({ decide: (name) => ({ visual_chart: 0.92, visual_flow: 0.2, visual_graph: 0.61 })[name] ?? null });
  const decided = await triageTurn({ decisions: createAgentDecisions({ client: scripted.client }), evidence: decisionEvidence([{ content: 'Chart open work by owner and show how the epics depend on each other', role: 'user' }]), message: 'Chart open work by owner and show how the epics depend on each other', toolbox });
  assert.deepEqual(decided.visuals, ['chart', 'graphviz']);
  const prompt = buildAgentInstructions();
  assert.match(prompt, /Never draw charts, diagrams or graphs with ASCII or text art/);
  assert.match(buildTurnContext({ triage: decided }), /This request would be clearest with a ```chart block or a ```dot graph\./);
  // The example puts the language alone on the fence line, so the model does not write "```chart: {".
  assert.match(prompt, /\n```chart\n\{"type": "bar"/);
  assert.doesNotMatch(prompt, /```(chart|mermaid|dot):/);
  assert.doesNotMatch(buildTurnContext({ triage: { visuals: [] } }), /would be clearest with/);
  assert.deepEqual(heuristicTriage('Draw the approval flow as a diagram').visuals, ['mermaid']);
});

test('a model that rejects 24-hour caching gets the step again without it, keeping the cache key', async () => {
  const scripted = scriptedOpenAi({ steps: [{ text: 'Cached or not, here it is.' }] });
  const sent = [];
  const client = {
    responses: {
      async create(params) {
        sent.push(params);
        if (params.prompt_cache_retention) throw Object.assign(new Error('prompt_cache_retention is not supported for this model.'), { status: 400 });
        return scripted.client.responses.create(params);
      },
    },
  };
  const toolbox = createAgentToolbox({ api: fakeApi(), projectId: 'project-1' });
  const result = await runAgentTurn({ client, instructions: 'Test.', model: 'gpt-5-mini', promptCacheKey: 'odin-abc', promptCacheRetention: '24h', state: createTurnState({ input: [{ content: 'Hi', role: 'user' }], toolNames: toolbox.toolNames() }), toolbox });
  assert.equal(result.text, 'Cached or not, here it is.');
  assert.deepEqual(sent.map((params) => [params.prompt_cache_key, params.prompt_cache_retention ?? null]), [['odin-abc', '24h'], ['odin-abc', null]]);
  assert.deepEqual([result.usage.cachedTokens, result.usage.inputTokens, result.usage.steps], [80, 100, 1]);
});

test('triage scores operations beyond the core tools in plain words and promotes at most four likely ones', async () => {
  const toolbox = createAgentToolbox({ api: fakeApi(), projectId: 'project-1' });
  const operations = toolbox.operations();
  for (const covered of ['odin_list_items', 'odin_get_project', 'odin_create_item', 'odin_update_item']) assert.ok(!operations.some((operation) => operation.name === covered), `${covered} is covered by a core tool`);
  assert.deepEqual(operations.find((operation) => operation.name === 'odin_activate_sprint'), { name: 'odin_activate_sprint', summary: 'Start a sprint, making it the active sprint.', write: true });

  const operationIn = (question) => question.instructions.match(/"(odin_[a-z_]+)"/)?.[1] ?? '';
  const scripted = scriptedOpenAi({ decide: (name, question) => (name.startsWith('op_') ? (operationIn(question).includes('sprint') ? 0.95 : 0.59) : null) });
  const decided = await triageTurn({ decisions: createAgentDecisions({ client: scripted.client }), evidence: decisionEvidence([{ content: 'start sprint 2', role: 'user' }]), message: 'start sprint 2', toolbox });
  assert.equal(decided.promoted.length, 4);
  assert.ok(decided.promoted.every((name) => name.includes('sprint')), 'operations under 0.6 are not promoted');
  const asked = scripted.calls.decisions[0].questions.find((question) => question.instructions.includes('"odin_activate_sprint"')).instructions;
  assert.match(asked, /\(it changes data\): Start a sprint/);
  assert.match(asked, /answer yes only if this operation itself is needed/);

  // The promoted operations reach the model as notes with their inputs, not as extra tools.
  const brief = toolbox.brief(['odin_activate_sprint', 'odin_delete_item', 'odin_not_real']);
  assert.deepEqual(brief.map((entry) => [entry.name, entry.writes, entry.confirms]), [['odin_activate_sprint', true, false], ['odin_delete_item', true, true]]);
  assert.match(buildTurnContext({ promoted: brief }), /odin_delete_item \(changes data; asks the user to confirm\)/);
  assert.deepEqual(toolbox.toolNames(), CORE_TOOL_NAMES);
});

test('odin_query is always offered, and a write in the turn makes later queries read fresh data', async () => {
  const api = fakeApi({ 'POST /api/projects/project-1/governance/items': { item: { id: 'risk-1' }, ok: true } });
  const toolbox = createAgentToolbox({ api, projectId: 'project-1' });
  assert.ok(toolbox.localToolNames().includes('odin_query'));
  assert.match(toolbox.definition('odin_query').description, /items\(id, project_id, type: 'epic', 'story' or 'task'/);
  const first = await toolbox.run('odin_query', { sql: "SELECT name FROM items WHERE type = 'story'" });
  assert.deepEqual(first.result.rows, [['Pay by card']]);
  await toolbox.run('odin_query', { sql: 'SELECT COUNT(*) FROM items' });
  const reads = () => api.requests.filter((request) => request.method === 'GET' && request.path === '/api/projects/project-1').length;
  assert.equal(reads(), 1);
  await toolbox.run('odin_create_governance_item', { input: { kind: 'risk', title: 'Vendor delay' }, projectId: 'project-1' });
  await toolbox.run('odin_query', { sql: 'SELECT COUNT(*) FROM items' });
  assert.equal(reads(), 2);
  assert.equal(toolActivityLabel('odin_query', {}, first.result), 'Ran a query (1 row)');
});

test('the timeline reads as dates and reasons, and a launch milestone can be added and moved', async () => {
  const card = buildGanttCard({
    calendar: normalizeWorkingCalendar(null),
    project: { epics: [{ id: 'epic-1', name: 'Launch', stories: [
      { assigneeId: 'ada', id: 'prep', name: 'Prep', status: 'In Progress', targetEndDate: '2026-10-28', targetStartDate: '2026-10-26' },
      { assigneeId: 'ada', id: 'cutover', name: 'Cutover', status: 'Not Started', targetEndDate: '2026-10-28', targetStartDate: '2026-10-28' },
    ] }] },
    memberNames: new Map([['ada', 'Ada']]),
    sprints: [],
    today: '2026-10-26',
  });
  const api = fakeApi({
    'GET /api/projects/project-1/insights': { cards: { gantt: card } },
    'GET /api/projects/project-1/governance': { milestones: [{ id: 'm-1', targetDate: '2026-10-30', title: 'Launch', version: 2 }] },
    'POST /api/projects/project-1/governance/milestones': ({ body }) => ({ id: 'm-1', ...body, version: 1 }),
    'PATCH /api/projects/project-1/governance/milestones/m-1': ({ body }) => ({ id: 'm-1', ...body }),
  });
  const toolbox = createAgentToolbox({ api, projectId: 'project-1' });
  const { result: timeline } = await toolbox.run('odin_get_timeline', { projectId: 'project-1' });
  assert.equal(timeline.planFinish, '2026-10-29');
  assert.match(timeline.advice, /^"Cutover" starts later than its dates because Ada is busy with another story then\. .*back-to-back dates/);
  assert.deepEqual(timeline.rows.find((row) => row.id === 'cutover'), {
    critical: true, done: false, finish: '2026-10-29', heldBy: 'waits for Ada to finish "Prep"', id: 'cutover', length: '1 working day from dates', name: 'Cutover', start: '2026-10-29', type: 'story',
  });

  const mistyped = await toolbox.run('odin_create_milestone', { input: { targetDate: '2026-10-30', title: 'Launch', workItemId: 'story-1-typo' }, projectId: 'project-1' });
  assert.match(mistyped.result.error.message, /No work item in this project has the id story-1-typo/);
  const { result: created } = await toolbox.run('odin_create_milestone', { input: { targetDate: '2026-10-30', title: 'Launch', workItemId: 'story-1' }, projectId: 'project-1' });
  assert.equal(created.linkedTo, 'story "Pay by card"');
  await toolbox.run('odin_update_milestone', { milestoneId: 'm-1', patch: { targetDate: '2026-10-29' }, projectId: 'project-1' });
  const writes = api.requests.filter((request) => request.method !== 'GET');
  assert.deepEqual(writes.map(({ body, method }) => [method, body]), [
    ['POST', { status: 'planned', targetDate: '2026-10-30', title: 'Launch', workItemId: 'story-1' }],
    ['PATCH', { expectedVersion: 2, targetDate: '2026-10-29' }],
  ]);
});

test('a reply that asks the user something it needs is not pushed to carry on', async () => {
  const verdict = { can_continue: 0.9, done: 0.1 };
  for (const [needsUser, nudged] of [[0.9, false], [0.1, true]]) {
    const scripted = scriptedOpenAi({ decide: (name) => ({ ...verdict, needs_user: needsUser })[name] ?? null });
    const events = [];
    const { result } = await runTurn({ checks: createAgentDecisions({ client: scripted.client }), collect: events, steps: [{ text: 'There are no sprints yet. Should I create one?' }, { text: 'Created Sprint 1.' }] });
    assert.equal(events.some((event) => event.type === 'assistant.reset'), nudged, `needs_user ${needsUser}`);
    assert.equal(result.text === 'There are no sprints yet. Should I create one?', !nudged);
  }
});
