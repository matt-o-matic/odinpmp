// The pursuit board and insights.
// Pure functions, so they test without a browser.

export const PURSUIT_STATUS_OPTIONS = Object.freeze(['Not Started', 'In Progress', 'At Risk', 'Review', 'Completed']);
export const PURSUIT_PRIORITY_OPTIONS = Object.freeze([
  { label: '1 (highest)', value: 1 }, { label: '2', value: 2 }, { label: '3', value: 3 }, { label: '4', value: 4 },
  { label: '5', value: 5 }, { label: '6', value: 6 }, { label: '7 (lowest)', value: 7 },
]);

const DUE_FORMAT = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** A card's due date as the board shows it, and whether an unfinished task is past it. */
export function pursuitCardDue(card, today = new Date().toISOString().slice(0, 10)) {
  const due = String(card?.targetEndDate ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return null;
  return { label: DUE_FORMAT.format(new Date(`${due}T00:00:00.000Z`)), overdue: due < today && card.status !== 'Completed' };
}

/** Every pursuit task in a pursuit project (as GET /pursuit returns it), in plan order. */
export function pursuitTasks(project) {
  const tasks = [];
  for (const epic of project?.epics ?? []) {
    for (const story of epic.stories ?? []) {
      for (const task of story.tasks ?? []) tasks.push({ ...task, storyId: story.id });
    }
  }
  return tasks;
}

/**
 * The project with a name on every task whose assignee is in `people` but came back unnamed. The
 * server names guests and stakeholders (`stakeholder:<id>`) on the pursuit board; a board write
 * returns the project from the plan's routes, which name only members.
 */
export function withAssigneeNames(project, people = []) {
  if (!project) return project;
  const names = new Map(people.map((person) => [person.id, person.name]));
  const name = (task) => (task.assigneeId && !task.assigneeName && names.get(task.assigneeId) ? { ...task, assigneeName: names.get(task.assigneeId) } : task);
  return {
    ...project,
    epics: (project.epics ?? []).map((epic) => ({ ...epic, stories: (epic.stories ?? []).map((story) => ({ ...story, tasks: (story.tasks ?? []).map(name) })) })),
  };
}

export function findPursuitTask(project, taskId) {
  return pursuitTasks(project).find((task) => task.id === taskId) ?? null;
}

/** The task editor's form for one task. */
export function pursuitTaskForm(task) {
  return {
    assigneeId: task?.assigneeId ?? '',
    description: task?.description ?? '',
    dueDate: task?.targetEndDate ?? '',
    name: task?.name ?? '',
    priority: Number.isInteger(task?.priority) ? task.priority : 4,
    status: task?.status ?? PURSUIT_STATUS_OPTIONS[0],
  };
}

export function validatePursuitTaskForm(form) {
  const errors = {};
  const name = String(form?.name ?? '').trim();
  if (!name) errors.name = 'Enter a task name.';
  else if (name.length > 200) errors.name = 'Task names can be up to 200 characters.';
  if (form?.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(form.dueDate)) errors.dueDate = 'Enter the due date as a date.';
  return errors;
}

/** The fields that changed, as an item patch; empty when nothing did. */
export function pursuitTaskPatch(task, form, people = []) {
  const patch = {};
  const name = String(form.name ?? '').trim();
  if (name !== (task.name ?? '')) patch.name = name;
  if (String(form.description ?? '') !== String(task.description ?? '')) patch.description = String(form.description ?? '');
  if (form.status !== task.status) patch.status = form.status;
  if (Number(form.priority) !== Number(task.priority ?? 4)) patch.priority = Number(form.priority);
  const due = form.dueDate || null;
  if (due !== (task.targetEndDate ?? null)) patch.targetEndDate = due;
  const assigneeId = form.assigneeId || null;
  if (assigneeId !== (task.assigneeId ?? null)) {
    patch.assigneeId = assigneeId;
    patch.assigneeName = people.find((person) => person.id === assigneeId)?.name ?? '';
  }
  return patch;
}

/** The stories on a delivery plan a pursuit task can move under, labelled with their epic. */
export function deliveryStoryOptions(project) {
  return (project?.epics ?? []).filter((epic) => !epic.pursuit).flatMap((epic) => (epic.stories ?? [])
    .filter((story) => !story.pursuit)
    .map((story) => ({ id: story.id, label: `${story.name || 'Untitled story'} (${epic.name || 'Untitled epic'})` })));
}

/** A move request for the chosen tasks, with the versions they were loaded at. */
export function pursuitMovePayload({ project, storyId, taskIds }) {
  const tasks = pursuitTasks(project).filter((task) => taskIds.includes(task.id));
  return { expectedVersions: Object.fromEntries(tasks.map((task) => [task.id, task.version])), storyId, taskIds: tasks.map((task) => task.id) };
}

// ---- Insights --------------------------------------------------------------------------

export const SOW_STEPS = Object.freeze([
  { label: 'Drafting', state: 'drafting' },
  { label: 'Shared for review', state: 'shared_for_review' },
  { label: 'Awaiting signature', state: 'awaiting_signature' },
  { label: 'Signed', state: 'signed' },
]);

/** The SOW's steps, each marked done, current or ahead, with the date Odin heard of it. */
export function sowSteps(sow) {
  const reached = SOW_STEPS.findIndex((step) => step.state === sow?.state);
  return SOW_STEPS.map((step, index) => ({
    ...step,
    at: [...(sow?.history ?? [])].reverse().find((entry) => entry.state === step.state)?.at ?? null,
    progress: reached < 0 ? 'ahead' : index < reached ? 'done' : index === reached ? 'current' : 'ahead',
  }));
}

/** The tasks burnup as line chart series, and its rows for the table view. */
export function tasksBurnup(data) {
  const points = data?.burnup ?? [];
  return {
    ariaLabel: points.length ? `Tasks burnup: ${points.at(-1).done} of ${points.at(-1).scope} tasks done.` : 'Tasks burnup: no tasks yet.',
    rows: points.map((point) => ({ date: point.date, done: point.done, key: point.date, scope: point.scope })),
    series: [
      { color: 'var(--ins-muted-series)', endLabel: 'Tasks', key: 'scope', label: 'Tasks', points: points.map((point) => ({ date: point.date, value: point.scope })) },
      { area: true, color: 'var(--ins-series-1)', endLabel: 'Done', key: 'done', label: 'Done', points: points.map((point) => ({ date: point.date, value: point.done })) },
    ],
  };
}

/** Posts and file versions per week, summed over channels, as column series. */
export function weeklyActivity(data, formatWeek = (week) => week) {
  const weeks = data?.weeks ?? [];
  const sum = (key, index) => (data?.channels ?? []).reduce((total, channel) => total + (channel[key][index] ?? 0), 0);
  const posts = weeks.map((_, index) => sum('posts', index));
  const files = weeks.map((_, index) => sum('files', index));
  return {
    ariaLabel: `Activity over ${weeks.length} weeks: ${posts.reduce((a, b) => a + b, 0)} posts and ${files.reduce((a, b) => a + b, 0)} file versions.`,
    categories: weeks.map((week) => ({ key: week, label: formatWeek(week) })),
    channels: (data?.channels ?? []).map((channel) => ({
      files: channel.files.reduce((a, b) => a + b, 0),
      key: channel.id,
      name: channel.name,
      posts: channel.posts.reduce((a, b) => a + b, 0),
    })),
    series: [
      { color: 'var(--ins-series-1)', key: 'posts', label: 'Posts', values: posts },
      { color: 'var(--ins-series-2)', key: 'files', label: 'File versions', values: files },
    ],
  };
}

export function daysLabel(days) {
  if (days == null) return '—';
  return days === 1 ? '1 day' : `${days} days`;
}
