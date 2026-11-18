import { classifyBounce } from '../../mail/mail-bounce.js';
import { renderMentionDigestEmail } from '../../mail/mail.service.js';
import { findEmailOptOuts, isOptedOut } from '../../users/notification-preferences.js';
import {
  DEFAULT_DIGEST_QUIET_MINUTES,
  DIGEST_LEASE_MS,
  DIGEST_MAX_ATTEMPTS,
  DIGEST_RETRY_MS,
  digestQuietMs,
} from '../../assistant/clarification-invitation-digest.service.js';
import { findTopicComment, topicComments } from '../requirements-topics.js';
import { commentToEmailHtml } from '../../../lib/content/email-markdown.js';
import { commentPlainText, mentionedActors, mentionExcerpt } from './mention-tokens.js';

// Comments up to this many characters of text are quoted whole and formatted; longer ones
// are quoted as a plain excerpt around the tag.
const QUOTE_WHOLE_COMMENT_CHARS = 1200;
import { stakeholderSeesTopic, topicFollowers } from './mentions.service.js';

// Mention digests: everything that tagged one person in one project, and every new comment on
// a topic they own or commented on (a reply), in one email, under
// the same rules as clarification invitation digests (clarification-invitation-digest
// .service.js): the same quiet period, claim and lease, re-reads before rendering and
// again before SMTP, retries, bounces, and at-least-once delivery.
//
// Before every attempt each mention must still hold: its comment exists, isn't removed and
// still tags the recipient; its topic or round still exists; the recipient can still open
// it (a project member, or a stakeholder who can see the topic or still reviews the round);
// the recipient has an email that hasn't opted out, and team members haven't turned off
// mention emails. A reply needs, instead of the tag, that the recipient still owns the topic
// or has a comment on it and hasn't commented on it since; team members can turn reply
// emails off separately. Entries that fail are released for good, with the reason.

export const MENTION_RELEASE_REASONS = Object.freeze({
  commentRemoved: 'mention digest: the comment was removed',
  linkRevoked: 'mention digest: the stakeholder requirements link is revoked',
  mentionsOff: 'mention digest: the user turned off mention emails',
  noAccess: 'mention digest: the recipient can no longer open it',
  noEmail: 'mention digest: the recipient has no email address',
  notFollowing: 'mention digest: the recipient no longer owns or comments on the topic',
  optedOut: 'mention digest: the email address opted out or bounced',
  repliedSince: 'mention digest: the recipient has commented on the topic since',
  repliesOff: 'mention digest: the user turned off topic reply emails',
  sourceMissing: 'mention digest: the topic or round no longer exists',
  untagged: 'mention digest: the comment no longer tags the recipient',
});

function normalizeBaseUrl(value) {
  return String(value ?? '').trim().replace(/\/+$/, '');
}

const recipientOf = ({ projectId, recipientId, recipientType, tenantId }) => ({ projectId, recipientId, recipientType, tenantId });

/** Sends every mention digest whose quiet period has passed. Safe to run concurrently and to rerun. */
export async function flushDueMentionDigests({
  assistantRepository,
  authRepository = null,
  env = {},
  frontendAppUrl = '',
  limit = 50,
  logger = null,
  mailRepository,
  mentionsRepository,
  now = () => new Date(),
  projectRepository = null,
  quietMinutes = DEFAULT_DIGEST_QUIET_MINUTES,
  roundsRepository = null,
  transport,
} = {}) {
  const summary = { deferred: 0, due: 0, errors: 0, failed: 0, retried: 0, sent: 0, skipped: 0 };
  if (!mentionsRepository?.listDueMentionDigests || !transport?.sendMail) return summary;
  const clock = typeof now === 'function' ? now : () => new Date(now);
  const quietMs = digestQuietMs(quietMinutes);
  const at = clock();
  const due = await mentionsRepository.listDueMentionDigests({ dueBefore: new Date(at.getTime() - quietMs), limit, now: at });
  summary.due = due.length;

  const deps = { assistantRepository, authRepository, frontendAppUrl, mailRepository, mentionsRepository, projectRepository, roundsRepository };
  for (const entry of due) {
    const recipient = recipientOf(entry);
    try {
      const outcome = await deliverDigest({ clock, deps, env, logger, quietMs, recipient, transport });
      summary[outcome] += 1;
    } catch (error) {
      // An unclaimed failure needs nothing; a claimed one expires and is retried by a later run.
      summary.errors += 1;
      logger?.logError?.({ context: recipient, error, level: 'warn', message: 'Mention digest could not be delivered.' });
    }
  }
  return summary;
}

