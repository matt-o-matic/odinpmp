import { buildOperationLogContext, logBackendError } from '../../../lib/logging/backend-logger.js';
import { isRemovedTopic } from '../removed-questions.js';
import { topicState } from '../requirements-topics.js';
import { resolveProposedAnswerStatus } from '../summary/summary-output.js';
import { roundTopicIds } from './round-summaries.js';
import { actorRefOf } from './round-views.js';

// Closing a review round closes out the topics its questions link to, so nothing from the
// round is left waiting in Decide. A topic still undecided gets a decision in the closer's
// name: Odin's proposed answer when the topic has one (Agreed when people agree, else
// Decided), replacing an earlier deferral; otherwise a deferral. Topics already decided,
// dismissed, or deleted are left as they are.

function sourcesFor(output) {
  const refs = [];
  const add = (values) => {
    for (const value of Array.isArray(values) ? values : []) {
      const ref = String(value ?? '').trim();
      if (ref && !refs.includes(ref)) refs.push(ref);
    }
  };
  add(output?.proposedAnswerSources);
  for (const entry of output?.aligned ?? []) add(entry?.sources);
  for (const entry of output?.divergent ?? []) {
    for (const position of entry?.positions ?? []) add(position?.sources);
  }
  return refs.slice(0, 50);
}

/** The decision that closes one topic, or null when the topic needs none. */
export function closingDecisionFor({ activeDecision = null, round, summary = null, topic }) {
  if (isRemovedTopic(topic)) return null;
  if (topicState({ status: topic.status, summary }) === 'decided') return null;
  const output = summary?.output ?? null;
  const proposedAnswer = String(output?.proposedAnswer ?? '').trim();
  if (!proposedAnswer || output?.insufficientInput === true) {
    // A topic already deferred stays deferred.
    if (activeDecision) return null;
    return {
      outcome: 'deferred',
      sourceSummaryId: summary?.id ?? null,
      sources: [],
      statement: `Deferred when review round ${round.number} closed: the review gave no answer to adopt.`,
      supersedesId: null,
      topicStatus: null,
    };
  }
  const status = resolveProposedAnswerStatus({ proposedAnswer, status: output.proposedAnswerStatus });
  return {
    outcome: status === 'agreed' ? 'agreed' : 'decided',
    sourceSummaryId: summary.id ?? null,
    sources: sourcesFor(output),
    statement: proposedAnswer,
    supersedesId: activeDecision?.id ?? null,
    topicStatus: 'resolved',
  };
}

/**
 * Records the closing decisions for a round that was just closed. Each topic is recorded on
 * its own; one that someone decided meanwhile (`decision_exists`) or that fails is skipped
 * and logged, since the round is already closed. Returns the topic ids it decided and deferred.
 */
export async function closeRoundTopics(deps, { closedAt, projectId, round, tenantId, user }) {
  const result = { decided: [], deferred: [] };
  const topicIds = roundTopicIds(round);
  if (topicIds.length === 0) return result;

  const [statuses, meta, summaries, decisions] = await Promise.all([
    deps.requirementsRepository.listTopicStatuses({ projectId, tenantId, topicIds }),
    deps.requirementsRepository.listTopicMeta({ projectId, tenantId }),
    deps.requirementsRepository.listLatestSummaries({ projectId, scopeType: 'topic', tenantId }),
    deps.requirementsRepository.listDecisions({ kind: 'topic', projectId, tenantId }),
  ]);
  const statusById = new Map(statuses.map((topic) => [topic.id, topic]));
  const trackById = new Map(meta.map((entry) => [entry.id, entry.track]));
  const summaryByTopic = new Map(summaries.map((summary) => [summary.scopeId, summary]));
  // listDecisions is newest first, so the first active decision per topic is its current one.
  const activeByTopic = new Map();
  for (const decision of decisions) {
    if (decision.topicId && !decision.supersededById && !activeByTopic.has(decision.topicId)) activeByTopic.set(decision.topicId, decision);
  }

  for (const topicId of topicIds) {
    const topic = statusById.get(topicId) ?? null;
    const track = trackById.get(topicId);
    const closing = topic && track
      ? closingDecisionFor({ activeDecision: activeByTopic.get(topicId) ?? null, round, summary: summaryByTopic.get(topicId) ?? null, topic })
      : null;
    if (!closing) continue;
    try {
      await deps.requirementsRepository.createDecision({
        decision: {
          decidedAt: closedAt,
          decidedBy: actorRefOf('user', user.id),
          decidedByName: user.name ?? '',
          kind: 'topic',
          outcome: closing.outcome,
          sourceSummaryId: closing.sourceSummaryId,
          sources: closing.sources,
          statement: closing.statement,
          topicId,
          track,
        },
        projectId,
        supersedesId: closing.supersedesId,
        tenantId,
        topicStatus: closing.topicStatus,
      });
      (closing.outcome === 'deferred' ? result.deferred : result.decided).push(topicId);
    } catch (error) {
      if (error?.details?.code === 'decision_exists' || error?.details?.code === 'decision_superseded') continue;
      logBackendError({
        context: buildOperationLogContext('requirements.rounds.closeTopics', { projectId, roundId: round.id, tenantId, topicId }),
        error,
        level: 'warn',
        message: 'Recording a topic decision when the round closed failed.',
      });
    }
  }
  return result;
}
