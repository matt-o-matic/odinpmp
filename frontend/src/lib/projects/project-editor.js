import { normalizeActualHours, normalizePercentComplete, normalizeRemainingHours, summarizeWorkProgress } from './work-progress.js';

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function createDraftId(prefix) {
  return `draft-${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeQuery(query) {
  return String(query ?? '').trim().toLowerCase();
}

// Date inputs and the API both use YYYY-MM-DD; trim a full timestamp down to its day.
export function normalizeDateValue(value) {
  if (!value) {
    return null;
  }

  const text = String(value);
  return /^\d{4}-\d{2}-\d{2}T/.test(text) ? text.slice(0, 10) : text;
}

function normalizeNumberValue(value, fallback = null) {
  if (value === '' || value == null || Number.isNaN(Number(value))) {
    return fallback;
  }

  return Number(value);
}

function isAcceptedAiNode(node) {
  if (!node) {
    return false;
  }

  // Legacy Odin treated AI-generated rows as "pending acceptance" until explicitly accepted.
  if (node.aiGenerated === true && node.aiAccepted !== true) {
    return false;
  }

  return true;
}

function matchNode(node, query) {
  if (!query) {
    return true;
  }

  return [
    node.name,
    node.description,
    node.status,
    node.assigneeName,
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(query));
}

function getStoryCount(project) {
  return (project?.epics ?? []).reduce((total, epic) => total + (epic.stories?.length ?? 0), 0);
}

function getTaskCount(project) {
  return (project?.epics ?? []).reduce(
    (total, epic) =>
      total + (epic.stories ?? []).reduce((storyTotal, story) => storyTotal + (story.tasks?.length ?? 0), 0),
    0,
  );
}

function getTaskListForNode(type, node) {
  if (!node) {
    return [];
  }

  if (type === 'task') {
    return [node];
  }

  if (type === 'story') {
    return [...(node.tasks ?? [])];
  }

  if (type === 'epic') {
    return (node.stories ?? []).flatMap((story) => story.tasks ?? []);
  }

  return (node.epics ?? []).flatMap((epic) => (epic.stories ?? []).flatMap((story) => story.tasks ?? []));
}

export function cloneProject(project) {
  return cloneJson(project);
}

export function createTaskDraft() {
  return {
    assigneeId: null,
    assigneeName: '',
    description: '',
    id: createDraftId('task'),
    name: 'New task',
    actualHours: null,
    estimateOverride: false,
    percentComplete: null,
    points: null,
    priority: 4,
    sprintId: null,
    sprintSortOrder: null,
    status: 'Not Started',
    targetEndDate: null,
    targetHourEstimate: null,
    targetStartDate: null,
  };
}

export function createStoryDraft() {
  return {
    assigneeId: null,
    assigneeName: '',
    description: '',
    id: createDraftId('story'),
    name: 'New story',
    actualHours: null,
    estimateOverride: false,
    percentComplete: null,
    points: null,
    priority: 4,
    sprintId: null,
    sprintSortOrder: null,
    status: 'Not Started',
    targetEndDate: null,
    targetHourEstimate: null,
    targetStartDate: null,
    tasks: [createTaskDraft()],
  };
}

export function createEpicDraft() {
  return {
    assigneeId: null,
    assigneeName: '',
    description: '',
    id: createDraftId('epic'),
    name: 'New epic',
    actualHours: null,
    estimateOverride: false,
    percentComplete: null,
    points: null,
    priority: 4,
    sprintId: null,
    sprintSortOrder: null,
    status: 'Not Started',
    stories: [createStoryDraft()],
    targetEndDate: null,
    targetHourEstimate: null,
    targetStartDate: null,
  };
}

export function serializeTask(task) {
  if (!isAcceptedAiNode(task)) {
    return null;
  }

  return {
    assigneeId: task.assigneeId || null,
    assigneeName: task.assigneeName || '',
    boardColumn: task.boardColumn || null,
    description: task.description ?? '',
    id: task.id,
    name: task.name,
    actualHours: normalizeActualHours(task.actualHours),
    estimateOverride: task.estimateOverride === true,
    percentComplete: normalizePercentComplete(task.percentComplete),
    points: normalizeNumberValue(task.points),
    priority: normalizeNumberValue(task.priority, 4) ?? 4,
    // Sent only when the item has the field, so a tree save never clears a value it didn't load.
    ...(task.remainingHours !== undefined ? { remainingHours: normalizeRemainingHours(task.remainingHours) } : {}),
    sprintId: task.sprintId || null,
    sprintSortOrder: normalizeNumberValue(task.sprintSortOrder),
    status: task.status || 'Not Started',
    sourceClarificationIds: Array.isArray(task.sourceClarificationIds) ? [...task.sourceClarificationIds] : [],
    targetEndDate: normalizeDateValue(task.targetEndDate),
    targetHourEstimate: normalizeNumberValue(task.targetHourEstimate),
    targetStartDate: normalizeDateValue(task.targetStartDate),
  };
}

export function serializeStory(story) {
  const base = serializeTask(story);
  if (!base) {
    return null;
  }

  return {
    ...base,
    tasks: (story.tasks ?? []).map(serializeTask).filter(Boolean),
  };
}

export function serializeEpic(epic) {
  const base = serializeTask(epic);
  if (!base) {
    return null;
  }

  return {
    ...base,
    stories: (epic.stories ?? []).map(serializeStory).filter(Boolean),
  };
}

export function serializeProjectMetadata(project) {
  return {
    description: project.description ?? '',
    endDate: normalizeDateValue(project.endDate),
    name: project.name,
    startDate: normalizeDateValue(project.startDate),
    status: project.status,
    expectedUpdatedAt: project.updatedAt,
  };
}

export function serializeProjectTree(project) {
  return {
    epics: (project.epics ?? []).map(serializeEpic).filter(Boolean),
    expectedUpdatedAt: project.updatedAt,
  };
}

export function serializeProjectSnapshot(project) {
  return {
    ...serializeProjectMetadata(project),
    epics: serializeProjectTree(project).epics,
    id: project.id,
  };
}

export function createProjectSelection(selection = {}) {
  const type = selection.type ?? 'project';

  if (type === 'project') {
    return { type: 'project' };
  }

  if (type === 'epic' && selection.epicId) {
    return { type, epicId: selection.epicId };
  }

  if (type === 'story' && selection.epicId && selection.storyId) {
    return { type, epicId: selection.epicId, storyId: selection.storyId };
  }

  if (type === 'task' && selection.epicId && selection.storyId && selection.taskId) {
    return {
      type,
      epicId: selection.epicId,
      storyId: selection.storyId,
      taskId: selection.taskId,
    };
  }

  return { type: 'project' };
}

export function resolveProjectSelection(project, selection = {}) {
  const normalizedSelection = createProjectSelection(selection);

  if (!project || normalizedSelection.type === 'project') {
    return {
      item: project,
      label: 'Project',
      project,
      selection: { type: 'project' },
      type: 'project',
    };
  }

  const epic = (project.epics ?? []).find((item) => item.id === normalizedSelection.epicId);

  if (!epic) {
    return resolveProjectSelection(project, { type: 'project' });
  }

  if (normalizedSelection.type === 'epic') {
    return {
      epic,
      item: epic,
      label: 'Epic',
      project,
      selection: { type: 'epic', epicId: epic.id },
      type: 'epic',
    };
  }

  const story = (epic.stories ?? []).find((item) => item.id === normalizedSelection.storyId);

  if (!story) {
    return resolveProjectSelection(project, { type: 'project' });
  }

  if (normalizedSelection.type === 'story') {
    return {
      epic,
      item: story,
      label: 'Story',
      project,
      selection: { type: 'story', epicId: epic.id, storyId: story.id },
      story,
      type: 'story',
    };
  }

  const task = (story.tasks ?? []).find((item) => item.id === normalizedSelection.taskId);

  if (!task) {
    return resolveProjectSelection(project, { type: 'project' });
  }

  return {
    epic,
    item: task,
    label: 'Task',
    project,
    selection: { type: 'task', epicId: epic.id, storyId: story.id, taskId: task.id },
    story,
    task,
    type: 'task',
  };
}

export function resolveSelectionCollection(project, selection = {}) {
  const resolved = resolveProjectSelection(project, selection);

  if (resolved.type === 'epic') {
    const list = project?.epics ?? [];
    return {
      fallbackSelection: { type: 'project' },
      index: list.findIndex((item) => item.id === resolved.epic.id),
      list,
    };
  }

  if (resolved.type === 'story') {
    const list = resolved.epic?.stories ?? [];
    return {
      fallbackSelection: { type: 'epic', epicId: resolved.epic.id },
      index: list.findIndex((item) => item.id === resolved.story.id),
      list,
    };
  }

  if (resolved.type === 'task') {
    const list = resolved.story?.tasks ?? [];
    return {
      fallbackSelection: { type: 'story', epicId: resolved.epic.id, storyId: resolved.story.id },
      index: list.findIndex((item) => item.id === resolved.task.id),
      list,
    };
  }

  return null;
}

export function filterProjectTree(project, query = '') {
  const normalized = normalizeQuery(query);

  if (!project) {
    return [];
  }

  if (!normalized) {
    return project.epics ?? [];
  }

  return (project.epics ?? []).reduce((epics, epic) => {
    if (matchNode(epic, normalized)) {
      epics.push(epic);
      return epics;
    }

    const stories = (epic.stories ?? []).reduce((storyMatches, story) => {
      if (matchNode(story, normalized)) {
        storyMatches.push(story);
        return storyMatches;
      }

      const tasks = (story.tasks ?? []).filter((task) => matchNode(task, normalized));

      if (tasks.length > 0) {
        storyMatches.push({
          ...story,
          tasks,
        });
      }

      return storyMatches;
    }, []);

    if (stories.length > 0) {
      epics.push({
        ...epic,
        stories,
      });
    }

    return epics;
  }, []);
}

export function buildTreeMetrics(type, node) {
  const progress = summarizeWorkProgress(type, node);

  return {
    completedPercent: progress.percentComplete,
    progress,
    storyCount: type === 'project'
      ? getStoryCount(node)
      : type === 'epic'
        ? node.stories?.length ?? 0
        : 0,
    taskCount: type === 'project'
      ? getTaskCount(node)
      : getTaskListForNode(type, node).length,
  };
}

export function formatDateRange(startDate, endDate) {
  if (startDate && endDate) {
    return `${startDate} to ${endDate}`;
  }

  if (startDate) {
    return `Starts ${startDate}`;
  }

  if (endDate) {
    return `Ends ${endDate}`;
  }

  return 'Dates TBD';
}
