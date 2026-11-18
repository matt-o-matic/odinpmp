import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isProductionLikeDatabaseName,
  runSchemaParityMigration,
} from '../src/jobs/migrate-prod-schema-parity.lib.js';

function createFakeExecutor({
  databaseName = 'odinpmp_dev',
  indexes = [],
  tables = {},
} = {}) {
  const ddl = [];

  return {
    ddl,
    async execute(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();

      if (/^SELECT DATABASE\(\) AS databaseName/i.test(normalized)) {
        return [[{ databaseName }]];
      }

      if (normalized.includes('FROM information_schema.TABLES') && normalized.includes('TABLE_COLLATION')) {
        const tableName = params[1];
        const table = tables[tableName];
        return [[table ? { tableCollation: table.collation } : undefined].filter(Boolean)];
      }

      if (normalized.includes('FROM information_schema.TABLES')) {
        const tableName = params[1];
        return [[tables[tableName] ? { 1: 1 } : undefined].filter(Boolean)];
      }

      if (normalized.includes('FROM information_schema.STATISTICS')) {
        const tableName = params[1];
        return [indexes
          .filter((index) => index.table === tableName)
          .flatMap((index) => index.columns.map((column, offset) => ({
            COLUMN_NAME: column,
            INDEX_NAME: index.name,
            NON_UNIQUE: index.unique ? 0 : 1,
            SEQ_IN_INDEX: offset + 1,
          })))];
      }

      ddl.push(normalized);
      return [{ affectedRows: 0 }];
    },
  };
}

test('runSchemaParityMigration defaults to dry-run and reports pending operations without DDL', async () => {
  const executor = createFakeExecutor({
    tables: {
      comments: { collation: 'utf8mb4_0900_ai_ci' },
      project_clarifications: { collation: 'utf8mb4_unicode_ci' },
    },
  });
  const statuses = [];

  const result = await runSchemaParityMigration({
    collationTables: ['project_clarifications'],
    executor,
    indexDefinitions: [
      { columns: ['target_id', 'target_type'], name: 'idx_comments_target_id_type', table: 'comments' },
    ],
    onStatus: (status) => statuses.push(status),
    tableDefinitions: [
      { name: 'holiday_calendar', sql: 'CREATE TABLE IF NOT EXISTS `holiday_calendar` (`id` char(36) NOT NULL)' },
    ],
  });

  assert.equal(result.applied.length, 0);
  assert.equal(result.pending.length, 3);
  assert.deepEqual(result.pending.map((operation) => operation.type), ['table', 'index', 'collation']);
  assert.equal(executor.ddl.length, 0);
  assert.deepEqual(statuses.map((status) => status.type), ['pending', 'pending', 'pending']);
});

test('runSchemaParityMigration applies pending operations in table-index-collation order', async () => {
  const executor = createFakeExecutor({
    tables: {
      comments: { collation: 'utf8mb4_0900_ai_ci' },
      project_clarifications: { collation: 'utf8mb4_unicode_ci' },
    },
  });

  const result = await runSchemaParityMigration({
    apply: true,
    collationTables: ['project_clarifications'],
    executor,
    indexDefinitions: [
      { columns: ['target_id', 'target_type'], name: 'idx_comments_target_id_type', table: 'comments' },
    ],
    tableDefinitions: [
      { name: 'holiday_calendar', sql: 'CREATE TABLE IF NOT EXISTS `holiday_calendar` (`id` char(36) NOT NULL)' },
    ],
  });

  assert.equal(result.applied.length, 3);
  assert.match(executor.ddl[0], /^CREATE TABLE IF NOT EXISTS `holiday_calendar`/);
  assert.match(executor.ddl[1], /^ALTER TABLE `comments` ADD INDEX `idx_comments_target_id_type`/);
  assert.match(executor.ddl[2], /^ALTER TABLE `project_clarifications` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci$/);
});

test('runSchemaParityMigration skips equivalent indexes even when names differ', async () => {
  const executor = createFakeExecutor({
    indexes: [
      { columns: ['target_id', 'target_type'], name: 'legacy_target_lookup', table: 'comments' },
    ],
    tables: {
      comments: { collation: 'utf8mb4_0900_ai_ci' },
    },
  });

  const result = await runSchemaParityMigration({
    executor,
    indexDefinitions: [
      { columns: ['target_id', 'target_type'], name: 'idx_comments_target_id_type', table: 'comments' },
    ],
    tableDefinitions: [],
  });

  assert.equal(result.pending.length, 0);
  assert.equal(result.skipped.length, 13);
  assert.equal(executor.ddl.length, 0);
});

test('runSchemaParityMigration requires explicit production apply confirmation', async () => {
  await assert.rejects(
    runSchemaParityMigration({
      apply: true,
      executor: createFakeExecutor({ databaseName: 'odinpmp_prod' }),
      tableDefinitions: [],
    }),
    /without --allow-production/i,
  );
});

test('isProductionLikeDatabaseName identifies production-like database names', () => {
  assert.equal(isProductionLikeDatabaseName('odinpmp_prod'), true);
  assert.equal(isProductionLikeDatabaseName('production'), true);
  assert.equal(isProductionLikeDatabaseName('odinpmp_dev'), false);
});
