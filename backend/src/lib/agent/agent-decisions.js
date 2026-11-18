// Fast typed judgments around the agent loop, made with the OpenAI Decisions API (gpt-6-luna):
// triage before a turn, a check before each write, and a check when the model stops. Each call
// is best-effort: on any error or timeout the caller gets null and carries on without it.
// Predicates and scores only; community testing found choice answers overconfident.

import { mediaFreeText } from './agent-media.js';
import { judgmentContext } from './agent-prompt.js';
import { SUMMARY_HEADING } from './agent-transcript.js';

const EVIDENCE_TEXT_LIMIT = 4000;
const TOOL_OUTPUT_LIMIT = 1200;
const EVIDENCE_MESSAGES = 10;
const EVIDENCE_TOOL_ITEMS = 16;

function clip(value = '', max = EVIDENCE_TEXT_LIMIT) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function messageText(item) {
  if (typeof item.content === 'string') return item.content;
  return mediaFreeText(item.content ?? []);
}

// Developer messages are instructions to the model, not conversation. A judgment keeps the
// summary of earlier turns and, from each turn's notes, only what the user was looking at; budget
// notes and nudges are dropped.
function judgedItem(item) {
  if (item.role !== 'developer') return item;
  const text = messageText(item);
  if (text.startsWith(SUMMARY_HEADING)) return item;
  const context = judgmentContext(text);
  return context ? { content: context, role: 'developer' } : null;
}

// What a judgment sees: the recent conversation (always including the user's latest request and
// the replies it refers back to) and this turn's latest tool calls, in order. Reasoning items
// and images are dropped and long texts shortened, so a long run of tools can never push the
// request itself out of view.
export function decisionEvidence(fullInput = [], { messages = EVIDENCE_MESSAGES, toolItems = EVIDENCE_TOOL_ITEMS } = {}) {
  const input = fullInput.map(judgedItem).filter(Boolean);
  const isMessage = (item) => Boolean(item.role) || item.type === 'message';
  const isTool = (item) => item.type === 'function_call' || item.type === 'function_call_output';
  // The last `count` indexes; slice(-0) would keep them all.
  const last = (indexes, count) => (count > 0 ? indexes.slice(-count) : []);
  const messageIndexes = last(input.map((item, index) => (isMessage(item) ? index : -1)).filter((index) => index >= 0), messages);
  const toolIndexes = last(input.map((item, index) => (isTool(item) ? index : -1)).filter((index) => index >= 0), toolItems);
  const keep = new Set([...messageIndexes, ...toolIndexes]);
  const items = [];
  input.forEach((item, index) => {
    if (!keep.has(index)) return;
    if (item.type === 'function_call') {
      items.push({ arguments: clip(item.arguments, 2000), call_id: item.call_id, name: item.name, type: 'function_call' });
    } else if (item.type === 'function_call_output') {
      items.push({ call_id: item.call_id, output: clip(mediaFreeText(item.output), TOOL_OUTPUT_LIMIT), type: 'function_call_output' });
    } else {
      const role = ['user', 'assistant', 'developer', 'system'].includes(item.role) ? item.role : 'assistant';
      items.push({ content: clip(messageText(item)) || '(empty)', role });
    }
  });
  // Tool outputs need their call, and calls their output (calls about to run are described in the
  // questions instead); drop any half pair.
  const calls = new Set(items.filter((item) => item.type === 'function_call').map((item) => item.call_id));
  const outputs = new Set(items.filter((item) => item.type === 'function_call_output').map((item) => item.call_id));
  return items.filter((item) => (item.type === 'function_call_output' ? calls.has(item.call_id) : item.type === 'function_call' ? outputs.has(item.call_id) : true));
}

