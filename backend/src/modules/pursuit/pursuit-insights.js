// The cards of an engagement's Insights tab. No stages: every card reads facts Odin already
// has. Each card is `{ status, data, message }` as project Insights cards are: `ready`,
// `empty` (with a message) or `error`.
import { isWorkItemDone } from '../metrics/work-completion-metrics.js';
import { addDays, createHistoryReplay, dateOnly, daysBetween, sampleDates, weekStart } from '../insights/insights-history.js';

export const ACTIVITY_WEEKS = 8;
export const NEXT_DUE_LIMIT = 5;
const MAX_BURNUP_POINTS = 30;

const ready = (data) => ({ data, message: '', status: 'ready' });
const empty = (message, data = null) => ({ data, message, status: 'empty' });

export function buildSowCard({ sow }) {
  if (!sow) return empty('No SOW is linked to this engagement.', { linked: false });
  return ready({ history: sow.history, label: sow.label, linked: true, state: sow.state, title: sow.title, url: sow.url });
}

/**
 * Done, open and overdue counts, a burnup of tasks over time, and the next five due. `tasks` are
 * the pursuit tasks now; `events` their revisions, oldest first; `doneStates` the task workflow's.
 */
export function buildTasksCard({ createdAt, doneStates = null, events = [], tasks, today }) {
  const done = (status) => isWorkItemDone('task', status, doneStates);
  const open = tasks.filter((task) => !done(task.status));
  const overdue = open.filter((task) => task.targetEndDate && dateOnly(task.targetEndDate) < today);
  const nextDue = open
    .filter((task) => task.targetEndDate && dateOnly(task.targetEndDate) >= today)
    .sort((left, right) => String(left.targetEndDate).localeCompare(String(right.targetEndDate)) || String(left.name).localeCompare(String(right.name)))
    .slice(0, NEXT_DUE_LIMIT)
    .map((task) => ({ assigneeName: task.assigneeName ?? '', dueDate: dateOnly(task.targetEndDate), id: task.id, name: task.name, status: task.status }));
  const counts = { done: tasks.length - open.length, open: open.length, overdue: overdue.length, total: tasks.length };
  if (!tasks.length && !events.length) return empty('No tasks yet. Add them on the Board tab.', { burnup: [], counts, nextDue });

  const start = [dateOnly(createdAt) ?? today, ...events.map((event) => dateOnly(event.at)).filter(Boolean)].sort()[0];
  const span = Math.max(0, daysBetween(start, today));
  const dates = sampleDates(start, today, Math.max(1, Math.ceil(span / (MAX_BURNUP_POINTS - 1))));
  const items = new Map(tasks.map((task) => [task.id, { assigneeId: task.assigneeId ?? null, exists: true, id: task.id, itemType: 'task', leaf: true, points: task.points ?? null, sprintId: null, status: task.status }]));
  const replay = createHistoryReplay({ events: events.filter((event) => event.itemType === 'task'), items });
  const totals = new Map();
  for (const date of [...dates].sort().reverse()) {
    const states = replay.at(date).filter((state) => state.exists && state.itemType === 'task');
    totals.set(date, { date, done: states.filter((state) => done(state.status)).length, scope: states.length });
  }
  return ready({ burnup: dates.map((date) => totals.get(date)), counts, nextDue });
}

/**
 * Posts and file versions per week by channel, for the last eight weeks, and the last activity.
 * `activity` is `[{ at, actorId, channelId, channelName, kind: 'post' | 'file' }]`.
 */
export function buildActivityCard({ activity, today }) {
  const firstWeek = weekStart(addDays(today, -7 * (ACTIVITY_WEEKS - 1)));
  const weeks = Array.from({ length: ACTIVITY_WEEKS }, (_, index) => addDays(firstWeek, index * 7));
  const channels = new Map();
  let lastActivityAt = null;
  for (const event of activity) {
    const at = event.at ? new Date(event.at).toISOString() : null;
    if (!at) continue;
    if (!lastActivityAt || at > lastActivityAt) lastActivityAt = at;
    const week = weekStart(at);
    if (week < firstWeek) continue;
    const key = event.channelId ?? 'files';
    if (!channels.has(key)) channels.set(key, { files: weeks.map(() => 0), id: key, name: event.channelName ?? 'Files', posts: weeks.map(() => 0) });
    const index = weeks.indexOf(week);
    if (index >= 0) channels.get(key)[event.kind === 'post' ? 'posts' : 'files'][index] += 1;
  }
  const rows = [...channels.values()].sort((left, right) => left.name.localeCompare(right.name));
  const data = { channels: rows, lastActivityAt, weeks };
  return rows.length ? ready(data) : empty('No posts or file versions in the last eight weeks.', data);
}

/**
 * Members and guests, and who posted or changed a file in the last 7 and 30 days. `people` are
 * `[{ id, name, kind: 'member' | 'guest' }]`; activity actors are matched by id.
 */
export function buildPeopleCard({ activity, people, today }) {
  const since = (days) => addDays(today, -(days - 1));
  const latest = new Map();
  for (const event of activity) {
    const day = dateOnly(event.at);
    if (!event.actorId || !day) continue;
    if (!latest.has(event.actorId) || day > latest.get(event.actorId)) latest.set(event.actorId, day);
  }
  const rows = people.map((person) => {
    const lastActiveOn = latest.get(person.id) ?? null;
    return { ...person, active30: Boolean(lastActiveOn && lastActiveOn >= since(30)), active7: Boolean(lastActiveOn && lastActiveOn >= since(7)), lastActiveOn };
  // Members first, then guests, each by name.
  }).sort((left, right) => Number(left.kind === 'guest') - Number(right.kind === 'guest') || left.name.localeCompare(right.name));
  const count = (predicate) => rows.filter(predicate).length;
  return ready({
    counts: { active30: count((row) => row.active30), active7: count((row) => row.active7), guests: count((row) => row.kind === 'guest'), members: count((row) => row.kind === 'member') },
    people: rows,
  });
}

/** Days since the engagement opened and since its last activity. */
export function buildAgeCard({ createdAt, lastActivityAt, today }) {
  const opened = dateOnly(createdAt);
  const last = dateOnly(lastActivityAt);
  return ready({
    daysOpen: opened ? Math.max(0, daysBetween(opened, today)) : null,
    daysSinceActivity: last ? Math.max(0, daysBetween(last, today)) : null,
    lastActivityAt: lastActivityAt ?? null,
    openedAt: createdAt ?? null,
  });
}
