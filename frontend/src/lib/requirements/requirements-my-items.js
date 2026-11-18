// "My open items": groups, one action per row, and the row's meta and timing text, from
// `GET /requirements/my-items`.

import { proposedAnswerStatusChip } from './requirements-sources.js';
import { readyRank, stanceLabel } from './requirements-topics.js';
import { formatRelativeDay, formatShortDate, isPast } from './requirements-time.js';
import { REQUIREMENTS_STAGES, plural } from './requirements-tracks.js';

export const MY_ITEM_GROUPS = Object.freeze([
  { key: 'decide', note: 'you can record decisions on this project', requiresDecisionRights: true, title: 'Needs your decision' },
  { key: 'answer', note: '', requiresDecisionRights: false, title: 'Needs your answer' },
  { key: 'review', note: '', requiresDecisionRights: false, title: 'Needs your review' },
  { key: 'drafts', note: 'only the team can see these', requiresDecisionRights: false, title: 'Your drafts' },
]);

/**
 * Decisions to make: topics in the register's ready order (nothing blocking first), then
 * preferences, each kind otherwise in payload order.
 */
function orderDecideItems(items) {
  const rank = (item) => (item.kind === 'topic'
    ? readyRank({ signals: item.meta?.signals, state: 'ready', summary: { proposedAnswerStatus: item.meta?.proposedAnswerStatus } })
    : 3);
  return [...items].sort((left, right) => rank(left) - rank(right));
}

/**
 * Non-empty groups in display order. The decision group appears only with decision
 * rights, whatever the payload holds.
 */
export function buildMyItemGroups(payload = {}, { canDecide = false } = {}) {
  const groups = payload?.groups ?? {};
  return MY_ITEM_GROUPS
    .filter((group) => !group.requiresDecisionRights || canDecide)
    .map((group) => {
      const items = Array.isArray(groups[group.key]) ? groups[group.key] : [];
      return { ...group, items: group.key === 'decide' ? orderDecideItems(items) : items };
    })
    .filter((group) => group.items.length > 0);
}

// The pipeline stage each group's work belongs to. Brief and Plan & work have no items of
// their own, so their cards read "Nothing for you".
export const MY_ITEM_GROUP_STAGES = Object.freeze({ answer: 'discuss', decide: 'decide', drafts: 'review', review: 'review' });

/**
 * The five stage cards above My open items, counting only the caller's items, from the
 * output of buildMyItemGroups. `tone` picks the status dot as in describeStage: attention
 * for decisions and overdue reviews, active for other waiting work, idle for none.
 */
export function describeMyItemStages(groups = [], { now = new Date() } = {}) {
  const byKey = Object.fromEntries((groups ?? []).map((group) => [group.key, group.items ?? []]));
  const answer = byKey.answer ?? [];
  const decide = byKey.decide ?? [];
  const rounds = byKey.review ?? [];
  const drafts = byKey.drafts ?? [];
  const overdue = rounds.some((item) => item.meta?.dueAt && isPast(item.meta.dueAt, { now }));

  const described = {
    decide: decide.length > 0
      ? { count: decide.length, status: `${decide.length} to decide`, tone: 'attention' }
      : null,
    discuss: answer.length > 0
      ? { count: answer.length, status: `${answer.length} to answer`, tone: 'active' }
      : null,
    review: rounds.length + drafts.length > 0
      ? {
        count: rounds.length + drafts.length,
        status: [
          rounds.length > 0 ? `${plural(rounds.length, 'round')} to review` : '',
          drafts.length > 0 ? plural(drafts.length, 'draft') : '',
        ].filter(Boolean).join(' · '),
        tone: overdue ? 'attention' : 'active',
      }
      : null,
  };

  return REQUIREMENTS_STAGES.map((stage) => ({
    ...stage,
    ...(described[stage.id] ?? { count: 0, status: 'Nothing for you', tone: 'idle' }),
  }));
}

/** The groups whose items belong to `stage`; every group when no stage is picked. */
export function filterMyItemGroups(groups = [], stage = '') {
  if (!stage) return groups;
  return groups.filter((group) => MY_ITEM_GROUP_STAGES[group.key] === stage);
}

/** Badge count for the Requirements tab, excluding decisions the person cannot make. */
export function myItemsBadgeCount(payload = {}) {
  if (!payload) return 0;
  const counts = payload.counts ?? {};
  const total = (payload.canDecide ? Number(counts.decide) || 0 : 0)
    + (Number(counts.answer) || 0)
    + (Number(counts.review) || 0)
    + (Number(counts.drafts) || 0);
  return Math.max(0, total);
}

const ACTION_LABELS = Object.freeze({ decide: 'Decide', preview: 'Preview', reply: 'Reply', review: 'Start review' });

export function myItemActionLabel(item = {}) {
  return ACTION_LABELS[item.action] ?? 'Open';
}

