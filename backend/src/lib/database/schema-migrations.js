import { createHash } from 'node:crypto';

const MIGRATION_LOCK = 'odinpmp_schema_migrations';

// A migration's checksum covers its id, description, version and the source of its `up`
// function, so a migration edited after it ran is caught. The source is hashed with LF line
// endings: the same code checked out on Windows (CRLF) and on Linux (LF) hashes the same.
//
// Production recorded 0001-0049 from a Windows checkout, before line endings were
// normalized. A stored checksum that matches the CRLF form of the current source is the same
// code, so it is accepted and re-recorded in the normalized form.

function sourceOf(migration) {
  return migration.up.toString().replace(/\r\n?/g, '\n');
}

function checksumOf(migration, source) {
  return createHash('sha256')
    .update(`${migration.id}\n${migration.description}\n${migration.version}\n${source}`)
    .digest('hex');
}

function migrationChecksum(migration) {
  return checksumOf(migration, sourceOf(migration));
}

/** The checksum the same migration had when hashed from a CRLF checkout. */
function legacyCrlfChecksum(migration) {
  return checksumOf(migration, sourceOf(migration).replace(/\n/g, '\r\n'));
}

function normalizeMigration(migration) {
  if (!/^\d{4}_[a-z0-9_]+$/.test(String(migration?.id ?? ''))) {
    throw new TypeError(`Invalid migration id: ${migration?.id ?? '<missing>'}.`);
  }
  if (!Number.isInteger(migration?.version) || migration.version < 1) {
    throw new TypeError(`Migration ${migration.id} requires a positive integer version.`);
  }
  if (typeof migration?.up !== 'function') {
    throw new TypeError(`Migration ${migration.id} requires an up function.`);
  }
  return { ...migration, checksum: migrationChecksum(migration), legacyChecksum: legacyCrlfChecksum(migration) };
}

async function withConnection(executor, run) {
  if (!executor?.getConnection) return run(executor, false);
  const connection = await executor.getConnection();
  try { return await run(connection, true); }
  finally { connection.release(); }
}

/**
 * Applies the migrations not yet recorded, in order, under a named lock.
 *
 * A recorded migration whose code changed since it ran stops the run
 * (`schema_migration_checksum_mismatch`). With `reconcile: true` the run instead applies the
 * changed migration's current `up` again and records its new checksum; use it only for
 * migrations written to be re-run safely (the ensure-schema helpers are). The result lists
 * those in `reconciled`, and checksums re-recorded after a line-ending-only difference in
 * `restamped`.
 */
export async function runMysqlMigrations({ executor, lockTimeoutSeconds = 30, migrations, reconcile = false }) {
  if (!executor?.execute) throw new TypeError('A MySQL executor is required.');
  const normalized = migrations.map(normalizeMigration);
  const ids = new Set();
  for (const migration of normalized) {
    if (ids.has(migration.id)) throw new TypeError(`Duplicate migration id: ${migration.id}.`);
    ids.add(migration.id);
  }

  return withConnection(executor, async (connection) => {
    await connection.execute(`CREATE TABLE IF NOT EXISTS schema_migrations (id VARCHAR(128) PRIMARY KEY, version INT NOT NULL, checksum CHAR(64) NOT NULL, description VARCHAR(255) NOT NULL, applied_at DATETIME(3) NOT NULL, execution_ms BIGINT NOT NULL)`);
    const [lockRows] = await connection.execute('SELECT GET_LOCK(?, ?) AS acquired', [MIGRATION_LOCK, lockTimeoutSeconds]);
    if (Number(lockRows[0]?.acquired) !== 1) throw new Error('Timed out acquiring the schema migration lock.');
    const applied = [];
    const reconciled = [];
    const restamped = [];
    const record = (migration) => connection.execute(
      'UPDATE schema_migrations SET checksum = ?, version = ?, description = ? WHERE id = ?',
      [migration.checksum, migration.version, migration.description, migration.id],
    );
    try {
      for (const migration of normalized) {
        const [rows] = await connection.execute('SELECT version, checksum FROM schema_migrations WHERE id = ? LIMIT 1', [migration.id]);
        if (rows[0]) {
          const sameVersion = Number(rows[0].version) === migration.version;
          if (sameVersion && rows[0].checksum === migration.checksum) continue;
          if (sameVersion && rows[0].checksum === migration.legacyChecksum) {
            await record(migration);
            restamped.push(migration.id);
            continue;
          }
          if (!reconcile) {
            throw Object.assign(new Error(`Migration checksum mismatch: ${migration.id}.`), { code: 'schema_migration_checksum_mismatch', migrationId: migration.id });
          }
          await migration.up(connection);
          await record(migration);
          reconciled.push(migration.id);
          continue;
        }
        const startedAt = Date.now();
        await migration.up(connection);
        await connection.execute(
          'INSERT INTO schema_migrations (id, version, checksum, description, applied_at, execution_ms) VALUES (?, ?, ?, ?, ?, ?)',
          [migration.id, migration.version, migration.checksum, migration.description, new Date(), Date.now() - startedAt],
        );
        applied.push(migration.id);
      }
      return {
        applied,
        ...(reconciled.length ? { reconciled } : {}),
        ...(restamped.length ? { restamped } : {}),
        total: normalized.length,
      };
    } finally {
      await connection.execute('SELECT RELEASE_LOCK(?) AS released', [MIGRATION_LOCK]);
    }
  });
}

/**
 * The ids of the given migrations not yet recorded as applied, in their order. One query; a
 * database without the schema_migrations table has applied none.
 */
export async function listPendingMysqlMigrations({ executor, migrations }) {
  let rows = [];
  try {
    [rows] = await executor.execute('SELECT id FROM schema_migrations');
  } catch (error) {
    if (error?.code !== 'ER_NO_SUCH_TABLE') throw error;
  }
  const applied = new Set(rows.map((row) => String(row.id)));
  return migrations.map((migration) => migration.id).filter((id) => !applied.has(id));
}

/**
 * For server start: logs an error naming the migrations the database lacks, and returns their
 * ids (null when the check itself failed). Never throws, so the server keeps running; requests
 * that need the missing schema fail on their own.
 */
export async function reportPendingMysqlMigrations({ executor, logger = console, migrations }) {
  try {
    const pending = await listPendingMysqlMigrations({ executor, migrations });
    if (pending.length > 0) {
      logger.error(`[schema] ${pending.length} registered migration(s) not applied: ${pending.join(', ')}. Run npm run job:bootstrap-schema.`);
    }
    return pending;
  } catch (error) {
    logger.error(`[schema] Could not read the applied migrations: ${error?.message ?? error}`);
    return null;
  }
}

export { legacyCrlfChecksum, migrationChecksum };
