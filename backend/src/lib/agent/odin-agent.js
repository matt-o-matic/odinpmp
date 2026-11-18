import { createHash } from 'node:crypto';

import { buildReasoning } from './agent-openai.js';
import { decisionEvidence } from './agent-decisions.js';
import { toolOutputFor } from './agent-media.js';
import { describeCall, toolActivityLabel, toolNeedsConfirmation, toolProgressLabel, truncateOutput } from './agent-tools.js';

// The agent loop. The model answers or calls tools (several at once if it likes); tools run as
// the user; results go back; repeat until it answers. The rails, for a capable but not top-tier
// model, help it finish rather than block it:
// - a tool-call budget pooled by task: each step of the model's plan adds a task's worth;
// - a loop guard that allows retries but stops calls that keep failing, or keep returning the
//   same result, with the same arguments;
// - a Decisions check that the user asked for each write, and one when the model stops that
//   nudges it to finish or to correct a claim no tool result supports;
// - a guaranteed final answer;
// - deletes and emails pause for the user's confirmation;
// - a read-only turn (a monitor's unattended check) refuses every write before it runs or pauses;
// - ids the model garbles are corrected in calls and in the reply (agent-ids.js).

const MAX_COMPLETION_NUDGES = 2;
// A step cut off by the output limit, its reasoning having used it all, returns nothing to act
// on. It runs again thinking less, at most this often per turn.
const MAX_TRUNCATED_STEPS = 2;
const LOWER_EFFORT = Object.freeze({ high: 'medium', max: 'high', medium: 'low', xhigh: 'high' });
const TRUNCATED_PROMPT = 'Your last step ran out of output space while thinking, so nothing was done. Act now on what you planned: keep your reasoning short and work in smaller pieces (at most 20 items per bulk call).';
const REPEAT_LIMIT = 3;
const FINAL_ANSWER_PROMPT = 'Stop using tools now and reply to the user with what you found and did. If something is not finished, say exactly what is left so they can ask you to continue.';
// A monitor check runs unattended and reads content anyone could have written, so it changes nothing.
const READ_ONLY_REFUSAL = Object.freeze({ ok: false, error: { code: 'read_only', message: 'Not run: this is a monitor check, which can only read. Nothing in Odin can be changed here, so do not try again. Report what you found, and say what the user could change.' } });
// A failed query is usually a column the model guessed, and the error it gets back lists the real
// ones. The person sees only this; the full error goes to the server log.
const QUERY_FAILED_NOTE = 'The query returned an error, so the assistant will retry it.';
const IDS_CORRECTED = 'These ids matched nothing, so each was read as the one id starting with the same 8 characters. Copy ids exactly as tool results give them.';

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : Object.assign(new Error('Assistant turn cancelled.'), { name: 'AbortError' });
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

const digest = (value) => createHash('sha256').update(stableJson(value)).digest('hex');

