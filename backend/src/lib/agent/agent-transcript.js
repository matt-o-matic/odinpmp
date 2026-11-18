// A chat's transcript as the model sees it: each turn's user message, tool calls and results, and
// reply, kept verbatim so follow-ups can use what earlier turns read, and so the conversation is
// a prompt prefix that only grows (and stays cached). When the next request would pass the
// compaction budget (about 120k tokens), older turns are condensed into a summary:
// - the most recent turns stay whole, tool results included, up to 40% of the budget;
// - earlier turns keep just their messages until there are 32 of them (or 60% of the budget);
// - everything older goes into the summary, which is kept and reused until the next compaction.
// Each turn's notes are kept (a request that drops them shares no cached prefix past that point);
// reasoning items are not, and images are replaced by a placeholder.

import { mediaFreeText } from './agent-media.js';

const CHARS_PER_TOKEN = 3.5;
const FULL_SHARE = 0.4;
const TEXT_SHARE = 0.6;
const MIN_MESSAGES = 32;
const SUMMARY_OUTPUT_TOKENS = 12000;
const TOOL_EXCERPT_CHARS = 1500;

export const estimateTokens = (value) => Math.ceil((typeof value === 'string' ? value : JSON.stringify(value ?? '')).length / CHARS_PER_TOKEN);

export function emptyTranscript() {
  return { coveredThrough: null, summary: null, turns: [] };
}

function textOf(content) {
  return mediaFreeText(content ?? '');
}

const isRoleMessage = (item) => item.role === 'user' || item.role === 'assistant';

// The items worth keeping from one turn's input, in order, in the shape the API accepts back.
export function keptItems(items = []) {
  const kept = [];
  for (const item of items) {
    if (item.type === 'function_call') kept.push({ arguments: item.arguments ?? '{}', call_id: item.call_id, name: item.name, type: 'function_call' });
    else if (item.type === 'function_call_output') kept.push({ call_id: item.call_id, output: mediaFreeText(item.output), type: 'function_call_output' });
    else if (item.type === 'message' && item.role === 'assistant') { const text = textOf(item.content).trim(); if (text) kept.push({ content: text, role: 'assistant' }); }
    else if (isRoleMessage(item)) { const text = textOf(item.content).trim(); if (text) kept.push({ content: text, role: item.role }); }
  }
  // Calls need their output and outputs their call (a call paused for confirmation has none yet).
  const calls = new Set(kept.filter((item) => item.type === 'function_call').map((item) => item.call_id));
  const outputs = new Set(kept.filter((item) => item.type === 'function_call_output').map((item) => item.call_id));
  return kept.filter((item) => (item.type === 'function_call' ? outputs.has(item.call_id) : item.type === 'function_call_output' ? calls.has(item.call_id) : true));
}

// Chat messages the transcript has not seen (older chats, turns that failed or were superseded
// while waiting for confirmation), as text-only turns: each user message starts one.
export function turnsFromMessages(messages = []) {
  const turns = [];
  for (const message of messages) {
    let content = String(message.content ?? '');
    if (message.role === 'user') {
      for (const file of message.attachments ?? []) {
        content += file.text ? `\n\nAttached file "${file.name}":\n${file.text}` : `\n\n[Attached ${file.mimeType?.startsWith('image/') ? 'image' : 'file'} "${file.name}"]`;
      }
    }
    if (message.role === 'assistant' && message.error && !content) content = `(The previous answer failed: ${message.error})`;
    if (!content.trim()) continue;
    const item = { content, role: message.role === 'user' ? 'user' : 'assistant' };
    if (item.role === 'user' || !turns.length) turns.push({ id: message.id, items: [item] });
    else { turns.at(-1).items.push(item); turns.at(-1).id = message.id; }
  }
  return turns;
}

// Brings the transcript up to date with the chat's earlier messages (all but the newest).
export function reconcileTranscript(transcript, messages) {
  const next = { ...emptyTranscript(), ...transcript, turns: [...(transcript?.turns ?? [])] };
  const covered = next.coveredThrough ? messages.findIndex((message) => message.id === next.coveredThrough) : -1;
  if (next.coveredThrough && covered < 0) return next;
  const missing = turnsFromMessages(messages.slice(covered + 1));
  if (missing.length) {
    next.turns.push(...missing);
    next.coveredThrough = missing.at(-1).id;
  }
  return next;
}

export const SUMMARY_HEADING = 'Summary of the earlier conversation (older messages were condensed to save space):';

