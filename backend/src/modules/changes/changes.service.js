import sanitizeHtml from 'sanitize-html';

import { PROJECT_CAPABILITIES, requireProjectCapability } from '../../lib/auth/project-capabilities.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { resolveKanbanColumn } from '../../lib/projects/kanban-placement.js';
import { isTicketVisibleToAssistant } from '../assistant/assistant-ticket-visibility.js';
import { CHANGE_SETTLE_MS } from './project-change-log.js';

// What changed in a project since an agent last looked. Without
// a cursor: the project's work in compact form and a cursor. With one: the changes after it, from
// the project change log, with the current state of what they touched. Deterministic data, read
// with the caller's own project access.

export const BASELINE_PAGE_SIZE = 1000;
const COMMENT_TEXT_LIMIT = 2000;

export function tenantIdOf(user) {
  const tenantId = user?.memberships?.[0]?.tenantId ?? user?.tenantId ?? null;
  if (!tenantId) throw new HttpError(403, 'No workspace.');
  return tenantId;
}

// A cursor names its project and a change log sequence number. It is opaque to callers.
export function encodeChangeCursor(projectId, seq) {
  return `c1.${Buffer.from(JSON.stringify({ p: projectId, s: seq })).toString('base64url')}`;
}

function invalidCursor(message = 'That cursor is not one Odin issued for this project. Call again without a cursor for a fresh baseline.') {
  return new HttpError(400, message, { details: { code: 'invalid_cursor' } });
}

export function decodeChangeCursor(cursor, projectId) {
  const match = /^c1\.([A-Za-z0-9_-]{4,200})$/.exec(String(cursor ?? ''));
  if (!match) throw invalidCursor();
  let value;
  try { value = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')); } catch { throw invalidCursor(); }
  if (value?.p !== projectId || !Number.isSafeInteger(value?.s) || value.s < 0) throw invalidCursor();
  return value.s;
}

// Comment HTML as plain text: paragraphs and line breaks kept, tags and entities gone, cut at
// `limit` characters and marked truncated past it.
export function commentText(html, limit = COMMENT_TEXT_LIMIT) {
  const text = sanitizeHtml(String(html ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|blockquote|pre|tr)>/gi, '\n'), { allowedAttributes: {}, allowedTags: [] })
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n').trim();
  return text.length > limit ? { text: `${text.slice(0, limit - 1)}…`, truncated: true } : { text };
}

export function flattenWork(project) {
  const rows = [];
  for (const epic of project?.epics ?? []) {
    rows.push({ item: epic, itemType: 'epic', parentId: null });
    for (const story of epic.stories ?? []) {
      rows.push({ item: story, itemType: 'story', parentId: epic.id });
      for (const task of story.tasks ?? []) rows.push({ item: task, itemType: 'task', parentId: story.id });
    }
  }
  // Tickets from outside the team stay hidden until someone validates them.
  for (const ticket of project?.tickets ?? []) if (isTicketVisibleToAssistant(ticket)) rows.push({ item: ticket, itemType: 'ticket', parentId: ticket.parentId ?? null });
  return rows;
}

/**
 * Where a card is, as Odin stores it and as the caller's board shows it. `status` and
 * `boardColumn` are the raw values, kept together: two columns can take the same status (Needs
 * Human and Review) and one column can take several (On Hold and Blocked), so neither alone says
 * where the card is. `column` is the column it shows in on the caller's board: its placement
 * while that column takes its status, else the first column that does; null when none does.
 */
export function placement(item, columns) {
  return { boardColumn: item.boardColumn ?? null, column: resolveKanbanColumn(item, columns)?.key ?? null, status: item.status ?? null };
}

function compactItem({ item, itemType, parentId }, { activity, columns }) {
  const comments = activity.get(item.id);
  return {
    assigneeId: item.assigneeId ?? null,
    assigneeName: item.assigneeName || null,
    ...placement(item, columns),
    commentCount: comments?.count ?? 0,
    id: item.id,
    itemType,
    lastCommentAt: comments?.lastAt ?? null,
    name: item.name,
    parentId,
    priority: item.priority ?? null,
    sprintId: item.sprintId ?? null,
    updatedAt: item.updatedAt ?? null,
    version: item.version ?? null,
  };
}

export async function workflowVersions(deps, { projectId, tenantId }) {
  if (!deps.workflowRepository?.listSnapshot) return [];
  const snapshot = await deps.workflowRepository.listSnapshot({ tenantId });
  return (snapshot.bindings ?? []).filter((binding) => binding.projectId === projectId).map((binding) => {
    const workflow = (snapshot.workflows ?? []).find((entry) => entry.id === binding.workflowId);
    return { itemType: binding.itemType, name: workflow?.name ?? null, version: workflow?.version ?? null, workflowId: binding.workflowId };
  }).sort((left, right) => left.itemType.localeCompare(right.itemType));
}

