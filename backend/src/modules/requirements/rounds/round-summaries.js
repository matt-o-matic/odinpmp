import { buildOperationLogContext, logBackendError } from '../../../lib/logging/backend-logger.js';
import { isRemovedTopic, questionTopicId } from '../removed-questions.js';
import { topicState } from '../requirements-topics.js';
import { resolveProposedAnswerStatus } from '../summary/summary-output.js';
import { decisionContext, presentSummaryOutput, presentSummaryStatus } from '../summary/summary-topics.js';
import {
  answerText,
  BUILT_IN_DIMENSIONS,
  dimensionLabels,
  manifestDirections,
  manifestQuestions,
  manifestScreens,
  STANCE_LABELS,
  VERDICT_LABELS,
} from './round-manifest.js';
import { actorRefOf, collectDirectionStances, collectScreenVerdicts, loadPeople, personName } from './round-views.js';
import { mentionsToPlainText } from '../mentions/mention-tokens.js';
import { publishRoundEvent, ROUND_EVENTS } from './round-events.js';

// Odin summaries for screens in a round and for whole rounds (plan.md, "AI running summary").
// Sources are the human feedback in the round: annotations (labeled A<number> on a screen,
// as reviewers see them), their thread comments (C1, C2, ...), screen verdicts with their
// notes (V1, ...), direction stances (D1, ...), and answers (Q1, ...). Stored refs are
// annotation:<id>, comment:<id>, verdict:<id>, and answer:<id>; people are user:<id> and
// stakeholder:<id>. Round summaries are team-only, so they publish no portal events.
//
// People answer round questions in the linked topic threads as often as in the round, so a
// round summary also reads each linked topic's state, proposed answer, and decision, and
// refreshes when a linked topic is decided or its proposed answer changes.

export const SCREEN_SCOPE = 'screen';
export const ROUND_SCOPE = 'round';

const SHAPE_LABELS = { arrow: 'Arrow', box: 'Box', highlight: 'Highlight', pen: 'Drawing', pin: 'Pin', text: 'Text label' };

export function screenScopeId(roundId, screenId) {
  return `${roundId}:${screenId}`;
}

export function parseScreenScopeId(scopeId) {
  const value = String(scopeId ?? '');
  const separator = value.indexOf(':');
  return separator > 0 ? { roundId: value.slice(0, separator), screenId: value.slice(separator + 1) } : null;
}

/** Everything a round's summaries and results read, loaded once. */
export async function loadRoundFeedback(deps, { projectId, round, tenantId }) {
  const [annotations, verdicts, answers] = await Promise.all([
    deps.roundsRepository.listAnnotations({ projectId, roundIds: [round.id], tenantId }),
    deps.roundsRepository.listVerdicts({ roundIds: [round.id] }),
    deps.roundsRepository.listAnswers({ roundIds: [round.id] }),
  ]);
  const comments = await deps.roundsRepository.listComments({ annotationIds: annotations.map((annotation) => annotation.id) });
  return { annotations, answers, comments, verdicts };
}

function describeAnnotation(annotation, { labels, screenTitle }) {
  const primary = (annotation.shapes ?? []).find((shape) => shape.type === 'pin') ?? annotation.shapes?.[0];
  const parts = [`${SHAPE_LABELS[primary?.type] ?? 'Mark'} ${annotation.number ?? ''} on "${screenTitle}"`.replace(/\s+on/, ' on')];
  if (annotation.stateKey) parts.push(`in state ${annotation.stateKey}`);
  if (annotation.category) parts.push(`about ${labels.get(annotation.category) ?? BUILT_IN_DIMENSIONS[annotation.category] ?? annotation.category}`);
  const hint = annotation.elementHint;
  if (hint && (hint.text || hint.tag || hint.odinId)) parts.push(`on ${hint.tag ?? 'element'}${hint.odinId ? ` [${hint.odinId}]` : ''}${hint.text ? ` "${hint.text}"` : ''}`);
  const texts = (annotation.shapes ?? []).filter((shape) => shape.type === 'text' && shape.text).map((shape) => `"${shape.text}"`);
  let text = parts.join(', ');
  if (texts.length > 0) text += `. Label: ${texts.join(' ')}`;
  if (annotation.status !== 'open') text += `. Status: ${annotation.status}`;
  if (annotation.anchor?.note) text += `. Note: ${annotation.anchor.note}`;
  return `${text}.`;
}

