import assert from 'node:assert/strict';
import test from 'node:test';

import { bootstrapMysqlSchema } from '../src/jobs/bootstrap-schema.lib.js';
import { ensureMysqlTicketingSchema } from '../src/modules/projects/projects.repository.js';
import { ensureMysqlTicketReopenSchema } from '../src/modules/projects/ticket-reopen.schema.js';

function recordingExecutor({ present }) {
  const statements = [];
  return {
    statements,
    async execute(sql) {
      statements.push(sql.trim());
      if (sql.includes('information_schema.COLUMNS')) return [[{ count: present ? 1 : 0 }]];
      return [{ affectedRows: 0 }];
    },
  };
}

test('0065 adds the reopen count and last reopen time to tasks once', async () => {
  const fresh = recordingExecutor({ present: false });
  await ensureMysqlTicketReopenSchema(fresh);
  assert.deepEqual(fresh.statements.filter((sql) => sql.startsWith('ALTER TABLE')), [
    'ALTER TABLE tasks ADD COLUMN reopen_count INT NOT NULL DEFAULT 0',
    'ALTER TABLE tasks ADD COLUMN last_reopened_at DATETIME(3) NULL',
  ]);

  const migrated = recordingExecutor({ present: true });
  await ensureMysqlTicketReopenSchema(migrated);
  assert.equal(migrated.statements.filter((sql) => sql.startsWith('ALTER TABLE')).length, 0);
});

test('0065 is registered after 0063 and leaves the 0047 ticketing migration untouched', async () => {
  let registered = [];
  await bootstrapMysqlSchema({
    executor: {},
    runMigrations: async ({ migrations }) => {
      registered = migrations;
      return { applied: [], total: migrations.length };
    },
  });
  const ids = registered.map((migration) => migration.id);
  const reopen = registered.find((migration) => migration.id === '0065_ticket_reopen_count');
  assert.ok(ids.indexOf('0065_ticket_reopen_count') > ids.indexOf('0063_clarification_topics_backfill'));
  assert.equal(reopen.up, ensureMysqlTicketReopenSchema);
  assert.equal(registered.find((migration) => migration.id === '0047_ticketing').up, ensureMysqlTicketingSchema);
  assert.doesNotMatch(String(ensureMysqlTicketingSchema), /reopen/);
});
