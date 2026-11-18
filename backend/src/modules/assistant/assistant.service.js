// Project clarifications and stakeholder contacts behind the assistant routes, plus inbound
// clarification mail replies. (The assistant's chats live in agent-chat.service.js.)
import { randomUUID } from 'node:crypto';
import { LIVE_EVENT_CHANNELS } from '../../lib/events/live-event-bus.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { PROJECT_CAPABILITIES, requireProjectCapability } from '../../lib/auth/project-capabilities.js';
import { buildOperationLogContext, logBackendError } from '../../lib/logging/backend-logger.js';
import { isProjectSoftDeleted } from '../projects/project-deletion.service.js';
import { DEFAULT_DIGEST_QUIET_MINUTES } from './clarification-invitation-digest.service.js';
import { normalizeInboundReplyBody as normalizeInboundClarificationReplyBody } from '../../lib/content/email-replies.js';
import { recordTopicReplies } from '../requirements/mentions/mentions.service.js';

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getPrimaryTenantId(user) {
  return user?.memberships?.[0]?.tenantId ?? null;
}

function requirePrimaryTenantId(user) {
  const tenantId = getPrimaryTenantId(user);
  if (!tenantId) {
    throw new HttpError(403, 'This account is not assigned to a tenant.');
  }

  return tenantId;
}

function extractClarificationReplyToken({ mailReplyDomain = '', toEmail = '' } = {}) {
  const normalizedEmail = String(toEmail ?? '').trim().toLowerCase();
  const match = normalizedEmail.match(/^clarification\+([^@]+)@([^@]+)$/i);
  if (!match) {
    return '';
  }

  const domain = String(match[2] ?? '').trim().toLowerCase();
  const expectedDomain = String(mailReplyDomain ?? '').trim().toLowerCase();
  if (expectedDomain && domain !== expectedDomain) {
    return '';
  }

  return String(match[1] ?? '').trim();
}

function resolveClarificationAttachmentUploader(clarification = {}, stakeholder = null) {
  const primaryUser = (clarification?.assignments ?? []).find((assignment) => {
    return assignment.actorType === 'user' && assignment.role === 'primary';
  }) ?? (clarification?.assignments ?? []).find((assignment) => assignment.actorType === 'user') ?? null;

  if (primaryUser?.actorId) {
    return {
      id: primaryUser.actorId,
      name: primaryUser.label || 'Project member',
    };
  }

  return {
    id: stakeholder?.id ?? 'clarification-mail-ingest',
    name: stakeholder?.name ?? 'Stakeholder',
  };
}

function clarificationAccessTokens(clarification = {}) {
  const tokens = new Set();

  if (clarification?.accessToken) {
    tokens.add(clarification.accessToken);
  }

  for (const assignment of clarification?.assignments ?? []) {
    if (assignment?.actorType === 'stakeholder' && assignment?.accessToken) {
      tokens.add(assignment.accessToken);
    }
    if (assignment?.actorType === 'stakeholder' && assignment?.invitationToken) {
      tokens.add(assignment.invitationToken);
    }
  }

  return [...tokens];
}

function publishProjectInvalidation(liveEventBus, projectId, reason = 'updated') {
  if (!liveEventBus || !projectId) {
    return;
  }

  liveEventBus.publish(LIVE_EVENT_CHANNELS.project(projectId), {
    actor: { id: 'odin-assistant', name: 'Odin assistant' },
    projectId,
    reason,
    type: 'project.assets.invalidated',
  });
}

function publishPublicClarificationInvalidations(liveEventBus, clarifications = [], reason = 'updated') {
  if (!liveEventBus) {
    return;
  }

  for (const clarification of clarifications ?? []) {
    for (const accessToken of clarificationAccessTokens(clarification)) {
      liveEventBus.publish(LIVE_EVENT_CHANNELS.publicClarification(accessToken), {
        clarificationId: clarification.id,
        reason,
        type: 'public.clarifications.invalidated',
      });
    }
  }
}

async function requireProjectContext(projectRepository, {
  capability = PROJECT_CAPABILITIES.READ,
  projectId,
  tenantId,
  user,
}) {
  if (!projectId) {
    return null;
  }

  await requireProjectCapability({ capability, projectId, repository: projectRepository, tenantId, user });
  const project = await projectRepository.getProjectDetail({
    projectId,
    tenantId,
  });

  if (!project) {
    throw new HttpError(404, 'Project not found.');
  }

  return project;
}

function userRoleForClarifications(user) {
  return String(user?.memberships?.[0]?.role ?? user?.role ?? 'user').trim().toLowerCase();
}

function canModerateClarifications(user) {
  return ['admin', 'manager'].includes(userRoleForClarifications(user));
}

