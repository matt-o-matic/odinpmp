import assert from 'node:assert/strict';
import test from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createLiveEventBus, LIVE_EVENT_CHANNELS } from '../src/lib/events/live-event-bus.js';
import { createInMemoryAgentChatsRepository } from '../src/modules/assistant/agent-chats.repository.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';
import { agentAppDeps, listen, runChatTurn, scriptedOpenAi, waitForChat, waitForTurn } from './helpers/agent-test-utils.js';

// The assistant's chat API end to end: a scripted model drives real tools, which call the app's
// REST routes over loopback as the signed-in user.

function member(id, name, tenantId = 'tenant-acme', role = 'user') {
  return { authMethod: 'basic', email: `${id.replace('user-', '')}@${tenantId === 'tenant-acme' ? 'acme.com' : 'globex.com'}`, id, memberships: [{ role, tenantId }], name, passwordHash: 'unused', preferences: { twoFactorEnabled: false } };
}

function seedProject() {
  return {
    description: 'Launch work.', endDate: '2026-12-15', id: 'project-launch', name: 'Launch Readiness', rank: 1, role: 'admin', startDate: '2026-05-10', status: 'In Progress', tenantId: 'tenant-acme', updatedAt: '2026-05-12T08:30:00.000Z',
    epics: [{
      id: 'epic-launch', name: 'Launch', status: 'In Progress',
      stories: [{ assigneeId: 'user-ada', id: 'story-routing', name: 'Routing', status: 'In Progress', tasks: [{ assigneeId: 'user-ada', id: 'task-rules', name: 'Rules', points: 3, status: 'In Progress' }] }],
    }],
  };
}

async function createChatTestApp(scripted, agentOverrides = {}, deps = {}) {
  const grace = member('user-grace', 'Grace Hopper', 'tenant-acme', 'admin');
  const hedy = member('user-hedy', 'Hedy Lamarr', 'tenant-globex');
  const users = [grace, member('user-ada', 'Ada Lovelace'), hedy];
  const authRepository = await createInMemoryAuthRepository({ disableDemoUser: true, tenants: [{ domains: ['acme.com'], id: 'tenant-acme', name: 'Acme' }, { domains: ['globex.com'], id: 'tenant-globex', name: 'Globex' }], users });
  const projectRepository = createInMemoryProjectsRepository({ authRepository, seed: { projects: [seedProject()] } });
  const tokenService = createTokenService({ issuer: 'odinpmp-test', secret: 'test-secret' });
  const sessionsRepository = createInMemorySessionsRepository();
  const liveEventBus = createLiveEventBus();
  const app = createApp({ ...agentAppDeps(scripted, agentOverrides), authRepository, frontendAppUrl: 'http://localhost:5173/app', liveEventBus, projectRepository, sessionsRepository, tokenService, ...deps });
  const signIn = async (user, role) => {
    const token = tokenService.signSessionToken({ email: user.email, id: user.id, name: user.name, preferences: {}, role, scopes: [], tenantId: user.memberships[0].tenantId });
    await sessionsRepository.createSession({ expiryDate: new Date(Date.now() + 3600_000), ipAddr: '127.0.0.1', locationName: 'Localhost', token, userAgent: 'test', userId: user.id });
    return token;
  };
  const server = await listen(app);
  return { app, close: server.close, hedyToken: await signIn(hedy, 'user'), liveEventBus, projectRepository, sessionsRepository, token: await signIn(grace, 'admin') };
}

const loadProject = async (app, token) => (await request(app).get('/api/projects/project-launch').set('Authorization', `Bearer ${token}`)).body.project;

test('a question streams an answer that keeps its formatting, and the chat is the user\'s own', async (context) => {
  const scripted = scriptedOpenAi({ steps: [
    { calls: [{ args: { projectId: 'project-launch' }, name: 'odin_project_overview' }] },
    { text: '## Launch Readiness\n\n**Status:** In progress.\n\n- 1 epic\n- 1 story' },
  ] });
  const harness = await createChatTestApp(scripted);
  context.after(harness.close);
  const created = await request(harness.app).post('/api/assistant/chats').set('Authorization', `Bearer ${harness.token}`).send({ projectId: 'project-launch' });
  const events = [];
  harness.liveEventBus.subscribe(LIVE_EVENT_CHANNELS.session(created.body.chat.id), (event) => events.push(event.type));

  const chat = await runChatTurn(harness.app, harness.token, { chatId: created.body.chat.id, message: 'Summarize the project please.' });
  const reply = chat.messages.at(-1);
  assert.equal(chat.run.status, 'completed');
  assert.equal(reply.content, '## Launch Readiness\n\n**Status:** In progress.\n\n- 1 epic\n- 1 story');
  assert.deepEqual(reply.activity.map((entry) => entry.label), ['Read the project overview']);
  for (const type of ['turn.started', 'intent.identified', 'tool.started', 'tool.completed', 'assistant.delta', 'turn.completed']) assert.ok(events.includes(type), `${type} was published`);

  // The model saw the project snapshot (in the turn's notes) and ran at high effort for a simple question.
  const first = scripted.calls.responses[0];
  assert.match(first.input.at(-2).content, /Launch Readiness/);
  assert.deepEqual(first.reasoning, { effort: 'high' });
  assert.equal(chat.run.reasoningEffort, 'high');
  assert.equal(chat.run.triage.source, 'decisions');

  assert.equal((await request(harness.app).get(`/api/assistant/chats/${chat.id}`).set('Authorization', `Bearer ${harness.hedyToken}`)).status, 404);
  const listed = await request(harness.app).get('/api/assistant/chats').set('Authorization', `Bearer ${harness.token}`);
  assert.equal(listed.body.projects[0].chats[0].id, chat.id);
});

