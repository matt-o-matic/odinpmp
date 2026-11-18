import { assignBoardColumnKeys, resolveKanbanColumn, slugifyBoardColumnKey } from './kanban-placement.js';

function normalizeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function createDefaultKanbanConfig(statuses = []) {
  const filteredStatuses = [...new Set((statuses ?? []).filter(Boolean))];

  return {
    assigneeIds: [],
    columns: assignBoardColumnKeys(filteredStatuses.map((status) => ({
      defaultStatus: status,
      key: slugifyBoardColumnKey(status),
      name: status,
      statuses: [status],
    }))),
    hideDone: false,
    includeBacklog: true,
    issueTypes: [],
    presets: [],
    search: '',
    selectedSprintIds: [],
    statusValues: [],
    swimlane: 'none',
  };
}

export function mergeSprintStaffingMembers(sprint, members = []) {
  const staffingByUserId = new Map((sprint?.staffing ?? []).map((entry) => [entry.userId, entry]));

  return (members ?? []).map((member) => {
    const staffing = staffingByUserId.get(member.id) ?? null;

    return {
      allocationPctOverride: staffing?.allocationPctOverride ?? null,
      capacityHours: staffing?.capacityHours ?? null,
      defaultAllocation: member.projectAllocation ?? null,
      defaultBillRate: member.defaultBillRate ?? null,
      id: member.id,
      minBillRate: member.minBillRate ?? null,
      name: member.name ?? '',
      notes: staffing?.notes ?? '',
      role: member.role ?? 'user',
      userId: member.id,
    };
  });
}

export function summarizeSprintHealth(sprint) {
  const summary = sprint?.summary ?? {};
  const totalHours = normalizeNumber(summary.totalHours);
  const totalPoints = normalizeNumber(summary.totalPoints);
  const capacityHours = normalizeNumber(summary.capacityHours);
  const remainingHours = capacityHours - totalHours;

  return {
    capacityHours,
    completedPercent: normalizeNumber(summary.completedPercent),
    isOverCapacity: capacityHours > 0 && totalHours > capacityHours,
    isUnderstaffed: capacityHours === 0 && normalizeNumber(summary.totalItems) > 0,
    remainingHours,
    totalHours,
    totalItems: normalizeNumber(summary.totalItems),
    totalPoints,
  };
}

function resolveLaneIdentity(card, swimlane) {
  switch (swimlane) {
    case 'assignee':
      return {
        key: card.assigneeId || 'unassigned',
        label: card.assigneeName || 'Unassigned',
      };
    case 'epic':
      // A ticket may hang off no epic at all (D-006); it reuses the existing no-epic lane.
      return {
        key: card.epicId || 'no-epic',
        label: card.epicName || 'No epic',
      };
    case 'sprint':
      // Tickets are off-sprint by default (D-015), so they land in the existing backlog lane.
      return {
        key: card.sprintId || 'backlog',
        label: card.sprintId ? (card.sprintName || 'Sprint') : 'Backlog',
      };
    case 'issueType':
      return {
        key: card.issueType || 'task',
        label: card.issueType ? `${card.issueType[0].toUpperCase()}${card.issueType.slice(1)}` : 'Task',
      };
    default:
      return {
        key: 'board',
        label: 'Board',
      };
  }
}

export function buildKanbanLanes(cards = [], columns = [], swimlane = 'none') {
  const laneMap = new Map();

  for (const card of cards ?? []) {
    const lane = resolveLaneIdentity(card, swimlane);
    const existingLane = laneMap.get(lane.key) ?? {
      columns: columns.map((column) => ({
        ...column,
        cards: [],
      })),
      key: lane.key,
      label: lane.label,
    };

    const column = resolveKanbanColumn(card, existingLane.columns);
    if (column) {
      column.cards.push(card);
    }

    laneMap.set(lane.key, existingLane);
  }

  if (laneMap.size === 0) {
    laneMap.set('board', {
      columns: columns.map((column) => ({
        ...column,
        cards: [],
      })),
      key: 'board',
      label: swimlane === 'none' ? 'Board' : 'Empty lane',
    });
  }

  return [...laneMap.values()];
}

export function buildPlanningSelection(project, item) {
  if (!project || !item) {
    return { type: 'project' };
  }

  // Tickets are a flat project-level collection with an optional parent reference (D-006).
  // They must resolve to a ticket selection rather than degrading to the project.
  if (item.issueType === 'ticket') {
    const ticket = (project.tickets ?? []).find((entry) => entry.id === item.id);

    if (ticket) {
      return {
        parentId: ticket.parentId ?? null,
        ticketId: ticket.id,
        type: 'ticket',
      };
    }

    return { type: 'project' };
  }

  if (item.issueType === 'story') {
    for (const epic of project.epics ?? []) {
      if ((epic.stories ?? []).some((story) => story.id === item.id)) {
        return {
          epicId: epic.id,
          storyId: item.id,
          type: 'story',
        };
      }
    }
  }

  if (item.issueType === 'task') {
    for (const epic of project.epics ?? []) {
      for (const story of epic.stories ?? []) {
        if ((story.tasks ?? []).some((task) => task.id === item.id)) {
          return {
            epicId: epic.id,
            storyId: story.id,
            taskId: item.id,
            type: 'task',
          };
        }
      }
    }
  }

  return { type: 'project' };
}
