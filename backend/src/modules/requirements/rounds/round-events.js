import { LIVE_EVENT_CHANNELS } from '../../../lib/events/live-event-bus.js';
import { buildOperationLogContext, logBackendError } from '../../../lib/logging/backend-logger.js';
import { REQUIREMENTS_EVENTS } from '../requirements-events.js';

// Live events for rounds. Team screens listen on project:{id}. A round is visible in
// the portal only to the stakeholders invited to it, so portal events go to their links and
// no others, and carry no actor ids.

export const ROUND_EVENTS = Object.freeze({
  review: REQUIREMENTS_EVENTS.review,
  rounds: REQUIREMENTS_EVENTS.rounds,
});

/**
 * Publishes one round event. `stakeholderIds` defaults to the round's current invitees;
 * pass extra ids (a stakeholder just removed) so their open portal refreshes too.
 */
export async function publishRoundEvent(deps, {
  actor = null,
  annotationId = null,
  extraStakeholderIds = [],
  projectId,
  reason,
  round,
  screenId = null,
  tenantId,
  type = ROUND_EVENTS.rounds,
}) {
  const bus = deps.liveEventBus;
  if (!bus || !projectId || !round) return;
  const detail = { roundId: round.id, ...(screenId ? { screenId } : {}), ...(annotationId ? { annotationId } : {}) };

  bus.publish(LIVE_EVENT_CHANNELS.project(projectId), {
    actor,
    projectId,
    reason,
    track: round.track,
    type,
    ...detail,
  });

  const stakeholderIds = new Set([
    ...(round.reviewers ?? []).filter((reviewer) => reviewer.actorType === 'stakeholder' && !reviewer.removedAt).map((reviewer) => reviewer.actorId),
    ...extraStakeholderIds,
  ]);
  if (stakeholderIds.size === 0) return;
  try {
    const links = await deps.requirementsRepository?.listAccessLinks?.({ projectId, tenantId }) ?? [];
    for (const link of links) {
      if (link.revokedAt || !stakeholderIds.has(link.stakeholderId)) continue;
      bus.publish(LIVE_EVENT_CHANNELS.publicRequirements(link.id), { reason, type, ...detail });
    }
  } catch (error) {
    logBackendError({
      context: buildOperationLogContext('requirements.rounds.publishPortalEvents', { projectId, reason, roundId: round.id, tenantId }),
      error,
      level: 'warn',
      message: 'Round portal invalidation failed.',
    });
  }
}
