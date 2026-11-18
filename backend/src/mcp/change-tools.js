import { z } from 'zod';
import { itemChangesSchema } from '../modules/changes/changes.schema.js';
import { OdinApiError } from './api-client.js';

// Tools for agents that keep a project in step with the world outside Odin
// (docs/mcp-change-feed/plan.md): what changed since they last looked, the details of the cards
// they pick, and a batch of checked changes, each a single call.

const ERRORS = {
  changes: {
    400: ['invalid_cursor', 'That cursor is not one Odin issued for this project. Call again without a cursor for a fresh baseline.'],
    404: ['http_404', 'Project not found, or the user cannot read it.'],
    409: ['cursor_expired', 'Changes after that cursor are older than Odin keeps (90 days). Call again without a cursor for a fresh baseline.'],
  },
  details: {
    400: ['invalid_request', 'Odin refused the request: name 1 to 25 item ids, or pass continue tokens an earlier call returned for this project.'],
    404: ['http_404', 'Project not found, or the user cannot read it.'],
  },
  apply: {
    400: ['invalid_request', 'Odin refused the batch: check basedOn is a cursor from odin_get_project_changes for this project.'],
    404: ['http_404', 'Project not found, or the user cannot read it.'],
  },
};

async function call(promise, errors) {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof OdinApiError && error.code === `http_${error.status}` && errors[error.status]) {
      const [code, message] = errors[error.status];
      throw new OdinApiError(error.status, code, message, { outcomeUnknown: error.outcomeUnknown });
    }
    throw error;
  }
}

const PLACEMENT = 'status and boardColumn are the raw values Odin stores, kept together (two columns can take one status, and one column several); column is the column the card shows in on your board.';

/** Registers the change tools on createOdinToolCatalog's `tool` helper. */
export function registerChangeTools({ api, id, tool }) {
  const path = (projectId, rest) => `/api/projects/${encodeURIComponent(projectId)}/${rest}`;

  tool('odin_get_project_changes', [
    'What changed in a project since you last looked, in one call. Without cursor: a baseline of every epic, story, task and validated ticket',
    '(id, type, name, status, boardColumn, column, parent, assignee, sprint, priority, version, last update, comment count and time of the latest comment),',
    `the board's columns, the workflow per item type with its version, and a cursor. ${PLACEMENT} Past 1000 items it is paged: call again with nextOffset, keeping the first page's cursor.`,
    'With cursor: only what changed after it, oldest first: each change\'s entity (item, comment, relation, dependency, project), action, actor, via (app for a person in Odin,',
    'assistant for Odin\'s assistant, mcp:<client> for an MCP connection, api:<application> for an app such as Bug Reporter, link for someone on a task link, system for jobs),',
    'the note an agent gave with odin_apply_item_changes (reason, evidence, key) and, for items, the fields changed with old and new values;',
    'plus the current state of every item touched (deleted ones as deleted: true), each new or edited comment as plain text (cut at 2000 characters, marked truncated) and deleted comment ids.',
    'unchanged: true means nothing changed. complete: false means more changes wait: call again with the new cursor. Keep the cursor only once you have used the result;',
    'the same cursor returns the same changes. Changes from the last few seconds are held back until the next call. Comments and links are covered too, not just item versions.',
  ].join(' '), z.object({
    projectId: id,
    cursor: z.string().trim().min(1).max(400).optional().describe('The cursor from your last call. Omit for a baseline.'),
    limit: z.number().int().min(1).max(500).default(200).describe('Most changes to return in one call.'),
    offset: z.number().int().min(0).max(1_000_000).optional().describe('For a baseline past 1000 items: the nextOffset from the previous page.'),
  }).strict(), async (args) => call(api.request('GET', path(args.projectId, 'changes'), {
    query: { cursor: args.cursor, limit: args.cursor ? args.limit : undefined, offset: args.offset },
  }), ERRORS.changes), { purpose: 'See what changed in a project since you last looked: cards, comments, links, who changed them and how, in one call.' });

  tool('odin_get_item_details', [
    'Full detail for up to 25 items in one call, for what odin_get_project_changes leaves out: each item\'s description, estimates, hours and dates,',
    'its comment thread (each comment with its parent, so replies can be rebuilt), its links and schedule dependencies, and its recent change history',
    `with actor, via and fields changed. ${PLACEMENT} Each item also gives what odin_apply_item_changes checks: version, changeSeq (the newest change to the item,`,
    'its comments or its links) and its workflow\'s version. Fields the change feed already gives (assignee, sprint, priority, parent) are not repeated.',
    'Comments and history come newest first in bounded pages, each listed oldest first. When older ones exist, more is true and next is a token:',
    'pass it in continue (with or without itemIds) to read the page before. Results for tokens come in pages. Nothing is cut silently: a long comment is marked truncated,',
    'and past a total budget a thread\'s older comments are left for next. Ids not on the project or not visible come back in missing.',
  ].join(' '), z.object({
    projectId: id,
    itemIds: z.array(id).max(25).optional().describe('Items to read from their newest comments and changes.'),
    continue: z.array(z.string().trim().min(1).max(620)).max(25).optional().describe('next tokens from an earlier call, to read the page before.'),
    commentLimit: z.number().int().min(1).max(100).default(20).describe('Comments per item page.'),
    historyLimit: z.number().int().min(1).max(100).default(10).describe('Changes per item page.'),
  }).strict(), async (args) => call(api.request('GET', path(args.projectId, 'item-details'), {
    query: { commentLimit: args.commentLimit, continue: args.continue?.length ? args.continue.join(',') : undefined, historyLimit: args.historyLimit, ids: args.itemIds?.length ? args.itemIds.join(',') : undefined },
  }), ERRORS.details), { purpose: 'Read the full detail of chosen cards in one call: descriptions, comment threads, links, dependencies and recent history.' });

  tool('odin_apply_item_changes', [
    'Apply up to 25 changes you have checked, each saved only if nothing it was based on moved. Each change names an itemId, a patch (status, boardColumn,',
    'assigneeId, sprintId, remainingHours and the other item fields odin_update_items takes; exact values, no names), a comment (Markdown, no mentions), or both;',
    'a reason; optional evidence references; an idempotencyKey; and expected: the card version you saw, optionally changeSeq (from odin_get_item_details) and',
    'workflowVersion. basedOn, a cursor from odin_get_project_changes, applies to every change. A change is stale, and nothing is saved, when the card version',
    'differs, when the item, its comments or its links changed after changeSeq or basedOn, or when the workflow\'s version differs; a stale result gives the item',
    'as it is now and the changes since, so you can re-plan without another read. Each result says applied, stale, refused (Odin\'s rules said no, with the reason),',
    'failed or in_progress, with the saved values and the item\'s change log entries the change wrote (its reason, evidence and key are on each). A failed change that saved',
    'part of itself says partial. Retrying with the same key and the same change returns the first result (replayed: true) and changes nothing; the same key with',
    'a different change is refused. Send one change per item. Changes run in order and each stands alone: one refused doesn\'t stop the rest.',
  ].join(' '), itemChangesSchema.extend({ projectId: id }).strict(), async ({ projectId, ...body }) => (
    // The change scope refuses a batch whole over the item limit, and counts what it changed. The
    // route answers ok: false when any change was not applied; that is still the batch's result.
    call(api.request('POST', path(projectId, 'item-changes'), { body, okFalseIsResult: true }), ERRORS.apply)
  ), { write: true, purpose: 'Save a batch of checked changes to cards (status, column, fields, comments), each refused if someone changed the card since.' });
}
