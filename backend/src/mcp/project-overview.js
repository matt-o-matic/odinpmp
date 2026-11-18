// A compact, decision-ready picture of one project, built from the project detail the REST API
// returns. Used by the odin_project_overview tool and the assistant's per-turn project snapshot.

const DONE_STATUS = /^(completed?|done|closed|resolved|cancel+ed|won'?t do)$/i;

export function isDoneStatus(status = '') {
  return DONE_STATUS.test(String(status ?? '').trim());
}

function truncate(value = '', max = 400) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function flattenProjectItems(project = {}) {
  const rows = [];
  for (const epic of project.epics ?? []) {
    rows.push({ ...epic, itemType: 'epic', parentId: null, parentName: '' });
    for (const story of epic.stories ?? []) {
      rows.push({ ...story, itemType: 'story', parentId: epic.id, parentName: epic.name });
      for (const task of story.tasks ?? []) rows.push({ ...task, itemType: 'task', parentId: story.id, parentName: story.name });
    }
  }
  return rows;
}

export function compactItem(item, { sprintNames = new Map(), description = false } = {}) {
  return {
    id: item.id,
    itemType: item.itemType,
    name: item.name,
    status: item.status ?? '',
    priority: item.priority ?? null,
    points: item.points ?? null,
    hours: item.targetHourEstimate ?? null,
    assignee: item.assigneeName || null,
    assigneeId: item.assigneeId || null,
    sprint: item.sprintId ? (sprintNames.get(item.sprintId) ?? item.sprintId) : null,
    start: item.targetStartDate ?? null,
    due: item.targetEndDate ?? null,
    parent: item.parentName || null,
    parentId: item.parentId ?? null,
    version: item.version ?? null,
    // On the pursuit board rather than the delivery plan (lib/projects/pursuit.js).
    ...(item.pursuit ? { pursuit: true } : {}),
    ...(description ? { description: truncate(item.description, 1500) } : {}),
  };
}

export function activeSprintOf(sprints = []) {
  return sprints.find((sprint) => sprint.status === 'active')
    ?? null;
}

export function buildProjectOverview(project = {}, sprints = [], { today = new Date().toISOString().slice(0, 10) } = {}) {
  const items = flattenProjectItems(project);
  const work = items.filter((item) => item.itemType !== 'epic');
  // Leaf work carries points and hours: tasks, plus stories that have no tasks.
  const leaves = work.filter((item) => item.itemType === 'task' || !(item.tasks ?? []).length);
  const sprintNames = new Map(sprints.map((sprint) => [sprint.id, sprint.name]));
  const open = work.filter((item) => !isDoneStatus(item.status));

  const byStatus = {};
  for (const item of work) byStatus[item.status || 'Unknown'] = (byStatus[item.status || 'Unknown'] ?? 0) + 1;

  const owners = new Map();
  for (const item of work) {
    if (!item.assigneeId && !item.assigneeName) continue;
    const key = item.assigneeId || item.assigneeName;
    const owner = owners.get(key) ?? { assigneeId: item.assigneeId || null, name: item.assigneeName || key, open: 0, done: 0, openPoints: 0 };
    if (isDoneStatus(item.status)) owner.done += 1;
    else { owner.open += 1; owner.openPoints += Number(item.points ?? 0) || 0; }
    owners.set(key, owner);
  }

  const overdue = open
    .filter((item) => item.targetEndDate && String(item.targetEndDate).slice(0, 10) < today)
    .sort((left, right) => String(left.targetEndDate).localeCompare(String(right.targetEndDate)));
  const totalPoints = leaves.reduce((sum, item) => sum + (Number(item.points ?? 0) || 0), 0);
  const donePoints = leaves.filter((item) => isDoneStatus(item.status)).reduce((sum, item) => sum + (Number(item.points ?? 0) || 0), 0);
  const active = activeSprintOf(sprints);
  const sprintItems = active ? work.filter((item) => item.sprintId === active.id) : [];

  return {
    project: {
      id: project.id,
      name: project.name,
      status: project.status ?? '',
      startDate: project.startDate ?? null,
      endDate: project.endDate ?? null,
      description: truncate(project.description, 600),
      updatedAt: project.updatedAt ?? null,
    },
    today,
    counts: {
      epics: items.filter((item) => item.itemType === 'epic').length,
      stories: work.filter((item) => item.itemType === 'story').length,
      tasks: work.filter((item) => item.itemType === 'task').length,
      open: open.length,
      done: work.length - open.length,
      unassignedOpen: open.filter((item) => !item.assigneeId && !item.assigneeName).length,
    },
    byStatus,
    points: { total: totalPoints, done: donePoints, percentDone: totalPoints ? Math.round((donePoints / totalPoints) * 100) : null },
    estimatedHours: leaves.reduce((sum, item) => sum + (Number(item.targetHourEstimate ?? 0) || 0), 0),
    owners: [...owners.values()].sort((left, right) => right.open - left.open),
    overdue: { count: overdue.length, items: overdue.slice(0, 10).map((item) => compactItem(item, { sprintNames })) },
    activeSprint: active ? {
      id: active.id,
      name: active.name,
      startDate: active.startDate ?? null,
      endDate: active.endDate ?? null,
      goal: truncate(active.goal ?? '', 300),
      openCount: sprintItems.filter((item) => !isDoneStatus(item.status)).length,
      doneCount: sprintItems.filter((item) => isDoneStatus(item.status)).length,
      open: sprintItems.filter((item) => !isDoneStatus(item.status)).slice(0, 25).map((item) => compactItem(item, { sprintNames })),
    } : null,
    sprints: sprints.map((sprint) => ({ id: sprint.id, name: sprint.name, status: sprint.status, startDate: sprint.startDate ?? null, endDate: sprint.endDate ?? null })),
    epics: (project.epics ?? []).map((epic) => {
      const stories = epic.stories ?? [];
      const tasks = stories.flatMap((story) => story.tasks ?? []);
      return {
        id: epic.id,
        name: epic.name,
        status: epic.status ?? '',
        stories: stories.length,
        openStories: stories.filter((story) => !isDoneStatus(story.status)).length,
        tasks: tasks.length,
        openTasks: tasks.filter((task) => !isDoneStatus(task.status)).length,
      };
    }),
  };
}