function clarificationActor(actorId = '', actorType = 'user') {
  const normalizedActorId = String(actorId ?? '').trim();
  if (!normalizedActorId) {
    return null;
  }

  return {
    actorId: normalizedActorId,
    actorType: actorType === 'stakeholder' ? 'stakeholder' : 'user',
  };
}

function reactionForActor(comment = {}, actor = null) {
  if (!actor) {
    return null;
  }

  return (comment.reactionVotes ?? []).find((reaction) => {
    return reaction.actorId === actor.actorId
      && reaction.actorType === actor.actorType;
  })?.reaction ?? null;
}

function presentClarificationCommentForActor(comment = {}, actor = null) {
  const presented = {
    ...clone(comment),
    currentReaction: reactionForActor(comment, actor),
  };
  delete presented.reactionVotes;

  if (Array.isArray(comment.children)) {
    presented.children = comment.children.map((child) => presentClarificationCommentForActor(child, actor));
  }

  return presented;
}

function presentClarificationForActor(clarification = null, actor = null) {
  if (!clarification) {
    return null;
  }

  const presented = clone(clarification);
  presented.comments = (clarification.comments ?? []).map((comment) => presentClarificationCommentForActor(comment, actor));
  presented.answerThread = (clarification.answerThread ?? []).map((comment) => {
    const copy = {
      ...clone(comment),
      currentReaction: reactionForActor(comment, actor),
    };
    delete copy.reactionVotes;
    return copy;
  });
  return presented;
}

function presentClarificationsForActor(clarifications = [], actor = null) {
  return (clarifications ?? []).map((clarification) => presentClarificationForActor(clarification, actor));
}

export async function createProjectStakeholderContactForUser({
  assistantRepository,
  input,
  liveEventBus,
  projectId,
  projectRepository,
  user,
}) {
  const tenantId = requirePrimaryTenantId(user);
  await requireProjectContext(projectRepository, { capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectId, tenantId, user });

  if (!canModerateClarifications(user)) {
    throw new HttpError(403, 'Only managers can add clarification stakeholders.');
  }

  const contact = await assistantRepository.createProjectStakeholder({
    projectId,
    tenantId,
    value: {
      createdAt: nowIso(),
      email: input.email,
      id: randomUUID(),
      name: input.name,
      roleTitle: input.roleTitle ?? '',
    },
  });
  const projectAssistantState = await assistantRepository.getProjectAssistantState({
    projectId,
    tenantId,
  });

  publishProjectInvalidation(liveEventBus, projectId, 'stakeholder-contact-added');
  publishPublicClarificationInvalidations(liveEventBus, projectAssistantState?.clarifications ?? [], 'stakeholder-contact-added');

  return {
    contact,
    ok: true,
    stakeholderContacts: projectAssistantState?.stakeholderContacts ?? [],
    stakeholders: projectAssistantState?.stakeholders ?? projectAssistantState?.stakeholderContacts ?? [],
  };
}

export async function updateProjectStakeholderContactForUser({
  assistantRepository,
  input,
  liveEventBus,
  projectId,
  projectRepository,
  stakeholderId,
  user,
}) {
  const tenantId = requirePrimaryTenantId(user);
  await requireProjectContext(projectRepository, { capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectId, tenantId, user });

  if (!canModerateClarifications(user)) {
    throw new HttpError(403, 'Only managers can edit clarification stakeholders.');
  }

  const contact = await assistantRepository.updateProjectStakeholder({ patch: input, projectId, stakeholderId, tenantId });
  if (!contact) throw new HttpError(404, 'Stakeholder not found.');
  const projectAssistantState = await assistantRepository.getProjectAssistantState({ projectId, tenantId });

  publishProjectInvalidation(liveEventBus, projectId, 'stakeholder-contact-updated');
  publishPublicClarificationInvalidations(liveEventBus, projectAssistantState?.clarifications ?? [], 'stakeholder-contact-updated');

  return {
    contact,
    ok: true,
    stakeholderContacts: projectAssistantState?.stakeholderContacts ?? [],
    stakeholders: projectAssistantState?.stakeholders ?? projectAssistantState?.stakeholderContacts ?? [],
  };
}

export async function listProjectClarificationsForUser({
  assistantRepository,
  digestQuietMinutes = DEFAULT_DIGEST_QUIET_MINUTES,
  projectId,
  projectRepository,
  user,
}) {
  const tenantId = requirePrimaryTenantId(user);
  await requireProjectContext(projectRepository, { projectId, tenantId, user });

  const state = await assistantRepository.getProjectAssistantState({
    projectId,
    tenantId,
  });
  const actor = clarificationActor(user.id, 'user');

  return {
    clarifications: presentClarificationsForActor(state.clarifications, actor),
    // Invitations wait in a per-stakeholder digest; clients use this to explain delivery.
    invitationDigest: { quietMinutes: digestQuietMinutes },
    ok: true,
    stakeholderContacts: state.stakeholderContacts,
    stakeholders: state.stakeholders ?? state.stakeholderContacts,
  };
}

