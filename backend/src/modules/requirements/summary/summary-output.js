import { z } from 'zod';

// The Odin summary's structured output (plan.md, "AI running summary"), the schema every
// provider's output is checked against, and the citation validator that runs after it.

export const SUMMARY_LIMITS = Object.freeze({
  aligned: 8,
  divergent: 8,
  feedbackThemes: 8,
  outstanding: 8,
  positions: 6,
  proposedPreferences: 10,
  refsPerEntry: 20,
  // A theme gathers every mark and comment on one point, so it may cite more.
  refsPerTheme: 60,
  underExplored: 8,
});

export const PREFERENCE_STANCES = Object.freeze(['keep', 'change', 'undecided']);

// How far the proposed answer is settled: 'agreed' when someone with standing and at least
// one other person back it, 'owner-answered' when it is the topic owner's answer and nobody
// has objected since, 'authority-answered' when it is the answer of a required person or an
// admin and nobody with equal or higher standing has disputed it, 'awaiting-confirmation'
// when it rests on one other person's answer that has not been confirmed, 'none' when there
// is no proposed answer. Agreed, owner-answered and authority-answered answers are ready to
// record.
export const PROPOSED_ANSWER_STATUSES = Object.freeze(['none', 'agreed', 'owner-answered', 'authority-answered', 'awaiting-confirmation']);
export const READY_TO_RECORD_STATUSES = Object.freeze(['agreed', 'owner-answered', 'authority-answered']);

const ref = z.string().trim().min(1).max(160);
const refs = z.array(ref).max(SUMMARY_LIMITS.refsPerEntry);

// Every field is required so the schema works with strict structured outputs.
export const summaryOutputSchema = z.object({
  aligned: z.array(z.object({
    sources: refs,
    statement: z.string().trim().min(1).max(600),
    supporters: refs,
  })).max(SUMMARY_LIMITS.aligned),
  divergent: z.array(z.object({
    issue: z.string().trim().min(1).max(600),
    positions: z.array(z.object({
      actors: refs,
      sources: refs,
      summary: z.string().trim().min(1).max(600),
    })).max(SUMMARY_LIMITS.positions),
  })).max(SUMMARY_LIMITS.divergent),
  // Round and screen summaries: what the annotations and comments say, grouped by theme.
  feedbackThemes: z.array(z.object({
    detail: z.string().trim().max(800),
    sources: z.array(ref).max(SUMMARY_LIMITS.refsPerTheme),
    theme: z.string().trim().min(1).max(160),
  })).max(SUMMARY_LIMITS.feedbackThemes),
  insufficientInput: z.boolean(),
  outstanding: z.array(z.object({
    blocking: z.boolean(),
    item: z.string().trim().min(1).max(600),
    sources: refs,
    suggestedOwnerRole: z.string().trim().max(120),
    waitingOn: refs,
  })).max(SUMMARY_LIMITS.outstanding),
  proposedAnswer: z.string().trim().max(2000),
  proposedAnswerSources: refs,
  proposedAnswerStatus: z.enum(PROPOSED_ANSWER_STATUSES),
  proposedPreferences: z.array(z.object({
    dimension: z.string().trim().max(80),
    sources: refs,
    stance: z.enum(PREFERENCE_STANCES),
    statement: z.string().trim().min(1).max(600),
  })).max(SUMMARY_LIMITS.proposedPreferences),
  underExplored: z.array(z.object({
    area: z.string().trim().min(1).max(300),
    suggestedQuestion: z.string().trim().max(600),
    why: z.string().trim().max(600),
  })).max(SUMMARY_LIMITS.underExplored),
});

export function emptySummaryOutput({ insufficientInput = false } = {}) {
  return {
    aligned: [],
    divergent: [],
    feedbackThemes: [],
    insufficientInput,
    outstanding: [],
    proposedAnswer: '',
    proposedAnswerSources: [],
    proposedAnswerStatus: 'none',
    proposedPreferences: [],
    underExplored: [],
  };
}

/**
 * The proposed answer's status, consistent with the answer: 'none' without an answer, and
 * never 'agreed' when fewer than two people took part. When that one person owns the topic
 * (`loneOwner`), nobody has challenged them, so the answer is the owner's unless the model
 * held it back as awaiting confirmation; when they are a required person or an admin
 * (`loneAuthority`), it is theirs the same way. 'owner-answered' needs a topic owner
 * (`hasOwner`) and 'authority-answered' a required person or admin (`hasAuthority`). Runs
 * stored before the status existed read as 'agreed' when they carry an answer, as they were
 * only written with two or more contributors.
 */
