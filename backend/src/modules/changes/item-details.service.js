import { PROJECT_CAPABILITIES, requireProjectCapability } from '../../lib/auth/project-capabilities.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { actorNames, commentText, flattenWork, loadProject, placement, presentChange, tenantIdOf, workflowVersions } from './changes.service.js';

// odin_get_item_details (docs/mcp-change-feed/plan.md): what odin_get_project_changes leaves out,
// for the cards an agent picks: each one's description, comment thread, links, schedule
// dependencies and recent history, plus the versions odin_apply_item_changes checks. The fields
// the feed already gives (assignee, sprint, priority, parent, comment counts) are not repeated.
// Comments and history come newest first in bounded pages; when older ones exist the item says
// so and gives a `next` token, which a later call passes in `continue` to read the page before.

export const MAX_DETAIL_ITEMS = 25;
export const DEFAULT_COMMENT_LIMIT = 20;
export const DEFAULT_HISTORY_LIMIT = 10;
const DESCRIPTION_LIMIT = 50_000;
const COMMENT_LIMIT_CHARS = 10_000;
// Across one response: once comment text reaches this, the rest of each thread is left for `next`.
const COMMENT_BUDGET_CHARS = 400_000;

const DETAIL_FIELDS = ['points', 'targetHourEstimate', 'remainingHours', 'actualHours', 'percentComplete', 'targetStartDate', 'targetEndDate', 'estimateOverride'];
const TICKET_FIELDS = ['severity', 'category', 'environment', 'releaseId', 'externalReviewState'];

function invalidToken() {
  return new HttpError(400, 'A continue token is not one Odin issued for this project. Read the item again without it.', { details: { code: 'invalid_continue_token' } });
}

// A token names its project, item, list (c for comments, h for history) and where the next
// page ends: a comment's time and id, or a change's sequence number.
export function encodeDetailToken(projectId, itemId, kind, before) {
  return `d1.${Buffer.from(JSON.stringify({ b: before, i: itemId, k: kind, p: projectId })).toString('base64url')}`;
}

