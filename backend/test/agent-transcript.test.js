import assert from 'node:assert/strict';
import test from 'node:test';

import { compactTranscript, emptyTranscript, estimateTokens, keptItems, planCompaction, reconcileTranscript, transcriptInput, turnsFromMessages } from '../src/lib/agent/agent-transcript.js';

const call = (id, name = 'odin_find_items') => ({ arguments: '{"text":"seo"}', call_id: id, id: `fc_${id}`, name, status: 'completed', type: 'function_call' });
const output = (id, text = '{"ok":true,"total":3}') => ({ call_id: id, output: text, type: 'function_call_output' });

test('a turn keeps its messages, tool calls and results, but not reasoning, notes or half pairs', () => {
  const kept = keptItems([
    { content: [{ text: 'Show the SEO work', type: 'input_text' }, { image_url: 'data:image/png;base64,AAAA', type: 'input_image' }], role: 'user' },
    { encrypted_content: 'secret', id: 'rs_1', type: 'reasoning' },
    call('a'), output('a'),
    { content: 'Tool budget: 20 of 40 calls used.', role: 'developer' },
    call('b', 'odin_delete_item'),
    { content: [{ text: 'Three SEO items.', type: 'output_text' }], id: 'msg_1', role: 'assistant', type: 'message' },
    { action: { query: 'seo' }, id: 'ws_1', type: 'web_search_call' },
  ]);
  assert.deepEqual(kept, [
    { content: 'Show the SEO work\n[image]', role: 'user' },
    { arguments: '{"text":"seo"}', call_id: 'a', name: 'odin_find_items', type: 'function_call' },
    { call_id: 'a', output: '{"ok":true,"total":3}', type: 'function_call_output' },
    { content: 'Three SEO items.', role: 'assistant' },
  ]);
});

test('messages the transcript has not seen join it as text turns, once', () => {
  const messages = [
    { content: 'Hi', id: 'u1', role: 'user' },
    { content: 'Hello.', id: 'a1', role: 'assistant' },
    { attachments: [{ mimeType: 'image/png', name: 'board.png' }], content: 'Look at this', id: 'u2', role: 'user' },
    { content: '', error: 'The model timed out.', id: 'a2', role: 'assistant' },
  ];
  assert.deepEqual(turnsFromMessages(messages).map((turn) => [turn.id, turn.items.map((item) => item.content)]), [
    ['a1', ['Hi', 'Hello.']],
    ['a2', ['Look at this\n\n[Attached image "board.png"]', '(The previous answer failed: The model timed out.)']],
  ]);
  const caughtUp = reconcileTranscript(emptyTranscript(), messages);
  assert.equal(caughtUp.coveredThrough, 'a2');
  assert.deepEqual(reconcileTranscript(caughtUp, messages), caughtUp, 'nothing is added twice');
  const later = reconcileTranscript(caughtUp, [...messages, { content: 'Next', id: 'u3', role: 'user' }, { content: 'Sure.', id: 'a3', role: 'assistant' }]);
  assert.equal(later.turns.length, 3);
});

test('compaction waits for the budget, keeps recent turns whole and 32 messages of text, and condenses the rest', () => {
  const big = (index) => ({ id: `t${index}`, items: [{ content: `Question ${index}`, role: 'user' }, call(`c${index}`), output(`c${index}`, 'x'.repeat(3500)), { content: `Answer ${index}`, role: 'assistant' }] });
  const transcript = { coveredThrough: 't59', summary: null, turns: Array.from({ length: 60 }, (_, index) => big(index)) };
  assert.equal(planCompaction(transcript, { budgetTokens: 1_000_000 }), null, 'under the budget nothing happens');

  const plan = planCompaction(transcript, { budgetTokens: 20000, reserveTokens: 2000 });
  const whole = plan.keep.filter((turn) => turn.items.some((item) => item.type));
  const slim = plan.keep.filter((turn) => !turn.items.some((item) => item.type));
  assert.ok(estimateTokens(whole.flatMap((turn) => turn.items)) <= 8000, 'whole turns fit in 40% of the budget');
  assert.equal(whole.at(-1).id, 't59', 'the newest turn stays whole');
  assert.ok(slim.length + whole.length >= 16, 'at least 32 messages are kept');
  assert.equal(plan.condense.length + plan.keep.length, 60);
  assert.equal(plan.condense.at(-1).id, `t${59 - plan.keep.length}`, 'only the oldest turns are condensed');
});

test('a condensed conversation starts with its summary and keeps the turns after it', async () => {
  const requests = [];
  const client = { responses: { async create(params) { requests.push(params); return { output_text: '- Matt owns the SEO epic (epic-7).', usage: { input_tokens: 900, output_tokens: 40 } }; } } };
  const transcript = { coveredThrough: 't2', summary: { condensedTurns: 4, text: 'Earlier: the project started in May.' }, turns: [{ id: 't1', items: [{ content: 'Who owns SEO?', role: 'user' }, call('a'), output('a'), { content: 'Matt.', role: 'assistant' }] }, { id: 't2', items: [{ content: 'Thanks', role: 'user' }] }] };
  const plan = { condense: [transcript.turns[0]], keep: [transcript.turns[1]] };
  const { transcript: next } = await compactTranscript({ cache: { key: 'odin-k', retention: '24h' }, client, model: 'gpt-6-luna', plan, transcript });
  assert.equal(next.summary.text, '- Matt owns the SEO epic (epic-7).');
  assert.equal(next.summary.condensedTurns, 5);
  assert.match(requests[0].input[0].content, /the project started in May/);
  assert.match(requests[0].input[1].content, /User: Who owns SEO\?\n\[tool call odin_find_items/);
  assert.equal(requests[0].prompt_cache_key, 'odin-k');
  assert.deepEqual(transcriptInput(next).map((item) => item.role ?? item.type), ['developer', 'user']);
  assert.match(transcriptInput(next)[0].content, /^Summary of the earlier conversation/);
});
