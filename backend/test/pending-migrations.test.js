import assert from 'node:assert/strict';
import test from 'node:test';

import { listPendingMysqlMigrations, reportPendingMysqlMigrations } from '../src/lib/database/schema-migrations.js';

const migrations = [
  { id: '0001_first', version: 1, description: 'First', up: async () => {} },
  { id: '0002_second', version: 1, description: 'Second', up: async () => {} },
  { id: '0003_third', version: 1, description: 'Third', up: async () => {} },
];

function fakeExecutor(result) {
  const calls = [];
  return {
    calls,
    async execute(sql, params) {
      calls.push([sql, params]);
      if (result instanceof Error) throw result;
      return [result.map((id) => ({ id }))];
    },
  };
}

function fakeLogger() {
  const errors = [];
  return { errors, error: (...args) => errors.push(args.join(' ')) };
}

test('server start reads the applied migrations once and names the ones not applied, in order', async () => {
  const executor = fakeExecutor(['0002_second']);
  const logger = fakeLogger();
  assert.deepEqual(await reportPendingMysqlMigrations({ executor, logger, migrations }), ['0001_first', '0003_third']);
  assert.deepEqual(executor.calls, [['SELECT id FROM schema_migrations', undefined]]);
  assert.equal(logger.errors.length, 1);
  assert.match(logger.errors[0], /0001_first, 0003_third/);
  assert.match(logger.errors[0], /npm run job:bootstrap-schema/);
});

test('a database with every migration applied logs nothing', async () => {
  const logger = fakeLogger();
  assert.deepEqual(await reportPendingMysqlMigrations({ executor: fakeExecutor(migrations.map((migration) => migration.id)), logger, migrations }), []);
  assert.deepEqual(logger.errors, []);
});

test('a database without schema_migrations has every migration pending', async () => {
  const missing = Object.assign(new Error("Table 'odin.schema_migrations' doesn't exist"), { code: 'ER_NO_SUCH_TABLE' });
  assert.deepEqual(await listPendingMysqlMigrations({ executor: fakeExecutor(missing), migrations }), ['0001_first', '0002_second', '0003_third']);
  const logger = fakeLogger();
  assert.deepEqual(await reportPendingMysqlMigrations({ executor: fakeExecutor(missing), logger, migrations }), ['0001_first', '0002_second', '0003_third']);
  assert.match(logger.errors[0], /3 registered migration\(s\) not applied/);
});

test('a failed check is logged and does not stop the server', async () => {
  const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  await assert.rejects(listPendingMysqlMigrations({ executor: fakeExecutor(refused), migrations }), /ECONNREFUSED/);
  const logger = fakeLogger();
  assert.equal(await reportPendingMysqlMigrations({ executor: fakeExecutor(refused), logger, migrations }), null);
  assert.match(logger.errors[0], /Could not read the applied migrations: connect ECONNREFUSED/);
});