export async function ingestClarificationMailReply({
  assistantAiService,
  assistantRepository,
  inboundMailWebhookSecret = '',
  input,
  liveEventBus,
  mailReplyDomain = '',
  mentionsRepository = null,
  projectRepository,
  requestSecret = '',
}) {
  const expectedSecret = String(inboundMailWebhookSecret ?? '').trim();
  if (!expectedSecret || String(requestSecret ?? '').trim() !== expectedSecret) {
    throw new HttpError(401, 'Invalid inbound mail secret.');
  }

  const replyToken = extractClarificationReplyToken({
    mailReplyDomain,
    toEmail: input.toEmail,
  });
  if (!replyToken) {
    throw new HttpError(400, 'Clarification reply address is invalid.');
  }

  const resolved = await assistantRepository.resolveClarificationInvitationByReply({
    fromEmail: input.fromEmail,
    replyToken,
  });
  if (!resolved?.invitation || !resolved?.stakeholder) {
    throw new HttpError(404, 'Clarification invitation not found.');
  }

  const invitation = resolved.invitation;
  const stakeholder = resolved.stakeholder;
  if (await isProjectSoftDeleted(projectRepository, invitation)) {
    throw new HttpError(404, 'Clarification not found.');
  }
  const clarification = await assistantRepository.getProjectClarification({
    clarificationId: invitation.clarificationId,
    projectId: invitation.projectId,
    tenantId: invitation.tenantId,
  });
  if (!clarification) {
    throw new HttpError(404, 'Clarification not found.');
  }

  // Replies on a requirements topic count only while the stakeholder's requirements link
  // is live and the topic takes comments. Rejected replies are logged, not stored, and
  // acknowledged so the mail relay does not retry them.
  const requirementsBridge = assistantRepository.requirementsBridge ?? null;
  const tracked = await isTrackedClarification(null, {
    clarificationId: clarification.id,
    projectId: invitation.projectId,
    tenantId: invitation.tenantId,
  }, assistantRepository);
  if (tracked) {
    const linkStatus = await requirementsBridge.stakeholderLinkStatus({
      projectId: invitation.projectId,
      stakeholderId: stakeholder.id,
      tenantId: invitation.tenantId,
    });
    const acceptsComments = await requirementsBridge.topicAcceptsComments({
      projectId: invitation.projectId,
      status: clarification.status,
      tenantId: invitation.tenantId,
      topicId: clarification.id,
    });
    const reason = ['revoked', 'expired'].includes(linkStatus)
      ? 'requirements_link_inactive'
      : acceptsComments ? null : 'comments_closed';
    if (reason) {
      logBackendError({
        context: buildOperationLogContext('assistant.ingestClarificationMailReply.rejected', {
          clarificationId: clarification.id,
          invitationId: invitation.id,
          linkStatus,
          projectId: invitation.projectId,
          reason,
          tenantId: invitation.tenantId,
        }),
        error: new Error(`Inbound reply on a requirements topic was not stored: ${reason}.`),
        level: 'warn',
        message: 'Inbound requirements topic reply rejected.',
      });
      return {
        ignored: true,
        ok: true,
        reason,
      };
    }
  }

  const normalizedBody = normalizeInboundClarificationReplyBody({
    htmlBody: input.htmlBody,
    textBody: input.textBody,
  });
  const recordedMessage = await assistantRepository.recordClarificationEmailMessage({
    value: {
      direction: 'inbound',
      fromEmail: input.fromEmail,
      inReplyTo: input.inReplyTo,
      invitationId: invitation.id,
      normalizedBody,
      projectId: invitation.projectId,
      providerMessageId: input.messageId,
      subject: input.subject,
      tenantId: invitation.tenantId,
      toEmail: input.toEmail,
    },
  });

  if (recordedMessage?.duplicate) {
    return {
      duplicate: true,
      ok: true,
    };
  }

  const hasAttachments = Array.isArray(input.attachments) && input.attachments.length > 0;
  const commentBody = normalizedBody || (hasAttachments
    ? `Email reply included ${input.attachments.length} attachment${input.attachments.length === 1 ? '' : 's'}.`
    : '');
  if (!commentBody) {
    throw new HttpError(400, 'Inbound clarification email must include text or attachments.');
  }

  const comment = await assistantRepository.addProjectClarificationComment({
    clarificationId: invitation.clarificationId,
    comment: {
      actorId: stakeholder.id,
      actorType: 'stakeholder',
      authorName: stakeholder.name ?? 'Stakeholder',
      body: commentBody,
      source: 'email-reply',
    },
    preserveStatus: true,
    projectId: invitation.projectId,
    tenantId: invitation.tenantId,
  });
  await recordTopicReplies({ mentionsRepository }, {
    author: { actorId: stakeholder.id, actorType: 'stakeholder', name: stakeholder.name ?? 'Stakeholder' },
    clarification,
    commentId: comment?.id,
    projectId: invitation.projectId,
    tenantId: invitation.tenantId,
    topicId: invitation.clarificationId,
  });

  if (hasAttachments) {
    const uploader = resolveClarificationAttachmentUploader(clarification, stakeholder);
    for (const attachment of input.attachments ?? []) {
      const fileName = String(attachment?.fileName ?? '').trim();
      const contentBase64 = String(attachment?.contentBase64 ?? '').trim();
      if (!fileName || !contentBase64) {
        continue;
      }

      await projectRepository.saveFile({
        fileContentsBase64: contentBase64,
        fileDescription: `Email attachment from ${stakeholder.name ?? stakeholder.email ?? 'stakeholder'}`,
        fileName,
        fileType: String(attachment?.contentType ?? '').trim() || 'application/octet-stream',
        inlineImage: false,
        projectId: invitation.projectId,
        targetId: invitation.clarificationId,
        targetType: 'clarification',
        tenantId: invitation.tenantId,
        user: uploader,
      });
    }
  }

  await assistantRepository.markClarificationInvitationInbound({
    invitationId: invitation.id,
    projectId: invitation.projectId,
    providerMessageId: input.messageId,
    tenantId: invitation.tenantId,
  });

  const currentProject = await projectRepository.getProjectDetail({
    projectId: invitation.projectId,
    tenantId: invitation.tenantId,
  });
  const refreshedClarification = await assistantRepository.getProjectClarification({
    clarificationId: invitation.clarificationId,
    projectId: invitation.projectId,
    tenantId: invitation.tenantId,
  });

  if (!tracked && assistantAiService?.reviewClarificationDiscussion && refreshedClarification) {
    try {
      const review = await assistantAiService.reviewClarificationDiscussion({
        clarification: refreshedClarification,
        currentProject,
        explicit: false,
        tenantId: invitation.tenantId,
      });

      if (review && (String(review.comment ?? '').trim() || String(review.currentAnswer ?? '').trim())) {
        const reviewedAnswer = String(review.currentAnswer ?? '').trim();
        await assistantRepository.updateProjectClarification({
          clarificationId: invitation.clarificationId,
          patch: {
            ...(reviewedAnswer ? { currentAnswer: reviewedAnswer } : {}),
            latestInboundSuggestedAnswer: '',
            latestInboundSummary: String(review.comment ?? '').trim(),
            latestInboundSummaryCommentId: comment?.id ?? null,
          },
          projectId: invitation.projectId,
          tenantId: invitation.tenantId,
        });
      }
    } catch (error) {
      logBackendError({
        context: buildOperationLogContext('assistant.ingestClarificationMailReply.review', {
          clarificationId: invitation.clarificationId,
          invitationId: invitation.id,
          projectId: invitation.projectId,
          tenantId: invitation.tenantId,
        }),
        error,
        level: 'warn',
        message: 'Inbound clarification email review enrichment failed.',
      });
    }
  }

  const updatedClarification = await assistantRepository.getProjectClarification({
    clarificationId: invitation.clarificationId,
    projectId: invitation.projectId,
    tenantId: invitation.tenantId,
  });
  const projectAssistantState = await assistantRepository.getProjectAssistantState({
    projectId: invitation.projectId,
    tenantId: invitation.tenantId,
  });

  publishProjectInvalidation(liveEventBus, invitation.projectId, 'clarification-email-replied');
  publishPublicClarificationInvalidations(liveEventBus, projectAssistantState?.clarifications ?? [], 'clarification-email-replied');
  if (tracked) {
    await requirementsBridge.publishTopicChange({
      projectId: invitation.projectId,
      reason: 'topic-email-replied',
      tenantId: invitation.tenantId,
      topicIds: [clarification.id],
    });
  }

  return {
    clarification: updatedClarification,
    ok: true,
  };
}

// Requirements topics are clarifications with a track. On public token paths their status
// never changes as a side effect of a stakeholder's comment, and the older automatic
// discussion review (which can set a status) does not run for them (Q-04).
async function isTrackedClarification(resolveClarificationTrack, { clarificationId, projectId, tenantId }, assistantRepository = null) {
  const bridge = assistantRepository?.requirementsBridge ?? null;
  const resolve = resolveClarificationTrack ?? (bridge?.getTopicTrack ? (args) => bridge.getTopicTrack(args) : null);
  if (!resolve || !clarificationId) {
    return false;
  }
  return Boolean(await resolve({ clarificationId, projectId, tenantId }));
}

