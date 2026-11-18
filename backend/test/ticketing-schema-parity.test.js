// Every ticketing table and column reaches a database through the registered
// migration path, so a fresh bootstrap and an existing deployment converge.
//
// The production parity job (migrate-prod-schema-parity.lib.js) covers legacy tables that
// exist in production but not in the bootstrap path. Ticketing tables are not in that
// category — they are created by migrations 0047-0049 — so the parity guarantee here is
// that those migrations are registered, ordered, and emit the expected DDL.

import assert from 'node:assert/strict';
import test from 'node:test';

import { bootstrapMysqlSchema } from '../src/jobs/bootstrap-schema.lib.js';
import {
  ensureMysqlTicketConfigSchema,
  ensureMysqlTicketIntakeSchema,
  ensureMysqlTicketingSchema,
} from '../src/modules/projects/projects.repository.js';

const TICKET_COLUMNS = [
  'category',
  'severity',
  'repro_steps',
  'expected_result',
  'actual_result',
  'environment_id',
  'build_version',
  'found_in_release_id',
  'fixed_in_release_id',
  'reporter_external_id',
  'external_review_state',
];

/** Records DDL while reporting every table, column, and index as absent. */
function createEmptySchemaExecutor() {
  const ddl = [];

  return {
    ddl,
    async execute(sql) {
      const normalized = sql.replace(/\s+/g, ' ').trim();

      if (normalized.includes('information_schema')) {
        return [[{ count: 0 }]];
      }

      ddl.push(normalized);
      return [{ affectedRows: 0 }];
    },
  };
}

/** Reports everything as already present, so a second run should be a no-op. */
function createPopulatedSchemaExecutor() {
  const ddl = [];

  return {
    ddl,
    async execute(sql) {
      const normalized = sql.replace(/\s+/g, ' ').trim();

      if (normalized.includes('information_schema')) {
        return [[{ count: 1 }]];
      }
      if (normalized.startsWith('SELECT name FROM tenant_environments')) {
        return [[{ name: 'Development' }, { name: 'Staging' }, { name: 'UAT' }, { name: 'Production' }]];
      }
      if (normalized.startsWith('SELECT id, name')) {
        return [[]];
      }

      ddl.push(normalized);
      return [{ affectedRows: 0 }];
    },
  };
}

test('the ticketing migration adds every ticket column and the relations table', async () => {
  const executor = createEmptySchemaExecutor();

  await ensureMysqlTicketingSchema(executor);

  for (const column of TICKET_COLUMNS) {
    assert.ok(
      executor.ddl.some((statement) => statement.startsWith(`ALTER TABLE tasks ADD COLUMN ${column} `)),
      `column ${column} is added`,
    );
  }
  assert.ok(executor.ddl.some((statement) => statement.includes('CREATE TABLE work_item_relations')));
  assert.ok(executor.ddl.some((statement) => statement.includes('idx_tasks_ticket_triage')));
  assert.ok(executor.ddl.some((statement) => statement.includes('idx_tasks_external_review')));
});

test('the relations table enforces uniqueness so repeated links cannot duplicate', async () => {
  const executor = createEmptySchemaExecutor();

  await ensureMysqlTicketingSchema(executor);

  const relations = executor.ddl.find((statement) => statement.includes('CREATE TABLE work_item_relations'));
  assert.match(relations, /UNIQUE KEY uq_work_item_relation \(from_item_id, to_item_id, relation_type\)/);
});

test('the configuration and intake migrations create their tables', async () => {
  const configExecutor = createEmptySchemaExecutor();
  await ensureMysqlTicketConfigSchema(configExecutor);
  assert.ok(configExecutor.ddl.some((statement) => statement.includes('CREATE TABLE tenant_environments')));
  assert.ok(configExecutor.ddl.some((statement) => statement.includes('CREATE TABLE tenant_releases')));

  const intakeExecutor = createEmptySchemaExecutor();
  await ensureMysqlTicketIntakeSchema(intakeExecutor);
  const intake = intakeExecutor.ddl.find((statement) => statement.includes('CREATE TABLE ticket_intake_invitations'));
  assert.ok(intake);
  assert.match(intake, /UNIQUE KEY uq_ticket_intake_token \(intake_token\)/);
  assert.match(intake, /UNIQUE KEY uq_ticket_intake_reply_token \(reply_token\)/);
});

test('re-running the migrations against a populated schema changes nothing', async () => {
  for (const migration of [ensureMysqlTicketingSchema, ensureMysqlTicketConfigSchema, ensureMysqlTicketIntakeSchema]) {
    const executor = createPopulatedSchemaExecutor();
    await migration(executor);
    assert.deepEqual(executor.ddl, [], `${migration.name} is idempotent`);
  }
});

test('the ticketing migrations are registered in order with unique ids', async () => {
  const registered = [];

  await bootstrapMysqlSchema({
    executor: { kind: 'pool' },
    runMigrations: async ({ migrations }) => {
      registered.push(...migrations.map((migration) => migration.id));
      return { applied: [], total: migrations.length };
    },
  });

  assert.equal(new Set(registered).size, registered.length, 'migration ids are unique');

  const ticketing = registered.indexOf('0047_ticketing');
  const config = registered.indexOf('0048_ticket_config_lists');
  const intake = registered.indexOf('0049_ticket_intake');

  assert.ok(ticketing > -1 && config > -1 && intake > -1, 'all three are registered');
  assert.ok(ticketing < config && config < intake, 'they run in id order');
  assert.deepEqual(registered, [...registered].sort(), 'they are appended, not inserted mid-history');
});

test('no earlier migration id was renumbered', async () => {
  const registered = [];

  await bootstrapMysqlSchema({
    executor: { kind: 'pool' },
    runMigrations: async ({ migrations }) => {
      registered.push(...migrations.map((migration) => migration.id));
      return { applied: [], total: migrations.length };
    },
  });

  // Renumbering an applied migration would fail every existing deployment on checksum.
  assert.equal(registered[0], '0001_agent_execution');
  assert.equal(registered[45], '0046_connector_oauth');
});
