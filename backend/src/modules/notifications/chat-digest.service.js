import {
  DEFAULT_DIGEST_QUIET_MINUTES,
  DIGEST_LEASE_MS,
  DIGEST_MAX_ATTEMPTS,
  DIGEST_RETRY_MS,
  digestQuietMs,
} from '../assistant/clarification-invitation-digest.service.js';
import { appUrl } from '../channels/channel-links.js';
import { classifyBounce } from '../mail/mail-bounce.js';
import { renderEmailFromTemplate } from '../mail/mail.service.js';
import { CHAT_DIGEST_TEMPLATE_ID } from '../mail/mail.templates.js';
import { findEmailOptOuts, isOptedOut } from '../users/notification-preferences.js';
import { createChannelGuestDirectory } from './guest-directory.js';
import { describeNotification, memberNotificationPath } from './notifications.service.js';

// The rolled-up chat email (docs/odin-chat/plan.md, Email; qna.md Q-04, AC-N05). A notification
// still unread 10 minutes after it was made joins its person's digest. The digest is sent once
// the quiet period (20 minutes by default, CLARIFICATION_DIGEST_QUIET_MINUTES) passes with no new
// item: one email per person and workspace that lists each item with a link. It runs with the
// mail queue job every minute, under the same rules as the requirements mention digest
// (requirements/mentions/mention-digest.service.js): claim and lease, re-reads before rendering
// and again right before SMTP, retries, bounces, at-least-once delivery.
//
// Before every attempt each item must still hold, or it is released for good with the reason:
// the person can still open it (a member of its project, or a guest still in its channel), has
// an email that hasn't opted out or bounced, and, for members, hasn't turned off "Chat email
// digest". An item read in Odin meanwhile is no longer an item at all, so it is dropped.

export const CHAT_DIGEST_RELEASE_REASONS = Object.freeze({
  digestOff: 'chat digest: the user turned off the chat email digest',
  noAccess: 'chat digest: the recipient can no longer open it',
  noEmail: 'chat digest: the recipient has no email address',
  optedOut: 'chat digest: the email address opted out or bounced',
});

const ODIN_EMAIL_LOGO = '<img src="https://odinpmp.com/app/brand/odin-mark-email.png" alt="OdinPMP" width="72" style="display:block; width:72px; max-width:72px; height:auto; border:0; margin-left:auto;" />';
const MANAGING_ROLES = new Set(['admin', 'manager']);

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const recipientOf = ({ principalId, principalType, tenantId }) => ({ principalId, principalType, tenantId });

const PREHEADER_MAX = 140;

/**
 * The line an inbox shows under the subject: the items' previews, hidden in the email itself.
 * Without it, every digest shows the same "Hello" line there.
 */
function preheaderHtml(excerpts) {
  const text = excerpts.filter(Boolean).join(' · ').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const short = text.length <= PREHEADER_MAX ? text : `${text.slice(0, PREHEADER_MAX - 1).trimEnd()}…`;
  return `<div style="display:none; max-height:0; overflow:hidden; opacity:0; mso-hide:all;">${escapeHtml(short)}</div>`;
}

/** Sends every chat digest whose quiet period has passed. Safe to run concurrently and to rerun. */
export async function flushDueChatDigests({
  authRepository = null,
  env = {},
  frontendAppUrl = '',
  guestDirectory = null,
  limit = 50,
  logger = null,
  mailRepository,
  notificationsRepository,
  now = () => new Date(),
  projectRepository = null,
  quietMinutes = DEFAULT_DIGEST_QUIET_MINUTES,
  transport,
} = {}) {
  const summary = { deferred: 0, due: 0, errors: 0, failed: 0, retried: 0, sent: 0, skipped: 0 };
  if (!notificationsRepository?.listDueChatDigests || !transport?.sendMail) return summary;
  const clock = typeof now === 'function' ? now : () => new Date(now);
  const quietMs = digestQuietMs(quietMinutes);
  const at = clock();
  const due = await notificationsRepository.listDueChatDigests({ dueBefore: new Date(at.getTime() - quietMs), limit, now: at });
  summary.due = due.length;
  const deps = { authRepository, frontendAppUrl, guests: guestDirectory ?? createChannelGuestDirectory({ projectRepository }), mailRepository, notificationsRepository, projectRepository };
  for (const entry of due) {
    const recipient = recipientOf(entry);
    try {
      summary[await deliverDigest({ clock, deps, env, logger, quietMs, recipient, transport })] += 1;
    } catch (error) {
      // An unclaimed failure needs nothing; a claimed one expires and is retried by a later run.
      summary.errors += 1;
      logger?.logError?.({ context: { principalType: recipient.principalType, tenantId: recipient.tenantId }, error, level: 'warn', message: 'Chat digest could not be delivered.' });
    }
  }
  return summary;
}

