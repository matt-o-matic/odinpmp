// Helpers for the Insights timeline (Gantt) card: which rows show, how links route between
// them, and the words the tooltip and table use. The backend (modules/insights/insights-gantt.js)
// does the scheduling; everything here is presentation.

export const GANTT_ROW_HEIGHT = 34;
export const GANTT_SUMMARY_ROW_HEIGHT = 30;
export const GANTT_ZOOMS = Object.freeze([0, 14, 22, 34, 52]);

const TYPE_LABELS = Object.freeze({ epic: 'Epic', person: 'Person', story: 'Story' });
const SOURCE_LABELS = Object.freeze({
  dates: 'target dates',
  default: 'no estimate, so a week',
  hours: 'hour estimate',
  points: 'points, a day each',
  sprint: 'no estimate, so a share of its sprint',
});
const LINK_LABELS = Object.freeze({ FF: 'finish-to-finish', FS: 'finish-to-start', SF: 'start-to-finish', SS: 'start-to-start' });

export function typeLabel(type) {
  return TYPE_LABELS[type] ?? 'Item';
}

export function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

/** "Day 3" is the fourth working day: offsets count from zero, labels from one. */
export function dayLabel(offset) {
  return `Day ${offset + 1}`;
}

export function spanLabel(row) {
  const days = row.finish - row.start;
  return `${dayLabel(row.start)}–${dayLabel(Math.max(row.start, row.finish - 1))} · ${plural(days, 'working day')}`;
}

export function durationSourceLabel(source) {
  return SOURCE_LABELS[source] ?? '';
}

/** Resource lookup: colour slot, display name and short name for each assignee. */
export function resourceIndex(resources = []) {
  const map = new Map();
  for (const resource of resources) {
    const first = String(resource.name ?? '').trim().split(/\s+/)[0] || resource.name;
    map.set(resource.id, { ...resource, short: first });
  }
  return map;
}

/** The CSS colour for a row's assignee: a palette slot, "other" past eight people, or unassigned. */
export function resourceColor(resource) {
  if (!resource) return 'var(--gantt-unassigned)';
  return resource.slot ? `var(--gantt-r${resource.slot})` : 'var(--gantt-other)';
}

/** Why a story starts when it does, in a phrase. */
export function driverLabel(row, { names, resources = new Map(), sprints }) {
  const driver = row.driver;
  if (!driver) return '';
  if (driver.kind === 'resource') {
    const person = resources.get(driver.assigneeId)?.short ?? 'its person';
    return `waits for ${person} to finish ${names.get(driver.itemId) ?? 'other work'}`;
  }
  if (driver.kind === 'blocker') {
    const how = driver.source === 'relation' ? 'blocked by' : `waits on (${LINK_LABELS[driver.type] ?? driver.type})`;
    return `${how} ${names.get(driver.itemId) ?? 'another item'}`;
  }
  if (driver.kind === 'sprint') return `planned in ${sprints.get(driver.sprintId)?.name ?? 'a sprint'}`;
  if (driver.kind === 'dates') return 'its target start date';
  return 'the start of the plan';
}

export function linkPhrase(blocker) {
  const lag = blocker.lag ? ` ${blocker.lag > 0 ? '+' : '−'}${Math.abs(blocker.lag)}d` : '';
  return blocker.source === 'relation' ? 'blocks' : `${blocker.type}${lag}`;
}

/** Rows that are on screen: collapsed parents hide their subtree; done work can be hidden. */
export function visibleGanttRows(rows, { collapsed = new Set(), hideDone = false } = {}) {
  const visible = [];
  const hiddenUnder = [];
  for (const row of rows) {
    while (hiddenUnder.length && hiddenUnder.at(-1).level >= row.level) hiddenUnder.pop();
    if (hiddenUnder.length) continue;
    if (hideDone && row.done) {
      hiddenUnder.push(row);
      continue;
    }
    visible.push(row);
    if (!row.leaf && collapsed.has(row.id)) hiddenUnder.push(row);
  }
  return visible;
}

export const UNASSIGNED_GROUP = 'person:unassigned';

/**
 * The same stories regrouped by person: a summary row per person (name order, unassigned
 * last) spanning their stories, which follow in start order. Epic rows drop out.
 */
