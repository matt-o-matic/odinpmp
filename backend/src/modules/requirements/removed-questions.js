import { HttpError } from '../../lib/errors/http-error.js';
import { manifestQuestions } from './rounds/round-manifest.js';

// A question stops needing an answer once its topic is deleted or dismissed, including after
// a round asking it was published. Reviewers and stakeholders then see it as removed and
// cannot answer it; answers already given stay stored.

export const QUESTION_REMOVED = 'question_removed';
export const QUESTION_REMOVED_MESSAGE = 'This question has been removed and no longer needs an answer.';

/** 404 where a portal link opens the question itself, 409 where a round is asked to accept an answer. */
export function questionRemovedError(statusCode = 409) {
  return new HttpError(statusCode, QUESTION_REMOVED_MESSAGE, { details: { code: QUESTION_REMOVED, message: QUESTION_REMOVED_MESSAGE } });
}

/** A topic that is gone (`null`) or dismissed. */
export function isRemovedTopic(topic) {
  return !topic || topic.status === 'dismissed';
}

/** The topic a round question posts its answers to: the one chosen at publish, else the manifest's. */
export function questionTopicId(round, question) {
  return round?.questionTopics?.[question.id] ?? question.topicId ?? null;
}

/** Ids of the round's questions whose topic was deleted or dismissed. Questions without a topic never count. */
export async function loadRemovedQuestionIds(deps, { manifest, projectId, round, tenantId }) {
  const linked = manifestQuestions(manifest)
    .map((question) => ({ questionId: question.id, topicId: questionTopicId(round, question) }))
    .filter((entry) => entry.topicId);
  if (linked.length === 0) return new Set();
  const topics = await deps.requirementsRepository.listTopicStatuses({
    projectId,
    tenantId,
    topicIds: [...new Set(linked.map((entry) => entry.topicId))],
  });
  const byId = new Map(topics.map((topic) => [topic.id, topic]));
  return new Set(linked.filter((entry) => isRemovedTopic(byId.get(entry.topicId))).map((entry) => entry.questionId));
}