async function deliverDigest({ clock, deps, env, logger, quietMs, recipient, transport }) {
  const { mentionsRepository } = deps;
  const claimedAt = clock();
  const claim = await mentionsRepository.claimMentionDigest({
    ...recipient,
    dueBefore: new Date(claimedAt.getTime() - quietMs),
    leaseUntil: new Date(claimedAt.getTime() + DIGEST_LEASE_MS),
    now: claimedAt,
  });
  if (!claim) return 'deferred';
  const owner = { ...recipient, claimToken: claim.claimToken, deliveryId: claim.deliveryId };
  if (claim.interruptedSend) {
    logger?.logEvent?.({ context: { ...recipient, deliveryId: claim.deliveryId }, message: 'A previous mention digest attempt stopped while sending and may have been delivered; sending it again.' });
  }

  const prepared = await prepareDigest(deps, recipient);
  if (!prepared.message) {
    await mentionsRepository.releaseMentionDigest({ ...owner, now: clock(), released: await confirmedReleases(deps, recipient, prepared) });
    return 'skipped';
  }

  // Everything the email depends on must still be what it was rendered from; anything that
  // changed meanwhile cancels this attempt and the next run renders again.
  let unchanged = false;
  try {
    unchanged = (await currentDecision(deps, recipient, prepared)).basis === prepared.basis;
  } finally {
    if (!unchanged) await mentionsRepository.abortMentionDigestSend({ ...owner, now: clock() });
  }
  if (!unchanged) return 'deferred';

  // The last step before SMTP, on a fresh clock with nothing awaited in between: the claim
  // must still be ours, the newest mention's deadline must have passed, and every mention in
  // the email must still be pending.
  const sendingAt = clock();
  const begun = await mentionsRepository.beginMentionDigestSend({
    ...owner,
    dueBefore: new Date(sendingAt.getTime() - quietMs),
    leaseUntil: new Date(sendingAt.getTime() + DIGEST_LEASE_MS),
    now: sendingAt,
    sendIds: prepared.sendIds,
  });
  if (!begun.ok) return 'deferred';

  let info;
  try {
    info = await transport.sendMail({
      from: { address: env.mailFromAddress, name: env.mailFromName },
      html: prepared.message.html,
      subject: prepared.message.subject,
      to: prepared.message.to,
    });
  } catch (error) {
    const reason = String(error?.message ?? error);
    const bounceType = classifyBounce(reason);
    await deps.mailRepository?.logBounce?.({ bounceType, email: prepared.message.to, reason });
    if (bounceType === 'hard') await deps.mailRepository?.optOutEmail?.({ email: prepared.message.to });
    const failedAt = clock();
    const result = await mentionsRepository.failMentionDigestAttempt({
      ...owner,
      error: reason,
      maxAttempts: DIGEST_MAX_ATTEMPTS,
      mentionIds: prepared.sendIds,
      now: failedAt,
      retryAt: bounceType === 'hard' ? null : new Date(failedAt.getTime() + DIGEST_RETRY_MS * (claim.attempts + 1)),
    });
    if (result.fenced) return 'deferred';
    return result.terminal ? 'failed' : 'retried';
  }

  // The email went out: record it even if the release check cannot run.
  let released = [];
  try {
    released = await confirmedReleases(deps, recipient, prepared);
  } catch (error) {
    logger?.logError?.({ context: { ...recipient, deliveryId: claim.deliveryId }, error, level: 'warn', message: 'Mention digest sent; releasing left-out mentions is deferred to the next run.' });
  }
  await mentionsRepository.completeMentionDigestSend({
    ...owner,
    now: clock(),
    providerMessageId: String(info?.messageId ?? ''),
    released,
    sentIds: prepared.sendIds,
  });
  return 'sent';
}

