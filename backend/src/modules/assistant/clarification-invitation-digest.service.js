import { classifyBounce } from '../mail/mail-bounce.js';
import { renderClarificationDigestEmail } from '../mail/mail.service.js';

// Clarification invitation digests. A save that invites stakeholders schedules them into
// their digest for that project in the same write (assistant.repository.js). The mail job
// delivers a digest once the stakeholder has had no new assignment in that project for more
// than the quiet period, with no maximum wait.
//
// Every attempt, including retries, claims the recipient's delivery, re-reads the topics,
// the stakeholder and their access, renders the email from that current state, re-checks the
// deadline and its claim under lock, reads the recipient, access and topics once more to
// confirm nothing the email depends on changed while it was prepared, and only then sends
// through the transport. Invitations left out are released only if that still holds, and
// only by the current owner. Digests do not go through the shared mail queue, so nothing
// stored earlier can be sent stale.
//
// Delivery is at least once, not exactly once: if SMTP accepts the message and the process
// stops before the database records it, the next attempt sends the digest again.

export const DEFAULT_DIGEST_QUIET_MINUTES = 20;
// Longer than the mail transport's worst-case send (nodemailer's 10-minute socket timeout),
// so a live sender is not overtaken; an expired claim is taken over by the next run.
export const DIGEST_LEASE_MS = 20 * 60 * 1000;
export const DIGEST_MAX_ATTEMPTS = 3;
export const DIGEST_RETRY_MS = 5 * 60 * 1000;
const CLOSED_STATUSES = new Set(['closed', 'dismissed', 'resolved']);

export const DIGEST_RELEASE_REASONS = Object.freeze({
  linkRevoked: 'digest: the stakeholder requirements link is revoked',
  notAssigned: 'digest: the stakeholder is no longer assigned',
  noEmail: 'digest: the stakeholder has no email address',
  optedOut: 'digest: the stakeholder email address opted out or bounced',
  topicClosed: 'digest: the clarification is closed',
  topicMissing: 'digest: the clarification no longer exists',
});