export function groupRowsByPerson(rows, resources = []) {
  const groups = new Map();
  for (const row of rows) {
    if (!row.leaf) continue;
    const key = row.assigneeId ? `person:${row.assigneeId}` : UNASSIGNED_GROUP;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const order = [...resources.map((resource) => `person:${resource.id}`), UNASSIGNED_GROUP];
  const grouped = [];
  for (const key of order) {
    const members = groups.get(key);
    if (!members) continue;
    const resource = resources.find((entry) => `person:${entry.id}` === key) ?? null;
    const stories = [...members].sort((left, right) => left.start - right.start || left.finish - right.finish);
    const doneCount = stories.filter((row) => row.done).length;
    grouped.push({
      assigneeId: resource?.id ?? null,
      blockedBy: [],
      blockedCount: stories.filter((row) => row.activelyBlocked).length,
      done: doneCount === stories.length,
      doneCount,
      finish: Math.max(...stories.map((row) => row.finish)),
      id: key,
      lateCount: stories.filter((row) => row.late).length,
      leaf: false,
      leafCount: stories.length,
      level: 0,
      name: resource?.name ?? 'Unassigned',
      parentId: null,
      progress: Math.round((doneCount / stories.length) * 100),
      start: Math.min(...stories.map((row) => row.start)),
      status: '',
      type: 'person',
    });
    for (const row of stories) grouped.push({ ...row, level: 1, parentId: key });
  }
  return grouped;
}

/** Maps each row id to the nearest row on screen (itself, or its collapsed ancestor). */
export function visibleAnchor(rows, visibleIds) {
  const parentOf = new Map(rows.map((row) => [row.id, row.parentId]));
  const cache = new Map();
  const resolve = (id) => {
    if (cache.has(id)) return cache.get(id);
    let cursor = id;
    while (cursor && !visibleIds.has(cursor)) cursor = parentOf.get(cursor) ?? null;
    cache.set(id, cursor);
    return cursor;
  };
  return resolve;
}

/**
 * An elbow path from a blocker's end (or start, for SS and SF) to the blocked item's start (or
 * end, for FF and SF). When the blocked item starts before the blocker ends, the path drops
 * between the rows and doubles back.
 */
export function linkPath({ fromX, fromY, toX, toY }) {
  const gap = 8;
  const down = toY >= fromY ? 1 : -1;
  if (toX - fromX >= gap * 2) {
    const midX = fromX + gap;
    return `M${fromX},${fromY} H${midX} V${toY} H${toX}`;
  }
  const between = toY - down * (GANTT_SUMMARY_ROW_HEIGHT / 2);
  return `M${fromX},${fromY} h${gap} V${between} H${toX - gap} V${toY} H${toX}`;
}

/** Day ticks for the axis: every 5, 10, 20… working days, whichever fits `pxPerDay`. */
export function ganttTicks(total, pxPerDay) {
  const step = [1, 5, 10, 20, 40, 60, 120].find((value) => value * pxPerDay >= 44) ?? 120;
  const ticks = [];
  for (let offset = 0; offset <= total; offset += step) ticks.push(offset);
  return ticks;
}

/** Every item upstream (what holds it back) and downstream (what it holds back) of `id`. */
export function chainOf(id, links, rows) {
  const parentOf = new Map(rows.map((row) => [row.id, row.parentId]));
  const childrenOf = new Map();
  for (const row of rows) if (row.parentId) childrenOf.set(row.parentId, [...(childrenOf.get(row.parentId) ?? []), row.id]);
  const family = (start) => {
    const ids = new Set([start]);
    for (let cursor = parentOf.get(start); cursor; cursor = parentOf.get(cursor)) ids.add(cursor);
    const stack = [start];
    while (stack.length) for (const child of childrenOf.get(stack.pop()) ?? []) if (!ids.has(child)) { ids.add(child); stack.push(child); }
    return ids;
  };
  const chain = new Set(family(id));
  const walk = (direction) => {
    const seen = new Set(family(id));
    const stack = [...seen];
    while (stack.length) {
      const current = stack.pop();
      for (const link of links) {
        const [here, there] = direction === 'up' ? [link.to, link.from] : [link.from, link.to];
        if (here !== current) continue;
        for (const member of family(there)) {
          if (seen.has(member)) continue;
          seen.add(member);
          chain.add(member);
          stack.push(member);
        }
      }
    }
  };
  walk('up');
  walk('down');
  return chain;
}

/** One table row per timeline row, for the card's table view. */
export function ganttTableRows(data) {
  const names = new Map(data.rows.map((row) => [row.id, row.name]));
  const sprints = new Map(data.sprints.map((sprint) => [sprint.id, sprint]));
  const resources = resourceIndex(data.resources);
  return data.rows.map((row) => {
    const flags = [];
    if (row.activelyBlocked) flags.push('Blocked now');
    if (row.late) flags.push('Late');
    if (row.slipsSprint && !row.done) flags.push('Runs past its sprint');
    if (row.critical) flags.push('Critical path');
    if (!row.leaf && row.blockedCount) flags.push(`${row.blockedCount} blocked`);
    return {
      assignee: row.leaf ? resources.get(row.assigneeId)?.name ?? 'Unassigned' : '',
      blockedBy: (row.blockedBy ?? []).map((blocker) => `${blocker.name}${blocker.done ? ' (done)' : ''}`).join(', ') || '—',
      days: row.finish - row.start,
      finish: dayLabel(Math.max(row.start, row.finish - 1)),
      flags: flags.join(', ') || '—',
      item: `${'  '.repeat(row.level)}${row.name}`,
      key: row.id,
      placedBy: row.leaf ? driverLabel(row, { names, resources, sprints }) : `${row.doneCount} of ${row.leafCount} stories done`,
      sprint: row.sprintId ? sprints.get(row.sprintId)?.name ?? '' : '',
      start: dayLabel(row.start),
      status: row.done ? 'Done' : row.status,
      type: typeLabel(row.type),
    };
  });
}
