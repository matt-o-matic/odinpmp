import assert from 'node:assert/strict';
import test from 'node:test';

import { applyLiveEvent, createAssistantStore } from '../src/lib/assistant/assistant-store.js';

function chatRecord(overrides = {}) {
  return { id: 'chat-1', messages: [], pending: null, projectId: 'project-1', run: null, settings: { allowWebResearch: true }, title: 'New chat', ...overrides };
}

// A fake API that records calls and lets a test push chat events.
function fakeApi(overrides = {}) {
  const calls = [];
  const handlers = {};
  const api = {
    calls,
    emit(chatId, type, data) { handlers[chatId]?.onEvent({ data, type }); },
    async listAssistantChats() { calls.push(['list']); return { general: [], projects: [{ chats: [{ id: 'chat-old', title: 'Older' }], projectId: 'project-1', projectName: 'Shop' }], projectsAvailable: [] }; },
    async createAssistantChat(payload) { calls.push(['create', payload]); return { chat: chatRecord({ projectId: payload.projectId }) }; },
    async getAssistantChat(chatId) { calls.push(['get', chatId]); return { chat: chatRecord({ id: chatId }) }; },
    async sendAssistantMessage(chatId, payload) {
      calls.push(['send', chatId, payload]);
      return { chat: chatRecord({ id: chatId, messages: [{ content: payload.message, id: 'm-1', role: 'user' }], run: { id: 'run-1', status: 'running' } }) };
    },
    async confirmAssistantAction(chatId, payload) { calls.push(['confirm', chatId, payload]); return { chat: chatRecord({ id: chatId, run: { id: 'run-2', status: 'running' } }) }; },
    async resolveAssistantProposal(chatId, payload) { calls.push(['proposal', chatId, payload]); return { chat: chatRecord({ id: chatId, title: 'Applied' }) }; },
    async undoAssistantChanges(chatId, messageId) { calls.push(['undo', chatId, messageId]); return { chat: chatRecord({ id: chatId, title: 'Undone' }) }; },
    subscribeToAssistantChatEvents(chatId, _token, handlersForChat) { handlers[chatId] = handlersForChat; calls.push(['subscribe', chatId]); return () => { delete handlers[chatId]; }; },
    subscribeToAssistantChatsEvents() { return () => {}; },
    ...overrides,
  };
  return api;
}

const createStore = (api) => createAssistantStore({ apiClient: api, authSession: { state: { token: 'token' } } });

test('live events build the in-progress reply: text, tools, plan and a reset', () => {
  let live = applyLiveEvent(null, 'assistant.delta', { delta: 'Hel' });
  live = applyLiveEvent(live, 'assistant.delta', { delta: 'lo' });
  live = applyLiveEvent(live, 'tool.started', { callId: 'c1', label: 'Searching', name: 'odin_find_items' });
  live = applyLiveEvent(live, 'tool.completed', { callId: 'c1', label: 'Found 3 items', name: 'odin_find_items', ok: true });
  live = applyLiveEvent(live, 'plan.updated', { budget: { pool: 80, used: 1 }, steps: [{ status: 'in_progress', title: 'Read' }] });
  assert.equal(live.text, 'Hello');
  assert.deepEqual(live.activity.map((entry) => [entry.label, entry.status]), [['Found 3 items', 'done']]);
  assert.equal(live.plan[0].title, 'Read');
  assert.equal(live.budget.pool, 80);
  assert.equal(applyLiveEvent(live, 'assistant.reset', {}).text, '');
});

test('the first message in a draft creates the chat, streams, and lands the finished chat', async () => {
  const api = fakeApi();
  const store = createStore(api);
  store.show();
  store.startDraft({ projectId: 'project-1' });
  const sending = store.send({ message: 'Summarize the project', pageContext: { view: 'project Insights' } });
  await sending;
  assert.deepEqual(api.calls.filter(([kind]) => ['create', 'send'].includes(kind)).map(([kind, ...rest]) => [kind, rest.at(-1)]), [
    ['create', { projectId: 'project-1' }],
    ['send', { allowWebResearch: true, attachments: [], message: 'Summarize the project', pageContext: { view: 'project Insights' } }],
  ]);
  assert.ok(store.state.live, 'the turn is live');

  api.emit('chat-1', 'assistant.delta', { delta: 'Shop is on track.' });
  assert.equal(store.state.live.text, 'Shop is on track.');
  api.emit('chat-1', 'turn.completed', { chat: chatRecord({ messages: [{ id: 'm-1', role: 'user' }, { content: 'Shop is on track.', id: 'm-2', role: 'assistant' }], run: { id: 'run-1', status: 'completed' } }) });
  assert.equal(store.state.live, null);
  assert.equal(store.state.chat.messages.at(-1).content, 'Shop is on track.');
  assert.equal(store.state.sending, false);
});

test('a reply that finishes before the send request returns is not reopened', async () => {
  let release;
  const api = fakeApi({
    async sendAssistantMessage(chatId, payload) {
      await new Promise((resolve) => { release = resolve; });
      return { chat: chatRecord({ id: chatId, messages: [{ content: payload.message, id: 'm-1', role: 'user' }], run: { id: 'run-1', status: 'running' } }) };
    },
  });
  const store = createStore(api);
  store.show();
  await store.openChat('chat-1');
  const sending = store.send({ message: 'Hi' });
  await new Promise((resolve) => setImmediate(resolve));
  api.emit('chat-1', 'turn.completed', { chat: chatRecord({ messages: [{ id: 'm-1', role: 'user' }, { content: 'Hello!', id: 'm-2', role: 'assistant' }], run: { id: 'run-1', status: 'completed' } }) });
  release();
  await sending;
  assert.equal(store.state.live, null);
  assert.equal(store.state.chat.run.status, 'completed');
  assert.equal(store.state.chat.messages.at(-1).content, 'Hello!');
});