function normalizeBaseUrl(value) {
  const normalized = String(value ?? '').trim();
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

export function buildClarificationPortalUrl({ accessToken, frontendAppUrl = '' } = {}) {
  const normalizedToken = String(accessToken ?? '').trim();
  if (!normalizedToken) return '';
  const base = normalizeBaseUrl(frontendAppUrl);
  return base ? `${base}/clarifications/${normalizedToken}` : `/clarifications/${normalizedToken}`;
}

export function buildClarificationReplyAddress({ mailReplyDomain = '', replyToken = '' } = {}) {
  const normalizedDomain = String(mailReplyDomain ?? '').trim().toLowerCase();
  const normalizedReplyToken = String(replyToken ?? '').trim();
  if (!normalizedDomain || !normalizedReplyToken) return '';
  return `clarification+${normalizedReplyToken}@${normalizedDomain}`;
}

export function digestQuietMs(quietMinutes = DEFAULT_DIGEST_QUIET_MINUTES) {
  const minutes = Number(quietMinutes);
  return (Number.isFinite(minutes) && minutes >= 0 ? minutes : DEFAULT_DIGEST_QUIET_MINUTES) * 60 * 1000;
}

/**
 * Schedules every never-sent invitation for the given clarifications (null: the whole
 * project) as a standalone write. Saves that invite stakeholders schedule inside their own
 * write instead; this is for a session commit that saved nothing itself.
 */
export async function scheduleClarificationInvitationDigests({ assistantRepository, clarificationIds = null, now = new Date(), projectId, tenantId } = {}) {
  if (!assistantRepository?.scheduleClarificationInvitations || !projectId || !tenantId) return [];
  return assistantRepository.scheduleClarificationInvitations({ clarificationIds, projectId, scheduledAt: new Date(now), tenantId });
}

/** Sends every digest whose quiet period has passed. Safe to run concurrently and to rerun. */
export async function flushDueClarificationInvitationDigests({
  assistantRepository,
  env = {},
  frontendAppUrl = '',
  limit = 50,
  logger = null,
  mailReplyDomain = '',
  mailRepository,
  now = () => new Date(),
  projectRepository = null,
  quietMinutes = DEFAULT_DIGEST_QUIET_MINUTES,
  transport,
} = {}) {
  const summary = { deferred: 0, due: 0, errors: 0, failed: 0, retried: 0, sent: 0, skipped: 0 };
  if (!assistantRepository?.listDueClarificationInvitationDigests || !transport?.sendMail) return summary;
  const clock = typeof now === 'function' ? now : () => new Date(now);
  const quietMs = digestQuietMs(quietMinutes);
  const at = clock();
  const due = await assistantRepository.listDueClarificationInvitationDigests({ dueBefore: new Date(at.getTime() - quietMs), limit, now: at });
  summary.due = due.length;

  for (const recipient of due) {
    try {
      const outcome = await deliverDigest({ assistantRepository, clock, env, frontendAppUrl, logger, mailReplyDomain, mailRepository, projectRepository, quietMs, recipient, transport });
      summary[outcome] += 1;
    } catch (error) {
      // An unclaimed failure needs nothing; a claimed one expires and is retried by a later run.
      summary.errors += 1;
      logger?.logError?.({
        context: { projectId: recipient.projectId, stakeholderId: recipient.stakeholderId, tenantId: recipient.tenantId },
        error,
        level: 'warn',
        message: 'Clarification invitation digest could not be delivered.',
      });
    }
  }
  return summary;
}

async function deliverDigest({ assistantRepository, clock, env, frontendAppUrl, logger, mailReplyDomain, mailRepository, projectRepository, quietMs, recipient, transport }) {
  const { projectId, stakeholderId, tenantId } = recipient;
  const claimedAt = clock();
  const claim = await assistantRepository.claimClarificationInvitationDigest({
    dueBefore: new Date(claimedAt.getTime() - quietMs),
    leaseUntil: new Date(claimedAt.getTime() + DIGEST_LEASE_MS),
    now: claimedAt,
    projectId,
    stakeholderId,
    tenantId,
  });
  if (!claim) return 'deferred';
  const owner = { claimToken: claim.claimToken, deliveryId: claim.deliveryId, projectId, stakeholderId, tenantId };
  if (claim.interruptedSend) {
    logger?.logEvent?.({
      context: { deliveryId: claim.deliveryId, projectId, stakeholderId, tenantId },
      message: 'A previous clarification digest attempt stopped while sending and may have been delivered; sending it again.',
    });
  }

  const context = { assistantRepository, frontendAppUrl, mailReplyDomain, mailRepository, projectId, projectRepository, stakeholderId, tenantId };
  const prepared = await prepareDigest(context);
  if (!prepared.message) {
    await assistantRepository.releaseClarificationDigest({ ...owner, now: clock(), released: await confirmedReleases(context, prepared) });
    return 'skipped';
  }

  // The recipient, their access and every topic's state must still be what the email was
  // rendered from. Anything that changed while it was being prepared (a revoked link, a new
  // address, an edited, closed or unassigned topic) cancels this attempt, and the next run
  // renders again from current state.
  let unchanged = false;
  try {
    unchanged = (await currentDecision(context, prepared)).basis === prepared.basis;
  } finally {
    if (!unchanged) await assistantRepository.abortClarificationDigestSend({ ...owner, now: clock() });
  }
  if (!unchanged) return 'deferred';

  // The last step before SMTP, after every asynchronous check, on a fresh clock and with
  // nothing awaited in between: under lock, the claim must still be ours, the newest
  // assignment's deadline must have passed, and every invitation in the email must still be
  // scheduled and unsent. fenced: another sender owns it now; not-due: a newer assignment
  // pushed the digest back; changed: the topics moved since rendering. Each releases the
  // attempt and the next run renders again.
  const sendingAt = clock();
  const begun = await assistantRepository.beginClarificationDigestSend({
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
      replyTo: prepared.message.replyTo,
      subject: prepared.message.subject,
      to: prepared.message.to,
    });
  } catch (error) {
    const reason = String(error?.message ?? error);
    const bounceType = classifyBounce(reason);
    await mailRepository?.logBounce?.({ bounceType, email: prepared.message.to, reason });
    if (bounceType === 'hard') await mailRepository?.optOutEmail?.({ email: prepared.message.to });
    const failedAt = clock();
    const result = await assistantRepository.failClarificationDigestAttempt({
      ...owner,
      error: reason,
      invitationIds: prepared.sendIds,
      maxAttempts: DIGEST_MAX_ATTEMPTS,
      now: failedAt,
      retryAt: bounceType === 'hard' ? null : new Date(failedAt.getTime() + DIGEST_RETRY_MS * (claim.attempts + 1)),
    });
    if (result.fenced) return 'deferred';
    return result.terminal ? 'failed' : 'retried';
  }

  // The email went out: record it even if the release check cannot run.
  let released = [];
  try {
    released = await confirmedReleases(context, prepared);
  } catch (error) {
    logger?.logError?.({ context: { deliveryId: claim.deliveryId, projectId, stakeholderId, tenantId }, error, level: 'warn', message: 'Clarification digest sent; releasing left-out invitations is deferred to the next run.' });
  }
  await assistantRepository.completeClarificationDigestSend({
    ...owner,
    now: clock(),
    providerMessageId: String(info?.messageId ?? ''),
    released,
    sentIds: prepared.sendIds,
  });
  return 'sent';
}

