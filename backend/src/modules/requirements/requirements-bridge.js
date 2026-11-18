import { buildOperationLogContext, logBackendError } from '../../lib/logging/backend-logger.js';
import {
  buildRequirementsPortalUrl,
  computeLinkStatus,
  generateAccessToken,
  hashAccessToken,
} from './requirements-access-links.js';
import { publishRequirementsChange } from './requirements-events.js';
import { topicCommentsOpen } from './requirements-topics.js';
import { topicCreateSchema, topicPatchSchema, trackSchema } from './requirements.schema.js';
import {
  createTrackTopicForUser,
  deleteTopicForUser,
  listProjectTopicsForUser,
  moveTopicForUser,
  updateTopicForUser,
} from './requirements.service.js';

// The older clarification code (invitation mail, the public clarification portal, and
// reply-by-email) is shared with requirements topics. It reaches requirements through this
// bridge, attached to the assistant repository it already receives everywhere, so every
// caller (routes, the assistant pipeline, and the durable worker) sees the same rules:
//   - tracked topics never appear on the older portal, whose tokens never expire;
//   - invitation mail for a tracked topic carries a fresh requirements link token;
//   - email replies on a tracked topic need a live requirements link, and schedule an Odin
//     summary refresh like any other comment;
//   - comments, edits, deletes, votes, and answers on a tracked topic through the older
//     team clarification routes schedule a refresh too (onTrackedTopicActivity).
// The AI Workspace also administers topics through it (listTopics, applyTopicAction), with
// the same permission checks as the Requirements routes. createApp binds the service deps
// once they exist (bindServices).

export function createRequirementsAssistantBridge({
  clock = () => new Date(),
  frontendAppUrl = '',
  liveEventBus = null,
  requirementsRepository,
  summaries = null,
}) {
  let serviceDeps = null;

  function requireServices() {
    const deps = serviceDeps?.();
    if (!deps) throw new Error('Requirements services are not available to the assistant.');
    return deps;
  }

  return {
    bindServices(getDeps) {
      serviceDeps = typeof getDeps === 'function' ? getDeps : null;
    },

    async listTopics({ projectId, user }) {
      return listProjectTopicsForUser(requireServices(), { projectId, user });
    },

    /** Applies one approved assistant topic action as the approving user. */
    async applyTopicAction({ action, projectId, user }) {
      const deps = requireServices();
      const payload = action?.createPayload?.input ?? {};
      const topicId = String(action?.targetId ?? '');
      switch (action?.type) {
        case 'topic_create':
          return createTrackTopicForUser(deps, {
            input: topicCreateSchema.parse(payload),
            origin: 'assistant',
            projectId,
            track: trackSchema.parse(payload.track),
            user,
          });
        case 'topic_update':
        case 'topic_status_change':
          return updateTopicForUser(deps, { input: topicPatchSchema.parse(payload), projectId, topicId, user });
        case 'topic_move':
          return moveTopicForUser(deps, { projectId, topicId, track: trackSchema.parse(payload.track), user });
        case 'topic_delete':
          return deleteTopicForUser(deps, { projectId, topicId, user });
        default:
          throw new Error(`Unknown topic action: ${action?.type}`);
      }
    },

    async listTrackedTopicIds({ projectId, tenantId }) {
      const meta = await requirementsRepository.listTopicMeta({ projectId, tenantId });
      return new Set(meta.filter((entry) => entry.track).map((entry) => entry.id));
    },

    async getTopicTrack({ clarificationId, projectId, tenantId }) {
      return requirementsRepository.getTopicTrack({ clarificationId, projectId, tenantId });
    },

    /**
     * Issues a token for one email. Creates the stakeholder's link when missing. Returns
     * null when an admin or manager revoked the link: assigning a topic does not undo that.
     */
    async issueInvitationUrl({ createdBy = 'system:invitation', projectId, purpose = 'invitation', stakeholderId, tenantId }) {
      const token = generateAccessToken();
      try {
        const issued = await requirementsRepository.issueAccessToken({
          createdBy,
          now: clock(),
          projectId,
          purpose,
          stakeholderId,
          tenantId,
          tokenHash: hashAccessToken(token),
        });
        return {
          linkId: issued.link.id,
          tokenId: issued.token.id,
          url: buildRequirementsPortalUrl({ frontendAppUrl, token }),
        };
      } catch (error) {
        if (error?.details?.code === 'link_revoked') {
          logBackendError({
            context: buildOperationLogContext('requirements.issueInvitationUrl', { projectId, stakeholderId, tenantId }),
            error,
            level: 'warn',
            message: 'Requirements invitation not sent because the stakeholder link is revoked.',
          });
          return null;
        }
        throw error;
      }
    },

    /**
     * Whether a token from issueInvitationUrl still opens the portal: it belongs to the
     * stakeholder's current link, neither is revoked, and the link has not expired. Reads only.
     */
    async invitationUrlUsable({ linkId, projectId, stakeholderId, tenantId, tokenId }) {
      const link = await requirementsRepository.getAccessLinkForStakeholder({ projectId, stakeholderId, tenantId });
      if (!link || link.id !== linkId) return false;
      const token = (link.tokens ?? []).find((entry) => entry.id === tokenId);
      if (!token || token.revokedAt) return false;
      const involvement = await requirementsRepository.listStakeholderInvolvement({ projectId, stakeholderId, tenantId });
      return computeLinkStatus({ involvement, link, now: clock() }).status === 'active';
    },

    /** Lifetime status of a stakeholder's link: 'missing', 'active', 'expired', or 'revoked'. */
    async stakeholderLinkStatus({ projectId, stakeholderId, tenantId }) {
      const link = await requirementsRepository.getAccessLinkForStakeholder({ projectId, stakeholderId, tenantId });
      if (!link) return 'missing';
      const involvement = await requirementsRepository.listStakeholderInvolvement({ projectId, stakeholderId, tenantId });
      return computeLinkStatus({ involvement, link, now: clock() }).status;
    },

    async topicAcceptsComments({ projectId, status, tenantId, topicId }) {
      const decisions = await requirementsRepository.listDecisions({ kind: 'topic', projectId, tenantId, topicId });
      return topicCommentsOpen({ hasActiveDecision: decisions.some((decision) => !decision.supersededById), status });
    },

    async publishTopicChange({ projectId, reason, tenantId, topicIds = [] }) {
      await publishRequirementsChange({
        liveEventBus,
        projectId,
        reason,
        requirementsRepository,
        tenantId,
        topicIds,
      });
      summaries?.noteTopicActivity?.({ projectId, reason, tenantId, topicIds });
    },

    /** Discussion activity on a tracked topic from the older clarification routes. */
    onTrackedTopicActivity({ projectId, reason, tenantId, topicId }) {
      if (!topicId) return;
      // Live update for open Requirements views and portals; never fails the caller's request.
      publishRequirementsChange({ liveEventBus, projectId, reason, requirementsRepository, tenantId, topicIds: [topicId] })
        .catch(() => {});
      summaries?.noteTopicActivity?.({ projectId, reason, tenantId, topicIds: [topicId] });
    },
  };
}

export function attachRequirementsBridge(assistantRepository, bridge) {
  if (assistantRepository && typeof assistantRepository === 'object') {
    assistantRepository.requirementsBridge = bridge;
  }
}
