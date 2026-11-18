// The Insights timeline (Gantt): every story placed on one axis of working-day offsets from the
// start of the plan, with epics spanning their stories. Tasks are not scheduled on their own:
// their links, sprint and assignee count towards their story.
//
// A story's earliest start comes from, strongest first:
//
//   1. Blocking. A governance dependency (FS, SS, FF or SF with lag) or a "blocks" relation
//      holds the blocked story back until its blocker allows it. A link on an epic applies to
//      every story in it.
//   2. Sprints. A story in a sprint starts no earlier than the sprint does.
//   3. Target dates, for stories in no sprint.
//
// Then people: each person works one open story at a time, so a story starts in its assignee's
// first free stretch long enough for it, from its earliest start on. Finished stories keep
// their earliest start and take no one's time. Stories are taken
// earliest start first, then by sprint, then priority. Unassigned stories go to whichever
// assigned person is free first, so the plan never runs more stories at once than the
// project has people.
//
// Stories that none of the three place are left off and counted. The axis is offsets, not
// calendar dates: dated sprints sit where their dates put them, undated sprints follow the one
// before. Length comes from a story's target dates, then its hours, then its points (a point is
// a working day, never longer than its sprint). Stories with no estimate share what is left
// of their person's sprint; outside a sprint they take a week.

import { isWorkItemDone } from '../metrics/work-completion-metrics.js';
import { addWorkingDays, workingDaysBetween } from '../governance/schedule-analysis.js';
import { emptyCard, readyCard } from './insights-cards.js';
import { dateOnly } from './insights-history.js';

export const GANTT_SPRINT_DAYS = 10;
export const GANTT_DEFAULT_ITEM_DAYS = 5;
export const GANTT_RESOURCE_COLORS = 8;
const DEPENDENCY_TYPES = new Set(['FS', 'SS', 'FF', 'SF']);
const NOT_STARTED = new Set(['', 'Not Started']);

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/** The value most entries share, ignoring blanks; null when there is none. */
function commonest(values) {
  const counts = new Map();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
}

/**
 * Epics and their stories in project order, each with the stories it spans. `alias` maps a
 * task to its story so links on tasks land on the story.
 */
function collectTree(project) {
  const nodes = new Map();
  const alias = new Map();
  const roots = [];
  let order = 0;
  const entryFor = (node, type, parent, tasks = []) => ({
    // A story with no assignee of its own belongs to the one person doing all its tasks.
    assigneeId: node.assigneeId ?? (new Set(tasks.map((task) => task.assigneeId ?? null)).size === 1 ? tasks[0]?.assigneeId ?? null : null),
    assigneeName: node.assigneeName ?? '',
    children: [],
    done: isWorkItemDone(type, node.status),
    id: node.id,
    name: String(node.name ?? ''),
    order: order += 1,
    parent,
    points: node.points ?? null,
    priority: Number(node.priority) || 4,
    progress: Math.max(0, Math.min(100, Number(node.progress) || 0)),
    sprintId: node.sprintId ?? commonest(tasks.map((task) => task.sprintId)),
    status: String(node.status ?? 'Not Started'),
    targetEndDate: dateOnly(node.targetEndDate),
    targetHourEstimate: node.targetHourEstimate ?? null,
    targetStartDate: dateOnly(node.targetStartDate),
    type,
  });
  for (const epic of project?.epics ?? []) {
    if (!epic?.id || nodes.has(epic.id)) continue;
    const root = entryFor(epic, 'epic', null);
    nodes.set(root.id, root);
    roots.push(root);
    for (const story of epic.stories ?? []) {
      if (!story?.id || nodes.has(story.id)) continue;
      const tasks = (story.tasks ?? []).filter((task) => task?.id);
      const entry = entryFor(story, 'story', root, tasks);
      nodes.set(entry.id, entry);
      root.children.push(entry);
      for (const task of tasks) alias.set(task.id, entry.id);
    }
  }
  const leavesOf = new Map();
  for (const root of roots) {
    const leaves = root.children.length ? root.children : [root];
    leavesOf.set(root.id, leaves);
    for (const child of root.children) leavesOf.set(child.id, [child]);
  }
  return { alias, leavesOf, nodes, roots };
}

/**
 * Blocking links between epics and stories: governance dependencies, then "blocks" relations
 * as finish-to-start with no lag. Links on tasks move to their stories. One link per pair; a
 * dependency wins over a relation. Links within one epic's own tree are dropped.
 */
