import { PROJECT_CAPABILITIES, getTenantMembership, hasProjectCapability } from '../../lib/auth/project-capabilities.js';

// Relations are directional: "from <type> to" reads "from blocks to", "from is caused by
// to", "from affects to", "from is a duplicate of to".

/**
 * Indexes every epic, story, task and ticket in a project detail by id, with the ancestry a
 * client needs to open the item.
 */
export function buildWorkItemIndex(project) {
  const index = new Map();
  const add = (node, itemType, ancestry = {}) => {
    if (!node?.id) return;
    index.set(node.id, {
      id: node.id,
      itemType,
      name: String(node.name ?? '').trim(),
      status: node.status ?? null,
      ...ancestry,
    });
  };
  for (const epic of project?.epics ?? []) {
    add(epic, 'epic');
    for (const story of epic.stories ?? []) {
      add(story, 'story', { epicId: epic.id });
      for (const task of story.tasks ?? []) add(task, 'task', { epicId: epic.id, storyId: story.id });
    }
  }
  for (const ticket of project?.tickets ?? []) add(ticket, 'ticket');
  return index;
}

/**
 * Describes each relation from the point of view of one item: whether it points out of or
 * into that item, and a summary of the item at the other end. A related item missing from
 * the index (for example, hidden from this reader) is reported as unavailable.
 */
export function describeRelationsForItem({ index, itemId, relations = [] }) {
  return relations.map((relation) => {
    const direction = relation.fromItemId === itemId ? 'outgoing' : 'incoming';
    const relatedId = direction === 'outgoing' ? relation.toItemId : relation.fromItemId;
    const related = index.get(relatedId);
    return {
      ...relation,
      direction,
      relatedItem: related ? { ...related, available: true } : { available: false, id: relatedId, itemType: null, name: '', status: null },
    };
  });
}

/** Whether the caller may add or remove relations, from the access record a read check returned. */
export function canEditWorkItemRelations({ access, tenantId, user }) {
  return hasProjectCapability({
    capability: PROJECT_CAPABILITIES.PLAN_EDIT,
    projectRole: access?.projectRole,
    tenantRole: getTenantMembership(user, tenantId)?.role,
    userCapabilities: user?.capabilities,
  });
}

/**
 * Lists one item's relations with the related items' names, types and statuses, so the
 * client draws the list without a lookup per relation. The project tree is read only when
 * there is something to describe.
 */
export async function listDescribedWorkItemRelations({ itemId, projectId, repository, tenantId }) {
  const relations = await repository.listWorkItemRelations({ itemId, projectId, tenantId });
  if (relations.length === 0) return [];
  const project = await repository.getProjectDetail({ projectId, tenantId });
  return describeRelationsForItem({ index: buildWorkItemIndex(project), itemId, relations });
}
