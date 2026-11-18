function flattenWorkItems(project = {}) {
  const items = [];
  for (const epic of project.epics ?? []) {
    items.push({ ...epic, type: 'epic' });
    for (const story of epic.stories ?? []) {
      items.push({ ...story, parentId: epic.id, type: 'story' });
      for (const task of story.tasks ?? []) items.push({ ...task, parentId: story.id, type: 'task' });
    }
  }
  return items;
}

export function normalizeWorkingCalendar(calendar = null) {
  return {
    holidays: [...new Set(calendar?.holidays ?? [])],
    hoursPerDay: Number(calendar?.hoursPerDay ?? 8),
    timezone: calendar?.timezone ?? 'UTC',
    workingDays: [...new Set(calendar?.workingDays ?? [1, 2, 3, 4, 5])],
  };
}

function parseDate(value) {
  const timestamp = Date.parse(`${String(value ?? '').slice(0, 10)}T00:00:00.000Z`);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function isWorkingDate(date, calendar) {
  return calendar.workingDays.includes(date.getUTCDay()) && !calendar.holidays.includes(date.toISOString().slice(0, 10));
}

export function addWorkingDays(value, days, calendarInput = null) {
  const calendar = normalizeWorkingCalendar(calendarInput);
  const date = parseDate(value);
  if (!date || !Number.isFinite(Number(days))) return null;
  let remaining = Math.abs(Math.trunc(Number(days)));
  const direction = Number(days) < 0 ? -1 : 1;
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + direction);
    if (isWorkingDate(date, calendar)) remaining -= 1;
  }
  while (!isWorkingDate(date, calendar)) date.setUTCDate(date.getUTCDate() + direction);
  return date.toISOString().slice(0, 10);
}

function buildWorkingDateOffsets(value, maximumOffset, calendar) {
  const date = parseDate(value);
  if (!date) return [];
  while (!isWorkingDate(date, calendar)) date.setUTCDate(date.getUTCDate() + 1);
  const dates = [date.toISOString().slice(0, 10)];
  for (let offset = 1; offset <= maximumOffset; offset += 1) {
    do date.setUTCDate(date.getUTCDate() + 1);
    while (!isWorkingDate(date, calendar));
    dates.push(date.toISOString().slice(0, 10));
  }
  return dates;
}

export function workingDaysBetween(start, end, calendarInput = null, { inclusive = false } = {}) {
  const calendar = normalizeWorkingCalendar(calendarInput);
  const left = parseDate(start); const right = parseDate(end);
  if (!left || !right) return null;
  if (left.valueOf() === right.valueOf()) return inclusive && isWorkingDate(left, calendar) ? 1 : 0;
  const direction = left < right ? 1 : -1;
  let count = 0;
  const cursor = new Date(left);
  if (!inclusive) cursor.setUTCDate(cursor.getUTCDate() + direction);
  while (direction > 0 ? cursor <= right : cursor >= right) {
    if (isWorkingDate(cursor, calendar)) count += direction;
    cursor.setUTCDate(cursor.getUTCDate() + direction);
  }
  return count;
}

function durationDays(start, end, calendar) {
  const value = workingDaysBetween(start, end, calendar, { inclusive: true });
  return value == null || value <= 0 ? 1 : value;
}

function dependencyStart(edge, predecessor, successorDuration) {
  const lag = Number(edge.lagDays ?? 0);
  if (edge.dependencyType === 'SS') return predecessor.start + lag;
  if (edge.dependencyType === 'FF') return predecessor.finish + lag - successorDuration;
  if (edge.dependencyType === 'SF') return predecessor.start + lag - successorDuration;
  return predecessor.finish + lag;
}

function predecessorLatestStart(edge, successor, predecessorDuration) {
  const lag = Number(edge.lagDays ?? 0);
  if (edge.dependencyType === 'SS') return successor.latestStart - lag;
  if (edge.dependencyType === 'FF') return successor.latestFinish - lag - predecessorDuration;
  if (edge.dependencyType === 'SF') return successor.latestFinish - lag;
  return successor.latestStart - lag - predecessorDuration;
}

