import { mysqlMigrationDefinitions } from '../../src/jobs/bootstrap-schema.lib.js';

// Runs the `up` of the named registered migrations, in registration order, without recording
// them in schema_migrations. For MySQL tests that use the test database as they find it and need
// only some of Odin's tables. Every `up` is idempotent, so a database that has them already is
// left as it is.
export async function applyMysqlMigrations(executor, ids) {
  const definitions = mysqlMigrationDefinitions();
  const unknown = ids.filter((id) => !definitions.some((migration) => migration.id === id));
  if (unknown.length > 0) throw new Error(`Unknown migrations: ${unknown.join(', ')}.`);
  for (const migration of definitions) {
    if (ids.includes(migration.id)) await migration.up(executor);
  }
}