test('opening the assistant on a project reuses its latest chat unless asked for a fresh one', async () => {
  const api = fakeApi();
  const store = createStore(api);
  await store.openForProject({ projectId: 'project-1' });
  assert.equal(store.state.chat.id, 'chat-old');
  await store.openForProject({ fresh: true, projectId: 'project-1' });
  assert.equal(store.state.chat.draft, true);
  assert.equal(store.state.chat.projectId, 'project-1');
  assert.equal(api.calls.some(([kind]) => kind === 'create'), false, 'nothing is created until the first message');
});

test('a draft can move to another project, or none, until its first message', async () => {
  const api = fakeApi();
  const store = createStore(api);
  store.show();
  store.startDraft({ projectId: 'project-1' });
  await store.setWebResearch(false);
  store.setDraftProject('project-2');
  assert.equal(store.state.chat.projectId, 'project-2');
  assert.equal(store.state.chat.settings.allowWebResearch, false, 'its settings carry over');
  store.setDraftProject(null);
  await store.send({ message: 'What is overdue?' });
  assert.deepEqual(api.calls.find(([kind]) => kind === 'create'), ['create', { projectId: null }]);
  const created = store.state.chat;
  store.setDraftProject('project-2');
  assert.equal(store.state.chat, created, 'a created chat keeps its project');
});

test('a confirmation and a proposal decision go to the server and update the chat', async () => {
  const api = fakeApi({ async getAssistantChat(chatId) { return { chat: chatRecord({ id: chatId, pending: { callId: 'call-9', name: 'odin_delete_item' } }) }; } });
  const store = createStore(api);
  store.show();
  await store.openChat('chat-1');
  await store.confirm('approve', { view: 'the project plan' });
  assert.deepEqual(api.calls.find(([kind]) => kind === 'confirm'), ['confirm', 'chat-1', { callId: 'call-9', decision: 'approve', pageContext: { view: 'the project plan' } }]);
  assert.ok(store.state.live);

  await store.resolveProposal({ decision: 'apply', itemIds: ['item-1'], proposalId: 'proposal-1' });
  assert.deepEqual(api.calls.find(([kind]) => kind === 'proposal'), ['proposal', 'chat-1', { decision: 'apply', itemIds: ['item-1'], proposalId: 'proposal-1' }]);
  assert.equal(store.state.chat.title, 'Applied');

  await store.undoChanges('reply-7');
  assert.deepEqual(api.calls.find(([kind]) => kind === 'undo'), ['undo', 'chat-1', 'reply-7']);
  assert.equal(store.state.chat.title, 'Undone');
});

test('a failed send takes the message back and shows the error', async () => {
  const api = fakeApi({ async sendAssistantMessage() { throw new Error('The assistant is not configured.'); } });
  const store = createStore(api);
  await store.openChat('chat-1');
  await assert.rejects(store.send({ message: 'Hi' }));
  assert.equal(store.state.chat.messages.length, 0);
  assert.equal(store.state.live, null);
  assert.equal(store.state.errorMessage, 'The assistant is not configured.');
});

test('live events track what the assistant is doing for the working indicator', () => {
  let live = applyLiveEvent(null, 'tool.started', { callId: 'a', label: 'Searching work items' }, 10);
  live = applyLiveEvent(live, 'tool.started', { callId: 'b', label: 'Reading governance' }, 11);
  assert.deepEqual([live.phase, live.phaseAt], ['tool', 11]);
  live = applyLiveEvent(live, 'tool.completed', { callId: 'a', label: 'Found 3 items', ok: true }, 12);
  assert.equal(live.phase, 'tool', 'another tool is still running');
  live = applyLiveEvent(live, 'tool.completed', { callId: 'b', label: 'Read governance', ok: true }, 13);
  assert.equal(live.phase, 'thinking');
  live = applyLiveEvent(live, 'assistant.delta', { delta: 'Done' }, 14);
  assert.deepEqual([live.phase, live.phaseAt], ['writing', 14]);
});

test('the workspace layout is remembered, and only known layouts are accepted', () => {
  const saved = new Map([['odin.assistant.layout', 'docked']]);
  const storage = { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  const store = createAssistantStore({ apiClient: fakeApi(), authSession: { state: { token: 'token' } }, storage });
  assert.equal(store.state.layout, 'docked');
  store.setLayout('maximized');
  assert.equal(saved.get('odin.assistant.layout'), 'maximized');
  store.setLayout('sideways');
  assert.equal(store.state.layout, 'maximized');
  assert.equal(createAssistantStore({ apiClient: fakeApi(), authSession: { state: { token: 'token' } }, storage: null }).state.layout, 'window');
});

test('a chat named after its first reply, or renamed from the list, shows the new name', async () => {
  const api = fakeApi({
    async updateAssistantChat(chatId, payload) { api.calls.push(['update', chatId, payload]); return { chat: chatRecord({ id: chatId, title: payload.title }) }; },
  });
  const store = createStore(api);
  store.show();
  await store.openForProject({ projectId: 'project-1' });
  api.emit('chat-old', 'chat.renamed', { chatId: 'chat-old', title: 'Launch summary' });
  assert.equal(store.state.chat.title, 'Launch summary');

  // Renaming another chat from the list leaves the open one alone and shows the name at once.
  store.state.list.general = [{ id: 'chat-2', title: 'Old name' }];
  const renaming = store.rename('  New name ', 'chat-2');
  assert.equal(store.state.list.general[0].title, 'New name');
  await renaming;
  assert.deepEqual(api.calls.find(([kind]) => kind === 'update'), ['update', 'chat-2', { title: 'New name' }]);
  assert.equal(store.state.chat.title, 'Launch summary');
});