export function decodeDetailToken(token, projectId) {
  const match = /^d1\.([A-Za-z0-9_-]{4,600})$/.exec(String(token ?? ''));
  if (!match) throw invalidToken();
  let value;
  try { value = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')); } catch { throw invalidToken(); }
  const before = value?.b;
  const validBefore = value?.k === 'h' ? Number.isSafeInteger(before) && before > 0 : typeof before?.createdAt === 'string' && typeof before?.id === 'string';
  if (value?.p !== projectId || typeof value?.i !== 'string' || !['c', 'h'].includes(value?.k) || !validBefore) throw invalidToken();
  return { before, itemId: value.i, kind: value.k === 'c' ? 'comments' : 'history' };
}

function presentComment(comment, itemId, budget) {
  const shown = commentText(comment.comment, COMMENT_LIMIT_CHARS);
  budget.used += shown.text.length;
  return {
    authorId: comment.userId ?? null, authorName: comment.author?.name ?? comment.authorName ?? null, createdAt: comment.createdAt, id: comment.id,
    itemId, parentId: comment.parentId ?? null, ...shown, updatedAt: comment.updatedAt,
  };
}

// A page of comments, oldest first, within the response's budget. Past the budget the oldest are
// left out and `more` says so; `next` reads the page before the oldest shown.
function commentPage({ budget, itemId, page, projectId }) {
  const shown = [];
  for (const comment of [...page.comments].reverse()) {
    if (shown.length && budget.used >= COMMENT_BUDGET_CHARS) break;
    shown.unshift(presentComment(comment, itemId, budget));
  }
  const more = page.more || shown.length < page.comments.length;
  return {
    entries: shown,
    more,
    ...(more && shown.length ? { next: encodeDetailToken(projectId, itemId, 'c', { createdAt: shown[0].createdAt, id: shown[0].id }) } : {}),
  };
}

// A page of changes, oldest first like the feed; `next` reads the page before the oldest shown.
function historyPage({ itemId, names, page, projectId }) {
  const entries = [...page.entries].reverse().map((entry) => presentChange(entry, names));
  return {
    entries,
    more: page.more,
    ...(page.more && entries.length ? { next: encodeDetailToken(projectId, itemId, 'h', entries[0].seq) } : {}),
  };
}

function itemFields({ item, itemType }) {
  const description = String(item.description ?? '');
  const cut = description.length > DESCRIPTION_LIMIT;
  const fields = Object.fromEntries([...DETAIL_FIELDS, ...(itemType === 'ticket' ? TICKET_FIELDS : [])].map((field) => [field, item[field] ?? null]));
  return { description: cut ? `${description.slice(0, DESCRIPTION_LIMIT - 1)}…` : description, ...(cut ? { descriptionTruncated: true } : {}), ...fields };
}

/**
 * odin_get_item_details. `itemIds` (up to 25) read each item from the top of its lists;
 * `continue` (up to 25 tokens) reads the page before one an earlier call returned.
 */
export async function getItemDetailsForUser(deps, { input, projectId, user }) {
  const tenantId = tenantIdOf(user);
  await requireProjectCapability({ capability: PROJECT_CAPABILITIES.READ, projectId, repository: deps.projectRepository, tenantId, user });
  const itemIds = [...new Set(input.itemIds ?? [])];
  const tokens = (input.continue ?? []).map((token) => decodeDetailToken(token, projectId));
  if (itemIds.length + tokens.length === 0) throw new HttpError(400, 'Name at least one item, or pass a continue token.', { details: { code: 'nothing_requested' } });
  if (itemIds.length > MAX_DETAIL_ITEMS || tokens.length > MAX_DETAIL_ITEMS) throw new HttpError(400, `Ask for at most ${MAX_DETAIL_ITEMS} items and ${MAX_DETAIL_ITEMS} continue tokens at once.`, { details: { code: 'too_many_items' } });
  const commentLimit = input.commentLimit ?? DEFAULT_COMMENT_LIMIT;
  const historyLimit = input.historyLimit ?? DEFAULT_HISTORY_LIMIT;

  const { columns, project } = await loadProject(deps, { projectId, tenantId, user });
  // Only items the caller can see: tickets nobody has validated stay out (D-027).
  const byId = new Map(flattenWork(project).map((entry) => [entry.item.id, entry]));
  const found = itemIds.filter((id) => byId.has(id));
  const missing = itemIds.filter((id) => !byId.has(id));
  const continued = tokens.filter((token) => byId.has(token.itemId));

  const commentTargets = [
    ...found.map((itemId) => ({ targetId: itemId })),
    ...continued.filter((token) => token.kind === 'comments').map((token) => ({ before: token.before, targetId: token.itemId })),
  ];
  const historyItems = [
    ...found.map((itemId) => ({ itemId })),
    ...continued.filter((token) => token.kind === 'history').map((token) => ({ beforeSeq: token.before, itemId: token.itemId })),
  ];
  // A continued item's page is read separately from its first page, so key the results apart.
  const firstComments = await deps.projectRepository.listItemComments({ limit: commentLimit, projectId, targets: commentTargets.filter((target) => !target.before), tenantId });
  const firstHistory = await deps.projectRepository.listItemChanges({ items: historyItems.filter((entry) => !entry.beforeSeq), limit: historyLimit, projectId, tenantId });
  const [links, dependencies, activity, workflows, files] = await Promise.all([
    found.length ? deps.projectRepository.listRelationsForItems({ itemIds: found, projectId, tenantId }) : [],
    found.length && deps.governanceRepository?.listDependenciesForItems ? deps.governanceRepository.listDependenciesForItems({ itemIds: found, projectId, tenantId }) : [],
    found.length && deps.projectRepository.listCommentActivity ? deps.projectRepository.listCommentActivity({ projectId, targetIds: found, tenantId }) : new Map(),
    workflowVersions(deps, { projectId, tenantId }),
    found.length && deps.projectRepository.listFiles ? deps.projectRepository.listFiles({ projectId, targetId: projectId, targetType: 'project', tenantId }) : [],
  ]);
  const pagedComments = [];
  for (const target of commentTargets.filter((candidate) => candidate.before)) {
    const page = (await deps.projectRepository.listItemComments({ limit: commentLimit, projectId, targets: [target], tenantId })).get(target.targetId);
    pagedComments.push({ itemId: target.targetId, page });
  }
  const pagedHistory = [];
  for (const entry of historyItems.filter((candidate) => candidate.beforeSeq)) {
    pagedHistory.push({ itemId: entry.itemId, page: (await deps.projectRepository.listItemChanges({ items: [entry], limit: historyLimit, projectId, tenantId })).get(entry.itemId) });
  }

  const allHistory = [...firstHistory.values(), ...pagedHistory.map((entry) => entry.page)].flatMap((page) => page?.entries ?? []);
  const names = await actorNames(deps, { actorIds: new Set(allHistory.map((entry) => entry.actorId)), tenantId });
  const workflowOf = (itemType) => workflows.find((workflow) => workflow.itemType === itemType) ?? null;
  const budget = { used: 0 };

  // Files from a ticket the caller cannot see stay out, as they do from the file tools (D-027).
  const visibleFiles = files.filter((file) => file.targetType !== 'ticket' || byId.has(file.targetId));
  const filesOn = (itemId) => visibleFiles.flatMap((file) => {
    const linked = file.links?.some((link) => link.targetId === itemId);
    if (file.targetId !== itemId && !linked) return [];
    return [{ fileName: file.fileName, id: file.id, linked: file.targetId !== itemId, updatedAt: file.updatedAt ?? null, version: file.version ?? 1 }];
  });

  const items = found.map((itemId) => {
    const entry = byId.get(itemId);
    const workflow = workflowOf(entry.itemType);
    return {
      id: itemId,
      itemType: entry.itemType,
      name: entry.item.name,
      ...placement(entry.item, columns),
      version: entry.item.version ?? null,
      // The newest change log entry about the item, its comments or its links: what
      // odin_apply_item_changes checks as expected.changeSeq.
      changeSeq: firstHistory.get(itemId)?.latestSeq ?? null,
      workflow: workflow ? { version: workflow.version, workflowId: workflow.workflowId } : null,
      ...itemFields(entry),
      comments: { ...commentPage({ budget, itemId, page: firstComments.get(itemId) ?? { comments: [], more: false }, projectId }), total: activity.get(itemId)?.count ?? 0 },
      history: historyPage({ itemId, names, page: firstHistory.get(itemId) ?? { entries: [], more: false }, projectId }),
      files: filesOn(itemId),
      links: links.filter((link) => link.fromItemId === itemId || link.toItemId === itemId)
        .map((link) => ({ fromItemId: link.fromItemId, id: link.id, relationType: link.relationType, toItemId: link.toItemId })),
      dependencies: dependencies.filter((dependency) => dependency.predecessorId === itemId || dependency.successorId === itemId)
        .map((dependency) => ({ dependencyType: dependency.dependencyType, id: dependency.id, lagDays: dependency.lagDays, predecessorId: dependency.predecessorId, successorId: dependency.successorId, version: dependency.version })),
    };
  });
  const pages = [
    ...pagedComments.map(({ itemId, page }) => ({ itemId, kind: 'comments', ...commentPage({ budget, itemId, page, projectId }) })),
    ...pagedHistory.map(({ itemId, page }) => ({ itemId, kind: 'history', ...historyPage({ itemId, names, page, projectId }) })),
  ];
  return {
    items,
    ...(pages.length ? { pages } : {}),
    // Items not on the project, deleted, or not visible to the caller; and continue tokens for them.
    missing: [...missing, ...tokens.filter((token) => !byId.has(token.itemId)).map((token) => token.itemId)].filter((id, index, all) => all.indexOf(id) === index),
    ok: true,
  };
}
