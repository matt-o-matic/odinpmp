import { addDays, dateOnly, shortDate } from './home-dates.js';
import { HOME_LENS } from './home-lenses.js';

// The right rail: counts for the lens, sprint progress with the ideal line, change trends and
// the top contributors. Each count names its severity so the client tints it.

export const RAIL_SPRINT_LIMIT = 3;
export const CHANGE_TREND_DAYS = 30;
export const LEADERBOARD_DAYS = 7;
export const LEADERBOARD_TOP = 3;

function count(key, label, value, note, { href = null, severity = null } = {}) {
  return { href, key, label, note, severity, value };
}

function plural(value, word, many = `${word}s`) {
  return `${value} ${value === 1 ? word : many}`;
}

/** Sunday of the week `today` falls in (weeks run Monday to Sunday). */
function weekEnd(today) {
  const weekday = new Date(`${today}T00:00:00.000Z`).getUTCDay();
  return addDays(today, (7 - weekday) % 7);
}

function myOpenItems(contexts, viewerId) {
  return contexts.flatMap((ctx) => ctx.items.filter((item) => item.open && item.leaf && item.itemType !== 'epic' && item.assigneeId === viewerId));
}

export function myWorkCounts({ alerts, contexts, today, viewerId }) {
  const mine = myOpenItems(contexts, viewerId);
  const due = mine.filter((item) => item.targetEndDate && item.targetEndDate <= weekEnd(today));
  const overdue = due.filter((item) => item.targetEndDate < today).length;
  const waiting = { answer: 0, decide: 0, review: 0 };
  for (const ctx of contexts) {
    for (const key of Object.keys(waiting)) waiting[key] += Number(ctx.myItems?.counts?.[key] ?? 0);
  }
  const waitingParts = [
    waiting.review ? plural(waiting.review, 'review') : '',
    waiting.answer ? plural(waiting.answer, 'answer') : '',
    waiting.decide ? plural(waiting.decide, 'decision') : '',
  ].filter(Boolean);
  const inReview = mine.filter((item) => /review/i.test(item.status)).length;
  const critical = (alerts ?? []).filter((alert) => alert.severity === 'critical').length;
  return [
    count('due-week', 'Due this week', due.length, overdue ? `${overdue} overdue` : 'none overdue', { severity: overdue ? 'danger' : null }),
    count('waiting', 'Waiting on you', waiting.answer + waiting.decide + waiting.review, waitingParts.join(', ') || 'nothing waiting'),
    count('in-review', 'Your items in review', inReview, inReview ? 'waiting on a reviewer' : 'none in review'),
    count('alerts', 'Odin alerts', (alerts ?? []).length, critical ? `${critical} critical` : 'none critical', { severity: critical ? 'danger' : null }),
  ];
}

export function teamCounts({ approvals, contexts, sprints }) {
  const behind = sprints.filter((entry) => entry.evaluation.total.behind || entry.evaluation.people.some((person) => person.behind)).length;
  const pastSla = approvals.filter((item) => item.reasons.some((reason) => reason.code === 'past-sla')).length;
  const risks = contexts.flatMap((ctx) => (ctx.governance?.items ?? []).filter((item) => item.kind === 'risk' && ['open', 'monitoring'].includes(item.status)));
  const critical = risks.filter((item) => item.impact === 'critical').length;
  const staffed = sprints.filter((entry) => entry.load.size > 0);
  const overallocated = new Set(staffed.flatMap((entry) => [...entry.load.values()].filter((load) => load.hoursLeft > load.capacityLeft).map((load) => load.userId)));
  return [
    count('active-sprints', 'Active sprints', sprints.length, behind ? `${behind} at risk` : 'none at risk', { severity: behind ? 'warn' : null }),
    count('approvals', 'Pending approvals', approvals.length, pastSla ? `${pastSla} past SLA` : 'none past SLA', { href: { name: 'workflows' }, severity: pastSla ? 'warn' : null }),
    count('critical-risks', 'Critical risks', critical, `of ${risks.length} open`, { severity: critical ? 'danger' : null }),
    staffed.length > 0
      ? count('overallocated', 'Overallocated', overallocated.size, 'people this sprint', { href: { name: 'resources' }, severity: overallocated.size ? 'warn' : null })
      : count('overallocated', 'Overallocated', null, 'no sprint capacity set', { href: { name: 'resources' } }),
  ];
}

