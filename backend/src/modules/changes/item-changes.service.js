import { createHash } from 'node:crypto';

import { PROJECT_CAPABILITIES, requireProjectCapability } from '../../lib/auth/project-capabilities.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { renderStoredRichTextToHtml } from '../../lib/content/rich-text.js';
import { extractMentionSpans } from '../../lib/mentions/mention-notifications.js';
import { addCommentForUser } from '../comments/comments.service.js';
import { updateProjectItemForUser } from '../projects/projects.service.js';
import { MAX_APPLY_CHANGES } from './changes.schema.js';
import { actorNames, commentText, decodeChangeCursor, flattenWork, loadProject, placement, presentChange, tenantIdOf, workflowVersions } from './changes.service.js';
import { runWithChangeNote } from './project-change-log.js';

// odin_apply_item_changes: a bounded batch of changes an agent has
// checked, each applied only if nothing it was based on has moved since. Each change carries the
// card version it saw, optionally the item's newest change log entry it saw (comments and links
// included) and its workflow's version, an idempotency key, a reason and evidence. A change whose
// basis moved is refused as stale with the item as it is now and what changed since; nothing is
// written over newer work. Applied changes go through Odin's own item and comment writes, so
// workflow rules and permissions hold, and every change log row they write carries the reason,
// evidence and key. Each change reports its own outcome; a retry with the same key gets the first
// result back and changes nothing.

const ITEM_CHANGE_SEQ_LIMIT = 20;

// Text Odin would turn into a mention, which emails the person: the stored-text sanitizer makes the
// span from any spelling it accepts. Words such as "mentioned" are fine.
const mentionsSomeone = (text) => extractMentionSpans(renderStoredRichTextToHtml(String(text ?? ''))).length > 0;

// JSON with sorted keys, so the same change hashes the same however its fields were ordered.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

export function changeRequestHash(basedOn, change) {
  const { idempotencyKey: _key, ...rest } = change;
  return createHash('sha256').update(canonical({ basedOn: basedOn ?? null, ...rest })).digest('hex');
}

// What the stale check names as having moved, from the change log entries since the basis.
function staleCode(entries) {
  const kinds = new Set(entries.map((entry) => entry.entityType));
  if (kinds.has('item') || kinds.has('project')) return 'item_changed';
  if (kinds.has('comment')) return 'comments_changed';
  return 'links_changed';
}

const MESSAGES = {
  comments_changed: 'Someone commented on this item since the state this change was based on. Nothing was saved.',
  duplicate_item: 'This batch already has a change for this item. Send one change per item: put the patch and the comment in the same change.',
  idempotency_key_reused: 'This idempotency key was already used for a different change. Use a new key for a new change.',
  in_progress: 'A request with this idempotency key is still being applied. Retry in a minute with the same key.',
  item_changed: 'This item changed since the state this change was based on. Nothing was saved.',
  item_deleted: 'This item was deleted since the state this change was based on. Nothing was saved.',
  links_changed: 'This item\'s links or dependencies changed since the state this change was based on. Nothing was saved.',
  mentions_not_allowed: 'Mentions email people, so this tool doesn\'t send them. Remove the mention, or add the comment with odin_add_comment, which asks first.',
  not_found: 'No item with this id is on the project, or the caller cannot see it.',
  workflow_changed: 'The workflow for this item type changed since the state this change was based on. Nothing was saved.',
};