export function resolveProposedAnswerStatus({
  contributors = 2,
  hasAuthority = true,
  hasOwner = true,
  loneAuthority = false,
  loneOwner = false,
  proposedAnswer = '',
  status,
} = {}) {
  if (!String(proposedAnswer ?? '').trim()) return 'none';
  if (contributors < 2) {
    if (status === 'awaiting-confirmation') return status;
    if (loneOwner) return 'owner-answered';
    return loneAuthority ? 'authority-answered' : 'awaiting-confirmation';
  }
  if (status === 'owner-answered') return hasOwner ? status : 'awaiting-confirmation';
  if (status === 'authority-answered') return hasAuthority ? status : 'awaiting-confirmation';
  if (status === 'agreed' || status === 'awaiting-confirmation') return status;
  return status === undefined ? 'agreed' : 'awaiting-confirmation';
}

/** True when the output says nothing at all. */
export function isEmptySummaryOutput(output) {
  return !output
    || ((output.aligned?.length ?? 0) === 0
      && (output.divergent?.length ?? 0) === 0
      && (output.underExplored?.length ?? 0) === 0
      && (output.outstanding?.length ?? 0) === 0
      && (output.proposedPreferences?.length ?? 0) === 0
      && (output.feedbackThemes?.length ?? 0) === 0
      && !String(output.proposedAnswer ?? '').trim());
}

function splitRefs(values = [], allowed) {
  const valid = [];
  const unknown = [];
  for (const value of values ?? []) {
    const normalized = String(value ?? '').trim();
    if (!normalized) continue;
    if (allowed.has(normalized)) {
      if (!valid.includes(normalized)) valid.push(normalized);
    } else if (!unknown.includes(normalized)) {
      unknown.push(normalized);
    }
  }
  return { unknown, valid };
}

export const MIN_DIVERGENT_POSITIONS = 2;

/**
 * Applies the guardrails to schema-valid output:
 *   - every aligned entry, divergent position, proposed preference, and feedback theme must
 *     cite at least one source ref from the input, or it is dropped;
 *   - a divergent entry needs at least two cited positions (a disagreement with one side
 *     is not a disagreement), or it is dropped;
 *   - unknown source refs and actor refs are removed from entries that survive;
 *   - an outstanding item stays, but a blocking one that cites no valid source is kept as
 *     non-blocking: a blocker has to point at the disagreement or open question behind it.
 * Each drop, removal, and downgrade is recorded. `failed` is true when the model said something, the
 * validator dropped it, and nothing valid remains.
 */
