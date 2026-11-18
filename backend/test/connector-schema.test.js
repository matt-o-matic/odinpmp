import assert from 'node:assert/strict';
import test from 'node:test';

import mysql from 'mysql2/promise';

import { ensureMysqlConnectorMarketplaceSchema, ensureMysqlConnectorSchema } from '../src/modules/connectors/connector.repository.js';

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();

test('connector marketplace schema tolerates concurrent duplicate-column winners', async () => {
  const addedColumns = new Set();
  const alterAttempts = [];
  let releaseSelects;
  let selectCount = 0;
  const bothSelected = new Promise((resolve) => { releaseSelects = resolve; });
  const executor = {
    async execute(statement) {
      if (statement.startsWith('SELECT column_name')) {
        selectCount += 1;
        if (selectCount === 2) releaseSelects();
        await bothSelected;
        return [[], []];
      }
      if (statement.startsWith('ALTER TABLE connector_connections ADD COLUMN')) {
        const columnName = statement.match(/ADD COLUMN ([a-z_]+)/)?.[1];
        alterAttempts.push(columnName);
        if (addedColumns.has(columnName)) {
          const error = new Error(`Duplicate column name '${columnName}'`);
          error.code = 'ER_DUP_FIELDNAME';
          throw error;
        }
        addedColumns.add(columnName);
      }
      return [[], []];
    },
  };

  await Promise.all([
    ensureMysqlConnectorMarketplaceSchema(executor),
    ensureMysqlConnectorMarketplaceSchema(executor),
  ]);

  assert.deepEqual([...addedColumns].sort(), ['approved_at', 'approved_by']);
  assert.equal(alterAttempts.length, 4);
});

test('connector marketplace schema surfaces non-idempotent DDL failures', async () => {
  const executor = {
    async execute(statement) {
      if (statement.startsWith('SELECT column_name')) return [[], []];
      if (statement.startsWith('ALTER TABLE connector_connections ADD COLUMN')) {
        const error = new Error('Schema metadata lock timed out.');
        error.code = 'ER_LOCK_WAIT_TIMEOUT';
        throw error;
      }
      return [[], []];
    },
  };

  await assert.rejects(
    ensureMysqlConnectorMarketplaceSchema(executor),
    (error) => error.code === 'ER_LOCK_WAIT_TIMEOUT',
  );
});

test('connector marketplace schema is race-safe across MySQL executors', { skip: !databaseUrl, timeout: 10_000 }, async () => {
  const sourceUrl = new URL(databaseUrl);
  const sourceSchema = decodeURIComponent(sourceUrl.pathname.slice(1));
  assert.match(sourceSchema, /^odinpmp_test_[a-zA-Z0-9_]*$/);
  const schemaName = `${sourceSchema}_connector_race_${process.pid}`.slice(0, 64);
  const admin = await mysql.createConnection({
    host: sourceUrl.hostname,
    password: decodeURIComponent(sourceUrl.password),
    port: Number(sourceUrl.port || 3306),
    user: decodeURIComponent(sourceUrl.username),
  });
  const schemaUrl = new URL(sourceUrl);
  schemaUrl.pathname = `/${schemaName}`;
  let firstPool;
  let secondPool;
  try {
    await admin.query(`CREATE DATABASE \`${schemaName}\``);
    firstPool = mysql.createPool(schemaUrl.toString());
    secondPool = mysql.createPool(schemaUrl.toString());
    await ensureMysqlConnectorSchema(firstPool);

    let releaseSelects;
    let selectCount = 0;
    const bothSelected = new Promise((resolve) => { releaseSelects = resolve; });
    const gateMarketplaceRead = (pool) => ({
      async execute(statement, parameters) {
        const result = await pool.execute(statement, parameters);
        if (statement.startsWith('SELECT column_name') && statement.includes("table_name = 'connector_connections'")) {
          selectCount += 1;
          if (selectCount === 2) releaseSelects();
          await bothSelected;
        }
        return result;
      },
    });

    await Promise.all([
      ensureMysqlConnectorMarketplaceSchema(gateMarketplaceRead(firstPool)),
      ensureMysqlConnectorMarketplaceSchema(gateMarketplaceRead(secondPool)),
    ]);

    const [columns] = await firstPool.execute("SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'connector_connections' AND column_name IN ('approved_by', 'approved_at')");
    assert.deepEqual(columns.map((row) => row.column_name ?? row.COLUMN_NAME).sort(), ['approved_at', 'approved_by']);
  } finally {
    await Promise.all([firstPool?.end(), secondPool?.end()].filter(Boolean));
    await admin.query(`DROP DATABASE IF EXISTS \`${schemaName}\``);
    await admin.end();
  }
});
