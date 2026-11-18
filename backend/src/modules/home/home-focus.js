import { PROJECT_CAPABILITIES, hasProjectCapability } from '../../lib/auth/project-capabilities.js';
import { addDays, addWorkingDays, dateOnly, dayWord, daysBetween, shortDate } from './home-dates.js';
import { HOME_LENS } from './home-lenses.js';
import { itemLink } from './home-items.js';

// Focus now: what to do first, ranked by fixed rules (spec-v2, "Focus now ranking inputs").
// Each candidate gets reasons in fixed wording; its tier is the best tier among them, and
// items sort within a tier by people blocked, due date, priority, then schedule float. AI
// does not rank.

export const FOCUS_MAX = 5;
export const FOCUS_MIN = 3;
export const REASONS_SHOWN = 2;
// Items in a tab beyond this are counted but not sent.
export const TAB_ITEM_LIMIT = 50;

// Display order of reasons within a tier.
const REASON_ORDER = [
  'blocks', 'overdue', 'past-sla', 'schedule-slip', 's1', 'odin-alert', 'expires', 'dead-webhook',
  'due-soon', 'sprint-ends', 'required-reviewer', 'decision', 'approval', 'critical-risk', 'sync-conflict', 'second-admin',
  'in-progress', 'high-priority', 's2', 'question', 'review-open', 'high-risk', 'items-left',
];

function plural(count, word, many = `${word}s`) {
  return `${count} ${count === 1 ? word : many}`;
}

export const REASONS = Object.freeze({
  accessReviewLeft: (count) => ({ code: 'items-left', count, label: `${count} items left`, tier: 3 }),
  approval: () => ({ code: 'approval', label: 'Approval waiting', tier: 2 }),
  blocks: (count) => ({ code: 'blocks', count, label: `Blocks ${plural(count, 'person', 'people')}`, tier: 1 }),
  criticalRisk: () => ({ code: 'critical-risk', label: 'Critical risk', tier: 2 }),
  deadWebhook: (count) => ({ code: 'dead-webhook', count, label: `${plural(count, 'event')} not delivered`, tier: 1, tone: 'hot' }),
  decision: () => ({ code: 'decision', label: 'Decision waiting', tier: 2 }),
  dueSoon: (word, tier = 2) => ({ code: 'due-soon', label: `Due ${word}`, tier }),
  expires: (hours) => ({ code: 'expires', label: hours <= 1 ? 'Expires within 1h' : `Expires in ${hours}h`, tier: 1, tone: 'hot' }),
  highPriority: () => ({ code: 'high-priority', label: 'High priority', tier: 3 }),
  highRisk: () => ({ code: 'high-risk', label: 'High risk', tier: 3 }),
  inProgress: () => ({ code: 'in-progress', label: 'In progress', tier: 3 }),
  odinAlert: () => ({ code: 'odin-alert', label: 'Odin alert', tier: 1, tone: 'hot' }),
  overdue: (days, critical) => ({ code: 'overdue', count: days, label: `Overdue ${days}d`, tier: critical ? 1 : 2, tone: 'hot' }),
  pastSla: () => ({ code: 'past-sla', label: 'Past SLA', tier: 1, tone: 'hot' }),
  question: () => ({ code: 'question', label: 'Question for you', tier: 3 }),
  requiredReviewer: (soon) => ({ code: 'required-reviewer', label: 'Required reviewer', tier: soon ? 2 : 3 }),
  reviewOpen: () => ({ code: 'review-open', label: 'Review open', tier: 3 }),
  s1: () => ({ code: 's1', label: 'S1 ticket', tier: 1, tone: 'hot' }),
  scheduleSlip: (days) => ({ code: 'schedule-slip', count: days, label: `Slips ${days}d`, tier: 1, tone: 'hot' }),
  s2: () => ({ code: 's2', label: 'S2 ticket', tier: 3 }),
  secondAdmin: () => ({ code: 'second-admin', label: 'Needs a second admin', tier: 2 }),
  sprintEnds: (word) => ({ code: 'sprint-ends', label: `Sprint ends ${word}`, tier: 2 }),
  syncConflict: (count) => ({ code: 'sync-conflict', count, label: `${plural(count, 'issue')} out of sync`, tier: 2 }),
});

