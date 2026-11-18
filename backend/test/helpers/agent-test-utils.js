import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { CHAT_TITLE_INSTRUCTIONS } from '../../src/lib/agent/agent-chat-title.js';

// Test doubles for the assistant: a scripted OpenAI client (Responses streams and Decisions
// answers), a loopback server so tools reach the app's REST routes as they do in production,
// and a helper that runs one chat turn to completion.

function chunks(text, size = 12) {
  const parts = [];
  for (let index = 0; index < text.length; index += size) parts.push(text.slice(index, index + size));
  return parts;
}

function streamFor(step) {
  const output = [];
  if (step.text) output.push({ content: [{ annotations: [], text: step.text, type: 'output_text' }], role: 'assistant', type: 'message' });
  for (const call of step.calls ?? []) {
    output.push({ arguments: typeof call.args === 'string' ? call.args : JSON.stringify(call.args ?? {}), call_id: call.id ?? `call_${randomUUID()}`, name: call.name, type: 'function_call' });
  }
  return (async function* events() {
    if (step.error) throw step.error;
    for (const chunk of chunks(step.text ?? '')) yield { delta: chunk, type: 'response.output_text.delta' };
    for (const item of output) yield { item, type: 'response.output_item.done' };
    const usage = { input_tokens: 100, input_tokens_details: { cached_tokens: 80 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 5 } };
    if (step.incomplete) yield { response: { incomplete_details: { reason: step.incomplete }, output, usage }, type: 'response.incomplete' };
    else yield { response: { output, usage }, type: 'response.completed' };
  })();
}

export const DEFAULT_DECISION_PROBABILITIES = Object.freeze({
  can_continue: 0.05,
  change: 0.5,
  done: 0.95,
  multi_step: 0.1,
  research: 0.05,
  simple: 0.8,
  unverified_claim: 0.02,
});

// steps: one entry per model call, each { text?, calls?: [{ name, args }], error?, incomplete? }.
// decide(name, question, params): optional override returning a probability.
// title: what the chat-naming call answers (a function of its params, or text); it never takes a
// scripted step and is recorded in calls.titles, not calls.responses.
export function scriptedOpenAi({ decide = null, decisionsAvailable = true, steps = [], title = 'Scripted chat title' } = {}) {
  const queue = [...steps];
  const calls = { decisions: [], responses: [], titles: [] };
  const client = {
    responses: {
      async create(params) {
        if (params.instructions === CHAT_TITLE_INSTRUCTIONS) {
          calls.titles.push(JSON.parse(JSON.stringify(params)));
          return { output_text: typeof title === 'function' ? await title(params) : title };
        }
        calls.responses.push(JSON.parse(JSON.stringify(params)));
        // Requests without streaming (the conversation summary) get a plain response.
        if (!params.stream) return { output_text: (queue.shift() ?? { text: 'Summary.' }).text ?? '', usage: { input_tokens: 400, output_tokens: 30 } };
        return streamFor(queue.shift() ?? { text: 'Done.' });
      },
    },
  };
  if (decisionsAvailable) {
    client.decisions = {
      async create(params) {
        calls.decisions.push(JSON.parse(JSON.stringify(params)));
        return {
          answers: params.questions.map((question) => {
            const custom = decide?.(question.name, question, params);
            const probability = custom ?? DEFAULT_DECISION_PROBABILITIES[question.name] ?? (question.name.startsWith('write_') ? 0.95 : 0.1);
            return { name: question.name, probability, type: 'predicate' };
          }),
          model: 'gpt-6-luna',
          usage: { input_tokens: 50, output_tokens: 0, total_tokens: 50 },
        };
      },
    };
  }
  return { calls, client, remaining: () => queue.length };
}

// Deps for createApp that point the assistant at a scripted client and a loopback origin.
export function agentAppDeps(scripted, overrides = {}) {
  return {
    agentModelResolver: async () => ({ client: scripted.client, model: 'gpt-6-luna' }),
    assistantAgent: { decisionsTimeoutMs: 2000, ...overrides },
  };
}

export async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  server.unref();
  app.locals.agentApiOrigin = `http://127.0.0.1:${server.address().port}`;
  return { close: () => new Promise((resolve) => server.close(resolve)) };
}

export async function waitForTurn(app, token, chatId, { timeoutMs = 8000 } = {}) {
  const started = Date.now();
  for (;;) {
    const response = await request(app).get(`/api/assistant/chats/${chatId}`).set('Authorization', `Bearer ${token}`);
    if (response.status !== 200) throw new Error(`Chat read failed: ${response.status} ${JSON.stringify(response.body)}`);
    const status = response.body.chat.run?.status;
    if (status && status !== 'running' && !app.locals.assistantTurnQueue.has(chatId)) return response.body.chat;
    if (Date.now() - started > timeoutMs) throw new Error(`Turn did not finish: ${JSON.stringify(response.body.chat.run)}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

// Reads the chat until `ready(chat)` holds, for work that finishes after the turn (its title).
export async function waitForChat(app, token, chatId, ready, { timeoutMs = 4000 } = {}) {
  const started = Date.now();
  for (;;) {
    const response = await request(app).get(`/api/assistant/chats/${chatId}`).set('Authorization', `Bearer ${token}`);
    if (response.status !== 200) throw new Error(`Chat read failed: ${response.status} ${JSON.stringify(response.body)}`);
    if (ready(response.body.chat)) return response.body.chat;
    if (Date.now() - started > timeoutMs) throw new Error(`Chat never got there: ${JSON.stringify({ title: response.body.chat.title })}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

// Creates a chat (or reuses chatId) and runs one message through the assistant.
export async function runChatTurn(app, token, { chatId = null, message, pageContext, projectId = null }) {
  let id = chatId;
  if (!id) {
    const created = await request(app).post('/api/assistant/chats').set('Authorization', `Bearer ${token}`).send({ projectId });
    if (created.status !== 201) throw new Error(`Chat create failed: ${created.status} ${JSON.stringify(created.body)}`);
    id = created.body.chat.id;
  }
  const sent = await request(app).post(`/api/assistant/chats/${id}/messages`).set('Authorization', `Bearer ${token}`).send({ message, ...(pageContext ? { pageContext } : {}) });
  if (sent.status !== 202) throw new Error(`Message failed: ${sent.status} ${JSON.stringify(sent.body)}`);
  return waitForTurn(app, token, id);
}