export function validateSummaryCitations(output, { actorRefs = [], sourceRefs = [] } = {}) {
  const sources = new Set(sourceRefs);
  const actors = new Set(actorRefs);
  const dropped = [];
  const result = emptySummaryOutput({ insufficientInput: Boolean(output?.insufficientInput) });
  let droppedEntries = 0;

  const noteUnknown = (section, location, kind, unknown) => {
    if (unknown.length > 0) dropped.push({ ...location, reason: kind, refs: unknown, section });
  };

  (output?.aligned ?? []).forEach((entry, index) => {
    const cited = splitRefs(entry.sources, sources);
    if (cited.valid.length === 0) {
      droppedEntries += 1;
      dropped.push({ entry, index, reason: 'no-valid-source', section: 'aligned' });
      return;
    }
    const supporters = splitRefs(entry.supporters, actors);
    noteUnknown('aligned', { index }, 'unknown-source', cited.unknown);
    noteUnknown('aligned', { index }, 'unknown-actor', supporters.unknown);
    result.aligned.push({ sources: cited.valid, statement: entry.statement, supporters: supporters.valid });
  });

  (output?.divergent ?? []).forEach((entry, index) => {
    const positions = [];
    (entry.positions ?? []).forEach((position, positionIndex) => {
      const cited = splitRefs(position.sources, sources);
      if (cited.valid.length === 0) {
        dropped.push({ entry: position, index, position: positionIndex, reason: 'no-valid-source', section: 'divergent' });
        return;
      }
      const holders = splitRefs(position.actors, actors);
      noteUnknown('divergent', { index, position: positionIndex }, 'unknown-source', cited.unknown);
      noteUnknown('divergent', { index, position: positionIndex }, 'unknown-actor', holders.unknown);
      positions.push({ actors: holders.valid, sources: cited.valid, summary: position.summary });
    });
    if (positions.length < MIN_DIVERGENT_POSITIONS) {
      droppedEntries += 1;
      dropped.push({
        entry: { issue: entry.issue, positions },
        index,
        reason: 'fewer-than-two-cited-positions',
        section: 'divergent',
      });
      return;
    }
    result.divergent.push({ issue: entry.issue, positions });
  });

  (output?.proposedPreferences ?? []).forEach((entry, index) => {
    const cited = splitRefs(entry.sources, sources);
    if (cited.valid.length === 0) {
      droppedEntries += 1;
      dropped.push({ entry, index, reason: 'no-valid-source', section: 'proposedPreferences' });
      return;
    }
    noteUnknown('proposedPreferences', { index }, 'unknown-source', cited.unknown);
    result.proposedPreferences.push({ dimension: entry.dimension, sources: cited.valid, stance: entry.stance, statement: entry.statement });
  });

  (output?.feedbackThemes ?? []).forEach((entry, index) => {
    const cited = splitRefs(entry.sources, sources);
    if (cited.valid.length === 0) {
      droppedEntries += 1;
      dropped.push({ entry, index, reason: 'no-valid-source', section: 'feedbackThemes' });
      return;
    }
    noteUnknown('feedbackThemes', { index }, 'unknown-source', cited.unknown);
    result.feedbackThemes.push({ detail: entry.detail ?? '', sources: cited.valid, theme: entry.theme });
  });

  (output?.outstanding ?? []).forEach((entry, index) => {
    const cited = splitRefs(entry.sources, sources);
    const waiting = splitRefs(entry.waitingOn, actors);
    noteUnknown('outstanding', { index }, 'unknown-source', cited.unknown);
    noteUnknown('outstanding', { index }, 'unknown-actor', waiting.unknown);
    const blocking = entry.blocking === true && cited.valid.length > 0;
    if (entry.blocking === true && !blocking) dropped.push({ index, reason: 'blocking-without-source', section: 'outstanding' });
    result.outstanding.push({
      blocking,
      item: entry.item,
      sources: cited.valid,
      suggestedOwnerRole: entry.suggestedOwnerRole ?? '',
      waitingOn: waiting.valid,
    });
  });

  result.underExplored = (output?.underExplored ?? []).map((entry) => ({ ...entry }));
  result.proposedAnswer = String(output?.proposedAnswer ?? '').trim();
  if (result.proposedAnswer) {
    const cited = splitRefs(output?.proposedAnswerSources, sources);
    noteUnknown('proposedAnswer', {}, 'unknown-source', cited.unknown);
    result.proposedAnswerSources = cited.valid;
  }
  result.proposedAnswerStatus = resolveProposedAnswerStatus({ proposedAnswer: result.proposedAnswer, status: output?.proposedAnswerStatus ?? 'none' });

  const failed = droppedEntries > 0 && !result.insufficientInput && isEmptySummaryOutput(result);
  return { dropped, failed, output: result };
}

/** Rewrites every source and actor ref in an output (or a dropped record) through `map`. */
export function mapSummaryRefs(output, { actor = (value) => value, source = (value) => value } = {}) {
  if (!output || typeof output !== 'object') return output;
  const mapList = (values, fn) => (Array.isArray(values) ? values.map((value) => fn(value)) : values);
  return {
    ...output,
    aligned: (output.aligned ?? []).map((entry) => ({ ...entry, sources: mapList(entry.sources, source), supporters: mapList(entry.supporters, actor) })),
    divergent: (output.divergent ?? []).map((entry) => ({
      ...entry,
      positions: (entry.positions ?? []).map((position) => ({ ...position, actors: mapList(position.actors, actor), sources: mapList(position.sources, source) })),
    })),
    feedbackThemes: (output.feedbackThemes ?? []).map((entry) => ({ ...entry, sources: mapList(entry.sources, source) })),
    outstanding: (output.outstanding ?? []).map((entry) => ({ ...entry, sources: mapList(entry.sources, source), waitingOn: mapList(entry.waitingOn, actor) })),
    proposedAnswerSources: mapList(output.proposedAnswerSources ?? [], source),
    proposedPreferences: (output.proposedPreferences ?? []).map((entry) => ({ ...entry, sources: mapList(entry.sources, source) })),
  };
}
