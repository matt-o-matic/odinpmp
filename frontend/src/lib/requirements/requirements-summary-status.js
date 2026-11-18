// How fresh a topic's Odin summary is, what a refresh did, and who the summary names.
// A failed run keeps the previous summary current, so the UI shows "Last updated <time>,
// refresh failed" (plan.md, Failure and recovery).

import { requirementsErrorCode } from './requirements-errors.js';
import { avatarColor, initials } from './requirements-topics.js';
import { resolveActorRef } from './requirements-sources.js';
import { formatAgo } from './requirements-time.js';

function list(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * `summary` is the topic's current summary (or null); `status` is the topic's
 * `summaryStatus` ({ lastAttemptAt, lastAttemptStatus, refreshPending }). Either may be
 * missing; the summary also carries its own last-attempt fields.
 */
export function describeSummaryStatus({ now = new Date(), status = null, summary = null } = {}) {
  const lastAttemptStatus = status?.lastAttemptStatus ?? summary?.lastAttemptStatus ?? (summary ? 'ok' : null);
  const lastAttemptAt = status?.lastAttemptAt ?? summary?.lastAttemptAt ?? summary?.createdAt ?? null;
  const updated = summary?.createdAt ? formatAgo(summary.createdAt, { now }) : '';
  const failed = lastAttemptStatus === 'failed';
  const failedAgo = failed && lastAttemptAt ? formatAgo(lastAttemptAt, { now }) : '';
  return {
    failed,
    failedText: failed ? (failedAgo ? `refresh failed ${failedAgo}` : 'refresh failed') : '',
    pending: Boolean(status?.refreshPending),
    updatedText: updated ? `Last updated ${updated}` : '',
  };
}

const AI_NOT_CONFIGURED = 'Odin can’t summarize because no AI provider is set up for this workspace. A workspace admin can add one in the AI settings.';

/** Message for a refresh response: `{ outcome: 'ok' | 'failed' | 'no-input' }`. */
export function describeSummaryRefreshOutcome(result) {
  const outcome = result?.outcome;
  if (outcome === 'ok') return { message: 'Odin summary updated.', tone: 'success' };
  if (outcome === 'no-input') return { message: 'Not enough input yet. Odin summarizes once people have contributed to the discussion.', tone: 'info' };
  if (outcome === 'failed') {
    return { message: 'Odin couldn’t refresh the summary. The previous summary is still shown, and Odin will try again.', tone: 'error' };
  }
  return { message: 'Odin summary refreshed.', tone: 'success' };
}

/** Message for a refresh request that failed outright. */
export function describeSummaryRefreshError(error) {
  const status = Number(error?.status) || 0;
  const code = requirementsErrorCode(error);
  if (code === 'ai_not_configured' || (status === 503 && !code)) return { message: AI_NOT_CONFIGURED, tone: 'error' };
  if (status === 404) return { message: 'This topic no longer exists, or you can’t refresh its summary.', tone: 'error' };
  return { message: 'Odin couldn’t refresh the summary. Try again.', tone: 'error' };
}

/**
 * People a summary entry names. The API sends display names alongside actor refs
 * (`supporterNames` / `actorNames`, same order); those win. Without refs (the portal's
 * shape), people are built from the names alone.
 */
export function summaryPeople(refs, names, context = {}) {
  const refList = list(refs).map((ref) => String(ref ?? '').trim());
  const nameList = list(names).map((name) => String(name ?? '').trim());
  const people = [];
  const seen = new Set();
  const count = Math.max(refList.length, nameList.length);
  for (let index = 0; index < count; index += 1) {
    const ref = refList[index] || '';
    const name = nameList[index] || '';
    const key = ref || `name:${name}:${index}`;
    if (!ref && !name) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    if (ref) {
      const resolved = resolveActorRef(ref, context);
      if (!resolved) continue;
      const displayName = name || resolved.name;
      people.push({ ...resolved, initials: initials(displayName), name: displayName });
    } else {
      people.push({ color: avatarColor(name), initials: initials(name), name, ref: key });
    }
  }
  return people;
}