function reasonOrder(reason) {
  const index = REASON_ORDER.indexOf(reason.code);
  return index === -1 ? REASON_ORDER.length : index;
}

function compareText(left, right) {
  return String(left ?? '').localeCompare(String(right ?? ''));
}

/** Within a tier: people blocked (most first), due date (soonest first), priority, float. */
function compareCandidates(left, right) {
  const leftDue = left.sort?.due ?? '9999-12-31';
  const rightDue = right.sort?.due ?? '9999-12-31';
  return left.tier - right.tier
    || (right.sort?.blocks ?? 0) - (left.sort?.blocks ?? 0)
    || compareText(leftDue, rightDue)
    || (left.sort?.priority ?? 4) - (right.sort?.priority ?? 4)
    || (left.sort?.float ?? Number.MAX_SAFE_INTEGER) - (right.sort?.float ?? Number.MAX_SAFE_INTEGER)
    || compareText(left.title, right.title)
    || compareText(left.id, right.id);
}

/**
 * Ranks candidates. Every candidate gets its tier (4 when no rule matched), its two leading
 * reasons and a rank. Focus is tiers 1 and 2 up to FOCUS_MAX, topped up from tier 3 to
 * FOCUS_MIN.
 */
export function rankHomeItems(candidates = []) {
  const ranked = candidates.map((candidate) => {
    const reasons = [...(candidate.reasons ?? [])].sort((left, right) => left.tier - right.tier || reasonOrder(left) - reasonOrder(right));
    return { ...candidate, reasons, tier: reasons[0]?.tier ?? 4 };
  }).sort(compareCandidates);

  const urgent = ranked.filter((item) => item.tier <= 2).slice(0, FOCUS_MAX);
  const next = urgent.length < FOCUS_MIN ? ranked.filter((item) => item.tier === 3).slice(0, FOCUS_MIN - urgent.length) : [];
  const focusIds = new Set([...urgent, ...next].map((item) => item.id));
  const items = ranked.map((item, index) => {
    const { sort: _sort, ...rest } = item;
    return {
      ...rest,
      rank: index + 1,
      reasons: item.reasons.slice(0, REASONS_SHOWN).map(({ code, count, label, tone }) => ({ code, label, ...(count != null ? { count } : {}), ...(tone ? { tone } : {}) })),
      tabs: focusIds.has(item.id) ? ['focus', ...item.tabs] : item.tabs,
    };
  });
  return { focus: items.filter((item) => focusIds.has(item.id)), items };
}

// ---------------------------------------------------------------------------
// Signals shared by the work-item rules
// ---------------------------------------------------------------------------

/** For each item that blocks others, the distinct people assigned to the open items it blocks. */
export function blockedPeopleByItem(ctx) {
  const byId = ctx.itemsById;
  const blocked = new Map();
  for (const relation of ctx.relations ?? []) {
    if (relation.relationType !== 'blocks') continue;
    const blocker = byId.get(relation.fromItemId);
    const target = byId.get(relation.toItemId);
    if (!blocker || !target?.open || !target.assigneeId || target.assigneeId === blocker.assigneeId) continue;
    const people = blocked.get(blocker.id) ?? new Set();
    people.add(target.assigneeId);
    blocked.set(blocker.id, people);
  }
  return blocked;
}

/** Item ids on the critical path, when the project's schedule has dependencies to make one. */
export function criticalPathIds(ctx) {
  return ctx.analysis?.dependencyCount > 0 ? new Set(ctx.analysis.criticalPathIds ?? []) : new Set();
}

function floatById(ctx) {
  return new Map((ctx.analysis?.itemTimings ?? []).map((timing) => [timing.id, timing.totalFloatWorkingDays]));
}

