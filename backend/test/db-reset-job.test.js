import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeMysqlDatabaseTarget,
  dropAllTablesInSchema,
  importMysqlSchemaWithCli,
  resetMysqlDatabase,
} from '../src/jobs/db-reset.lib.js';

test('describeMysqlDatabaseTarget rejects missing DATABASE_URL input', () => {
  assert.throws(
    () => describeMysqlDatabaseTarget(''),
    /DATABASE_URL is required/i,
  );
});

test('describeMysqlDatabaseTarget rejects non-MySQL URLs', () => {
  assert.throws(
    () => describeMysqlDatabaseTarget('postgres://user:pass@127.0.0.1:5432/odinpmp_dev'),
    /must use the mysql protocol/i,
  );
});

test('describeMysqlDatabaseTarget rejects URLs without a database name', () => {
  assert.throws(
    () => describeMysqlDatabaseTarget('mysql://user:pass@127.0.0.1:3306/'),
    /must include a database name/i,
  );
});

test('dropAllTablesInSchema drops every discovered table with foreign key checks disabled', async () => {
  const executed = [];
  const queried = [];
  const pool = {
    async execute(sql, params = []) {
      executed.push({ params, sql });
      return [];
    },
    async query(sql, params = []) {
      queried.push({ params, sql });
      return [[
        { tableName: 'projects' },
        { tableName: 'summary_documents' },
      ]];
    },
  };

  const droppedTableCount = await dropAllTablesInSchema({
    databaseName: 'odinpmp_dev',
    pool,
  });

  assert.equal(droppedTableCount, 2);
  assert.match(queried[0].sql, /information_schema\.tables/i);
  assert.deepEqual(queried[0].params, ['odinpmp_dev']);
  assert.deepEqual(
    executed.map((statement) => statement.sql),
    [
      'SET FOREIGN_KEY_CHECKS = 0',
      'DROP TABLE IF EXISTS `projects`',
      'DROP TABLE IF EXISTS `summary_documents`',
      'SET FOREIGN_KEY_CHECKS = 1',
    ],
  );
});

test('importMysqlSchemaWithCli pipes the schema into mysql for the target database', async () => {
  const spawnCalls = [];

  await importMysqlSchemaWithCli({
    readSchemaFile: () => Buffer.from('CREATE TABLE example (id INT);'),
    schemaPath: '/tmp/mysql.schema.sql',
    spawnSyncImpl(command, args, options) {
      spawnCalls.push({ args, command, options });
      return { status: 0 };
    },
    target: {
      databaseName: 'odinpmp_dev',
      host: '127.0.0.1',
      password: 'secret',
      port: '3306',
      username: 'odin',
    },
  });

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, 'mysql');
  assert.deepEqual(
    spawnCalls[0].args,
    [
      '--host=127.0.0.1',
      '--port=3306',
      '--user=odin',
      '--protocol=TCP',
      'odinpmp_dev',
    ],
  );
  assert.equal(spawnCalls[0].options.input.toString(), 'CREATE TABLE example (id INT);');
  assert.equal(spawnCalls[0].options.env.MYSQL_PWD, 'secret');
});

test('resetMysqlDatabase rejects production-like targets before destructive work', async () => {
  await assert.rejects(
    resetMysqlDatabase({
      databaseUrl: 'mysql://odin:secret@127.0.0.1:3306/odinpmp_prod',
      yes: true,
    }),
    /refuses to reset production-like databases/i,
  );
});

test('resetMysqlDatabase requires confirmation unless --yes is passed', async () => {
  const calls = [];
  let confirmedTarget = null;

  await assert.rejects(
    resetMysqlDatabase({
      bootstrapMysqlSchema: async () => {
        calls.push('bootstrap');
      },
      confirmReset: async (target) => {
        confirmedTarget = target;
        return false;
      },
      createAuthRepository: () => ({}),
      createMysqlPool: () => {
        calls.push('pool');
        return {
          end: async () => {
            calls.push('end');
          },
        };
      },
      databaseUrl: 'mysql://odin:secret@127.0.0.1:3306/odinpmp_dev',
      ensureDevelopmentDemoUser: async () => {
        calls.push('demo');
      },
      importMysqlSchema: async () => {
        calls.push('import');
      },
    }),
    /cancelled/i,
  );

  assert.equal(confirmedTarget?.databaseName, 'odinpmp_dev');
  assert.deepEqual(calls, []);
});

test('resetMysqlDatabase skips demo seeding only when requested', async () => {
  const firstRunCalls = [];
  const secondRunCalls = [];
  const createPool = (calls) => ({
    async end() {
      calls.push('end');
    },
  });

  const baseOptions = {
    bootstrapMysqlSchema: async () => {},
    confirmReset: async () => true,
    createAuthRepository: () => ({ kind: 'auth-repository' }),
    databaseUrl: 'mysql://odin:secret@127.0.0.1:3306/odinpmp_dev',
    dropAllTables: async () => 0,
    importMysqlSchema: async () => {},
    yes: true,
  };

  await resetMysqlDatabase({
    ...baseOptions,
    createMysqlPool: () => createPool(firstRunCalls),
    ensureDevelopmentDemoUser: async () => {
      firstRunCalls.push('demo');
      return { created: true };
    },
  });

  await resetMysqlDatabase({
    ...baseOptions,
    createMysqlPool: () => createPool(secondRunCalls),
    ensureDevelopmentDemoUser: async () => {
      secondRunCalls.push('demo');
      return { created: true };
    },
    skipDemo: true,
  });

  assert.deepEqual(firstRunCalls, ['demo', 'end']);
  assert.deepEqual(secondRunCalls, ['end']);
});
