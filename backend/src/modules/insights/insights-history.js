// Rebuilds a project's work items as they stood on past days, from the item revisions every
// write records (project_item_revisions). Replay runs backwards: it starts from today's tree
// and undoes each revision newer than the day asked for. Items without revisions keep their
// current values throughout, so a project with no history reads as flat, not empty.
//
// What revisions do not cover stays at today's value: moving work between sprints through
// sprint planning writes no revision, so sprint membership on past days is today's membership
// unless an item edit recorded it.

import { isWorkItemDone } from '../metrics/work-completion-metrics.js';

export const WORK_ITEM_TYPES = new Set(['epic', 'story', 'task']);
const DAY_MS = 86_400_000;

export function dateOnly(value) {
  if (value instanceof Date) return Number.isNaN(value.valueOf()) ? null : value.toISOString().slice(0, 10);
  const text = String(value ?? '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && Number.isFinite(Date.parse(`${text}T00:00:00.000Z`)) ? text : null;
}

export function addDays(value, days) {
  const date = new Date(`${dateOnly(value)}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function daysBetween(start, end) {
  return Math.round((Date.parse(`${dateOnly(end)}T00:00:00.000Z`) - Date.parse(`${dateOnly(start)}T00:00:00.000Z`)) / DAY_MS);
}

/** Monday of the week containing `value`. */
export function weekStart(value) {
  const date = new Date(`${dateOnly(value)}T00:00:00.000Z`);
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - (day === 0 ? 6 : day - 1));
  return date.toISOString().slice(0, 10);
}

/** Evenly spaced days from `start` to `end`, always ending on `end`. */
export function sampleDates(start, end, step) {
  const dates = [];
  const span = daysBetween(start, end);
  if (span < 0) return [dateOnly(end)];
  for (let offset = 0; offset < span; offset += Math.max(1, step)) dates.push(addDays(start, offset));
  dates.push(dateOnly(end));
  return dates;
}

export function positivePoints(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function snapshotFields(node) {
  if (!node) return null;
  return {
    assigneeId: node.assigneeId ?? null,
    points: node.points ?? null,
    sprintId: node.sprintId ?? null,
    status: node.status ?? null,
  };
}

/** Today's work items and tickets, keyed by id, with what replay needs to know about each. */
export function collectProjectItems(project) {
  const items = new Map();
  const add = (node, itemType, { epicId = null, leaf, parentId = null }) => {
    if (!node?.id) return;
    items.set(node.id, {
      ...snapshotFields(node),
      epicId,
      exists: true,
      id: node.id,
      itemType,
      leaf,
      name: String(node.name ?? ''),
      parentId,
      targetEndDate: node.targetEndDate ?? null,
      targetHourEstimate: node.targetHourEstimate ?? null,
    });
  };
  for (const epic of project?.epics ?? []) {
    const stories = epic.stories ?? [];
    add(epic, 'epic', { epicId: epic.id, leaf: stories.length === 0 });
    for (const story of stories) {
      const tasks = story.tasks ?? [];
      add(story, 'story', { epicId: epic.id, leaf: tasks.length === 0, parentId: epic.id });
      for (const task of tasks) add(task, 'task', { epicId: epic.id, leaf: true, parentId: story.id });
    }
  }
  for (const ticket of project?.tickets ?? []) add(ticket, 'ticket', { leaf: true, parentId: ticket.parentId ?? null });
  return items;
}

export function isDone(state) {
  return Boolean(state?.exists) && isWorkItemDone(state.itemType, state.status);
}

export function isWorkLeaf(state) {
  return Boolean(state?.exists && state.leaf && WORK_ITEM_TYPES.has(state.itemType));
}

/**
 * Replays history backwards. `events` are compact revisions sorted oldest first:
 * { itemId, itemType, parentId, at, actorUserId, before, after } where before/after are
 * { status, points, sprintId, assigneeId } or null. Returns `at(date)`, which yields the
 * item states at the end of that day; call it with dates in descending order.
 */
export function createHistoryReplay({ events = [], items }) {
  const parents = new Set();
  for (const item of items.values()) if (item.parentId) parents.add(item.parentId);
  for (const event of events) if (event.parentId) parents.add(event.parentId);

  const states = new Map();
  for (const [id, item] of items) states.set(id, { ...item });
  for (const event of events) {
    if (states.has(event.itemId)) continue;
    const leaf = event.itemType === 'task' || event.itemType === 'ticket' || !parents.has(event.itemId);
    states.set(event.itemId, { assigneeId: null, epicId: null, exists: false, id: event.itemId, itemType: event.itemType, leaf, name: '', parentId: event.parentId ?? null, points: null, sprintId: null, status: null });
  }

  let cursor = events.length - 1;
  let lastDate = null;
  return {
    at(date) {
      const day = dateOnly(date);
      if (lastDate && day > lastDate) throw new Error('History replay dates must descend.');
      lastDate = day;
      while (cursor >= 0 && dateOnly(events[cursor].at) > day) {
        const event = events[cursor];
        const state = states.get(event.itemId);
        if (event.before) Object.assign(state, event.before, { exists: true });
        else state.exists = false;
        cursor -= 1;
      }
      return [...states.values()];
    },
  };
}

/** Runs `reduce(states, date)` for each date and returns the results in the dates' order. */
export function replayAt({ dates, events, items, reduce }) {
  const replay = createHistoryReplay({ events, items });
  const order = [...new Set(dates.map(dateOnly))].sort().reverse();
  const results = new Map();
  for (const date of order) results.set(date, reduce(replay.at(date), date));
  return dates.map((date) => results.get(dateOnly(date)));
}

export function weightFor(state, unit) {
  return unit === 'items' ? 1 : positivePoints(state.points);
}

/** Scope, done and unestimated totals over leaf work items. */
export function burnupTotals(states, unit) {
  let scope = 0;
  let done = 0;
  let notEstimated = 0;
  for (const state of states) {
    if (!isWorkLeaf(state)) continue;
    const weight = weightFor(state, unit);
    scope += weight;
    if (isDone(state)) done += weight;
    if (!positivePoints(state.points)) notEstimated += 1;
  }
  return { done, notEstimated, scope };
}

export const FLOW_BUCKETS = Object.freeze(['notStarted', 'inProgress', 'review', 'done']);

export function flowBucket(state) {
  if (isDone(state)) return 'done';
  const status = String(state.status ?? '').trim();
  if (!status || status === 'Not Started') return 'notStarted';
  if (status === 'Review') return 'review';
  return 'inProgress';
}

export function flowTotals(states, unit) {
  const totals = { done: 0, inProgress: 0, notStarted: 0, review: 0 };
  for (const state of states) {
    if (!isWorkLeaf(state)) continue;
    totals[flowBucket(state)] += weightFor(state, unit);
  }
  return totals;
}

export function sprintTotals(states, sprintId, unit) {
  let committed = 0;
  let done = 0;
  let count = 0;
  for (const state of states) {
    if (!isWorkLeaf(state) || state.sprintId !== sprintId) continue;
    const weight = weightFor(state, unit);
    committed += weight;
    count += 1;
    if (isDone(state)) done += weight;
  }
  return { committed, count, done };
}

const TICKET_RESOLVED_STATES = new Set(['closed', 'rejected', 'deferred']);

export function isTicketResolved(status) {
  return TICKET_RESOLVED_STATES.has(String(status ?? '').trim());
}

/**
 * Tickets opened and resolved per bucket. A ticket opens when its create revision is
 * recorded, and resolves each time it moves into closed, rejected or deferred from any
 * other state. `buckets` are ascending start days; the last runs to `end`.
 */
export function ticketFlow({ buckets, end, events }) {
  const rows = buckets.map((start) => ({ opened: 0, resolved: 0, start }));
  const indexFor = (day) => {
    if (day < buckets[0] || day > end) return -1;
    let index = 0;
    while (index + 1 < buckets.length && buckets[index + 1] <= day) index += 1;
    return index;
  };
  for (const event of events) {
    if (event.itemType !== 'ticket') continue;
    const index = indexFor(dateOnly(event.at));
    if (index < 0) continue;
    if (!event.before && event.after) rows[index].opened += 1;
    if (event.before && event.after && !isTicketResolved(event.before.status) && isTicketResolved(event.after.status)) rows[index].resolved += 1;
  }
  return rows;
}

/**
 * Per-person completions in [since, today] from history, following the leaderboard's rules:
 * a leaf moving into done credits its assignee (or whoever saved it when unassigned) one item
 * and its points; moving out of done takes them back.
 */
export function deriveThroughput({ events, items, since }) {
  const leafById = new Map([...items.values()].map((item) => [item.id, item.leaf]));
  const totals = new Map();
  for (const event of events) {
    const day = dateOnly(event.at);
    if (!day || day < since || !event.before || !event.after) continue;
    if (leafById.has(event.itemId) && !leafById.get(event.itemId)) continue;
    const wasDone = isWorkItemDone(event.itemType, event.before.status);
    const nowDone = isWorkItemDone(event.itemType, event.after.status);
    if (wasDone === nowDone) continue;
    const owner = String((nowDone ? event.after : event.before).assigneeId ?? '').trim() || event.actorUserId || null;
    if (!owner) continue;
    const sign = nowDone ? 1 : -1;
    const current = totals.get(owner) ?? { points: 0, tasksCompleted: 0 };
    current.tasksCompleted += sign;
    current.points += sign * Math.round(positivePoints((nowDone ? event.after : event.before).points));
    totals.set(owner, current);
  }
  return [...totals.entries()]
    .map(([id, value]) => ({ hoursLogged: 0, id, points: value.points, tasksCompleted: value.tasksCompleted }))
    .filter((row) => row.points > 0 || row.tasksCompleted > 0);
}