/** Items whose latest workflow transition set an SLA that has passed while still in that state. */
export function pastSlaItemIds(ctx, histories = [], now) {
  const latest = new Map();
  for (const history of histories) {
    if (history.projectId !== ctx.project.id) continue;
    const current = latest.get(history.itemId);
    const newer = current && Number(history.sequenceId) > 0 && Number(current.sequenceId) > 0
      ? Number(history.sequenceId) > Number(current.sequenceId)
      : String(history.occurredAt ?? '') > String(current?.occurredAt ?? '');
    if (!current || newer) latest.set(history.itemId, history);
  }
  const ids = new Set();
  for (const [itemId, history] of latest) {
    const item = ctx.itemsById.get(itemId);
    if (item?.open && history.slaDueAt && Date.parse(history.slaDueAt) <= now.valueOf() && history.toState === item.status) ids.add(itemId);
  }
  return ids;
}

function activeSprintEnds(ctx) {
  return new Map(ctx.sprints.filter((sprint) => String(sprint.status ?? '').toLowerCase() === 'active').map((sprint) => [sprint.id, dateOnly(sprint.endDate)]));
}

/** The reasons one open work item or ticket earns, and the numbers it sorts on. */
function workItemSignals(ctx, item, { blocked, critical, floats, pastSla, sprintEnds, today }) {
  const reasons = [];
  const blockedCount = blocked.get(item.id)?.size ?? 0;
  if (blockedCount > 0) reasons.push(REASONS.blocks(blockedCount));
  if (item.targetEndDate && item.targetEndDate < today) reasons.push(REASONS.overdue(daysBetween(item.targetEndDate, today), critical.has(item.id)));
  if (pastSla.has(item.id)) reasons.push(REASONS.pastSla());
  if (item.itemType === 'ticket' && item.severity === 'S1') reasons.push(REASONS.s1());
  if (item.targetEndDate && item.targetEndDate >= today && item.targetEndDate <= addWorkingDays(today, 1, ctx.calendar)) {
    reasons.push(REASONS.dueSoon(dayWord(item.targetEndDate, today)));
  }
  const sprintEnd = item.sprintId ? sprintEnds.get(item.sprintId) : null;
  if (sprintEnd && sprintEnd >= today && sprintEnd <= addWorkingDays(today, 2, ctx.calendar)) reasons.push(REASONS.sprintEnds(dayWord(sprintEnd, today)));
  if (sprintEnd && item.inProgress) reasons.push(REASONS.inProgress());
  if (item.priority <= 2) reasons.push(REASONS.highPriority());
  if (item.itemType === 'ticket' && item.severity === 'S2') reasons.push(REASONS.s2());
  return {
    reasons,
    sort: { blocks: blockedCount, due: item.targetEndDate, float: floats.get(item.id) ?? null, priority: item.priority },
  };
}

// Own work and team rules read the same signals for a project; work them out once per load.
const signalCache = new WeakMap();

function signalContext(ctx, { histories, now, today }) {
  if (!signalCache.has(ctx)) {
    signalCache.set(ctx, {
      blocked: blockedPeopleByItem(ctx),
      critical: criticalPathIds(ctx),
      floats: floatById(ctx),
      pastSla: pastSlaItemIds(ctx, histories, now),
      sprintEnds: activeSprintEnds(ctx),
      today,
    });
  }
  return signalCache.get(ctx);
}