async function deliverDigest({ clock, deps, env, logger, quietMs, recipient, transport }) {
  const store = deps.notificationsRepository;
  const claimedAt = clock();
  const claim = await store.claimChatDigest({ ...recipient, dueBefore: new Date(claimedAt.getTime() - quietMs), leaseUntil: new Date(claimedAt.getTime() + DIGEST_LEASE_MS), now: claimedAt });
  if (!claim) return 'deferred';
  const owner = { ...recipient, claimToken: claim.claimToken, deliveryId: claim.deliveryId };
  if (claim.interruptedSend) logger?.logEvent?.({ context: { deliveryId: claim.deliveryId, principalType: recipient.principalType }, message: 'A previous chat digest attempt stopped while sending and may have been delivered; sending it again.' });

  const prepared = await prepareDigest(deps, recipient, clock());
  if (!prepared.message) {
    await store.releaseChatDigest({ ...owner, now: clock(), released: await confirmedReleases(deps, recipient, prepared, clock()) });
    return 'skipped';
  }

  // Everything the email depends on must still be what it was rendered from.
  let unchanged = false;
  try {
    unchanged = (await decide(deps, recipient, clock())).basis === prepared.basis;
  } finally {
    if (!unchanged) await store.abortChatDigestSend({ ...owner, now: clock() });
  }
  if (!unchanged) return 'deferred';

  // The last step before SMTP: the claim is still ours, the newest item's quiet period has
  // passed, and every item in the email is still pending and unread.
  const sendingAt = clock();
  const begun = await store.beginChatDigestSend({ ...owner, dueBefore: new Date(sendingAt.getTime() - quietMs), leaseUntil: new Date(sendingAt.getTime() + DIGEST_LEASE_MS), now: sendingAt, sendIds: prepared.sendIds });
  if (!begun.ok) return 'deferred';

  let info;
  try {
    info = await transport.sendMail({ from: { address: env.mailFromAddress, name: env.mailFromName }, html: prepared.message.html, subject: prepared.message.subject, to: prepared.message.to });
  } catch (error) {
    const reason = String(error?.message ?? error);
    const bounceType = classifyBounce(reason);
    await deps.mailRepository?.logBounce?.({ bounceType, email: prepared.message.to, reason });
    if (bounceType === 'hard') await deps.mailRepository?.optOutEmail?.({ email: prepared.message.to });
    const failedAt = clock();
    const result = await store.failChatDigestAttempt({ ...owner, error: reason, itemIds: prepared.sendIds, maxAttempts: DIGEST_MAX_ATTEMPTS, now: failedAt, retryAt: bounceType === 'hard' ? null : new Date(failedAt.getTime() + DIGEST_RETRY_MS * (claim.attempts + 1)) });
    if (result.fenced) return 'deferred';
    return result.terminal ? 'failed' : 'retried';
  }

  let released = [];
  try {
    released = await confirmedReleases(deps, recipient, prepared, clock());
  } catch (error) {
    logger?.logError?.({ context: { deliveryId: claim.deliveryId }, error, level: 'warn', message: 'Chat digest sent; releasing left-out items is deferred to the next run.' });
  }
  await store.completeChatDigestSend({ ...owner, now: clock(), providerMessageId: String(info?.messageId ?? ''), released, sentIds: prepared.sendIds });
  return 'sent';
}

/** Reads, without side effects, everything this person's digest depends on. */
async function readState(deps, recipient, at) {
  const items = await deps.notificationsRepository.listChatDigestItems({ ...recipient, now: at });
  const read = { canOpen: async () => false, digestOff: false, email: '', items, name: '', optedOut: false, timeZone: null };
  if (!items.length) return read;
  if (recipient.principalType === 'user') {
    const user = await deps.authRepository?.findUserById?.(String(recipient.principalId));
    const membership = user?.memberships?.find((entry) => entry.tenantId === recipient.tenantId) ?? null;
    Object.assign(read, { email: String(user?.email ?? '').trim(), name: String(user?.name ?? '').trim(), timeZone: user?.timezone ?? null });
    const access = new Map();
    read.canOpen = async (item) => {
      if (!membership) return false;
      if (!item.projectId || MANAGING_ROLES.has(String(membership.role ?? '').toLowerCase())) return true;
      if (!access.has(item.projectId)) {
        const found = await deps.projectRepository?.getProjectAccess?.({ projectId: item.projectId, tenantId: recipient.tenantId, userId: String(recipient.principalId) });
        access.set(item.projectId, Boolean(found?.exists && found.projectRole));
      }
      return access.get(item.projectId);
    };
    const readPreferences = deps.authRepository?.listUserPreferences?.bind(deps.authRepository);
    read.digestOff = isOptedOut(await findEmailOptOuts({ kind: 'chatDigest', read: readPreferences, userIds: [String(recipient.principalId)] }), { userId: String(recipient.principalId) });
  } else {
    const guest = await deps.guests.describe(recipient, items);
    Object.assign(read, { email: guest?.email ?? '', name: guest?.name ?? '' });
    read.canOpen = async (item) => Boolean(guest) && deps.guests.canOpen(recipient, item);
  }
  read.optedOut = Boolean(read.email && await deps.mailRepository?.isOptedOut?.({ email: read.email }));
  return read;
}