export function workspaceCounts({ connectors, identity, members, platform }) {
  const counts = [];
  if (platform) {
    const dead = (platform.deliveries ?? []).filter((delivery) => delivery.status === 'dead');
    const subscriptions = new Set(dead.map((delivery) => delivery.subscriptionId));
    counts.push(count('dead-webhooks', 'Dead webhooks', subscriptions.size, dead.length ? `${plural(dead.length, 'failed delivery', 'failed deliveries')}` : 'all delivering', { href: { name: 'integration-admin' }, severity: dead.length ? 'danger' : null }));
  }
  if (connectors) {
    const open = (connectors.conflicts ?? []).filter((conflict) => conflict.status === 'open');
    const connectionIds = [...new Set(open.map((conflict) => conflict.connectionId))];
    const onlyName = connectionIds.length === 1 ? (connectors.connections ?? []).find((connection) => connection.id === connectionIds[0])?.name : null;
    counts.push(count('sync-conflicts', 'Sync conflicts', open.length, open.length === 0 ? 'none open' : onlyName || plural(connectionIds.length, 'connection'), { href: { name: 'integration-admin' }, severity: open.length ? 'warn' : null }));
  }
  if (identity) {
    const reviews = (identity.accessReviews ?? []).filter((review) => review.status === 'open');
    const ids = new Set(reviews.map((review) => review.id));
    const items = (identity.accessReviewItems ?? []).filter((item) => ids.has(item.reviewId));
    const decided = items.filter((item) => item.decision !== 'pending').length;
    const due = reviews.map((review) => dateOnly(review.dueAt)).filter(Boolean).sort()[0];
    counts.push(items.length > 0
      ? count('access-review', 'Access review', `${Math.round((decided / items.length) * 100)}%`, `${decided} of ${items.length}${due ? ` · due ${shortDate(due)}` : ''}`, { href: { name: 'identity-admin' } })
      : count('access-review', 'Access review', null, 'no review open', { href: { name: 'identity-admin' } }));
  }
  if (members) {
    const without = members.filter((member) => !member.twoFA).length;
    counts.push(count('without-2fa', 'Without 2FA', without, `of ${plural(members.length, 'member')}`, { href: { name: 'admin' }, severity: without ? 'warn' : null }));
  }
  return counts;
}

function railSprint(entry, viewerId = null) {
  const { evaluation, summary } = entry;
  const peopleBehind = evaluation.people.filter((person) => person.behind).length;
  const mine = viewerId ? entry.leaves.filter((item) => item.assigneeId === viewerId) : [];
  return {
    ...summary,
    idealPct: summary.elapsedPct,
    link: { name: 'project-kanban', params: { projectId: summary.projectId } },
    myItems: viewerId ? { done: mine.filter((item) => item.done).length, total: mine.length } : null,
    peopleBehind,
    status: summary.behind || peopleBehind > 0 ? 'behind' : 'on-track',
  };
}

/** Sprint rows for the lens: the viewer's main sprint, the team's, or the workspace's behind. */
export function railSprints({ lens, sprints, viewerId }) {
  if (lens === HOME_LENS.MY_WORK) {
    const scored = sprints
      .map((entry) => ({ assigned: entry.evaluation.people.find((person) => person.id === viewerId)?.assigned ?? 0, entry }))
      .filter((row) => row.assigned > 0)
      .sort((left, right) => right.assigned - left.assigned);
    return scored.slice(0, 1).map((row) => railSprint(row.entry, viewerId));
  }
  const rows = sprints.map((entry) => railSprint(entry));
  const ordered = rows.sort((left, right) => Number(right.status === 'behind') - Number(left.status === 'behind') || String(left.endDate ?? '').localeCompare(String(right.endDate ?? '')));
  return (lens === HOME_LENS.WORKSPACE ? ordered.filter((row) => row.status === 'behind') : ordered).slice(0, RAIL_SPRINT_LIMIT);
}

/** Daily change counts for the last CHANGE_TREND_DAYS days from the change-trends facts. */
export function changeTrendsFrom(result, today) {
  const start = addDays(today, -(CHANGE_TREND_DAYS - 1));
  const byDay = new Map();
  for (const fact of result?.facts ?? []) {
    const day = dateOnly(fact.metricDate);
    if (!day || day < start || day > today) continue;
    byDay.set(day, (byDay.get(day) ?? 0) + Number(fact.occurrenceCount ?? 0));
  }
  const series = Array.from({ length: CHANGE_TREND_DAYS }, (_, index) => {
    const date = addDays(start, index);
    return { count: byDay.get(date) ?? 0, date };
  });
  return {
    days: CHANGE_TREND_DAYS,
    series,
    total: series.reduce((sum, point) => sum + point.count, 0),
    yesterday: byDay.get(addDays(today, -1)) ?? 0,
  };
}

/** The top contributors and, when outside them, the viewer's own row. */
export function leaderboardFrom(result) {
  const row = (entry) => ({ id: entry.id, isCurrentUser: Boolean(entry.isCurrentUser), name: entry.name ?? '', picture: entry.picture ?? null, points: Number(entry.points ?? 0), rank: entry.rank, tasks: Number(entry.tasksCompleted ?? 0) });
  const top = (result?.leaderboard ?? []).slice(0, LEADERBOARD_TOP).map(row);
  const me = result?.currentUser && !top.some((entry) => entry.isCurrentUser) ? row(result.currentUser) : null;
  return { days: result?.days ?? LEADERBOARD_DAYS, me, top };
}