/**
 * Where a row's action goes. Topics and packages open their own page, a round opens the
 * guided review (or the round page when `roundReview` is false, for builds without the
 * guided review route), and preferences open the Decide stage.
 */
export function myItemTarget(item = {}, projectId = '', { roundReview = true } = {}) {
  // Review is project-wide: rounds and packages open on the Review tab, whatever their track.
  if (item.kind === 'round' && item.id) {
    return {
      name: roundReview ? 'project-requirements-round-review' : 'project-requirements-round',
      params: { projectId, roundId: item.id },
    };
  }
  if (item.kind === 'package' && item.id) {
    return {
      name: 'project-requirements-package',
      params: { packageId: item.id, projectId },
    };
  }
  if (item.kind === 'topic') {
    return {
      name: 'project-requirements-topic',
      params: { projectId, topicId: item.id },
      query: { focus: item.action === 'decide' ? 'decision' : 'reply' },
    };
  }
  if (item.kind !== 'preference') {
    return { name: 'project-requirements-review', params: { projectId }, query: { [item.kind === 'round' ? 'round' : 'item']: item.id } };
  }
  return {
    name: 'project-requirements-track',
    params: { projectId, stage: 'decide', track: item.track },
    query: { preference: item.id },
  };
}

/**
 * A second action for rows that have one: a draft package can be published as a round by
 * anyone who can publish. Returns null otherwise.
 */
export function myItemSecondaryAction(item = {}, projectId = '', { canPublish = false } = {}) {
  if (item.kind !== 'package' || !item.id || !canPublish) return null;
  return {
    label: 'Publish',
    target: { name: 'project-requirements-round-publish', params: { packageId: item.id, projectId } },
  };
}

export function myItemTitle(item = {}) {
  if (item.kind === 'preference') return `Preference: ${item.title}`;
  return item.title ?? '';
}

/** The muted line under a row's title. */
export function myItemMeta(item = {}) {
  const meta = item.meta ?? {};
  if (item.kind === 'topic' && item.action === 'decide') {
    const comments = Number(meta.evidence?.comments) || 0;
    const people = Number(meta.evidence?.contributors) || 0;
    if (comments === 0) return 'Ready for a decision';
    return `${plural(comments, 'contribution')} from ${plural(people, 'person', 'people')}`;
  }
  if (item.kind === 'preference') {
    const parts = [`Proposed ${stanceLabel(meta.stance)}`];
    if (meta.dimension) parts.push(meta.dimension);
    const sources = Array.isArray(meta.sources) ? meta.sources.length : 0;
    if (sources > 0) parts.push(plural(sources, 'source'));
    return parts.join(' · ');
  }
  if (item.kind === 'topic') {
    const parts = [meta.role === 'primary' ? 'You own this topic' : meta.role === 'required' ? 'Your answer is required' : 'You were asked to weigh in'];
    const comments = Number(meta.commentCount) || 0;
    parts.push(comments === 0 ? 'no replies yet' : plural(comments, 'comment'));
    return parts.join(' · ');
  }
  if (item.kind === 'round') {
    return meta.required ? 'You are a required reviewer' : 'You are a reviewer';
  }
  if (item.kind === 'package') {
    const via = meta.source === 'mcp' ? 'uploaded through MCP' : 'uploaded in Odin';
    return meta.version ? `Package v${meta.version} · ${via}` : via;
  }
  return '';
}

/** The proposed-answer status chip for a topic to decide, when the payload carries the status. */
export function myItemAnswerChip(item = {}) {
  if (item.kind !== 'topic' || item.action !== 'decide') return null;
  return proposedAnswerStatusChip(item.meta?.proposedAnswerStatus, { blocking: item.meta?.signals?.blocking });
}

/** The right-hand timing text and whether it is a due date to highlight. */
export function myItemWhen(item = {}, { locale, now = new Date() } = {}) {
  const meta = item.meta ?? {};
  if (item.kind === 'topic' && item.action === 'decide') {
    const since = formatRelativeDay(meta.readySince ?? item.updatedAt, { locale, now });
    return { due: false, text: since ? `ready since ${since}` : '' };
  }
  if (item.kind === 'round') {
    if (!meta.dueAt) return { due: false, text: 'no due date' };
    const overdue = isPast(meta.dueAt, { now });
    return { due: true, text: `${overdue ? 'was due' : 'due'} ${formatShortDate(meta.dueAt, { locale, weekday: true })}` };
  }
  if (item.kind === 'package') return { due: false, text: 'not published' };
  if (item.kind === 'topic') return { due: false, text: formatRelativeDay(meta.lastActivityAt ?? item.updatedAt, { locale, now }) };
  return { due: false, text: formatRelativeDay(item.updatedAt ?? item.createdAt, { locale, now }) };
}