/** Which items go in the email and which are released, and a basis that changes with either. */
async function decide(deps, recipient, at) {
  const read = await readState(deps, recipient, at);
  const released = [];
  let included = [];
  for (const item of read.items) {
    if (await read.canOpen(item)) included.push(item);
    else released.push({ id: item.id, reason: CHAT_DIGEST_RELEASE_REASONS.noAccess });
  }
  const leaveOut = (reason) => {
    released.push(...included.map((item) => ({ id: item.id, reason })));
    included = [];
  };
  if (included.length && !read.email) leaveOut(CHAT_DIGEST_RELEASE_REASONS.noEmail);
  if (included.length && read.optedOut) leaveOut(CHAT_DIGEST_RELEASE_REASONS.optedOut);
  if (included.length && read.digestOff) leaveOut(CHAT_DIGEST_RELEASE_REASONS.digestOff);
  const basis = JSON.stringify({
    email: read.email,
    included: included.map((item) => [item.id, item.updatedAt, item.collapseCount]),
    name: read.name,
    released: released.map((entry) => [entry.id, entry.reason]),
  });
  return { basis, included, read, released };
}

async function confirmedReleases(deps, recipient, prepared, at) {
  if (!prepared.released.length) return [];
  const current = new Set((await decide(deps, recipient, at)).released.map((entry) => JSON.stringify([entry.id, entry.reason])));
  return prepared.released.filter((entry) => current.has(JSON.stringify([entry.id, entry.reason])));
}

function itemUrl(deps, recipient, item) {
  const path = recipient.principalType === 'user' ? memberNotificationPath(item) : deps.guests.linkFor(item);
  return appUrl(deps.frontendAppUrl, path);
}

async function prepareDigest(deps, recipient, at) {
  const decision = await decide(deps, recipient, at);
  const sendIds = decision.included.map((item) => item.id);
  if (!decision.included.length) return { basis: decision.basis, message: null, released: decision.released, sendIds };
  const described = decision.included.map((item) => ({ ...describeNotification(item), item }));
  // Each item names the thread a reply is in, so two emails about one thread say so.
  const html = described.map(({ excerpt, item, thread, title }) => `
      <div class="item">
        <h3><a href="${escapeHtml(itemUrl(deps, recipient, item))}">${escapeHtml(title)}</a></h3>
        ${thread ? `<p style="margin:0; color:#6b7280; font-size:13px; overflow-wrap:anywhere;">In reply to: ${escapeHtml(thread)}</p>` : ''}
        ${excerpt ? `<blockquote>${escapeHtml(excerpt)}</blockquote>` : ''}
      </div>`).join('');
  const count = decision.included.length;
  const first = describeNotification(decision.included[0]).title;
  const settings = recipient.principalType === 'user'
    ? `<a href="${escapeHtml(appUrl(deps.frontendAppUrl, '/user?tab=preferences'))}">Turn off the chat email digest</a> in your settings.`
    : 'Ask the person who invited you to stop these emails.';
  const rendered = await renderEmailFromTemplate({
    mailRepository: deps.mailRepository,
    templateId: CHAT_DIGEST_TEMPLATE_ID,
    vars: {
      // The subject is plain text, not HTML.
      digestSubject: count === 1 ? first : `${count} things you haven't seen in Odin`,
      headline: escapeHtml(count === 1 ? 'Here is something you have not seen in Odin yet.' : `Here are ${count} things you have not seen in Odin yet.`),
      itemsHtml: html,
      odinLogo: ODIN_EMAIL_LOGO,
      preheaderHtml: preheaderHtml(described.map(({ excerpt }) => excerpt)),
      recipientName: escapeHtml(decision.read.name || 'there'),
      settingsHtml: settings,
    },
  });
  return { basis: decision.basis, message: { html: rendered.body, subject: rendered.subject.slice(0, 255), to: decision.read.email }, released: decision.released, sendIds };
}
