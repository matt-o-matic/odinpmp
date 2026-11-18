// Typed links between items in one project. Stored relations are directional ("from
// blocks to"), so each type reads two ways depending on which end you are looking from.

export const RELATION_TYPES = ['blocks', 'caused_by', 'affects', 'duplicate_of'];

const LABELS = {
  affects: { incoming: 'Affected by', outgoing: 'Affects' },
  blocks: { incoming: 'Blocked by', outgoing: 'Blocks' },
  caused_by: { incoming: 'Causes', outgoing: 'Caused by' },
  duplicate_of: { incoming: 'Duplicated by', outgoing: 'Duplicate of' },
};

const CHOICE_LABELS = {
  affects: { incoming: 'is affected by', outgoing: 'affects' },
  blocks: { incoming: 'is blocked by', outgoing: 'blocks' },
  caused_by: { incoming: 'causes', outgoing: 'is caused by' },
  duplicate_of: { incoming: 'is duplicated by', outgoing: 'is a duplicate of' },
};

// Choices for "This item …", in both directions. An incoming choice is stored from the
// other item to this one.
export const RELATION_CHOICES = RELATION_TYPES.flatMap((relationType) => ['outgoing', 'incoming'].map((direction) => ({
  direction,
  key: `${relationType}:${direction}`,
  label: CHOICE_LABELS[relationType][direction],
  relationType,
})));

export const ITEM_TYPE_META = {
  epic: { icon: 'bi-collection', label: 'Epic' },
  story: { icon: 'bi-journal-text', label: 'Story' },
  task: { icon: 'bi-check2-square', label: 'Task' },
  ticket: { icon: 'bi-bug', label: 'Ticket' },
};

export function relationLabel(relationType, direction) {
  return LABELS[relationType]?.[direction] ?? String(relationType ?? '').replace(/_/g, ' ');
}

export function itemTypeMeta(itemType) {
  return ITEM_TYPE_META[itemType] ?? { icon: 'bi-question-circle', label: 'Item' };
}

/** Groups described relations under their human label, in a stable type and direction order. */
export function groupRelations(relations = []) {
  return RELATION_CHOICES
    .map((choice) => ({
      key: choice.key,
      label: relationLabel(choice.relationType, choice.direction),
      relations: relations.filter((relation) => relation.relationType === choice.relationType && relation.direction === choice.direction),
    }))
    .filter((group) => group.relations.length > 0);
}

/** Every epic, story, task and ticket in a project detail, with the ancestry needed to open it. */
export function flattenProjectItems(project) {
  const items = [];
  for (const epic of project?.epics ?? []) {
    items.push({ id: epic.id, itemType: 'epic', name: epic.name ?? '', status: epic.status ?? '' });
    for (const story of epic.stories ?? []) {
      items.push({ epicId: epic.id, id: story.id, itemType: 'story', name: story.name ?? '', status: story.status ?? '' });
      for (const task of story.tasks ?? []) {
        items.push({ epicId: epic.id, id: task.id, itemType: 'task', name: task.name ?? '', status: task.status ?? '', storyId: story.id });
      }
    }
  }
  for (const ticket of project?.tickets ?? []) {
    items.push({ id: ticket.id, itemType: 'ticket', name: ticket.name ?? '', status: ticket.status ?? '' });
  }
  return items.filter((item) => item.id);
}

/**
 * Items the current item can be linked to with one choice: same project, not itself, and
 * not already linked the same way. Matches the query against name and type.
 */
export function relationCandidates({ choiceKey, itemId, items = [], query = '', relations = [] }) {
  const [relationType, direction] = String(choiceKey ?? '').split(':');
  const linked = new Set(relations
    .filter((relation) => relation.relationType === relationType && relation.direction === direction)
    .map((relation) => relation.relatedItem?.id));
  const terms = String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    if (item.id === itemId || linked.has(item.id)) return false;
    const haystack = `${item.name} ${itemTypeMeta(item.itemType).label} ${item.id}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/** The POST that records a choice: incoming choices are stored from the other item. */
export function relationCreateRequest({ choiceKey, itemId, otherItemId }) {
  const [relationType, direction] = String(choiceKey ?? '').split(':');
  return direction === 'incoming'
    ? { fromItemId: otherItemId, payload: { relationType, toItemId: itemId } }
    : { fromItemId: itemId, payload: { relationType, toItemId: otherItemId } };
}

/** Where a related item opens: tickets in the ticket list, plan items in the project workbench. */
export function relatedItemRoute(projectId, item = {}) {
  if (item.itemType === 'ticket') return { name: 'tickets', query: { project: projectId, ticket: item.id } };
  return { name: 'project-detail', params: { projectId }, query: { item: item.id } };
}

/** The workbench selection for a plan item id, or null when the project has no such epic, story or task. */
export function projectSelectionForItem(project, itemId) {
  const item = flattenProjectItems(project).find((entry) => entry.id === itemId && entry.itemType !== 'ticket');
  if (!item) return null;
  if (item.itemType === 'epic') return { epicId: item.id, type: 'epic' };
  if (item.itemType === 'story') return { epicId: item.epicId, storyId: item.id, type: 'story' };
  return { epicId: item.epicId, storyId: item.storyId, taskId: item.id, type: 'task' };
}