function describeVerdict(verdict, { labels, screenTitle }) {
  const parts = [`Verdict on "${screenTitle}": ${VERDICT_LABELS[verdict.overall] ?? verdict.overall}.`];
  const dimensions = Object.entries(verdict.dimensions ?? {}).map(([key, value]) => `${labels.get(key) ?? key}: ${VERDICT_LABELS[value] ?? value}`);
  if (dimensions.length > 0) parts.push(`${dimensions.join('; ')}.`);
  if (verdict.stay) parts.push(`What should stay: ${verdict.stay}`);
  if (verdict.change) parts.push(`What should change: ${verdict.change}`);
  if (verdict.mixed) parts.push(`Mixed feelings: ${verdict.mixed}`);
  return parts.join(' ');
}

/**
 * Sources and a lookup for every stored ref, for one screen or the whole round.
 * `screenFilter` limits annotations and verdicts to one screen; directions and answers are
 * round-only. Answers to `removedQuestionIds` are left out.
 */
export function buildRoundSources({ feedback, manifest, people, removedQuestionIds = new Set(), round, screenFilter = null, track }) {
  const labels = dimensionLabels(manifest, track);
  const screens = manifestScreens(manifest);
  const titleOf = new Map(screens.map((screen) => [screen.id, screen.title]));
  const screenIndex = new Map(screens.map((screen, index) => [screen.id, index + 1]));
  const sources = [];
  const lookup = new Map();
  const nameOf = (actorType, actorId, fallback = '') => personName(people, actorRefOf(actorType, actorId), fallback);
  const prefix = (screenId) => (screenFilter ? '' : `S${screenIndex.get(screenId) ?? 0}-`);

  const annotations = feedback.annotations
    .filter((annotation) => !screenFilter || annotation.screenId === screenFilter)
    .filter((annotation) => titleOf.has(annotation.screenId))
    .sort((left, right) => (screenIndex.get(left.screenId) - screenIndex.get(right.screenId)) || (Number(left.number ?? 0) - Number(right.number ?? 0)));
  const annotationLabel = new Map();
  for (const annotation of annotations) {
    const label = `${prefix(annotation.screenId)}A${annotation.number ?? 0}`;
    annotationLabel.set(annotation.id, label);
    const storedRef = `annotation:${annotation.id}`;
    lookup.set(storedRef, { annotationId: annotation.id, kind: 'annotation', label: `#${annotation.number}`, screenId: annotation.screenId });
    sources.push({
      actorName: nameOf(annotation.authorType, annotation.authorId, annotation.authorName),
      actorRef: actorRefOf(annotation.authorType, annotation.authorId),
      createdAt: annotation.createdAt,
      kind: 'annotation',
      ref: label,
      storedRef,
      text: describeAnnotation(annotation, { labels, screenTitle: titleOf.get(annotation.screenId) }),
    });
  }

  const annotationIds = new Set(annotations.map((annotation) => annotation.id));
  const comments = feedback.comments
    .filter((comment) => annotationIds.has(comment.annotationId))
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  const commentLabel = new Map();
  comments.forEach((comment, index) => {
    const label = `C${index + 1}`;
    commentLabel.set(comment.id, label);
    const storedRef = `comment:${comment.id}`;
    if (comment.deletedAt || !String(comment.body ?? '').trim()) return;
    const annotation = annotations.find((item) => item.id === comment.annotationId);
    lookup.set(storedRef, { annotationId: comment.annotationId, kind: 'comment', label, screenId: annotation?.screenId ?? null });
    sources.push({
      actorName: nameOf(comment.authorType, comment.authorId, comment.authorName),
      actorRef: actorRefOf(comment.authorType, comment.authorId),
      createdAt: comment.createdAt,
      kind: 'annotation-comment',
      ref: label,
      replyTo: (comment.parentCommentId && commentLabel.get(comment.parentCommentId)) || annotationLabel.get(comment.annotationId) || null,
      storedRef,
      text: mentionsToPlainText(comment.body),
    });
  });

  const screenVerdicts = collectScreenVerdicts(feedback.verdicts);
  let verdictIndex = 0;
  for (const [key, verdict] of screenVerdicts) {
    const separator = key.lastIndexOf('|');
    const actorRef = key.slice(0, separator);
    const screenId = key.slice(separator + 1);
    if ((screenFilter && screenId !== screenFilter) || !titleOf.has(screenId)) continue;
    verdictIndex += 1;
    const label = `V${verdictIndex}`;
    const storedRef = `verdict:${verdict.id}`;
    lookup.set(storedRef, { actorRef, kind: 'verdict', label, screenId });
    sources.push({
      actorName: personName(people, actorRef),
      actorRef,
      createdAt: verdict.updatedAt,
      kind: 'verdict',
      ref: label,
      storedRef,
      text: describeVerdict(verdict, { labels, screenTitle: titleOf.get(screenId) }),
    });
  }

  if (!screenFilter) {
    const directions = new Map(manifestDirections(manifest).map((direction) => [direction.id, direction]));
    let directionIndex = 0;
    for (const [key, stance] of collectDirectionStances(feedback.verdicts)) {
      const separator = key.lastIndexOf('|');
      const actorRef = key.slice(0, separator);
      const direction = directions.get(key.slice(separator + 1));
      if (!direction) continue;
      directionIndex += 1;
      const label = `D${directionIndex}`;
      const storedRef = `verdict:${stance.id}`;
      lookup.set(storedRef, { actorRef, directionId: direction.id, kind: 'direction', label });
      sources.push({
        actorName: personName(people, actorRef),
        actorRef,
        createdAt: stance.updatedAt,
        kind: 'direction',
        ref: label,
        storedRef,
        text: `Direction "${direction.title}": ${STANCE_LABELS[stance.stance] ?? stance.stance}.${stance.remix ? ` Remix: ${stance.remix}` : ''}`,
      });
    }

    const questions = new Map(manifestQuestions(manifest).map((question) => [question.id, question]));
    feedback.answers.forEach((answer, index) => {
      const question = questions.get(answer.questionId);
      if (!question || removedQuestionIds.has(question.id)) return;
      const label = `Q${index + 1}`;
      const storedRef = `answer:${answer.id}`;
      const actorRef = actorRefOf(answer.actorType, answer.actorId);
      lookup.set(storedRef, { actorRef, kind: 'answer', label, questionId: question.id });
      sources.push({
        actorName: personName(people, actorRef),
        actorRef,
        createdAt: answer.updatedAt,
        kind: 'answer',
        ref: label,
        storedRef,
        text: `Answer to "${question.prompt}": ${answerText(question, answer.value)}`,
      });
    });
  }

  return { lookup, sources };
}