function parseArguments(raw) {
  try {
    const value = JSON.parse(raw || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return null;
  }
}

const EMPTY_USAGE = Object.freeze({ cachedTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, steps: 0 });

function addUsage(total, usage) {
  if (!usage) return total;
  return {
    cachedTokens: total.cachedTokens + (usage.input_tokens_details?.cached_tokens ?? 0),
    inputTokens: total.inputTokens + (usage.input_tokens ?? 0),
    outputTokens: total.outputTokens + (usage.output_tokens ?? 0),
    reasoningTokens: total.reasoningTokens + (usage.output_tokens_details?.reasoning_tokens ?? 0),
    steps: total.steps + 1,
  };
}

export function createTurnState({ input, maxToolCalls = 420, toolCallsPerTask = 40, toolNames }) {
  return {
    budget: { ceiling: maxToolCalls, noted: [], perTask: toolCallsPerTask, pool: Math.min(maxToolCalls, toolCallsPerTask), used: 0 },
    carryReasoning: true,
    guard: { failures: {}, repeats: {} },
    input,
    plan: null,
    toolNames,
  };
}

async function streamStep({ abortSignal, cache, carryReasoning, client, emit, input, instructions, maxOutputTokens, model, reasoningEffort, toolChoice = 'auto', tools }) {
  const reasoning = buildReasoning(reasoningEffort, model);
  const stream = await client.responses.create({
    input,
    instructions,
    max_output_tokens: maxOutputTokens,
    model,
    parallel_tool_calls: true,
    // The instructions and tools never change and the input only grows, so each step (and the
    // next turn) reuses the cached prefix; the key keeps one user's requests together.
    ...(cache?.key ? { prompt_cache_key: cache.key } : {}),
    ...(cache?.retention ? { prompt_cache_retention: cache.retention } : {}),
    ...(reasoning ? { reasoning } : {}),
    // Reasoning carried between steps (store is off) so the model keeps its train of thought.
    ...(reasoning && carryReasoning ? { include: ['reasoning.encrypted_content'] } : {}),
    store: false,
    stream: true,
    ...(tools.length ? { tool_choice: toolChoice, tools } : {}),
  }, abortSignal ? { signal: abortSignal } : undefined);

  let text = '';
  const citations = [];
  let output = [];
  let usage = null;
  let webSearches = 0;
  let incomplete = null;
  for await (const event of stream) {
    if (abortSignal?.aborted) throw abortError(abortSignal);
    switch (event.type) {
      case 'response.output_text.delta':
        if (event.delta) { text += event.delta; await emit('assistant.delta', { delta: event.delta }); }
        break;
      case 'response.output_item.added':
        if (event.item?.type === 'web_search_call') await emit('tool.started', { callId: event.item.id, label: 'Searching the web', name: 'web_search' });
        break;
      case 'response.output_item.done': {
        const item = event.item ?? {};
        output.push(item);
        if (item.type === 'web_search_call') {
          webSearches += 1;
          await emit('tool.completed', { callId: item.id, label: toolActivityLabel('web_search', { query: item.action?.query }), name: 'web_search', ok: item.status !== 'failed' });
        }
        if (item.type === 'message') {
          for (const part of item.content ?? []) {
            for (const annotation of part.annotations ?? []) {
              if (annotation.type === 'url_citation' && annotation.url) citations.push({ title: annotation.title || annotation.url, url: annotation.url });
            }
          }
        }
        break;
      }
      case 'response.completed':
      case 'response.incomplete':
        usage = event.response?.usage ?? null;
        if (event.type === 'response.incomplete') incomplete = event.response?.incomplete_details?.reason ?? 'unknown';
        if (Array.isArray(event.response?.output) && event.response.output.length) output = event.response.output;
        break;
      case 'response.failed':
        throw new Error(event.response?.error?.message ?? 'The AI model could not complete the response.');
      case 'error':
        throw new Error(event.message ?? event.error?.message ?? 'The AI model stream failed.');
      default:
        break;
    }
  }
  const calls = output.filter((item) => item.type === 'function_call').map((item) => ({ arguments: item.arguments ?? '{}', callId: item.call_id, name: item.name }));
  return { calls, citations, incomplete, output, text, usage, webSearches };
}

// Items from a response that go back into the next request's input.
function carriedItems(output, carryReasoning) {
  return output.filter((item) => {
    if (item.type === 'reasoning') return carryReasoning && Boolean(item.encrypted_content);
    return ['message', 'function_call', 'web_search_call'].includes(item.type);
  }).map((item) => (carryReasoning || item.type !== 'function_call' ? item : { arguments: item.arguments, call_id: item.call_id, name: item.name, type: 'function_call' }));
}

/**
 * Runs, or resumes, one assistant turn.
 * Returns { status: 'completed' | 'awaiting_confirmation', text, activity, citations, pending, plan, state, usage, writes }.
 */
export async function runAgentTurn({
  abortSignal = null,
  allowWebResearch = false,
  checks = null,
  client,
  emit = async () => {},
  instructions,
  // Identifies the turn in the server log (chatId and the like).
  logContext = {},
  maxOutputTokens = 32000,
  model,
  promptCacheKey = null,
  promptCacheRetention = null,
  readOnly = false,
  reasoningEffort = 'max',
  resume = null,
  state,
  toolbox,
  writeCheckThreshold = 0.3,
}) {
  const activity = [];
  const citations = [];
  const writes = [];
  const cache = { key: promptCacheKey, retention: promptCacheRetention };
  let texts = [];
  let usage = { ...EMPTY_USAGE };
  let nudges = 0;
  let effort = reasoningEffort;
  let truncatedSteps = 0;

  const budgetLeft = () => state.budget.pool - state.budget.used;
  // The reply, with links whose ids the model garbled pointed at the right item.
  const replyText = async () => {
    const text = texts.join('\n\n');
    return toolbox.repairText ? toolbox.repairText(text) : text;
  };
  toolbox.learnIds?.(state.input);
  const offered = () => [
    ...state.toolNames.map((name) => toolbox.definition(name)),
    ...toolbox.localToolNames().map((name) => toolbox.definition(name)),
    ...(allowWebResearch ? [{ type: 'web_search' }] : []),
  ];

  async function step(options = {}) {
    for (;;) {
      try {
        return await streamStep({ abortSignal, cache, carryReasoning: state.carryReasoning, client, emit, input: state.input, instructions, maxOutputTokens, model, reasoningEffort: effort, tools: offered(), ...options });
      } catch (error) {
        if (Number(error?.status) !== 400) throw error;
        const message = String(error?.message);
        // Models without extended prompt caching: send the rest of the turn without it.
        if (cache.retention && /prompt_cache_retention|cache retention|prompt caching/i.test(message)) { cache.retention = null; continue; }
        // Models or accounts without encrypted reasoning: drop it and retry without.
        if (state.carryReasoning && /encrypted|include|reasoning/i.test(message)) {
          state.carryReasoning = false;
          state.input = state.input.filter((item) => item.type !== 'reasoning');
          continue;
        }
        throw error;
      }
    }
  }

  function applyPlan(steps) {
    state.plan = steps;
    const wanted = Math.max(1, steps.filter((entry) => entry.status !== 'skipped').length) * state.budget.perTask;
    state.budget.pool = Math.min(state.budget.ceiling, Math.max(state.budget.pool, wanted));
  }

  async function record(call, resolved, outcome) {
    const ok = outcome.result?.ok !== false;
    const label = toolActivityLabel(resolved.name, resolved.args ?? {}, outcome.result);
    const failure = outcome.result?.error?.message
      ?? outcome.result?.failed?.map((entry) => `${entry.name}: ${entry.error}`).join('; ')
      ?? outcome.result?.results?.filter((entry) => !entry.ok).map((entry) => `${entry.name ?? entry.itemId}: ${entry.error}`).join('; ');
    if (!ok && outcome.result?.error?.code !== 'declined') {
      console.warn('Assistant tool failed.', { ...logContext, callId: call.callId, code: outcome.result?.error?.code ?? null, error: String(failure || 'Failed').slice(0, 2000), name: resolved.name, ...(resolved.name === 'odin_query' ? { sql: String(resolved.args?.sql ?? '').slice(0, 4000) } : {}) });
    }
    const shown = resolved.name === 'odin_query' ? QUERY_FAILED_NOTE : String(failure || 'Failed').slice(0, 300);
    const entry = { callId: call.callId, label, name: resolved.name, ok, ...(ok ? {} : { error: shown }) };
    if (resolved.name !== 'update_plan') activity.push(entry);
    if (outcome.write && ok) writes.push({ args: outcome.args, name: resolved.name, result: outcome.result });
    await emit('tool.completed', entry);
    // A result with media (an image or PDF to look at) goes back as text and those parts.
    state.input.push({ call_id: call.callId, output: toolOutputFor(outcome.result, truncateOutput), type: 'function_call_output' });
  }

  // Loop guard: identical calls may be retried, but not forever.
  function guardBlock(signature) {
    if ((state.guard.failures[signature] ?? 0) >= REPEAT_LIMIT) {
      return { ok: false, error: { code: 'repeated_failure', message: `This exact call has failed ${REPEAT_LIMIT} times. Change the arguments, read the current state first, use another operation, or tell the user what is blocking you.` } };
    }
    if ((state.guard.repeats[signature]?.count ?? 0) >= REPEAT_LIMIT) {
      return { ok: false, error: { code: 'repeated_call', message: `This exact call has returned the same result ${REPEAT_LIMIT} times. Use the result you already have, or change the arguments.` } };
    }
    return null;
  }
  function guardNote(signature, outcome) {
    const failed = outcome.result?.ok === false;
    if (failed) { state.guard.failures[signature] = (state.guard.failures[signature] ?? 0) + 1; return; }
    delete state.guard.failures[signature];
    if (outcome.write) { state.guard.repeats = {}; return; }
    const hash = digest(outcome.result);
    const previous = state.guard.repeats[signature];
    state.guard.repeats[signature] = previous?.hash === hash ? { count: previous.count + 1, hash } : { count: 1, hash };
  }

  async function execute(call, resolved, { confirmed = false } = {}) {
    if (resolved.name === 'update_plan') {
      const outcome = await toolbox.run('update_plan', resolved.args);
      if (outcome.result.ok) {
        applyPlan(outcome.args.steps);
        await emit('plan.updated', { budget: { pool: state.budget.pool, used: state.budget.used }, steps: state.plan });
        outcome.result = { ok: true, budget: { pool: state.budget.pool, used: state.budget.used } };
      }
      await record(call, resolved, outcome);
      return;
    }
    const signature = `${resolved.name}:${stableJson(resolved.args)}`;
    const blocked = !confirmed && guardBlock(signature);
    state.budget.used += 1;
    if (blocked) { await record(call, resolved, { result: blocked }); return; }
    await emit('tool.started', { callId: call.callId, label: toolProgressLabel(resolved.name, resolved.args), name: resolved.name });
    const outcome = await toolbox.run(resolved.name, resolved.args);
    if (resolved.corrected?.length && outcome.result && typeof outcome.result === 'object') {
      outcome.result = { ...outcome.result, idsCorrected: { ids: resolved.corrected, note: IDS_CORRECTED } };
    }
    guardNote(signature, outcome);
    await record(call, resolved, outcome);
  }

  // Resuming after the user confirmed or declined a paused action.
  if (resume) {
    const call = { callId: resume.callId };
    const resolved = { args: resume.args, name: resume.name, write: true };
    if (resume.approved) await execute(call, resolved, { confirmed: true });
    else await record(call, resolved, { result: { ok: false, declined: true, error: { code: 'declined', message: 'The user declined this action. Do not retry it unless they ask again.' } } });
  }

  let finished = false;
  const stepCeiling = state.budget.ceiling + 20;
  for (let stepIndex = 0; stepIndex < stepCeiling && !finished; stepIndex += 1) {
    if (abortSignal?.aborted) throw abortError(abortSignal);
    if (budgetLeft() <= 0) break;
    for (const [mark, share] of [['half', 0.5], ['most', 0.8]]) {
      if (!state.budget.noted.includes(mark) && state.budget.used >= state.budget.pool * share) {
        state.budget.noted.push(mark);
        state.input.push({ content: `Tool budget: ${state.budget.used} of ${state.budget.pool} calls used this turn. Work efficiently and finish the most important parts first.`, role: 'developer' });
      }
    }

    const result = await step();
    usage = addUsage(usage, result.usage);
    citations.push(...result.citations);
    state.budget.used += result.webSearches;
    // Cut off while thinking, with nothing to show: try again thinking less. Its partial output
    // is not carried. Live, a 52-item date change at max effort ended the turn with nothing done.
    if (result.incomplete === 'max_output_tokens' && !result.calls.length && !result.text.trim() && truncatedSteps < MAX_TRUNCATED_STEPS) {
      truncatedSteps += 1;
      effort = LOWER_EFFORT[effort] ?? effort;
      state.input.push({ content: TRUNCATED_PROMPT, role: 'developer' });
      continue;
    }
    if (result.text.trim()) texts.push(result.text.trim());
    state.input.push(...carriedItems(result.output, state.carryReasoning));
    if (!result.output.some((item) => item.type === 'message') && result.text.trim()) state.input.push({ content: result.text, role: 'assistant' });

    if (!result.calls.length) {
      if (!result.text.trim()) break;
      // The model stopped. Check that it really finished and only claims what tools did.
      // The check sees enough tool results to judge a turn of many parallel calls (Decisions input
      // is cheap); with too few it judges complete answers unfinished and costs extra steps.
      const verdict = nudges < MAX_COMPLETION_NUDGES && checks ? await checks.checkCompletion({ abortSignal, evidence: decisionEvidence(state.input, { toolItems: 64 }) }) : null;
      const unverified = (verdict?.unverifiedClaim ?? 0) >= 0.6;
      // A reply that asks the user something it needs to go on is finished for now: no nudge.
      const unfinished = (verdict?.done ?? 1) < 0.35 && (verdict?.canContinue ?? 0) >= 0.6 && (verdict?.needsUser ?? 0) < 0.5;
      if (verdict && (unverified || unfinished) && budgetLeft() > 0) {
        nudges += 1;
        texts = [];
        await emit('assistant.reset', { reason: unverified ? 'unverified_claim' : 'unfinished' });
        state.input.push({
          content: unverified
            ? 'Your reply says something was changed in Odin, but no successful tool result this turn shows it. Check the tool results: make the change now if it was asked for, or correct the reply. Then write your complete reply again; it replaces the previous one.'
            : 'Part of what the user asked for is not done yet, and you can still do it with your tools. Continue the work, then write your complete reply again; it replaces the previous one.',
          role: 'developer',
        });
        continue;
      }
      finished = true;
      break;
    }

    // Garbled ids are corrected before anything checks or runs the calls.
    const calls = await Promise.all(result.calls.map(async (call) => {
      const args = parseArguments(call.arguments);
      const resolved = args ? toolbox.resolve(call.name, args) : null;
      return { args, call, resolved: resolved && toolbox.repairIds ? await toolbox.repairIds(resolved) : resolved };
    }));

    // Calls past the budget are not run.
    let allowance = budgetLeft();
    const runnable = [];
    for (const entry of calls) {
      if (!entry.resolved) { await record(entry.call, { args: {}, name: entry.call.name }, { result: { ok: false, error: { code: 'invalid_json', message: 'The arguments were not valid JSON. Send a JSON object.' } } }); continue; }
      if (entry.resolved.name !== 'update_plan') {
        if (allowance <= 0) { await record(entry.call, entry.resolved, { result: { ok: false, error: { code: 'budget_exhausted', message: 'Not run: the tool budget for this turn is used up.' } } }); continue; }
        allowance -= 1;
      }
      if (readOnly && entry.resolved.write) { state.budget.used += 1; await record(entry.call, entry.resolved, { result: READ_ONLY_REFUSAL }); continue; }
      runnable.push(entry);
    }

    // The first action that needs confirmation pauses the turn after everything before it ran.
    const pausing = runnable.find((entry) => entry.resolved.write && toolNeedsConfirmation(entry.resolved.name, entry.resolved.args));
    // Writes the user did not ask for are held back (Decisions check; skipped when unavailable).
    // The check reads the conversation, not tool results: shown a read of 22 open items, it held
    // target dates on all 52 items, asked for in so many words (0.04 against 0.86 without).
    const writesToCheck = runnable.filter((entry) => entry.resolved.write && entry !== pausing && !toolNeedsConfirmation(entry.resolved.name, entry.resolved.args));
    const held = new Set();
    if (writesToCheck.length && checks) {
      const probabilities = await checks.checkWrites({
        abortSignal,
        evidence: decisionEvidence(state.input, { toolItems: 0 }),
        proposals: await Promise.all(writesToCheck.map(async (entry) => {
          const target = toolbox.describeTarget ? await toolbox.describeTarget(entry.resolved.name, entry.resolved.args) : '';
          return { summary: `${describeCall(entry.resolved.name, entry.resolved.args)}${target ? `; affects ${target}` : ''}` };
        })),
      });
      probabilities?.forEach((probability, index) => { if (probability !== null && probability < writeCheckThreshold) held.add(writesToCheck[index]); });
    }

    const reads = runnable.filter((entry) => !entry.resolved.write);
    const writesNow = runnable.filter((entry) => entry.resolved.write && entry !== pausing);
    await Promise.all(reads.map((entry) => execute(entry.call, entry.resolved)));
    for (const entry of writesNow) {
      if (held.has(entry)) {
        state.budget.used += 1;
        await record(entry.call, entry.resolved, { result: { ok: false, error: { code: 'not_requested', message: 'Not run: this change looks outside what the user asked for. Do not retry it. In your reply, say exactly what you would change and ask the user to confirm.' } } });
      } else if (pausing && toolNeedsConfirmation(entry.resolved.name, entry.resolved.args)) {
        await record(entry.call, entry.resolved, { result: { ok: false, error: { code: 'waiting', message: 'Not run: another action is waiting for the user to confirm. Call it again afterwards if it is still needed.' } } });
      } else {
        await execute(entry.call, entry.resolved);
      }
    }

    if (pausing) {
      const entry = toolbox.describe(pausing.resolved.name);
      const pending = {
        args: pausing.resolved.args,
        callId: pausing.call.callId,
        description: entry?.description?.split(/(?<=\.)\s/)[0] ?? '',
        label: toolActivityLabel(pausing.resolved.name, pausing.resolved.args),
        name: pausing.resolved.name,
        target: toolbox.describeTarget ? await toolbox.describeTarget(pausing.resolved.name, pausing.resolved.args) : '',
      };
      await emit('confirm.requested', pending);
      return { activity, citations, pending, plan: state.plan, state, status: 'awaiting_confirmation', text: await replyText(), usage, writes };
    }
  }

  if (!finished) {
    // Guaranteed answer: one last step with tools off.
    state.input.push({ content: budgetLeft() <= 0 ? `The tool budget for this turn (${state.budget.pool} calls) is used up. ${FINAL_ANSWER_PROMPT}` : FINAL_ANSWER_PROMPT, role: 'developer' });
    const result = await step({ toolChoice: 'none' });
    usage = addUsage(usage, result.usage);
    citations.push(...result.citations);
    if (result.text.trim()) texts.push(result.text.trim());
    state.input.push(...carriedItems(result.output, state.carryReasoning));
  }

  return {
    activity,
    citations: [...new Map(citations.map((citation) => [citation.url, citation])).values()],
    pending: null,
    plan: state.plan,
    state,
    status: 'completed',
    text: (await replyText()) || 'I could not produce an answer this time. Please try again or rephrase the request.',
    usage,
    writes,
  };
}