export function transcriptInput(transcript) {
  return [
    ...(transcript.summary ? [{ content: `${SUMMARY_HEADING}\n${transcript.summary.text}`, role: 'developer' }] : []),
    ...transcript.turns.flatMap((turn) => turn.items),
  ];
}

const textOnly = (turn) => ({ id: turn.id, items: turn.items.filter(isRoleMessage) });

// Whether the next request would pass the budget, and if so which turns to condense.
export function planCompaction(transcript, { budgetTokens, reserveTokens = 0 }) {
  const turns = transcript.turns;
  const sizes = turns.map((turn) => estimateTokens(turn.items));
  const total = reserveTokens + estimateTokens(transcript.summary?.text ?? '') + sizes.reduce((sum, size) => sum + size, 0);
  if (total <= budgetTokens) return null;
  let index = turns.length - 1;
  let used = 0;
  const keepFull = [];
  while (index >= 0 && (!keepFull.length || used + sizes[index] <= budgetTokens * FULL_SHARE)) {
    keepFull.unshift(turns[index]);
    used += sizes[index];
    index -= 1;
  }
  let messages = keepFull.reduce((count, turn) => count + turn.items.filter(isRoleMessage).length, 0);
  const keepText = [];
  while (index >= 0 && messages < MIN_MESSAGES) {
    const slim = textOnly(turns[index]);
    const size = estimateTokens(slim.items);
    if (used + size > budgetTokens * TEXT_SHARE) break;
    keepText.unshift(slim);
    used += size;
    messages += slim.items.length;
    index -= 1;
  }
  const condense = turns.slice(0, index + 1);
  return condense.length ? { condense, keep: [...keepText, ...keepFull], total } : null;
}

function renderTurns(turns) {
  return turns.map((turn) => turn.items.filter((item) => item.role !== 'developer').map((item) => {
    if (item.type === 'function_call') return `[tool call ${item.name} ${String(item.arguments).slice(0, 400)}]`;
    if (item.type === 'function_call_output') { const output = mediaFreeText(item.output); return `[tool result ${output.slice(0, TOOL_EXCERPT_CHARS)}${output.length > TOOL_EXCERPT_CHARS ? '…' : ''}]`; }
    return `${item.role === 'user' ? 'User' : 'Assistant'}: ${item.content}`;
  }).join('\n')).join('\n\n');
}

const SUMMARY_INSTRUCTIONS = `You condense the earlier part of a conversation between a user and Odin, the project assistant in OdinPMP, so the assistant can carry on without the full text.
Write a summary in Markdown, at most about 1,500 words, covering:
- what the user is trying to achieve, and their preferences and instructions for how to work;
- decisions made and answers given;
- every change made in Odin (created, updated, moved, deleted), naming the items with their ids exactly as written;
- facts and numbers that later messages may rely on (people, dates, counts, ids);
- open questions and anything left to do.
Keep ids, names and numbers exactly. Leave out pleasantries and anything superseded later. Do not add anything that is not in the conversation.`;

// Condenses the planned turns (and any earlier summary) into a new summary.
export async function compactTranscript({ abortSignal = null, cache = null, client, model, plan, reasoningEffort = 'max', transcript }) {
  const input = [
    ...(transcript.summary ? [{ content: `Summary of the conversation before this part:\n${transcript.summary.text}`, role: 'user' }] : []),
    { content: `The conversation to condense:\n\n${renderTurns(plan.condense)}`, role: 'user' },
  ];
  const request = (retention) => client.responses.create({
    input,
    instructions: SUMMARY_INSTRUCTIONS,
    max_output_tokens: SUMMARY_OUTPUT_TOKENS,
    model,
    reasoning: { effort: reasoningEffort },
    store: false,
    ...(cache?.key ? { prompt_cache_key: cache.key } : {}),
    ...(retention ? { prompt_cache_retention: retention } : {}),
  }, abortSignal ? { signal: abortSignal } : undefined);
  let response;
  try {
    response = await request(cache?.retention);
  } catch (error) {
    if (!cache?.retention || Number(error?.status) !== 400 || !/prompt_cache_retention|cache retention|prompt caching/i.test(String(error?.message))) throw error;
    response = await request(null);
  }
  const text = String(response.output_text ?? '').trim();
  if (!text) throw new Error('The conversation summary came back empty.');
  return {
    transcript: {
      coveredThrough: transcript.coveredThrough,
      summary: { condensedTurns: (transcript.summary?.condensedTurns ?? 0) + plan.condense.length, createdAt: new Date().toISOString(), text },
      turns: plan.keep,
    },
    usage: response.usage ?? null,
  };
}