/** Reads, without side effects, everything a digest for this tenant, project and stakeholder depends on. */
async function readDigestState({ assistantRepository, mailRepository, projectId, stakeholderId, tenantId }) {
  const state = await assistantRepository.getProjectAssistantState({ projectId, tenantId });
  const stakeholder = (state?.stakeholders ?? []).find((entry) => entry.id === stakeholderId)
    ?? await assistantRepository.findProjectStakeholderById?.({ projectId, stakeholderId, tenantId })
    ?? null;
  const invitations = (await assistantRepository.listClarificationInvitations({ projectId, tenantId }))
    .filter((invitation) => invitation.stakeholderId === stakeholderId && !invitation.deactivatedAt && !invitation.queuedAt && invitation.mailStatus === 'pending' && invitation.scheduledAt)
    .sort((left, right) => String(left.scheduledAt).localeCompare(String(right.scheduledAt)));
  const email = String(stakeholder?.email ?? '').trim();
  const bridge = assistantRepository.requirementsBridge ?? null;
  return {
    bridge,
    clarificationById: new Map((state?.clarifications ?? []).map((clarification) => [clarification.id, clarification])),
    email,
    invitations,
    optedOut: Boolean(email && invitations.length && await mailRepository?.isOptedOut?.({ email })),
    stakeholder,
    trackedIds: invitations.length && bridge?.listTrackedTopicIds ? await bridge.listTrackedTopicIds({ projectId, tenantId }) : new Set(),
  };
}

const releaseOf = (invitation, reason) => ({ id: invitation.id, reason, scheduledAt: invitation.scheduledAt });
const releaseKey = (entry) => JSON.stringify([entry.id, entry.reason, entry.scheduledAt]);

/**
 * Which scheduled invitations go in the email and which are released, and why.
 * trackedUsable: whether Requirements topics can get a working portal link.
 */
function decideDigest(read, { stakeholderId, trackedUsable }) {
  const released = [];
  let included = [];
  for (const invitation of read.invitations) {
    const clarification = read.clarificationById.get(invitation.clarificationId);
    const reason = !clarification?.prompt ? DIGEST_RELEASE_REASONS.topicMissing
      : CLOSED_STATUSES.has(String(clarification.status ?? '').toLowerCase()) ? DIGEST_RELEASE_REASONS.topicClosed
        : !(clarification.assignments ?? []).some((assignment) => assignment.actorType === 'stakeholder' && assignment.actorId === stakeholderId) ? DIGEST_RELEASE_REASONS.notAssigned
          : null;
    if (reason) released.push(releaseOf(invitation, reason));
    else included.push({ clarification, invitation });
  }
  const leaveOut = (reason, keep = () => false) => {
    released.push(...included.filter((entry) => !keep(entry)).map(({ invitation }) => releaseOf(invitation, reason)));
    included = included.filter(keep);
  };
  if (included.length && !read.email) leaveOut(DIGEST_RELEASE_REASONS.noEmail);
  if (included.length && read.optedOut) leaveOut(DIGEST_RELEASE_REASONS.optedOut);
  // A revoked link is not reopened by an assignment, so those topics are left out.
  if (!trackedUsable) leaveOut(DIGEST_RELEASE_REASONS.linkRevoked, ({ clarification }) => !read.trackedIds.has(clarification.id));
  return { included, released };
}