/** Topic ids a round's questions are linked to (set for every question when it is published). */
export function roundTopicIds(round) {
  return [...new Set(Object.values(round?.questionTopics ?? {}).filter(Boolean))];
}

/**
 * What each linked topic says now, for the round summary's context, keyed by question id.
 * A question whose topic was deleted or dismissed reads as removed: it no longer needs an
 * answer, so the round summary leaves it and its answers out.
 */
export async function loadLinkedTopics(deps, { manifest, projectId, round, tenantId }) {
  const links = manifestQuestions(manifest)
    .map((question) => ({ question, topicId: questionTopicId(round, question) }))
    .filter((link) => link.topicId);
  if (links.length === 0) return [];
  const topicIds = [...new Set(links.map((link) => link.topicId))];
  const [topics, summaries, decisions] = await Promise.all([
    deps.requirementsRepository.listTopicStatuses({ projectId, tenantId, topicIds }),
    deps.requirementsRepository.listLatestSummaries({ projectId, scopeType: 'topic', tenantId }),
    deps.requirementsRepository.listDecisions({ kind: 'topic', projectId, tenantId }),
  ]);
  const topicById = new Map(topics.map((topic) => [topic.id, topic]));
  const summaryByTopic = new Map(summaries.map((summary) => [summary.scopeId, summary]));
  // listDecisions is newest first, so the first active decision per topic is its current one.
  const decisionByTopic = new Map();
  for (const decision of decisions) {
    if (decision.topicId && !decision.supersededById && !decisionByTopic.has(decision.topicId)) decisionByTopic.set(decision.topicId, decision);
  }
  return links.map(({ question, topicId }) => {
    const topic = topicById.get(topicId);
    if (isRemovedTopic(topic)) return { question: question.prompt, questionId: question.id, state: 'removed' };
    const summary = summaryByTopic.get(topicId) ?? null;
    const output = summary?.output ?? null;
    const decision = decisionByTopic.get(topicId);
    const proposedAnswer = String(output?.proposedAnswer ?? '').trim();
    return {
      question: question.prompt,
      questionId: question.id,
      state: topicState({ status: topic.status, summary }),
      ...(proposedAnswer
        ? { proposedAnswer, proposedAnswerStatus: resolveProposedAnswerStatus({ proposedAnswer, status: output.proposedAnswerStatus }) }
        : {}),
      ...(decision ? { decision: { outcome: decision.outcome, statement: decisionContext(decision).statement } } : {}),
    };
  });
}