export async function applyItemChangesForUser(deps, { input, projectId, user }) {
  const tenantId = tenantIdOf(user);
  await requireProjectCapability({ capability: PROJECT_CAPABILITIES.READ, projectId, repository: deps.projectRepository, tenantId, user });
  if (!input.changes?.length || input.changes.length > MAX_APPLY_CHANGES) {
    throw new HttpError(400, `Send between 1 and ${MAX_APPLY_CHANGES} changes.`, { details: { code: 'invalid_batch' } });
  }
  const basedOnSeq = input.basedOn ? decodeChangeCursor(input.basedOn, projectId) : null;
  const store = deps.projectRepository.itemChangeRequests;
  const workflows = await workflowVersions(deps, { projectId, tenantId });
  let { columns, project } = await loadProject(deps, { projectId, tenantId, user });
  let byId = new Map(flattenWork(project).map((entry) => [entry.item.id, entry]));
  const refresh = (next) => {
    if (!next) return;
    project = next;
    byId = new Map(flattenWork(project).map((entry) => [entry.item.id, entry]));
  };

  // The item's newest change log entries (its own, its comments', and links at either end).
  const historyOf = async (itemId) => (await deps.projectRepository.listItemChanges({ items: [{ itemId }], limit: ITEM_CHANGE_SEQ_LIMIT, projectId, tenantId })).get(itemId)
    ?? { entries: [], latestSeq: null, more: false };
  const present = async (entries) => {
    const names = await actorNames(deps, { actorIds: new Set(entries.map((entry) => entry.actorId)), tenantId });
    return [...entries].sort((left, right) => left.seq - right.seq).map((entry) => presentChange(entry, names));
  };
  const workflowOf = (itemType) => workflows.find((workflow) => workflow.itemType === itemType) ?? null;
  const itemState = (itemId, history) => {
    const entry = byId.get(itemId);
    if (!entry) return { deleted: true, id: itemId };
    const workflow = workflowOf(entry.itemType);
    return {
      id: itemId, itemType: entry.itemType, name: entry.item.name, ...placement(entry.item, columns), version: entry.item.version ?? null,
      changeSeq: history.latestSeq, workflow: workflow ? { version: workflow.version, workflowId: workflow.workflowId } : null,
    };
  };
  const audit = async (itemId, key) => present((await historyOf(itemId)).entries.filter((entry) => entry.detail?.note?.key === key));

  const seen = new Set();
  const results = [];
  for (const change of input.changes) {
    const base = { idempotencyKey: change.idempotencyKey, itemId: change.itemId };
    const outcome = (status, code, extra = {}) => ({ ...base, status, ...(code ? { code, message: MESSAGES[code] ?? extra.message } : {}), ...extra });
    if (seen.has(change.itemId)) {
      results.push(outcome('refused', 'duplicate_item'));
      continue;
    }
    seen.add(change.itemId);

    const keyArgs = { actorId: user.id, key: change.idempotencyKey, tenantId };
    const requestHash = changeRequestHash(input.basedOn, change);
    const claim = await store.claim({ ...keyArgs, itemId: change.itemId, projectId, requestHash });
    if (!claim.claimed) {
      const { record } = claim;
      if (record.requestHash !== requestHash || record.projectId !== projectId) {
        results.push(outcome('refused', 'idempotency_key_reused'));
        continue;
      }
      if (record.status === 'done') {
        results.push({ ...record.result, replayed: true });
        continue;
      }
      if (!await store.takeOver(keyArgs)) {
        results.push(outcome('in_progress', 'in_progress'));
        continue;
      }
      // The request that claimed the key died. Its item write and change log rows commit together,
      // so the log says whether the change landed.
      const landed = await audit(change.itemId, change.idempotencyKey);
      if (landed.length) {
        const result = outcome('applied', null, { audit: landed, item: itemState(change.itemId, await historyOf(change.itemId)), recovered: true });
        await store.finish({ ...keyArgs, result });
        results.push(result);
        continue;
      }
    }

    let wrote = false;
    try {
      const result = await applyOne(change);
      wrote = result.status === 'applied' || Boolean(result.partial);
      // Applied, stale and refused results stand for the key; a failure that wrote nothing frees it.
      if (result.status === 'failed' && !wrote) await store.release(keyArgs);
      else await store.finish({ ...keyArgs, result });
      results.push(result);
    } catch (error) {
      if (!wrote) await store.release(keyArgs).catch(() => {});
      throw error;
    }

    async function applyOne() {
      const entry = byId.get(change.itemId);
      const history = await historyOf(change.itemId);
      if (!entry) {
        const deleted = history.entries.some((logged) => logged.entityType === 'item' && logged.action === 'delete' && logged.itemId === change.itemId);
        return deleted ? outcome('stale', 'item_deleted', { changesSince: await present(history.entries.filter((logged) => logged.seq > (change.expected.changeSeq ?? basedOnSeq ?? 0))), item: { deleted: true, id: change.itemId } }) : outcome('refused', 'not_found');
      }
      // The basis: the card version, the newest change log entry the agent saw, and the workflow.
      const sinceSeq = Math.max(change.expected.changeSeq ?? -1, basedOnSeq ?? -1);
      // Without a log position, the item's own changes past the version the agent saw stand in.
      const newer = sinceSeq >= 0 ? history.entries.filter((logged) => logged.seq > sinceSeq)
        : history.entries.filter((logged) => logged.entityType === 'item' && Number(logged.detail?.version) > change.expected.version);
      const workflow = workflowOf(entry.itemType);
      const staleBecause = Number(entry.item.version) !== change.expected.version ? 'item_changed'
        : change.expected.workflowVersion !== undefined && (workflow?.version ?? null) !== change.expected.workflowVersion ? 'workflow_changed'
          : sinceSeq >= 0 && newer.length ? staleCode(newer) : null;
      if (staleBecause) {
        return outcome('stale', staleBecause, {
          changesSince: await present(newer), item: itemState(change.itemId, history), ...(newer.length && history.more && newer.length === history.entries.length ? { moreChangesSince: true } : {}),
        });
      }
      if ((change.comment && mentionsSomeone(change.comment)) || (change.patch?.description !== undefined && mentionsSomeone(change.patch.description))) {
        return outcome('refused', 'mentions_not_allowed');
      }

      const note = { evidence: change.evidence ?? [], key: change.idempotencyKey, reason: change.reason };
      const done = { comment: false, patch: false };
      let comment = null;
      try {
        await runWithChangeNote(note, async () => {
          if (change.patch && Object.keys(change.patch).length) {
            const updated = await updateProjectItemForUser(user, projectId, change.itemId, { expectedVersion: change.expected.version, patch: change.patch },
              deps.projectRepository, deps.workflowRepository ?? null, deps.notifyTicketStatusChange ?? null, deps.metricsRepository ?? null);
            done.patch = true;
            wrote = true;
            refresh(updated.project);
          }
          if (change.comment) {
            const added = await addCommentForUser(user, projectId, { comment: change.comment, mentions: [], parentId: null, targetId: change.itemId, targetType: entry.itemType }, deps.projectRepository);
            done.comment = true;
            wrote = true;
            comment = added.comment;
          }
        });
      } catch (error) {
        const code = error?.details?.code ?? null;
        if (!done.patch && code === 'project_item_version_conflict') {
          // Someone saved between the check and the write.
          const now = await historyOf(change.itemId);
          refresh(await deps.projectRepository.getProjectDetail({ projectId, tenantId }));
          return outcome('stale', 'item_changed', {
            changesSince: await present(now.entries.filter((logged) => (sinceSeq >= 0 ? logged.seq > sinceSeq : logged.entityType === 'item' && Number(logged.detail?.version) > change.expected.version))),
            item: itemState(change.itemId, now),
          });
        }
        if (done.patch) {
          // The patch saved, the comment didn't: say exactly that.
          return outcome('failed', null, {
            audit: await audit(change.itemId, change.idempotencyKey), code: 'comment_failed', item: itemState(change.itemId, await historyOf(change.itemId)),
            message: `The patch was saved but the comment wasn't: ${error instanceof HttpError ? error.message : 'Odin could not add it.'} Add the comment on its own, with a new key.`,
            partial: true, saved: { fields: savedFields(change.itemId) },
          });
        }
        if (error instanceof HttpError && error.statusCode < 500) {
          return outcome('refused', null, { code: code ?? `http_${error.statusCode}`, message: error.message });
        }
        return outcome('failed', null, { code: 'internal_error', message: 'Odin could not apply this change. Nothing was saved; retry with the same key.' });
      }
      return outcome('applied', null, {
        audit: await audit(change.itemId, change.idempotencyKey),
        item: itemState(change.itemId, await historyOf(change.itemId)),
        saved: {
          ...(done.patch ? { fields: savedFields(change.itemId) } : {}),
          ...(comment ? { comment: { createdAt: comment.createdAt, id: comment.id, ...commentText(comment.comment) } } : {}),
        },
      });
    }

    // The patched fields as Odin saved them, which may differ from what was sent (a column
    // move can set a status, for one).
    function savedFields(itemId) {
      const saved = byId.get(itemId)?.item ?? {};
      return Object.fromEntries(Object.keys(change.patch ?? {}).map((field) => [field, saved[field] ?? null]));
    }
  }

  return {
    applied: results.filter((result) => result.status === 'applied').length,
    ok: results.every((result) => result.status === 'applied'),
    results,
  };
}
