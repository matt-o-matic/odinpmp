import { PROJECT_CAPABILITIES, requireProjectCapability } from '../../lib/auth/project-capabilities.js';
import { renderStoredRichTextToHtml } from '../../lib/content/rich-text.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { buildOperationLogContext, logBackendError } from '../../lib/logging/backend-logger.js';
import { placeMentions } from '../../lib/mentions/mention-markup.js';

function getPrimaryTenantId(user) {
  return user.memberships?.[0]?.tenantId ?? null;
}

function assertTenantId(user) {
  const tenantId = getPrimaryTenantId(user);

  if (!tenantId) {
    throw new HttpError(403, 'This account is not assigned to a tenant.');
  }

  return tenantId;
}

async function requireCommentCapability(user, projectId, repository, capability) {
  const tenantId = assertTenantId(user);
  await requireProjectCapability({ capability, projectId, repository, tenantId, user });
  return tenantId;
}

function normalizeRepositoryError(error) {
  if (error?.message === 'Forbidden') {
    throw new HttpError(403, 'Forbidden');
  }

  if (error?.message === 'Invalid comment target.' || error?.message === 'Invalid parent comment.') {
    throw new HttpError(400, error.message);
  }

  throw error;
}

function logCommentsRepositoryFailure({ error, operation, projectId, user, extra = {} }) {
  logBackendError({
    context: buildOperationLogContext(operation, {
      projectId,
      tenantId: getPrimaryTenantId(user),
      userId: user?.id ?? null,
      ...extra,
    }),
    error,
    level: 'warn',
    message: 'Comments repository operation failed.',
  });
}

// Comments are stored as HTML, as the editor writes them. Text without HTML (from the assistant or
// an API client) is read as Markdown, like item descriptions. Each person in `mentions` gets the
// editor's mention span, which is what emails them, if the mention picker would offer them.
async function commentHtml({ comment, mentions = [] }, { projectId, repository, tenantId }) {
  const html = renderStoredRichTextToHtml(comment);
  if (!mentions.length) return html;
  const mentionable = await repository.listMentionableUsers({ projectId, query: '', tenantId });
  const people = [...new Set(mentions)].map((userId) => mentionable.find((person) => person.id === userId));
  if (people.includes(undefined)) throw new HttpError(400, 'Mention only people who can be mentioned in this project.');
  return placeMentions(html, people);
}

export async function listMentionablesForUser(user, projectId, query, repository) {
  const tenantId = await requireCommentCapability(user, projectId, repository, PROJECT_CAPABILITIES.READ);
  return {
    ok: true,
    users: await repository.listMentionableUsers({
      projectId,
      query,
      tenantId,
    }),
  };
}

export async function listCommentsForUser(user, projectId, input, repository) {
  const tenantId = await requireCommentCapability(user, projectId, repository, PROJECT_CAPABILITIES.READ);
  return {
    comments: await repository.listComments({
      ...input,
      projectId,
      tenantId,
      user,
    }),
    ok: true,
  };
}

export async function addCommentForUser(user, projectId, input, repository) {
  const tenantId = await requireCommentCapability(user, projectId, repository, PROJECT_CAPABILITIES.COLLABORATE);
  const { mentions, ...fields } = input;
  const comment = await commentHtml(input, { projectId, repository, tenantId });
  try {
    return {
      comment: await repository.addComment({
        ...fields,
        comment,
        projectId,
        tenantId,
        user,
      }),
      ok: true,
    };
  } catch (error) {
    logCommentsRepositoryFailure({
      error,
      extra: {
        parentCommentId: input.parentCommentId ?? null,
        targetId: input.targetId,
        targetType: input.targetType,
      },
      operation: 'comments.add',
      projectId,
      user,
    });
    normalizeRepositoryError(error);
  }
}

export async function updateCommentForUser(user, projectId, commentId, input, repository) {
  const tenantId = await requireCommentCapability(user, projectId, repository, PROJECT_CAPABILITIES.COLLABORATE);
  const html = await commentHtml(input, { projectId, repository, tenantId });
  let comment = null;

  try {
    comment = await repository.updateComment({
      commentId,
      commentHtml: html,
      projectId,
      tenantId,
      user,
    });
  } catch (error) {
    logCommentsRepositoryFailure({
      error,
      extra: {
        commentId,
      },
      operation: 'comments.update',
      projectId,
      user,
    });
    normalizeRepositoryError(error);
  }

  if (!comment) {
    throw new HttpError(404, 'Comment not found.');
  }

  return {
    comment,
    ok: true,
  };
}

// withoutReplies: refuse (409) rather than take replies with it, as the assistant's undo asks.
// expectedTextHash: refuse (409) unless the text, as Odin returns it, has this SHA-256: someone
// edited it since.
export async function deleteCommentForUser(user, projectId, commentId, repository, { expectedTextHash, withoutReplies = false } = {}) {
  const tenantId = await requireCommentCapability(user, projectId, repository, PROJECT_CAPABILITIES.COLLABORATE);
  let deleted = false;

  try {
    deleted = await repository.deleteComment({
      commentId,
      expectedTextHash,
      projectId,
      tenantId,
      user,
      withoutReplies,
    });
  } catch (error) {
    logCommentsRepositoryFailure({
      error,
      extra: {
        commentId,
      },
      operation: 'comments.delete',
      projectId,
      user,
    });
    normalizeRepositoryError(error);
  }

  if (!deleted) {
    throw new HttpError(404, 'Comment not found.');
  }

  return {
    deletedCommentId: commentId,
    ok: true,
  };
}

export async function voteCommentForUser(user, projectId, commentId, input, repository) {
  const tenantId = await requireCommentCapability(user, projectId, repository, PROJECT_CAPABILITIES.COLLABORATE);
  let result = null;

  try {
    result = await repository.voteComment({
      commentId,
      projectId,
      tenantId,
      user,
      vote: input.vote,
    });
  } catch (error) {
    logCommentsRepositoryFailure({
      error,
      extra: {
        commentId,
        vote: input.vote,
      },
      operation: 'comments.vote',
      projectId,
      user,
    });
    normalizeRepositoryError(error);
  }

  if (!result) {
    throw new HttpError(404, 'Comment not found.');
  }

  return {
    ok: true,
    vote: result,
  };
}