function baselineVariance(project, workItems, milestones, baseline, calendar) {
  if (!baseline?.snapshot) return null;
  const baselineItems = new Map((baseline.snapshot.items ?? []).map((item) => [item.id, item]));
  const currentItems = new Map(workItems.map((item) => [item.id, item]));
  const itemVariances = [];
  for (const item of workItems) {
    const original = baselineItems.get(item.id);
    if (!original) continue;
    const startVarianceWorkingDays = workingDaysBetween(original.targetStartDate, item.targetStartDate, calendar);
    const finishVarianceWorkingDays = workingDaysBetween(original.targetEndDate, item.targetEndDate, calendar);
    if (startVarianceWorkingDays || finishVarianceWorkingDays) itemVariances.push({ finishVarianceWorkingDays, id: item.id, name: item.name, startVarianceWorkingDays, type: item.type });
  }
  const baselineMilestones = new Map((baseline.snapshot.milestones ?? []).map((item) => [item.id, item]));
  const milestoneVariances = milestones.flatMap((milestone) => {
    const original = baselineMilestones.get(milestone.id);
    if (!original) return [];
    const varianceWorkingDays = workingDaysBetween(original.targetDate, milestone.targetDate, calendar);
    return varianceWorkingDays ? [{ id: milestone.id, title: milestone.title, varianceWorkingDays }] : [];
  });
  return {
    baselineCapturedAt: baseline.capturedAt,
    baselineId: baseline.id,
    baselineName: baseline.name,
    itemVariances,
    milestoneVariances,
    projectFinishVarianceWorkingDays: workingDaysBetween(baseline.snapshot.project?.endDate, project.endDate, calendar),
    projectStartVarianceWorkingDays: workingDaysBetween(baseline.snapshot.project?.startDate, project.startDate, calendar),
    scopeAddedCount: [...currentItems.keys()].filter((id) => !baselineItems.has(id)).length,
    scopeRemovedCount: [...baselineItems.keys()].filter((id) => !currentItems.has(id)).length,
  };
}

