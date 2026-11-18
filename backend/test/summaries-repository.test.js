import assert from 'node:assert/strict';
import test from 'node:test';

import { ensureMysqlSummarySchema } from '../src/modules/summaries/summaries.repository.js';

// A pool that knows only the tables it has been asked to create.
function createSchemaPool() {
  const schemaStatements = [];
  return {
    schemaStatements,
    async execute(sql, params = []) {
      if (sql.includes('FROM information_schema.TABLES')) {
        const [tableName] = params;
        return [[{ count: Number(schemaStatements.some((statement) => statement.includes(`CREATE TABLE ${tableName}`))) }]];
      }
      if (sql.includes('CREATE TABLE')) {
        schemaStatements.push(sql);
        return [{ affectedRows: 0 }];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}

test('mysql summary schema creates the summary tables once', async () => {
  const pool = createSchemaPool();

  await ensureMysqlSummarySchema(pool);
  await ensureMysqlSummarySchema(pool);

  assert.equal(pool.schemaStatements.filter((sql) => sql.includes('CREATE TABLE summary_documents')).length, 1);
  assert.equal(pool.schemaStatements.filter((sql) => sql.includes('CREATE TABLE summary_refresh_queue')).length, 1);
});
