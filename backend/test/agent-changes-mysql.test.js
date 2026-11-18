import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { sanitizeRichHtml } from '../src/lib/content/html-content.js';
import { createMysqlProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createMysqlResourceFinanceRepository } from '../src/modules/resource-finance/resource-finance.repository.js';
import { createMysqlWorkflowRepository } from '../src/modules/workflows/workflows.repository.js';

// The MySQL side of what undo relies on, against stubbed pools: writes that reply with their own
// state, and deletes and uploads that refuse in the same transaction when someone got there first.

const AT = new Date('2026-10-01T09:00:00.000Z');

// A pool whose statements `answer` replies to by their text (whitespace collapsed), logged in
// order with BEGIN, COMMIT and ROLLBACK. `onCommit` runs as a transaction commits.
function fakePool(answer, { onCommit = () => {} } = {}) {
  const log = [];
  const run = (inTransaction) => async (sql, params = []) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    log.push(text);
    return answer(text, params, inTransaction) ?? [[]];
  };
  const connection = {
    async beginTransaction() { log.push('BEGIN'); },
    async commit() { log.push('COMMIT'); onCommit(); },
    execute: run(true),
    query: run(true),
    release() {},
    async rollback() { log.push('ROLLBACK'); },
  };
  return { log, pool: { execute: run(false), getConnection: async () => connection, query: run(false) } };
}

// A versioned update to `row`, after which someone's edit lands as soon as the row is free: at
// once after an update made outside a transaction, as the transaction commits after one in it.
function updatedUnder(table, row, apply, theirs) {
  let pending = null;
  return fakePool((text, params, inTransaction) => {
    if (text.startsWith(`UPDATE ${table} `)) {
      if (params.at(-1) !== row.version) return [{ affectedRows: 0 }];
      apply(params);
      row.version += 1;
      if (inTransaction) pending = theirs;
      else theirs();
      return [{ affectedRows: 1 }];
    }
    if (text.startsWith(`SELECT version`) && text.includes(`FROM ${table} `)) return [[{ status: row.status, version: row.version }]];
    if (text.startsWith(`SELECT * FROM ${table} `)) return [[{ ...row }]];
    return undefined;
  }, { onCommit: () => { pending?.(); pending = null; } });
}

test('a MySQL resource update replies with its own write, never an edit that lands just after it', async () => {
  const row = { billable: 1, created_at: AT, hours: 2, id: 'time-1', note: '', period_id: null, project_id: 'p1', resource_id: 'res-1', status: 'submitted', tenant_id: 't1', updated_at: AT, version: 1, work_date: '2026-07-06', work_item_id: null };
  const { pool } = updatedUnder('project_time_entries', row, (params) => { row.hours = params[5]; }, () => Object.assign(row, { hours: 8, version: row.version + 1 }));
  const saved = await createMysqlResourceFinanceRepository({ pool }).updateTimeEntry({ input: { expectedVersion: 1, hours: 3 }, tenantId: 't1', timeEntryId: 'time-1' });
  assert.deepEqual([saved.hours, saved.version], [3, 2]);
  assert.deepEqual([row.hours, row.version], [8, 3], 'their edit landed once the write was done');
});

test('a MySQL custom value update replies with its own write, never an edit that lands just after it', async () => {
  const row = { created_at: AT, field_id: 'f-1', id: 'v-1', item_id: 'story-1', item_type: 'story', project_id: 'p1', tenant_id: 't1', updated_at: AT, value_json: '"low"', version: 2 };
  const { pool } = updatedUnder('custom_field_values', row, (params) => { row.value_json = params[0]; }, () => Object.assign(row, { value_json: '"medium"', version: row.version + 1 }));
  const saved = await createMysqlWorkflowRepository({ pool }).upsertCustomValue({ input: { expectedVersion: 2, fieldId: 'f-1', itemId: 'story-1', itemType: 'story', projectId: 'p1', value: 'high' }, tenantId: 't1' });
  assert.deepEqual([saved.value, saved.version], ['high', 3]);
  assert.deepEqual([row.value_json, row.version], ['"medium"', 4]);
});