// Names for the people behind actor ids: users, and resources without a login (`resource:<id>`).
export async function actorNames(deps, { actorIds, tenantId }) {
  const names = new Map();
  const resources = [...actorIds].filter((id) => id.startsWith('resource:'));
  if (resources.length && deps.resourceFinanceRepository?.listSnapshot) {
    const snapshot = await deps.resourceFinanceRepository.listSnapshot({ tenantId });
    for (const resource of snapshot.resources ?? []) names.set(`resource:${resource.id}`, resource.name);
  }
  for (const id of actorIds) {
    if (!id || names.has(id) || id.includes(':')) continue;
    const found = await deps.authRepository?.findUserById?.(id).catch(() => null);
    if (found) names.set(id, found.name || found.email || null);
  }
  return names;
}

/** One change log entry as the tools show it: what changed, who changed it and through what. */
export function presentChange(entry, names) {
  return {
    action: entry.action,
    actor: { id: entry.actorId || null, name: names.get(entry.actorId) ?? null },
    at: entry.at,
    entity: entry.entityType,
    id: entry.entityId,
    ...(entry.itemId ? { itemId: entry.itemId } : {}),
    ...(entry.detail?.itemType ? { itemType: entry.detail.itemType } : {}),
    ...(entry.detail?.fields && Object.keys(entry.detail.fields).length ? { fields: entry.detail.fields } : {}),
    ...(entry.entityType === 'relation' ? { relation: { fromItemId: entry.detail?.fromItemId, relationType: entry.detail?.relationType, toItemId: entry.detail?.toItemId } } : {}),
    ...(entry.entityType === 'dependency' && entry.detail ? { dependency: { dependencyType: entry.detail.dependencyType, lagDays: entry.detail.lagDays, predecessorId: entry.detail.predecessorId, successorId: entry.detail.successorId } } : {}),
    ...(entry.entityType === 'file' && entry.detail ? {
      file: {
        ...(entry.detail.fileName ? { contentType: entry.detail.contentType ?? null, fileName: entry.detail.fileName } : {}),
        targetId: entry.detail.targetId,
        targetType: entry.detail.targetType,
        version: entry.detail.version ?? null,
        ...(entry.detail.versionNote ? { versionNote: entry.detail.versionNote } : {}),
        ...(entry.detail.audience ? { audience: entry.detail.audience } : {}),
      },
    } : {}),
    ...(entry.entityType === 'signing' && entry.detail ? { signing: entry.detail } : {}),
    ...(entry.entityType === 'engagement' && entry.detail ? { engagement: entry.detail } : {}),
    ...(entry.detail?.splitFrom ? { splitFrom: entry.detail.splitFrom } : {}),
    ...(entry.detail?.splitInto ? { splitInto: entry.detail.splitInto } : {}),
    ...(entry.detail?.note ? { note: entry.detail.note } : {}),
    seq: entry.seq,
    via: entry.via,
  };
}

// The project, and the columns of the caller's board: the ones they arranged, or the ones Odin's
// board shows by default.
export async function loadProject(deps, { projectId, tenantId, user }) {
  const [project, board] = await Promise.all([
    deps.projectRepository.getProjectDetail({ projectId, tenantId }),
    deps.projectRepository.getKanbanBoard ? deps.projectRepository.getKanbanBoard({ filters: {}, projectId, tenantId, user }) : null,
  ]);
  if (!project) throw new HttpError(404, 'Project not found.');
  return { columns: board?.columns ?? [], project };
}

async function commentActivity(deps, { projectId, tenantId, work }) {
  if (!deps.projectRepository.listCommentActivity) return new Map();
  return deps.projectRepository.listCommentActivity({ projectId, targetIds: work.map((entry) => entry.item.id), tenantId });
}

/**
 * odin_get_project_changes. `cursor` absent: a baseline of the project's work, paged by `offset`
 * past BASELINE_PAGE_SIZE items. `cursor` given: the changes after it, at most `limit`.
 */