async function loadRoundAndPackage(deps, { projectId, roundId, tenantId }) {
  const round = await deps.roundsRepository.getRound({ projectId, roundId, tenantId });
  if (!round) return null;
  const pkg = await deps.packagesRepository.getPackage({ packageId: round.packageId, projectId, tenantId });
  return pkg ? { pkg, round } : null;
}

/** Registers the 'screen' and 'round' scopes with the summary engine. */
export function registerRoundSummaryScopes(engine, deps) {
  if (typeof engine?.registerScope !== 'function') return;

  engine.registerScope(SCREEN_SCOPE, {
    async load({ projectId, scopeId, tenantId }) {
      const parsed = parseScreenScopeId(scopeId);
      if (!parsed) return null;
      const loaded = await loadRoundAndPackage(deps, { projectId, roundId: parsed.roundId, tenantId });
      const screen = loaded ? manifestScreens(loaded.pkg.manifest).find((item) => item.id === parsed.screenId) : null;
      if (!screen) return null;
      const [feedback, people] = await Promise.all([
        loadRoundFeedback(deps, { projectId, round: loaded.round, tenantId }),
        loadPeople(deps, { projectId, tenantId }),
      ]);
      const { sources } = buildRoundSources({ feedback, manifest: loaded.pkg.manifest, people, round: loaded.round, screenFilter: screen.id, track: loaded.round.track });
      return {
        audience: { stakeholderIds: [] },
        context: { feedbackDimensions: [...dimensionLabels(loaded.pkg.manifest, loaded.round.track).values()] },
        sources,
        subject: { alt: screen.alt ?? '', kind: screen.kind, package: loaded.pkg.title, round: loaded.round.number, screen: screen.title },
        track: loaded.round.track,
      };
    },
  });

  engine.registerScope(ROUND_SCOPE, {
    async load({ projectId, scopeId, tenantId }) {
      const loaded = await loadRoundAndPackage(deps, { projectId, roundId: scopeId, tenantId });
      if (!loaded) return null;
      const { manifest } = loaded.pkg;
      const [feedback, people, linkedTopics] = await Promise.all([
        loadRoundFeedback(deps, { projectId, round: loaded.round, tenantId }),
        loadPeople(deps, { projectId, tenantId }),
        loadLinkedTopics(deps, { manifest, projectId, round: loaded.round, tenantId }),
      ]);
      const removedQuestionIds = new Set(linkedTopics.filter((entry) => entry.state === 'removed').map((entry) => entry.questionId));
      const linked = linkedTopics.filter((entry) => entry.state !== 'removed').map(({ questionId: _questionId, ...entry }) => entry);
      const { sources } = buildRoundSources({ feedback, manifest, people, removedQuestionIds, round: loaded.round, track: loaded.round.track });
      return {
        audience: { stakeholderIds: [] },
        context: {
          directions: manifestDirections(manifest).map((direction) => direction.title),
          ...(linked.length > 0 ? { linkedTopics: linked } : {}),
          questions: manifestQuestions(manifest).filter((question) => !removedQuestionIds.has(question.id)).map((question) => question.prompt),
          screens: manifestScreens(manifest).map((screen) => screen.title),
        },
        sources,
        subject: { package: loaded.pkg.title, round: loaded.round.number, summary: manifest?.summary ?? '' },
        track: loaded.round.track,
      };
    },
  });

  if (typeof engine.subscribe === 'function') {
    engine.subscribe({
      onSummaryStored({ job, previous, summary }) {
        if (job.scopeType !== 'topic' || !topicAnswerChanged(previous?.output, summary?.output)) return null;
        return refreshRoundsLinkedToTopics({ ...deps, requirementsSummaries: engine }, { projectId: job.projectId, tenantId: job.tenantId, topicIds: [job.scopeId] });
      },
      async onTopicActivity({ projectId, reason, tenantId, topicIds }) {
        if (!LINKED_TOPIC_REASONS.has(reason)) return;
        const rounds = await refreshRoundsLinkedToTopics({ ...deps, requirementsSummaries: engine }, { projectId, tenantId, topicIds });
        // A deleted, dismissed, or reopened topic removes or restores its question, so open
        // reviews refetch instead of offering an answer the round now refuses.
        if (!QUESTION_CHANGE_REASONS.has(reason)) return;
        for (const round of rounds.filter((item) => item.status === 'open')) {
          await publishRoundEvent(deps, { projectId, reason: 'question-changed', round, tenantId, type: ROUND_EVENTS.rounds });
        }
      },
    });
  }
}