test('a MySQL upload that must not save over a file refuses, in its transaction, when one is there or is not the one expected', async () => {
  let existing = { id: 'file-theirs', signature: 'sig-theirs' };
  const written = [];
  const { log, pool } = fakePool((text) => {
    if (text.startsWith('SELECT id, tenant_id AS tenantId FROM projects')) return [[{ id: 'p1', tenantId: 't1' }]];
    if (text.startsWith('SELECT id, signature FROM file_vault')) return [existing ? [existing] : []];
    if (text.startsWith('SELECT * FROM file_vault')) return [existing ? [{ ...existing, current_version: 1, file_name: 'notes.md', file_type: 'text/markdown', tenant_id: 't1', user_id: 'u1' }] : []];
    if (text.startsWith('SELECT fv.id')) return [[{ createdAt: AT, fileName: 'notes.md', fileSize: 4, fileType: 'text/markdown', id: 'file-1', signature: 'sig', targetId: 'p1', targetType: 'project', tenantId: 't1', updatedAt: AT, userId: 'u1' }]];
    return undefined;
  });
  const repository = createMysqlProjectsRepository({ fileStorage: { async delete() {}, async read() { return null; }, async write(id) { written.push(id); } }, pool });
  const upload = (guard) => repository.saveFile({ ...guard, fileContentsBase64: Buffer.from('ours').toString('base64'), fileDescription: '', fileName: 'notes.md', fileType: 'text/markdown', projectId: 'p1', targetId: 'p1', targetType: 'project', tenantId: 't1', user: { id: 'u1' } });
  const saves = () => log.filter((text) => /^(UPDATE|INSERT INTO) file_vault/.test(text)).map((text) => text.split(' ')[0]);

  // Someone uploaded the name after the agent listed the files, or saved over the one it listed.
  await assert.rejects(upload({ createOnly: true }), (error) => error.statusCode === 409 && error.details?.code === 'file_exists');
  await assert.rejects(upload({ expectedSignature: 'sig-listed' }), (error) => error.statusCode === 409 && error.details?.code === 'file_changed');
  assert.deepEqual([saves(), written], [[], []]);
  assert.ok(log.filter((text) => text.startsWith('SELECT id, signature FROM file_vault')).every((text) => text.endsWith('FOR UPDATE')), 'the row found is held until the save');

  existing = { id: 'file-theirs', signature: 'sig-listed' };
  await upload({ expectedSignature: 'sig-listed' });
  assert.equal(log.filter((text) => text.startsWith('INSERT INTO file_versions')).length, 1, 'saving over a file keeps what was there');
  assert.notEqual(written[0], 'file-theirs', 'the contents already stored are left alone');
  existing = null;
  await upload({ createOnly: true });
  assert.deepEqual(saves(), ['UPDATE', 'INSERT']);
});

test('a MySQL item delete that must take nothing with it refuses, in its transaction, while anything links to it or is on it', async () => {
  for (const table of ['work_item_relations', 'comments', 'file_vault', 'file_links', 'project_time_entries']) {
    const { log, pool } = fakePool((text) => {
      if (text.includes('information_schema')) return [[{ count: 1 }]];
      if (text.includes('FROM tasks t INNER JOIN projects p')) return [[{ deleted: 0, id: 'task-9', item_type: 'Task', parent_task_id: 'story-1', project_id: 'p1', sort_order: 0, task_type: 3, version: 1 }]];
      if (text.startsWith(`SELECT id FROM ${table} `)) return [[{ id: 'theirs' }]];
      return undefined;
    });
    const remove = createMysqlProjectsRepository({ pool }).deleteProjectItem({ expectedVersion: 1, itemId: 'task-9', projectId: 'p1', tenantId: 't1', user: { id: 'u1' }, withoutDependents: true });
    await assert.rejects(remove, (error) => error.statusCode === 409 && error.details?.code === 'item_has_dependents', table);
    assert.deepEqual([log.some((text) => text.startsWith('UPDATE tasks SET deleted = 1')), log.at(-1)], [false, 'ROLLBACK'], table);
  }
});

test('a MySQL comment delete that names the text it expects refuses, holding the row, once someone edits it', async () => {
  const hash = (text) => createHash('sha256').update(sanitizeRichHtml(text)).digest('hex');
  let stored = '<p>Receipts can wait a sprint.</p>';
  const { log, pool } = fakePool((text) => {
    if (text.startsWith('SELECT comment FROM comments')) return [[{ comment: stored }]];
    if (text.includes('FROM comments WHERE id = ? AND tenant_id = ? LIMIT 1')) return [[{ comment: stored, id: 'c-1', parentId: null, targetId: 'p1', targetType: 'project', tenantId: 't1', userId: 'u1' }]];
    if (text.startsWith('SELECT id, tenant_id AS tenantId FROM projects')) return [[{ id: 'p1', tenantId: 't1' }]];
    return undefined;
  });
  const user = { id: 'u1', memberships: [{ role: 'user', tenantId: 't1' }] };
  const remove = () => createMysqlProjectsRepository({ pool }).deleteComment({ commentId: 'c-1', expectedTextHash: hash('<p>Receipts can wait.</p>'), projectId: 'p1', tenantId: 't1', user, withoutReplies: true });
  await assert.rejects(remove(), (error) => error.statusCode === 409 && error.details?.code === 'comment_changed');
  assert.deepEqual([log.some((text) => text.startsWith('DELETE FROM comments')), log.find((text) => text.startsWith('SELECT comment FROM comments'))?.endsWith('FOR UPDATE')], [false, true]);
  stored = '<p>Receipts can wait.</p>';
  assert.equal(await remove(), true);
  assert.ok(log.some((text) => text.startsWith('DELETE FROM comments')));
});