export function analyzeProjectSchedule(project = {}, dependencies = [], { baseline = null, calendar: calendarInput = null, milestones = [] } = {}) {
  const calendar = normalizeWorkingCalendar(calendarInput);
  const workItems = flattenWorkItems(project).filter((item) => item.id);
  const byId = new Map(workItems.map((item) => [item.id, item]));
  const edges = dependencies.filter((edge) => byId.has(edge.predecessorId) && byId.has(edge.successorId));
  const incoming = new Map(workItems.map((item) => [item.id, []]));
  const outgoing = new Map(workItems.map((item) => [item.id, []]));
  for (const edge of edges) { incoming.get(edge.successorId).push(edge); outgoing.get(edge.predecessorId).push(edge); }
  const indegree = new Map([...incoming].map(([itemId, values]) => [itemId, values.length]));
  const queue = workItems.filter((item) => indegree.get(item.id) === 0).map((item) => item.id).sort();
  const order = [];
  while (queue.length) {
    const itemId = queue.shift(); order.push(itemId);
    for (const edge of outgoing.get(itemId)) {
      indegree.set(edge.successorId, indegree.get(edge.successorId) - 1);
      if (indegree.get(edge.successorId) === 0) queue.push(edge.successorId);
    }
    queue.sort();
  }
  const cyclicItemIds = workItems.map((item) => item.id).filter((itemId) => !order.includes(itemId));
  const datedStarts = workItems.map((item) => item.targetStartDate).filter(Boolean);
  const scheduleAnchorValue = [project.startDate, ...datedStarts].filter(Boolean).sort().at(0) ?? null;
  const scheduleAnchor = scheduleAnchorValue ? addWorkingDays(scheduleAnchorValue, 0, calendar) : null;
  const timing = new Map(); const parent = new Map();
  for (const itemId of order) {
    const item = byId.get(itemId); const duration = durationDays(item.targetStartDate, item.targetEndDate, calendar);
    let start = scheduleAnchor && item.targetStartDate
      ? Math.max(0, workingDaysBetween(scheduleAnchor, addWorkingDays(item.targetStartDate, 0, calendar), calendar) ?? 0)
      : 0;
    for (const edge of incoming.get(itemId)) {
      const candidate = dependencyStart(edge, timing.get(edge.predecessorId) ?? { finish: 0, start: 0 }, duration);
      if (candidate >= start) { start = candidate; parent.set(itemId, edge.predecessorId); }
    }
    timing.set(itemId, { duration, finish: start + duration, start });
  }
  const projectFinish = Math.max(0, ...[...timing.values()].map((item) => item.finish));
  const latest = new Map([...timing].map(([itemId, item]) => [itemId, {
    latestFinish: projectFinish,
    latestStart: projectFinish - item.duration,
  }]));
  for (const itemId of [...order].reverse()) {
    const itemTiming = timing.get(itemId);
    let latestStart = latest.get(itemId)?.latestStart ?? projectFinish - itemTiming.duration;
    for (const edge of outgoing.get(itemId)) {
      const successor = latest.get(edge.successorId);
      latestStart = Math.min(latestStart, predecessorLatestStart(edge, successor, itemTiming.duration));
    }
    latest.set(itemId, { latestFinish: latestStart + itemTiming.duration, latestStart });
  }
  let endId = [...timing].sort((a, b) => b[1].finish - a[1].finish)[0]?.[0] ?? null;
  const criticalPathIds = [];
  while (endId) { criticalPathIds.unshift(endId); endId = parent.get(endId) ?? null; }
  const projectedDates = scheduleAnchor
    ? buildWorkingDateOffsets(scheduleAnchor, Math.max(0, projectFinish - 1), calendar)
    : [];
  const forecastFinish = scheduleAnchor && projectFinish > 0
    ? projectedDates[projectFinish - 1]
    : workItems.map((item) => item.targetEndDate).filter(Boolean).sort().at(-1) ?? project.endDate ?? null;
  const latestBaseline = baseline ?? null;
  const itemTimings = order.map((itemId) => {
    const item = byId.get(itemId);
    const itemTiming = timing.get(itemId);
    const latestTiming = latest.get(itemId);
    return {
      durationWorkingDays: itemTiming.duration,
      finishOffsetWorkingDays: itemTiming.finish,
      forecastFinish: scheduleAnchor ? projectedDates[itemTiming.finish - 1] : null,
      forecastStart: scheduleAnchor ? projectedDates[itemTiming.start] : null,
      id: itemId,
      name: item.name,
      startOffsetWorkingDays: itemTiming.start,
      totalFloatWorkingDays: Math.max(0, latestTiming.latestStart - itemTiming.start),
      type: item.type,
    };
  });
  const itemTimingsById = new Map(itemTimings.map((item) => [item.id, item]));
  const milestoneForecasts = milestones.map((milestone) => {
    const linkedTiming = itemTimingsById.get(milestone.workItemId);
    const forecastDate = linkedTiming?.forecastFinish ?? milestone.targetDate ?? null;
    return {
      forecastDate,
      id: milestone.id,
      targetDate: milestone.targetDate ?? null,
      title: milestone.title,
      varianceWorkingDays: milestone.targetDate && forecastDate
        ? workingDaysBetween(milestone.targetDate, forecastDate, calendar)
        : null,
      workItemId: milestone.workItemId ?? null,
    };
  });
  return {
    baselineVariance: baselineVariance(project, workItems, milestones, latestBaseline, latestBaseline?.snapshot?.calendar ?? calendar),
    calendar,
    criticalPathIds,
    cyclicItemIds,
    dependencyCount: edges.length,
    forecastFinish,
    forecastVarianceDays: project.endDate && forecastFinish ? workingDaysBetween(project.endDate, forecastFinish, calendar) : null,
    itemTimings,
    milestoneForecasts,
    milestoneCount: milestones.length,
    passed: cyclicItemIds.length === 0,
    totalDurationDays: criticalPathIds.length ? timing.get(criticalPathIds.at(-1)).finish : 0,
    workItemCount: workItems.length,
  };
}