export async function getProjectChangesForUser(deps, { input = {}, projectId, user }) {
  const tenantId = tenantIdOf(user);
  await requireProjectCapability({ capability: PROJECT_CAPABILITIES.READ, projectId, repository: deps.projectRepository, tenantId, user });
  if (!input.cursor) return baseline(deps, { offset: input.offset ?? 0, projectId, tenantId, user });

  const afterSeq = decodeChangeCursor(input.cursor, projectId);
  const log = await deps.projectRepository.listProjectChanges({ afterSeq, limit: input.limit ?? 200, projectId, settleMs: deps.changeSettleMs ?? CHANGE_SETTLE_MS, tenantId });
  if (afterSeq < log.floorSeq) {
    throw new HttpError(409, 'Changes after that cursor are older than Odin keeps (90 days). Call again without a cursor for a fresh baseline.', { details: { code: 'cursor_expired' } });
  }
  const workflows = await workflowVersions(deps, { projectId, tenantId });
  // The cursor moves past every change read, shown or not. With nothing more to read it moves to
  // the newest settled change in the log, so a quiet project's cursor keeps ahead of the purge.
  const nextSeq = log.more ? log.entries.at(-1).seq : Math.max(afterSeq, log.settledSeq);
  const unchanged = { complete: !log.more, cursor: encodeChangeCursor(projectId, nextSeq), mode: 'changes', ok: true, unchanged: true, workflows };
  if (!log.entries.length) return unchanged;

  const { columns, project } = await loadProject(deps, { projectId, tenantId, user });
  const work = flattenWork(project);
  const byId = new Map(work.map((entry) => [entry.item.id, entry]));
  // Changes to tickets nobody has validated stay out, like the tickets themselves.
  const hidden = new Set((project.tickets ?? []).filter((ticket) => !isTicketVisibleToAssistant(ticket)).map((ticket) => ticket.id));
  const entries = log.entries.filter((entry) => !hidden.has(entry.itemId ?? entry.entityId));
  if (!entries.length) return unchanged;
  const names = await actorNames(deps, { actorIds: new Set(entries.map((entry) => entry.actorId)), tenantId });

  const itemIds = new Set(entries.map((entry) => entry.itemId).filter(Boolean));
  const touched = work.filter((entry) => itemIds.has(entry.item.id));
  const activity = await commentActivity(deps, { projectId, tenantId, work: touched });
  const items = [...itemIds].map((itemId) => (byId.has(itemId) ? compactItem(byId.get(itemId), { activity, columns }) : { deleted: true, id: itemId }));

  // Comments as they are now: each one changed, from its item's thread.
  const commentIds = new Set(entries.filter((entry) => entry.entityType === 'comment').map((entry) => entry.entityId));
  const comments = [];
  const found = new Set();
  const commentItems = [...new Set(entries.filter((entry) => entry.entityType === 'comment').map((entry) => entry.detail?.targetId && `${entry.detail.targetType}:${entry.detail.targetId}`).filter(Boolean))];
  for (const key of commentItems) {
    const [targetType, targetId] = key.split(/:(.+)/);
    if (!byId.has(targetId) && targetType !== 'project') continue;
    const thread = await deps.projectRepository.listComments({ projectId, targetId, targetType, tenantId });
    const flat = [];
    const walk = (nodes) => { for (const node of nodes ?? []) { flat.push(node); walk(node.children); } };
    walk(thread);
    for (const comment of flat) {
      if (!commentIds.has(comment.id)) continue;
      found.add(comment.id);
      comments.push({
        authorId: comment.userId ?? null, authorName: comment.author?.name ?? comment.authorName ?? names.get(comment.userId) ?? null, createdAt: comment.createdAt,
        id: comment.id, itemId: targetId, parentId: comment.parentId ?? null, targetType, updatedAt: comment.updatedAt, ...commentText(comment.comment),
      });
    }
  }
  for (const id of commentIds) if (!found.has(id)) comments.push({ deleted: true, id });

  return {
    changes: entries.map((entry) => presentChange(entry, names)),
    comments,
    complete: !log.more,
    cursor: encodeChangeCursor(projectId, nextSeq),
    items,
    mode: 'changes',
    ok: true,
    unchanged: false,
    workflows,
  };
}

async function baseline(deps, { offset, projectId, tenantId, user }) {
  // The cursor comes first: anything changed while the baseline is read is reported again by the
  // next call, rather than missed.
  // It is the newest settled change in the whole log, so a quiet project's cursor is never already
  // older than Odin keeps.
  const { floorSeq = 0, settledSeq } = await deps.projectRepository.listProjectChanges({ afterSeq: Number.MAX_SAFE_INTEGER, limit: 1, projectId, settleMs: deps.changeSettleMs ?? CHANGE_SETTLE_MS, tenantId });
  const { columns, project } = await loadProject(deps, { projectId, tenantId, user });
  const work = flattenWork(project);
  const page = work.slice(offset, offset + BASELINE_PAGE_SIZE);
  const activity = await commentActivity(deps, { projectId, tenantId, work: page });
  const more = offset + page.length < work.length;
  return {
    board: { columns: columns.map(({ key, name, statuses }) => ({ key, name, statuses })) },
    complete: !more,
    cursor: encodeChangeCursor(projectId, Math.max(settledSeq, floorSeq)),
    items: page.map((entry) => compactItem(entry, { activity, columns })),
    mode: 'baseline',
    ...(more ? { nextOffset: offset + page.length } : {}),
    ok: true,
    project: { id: project.id, name: project.name, status: project.status ?? null, updatedAt: project.updatedAt ?? null },
    totalItems: work.length,
    workflows: await workflowVersions(deps, { projectId, tenantId }),
  };
}