export function collectGanttLinks({ alias = new Map(), dependencies = [], nodes, relations = [] }) {
  const links = new Map();
  const add = (link) => {
    const fromId = alias.get(link.from) ?? link.from;
    const toId = alias.get(link.to) ?? link.to;
    const from = nodes.get(fromId);
    const to = nodes.get(toId);
    if (!from || !to || from === to || from.parent === to || to.parent === from) return;
    const key = `${fromId}>${toId}`;
    if (!links.has(key)) links.set(key, { ...link, from: fromId, to: toId });
  };
  for (const edge of dependencies) {
    add({ from: edge.predecessorId, lag: Math.trunc(Number(edge.lagDays) || 0), source: 'dependency', to: edge.successorId, type: DEPENDENCY_TYPES.has(edge.dependencyType) ? edge.dependencyType : 'FS' });
  }
  for (const relation of relations) {
    if (relation.relationType === 'blocks') add({ from: relation.fromItemId, lag: 0, source: 'relation', to: relation.toItemId, type: 'FS' });
  }
  return [...links.values()];
}

function linkStart(link, predecessor, duration) {
  if (link.type === 'SS') return predecessor.start + link.lag;
  if (link.type === 'FF') return predecessor.finish + link.lag - duration;
  if (link.type === 'SF') return predecessor.start + link.lag - duration;
  return predecessor.finish + link.lag;
}

/** Sprints laid on the offset axis: dated ones by their dates, undated after the one before. */
function placeSprints({ calendar, offsetOf, sprints, usedSprintIds }) {
  const placed = [];
  let cursor = 0;
  for (const sprint of sprints) {
    const used = usedSprintIds.has(sprint.id);
    if (!used && !['active', 'planned'].includes(sprint.status)) continue;
    const start = sprint.startDate ? offsetOf(sprint.startDate) : cursor;
    const length = sprint.startDate && sprint.endDate && sprint.endDate >= sprint.startDate
      ? Math.max(1, workingDaysBetween(sprint.startDate, sprint.endDate, calendar, { inclusive: true }) ?? GANTT_SPRINT_DAYS)
      : GANTT_SPRINT_DAYS;
    const entry = { dated: Boolean(sprint.startDate), end: start + length, id: sprint.id, name: sprint.name, start, status: sprint.status };
    placed.push(entry);
    cursor = Math.max(cursor, entry.end);
  }
  return placed.sort((left, right) => left.start - right.start || left.end - right.end);
}

function estimateFor(leaf, { calendar, sprint }) {
  if (leaf.targetStartDate && leaf.targetEndDate && leaf.targetEndDate >= leaf.targetStartDate) {
    return { days: Math.max(1, workingDaysBetween(leaf.targetStartDate, leaf.targetEndDate, calendar, { inclusive: true }) ?? 1), source: 'dates' };
  }
  const hours = positive(leaf.targetHourEstimate);
  if (hours) return { days: Math.max(1, Math.ceil(hours / (calendar.hoursPerDay || 8))), source: 'hours' };
  const points = positive(leaf.points);
  if (points) return { days: Math.max(1, Math.min(Math.ceil(points), sprint ? sprint.end - sprint.start : Infinity)), source: 'points' };
  return { days: null, source: sprint ? 'sprint' : 'default' };
}

/**
 * Days for stories with no estimate. In a sprint they split what their person (or, unassigned,
 * the whole team) has left after the estimated stories there; elsewhere they take a week.
 */
function durationsFor(leaves, { calendar, laneOf, teamSize }) {
  const estimates = new Map(leaves.map((leaf) => [leaf.id, estimateFor(leaf, { calendar, sprint: laneOf(leaf) })]));
  const groups = new Map();
  for (const leaf of leaves) {
    const lane = laneOf(leaf);
    if (!lane) continue;
    const key = `${lane.id}:${leaf.assigneeId ?? ''}`;
    const group = groups.get(key) ?? { capacity: (lane.end - lane.start) * (leaf.assigneeId ? 1 : Math.max(1, teamSize)), estimated: 0, open: [] };
    const estimate = estimates.get(leaf.id);
    if (estimate.days != null) group.estimated += estimate.days;
    else group.open.push(leaf);
    groups.set(key, group);
  }
  const durations = new Map();
  for (const leaf of leaves) {
    const estimate = estimates.get(leaf.id);
    if (estimate.days != null) durations.set(leaf.id, estimate);
    else if (!laneOf(leaf)) durations.set(leaf.id, { days: GANTT_DEFAULT_ITEM_DAYS, source: 'default' });
  }
  for (const group of groups.values()) {
    if (group.open.length === 0) continue;
    const lane = laneOf(group.open[0]);
    const share = Math.floor(Math.max(0, group.capacity - group.estimated) / group.open.length);
    for (const leaf of group.open) durations.set(leaf.id, { days: Math.max(1, Math.min(lane.end - lane.start, share)), source: 'sprint' });
  }
  return durations;
}