export function createAgentDecisions({ cacheKey = null, client, enabled = true, model = 'gpt-6-luna', timeoutMs = 4000 }) {
  async function decide(input, questions, { abortSignal = null } = {}) {
    if (!enabled || !client?.decisions?.create || !questions.length) return null;
    try {
      const signal = abortSignal ? AbortSignal.any([abortSignal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      const response = await client.decisions.create({ input, model, questions, ...(cacheKey ? { prompt_cache_key: cacheKey } : {}) }, { maxRetries: 0, signal });
      const answers = new Map();
      for (const answer of response.answers ?? []) if (answer?.name) answers.set(answer.name, answer);
      return answers;
    } catch (error) {
      if (abortSignal?.aborted) throw error;
      return null;
    }
  }
  const probability = (answers, name) => (answers?.get(name)?.type === 'predicate' ? Number(answers.get(name).probability) : null);

  return {
    enabled: Boolean(enabled && client?.decisions?.create),

    // Any other judgment: each predicate's probability by name (null where none came back), or
    // null when the call failed.
    async judge({ abortSignal, input, questions }) {
      const answers = await decide(input, questions, { abortSignal });
      return answers ? Object.fromEntries(questions.map(({ name }) => [name, probability(answers, name)])) : null;
    },

    // Before the loop: is this simple, does it want changes, is it multi-step, does it need the
    // web, and which catalog operations will it likely need.
    async triage({ abortSignal, evidence, operations = [] }) {
      const questions = [
        // "No schedule, plan or project-wide analysis": "what do we need to do to finish by Oct 30?"
        // read as a direct question (0.97) and ran at the lower effort; now 0.00, while a status
        // question, "mark it done" and a count stay simple (0.99, 0.77, 0.85).
        { instructions: 'The user\'s latest message is a simple request: a direct question or one small change that one or two lookups or edits fully handle, with no schedule, plan or project-wide analysis to work out.', name: 'simple', type: 'predicate' },
        // "Answers a question": a reply to the assistant's question about a change it is making
        // ("keep the end date on Oct 30") read as a question, and its writes were held (0.2).
        { instructions: 'The user\'s latest message asks the assistant to do something that creates, updates, moves, starts, finishes, assigns, logs, records, invites, sends, deletes or otherwise changes anything in Odin, agrees to a change the assistant proposed, or answers a question the assistant asked before making a change the user wants. Questions and requests for information, charts or summaries are not changes.', name: 'change', type: 'predicate' },
        { instructions: 'Handling the user\'s latest message well needs several distinct steps rather than a single lookup or edit: for example reading or changing many items, or working out a schedule, totals, or what it would take to reach a goal across the project.', name: 'multi_step', type: 'predicate' },
        { instructions: 'Answering the user\'s latest message needs current information from the public web, not just data inside Odin.', name: 'research', type: 'predicate' },
        { instructions: 'The best answer to the user\'s latest message includes a chart of numbers (bar, line, pie and the like), for example counts, trends, comparisons or a breakdown, or the user asked for a chart or graph of data.', name: 'visual_chart', type: 'predicate' },
        { instructions: 'The best answer to the user\'s latest message includes a diagram of a process flow, sequence, timeline, state changes, a schedule (Gantt) or a mind map, or the user asked for such a diagram.', name: 'visual_flow', type: 'predicate' },
        { instructions: 'The best answer to the user\'s latest message includes a network graph of dependencies, relationships between items or people, or a hierarchy such as an org chart, or the user asked for one.', name: 'visual_graph', type: 'predicate' },
        // Worded so general work-item tools don't make every operation look needed; measured on
        // 16 typical requests, precision went from 0.26 to 0.71 and recall from 0.60 to 0.75.
        ...operations.slice(0, 390).map((operation, index) => ({
          instructions: `Handling the user's latest message needs the specific Odin operation "${operation.name}" (${operation.write ? 'it changes data' : 'read-only'}): ${clip(operation.summary, 300)} Finding, reading, creating and updating work items, the project overview, comments and workspace search are covered by other tools, so answer yes only if this operation itself is needed.`,
          name: `op_${index}`,
          type: 'predicate',
        })),
      ];
      const answers = await decide(evidence, questions, { abortSignal });
      if (!answers) return null;
      return {
        change: probability(answers, 'change'),
        multiStep: probability(answers, 'multi_step'),
        operations: operations.map((operation, index) => ({ name: operation.name, probability: probability(answers, `op_${index}`) })).filter((entry) => entry.probability !== null),
        research: probability(answers, 'research'),
        visuals: { chart: probability(answers, 'visual_chart'), graphviz: probability(answers, 'visual_graph'), mermaid: probability(answers, 'visual_flow') },
        simple: probability(answers, 'simple'),
      };
    },

    // Before writes: did the user ask for (or agree to) each proposed change? One predicate per
    // proposal, in one call. Worded around the request: "the user asked for this action" scored
    // target dates on every item, asked for in so many words, at 0.02.
    async checkWrites({ abortSignal, evidence, proposals }) {
      const questions = proposals.map((proposal, index) => ({
        instructions: `Proposed change in Odin: ${proposal.summary}. This change is part of what the user's latest request asks for (directly, or as a reasonable step toward it), or something the user clearly agreed to.`,
        name: `write_${index}`,
        type: 'predicate',
      }));
      const answers = await decide(evidence, questions, { abortSignal });
      if (!answers) return null;
      return proposals.map((_, index) => probability(answers, `write_${index}`));
    },

    // When the model stops: did it finish, did it claim a change no tool result shows, and is
    // there work left it could still do.
    async checkCompletion({ abortSignal, evidence }) {
      const answers = await decide(evidence, [
        { instructions: 'The assistant\'s final reply fully answers the user\'s latest message or completes everything the user asked for in this turn.', name: 'done', type: 'predicate' },
        { instructions: 'The assistant\'s final reply says a change was made in Odin that no successful tool result in this turn shows.', name: 'unverified_claim', type: 'predicate' },
        { instructions: 'Part of what the user asked for is still not done, and the assistant could do it with its tools without needing anything more from the user.', name: 'can_continue', type: 'predicate' },
        { instructions: 'The assistant\'s final reply asks the user a question, or asks them to choose or confirm something, that it needs answered before it can go on.', name: 'needs_user', type: 'predicate' },
      ], { abortSignal });
      if (!answers) return null;
      return { canContinue: probability(answers, 'can_continue'), done: probability(answers, 'done'), needsUser: probability(answers, 'needs_user'), unverifiedClaim: probability(answers, 'unverified_claim') };
    },
  };
}

const CHANGE_VERBS = /^(please\s+|can you\s+|could you\s+|would you\s+|go ahead( and)?\s+|let'?s\s+|i need you to\s+|i want you to\s+)?(add|create|make|update|change|edit|rename|move|delete|remove|assign|reassign|set|mark|close|complete|reopen|split|link|unlink|comment|invite|send|publish|log|record|draft|write|generate|decompose|expand|fix|clean|prioriti[sz]e|reorder|schedule|start|activate|put|turn|convert|merge|archive|resolve|dismiss|upload)\b/i;
const AFFIRMATIONS = /^(yes|yep|yeah|sure|ok(ay)?|do it|go ahead|please do|sounds good|approved?|ship it|make it so)\b/i;
const BROAD = /\b(all|every|each|whole|entire|break (it |this |them )?down|decompose|reorganiz\w*|restructur\w*|clean ?up|plan out|for each)\b/i;
const VISUAL_WORDS = {
  chart: /\b(chart|plot|bar graph|line graph|pie|histogram|visuali[sz]e|trend|breakdown)\b/i,
  graphviz: /\b(dependency graph|dependencies|org chart|hierarchy|relationships?|network|tree)\b/i,
  mermaid: /\b(diagram|flow ?chart|flow|sequence|timeline|gantt|mind ?map|state machine|lifecycle|process map)\b/i,
};
const RESEARCH = /\b(research|look (it )?up|search the web|online|latest|industry|best practices?|benchmarks?|competitors?)\b/i;

// The fallback when the Decisions API is unavailable: simple word rules.
export function heuristicTriage(message = '') {
  const text = String(message ?? '').trim();
  const sentences = text.split(/(?<=[.!?\n])\s+/).filter(Boolean);
  const change = sentences.some((sentence) => CHANGE_VERBS.test(sentence.trim())) || AFFIRMATIONS.test(text);
  const listy = (text.match(/^\s*(?:[-*]|\d+[.)])\s+/gm) ?? []).length >= 2;
  const multiStep = BROAD.test(text) || listy || text.length > 400;
  const visuals = Object.entries(VISUAL_WORDS).filter(([, pattern]) => pattern.test(text)).map(([kind]) => kind);
  return { change, multiStep, research: RESEARCH.test(text), simple: !multiStep && text.length <= 240 && sentences.length <= 3, visuals };
}

export const PROMOTE_THRESHOLD = 0.6;
export const PROMOTE_LIMIT = 4;

// Triage for one turn: Decisions when available, word rules otherwise. Also tells the toolbox
// which catalog operations look relevant and picks a few to describe in the turn's notes.
export async function triageTurn({ abortSignal = null, decisions = null, evidence, message, toolbox }) {
  const fallback = heuristicTriage(message);
  const verdict = decisions?.enabled ? await decisions.triage({ abortSignal, evidence, operations: toolbox.operations() }) : null;
  if (!verdict) return { ...fallback, promoted: toolbox.keywordPromotions(message), source: 'heuristic' };
  toolbox.setRelevance(verdict.operations);
  const promoted = verdict.operations
    .filter((entry) => entry.probability >= PROMOTE_THRESHOLD)
    .sort((left, right) => right.probability - left.probability)
    .slice(0, PROMOTE_LIMIT)
    .map((entry) => entry.name);
  const at = (value, fallbackValue) => (value === null || value === undefined ? fallbackValue : value >= 0.5);
  return {
    change: at(verdict.change, fallback.change) || (fallback.change && CHANGE_VERBS.test(String(message).trim())),
    multiStep: at(verdict.multiStep, fallback.multiStep),
    probabilities: { change: verdict.change, multiStep: verdict.multiStep, research: verdict.research, simple: verdict.simple, visuals: verdict.visuals },
    promoted,
    research: at(verdict.research, fallback.research),
    // The visual formats the answer should use, most fitting first.
    visuals: verdict.visuals
      ? Object.entries(verdict.visuals).filter(([, value]) => value !== null && value >= 0.5).sort((left, right) => right[1] - left[1]).map(([kind]) => kind)
      : fallback.visuals,
    simple: at(verdict.simple, fallback.simple),
    source: 'decisions',
  };
}
