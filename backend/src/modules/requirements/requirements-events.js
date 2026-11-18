import { LIVE_EVENT_CHANNELS } from '../../lib/events/live-event-bus.js';
import { buildOperationLogContext, logBackendError } from '../../lib/logging/backend-logger.js';

// Requirements invalidations. Team screens listen on project:{id}; every stakeholder link
// in the project listens on public-requirements:{linkId}, because unassigned topics are
// visible to all of them. The older clarification portal never shows tracked
// topics, so it gets no requirements events.

export const REQUIREMENTS_EVENTS = Object.freeze({
  decisions: 'requirements.decisions.invalidated',
  links: 'requirements.links.invalidated',
  // Feedback inside a round: { roundId, screenId?, annotationId?, reason }. Published on the
  // project channel and the portal channels of the round's invited stakeholders only.
  review: 'requirements.review.updated',
  // Round lifecycle, reviewers, and submissions: { roundId, track, reason }, same channels.
  rounds: 'requirements.rounds.invalidated',
  // Published by the summary engine on every stored run: { scopeType, scopeId, summaryId, status, track }.
  summary: 'requirements.summary.updated',
  topics: 'requirements.topics.invalidated',
});

export async function publishRequirementsChange({
  actor = null,
  liveEventBus,
  projectId,
  reason = 'updated',
  requirementsRepository,
  tenantId,
  topicIds = [],
  track = null,
  type = REQUIREMENTS_EVENTS.topics,
}) {
  if (!liveEventBus || !projectId) return;

  liveEventBus.publish(LIVE_EVENT_CHANNELS.project(projectId), {
    actor,
    projectId,
    reason,
    topicIds,
    track,
    type,
  });

  try {
    const links = await requirementsRepository?.listAccessLinks?.({ projectId, tenantId }) ?? [];
    for (const link of links) {
      if (link.revokedAt) continue;
      liveEventBus.publish(LIVE_EVENT_CHANNELS.publicRequirements(link.id), {
        reason,
        topicIds,
        type,
      });
    }
  } catch (error) {
    logBackendError({
      context: buildOperationLogContext('requirements.publishPortalEvents', { projectId, reason, tenantId }),
      error,
      level: 'warn',
      message: 'Client portal invalidation failed.',
    });
  }
}
