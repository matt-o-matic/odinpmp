import assert from 'node:assert/strict';
import test from 'node:test';

import { legacyCrlfChecksum, migrationChecksum, runMysqlMigrations } from '../src/lib/database/schema-migrations.js';

function fakeExecutor(seed = new Map()) {
  const applied = seed;
  const calls = [];
  return {
    applied,
    calls,
    async execute(sql, params = []) {
      calls.push([sql, params]);
      if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
      if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }]];
      if (sql.startsWith('SELECT version, checksum')) return [[applied.get(params[0])].filter(Boolean)];
      if (sql.startsWith('INSERT INTO schema_migrations')) {
        applied.set(params[0], { checksum: params[2], version: params[1] });
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('UPDATE schema_migrations')) {
        applied.set(params[3], { checksum: params[0], version: params[1] });
        return [{ affectedRows: 1 }];
      }
      return [{ affectedRows: 0 }];
    },
  };
}

test('migration runner applies each migration once and records checksums', async () => {
  const executor = fakeExecutor();
  const bodies = [];
  const migrations = [
    { id: '0001_first', version: 1, description: 'First', up: async () => bodies.push('first') },
    { id: '0002_second', version: 1, description: 'Second', up: async () => bodies.push('second') },
  ];
  assert.deepEqual(await runMysqlMigrations({ executor, migrations }), { applied: ['0001_first', '0002_second'], total: 2 });
  assert.deepEqual(await runMysqlMigrations({ executor, migrations }), { applied: [], total: 2 });
  assert.deepEqual(bodies, ['first', 'second']);
  assert.equal(executor.applied.get('0001_first').checksum, migrationChecksum(migrations[0]));
});

test('migration runner fails closed when an applied migration changes', async () => {
  const migration = { id: '0001_first', version: 1, description: 'First', up: async () => {} };
  const executor = fakeExecutor(new Map([['0001_first', { checksum: '0'.repeat(64), version: 1 }]]));
  await assert.rejects(
    runMysqlMigrations({ executor, migrations: [migration] }),
    (error) => error.code === 'schema_migration_checksum_mismatch',
  );
  assert.equal(executor.calls.some(([sql]) => sql.includes('RELEASE_LOCK')), true);
});

test('checksums ignore line endings: CRLF and LF copies of the same code match', () => {
  const LF = String.fromCharCode(10);
  const CR = String.fromCharCode(13);
  const lf = { id: '0001_first', version: 1, description: 'First', up: new Function('executor', ['return executor;', 'const a = 1;'].join(LF)) };
  const crlf = { ...lf, up: new Function('executor', ['return executor;', 'const a = 1;'].join(CR + LF)) };
  assert.equal(migrationChecksum(crlf), migrationChecksum(lf));
  assert.notEqual(legacyCrlfChecksum(lf), migrationChecksum(lf));
});

test('a checksum recorded from a CRLF checkout is accepted and re-recorded, without running the migration again', async () => {
  let runs = 0;
  const migration = { id: '0001_first', version: 1, description: 'First', up: async () => {
    runs += 1;
  } };
  const executor = fakeExecutor(new Map([['0001_first', { checksum: legacyCrlfChecksum(migration), version: 1 }]]));
  assert.deepEqual(await runMysqlMigrations({ executor, migrations: [migration] }), { applied: [], restamped: ['0001_first'], total: 1 });
  assert.equal(runs, 0);
  assert.equal(executor.applied.get('0001_first').checksum, migrationChecksum(migration));
  assert.deepEqual(await runMysqlMigrations({ executor, migrations: [migration] }), { applied: [], total: 1 }, 'the next run matches directly');
});

test('reconcile re-runs a migration edited after it ran and records its new checksum', async () => {
  const bodies = [];
  const migrations = [
    { id: '0001_first', version: 1, description: 'First', up: async () => bodies.push('first, edited') },
    { id: '0002_second', version: 1, description: 'Second', up: async () => bodies.push('second') },
  ];
  const executor = fakeExecutor(new Map([['0001_first', { checksum: '0'.repeat(64), version: 1 }]]));
  await assert.rejects(runMysqlMigrations({ executor, migrations }), (error) => error.migrationId === '0001_first');
  assert.deepEqual(bodies, [], 'without reconcile nothing runs, including later migrations');
  assert.deepEqual(await runMysqlMigrations({ executor, migrations, reconcile: true }), { applied: ['0002_second'], reconciled: ['0001_first'], total: 2 });
  assert.deepEqual(bodies, ['first, edited', 'second']);
  assert.equal(executor.applied.get('0001_first').checksum, migrationChecksum(migrations[0]));
  assert.deepEqual(await runMysqlMigrations({ executor, migrations }), { applied: [], total: 2 });
});