/** Reads, without side effects, everything this recipient's digest depends on. */
async function readDigestState(deps, recipient) {
  const { projectId, recipientId, recipientType, tenantId } = recipient;
  const mentions = await deps.mentionsRepository.listPendingMentions(recipient);
  const read = { comments: new Map(), email: '', mentions, name: '', optedOut: false, mentionsOff: false, repliesOff: false, rounds: new Map(), annotations: new Map(), clarifications: new Map(), canOpen: () => false };
  if (!mentions.length) return read;

  const needsTopics = mentions.some((mention) => mention.sourceType === 'topic');
  const state = needsTopics ? await deps.assistantRepository.getProjectAssistantState({ projectId, tenantId }) : null;
  for (const clarification of state?.clarifications ?? []) read.clarifications.set(clarification.id, clarification);

  for (const mention of mentions.filter((entry) => entry.sourceType === 'annotation')) {
    if (!read.rounds.has(mention.roundId)) read.rounds.set(mention.roundId, await deps.roundsRepository?.getRound?.({ projectId, roundId: mention.roundId, tenantId }) ?? null);
    if (!read.annotations.has(mention.annotationId)) read.annotations.set(mention.annotationId, await deps.roundsRepository?.getAnnotation?.({ annotationId: mention.annotationId }) ?? null);
    if (!read.comments.has(mention.commentId)) read.comments.set(mention.commentId, await deps.roundsRepository?.getComment?.({ commentId: mention.commentId }) ?? null);
  }

  if (recipientType === 'user') {
    const valid = await deps.projectRepository?.getValidUsers?.({ projectId, tenantId });
    const member = (valid?.project_users ?? []).find((entry) => String(entry?.id) === String(recipientId)) ?? null;
    read.email = String(member?.email ?? '').trim();
    read.name = String(member?.name ?? '').trim();
    read.canOpen = () => Boolean(member);
    if (member) {
      const readPreferences = deps.authRepository?.listUserPreferences?.bind(deps.authRepository);
      const optOuts = await findEmailOptOuts({ kind: 'mentions', read: readPreferences, userIds: [recipientId] });
      read.mentionsOff = isOptedOut(optOuts, { userId: recipientId });
      if (mentions.some((mention) => mention.reason === 'reply')) {
        read.repliesOff = isOptedOut(await findEmailOptOuts({ kind: 'topicReplies', read: readPreferences, userIds: [recipientId] }), { userId: recipientId });
      }
    }
  } else {
    const stakeholders = await deps.assistantRepository.listProjectStakeholders({ projectId, tenantId });
    const stakeholder = (stakeholders ?? []).find((entry) => entry.id === recipientId) ?? null;
    read.email = String(stakeholder?.email ?? '').trim();
    read.name = String(stakeholder?.name ?? '').trim();
    read.canOpen = (mention) => {
      if (!stakeholder) return false;
      if (mention.sourceType === 'topic') return stakeholderSeesTopic(read.clarifications.get(mention.topicId), recipientId);
      const round = read.rounds.get(mention.roundId);
      return Boolean(round?.reviewers?.some((reviewer) => reviewer.actorType === 'stakeholder' && reviewer.actorId === recipientId && !reviewer.removedAt));
    };
  }
  read.optedOut = Boolean(read.email && await deps.mailRepository?.isOptedOut?.({ email: read.email }));
  return read;
}

