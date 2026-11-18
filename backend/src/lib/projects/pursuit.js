// Pursuit work. Every engagement has one Pursuit epic and story that Odin creates and keeps out of
// sight, because every task needs a parent story. The tasks under them are the engagement's
// pursuit tasks. Each of these items carries `pursuit: true` (tasks.pursuit in MySQL), so delivery
// views can leave them out after the engagement converts.
//
// Project loaders leave pursuit work out unless asked (`includePursuit`), so the plan, boards,
// reports, Insights and metrics see delivery work only. The pursuit board, the pursuit insights,
// task-access links, item writes and the agents' item tools (PURSUIT_READS) ask for it.

export const PURSUIT_EPIC_NAME = 'Pursuit';
export const PURSUIT_STORY_NAME = 'Pursuit tasks';
// Where "Move open pursuit tasks to the project board" puts them at conversion.
export const HANDOVER_EPIC_NAME = 'Pursuit handover';
export const HANDOVER_STORY_NAME = 'Open pursuit tasks';

export const BOARD_SCOPE_DELIVERY = 'delivery';
export const BOARD_SCOPE_PURSUIT = 'pursuit';
export const BOARD_SCOPES = Object.freeze([BOARD_SCOPE_DELIVERY, BOARD_SCOPE_PURSUIT]);

// What a project read (GET /api/projects/:projectId?pursuit=) shows of pursuit work:
// - none (the default): delivery work only, as every screen reads it;
// - auto: the pursuit work too on an engagement, whose only work it is;
// - include: the pursuit work too on any project, for a converted project's Pursuit board.
// The agents' item tools read with auto, or include when asked for the Pursuit board. Members
// see every pursuit task (pursuit-visibility.js), so a read that
// passes the project's read check may show them all.
export const PURSUIT_READS = Object.freeze(['none', 'auto', 'include']);

/** Whether a project read with `pursuit` (PURSUIT_READS) shows the pursuit work of a project of `kind`. */
export function readsPursuitWork(pursuit, kind) {
  return pursuit === 'include' || (pursuit === 'auto' && kind === 'engagement');
}

export function isPursuitItem(item) {
  return item?.pursuit === true;
}

/** The project with its pursuit epics, stories and tasks left out. Returns a shallow copy. */
export function withoutPursuitWork(project) {
  if (!project) return project;
  return {
    ...project,
    epics: (project.epics ?? []).filter((epic) => !isPursuitItem(epic)).map((epic) => ({
      ...epic,
      stories: (epic.stories ?? []).filter((story) => !isPursuitItem(story)).map((story) => ({
        ...story,
        tasks: (story.tasks ?? []).filter((task) => !isPursuitItem(task)),
      })),
    })),
  };
}

/** The project with only its pursuit epics, the stories in them and their tasks. */
export function onlyPursuitWork(project) {
  if (!project) return project;
  return { ...project, epics: (project.epics ?? []).filter(isPursuitItem), tickets: [] };
}

/** The hidden Pursuit epic and story, or nulls when the project has none yet. */
export function pursuitParents(project) {
  const epic = (project?.epics ?? []).find(isPursuitItem) ?? null;
  const story = (epic?.stories ?? []).find(isPursuitItem) ?? null;
  return { epic, story };
}

/** Every pursuit task with the id of the story it sits under, in plan order. */
export function pursuitTasksOf(project) {
  const tasks = [];
  for (const epic of project?.epics ?? []) {
    if (!isPursuitItem(epic)) continue;
    for (const story of epic.stories ?? []) {
      for (const task of story.tasks ?? []) tasks.push({ ...task, storyId: story.id });
    }
  }
  return tasks;
}

/** The ids of every pursuit epic, story and task. */
export function pursuitItemIds(project) {
  const ids = [];
  for (const epic of project?.epics ?? []) {
    if (!isPursuitItem(epic)) continue;
    ids.push(epic.id);
    for (const story of epic.stories ?? []) {
      ids.push(story.id);
      for (const task of story.tasks ?? []) ids.push(task.id);
    }
  }
  return ids.filter(Boolean);
}

export function hasPursuitWork(project) {
  return pursuitTasksOf(project).length > 0;
}

/**
 * Sets each story's and task's marker from its parent, with the epic's as the source, so a task
 * moved out of the Pursuit story leaves pursuit work and one moved in joins it. Mutates `epics`.
 */
export function syncPursuitMarkers(epics) {
  for (const epic of epics ?? []) {
    const epicPursuit = isPursuitItem(epic);
    for (const story of epic.stories ?? []) {
      setMarker(story, epicPursuit);
      for (const task of story.tasks ?? []) setMarker(task, epicPursuit);
    }
  }
  return epics;
}

function setMarker(node, pursuit) {
  if (pursuit) node.pursuit = true;
  else delete node.pursuit;
}
