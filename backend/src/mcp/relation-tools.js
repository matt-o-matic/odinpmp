import { z } from 'zod';
import { OdinApiError } from './api-client.js';
import { isTicketVisibleToAssistant } from '../modules/assistant/assistant-ticket-visibility.js';
import { WORK_ITEM_RELATION_TYPES, workItemRelationCreateSchema } from '../modules/projects/projects.schema.js';

// Typed links between epics, stories, tasks and tickets in one project (blocks, caused_by,
// affects, duplicate_of). A ticket submitted from outside the team stays hidden from agents until
// someone validates it, so it is never listed, linked or unlinked here.

const relationType = z.enum(WORK_ITEM_RELATION_TYPES)
  .describe('Read as "from <type> to": blocks = from must finish before to; caused_by = from was caused by to; affects = from affects to; duplicate_of = from duplicates to.');

export function registerRelationTools({ api, dryRun, flattenItems, id, mutate, tool }) {
  const projectPath = (projectId) => `/api/projects/${encodeURIComponent(projectId)}`;
  const relationsPath = (projectId, itemId) => `${projectPath(projectId)}/items/${encodeURIComponent(itemId)}/relations`;

  // The ids of the items an agent may see and link: every epic, story and task, and visible tickets.
  async function requireItems(projectId, itemIds) {
    const { project } = await api.request('GET', projectPath(projectId));
    const known = new Set([...flattenItems(project), ...(project.tickets ?? []).filter(isTicketVisibleToAssistant)].map((entry) => entry.id));
    if (itemIds.some((itemId) => !known.has(itemId))) throw new OdinApiError(404, 'item_not_found', 'Epic, story, task or ticket not found.');
    return known;
  }

  async function listRelations(projectId, itemId, known) {
    const { relations } = await api.request('GET', relationsPath(projectId, itemId));
    return relations
      .filter((relation) => known.has(relation.relatedItem?.id))
      .map(({ createdAt, direction, fromItemId, id: relationId, relatedItem, relationType: type, toItemId }) => ({
        createdAt, direction, fromItemId, id: relationId, relatedItem: { id: relatedItem.id, itemType: relatedItem.itemType, name: relatedItem.name, status: relatedItem.status }, relationType: type, toItemId,
      }));
  }

  tool('odin_list_item_relations', 'Read typed relations (blocks, caused_by, affects, duplicate_of) touching one epic, story, task or ticket, in both directions, with the related item\'s type, name and status. direction is outgoing when itemId is the "from" side.', z.object({ projectId: id, itemId: id }).strict(), async ({ projectId, itemId }) => {
    const known = await requireItems(projectId, [itemId]);
    return { ok: true, itemId, relations: await listRelations(projectId, itemId, known) };
  }, { purpose: 'Find what an item blocks, depends on or is linked to (dependencies between items).' });
  tool('odin_link_work_items', 'Create a typed relation from one epic, story, task or ticket to another in the same project, for example a ticket caused_by a story, or a story that affects a ticket. Requires plan-edit permission. Idempotent: an identical relation returns the existing one. Read relations first to avoid near-duplicates.', z.object({ projectId: id, fromItemId: id, relationType, toItemId: id, dryRun }).strict(), async (args) => {
    if (args.fromItemId === args.toItemId) throw new OdinApiError(400, 'invalid_relation', 'An item cannot relate to itself.');
    if (!args.dryRun) await requireItems(args.projectId, [args.fromItemId, args.toItemId]);
    return mutate(args, 'POST', relationsPath(args.projectId, args.fromItemId), workItemRelationCreateSchema, { relationType: args.relationType, toItemId: args.toItemId });
  }, { write: true, purpose: 'Link two work items or tickets, for example mark that one blocks another, or that a bug duplicates or was caused by another.' });
  tool('odin_unlink_work_items', 'Remove one relation listed on itemId by odin_list_item_relations. Requires plan-edit permission. No version precondition.', z.object({ projectId: id, itemId: id, relationId: id, dryRun }).strict(), async (args) => {
    if (!args.dryRun) {
      const known = await requireItems(args.projectId, [args.itemId]);
      if (!(await listRelations(args.projectId, args.itemId, known)).some((relation) => relation.id === args.relationId)) {
        throw new OdinApiError(404, 'relation_not_found', 'Relation not found on the specified item.');
      }
    }
    return mutate(args, 'DELETE', `${projectPath(args.projectId)}/relations/${encodeURIComponent(args.relationId)}`);
  }, { write: true, destructive: true, confirm: true });
}