test('every turn sends the same instructions and tools, with its own notes just before the message, so the prefix is cached', async (context) => {
  const scripted = scriptedOpenAi({
    decide: (name, question) => (question.instructions.includes('"odin_list_sprints"') ? 0.9 : null),
    steps: [{ calls: [{ args: { projectId: 'project-launch' }, name: 'odin_project_overview' }] }, { text: 'One epic.' }, { text: 'No sprints yet.' }],
  });
  const harness = await createChatTestApp(scripted);
  context.after(harness.close);
  const first = await runChatTurn(harness.app, harness.token, { message: 'Summarize the project please.', projectId: 'project-launch' });
  await runChatTurn(harness.app, harness.token, { chatId: first.id, message: 'What sprints are there?' });
  const [turnOne, turnOneAgain, turnTwo] = scripted.calls.responses;

  // Same instructions and tool list on every step and turn: no names, dates, snapshot or promotions.
  assert.equal(turnTwo.instructions, turnOne.instructions);
  assert.deepEqual(turnTwo.tools, turnOne.tools);
  assert.doesNotMatch(turnOne.instructions, /Grace|Launch Readiness|20\d\d/);
  assert.ok(!turnTwo.tools.some((tool) => tool.name === 'odin_list_sprints'), 'promoted operations are not added as tools');

  // Within a turn the input only grows; across turns the conversation comes first, then the notes.
  assert.deepEqual(turnOneAgain.input.slice(0, turnOne.input.length), turnOne.input);
  // Turn one's request, notes included, is the start of turn two's: the whole of it stays cached.
  assert.deepEqual(turnOne.input.map((item) => item.role ?? item.type), ['developer', 'user']);
  assert.deepEqual(turnTwo.input.slice(0, 2), turnOne.input);
  assert.deepEqual(turnTwo.input.map((item) => item.role ?? item.type), ['developer', 'user', 'function_call', 'function_call_output', 'assistant', 'developer', 'user']);
  assert.match(turnTwo.input[0].content, /^# Turn notes \(as of /);
  const notes = turnTwo.input[5].content;
  assert.match(notes, /Grace Hopper/);
  assert.match(notes, /- Grace's role: admin of this project, and workspace admin. They run the project and can change anything in it/);
  assert.match(notes, /Launch Readiness/);
  assert.match(notes, /odin_list_sprints \(read-only\): List the project's sprints with their dates and status\. Inputs: \{/);

  // One user's requests share a cache key (not their raw id) and ask for 24-hour caching.
  assert.match(turnOne.prompt_cache_key, /^odin-[0-9a-f]{32}$/);
  assert.equal(turnTwo.prompt_cache_key, turnOne.prompt_cache_key);
  assert.equal(turnOne.prompt_cache_retention, '24h');
  const latest = (await request(harness.app).get(`/api/assistant/chats/${first.id}`).set('Authorization', `Bearer ${harness.token}`)).body.chat;
  assert.deepEqual([latest.run.usage.cachedTokens, latest.run.usage.inputTokens, latest.run.usage.steps], [80, 100, 1]);
});

test('anything other than a simple request runs at max reasoning effort', async (context) => {
  const scripted = scriptedOpenAi({ decide: (name) => (name === 'simple' ? 0.1 : null), steps: [{ text: 'Planned.' }] });
  const harness = await createChatTestApp(scripted);
  context.after(harness.close);
  const chat = await runChatTurn(harness.app, harness.token, { message: 'Break every epic down into stories and tasks.', projectId: 'project-launch' });
  assert.equal(chat.run.reasoningEffort, 'max');
  assert.deepEqual(scripted.calls.responses[0].reasoning, { effort: 'max' });
});

test('a short reply that lets a complex change go on keeps max effort', async (context) => {
  let simple = 0.1;
  const scripted = scriptedOpenAi({ decide: (name) => ({ change: 0.9, simple })[name] ?? null, steps: [{ text: 'Should the project end on Oct 30?' }, { text: 'Done.' }, { text: 'Done.' }] });
  const harness = await createChatTestApp(scripted);
  context.after(harness.close);
  const first = await runChatTurn(harness.app, harness.token, { message: 'Set every item\'s dates so we launch Friday.', projectId: 'project-launch' });
  simple = 0.95;
  const reply = await runChatTurn(harness.app, harness.token, { chatId: first.id, message: 'Keep it ending Oct 30.' });
  assert.equal(reply.run.reasoningEffort, 'max');
  // The reply itself was judged simple, so a simple change after it runs as simple.
  const next = await runChatTurn(harness.app, harness.token, { chatId: first.id, message: 'Mark the cutover story done.' });
  assert.equal(next.run.reasoningEffort, 'high');
});

test('a request that needs several steps runs at max effort even when it reads as simple', async (context) => {
  const scripted = scriptedOpenAi({ decide: (name) => ({ change: 0.9, multi_step: 0.85, simple: 0.52 })[name] ?? null, steps: [{ text: 'Done.' }] });
  const harness = await createChatTestApp(scripted);
  context.after(harness.close);
  const chat = await runChatTurn(harness.app, harness.token, { message: 'Make it happen.', projectId: 'project-launch' });
  assert.equal(chat.run.reasoningEffort, 'max');
});

test('a question gets a proposal, and the go-ahead carries it out at the same effort', async (context) => {
  let verdict = { change: 0.1, multi_step: 0.8, simple: 0.3 };
  const scripted = scriptedOpenAi({ decide: (name) => verdict[name] ?? null, steps: [{ text: 'I would move the start to Oct 19 and re-date 12 stories. Shall I?' }, { text: 'Done.' }] });
  const harness = await createChatTestApp(scripted);
  context.after(harness.close);
  const first = await runChatTurn(harness.app, harness.token, { message: 'What do we need to do to finish by Oct 30?', projectId: 'project-launch' });
  const notes = scripted.calls.responses[0].input.find((item) => item.role === 'developer').content;
  assert.match(notes, /This message asks rather than tells: answer it, and if changes would help, say what you will change and ask whether to go ahead, without changing anything yet\./);
  assert.match(scripted.calls.responses[0].instructions, /propose them as what you will do, with the values you would set \("I'll move the start to Oct 19 and…"\), and ask whether to go ahead\. .*Make the changes once the user agrees\./);
  verdict = { change: 0.9, multi_step: 0.2, simple: 0.9 };
  const goAhead = await runChatTurn(harness.app, harness.token, { chatId: first.id, message: 'Yes, do it.' });
  assert.equal(first.run.reasoningEffort, 'max');
  assert.equal(goAhead.run.reasoningEffort, 'max');
});

test('the assistant writes as the user, and a delete waits for confirmation', async (context) => {
  const scripted = scriptedOpenAi({ steps: [
    { calls: [{ args: { items: [{ assignee: 'Ada Lovelace', name: 'Write the launch FAQ', points: 2 }], parentId: 'story-routing', projectId: 'project-launch' }, name: 'odin_create_plan_items' }] },
    { calls: [{ args: { args: { itemId: 'task-rules', projectId: 'project-launch' }, operation: 'odin_delete_item' }, name: 'odin_run' }] },
    { text: 'Added the FAQ task and removed Rules.' },
  ] });
  const harness = await createChatTestApp(scripted);
  context.after(harness.close);

  const paused = await runChatTurn(harness.app, harness.token, { message: 'Add an FAQ task for Ada under Routing, and delete the Rules task.', projectId: 'project-launch' });
  assert.equal(paused.run.status, 'awaiting_confirmation');
  assert.equal(paused.pending.name, 'odin_delete_item');
  assert.equal(paused.messages.at(-1).confirmation.status, 'pending');
  let project = await loadProject(harness.app, harness.token);
  const tasks = project.epics[0].stories[0].tasks;
  assert.deepEqual(tasks.map((task) => task.name).sort(), ['Rules', 'Write the launch FAQ']);
  assert.equal(tasks.find((task) => task.name === 'Write the launch FAQ').assigneeId, 'user-ada');
  // The turn's own session is gone once the turn ends.
  const sessions = await harness.sessionsRepository.listActiveSessions({ userId: 'user-grace' });
  assert.equal(sessions.filter((session) => session.userAgent === 'Odin assistant').length, 0);

  const confirmed = await request(harness.app).post(`/api/assistant/chats/${paused.id}/confirmation`).set('Authorization', `Bearer ${harness.token}`).send({ callId: paused.pending.callId, decision: 'approve' });
  assert.equal(confirmed.status, 202, JSON.stringify(confirmed.body));
  const done = await waitForTurn(harness.app, harness.token, paused.id);
  assert.equal(done.run.status, 'completed');
  assert.equal(done.messages.find((message) => message.confirmation)?.confirmation.status, 'approved');
  assert.equal(done.messages.at(-1).content, 'Added the FAQ task and removed Rules.');
  project = await loadProject(harness.app, harness.token);
  assert.deepEqual(project.epics[0].stories[0].tasks.map((task) => task.name), ['Write the launch FAQ']);
});

test('a new message skips a pending confirmation, and attachments reach the model', async (context) => {
  const scripted = scriptedOpenAi({ steps: [
    { calls: [{ args: { args: { itemId: 'task-rules', projectId: 'project-launch' }, operation: 'odin_delete_item' }, name: 'odin_run' }] },
    { text: 'Read your notes.' },
  ] });
  const harness = await createChatTestApp(scripted);
  context.after(harness.close);
  const paused = await runChatTurn(harness.app, harness.token, { message: 'Delete the Rules task.', projectId: 'project-launch' });
  assert.equal(paused.run.status, 'awaiting_confirmation');

  const sent = await request(harness.app).post(`/api/assistant/chats/${paused.id}/messages`).set('Authorization', `Bearer ${harness.token}`)
    .send({ attachments: [{ mimeType: 'text/markdown', name: 'notes.md', size: 20, text: 'Launch moves to Nov 3.' }], message: 'Actually, read these notes instead.' });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  const chat = await waitForTurn(harness.app, harness.token, paused.id);
  assert.equal(chat.messages.find((message) => message.confirmation)?.confirmation.status, 'skipped');
  assert.equal(chat.pending, null);
  assert.deepEqual(chat.messages.at(-2).attachments, [{ mimeType: 'text/markdown', name: 'notes.md', size: 20 }]);
  const input = JSON.stringify(scripted.calls.responses.at(-1).input);
  assert.match(input, /Launch moves to Nov 3\./);
  assert.equal((await loadProject(harness.app, harness.token)).epics[0].stories[0].tasks.length, 1, 'the skipped delete did not run');
});

test('without the Decisions API the turn still runs, using word rules', async (context) => {
  const scripted = scriptedOpenAi({ decisionsAvailable: false, steps: [{ text: 'Here you go.' }] });
  const harness = await createChatTestApp(scripted);
  context.after(harness.close);
  const chat = await runChatTurn(harness.app, harness.token, { message: 'What is left in the sprint?', projectId: 'project-launch' });
  assert.equal(chat.run.status, 'completed');
  assert.equal(chat.run.triage.source, 'heuristic');
  assert.equal(chat.run.reasoningEffort, 'high');
});

test('a model failure ends the turn with a readable error instead of a canned reply', async (context) => {
  const scripted = scriptedOpenAi({ steps: [{ error: Object.assign(new Error('Rate limit reached'), { status: 429 }) }] });
  const harness = await createChatTestApp(scripted);
  context.after(harness.close);
  const chat = await runChatTurn(harness.app, harness.token, { message: 'Summarize.', projectId: 'project-launch' });
  assert.equal(chat.run.status, 'failed');
  assert.match(chat.messages.at(-1).error, /rate limiting/);
});

test('a turn cut off by a restart shows as an error reply, which stays in the chat once the next message is sent', async (context) => {
  const agentChatsRepository = createInMemoryAgentChatsRepository();
  const harness = await createChatTestApp(scriptedOpenAi({ steps: [{ text: 'Here now.' }] }), {}, { agentChatsRepository });
  context.after(harness.close);
  const created = await request(harness.app).post('/api/assistant/chats').set('Authorization', `Bearer ${harness.token}`).send({ projectId: 'project-launch' });
  const chatId = created.body.chat.id;
  // As a process that stopped during a turn leaves the chat: the message saved, the run still running.
  const stored = await agentChatsRepository.get({ chatId, tenantId: 'tenant-acme', userId: 'user-grace' });
  stored.messages.push({ attachments: [], content: 'Did the tasks move too?', createdAt: '2026-10-30T15:18:35.601Z', id: 'message-lost', role: 'user' });
  stored.run = { id: 'run-lost', startedAt: '2026-10-30T15:18:35.601Z', status: 'running' };
  await agentChatsRepository.save(stored);

  const interrupted = 'This answer was interrupted when Odin restarted. Send your message again.';
  const shown = (await request(harness.app).get(`/api/assistant/chats/${chatId}`).set('Authorization', `Bearer ${harness.token}`)).body.chat;
  assert.deepEqual([shown.run.status, shown.messages.at(-1).role, shown.messages.at(-1).error], ['failed', 'assistant', interrupted]);
  const chat = await runChatTurn(harness.app, harness.token, { chatId, message: 'hello?' });
  assert.deepEqual(chat.messages.map((message) => [message.role, message.content || message.error]), [
    ['user', 'Did the tasks move too?'], ['assistant', interrupted], ['user', 'hello?'], ['assistant', 'Here now.'],
  ]);
});

test('budget and reasoning settings come from configuration', async (context) => {
  const scripted = scriptedOpenAi({ decide: (name) => (name === 'simple' ? 0.1 : null), steps: [{ text: 'Done.' }] });
  const harness = await createChatTestApp(scripted, { maxToolCalls: 60, reasoningComplex: 'xhigh', toolCallsPerTask: 12 });
  context.after(harness.close);
  const chat = await runChatTurn(harness.app, harness.token, { message: 'Reorganize the whole plan.', projectId: 'project-launch' });
  assert.deepEqual(chat.run.budget, { pool: 12, used: 0 });
  assert.equal(chat.run.reasoningEffort, 'xhigh');
  assert.match(scripted.calls.responses[0].input.at(-2).content, /Tool budget for this turn: 12 calls; each task in your plan adds 12/);
});

test('on a turn that asks for changes only plainly unrelated writes are held; on a question the bar is higher', async (context) => {
  const updateRules = { args: { projectId: 'project-launch', updates: [{ itemId: 'task-rules', patch: { name: 'Rules engine' } }] }, name: 'odin_update_items' };
  const asked = scriptedOpenAi({ decide: (name) => (name === 'change' ? 0.95 : name === 'write_0' ? 0.2 : null), steps: [{ calls: [updateRules] }, { text: 'Renamed it.' }] });
  const harness = await createChatTestApp(asked);
  context.after(harness.close);
  await runChatTurn(harness.app, harness.token, { message: 'Rename the rules task to Rules engine.', projectId: 'project-launch' });
  assert.equal((await loadProject(harness.app, harness.token)).epics[0].stories[0].tasks[0].name, 'Rules engine');

  const question = scriptedOpenAi({ decide: (name) => (name === 'change' ? 0.05 : name === 'write_0' ? 0.2 : null), steps: [{ calls: [{ ...updateRules, args: { ...updateRules.args, updates: [{ itemId: 'task-rules', patch: { name: 'Something else' } }] } }] }, { text: 'I did not change anything.' }] });
  const other = await createChatTestApp(question);
  context.after(other.close);
  const chat = await runChatTurn(other.app, other.token, { message: 'What is the rules task called?', projectId: 'project-launch' });
  assert.match(chat.messages.at(-1).activity[0].error, /outside what the user asked for/);
  assert.equal((await loadProject(other.app, other.token)).epics[0].stories[0].tasks[0].name, 'Rules');
});

test('follow-ups see what earlier turns read, and past the budget older turns are condensed into a summary', async (context) => {
  const scripted = scriptedOpenAi({ steps: [
    { calls: [{ args: { projectId: 'project-launch' }, name: 'odin_project_overview' }] },
    { text: 'Noted; Launch is the only epic.' },
    { text: 'Routing is in progress.' },
    { text: '- The user shared a long launch brief; Launch is the only epic.' },
    { text: 'Still in progress.' },
  ] });
  const harness = await createChatTestApp(scripted, { compactAtTokens: 12000 });
  context.after(harness.close);
  const created = await request(harness.app).post('/api/assistant/chats').set('Authorization', `Bearer ${harness.token}`).send({ projectId: 'project-launch' });
  const chatId = created.body.chat.id;
  const brief = `Launch brief. ${'Details about the launch plan. '.repeat(1200)}`;
  await request(harness.app).post(`/api/assistant/chats/${chatId}/messages`).set('Authorization', `Bearer ${harness.token}`)
    .send({ attachments: [{ mimeType: 'text/plain', name: 'brief.txt', size: brief.length, text: brief }], message: 'Read this brief and check the project.' });
  await waitForTurn(harness.app, harness.token, chatId);

  // Turn two carries turn one whole: the message, the overview call and its result, the reply.
  await runChatTurn(harness.app, harness.token, { chatId, message: 'What is the status of Routing?' });
  const second = scripted.calls.responses[2];
  assert.deepEqual(second.input.map((item) => item.role ?? item.type), ['developer', 'user', 'function_call', 'function_call_output', 'assistant', 'developer', 'user']);
  assert.match(second.input[1].content, /Launch brief/);
  assert.equal(second.input[2].name, 'odin_project_overview');
  assert.match(second.input[3].output, /Launch Readiness/);

  // Turn three would pass the budget: the brief's turn is condensed, the newest turn stays whole.
  const third = await runChatTurn(harness.app, harness.token, { chatId, message: 'And now?' });
  const [summaryRequest, answerRequest] = scripted.calls.responses.slice(3);
  assert.equal(summaryRequest.stream, undefined);
  assert.match(summaryRequest.instructions, /condense the earlier part of a conversation/);
  assert.match(summaryRequest.input.at(-1).content, /^The conversation to condense:\n\nUser: Read this brief[\s\S]*\[tool call odin_project_overview/);
  assert.doesNotMatch(summaryRequest.input.at(-1).content, /Turn notes/);
  assert.deepEqual(answerRequest.input.map((item) => item.role ?? item.type), ['developer', 'developer', 'user', 'assistant', 'developer', 'user']);
  assert.match(answerRequest.input[0].content, /^Summary of the earlier conversation[\s\S]*long launch brief/);
  assert.match(answerRequest.input[1].content, /^# Turn notes/);
  assert.equal(answerRequest.input[2].content, 'What is the status of Routing?');
  assert.equal(third.messages.at(-1).activity[0].label, 'Condensed 1 earlier turn of the conversation');
  assert.equal(third.messages.at(-1).content, 'Still in progress.');
});

test('odin_query answers across the project through the user\'s own access, relations included', async (context) => {
  const scripted = scriptedOpenAi({ steps: [
    { calls: [{ args: { sql: "SELECT b.name AS blocker, x.name AS blocked, b.assignee FROM relations r JOIN items b ON b.id = r.from_id JOIN items x ON x.id = r.to_id WHERE r.type = 'blocks'" }, name: 'odin_query' }] },
    { text: 'Routing blocks Rules.' },
  ] });
  const harness = await createChatTestApp(scripted);
  context.after(harness.close);
  const auth = (token) => ({ Authorization: `Bearer ${token}` });
  const linked = await request(harness.app).post('/api/projects/project-launch/items/story-routing/relations').set(auth(harness.token)).send({ relationType: 'blocks', toItemId: 'task-rules' });
  assert.equal(linked.status, 201, JSON.stringify(linked.body));
  const relations = await request(harness.app).get('/api/projects/project-launch/relations').set(auth(harness.token));
  assert.deepEqual(relations.body.relations.map(({ fromItemId, relationType, toItemId }) => [fromItemId, relationType, toItemId]), [['story-routing', 'blocks', 'task-rules']]);
  assert.equal((await request(harness.app).get('/api/projects/project-launch/relations').set(auth(harness.hedyToken))).status, 404);

  const chat = await runChatTurn(harness.app, harness.token, { message: 'What is blocking what?', projectId: 'project-launch' });
  assert.deepEqual(chat.messages.at(-1).activity.map((entry) => entry.label), ['Ran a query (1 row)']);
  const output = JSON.parse(scripted.calls.responses[1].input.find((item) => item.type === 'function_call_output').output);
  assert.deepEqual(output.rows, [['Routing', 'Rules', 'Ada Lovelace']]);
  assert.ok(scripted.calls.responses[0].tools.some((tool) => tool.name === 'odin_query'));
});

test('a query on a guessed column gives the model the real columns, the person a short note, and the log the full error', async (context) => {
  const sql = 'SELECT name, target_hours FROM items';
  const scripted = scriptedOpenAi({ steps: [
    { calls: [{ args: { sql }, name: 'odin_query' }] },
    { calls: [{ args: { sql: 'SELECT name, estimate_hours FROM items' }, name: 'odin_query' }] },
    { text: 'Rules has no estimate.' },
  ] });
  const harness = await createChatTestApp(scripted);
  context.after(harness.close);
  const warn = context.mock.method(console, 'warn', () => {});
  const chat = await runChatTurn(harness.app, harness.token, { message: 'How many hours is each item estimated at?', projectId: 'project-launch' });
  const [failed, retried] = chat.messages.at(-1).activity;
  assert.deepEqual([failed.label, failed.ok, failed.error], ['Run a query', false, 'The query returned an error, so the assistant will retry it.']);
  assert.match(retried.label, /^Ran a query \(\d+ rows?\)$/);
  const output = JSON.parse(scripted.calls.responses[1].input.find((item) => item.type === 'function_call_output').output);
  assert.match(output.error.message, /no such column: target_hours\. Tables: items\(id, .*estimate_hours/);
  const logged = warn.mock.calls.find((call) => call.arguments[0] === 'Assistant tool failed.')?.arguments[1];
  assert.equal(logged.chatId, chat.id);
  assert.equal(logged.name, 'odin_query');
  assert.equal(logged.sql, sql);
  assert.match(logged.error, /no such column: target_hours/);
});

test('a reply\'s changes can be undone; anything changed since is left alone and said so', async (context) => {
  const scripted = scriptedOpenAi({ steps: [
    { calls: [{ args: { items: [{ name: 'Write the launch FAQ', points: 2 }], parentId: 'story-routing', projectId: 'project-launch' }, name: 'odin_create_plan_items' }] },
    { calls: [{ args: { projectId: 'project-launch', updates: [{ itemId: 'task-rules', patch: { points: 5, status: 'Blocked' } }, { itemId: 'story-routing', patch: { name: 'Routing v2' } }] }, name: 'odin_update_items' }] },
    { calls: [{ args: { input: { comment: 'Re-planned routing.', targetId: 'story-routing', targetType: 'story' }, projectId: 'project-launch' }, name: 'odin_add_comment' }] },
    { text: 'Added the FAQ task, blocked Rules and renamed Routing.' },
  ] });
  const harness = await createChatTestApp(scripted);
  context.after(harness.close);
  const chat = await runChatTurn(harness.app, harness.token, { message: 'Add an FAQ task, block Rules at 5 points, rename Routing to Routing v2 and leave a note.', projectId: 'project-launch' });
  const reply = chat.messages.at(-1);
  assert.deepEqual(reply.changes.records.map((record) => [record.label, record.undoable, record.status]), [
    ['Created task "Write the launch FAQ"', true, 'applied'],
    ['Updated "Rules": status, points', true, 'applied'],
    ['Updated "Routing": name', true, 'applied'],
    ['Added a comment', true, 'applied'],
  ]);
  assert.equal(reply.changes.versions, undefined, 'the undo details stay on the server');

  // Someone renames the story again after the turn: that change is kept.
  const before = await loadProject(harness.app, harness.token);
  const story = before.epics[0].stories[0];
  const renamed = await request(harness.app).patch(`/api/projects/project-launch/items/${story.id}`).set('Authorization', `Bearer ${harness.token}`).send({ expectedVersion: Number(story.version), patch: { name: 'Routing (final)' } });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));

  const undone = await request(harness.app).post(`/api/assistant/chats/${chat.id}/messages/${reply.id}/undo`).set('Authorization', `Bearer ${harness.token}`);
  assert.equal(undone.status, 200, JSON.stringify(undone.body));
  const records = undone.body.chat.messages.find((message) => message.id === reply.id).changes.records;
  assert.deepEqual(records.map((record) => [record.label, record.status]), [
    ['Created task "Write the launch FAQ"', 'undone'],
    ['Updated "Rules": status, points', 'undone'],
    ['Updated "Routing": name', 'kept'],
    ['Added a comment', 'undone'],
  ]);
  assert.match(records[2].note, /Changed since/);
  assert.match(undone.body.chat.messages.at(-1).content, /^Undid 3 changes; left 1 that changed since\.\n\n- Created task "Write the launch FAQ"\n- Updated "Rules": status, points\n- Added a comment$/);

  const after = await loadProject(harness.app, harness.token);
  const routing = after.epics[0].stories[0];
  assert.equal(routing.name, 'Routing (final)', 'the later edit stays');
  assert.ok(!routing.tasks.some((task) => task.name === 'Write the launch FAQ'), 'the created task is removed; only its parent was edited since');
  const rules = routing.tasks.find((task) => task.id === 'task-rules');
  assert.deepEqual([rules.status, rules.points], ['In Progress', 3]);
  const comments = await request(harness.app).get('/api/projects/project-launch/comments').query({ targetId: 'story-routing', targetType: 'story' }).set('Authorization', `Bearer ${harness.token}`);
  assert.equal(comments.body.comments.length, 0);
  assert.equal((await request(harness.app).post(`/api/assistant/chats/${chat.id}/messages/${reply.id}/undo`).set('Authorization', `Bearer ${harness.token}`)).status, 409);
  assert.equal((await request(harness.app).post(`/api/assistant/chats/${chat.id}/messages/${reply.id}/undo`).set('Authorization', `Bearer ${harness.hedyToken}`)).status, 404);
});

test('undos of two replies run independently, and neither overwrites the other', async (context) => {
  const scripted = scriptedOpenAi({ steps: [
    { calls: [{ args: { items: [{ name: 'Draft the press note', points: 1 }], parentId: 'story-routing', projectId: 'project-launch' }, name: 'odin_create_plan_items' }] },
    { text: 'Added the press note task.' },
    { calls: [{ args: { items: [{ name: 'Book the venue', points: 2 }], parentId: 'story-routing', projectId: 'project-launch' }, name: 'odin_create_plan_items' }] },
    { text: 'Added the venue task.' },
  ] });
  const harness = await createChatTestApp(scripted);
  context.after(harness.close);
  const first = await runChatTurn(harness.app, harness.token, { message: 'Add a task to draft the press note.', projectId: 'project-launch' });
  const second = await runChatTurn(harness.app, harness.token, { chatId: first.id, message: 'And one to book the venue.' });
  const replies = second.messages.filter((message) => message.changes);
  assert.equal(replies.length, 2);

  const undo = (reply) => request(harness.app).post(`/api/assistant/chats/${first.id}/messages/${reply.id}/undo`).set('Authorization', `Bearer ${harness.token}`);
  const results = await Promise.all(replies.map(undo));
  assert.deepEqual(results.map((result) => result.status), [200, 200], JSON.stringify(results.map((result) => result.body)));
  const chat = (await request(harness.app).get(`/api/assistant/chats/${first.id}`).set('Authorization', `Bearer ${harness.token}`)).body.chat;
  assert.deepEqual(replies.map((reply) => chat.messages.find((message) => message.id === reply.id).changes.status), ['undone', 'undone']);
  assert.deepEqual(chat.messages.filter((message) => message.undoOf).map((message) => message.undoOf).sort(), replies.map((reply) => reply.id).sort());
  const tasks = (await loadProject(harness.app, harness.token)).epics[0].stories[0].tasks.map((task) => task.name);
  assert.ok(!tasks.includes('Draft the press note') && !tasks.includes('Book the venue'));
});

test('"undo that" in chat reverses the last reply\'s changes, and the undo is itself recorded', async (context) => {
  const scripted = scriptedOpenAi({ steps: [
    { calls: [{ args: { items: [{ name: 'Draft the press note', points: 1 }], parentId: 'story-routing', projectId: 'project-launch' }, name: 'odin_create_plan_items' }] },
    { text: 'Added the press note task.' },
    { calls: [{ args: {}, name: 'odin_undo_turn' }] },
    { text: 'Undone: the press note task is gone.' },
  ] });
  const harness = await createChatTestApp(scripted);
  context.after(harness.close);
  const first = await runChatTurn(harness.app, harness.token, { message: 'Add a task to draft the press note.', projectId: 'project-launch' });
  assert.ok((await loadProject(harness.app, harness.token)).epics[0].stories[0].tasks.some((task) => task.name === 'Draft the press note'));
  const second = await runChatTurn(harness.app, harness.token, { chatId: first.id, message: 'Actually, undo that.' });
  assert.ok(!(await loadProject(harness.app, harness.token)).epics[0].stories[0].tasks.some((task) => task.name === 'Draft the press note'));
  assert.equal(second.messages.find((message) => message.id === first.messages.at(-1).id).changes.status, 'undone');
  const output = JSON.parse(scripted.calls.responses[3].input.find((item) => item.type === 'function_call_output' && item.call_id === scripted.calls.responses[3].input.filter((entry) => entry.type === 'function_call').at(-1).call_id).output);
  assert.equal(output.summary, 'Undid 1 change.');
  assert.deepEqual(second.messages.at(-1).changes.records.map((record) => [record.label, record.undoable]), [['Deleted task "Draft the press note"', false]]);
});

test('"undo that" after a reply whose changes can\'t be undone says so, and leaves the reply before it alone', async (context) => {
  const scripted = scriptedOpenAi({ steps: [
    { calls: [{ args: { items: [{ name: 'Draft the press note', points: 1 }], parentId: 'story-routing', projectId: 'project-launch' }, name: 'odin_create_plan_items' }] },
    { text: 'Added the press note task.' },
    { calls: [{ args: { input: { name: 'Press tour', status: 'Planned' } }, name: 'odin_create_project' }] },
    { text: 'Created the Press tour project.' },
    { calls: [{ args: {}, name: 'odin_undo_turn' }] },
    { text: 'That project can\'t be undone here.' },
  ] });
  const harness = await createChatTestApp(scripted);
  context.after(harness.close);
  const first = await runChatTurn(harness.app, harness.token, { message: 'Add a task to draft the press note.', projectId: 'project-launch' });
  const second = await runChatTurn(harness.app, harness.token, { chatId: first.id, message: 'Also start a Press tour project.' });
  assert.deepEqual(second.messages.at(-1).changes.records.map((record) => [record.label, record.undoable]), [['Created project "Press tour"', false]]);
  await runChatTurn(harness.app, harness.token, { chatId: first.id, message: 'Undo that.' });
  assert.ok((await loadProject(harness.app, harness.token)).epics[0].stories[0].tasks.some((task) => task.name === 'Draft the press note'), 'the earlier reply stays');
  const response = scripted.calls.responses[5];
  const call = response.input.filter((entry) => entry.type === 'function_call').at(-1);
  const output = JSON.parse(response.input.find((item) => item.type === 'function_call_output' && item.call_id === call.call_id).output);
  assert.equal(output.error.code, 'not_undoable');
  assert.match(output.error.message, /Created project "Press tour"/);
});

// Chat titles: once the first request has its answer, a small model names the chat from the two.

test('the first reply names the chat with gpt-6-luna at low effort, from the request and the reply', async (context) => {
  const scripted = scriptedOpenAi({ steps: [{ text: 'One epic, Launch, with one story in progress.' }, { text: 'Rules is the only task.' }], title: '"Launch Readiness project summary."' });
  const harness = await createChatTestApp(scripted);
  context.after(harness.close);
  const created = await request(harness.app).post('/api/assistant/chats').set('Authorization', `Bearer ${harness.token}`).send({ projectId: 'project-launch' });
  const events = [];
  harness.liveEventBus.subscribe(LIVE_EVENT_CHANNELS.session(created.body.chat.id), (event) => events.push(event));

  const first = await runChatTurn(harness.app, harness.token, { chatId: created.body.chat.id, message: 'Summarize the project please.' });
  const named = await waitForChat(harness.app, harness.token, first.id, (chat) => chat.title !== 'Summarize the project please');
  assert.equal(named.title, 'Launch Readiness project summary');
  assert.equal(named.updatedAt, first.updatedAt, 'naming is not activity');
  assert.equal(scripted.calls.titles.length, 1);
  const [call] = scripted.calls.titles;
  assert.equal(call.model, 'gpt-6-luna');
  assert.deepEqual(call.reasoning, { effort: 'low' });
  assert.equal(call.store, false);
  assert.equal(call.input[0].content, 'Request:\nSummarize the project please.\n\nReply:\nOne epic, Launch, with one story in progress.');
  assert.deepEqual(events.find((event) => event.type === 'chat.renamed')?.payload, { chatId: first.id, title: 'Launch Readiness project summary' });
  const listed = await request(harness.app).get('/api/assistant/chats').set('Authorization', `Bearer ${harness.token}`);
  assert.equal(listed.body.projects[0].chats[0].title, 'Launch Readiness project summary');
  assert.ok(listed.body.projects[0].chats[0].createdAt, 'the list says when the chat was opened');

  // Later replies leave the name alone.
  await runChatTurn(harness.app, harness.token, { chatId: first.id, message: 'And the tasks?' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(scripted.calls.titles.length, 1);
  assert.equal((await waitForTurn(harness.app, harness.token, first.id)).title, 'Launch Readiness project summary');
});

test('a rename while the name is being written wins, and a failed name keeps the one from the request', async (context) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const scripted = scriptedOpenAi({ steps: [{ text: 'One epic.' }], title: async () => { await held; return 'Generated name'; } });
  const harness = await createChatTestApp(scripted);
  context.after(harness.close);
  const chat = await runChatTurn(harness.app, harness.token, { message: 'Summarize the project please.', projectId: 'project-launch' });
  const renamed = await request(harness.app).patch(`/api/assistant/chats/${chat.id}`).set('Authorization', `Bearer ${harness.token}`).send({ title: 'My launch notes' });
  assert.equal(renamed.status, 200);
  release();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(scripted.calls.titles.length, 1);
  assert.equal((await waitForTurn(harness.app, harness.token, chat.id)).title, 'My launch notes');

  const failing = scriptedOpenAi({ steps: [{ text: 'One epic.' }], title: async () => { throw new Error('model unavailable'); } });
  const other = await createChatTestApp(failing);
  context.after(other.close);
  const kept = await runChatTurn(other.app, other.token, { message: 'Summarize the project please.', projectId: 'project-launch' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(failing.calls.titles.length, 1);
  assert.equal((await waitForTurn(other.app, other.token, kept.id)).title, 'Summarize the project please');
});

test('a first turn that waits for a confirmation is named once it is answered', async (context) => {
  const scripted = scriptedOpenAi({ steps: [
    { calls: [{ args: { args: { itemId: 'task-rules', projectId: 'project-launch' }, operation: 'odin_delete_item' }, name: 'odin_run' }] },
    { text: 'Deleted Rules.' },
  ], title: (params) => (params.input[0].content.includes('Deleted Rules.') ? 'Delete the Rules task' : 'Too early') });
  const harness = await createChatTestApp(scripted);
  context.after(harness.close);
  const paused = await runChatTurn(harness.app, harness.token, { message: 'Delete the Rules task.', projectId: 'project-launch' });
  assert.equal(paused.run.status, 'awaiting_confirmation');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(scripted.calls.titles.length, 0, 'not named while waiting');
  await request(harness.app).post(`/api/assistant/chats/${paused.id}/confirmation`).set('Authorization', `Bearer ${harness.token}`).send({ callId: paused.pending.callId, decision: 'approve' });
  await waitForTurn(harness.app, harness.token, paused.id);
  assert.equal((await waitForChat(harness.app, harness.token, paused.id, (chat) => chat.title === 'Delete the Rules task')).title, 'Delete the Rules task');
});

test('naming can be turned off', async (context) => {
  const scripted = scriptedOpenAi({ steps: [{ text: 'One epic.' }] });
  const harness = await createChatTestApp(scripted, { chatTitles: false });
  context.after(harness.close);
  const chat = await runChatTurn(harness.app, harness.token, { message: 'Summarize the project please.', projectId: 'project-launch' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(scripted.calls.titles.length, 0);
  assert.equal(chat.title, 'Summarize the project please');
});