function sourceOf(read, mention) {
  if (mention.sourceType === 'topic') {
    const clarification = read.clarifications.get(mention.topicId) ?? null;
    if (!clarification?.prompt || clarification.status === 'dismissed') return { missing: true };
    return { clarification, comment: findTopicComment(clarification, mention.commentId), where: `Topic: ${clarification.prompt}` };
  }
  const round = read.rounds.get(mention.roundId) ?? null;
  const annotation = read.annotations.get(mention.annotationId) ?? null;
  if (!round || round.status === 'draft' || !annotation || annotation.deletedAt) return { missing: true };
  const comment = read.comments.get(mention.commentId) ?? null;
  return { comment: comment?.annotationId === annotation.id ? comment : null, round, where: `Review round ${round.number}: a comment on a screen` };
}

const releaseOf = (mention, reason) => ({ id: mention.id, reason });
const toTime = (value) => (value ? new Date(value).getTime() || 0 : 0);

/** Whether the recipient owns the topic, and why a reply no longer goes to them (or null). */
function replyStanding(source, actorRef) {
  const owner = topicFollowers(source.clarification).some((entry) => entry.actorRef === actorRef && entry.owner);
  const own = topicComments(source.clarification).filter((comment) => !comment.deletedAt && !comment.isDeleted && `${comment.actorType}:${comment.actorId}` === actorRef);
  const after = toTime(source.comment.createdAt);
  if (after && own.some((comment) => toTime(comment.createdAt) > after)) return { owner, reason: MENTION_RELEASE_REASONS.repliedSince };
  return { owner, reason: owner || own.length ? null : MENTION_RELEASE_REASONS.notFollowing };
}
const releaseKey = (entry) => JSON.stringify([entry.id, entry.reason]);

/** Which pending mentions go in the email and which are released, and why. */
function decideDigest(read, recipient, { linkUsable }) {
  const actorRef = `${recipient.recipientType}:${recipient.recipientId}`;
  const released = [];
  let included = [];
  for (const mention of read.mentions) {
    const source = sourceOf(read, mention);
    const body = source.comment?.body ?? '';
    const isReply = mention.reason === 'reply';
    const removed = !source.missing && (!source.comment || source.comment.deletedAt || source.comment.isDeleted);
    const standing = isReply && !source.missing && !removed ? replyStanding(source, actorRef) : null;
    const reason = source.missing ? MENTION_RELEASE_REASONS.sourceMissing
      : removed ? MENTION_RELEASE_REASONS.commentRemoved
        : isReply ? standing.reason
          : !mentionedActors(body).some((entry) => entry.actorRef === actorRef) ? MENTION_RELEASE_REASONS.untagged
            : null;
    const finalReason = reason ?? (read.canOpen(mention) ? null : MENTION_RELEASE_REASONS.noAccess);
    if (finalReason) released.push(releaseOf(mention, finalReason));
    else included.push({ body, mention, relation: isReply ? (standing.owner ? 'owner' : 'contributor') : 'tagged', source });
  }
  const leaveOut = (reason, applies = () => true) => {
    const kept = [];
    for (const entry of included) {
      if (applies(entry)) released.push(releaseOf(entry.mention, reason));
      else kept.push(entry);
    }
    included = kept;
  };
  const isReplyEntry = ({ mention }) => mention.reason === 'reply';
  if (included.length && !read.email) leaveOut(MENTION_RELEASE_REASONS.noEmail);
  if (included.length && read.optedOut) leaveOut(MENTION_RELEASE_REASONS.optedOut);
  if (included.length && read.mentionsOff) leaveOut(MENTION_RELEASE_REASONS.mentionsOff, (entry) => !isReplyEntry(entry));
  if (included.length && read.repliesOff) leaveOut(MENTION_RELEASE_REASONS.repliesOff, isReplyEntry);
  if (included.length && recipient.recipientType === 'stakeholder' && !linkUsable) leaveOut(MENTION_RELEASE_REASONS.linkRevoked);
  return { included, released };
}

function digestBasis(read, decision) {
  return JSON.stringify({
    email: read.email,
    included: decision.included.map(({ body, mention, relation, source }) => [mention.id, mention.scheduledAt, mention.authorName, relation, body, source.where]),
    name: read.name,
    released: decision.released.map((entry) => [entry.id, entry.reason]),
  });
}