/** Each person's booked stretches, kept in start order. */
function createCalendars(people) {
  const booked = new Map(people.map((id) => [id, []]));
  return {
    /** The first start at or after `earliest` where `days` fit, and the booking it waits behind. */
    firstFit(personId, earliest, days) {
      let start = earliest;
      let behind = null;
      for (const slot of booked.get(personId)) {
        if (slot.finish <= start) continue;
        if (slot.start >= start + days) break;
        start = slot.finish;
        behind = slot.id;
      }
      return { behind, start };
    },
    book(personId, slot) {
      const slots = booked.get(personId);
      const index = slots.findIndex((entry) => entry.start > slot.start);
      slots.splice(index < 0 ? slots.length : index, 0, slot);
    },
  };
}

/** Resources ordered by name; past eight people only the busiest keep a colour. */
function resourcesFor(leaves, { memberNames, timing }) {
  const byId = new Map();
  for (const leaf of leaves) {
    if (!leaf.assigneeId) continue;
    const entry = byId.get(leaf.assigneeId) ?? { count: 0, finish: 0, id: leaf.assigneeId, name: memberNames.get(leaf.assigneeId) || leaf.assigneeName || 'Former member', open: 0 };
    entry.count += 1;
    if (!leaf.done) entry.open += 1;
    entry.finish = Math.max(entry.finish, timing.get(leaf.id).finish);
    byId.set(leaf.assigneeId, entry);
  }
  const all = [...byId.values()];
  const colored = new Set([...all].sort((left, right) => right.count - left.count || left.name.localeCompare(right.name)).slice(0, GANTT_RESOURCE_COLORS).map((entry) => entry.id));
  let slot = 0;
  return all
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => ({ ...entry, slot: colored.has(entry.id) ? (slot += 1) : null }));
}

/**
 * Schedules the project's stories. Takes the project tree, its sprints in planning order,
 * governance dependencies, work-item relations, the working calendar, member names and today.
 */
