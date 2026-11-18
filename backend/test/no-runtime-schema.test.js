import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { mysqlMigrationDefinitions } from '../src/jobs/bootstrap-schema.lib.js';

// Only the registered migrations create or change schema (npm run job:bootstrap-schema).
// Request handlers, polls, jobs and server start must not run DDL or information_schema
// probes, or call the helpers that do. This scans backend/src, one top-level declaration at a
// time, and allows schema code only inside migration helpers and the places listed below.

const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));

// Files that may hold DDL anywhere.
const ALLOWED_FILES = {
  'jobs/bootstrap-schema.lib.js': 'the migration registry',
  'lib/database/schema-migrations.js': 'the migration runner, which owns schema_migrations',
  'jobs/db-reset.lib.js': 'drops every table of a development database (npm run job:db-reset); refuses production',
  'jobs/migrate-prod-schema-parity.lib.js': 'operator-run job that aligns an old database with the legacy base schema',
  'lib/agent/odin-query-worker.js': 'creates in-memory SQLite tables for agent queries, not MySQL',
};

// Top-level declarations that hold migration code without a helper's name.
const ALLOWED_DECLARATIONS = {
  'modules/tenants/join-requests.repository.js': { JOIN_REQUEST_INDEXES: 'index statements of migration 0072' },
};

// Registered migrations that request code may still call: they insert lookup rows, not schema.
const DATA_SEEDERS = {
  ensureMysqlProjectStatuses: 'project status lookups seed the canonical statuses when none exist',
  ensureMysqlProjectTaskTypes: 'task type lookups seed canonical task types added since the last run',
};

const REGISTERED_HELPERS = new Set(mysqlMigrationDefinitions().map((migration) => migration.up.name));
const SCHEMA_HELPER = /^ensure\w*(?:Schema|Columns)$/;
const PROBE_HELPER = /^(?:tableExists|columnExists|indexExists|memoryColumnExists|columnLength|getColumnDefinition|getForeignKeyConstraintName|primaryKeyColumns|informationSchemaCount)$/;
const DECLARATION = /^(?:export\s+)?(?:async\s+)?(?:function\*?\s+|const\s+|let\s+|var\s+|class\s+)([A-Za-z0-9_$]+)/;

const CHECKS = [
  ['DDL or information_schema', /\b(?:CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX)|ADD\s+COLUMN|MODIFY\s+COLUMN|DROP\s+FOREIGN\s+KEY|information_schema)\b/i],
  ['schema helper or wrapper', /\bensure\w*(?:Schema|Columns)\b/],
  ['schema probe', new RegExp(`\\b(?:${PROBE_HELPER.source.slice(4, -2)})\\s*\\(`)],
  ['registered migration helper', new RegExp(`\\b(?:${[...REGISTERED_HELPERS].filter((name) => !DATA_SEEDERS[name]).join('|')})\\b`)],
  ['ensureOnce on something other than a data seeder', new RegExp(`(?<!function )\\bensureOnce\\(\\s*\\w+\\s*,\\s*(?!(?:${Object.keys(DATA_SEEDERS).join('|')})\\b)\\w`)],
];

function isMigrationCode(file, name) {
  return SCHEMA_HELPER.test(name) || PROBE_HELPER.test(name) || REGISTERED_HELPERS.has(name) || Boolean(ALLOWED_DECLARATIONS[file]?.[name]);
}

/** Every line of runtime code in `text` that runs or calls schema code, as `file:line [check] text`. */
export function findRuntimeSchemaUse(file, text) {
  if (ALLOWED_FILES[file]) return [];
  const found = [];
  let declaration = '';
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const match = DECLARATION.exec(line);
    if (match) declaration = match[1];
    else if (/^[}\])]/.test(line)) declaration = '';
    const trimmed = line.trim();
    if (/^(?:\/\/|\/\*|\*)/.test(trimmed) || isMigrationCode(file, declaration)) continue;
    for (const [check, pattern] of CHECKS) {
      if (pattern.test(line)) found.push(`${file}:${index + 1} [${check}] ${trimmed.slice(0, 160)}`);
    }
  }
  return found;
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

test('the scan reports each way request code used to run schema code', () => {
  const runtime = (body) => `export function createMysqlExampleRepository({ pool }) {\n${body}\n}\n`;
  const cases = {
    'a direct helper call': '  async function list() { await ensureMysqlProjectPlanningSchema(pool); }',
    'ensureOnce on a schema helper': '  async function list() { await ensureOnce(pool, ensureMysqlTicketingSchema); }',
    'a memoizing wrapper': '  let ready = null;\n  const ensure = () => (ready ??= ensureMysqlMcpOAuthSchema(pool));',
    'a wrapper call': '  async function list() { await ensureSchema(); }',
    'inline DDL': "  async function save() { await pool.execute('CREATE TABLE IF NOT EXISTS bug_reporter_replies (id CHAR(36))'); }",
    'an information_schema probe': "  async function save() { await pool.execute('SELECT COUNT(*) FROM information_schema.tables'); }",
    'a probe helper call': "  async function save() { if (await tableExists(pool, 'tasks')) return; }",
    'a registered data migration': '  async function save(connection) { await ensureMysqlAuthenticationMethods(connection); }',
  };
  for (const [name, body] of Object.entries(cases)) {
    assert.notDeepEqual(findRuntimeSchemaUse('modules/example/example.repository.js', runtime(body)), [], name);
  }

  const allowed = [
    "export async function ensureMysqlExampleSchema(executor) {\n  if (!await tableExists(executor, 'x')) await executor.execute('CREATE TABLE x (id INT)');\n}\n",
    "async function tableExists(executor, name) {\n  return executor.execute('SELECT 1 FROM information_schema.TABLES WHERE TABLE_NAME = ?', [name]);\n}\n",
    runtime('  async function ids(executor) { await ensureOnce(pool, ensureMysqlProjectTaskTypes, executor); return ensureMysqlProjectStatuses(executor); }'),
    runtime("  // A comment may mention CREATE TABLE.\n  async function save() { await pool.execute('INSERT INTO x VALUES (1)'); }"),
  ];
  for (const text of allowed) assert.deepEqual(findRuntimeSchemaUse('modules/example/example.repository.js', text), []);
  assert.notDeepEqual(
    findRuntimeSchemaUse('modules/example/example.repository.js', "export async function ensureMysqlExampleSchema(executor) {\n  await executor.execute('CREATE TABLE x (id INT)');\n}\nawait pool.execute('ALTER TABLE x ADD COLUMN y INT');\n"),
    [],
    'module-level code after a helper is runtime code',
  );
});

test('backend/src runs no schema code outside registered migrations', () => {
  const found = sourceFiles(srcRoot).flatMap((full) => {
    const file = path.relative(srcRoot, full).split(path.sep).join('/');
    return findRuntimeSchemaUse(file, readFileSync(full, 'utf8'));
  });
  assert.deepEqual(found, [], `Schema code outside migrations. Register a migration in src/jobs/bootstrap-schema.lib.js instead:\n${found.join('\n')}`);
});