// Topic changes a linked round's summary has to reflect, and the ones that remove or restore
// the round's question.
const LINKED_TOPIC_REASONS = new Set(['decision-recorded', 'decision-updated', 'topic-deleted', 'topic-status-changed']);
const QUESTION_CHANGE_REASONS = new Set(['topic-deleted', 'topic-status-changed']);

/** Whether a topic run changed what a round reads from it. */
export function topicAnswerChanged(before, after) {
  const view = (output) => {
    const proposedAnswer = String(output?.proposedAnswer ?? '').trim();
    return JSON.stringify([
      output?.insufficientInput === true,
      proposedAnswer,
      resolveProposedAnswerStatus({ proposedAnswer, status: output?.proposedAnswerStatus }),
    ]);
  };
  return view(before) !== view(after);
}

/**
 * Debounced refresh of every round, open or closed, with a question linked to one of the
 * topics. Returns those rounds.
 */
export async function refreshRoundsLinkedToTopics(deps, { projectId, tenantId, topicIds = [] }) {
  const wanted = new Set(topicIds.filter(Boolean));
  if (wanted.size === 0) return [];
  const rounds = (await deps.roundsRepository.listRounds({ projectId, tenantId }))
    .filter((round) => roundTopicIds(round).some((topicId) => wanted.has(topicId)));
  for (const round of rounds) requestRoundSummaryRefresh(deps, { projectId, roundId: round.id, tenantId });
  return rounds;
}

/** Debounced refresh of a screen's summary and its round's (after human activity). */
export function requestRoundSummaryRefresh(deps, { projectId, roundId, screenId = null, tenantId }) {
  const engine = deps.requirementsSummaries;
  if (typeof engine?.requestRefresh !== 'function') return;
  try {
    if (screenId) engine.requestRefresh({ projectId, scopeId: screenScopeId(roundId, screenId), scopeType: SCREEN_SCOPE, tenantId });
    engine.requestRefresh({ projectId, scopeId: roundId, scopeType: ROUND_SCOPE, tenantId });
  } catch (error) {
    logBackendError({
      context: buildOperationLogContext('requirements.rounds.requestSummary', { projectId, roundId, screenId, tenantId }),
      error,
      level: 'warn',
      message: 'Odin summary refresh could not be scheduled.',
    });
  }
}

function citedRefs(output) {
  const refs = [];
  const add = (values) => {
    for (const value of values ?? []) if (value && !refs.includes(value)) refs.push(value);
  };
  for (const entry of output?.aligned ?? []) add(entry.sources);
  for (const entry of output?.divergent ?? []) for (const position of entry.positions ?? []) add(position.sources);
  for (const entry of output?.proposedPreferences ?? []) add(entry.sources);
  for (const entry of output?.outstanding ?? []) add(entry.sources);
  for (const entry of output?.feedbackThemes ?? []) add(entry.sources);
  return refs;
}

/** A stored screen or round summary for the team, with every cited source resolved. */
export function presentScopeSummary(summary, { attempt = null, lookup = new Map(), names = new Map(), pending = false } = {}) {
  const status = presentSummaryStatus({ lastAttempt: attempt, refreshPending: pending });
  if (!summary) return { current: null, status };
  const output = presentSummaryOutput(summary.output, { audience: 'team', names });
  return {
    current: {
      createdAt: summary.createdAt,
      id: summary.id,
      output,
      sources: citedRefs(summary.output).map((ref) => {
        // A source is unavailable once it is deleted or no longer belongs to this round.
        const found = lookup.get(ref);
        return found ? { available: true, ref, ...found } : { available: false, kind: ref.split(':')[0] || null, label: null, ref };
      }),
    },
    status,
  };
}