export function scheduleGantt({ calendar, dependencies = [], memberNames = new Map(), project, relations = [], sprints = [], today }) {
  const { alias, leavesOf, nodes, roots } = collectTree(project);
  const links = collectGanttLinks({ alias, dependencies, nodes, relations });
  const sprintById = new Map(sprints.map((sprint) => [sprint.id, sprint]));
  const leaves = [...nodes.values()].filter((node) => node.children.length === 0);
  const sprintOf = (leaf) => (sprintById.has(leaf.sprintId) ? leaf.sprintId : null);

  // Anchor: the earliest sprint or story start; the project start only when nothing is dated.
  const datedStarts = [
    ...sprints.filter((sprint) => sprint.startDate).map((sprint) => sprint.startDate),
    ...leaves.filter((leaf) => !sprintOf(leaf) && leaf.targetStartDate).map((leaf) => leaf.targetStartDate),
  ].sort();
  const anchorValue = datedStarts[0] ?? dateOnly(project?.startDate) ?? null;
  const anchor = anchorValue ? addWorkingDays(anchorValue, 0, calendar) : null;
  const offsetOf = (date) => (anchor ? Math.max(0, workingDaysBetween(anchor, addWorkingDays(date, 0, calendar), calendar) ?? 0) : 0);

  const sprintLanes = placeSprints({ calendar, offsetOf, sprints, usedSprintIds: new Set(leaves.map(sprintOf).filter(Boolean)) });
  const laneById = new Map(sprintLanes.map((lane) => [lane.id, lane]));
  const laneOf = (leaf) => laneById.get(sprintOf(leaf)) ?? null;

  // A story is linked when it, or its epic, blocks or is blocked.
  const linkedIds = new Set(links.flatMap((link) => [link.from, link.to]));
  const incoming = new Map(leaves.map((leaf) => [leaf.id, []]));
  for (const link of links) for (const leaf of leavesOf.get(link.to)) incoming.get(leaf.id).push(link);
  const isLinked = (leaf) => linkedIds.has(leaf.id) || (leaf.parent && linkedIds.has(leaf.parent.id));
  const placeable = leaves.filter((leaf) => laneOf(leaf) || (leaf.targetStartDate && anchor) || isLinked(leaf));
  const placeableIds = new Set(placeable.map((leaf) => leaf.id));

  const people = [...new Set(placeable.map((leaf) => leaf.assigneeId).filter(Boolean))].sort();
  const durations = durationsFor(placeable, { calendar, laneOf, teamSize: people.length });
  const calendars = createCalendars(people);

  // Ready stories (every blocker placed) are taken earliest start first; stories left when
  // none are ready are in a blocking loop and are placed without their links.
  const waitsOn = new Map(placeable.map((leaf) => [leaf.id, new Set(incoming.get(leaf.id).flatMap((link) => leavesOf.get(link.from).filter((entry) => placeableIds.has(entry.id) && entry !== leaf).map((entry) => entry.id)))]));
  const dependents = new Map(placeable.map((leaf) => [leaf.id, []]));
  for (const [id, waits] of waitsOn) for (const other of waits) dependents.get(other).push(id);
  const pending = new Map([...waitsOn].map(([id, waits]) => [id, waits.size]));

  const timing = new Map();
  const cyclic = new Set();
  const aggregate = (id) => {
    let start = Infinity;
    let finish = -Infinity;
    for (const leaf of leavesOf.get(id)) {
      const entry = timing.get(leaf.id);
      if (!entry) continue;
      start = Math.min(start, entry.start);
      finish = Math.max(finish, entry.finish);
    }
    return Number.isFinite(start) ? { finish, start } : null;
  };
  const earliestFor = (leaf, { ignoreLinks = false } = {}) => {
    const lane = laneOf(leaf);
    const { days } = durations.get(leaf.id);
    let start = 0;
    let driver = { kind: 'start' };
    if (lane) {
      start = lane.start;
      driver = { kind: 'sprint', sprintId: lane.id };
    } else if (leaf.targetStartDate && anchor) {
      start = offsetOf(leaf.targetStartDate);
      driver = { kind: 'dates' };
    }
    for (const link of ignoreLinks ? [] : incoming.get(leaf.id)) {
      const predecessor = aggregate(link.from);
      if (!predecessor) continue;
      const candidate = Math.max(0, linkStart(link, predecessor, days));
      if (candidate > start) {
        start = candidate;
        driver = { itemId: link.from, kind: 'blocker', source: link.source, type: link.type };
      }
    }
    return { driver, start };
  };
  const rank = (left, right) => left.earliest.start - right.earliest.start
    || (laneOf(left.leaf)?.start ?? Infinity) - (laneOf(right.leaf)?.start ?? Infinity)
    || left.leaf.priority - right.leaf.priority
    || left.leaf.order - right.leaf.order;
  const place = (leaf, earliest) => {
    const { days, source } = durations.get(leaf.id);
    let start = earliest.start;
    let driver = earliest.driver;
    let trackId = leaf.assigneeId;
    // Finished work stays where its dates or blockers put it. It is history: it neither waits
    // for its person nor holds their open work back, which pushed launches weeks past their
    // dates for one person with a week of finished stories behind them.
    if (people.length > 0 && !leaf.done) {
      // Unassigned: the person who can start it first, then the one with less booked.
      const candidates = leaf.assigneeId ? [leaf.assigneeId] : people;
      let best = null;
      for (const personId of candidates) {
        const fit = calendars.firstFit(personId, earliest.start, days);
        if (!best || fit.start < best.fit.start) best = { fit, personId };
      }
      start = best.fit.start;
      trackId = best.personId;
      if (start > earliest.start && best.fit.behind) driver = { assigneeId: trackId, itemId: best.fit.behind, kind: 'resource' };
      calendars.book(trackId, { finish: start + days, id: leaf.id, start });
    }
    timing.set(leaf.id, { driver, duration: days, durationSource: source, earliest: earliest.start, finish: start + days, lane: laneOf(leaf), start, trackId });
  };

  const ready = placeable.filter((leaf) => pending.get(leaf.id) === 0).map((leaf) => ({ earliest: earliestFor(leaf), leaf }));
  while (timing.size < placeable.length) {
    if (ready.length === 0) {
      const stuck = placeable.filter((leaf) => !timing.has(leaf.id));
      for (const leaf of stuck) cyclic.add(leaf.id);
      stuck.map((leaf) => ({ earliest: earliestFor(leaf, { ignoreLinks: true }), leaf })).sort(rank).forEach(({ earliest, leaf }) => place(leaf, earliest));
      break;
    }
    ready.sort(rank);
    const { earliest, leaf } = ready.shift();
    place(leaf, earliest);
    for (const next of dependents.get(leaf.id)) {
      pending.set(next, pending.get(next) - 1);
      if (pending.get(next) === 0) ready.push({ earliest: earliestFor(nodes.get(next)), leaf: nodes.get(next) });
    }
  }

  // Today on the axis: only when the dates behind the axis can say where today is.
  const activeLane = sprintLanes.find((lane) => lane.status === 'active') ?? null;
  let now = null;
  if (anchor && today && (!activeLane || activeLane.dated)) now = workingDaysBetween(anchor, addWorkingDays(today, 0, calendar), calendar);
  else if (activeLane) now = activeLane.start;
  const finishes = [...timing.values()].map((entry) => entry.finish);
  const total = Math.max(1, ...finishes, ...sprintLanes.map((lane) => lane.end));
  if (now != null && (now < 0 || now > total)) now = null;

  // Critical chain: back from the latest finish through whatever held each story back, a
  // blocker or the person it waited for.
  const critical = new Set();
  if (finishes.length > 0 && (links.length > 0 || people.length > 0)) {
    const end = Math.max(...finishes);
    const stack = [...timing].filter(([, entry]) => entry.finish === end).map(([id]) => id);
    while (stack.length) {
      const id = stack.pop();
      if (critical.has(id)) continue;
      critical.add(id);
      const { driver } = timing.get(id);
      if (driver.kind === 'resource') stack.push(driver.itemId);
      if (driver.kind !== 'blocker') continue;
      const binding = leavesOf.get(driver.itemId).filter((leaf) => timing.has(leaf.id));
      const latest = Math.max(...binding.map((leaf) => timing.get(leaf.id).finish));
      stack.push(...binding.filter((leaf) => timing.get(leaf.id).finish === latest).map((leaf) => leaf.id));
    }
    // A chain of one is not a path worth showing.
    if (critical.size < 2) critical.clear();
  }

  const doneOf = (id) => {
    const node = nodes.get(id);
    return node.children.length === 0 ? node.done : node.children.every((child) => child.done);
  };
  const blockerEntry = (link, viaId) => ({ done: doneOf(link.from), id: link.from, lag: link.lag, name: nodes.get(link.from).name, source: link.source, type: link.type, viaId });

  const rows = [];
  const emitLeaf = (node, level) => {
    const entry = timing.get(node.id);
    const blockedBy = incoming.get(node.id).map((link) => blockerEntry(link, link.to === node.id ? null : link.to));
    const openBlockers = blockedBy.filter((blocker) => !blocker.done);
    const activelyBlocked = !node.done && openBlockers.length > 0 && (entry.lane?.status === 'active' || !NOT_STARTED.has(node.status) || (now != null && entry.start <= now));
    rows.push({
      activelyBlocked,
      assigneeId: node.assigneeId,
      blockedBy,
      critical: critical.has(node.id),
      cyclic: cyclic.has(node.id),
      done: node.done,
      driver: entry.driver,
      durationSource: entry.durationSource,
      // Where blockers and its sprint alone would start it; any later start is waiting for people.
      earliest: entry.earliest,
      finish: entry.finish,
      id: node.id,
      late: !node.done && now != null && entry.finish <= now,
      leaf: true,
      level,
      name: node.name,
      parentId: node.parent?.id ?? null,
      points: node.points ?? null,
      progress: node.done ? 100 : node.progress,
      slipsSprint: Boolean(entry.lane && entry.finish > entry.lane.end),
      sprintId: entry.lane?.id ?? null,
      start: entry.start,
      status: node.status,
      trackId: entry.trackId ?? null,
      type: node.type,
    });
  };
  const bySpan = (left, right) => left.span.start - right.span.start || left.span.finish - right.span.finish || left.node.order - right.node.order;
  const orderedRoots = roots.map((node) => ({ node, span: aggregate(node.id) })).filter((entry) => entry.span).sort(bySpan);
  for (const { node: root, span } of orderedRoots) {
    if (root.children.length === 0) {
      emitLeaf(root, 0);
      continue;
    }
    const children = root.children.map((node) => ({ node, span: aggregate(node.id) })).filter((entry) => entry.span).sort(bySpan);
    const childRows = children.map(({ node }) => node);
    rows.push({
      assigneeId: root.assigneeId,
      blockedBy: links.filter((link) => link.to === root.id).map((link) => blockerEntry(link, null)),
      doneCount: childRows.filter((node) => node.done).length,
      done: childRows.every((node) => node.done),
      finish: span.finish,
      id: root.id,
      leaf: false,
      leafCount: childRows.length,
      level: 0,
      name: root.name,
      parentId: null,
      progress: Math.round((childRows.filter((node) => node.done).length / childRows.length) * 100),
      start: span.start,
      status: root.status,
      type: root.type,
    });
    const first = rows.length;
    for (const node of childRows) emitLeaf(node, 1);
    const summary = rows[first - 1];
    summary.blockedCount = rows.slice(first).filter((row) => row.activelyBlocked).length;
    summary.lateCount = rows.slice(first).filter((row) => row.late).length;
  }

  // Calendar dates for the offsets, when the axis is anchored: the first and last working day.
  if (anchor) {
    for (const row of rows) {
      row.startDate = addWorkingDays(anchor, row.start, calendar);
      row.finishDate = addWorkingDays(anchor, Math.max(row.start, row.finish - 1), calendar);
    }
  }

  const placedLeaves = placeable;
  const unscheduled = leaves.filter((leaf) => !timing.has(leaf.id)).map((leaf) => ({ id: leaf.id, name: leaf.name, type: leaf.type }));
  const leafRows = rows.filter((row) => row.leaf);
  return {
    activeSprintId: activeLane?.id ?? null,
    anchorDate: anchor,
    anchored: Boolean(anchor),
    counts: {
      blocked: leafRows.filter((row) => row.activelyBlocked).length,
      critical: critical.size,
      cyclic: cyclic.size,
      late: leafRows.filter((row) => row.late).length,
      leveled: leafRows.filter((row) => row.driver.kind === 'resource').length,
      links: links.length,
      noEstimate: leafRows.filter((row) => ['sprint', 'default'].includes(row.durationSource)).length,
      placed: placedLeaves.length,
      slipping: leafRows.filter((row) => row.slipsSprint && !row.done).length,
      unassigned: leafRows.filter((row) => !row.assigneeId).length,
    },
    links: links.map((link) => ({ ...link, done: doneOf(link.from) })).filter((link) => aggregate(link.from) && aggregate(link.to)),
    now,
    resources: resourcesFor(placedLeaves, { memberNames, timing }),
    rows,
    sprints: sprintLanes,
    total,
    unscheduled,
  };
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

export function buildGanttCard(ctx) {
  const hasWork = (ctx.project?.epics ?? []).length > 0;
  if (!hasWork) return emptyCard('No work items yet. Add epics and stories to the project structure.', { label: 'Open project structure', target: 'structure' });
  const data = scheduleGantt({
    calendar: ctx.calendar,
    dependencies: ctx.governance?.dependencies ?? [],
    memberNames: ctx.memberNames,
    project: ctx.project,
    relations: ctx.relations ?? [],
    sprints: ctx.sprints,
    today: ctx.today,
  });
  if (data.rows.length === 0) {
    return emptyCard('Nothing to put on a timeline yet. Plan stories into sprints, or set which items block which, and the plan appears here.', { label: 'Open sprints', target: 'sprints' });
  }
  const notes = [];
  if (data.counts.cyclic > 0) notes.push(`${plural(data.counts.cyclic, 'story is', 'stories are')} in a blocking loop, so ${data.counts.cyclic === 1 ? 'it is' : 'they are'} placed without ${data.counts.cyclic === 1 ? 'its' : 'their'} blocking links. Check the links in Governance.`);
  if (data.unscheduled.length > 0) notes.push(`${plural(data.unscheduled.length, 'story is', 'stories are')} in no sprint, with no target start and nothing blocking ${data.unscheduled.length === 1 ? 'it' : 'them'}, so ${data.unscheduled.length === 1 ? 'it is' : 'they are'} not on the timeline.`);
  if (data.resources.length === 0) notes.push('Nobody is assigned to the planned stories, so they run side by side. Assign people to see how long the work takes one story at a time.');
  return readyCard(data, notes);
}