function firstName(name) {
  return String(name ?? '').trim().split(/\s+/)[0] || 'someone';
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/** Open work items and tickets assigned to the viewer. */
export function ownWorkCandidates(ctx, { histories = [], now, today, viewerId }) {
  const signals = signalContext(ctx, { histories, now, today });
  return ctx.items
    .filter((item) => item.open && item.leaf && item.itemType !== 'epic' && item.assigneeId === viewerId)
    .map((item) => ({
      due: item.targetEndDate ? { at: item.targetEndDate, kind: 'due' } : null,
      id: `item:${item.id}`,
      kind: item.itemType === 'ticket' ? 'ticket' : 'work-item',
      link: itemLink(ctx.project.id, item),
      projectId: ctx.project.id,
      projectName: ctx.project.name,
      tabs: ['assigned', 'all'],
      title: item.name,
      ...workItemSignals(ctx, item, signals),
    }));
}

/**
 * Teammates' work that holds others up, on projects the viewer manages: items that block
 * someone, overdue critical-path items, and items past their workflow SLA.
 */
export function teamCandidates(ctx, { histories = [], now, today, viewerId }) {
  const signals = signalContext(ctx, { histories, now, today });
  const candidates = [];
  for (const item of ctx.items) {
    if (!item.open || !item.leaf || item.itemType === 'epic' || !item.assigneeId || item.assigneeId === viewerId) continue;
    const blocking = (signals.blocked.get(item.id)?.size ?? 0) > 0;
    const lateOnPath = Boolean(item.targetEndDate && item.targetEndDate < today && signals.critical.has(item.id));
    if (!blocking && !lateOnPath && !signals.pastSla.has(item.id)) continue;
    const { reasons, sort } = workItemSignals(ctx, item, signals);
    const owner = item.assigneeName || ctx.members.get(item.assigneeId) || '';
    candidates.push({
      due: item.targetEndDate ? { at: item.targetEndDate, kind: 'due' } : null,
      id: `team:${item.id}`,
      kind: 'blocker',
      link: itemLink(ctx.project.id, item),
      projectId: ctx.project.id,
      projectName: ctx.project.name,
      reasons: reasons.filter((reason) => reason.tier <= 2),
      sort,
      tabs: ['team', 'all'],
      title: `Unblock ${firstName(owner)} on “${item.name}”`,
    });
  }
  return candidates;
}

/** Requirements items waiting on the viewer (the Requirements tab badge), per project. */
export function requirementsCandidates(ctx, { lens, today }) {
  const groups = ctx.myItems?.groups;
  if (!groups) return [];
  const projectId = ctx.project.id;
  const base = { projectId, projectName: ctx.project.name };
  const decideTabs = lens === HOME_LENS.TEAM ? ['decide', 'all'] : ['requirements', 'all'];
  const otherTabs = lens === HOME_LENS.TEAM ? ['all'] : ['requirements', 'all'];
  const candidates = [];
  for (const entry of groups.decide ?? []) {
    candidates.push({
      ...base,
      due: null,
      id: `decide:${projectId}:${entry.id}`,
      kind: 'decision',
      link: entry.kind === 'topic'
        ? { name: 'project-requirements-topic', params: { projectId, topicId: entry.id } }
        : { name: 'project-requirements-track', params: { projectId, stage: 'decide', track: entry.track } },
      reasons: [REASONS.decision()],
      sort: { due: null },
      tabs: decideTabs,
      title: `Decide: ${entry.title}`,
    });
  }
  for (const entry of groups.answer ?? []) {
    candidates.push({
      ...base,
      due: null,
      id: `answer:${projectId}:${entry.id}`,
      kind: 'answer',
      link: { name: 'project-requirements-topic', params: { projectId, topicId: entry.id } },
      reasons: [REASONS.question()],
      sort: { due: null },
      tabs: otherTabs,
      title: `Answer: ${entry.title}`,
    });
  }
  for (const entry of groups.review ?? []) {
    const dueAt = dateOnly(entry.meta?.dueAt);
    const soon = Boolean(dueAt && dueAt <= addWorkingDays(today, 2, ctx.calendar));
    candidates.push({
      ...base,
      due: dueAt ? { at: entry.meta.dueAt, kind: 'due' } : null,
      id: `review:${projectId}:${entry.id}`,
      kind: 'review',
      link: { name: 'project-requirements-round-review', params: { projectId, roundId: entry.id } },
      reasons: [entry.meta?.required ? REASONS.requiredReviewer(soon) : REASONS.reviewOpen()],
      sort: { due: dueAt },
      tabs: otherTabs,
      title: `Review ${String(entry.title ?? '').replace(/^Round/, 'round')}`,
    });
  }
  for (const entry of groups.drafts ?? []) {
    candidates.push({
      ...base,
      due: null,
      id: `draft:${projectId}:${entry.id}`,
      kind: 'draft',
      link: { name: 'project-requirements-package', params: { packageId: entry.id, projectId, track: entry.track } },
      reasons: [],
      sort: { due: null },
      tabs: otherTabs,
      title: `Finish draft: ${entry.title}`,
    });
  }
  return candidates;
}

/** Open risks and issues the viewer owns that are high or critical. */
export function riskCandidates(ctx, { lens, viewerId }) {
  return (ctx.governance?.items ?? [])
    .filter((item) => ['risk', 'issue'].includes(item.kind) && item.ownerId === viewerId && ['open', 'monitoring'].includes(item.status) && ['high', 'critical'].includes(item.impact))
    .map((item) => ({
      due: item.dueDate ? { at: item.dueDate, kind: 'due' } : { at: null, kind: 'owner' },
      id: `risk:${item.id}`,
      kind: 'risk',
      link: { name: 'project-governance', params: { projectId: ctx.project.id } },
      projectId: ctx.project.id,
      projectName: ctx.project.name,
      reasons: [item.impact === 'critical' ? REASONS.criticalRisk() : REASONS.highRisk()],
      sort: { due: dateOnly(item.dueDate) },
      tabs: lens === HOME_LENS.TEAM ? ['team', 'all'] : ['all'],
      title: `Respond to ${item.impact === 'critical' ? 'critical ' : ''}${item.kind}: ${item.title}`,
    }));
}

// Milestones are judged within this many calendar days, as the Insights project rule does.
const MILESTONE_LOOKAHEAD_DAYS = 30;
const CLOSED_MILESTONE_STATUSES = new Set(['achieved', 'cancelled', 'missed']);

/**
 * Schedule slips on a managed project, from its schedule analysis: the critical-path forecast
 * finishing after the project's end date, and open milestones due within 30 days that
 * forecast late. Not "behind" (that is the sprint rule), but tier 1 work for its manager.
 */
export function scheduleCandidates(ctx, { today }) {
  const analysis = ctx.analysis;
  if (!analysis) return [];
  const base = { kind: 'schedule', link: { name: 'project-governance', params: { projectId: ctx.project.id } }, projectId: ctx.project.id, projectName: ctx.project.name, tabs: ['team', 'all'] };
  const candidates = [];
  const projectSlip = Number(analysis.forecastVarianceDays);
  if (projectSlip > 0 && ctx.project.endDate) {
    candidates.push({
      ...base,
      due: { at: ctx.project.endDate, kind: 'due' },
      id: `schedule:${ctx.project.id}`,
      reasons: [REASONS.scheduleSlip(projectSlip)],
      sort: { due: ctx.project.endDate },
      title: `Bring ${ctx.project.name} back to its ${shortDate(ctx.project.endDate)} end date`,
    });
  }
  const open = new Map((ctx.governance?.milestones ?? []).filter((milestone) => !CLOSED_MILESTONE_STATUSES.has(String(milestone.status ?? '').toLowerCase())).map((milestone) => [milestone.id, milestone]));
  const horizon = addDays(today, MILESTONE_LOOKAHEAD_DAYS);
  for (const forecast of analysis.milestoneForecasts ?? []) {
    const target = dateOnly(forecast.targetDate);
    const slip = Number(forecast.varianceWorkingDays);
    if (!open.has(forecast.id) || !target || target < today || target > horizon || !(slip > 0)) continue;
    candidates.push({
      ...base,
      due: { at: target, kind: 'due' },
      id: `milestone:${forecast.id}`,
      reasons: [REASONS.scheduleSlip(slip)],
      sort: { due: target },
      title: `Milestone “${forecast.title}” forecasts ${slip} working ${slip === 1 ? 'day' : 'days'} late`,
    });
  }
  return candidates;
}

/**
 * Pending workflow approvals the viewer may decide: plan edit rights on the project, a role
 * the transition accepts, and not their own request (workflows.service decideApprovalForUser).
 */
export function approvalCandidates(contexts, { now, tenantRole, viewerId, workflowSnapshot }) {
  const byProject = new Map(contexts.map((ctx) => [ctx.project.id, ctx]));
  const candidates = [];
  for (const approval of workflowSnapshot?.approvals ?? []) {
    const ctx = byProject.get(approval.projectId);
    if (!ctx?.canEdit || approval.status !== 'pending' || approval.requestedBy === viewerId) continue;
    const binding = (workflowSnapshot.bindings ?? []).find((entry) => entry.projectId === approval.projectId && entry.itemType === approval.itemType);
    const workflow = (workflowSnapshot.workflows ?? []).find((entry) => entry.id === binding?.workflowId);
    const transition = workflow?.transitions?.find((entry) => entry.key === approval.transitionKey && entry.fromState === approval.fromState && entry.toState === approval.toState);
    if (!transition?.approvalRequired) continue;
    const roles = new Set([String(tenantRole ?? '').toLowerCase(), String(ctx.projectRole ?? '').toLowerCase()]);
    if (transition.approverRoles?.length && !transition.approverRoles.some((role) => roles.has(role))) continue;
    const item = ctx.itemsById.get(approval.itemId);
    const toLabel = workflow.states?.find((state) => state.key === approval.toState)?.label ?? approval.toState;
    const late = Boolean(approval.expiresAt && Date.parse(approval.expiresAt) <= now.valueOf());
    candidates.push({
      due: approval.expiresAt ? { at: approval.expiresAt, kind: 'due' } : null,
      id: `approval:${approval.id}`,
      kind: 'approval',
      link: item ? itemLink(ctx.project.id, item) : { name: 'workflows' },
      projectId: ctx.project.id,
      projectName: ctx.project.name,
      reasons: [late ? REASONS.pastSla() : REASONS.approval()],
      sort: { due: dateOnly(approval.expiresAt) },
      tabs: ['decide', 'all'],
      title: `Approve: ${item?.name ?? 'Work item'} to ${toLabel}`,
    });
  }
  return candidates;
}

/** Unread critical alerts on the viewer's Odin goals, on projects Home can show. */
export function alertCandidates(notifications = [], contexts) {
  const byProject = new Map(contexts.map((ctx) => [ctx.project.id, ctx]));
  return notifications
    .filter((notification) => notification.severity === 'critical' && (!notification.projectId || byProject.has(notification.projectId)))
    .map((notification) => {
      const ctx = byProject.get(notification.projectId);
      return {
        due: null,
        id: `alert:${notification.id}`,
        kind: 'alert',
        link: ctx ? { name: 'project-detail', params: { projectId: ctx.project.id } } : null,
        projectId: ctx?.project.id ?? null,
        projectName: ctx?.project.name ?? 'Odin goals',
        reasons: [REASONS.odinAlert()],
        sort: { due: dateOnly(notification.createdAt) },
        tabs: ['all'],
        title: notification.title || 'Odin goal needs attention',
      };
    });
}

/** Workspace work for tenant admins: identity, integrations and access reviews. */
export function workspaceCandidates({ connectors, identity, now, platform, today, userNames, viewerId }) {
  const candidates = [];
  const nameOf = (userId) => userNames.get(userId) || 'a member';
  for (const grant of identity?.impersonationGrants ?? []) {
    if (grant.status !== 'pending' || grant.requesterUserId === viewerId || Date.parse(grant.expiresAt) <= now.valueOf()) continue;
    const hoursLeft = Math.ceil((Date.parse(grant.expiresAt) - now.valueOf()) / 3_600_000);
    candidates.push({
      due: { at: grant.expiresAt, kind: 'expires' },
      id: `impersonation:${grant.id}`,
      kind: 'impersonation',
      link: { name: 'identity-admin' },
      projectId: null,
      projectName: 'Identity',
      reasons: [REASONS.secondAdmin(), ...(hoursLeft <= 24 ? [REASONS.expires(hoursLeft)] : [])],
      sort: { due: dateOnly(grant.expiresAt) },
      tabs: ['approvals', 'identity', 'all'],
      title: `Approve impersonation request: ${nameOf(grant.requesterUserId)} → ${nameOf(grant.targetUserId)}`,
    });
  }
  for (const subscription of platform?.subscriptions ?? []) {
    const dead = (platform.deliveries ?? []).filter((delivery) => delivery.subscriptionId === subscription.id && delivery.status === 'dead');
    if (dead.length === 0) continue;
    const since = dead.map((delivery) => delivery.createdAt).filter(Boolean).sort()[0] ?? null;
    candidates.push({
      due: since ? { at: since, kind: 'since' } : null,
      id: `webhook:${subscription.id}`,
      kind: 'webhook',
      link: { name: 'integration-admin' },
      projectId: null,
      projectName: 'API & integrations',
      reasons: [REASONS.deadWebhook(dead.length)],
      // Failing since a date is not due on one, so it sorts after dated work in its tier.
      sort: { due: null },
      tabs: ['integrations', 'all'],
      title: `Fix the dead webhook “${subscription.name || subscription.url || 'Webhook'}”`,
    });
  }
  const openConflicts = (connectors?.conflicts ?? []).filter((conflict) => conflict.status === 'open');
  for (const connection of connectors?.connections ?? []) {
    const conflicts = openConflicts.filter((conflict) => conflict.connectionId === connection.id);
    if (conflicts.length === 0) continue;
    candidates.push({
      due: null,
      id: `connector:${connection.id}`,
      kind: 'sync-conflict',
      link: { name: 'integration-admin' },
      projectId: null,
      projectName: 'Connectors',
      reasons: [REASONS.syncConflict(conflicts.length)],
      sort: { due: null },
      tabs: ['integrations', 'all'],
      title: `Resolve the ${connection.name || 'connector'} sync ${conflicts.length === 1 ? 'conflict' : 'conflicts'}`,
    });
  }
  for (const review of identity?.accessReviews ?? []) {
    if (review.status !== 'open' || review.reviewerUserId !== viewerId) continue;
    const left = (identity.accessReviewItems ?? []).filter((item) => item.reviewId === review.id && item.decision === 'pending').length;
    if (left === 0) continue;
    const dueAt = dateOnly(review.dueAt);
    const soon = Boolean(dueAt && dueAt <= addWorkingDays(today, 2));
    candidates.push({
      due: dueAt ? { at: review.dueAt, kind: 'due' } : null,
      id: `access-review:${review.id}`,
      kind: 'access-review',
      link: { name: 'identity-admin' },
      projectId: null,
      projectName: 'Identity',
      reasons: [REASONS.accessReviewLeft(left), ...(dueAt ? [REASONS.dueSoon(dayWord(dueAt, today), soon ? 2 : 3)] : [])],
      sort: { due: dueAt },
      tabs: ['identity', 'all'],
      title: `Finish the ${review.name || 'access review'}`,
    });
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export const LENS_TABS = Object.freeze({
  [HOME_LENS.MY_WORK]: [['focus', 'Focus now'], ['assigned', 'Assigned'], ['requirements', 'Requirements'], ['all', 'All']],
  [HOME_LENS.TEAM]: [['focus', 'Focus now'], ['decide', 'Decide'], ['team', 'Team'], ['assigned', 'Assigned'], ['all', 'All']],
  [HOME_LENS.WORKSPACE]: [['focus', 'Focus now'], ['approvals', 'Approvals'], ['integrations', 'Integrations'], ['identity', 'Identity'], ['all', 'All']],
});

/** Tab counts for the lens, and the ranked items each tab lists (capped per tab). */
export function buildTabs(lens, items) {
  const tabs = LENS_TABS[lens].map(([key, label]) => ({ count: items.filter((item) => item.tabs.includes(key)).length, key, label }));
  const kept = new Set();
  for (const { key } of tabs) {
    for (const item of items.filter((entry) => entry.tabs.includes(key)).slice(0, TAB_ITEM_LIMIT)) kept.add(item.id);
  }
  return { items: items.filter((item) => kept.has(item.id)), tabs };
}

export function canEditProject(user, tenantRole, projectRole) {
  return hasProjectCapability({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectRole, tenantRole, userCapabilities: user?.capabilities });
}