/** Re-reads current state and decides again, checking the issued portal link without issuing another. */
async function currentDecision(deps, recipient, prepared) {
  const read = await readDigestState(deps, recipient);
  let linkUsable = true;
  if (recipient.recipientType === 'stakeholder') {
    const bridge = deps.assistantRepository?.requirementsBridge ?? null;
    const scope = { projectId: recipient.projectId, stakeholderId: recipient.recipientId, tenantId: recipient.tenantId };
    linkUsable = prepared.issued
      ? Boolean(await bridge?.invitationUrlUsable?.({ ...prepared.issued, ...scope }))
      : (bridge?.stakeholderLinkStatus ? await bridge.stakeholderLinkStatus(scope) !== 'revoked' : false);
  }
  const decision = decideDigest(read, recipient, { linkUsable });
  return { basis: digestBasis(read, decision), decision };
}

/** The releases decided while preparing that still hold now. */
async function confirmedReleases(deps, recipient, prepared) {
  if (!prepared.released.length) return [];
  const current = new Set((await currentDecision(deps, recipient, prepared)).decision.released.map(releaseKey));
  return prepared.released.filter((entry) => current.has(releaseKey(entry)));
}

function itemUrl(deps, recipient, { mention, source }, issued) {
  if (recipient.recipientType === 'stakeholder') {
    if (!issued?.url) return '';
    return mention.sourceType === 'topic'
      ? `${issued.url}/questions/${encodeURIComponent(mention.topicId)}`
      : `${issued.url}/rounds/${encodeURIComponent(mention.roundId)}`;
  }
  const base = `${normalizeBaseUrl(deps.frontendAppUrl)}/projects/${encodeURIComponent(recipient.projectId)}/requirements`;
  return mention.sourceType === 'topic'
    ? `${base}/topics/${encodeURIComponent(mention.topicId)}`
    : `${base}/review/rounds/${encodeURIComponent(mention.roundId)}/review`;
}

/** Re-reads everything for this recipient and renders the email. */
async function prepareDigest(deps, recipient) {
  const read = await readDigestState(deps, recipient);
  let decision = decideDigest(read, recipient, { linkUsable: true });

  // Stakeholders get one fresh portal link per digest, as invitation digests do.
  let issued = null;
  if (recipient.recipientType === 'stakeholder' && decision.included.length) {
    const bridge = deps.assistantRepository?.requirementsBridge ?? null;
    issued = await bridge?.issueInvitationUrl?.({ projectId: recipient.projectId, stakeholderId: recipient.recipientId, tenantId: recipient.tenantId }) ?? null;
    if (!issued) decision = decideDigest(read, recipient, { linkUsable: false });
  }
  const basis = digestBasis(read, decision);
  const sendIds = decision.included.map(({ mention }) => mention.id);
  if (!decision.included.length) return { basis, issued, message: null, released: decision.released, sendIds: [] };

  const actorRef = `${recipient.recipientType}:${recipient.recipientId}`;
  const project = await deps.projectRepository?.getProjectDetail?.({ projectId: recipient.projectId, tenantId: recipient.tenantId }) ?? null;
  const message = await renderMentionDigestEmail({
    digest: {
      mentions: decision.included.map((entry) => ({
        authorName: entry.mention.authorName,
        commentHtml: commentPlainText(entry.body).length <= QUOTE_WHOLE_COMMENT_CHARS ? commentToEmailHtml(entry.body) : '',
        excerpt: mentionExcerpt(entry.body, actorRef),
        relation: entry.relation,
        url: itemUrl(deps, recipient, entry, issued),
        where: entry.source.where,
      })),
      projectName: project?.name ?? 'Project',
      recipientEmail: read.email,
      recipientName: read.name,
    },
    mailRepository: deps.mailRepository,
  });
  return { basis, issued, message, released: decision.released, sendIds };
}