/** Everything the rendered email and the release decisions depend on, as one comparable value. */
function digestBasis(read, decision) {
  return JSON.stringify({
    email: read.email,
    included: decision.included.map(({ clarification, invitation }) => [
      invitation.id, invitation.scheduledAt, clarification.id, clarification.prompt, clarification.rationale ?? '', read.trackedIds.has(clarification.id),
    ]),
    name: read.stakeholder?.name ?? '',
    released: decision.released.map((entry) => [entry.id, entry.reason, entry.scheduledAt]),
  });
}

/** Re-reads current state and decides again, checking the issued portal link without issuing another. */
async function currentDecision(context, prepared) {
  const { projectId, stakeholderId, tenantId } = context;
  const read = await readDigestState(context);
  let trackedUsable = false;
  if (prepared.issued) {
    trackedUsable = Boolean(await read.bridge?.invitationUrlUsable?.({ ...prepared.issued, projectId, stakeholderId, tenantId }));
  } else if (read.bridge?.stakeholderLinkStatus) {
    // No link was issued: either no topic needed one, or the link was revoked.
    trackedUsable = await read.bridge.stakeholderLinkStatus({ projectId, stakeholderId, tenantId }) !== 'revoked';
  }
  const decision = decideDigest(read, { stakeholderId, trackedUsable });
  return { basis: digestBasis(read, decision), decision };
}

/** The releases decided while preparing that still hold now; a topic that became eligible meanwhile stays scheduled. */
async function confirmedReleases(context, prepared) {
  if (!prepared.released.length) return [];
  const current = new Set((await currentDecision(context, prepared)).decision.released.map(releaseKey));
  return prepared.released.filter((entry) => current.has(releaseKey(entry)));
}

/** Re-reads everything for this tenant, project and stakeholder and renders the email. */
async function prepareDigest(context) {
  const { frontendAppUrl, mailReplyDomain, mailRepository, projectId, projectRepository, stakeholderId, tenantId } = context;
  const read = await readDigestState(context);
  let decision = decideDigest(read, { stakeholderId, trackedUsable: true });

  // Requirements topics share one fresh portal link.
  let issued = null;
  if (decision.included.some(({ clarification }) => read.trackedIds.has(clarification.id))) {
    issued = await read.bridge.issueInvitationUrl({ projectId, stakeholderId, tenantId });
    if (!issued) decision = decideDigest(read, { stakeholderId, trackedUsable: false });
  }
  const basis = digestBasis(read, decision);
  const sendIds = decision.included.map(({ invitation }) => invitation.id);
  // One entry per topic, even if a race left two active invitations for it.
  const seen = new Set();
  const topics = decision.included.filter(({ clarification }) => !seen.has(clarification.id) && seen.add(clarification.id));
  if (!topics.length) return { basis, issued, message: null, released: decision.released, sendIds: [] };

  const project = await projectRepository?.getProjectDetail?.({ projectId, tenantId }) ?? null;
  const message = await renderClarificationDigestEmail({
    digest: {
      projectName: project?.name ?? 'Project',
      stakeholderEmail: read.email,
      stakeholderName: read.stakeholder.name ?? 'Stakeholder',
      topics: topics.map(({ clarification, invitation }) => ({
        prompt: clarification.prompt,
        rationale: clarification.rationale ?? '',
        replyAddress: buildClarificationReplyAddress({ mailReplyDomain, replyToken: invitation.replyToken }),
        url: read.trackedIds.has(clarification.id) ? issued.url : buildClarificationPortalUrl({ accessToken: invitation.invitationToken, frontendAppUrl }),
      })),
    },
    mailRepository,
  });
  return { basis, issued, message, released: decision.released, sendIds };
}
