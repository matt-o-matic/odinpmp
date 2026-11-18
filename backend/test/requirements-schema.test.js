import assert from 'node:assert/strict';
import test from 'node:test';

import { bootstrapMysqlSchema } from '../src/jobs/bootstrap-schema.lib.js';
import {
  backfillMysqlClarificationTopics,
  ensureMysqlRequirementsDecisionsSchema,
  ensureMysqlRequirementsLinksSchema,
  ensureMysqlRequirementsTracksSchema,
  ensureMysqlReviewFeedbackSchema,
  ensureMysqlReviewPackagesSchema,
  ensureMysqlReviewRoundsSchema,
} from '../src/modules/requirements/requirements.repository.js';
import { ensureMysqlReviewPackageReplacementSchema, ensureMysqlReviewPackageStorageSchema } from '../src/modules/requirements/packages/packages.repository.js';
import { ensureMysqlReviewRoundDetailsSchema } from '../src/modules/requirements/rounds/rounds.repository.js';
import { ensureMysqlRequirementsPlanDetailsSchema } from '../src/modules/requirements/plans/plans.repository.js';

function createRecordingExecutor({ present }) {
  const ddl = [];
  return {
    ddl,
    async execute(sql) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (normalized.includes('information_schema')) return [[{ count: present ? 1 : 0 }]];
      ddl.push(normalized);
      return [{ affectedRows: 0 }];
    },
  };
}

const STEPS = [
  ensureMysqlRequirementsTracksSchema,
  ensureMysqlRequirementsLinksSchema,
  ensureMysqlReviewPackagesSchema,
  ensureMysqlReviewRoundsSchema,
  ensureMysqlReviewFeedbackSchema,
  ensureMysqlRequirementsDecisionsSchema,
  ensureMysqlReviewPackageStorageSchema,
  ensureMysqlReviewRoundDetailsSchema,
  ensureMysqlRequirementsPlanDetailsSchema,
  backfillMysqlClarificationTopics,
  ensureMysqlReviewPackageReplacementSchema,
];

// Main reserved 0051-0057 for this feature and shipped 0058-0060 meanwhile, so the last two
// requirements migrations follow main's.
const REQUIREMENTS_MIGRATION_IDS = [
  '0051_requirements_tracks',
  '0052_requirements_links',
  '0053_review_packages',
  '0054_review_rounds',
  '0055_review_feedback',
  '0056_requirements_decisions',
  '0057_review_package_storage',
  '0061_review_round_details',
  '0062_requirements_plan_details',
  '0063_clarification_topics_backfill',
  '0064_review_package_replacement',
];

test('migrations 0051-0057 and 0061-0064 are registered in order around 0058-0060 from main', async () => {
  let registered = [];
  await bootstrapMysqlSchema({
    executor: {},
    runMigrations: async ({ migrations }) => {
      registered = migrations;
      return { applied: [], total: migrations.length };
    },
  });
  // Later migrations follow 0064; only this range is checked here.
  assert.ok(registered.length >= 64);
  assert.equal(registered[49].id, '0050_project_item_percent_complete');
  assert.deepEqual(registered.slice(50, 64).map((migration) => migration.id), [
    ...REQUIREMENTS_MIGRATION_IDS.slice(0, 7),
    '0058_project_item_actual_hours',
    '0059_audit_log_actor_length',
    '0060_project_item_estimate_override',
    ...REQUIREMENTS_MIGRATION_IDS.slice(7),
  ]);
  const requirements = registered.filter((migration) => REQUIREMENTS_MIGRATION_IDS.includes(migration.id));
  assert.deepEqual(requirements.map((migration) => migration.up), STEPS);
});

test('0051 adds track, origin, creator, brief source, and owner role to clarifications without editing 0003', async () => {
  const executor = createRecordingExecutor({ present: false });
  await ensureMysqlRequirementsTracksSchema(executor);
  assert.deepEqual(executor.ddl, [
    'ALTER TABLE project_clarifications ADD COLUMN track VARCHAR(16) NULL',
    'ALTER TABLE project_clarifications ADD COLUMN topic_origin VARCHAR(16) NULL',
    'ALTER TABLE project_clarifications ADD COLUMN created_by VARCHAR(80) NULL',
    'ALTER TABLE project_clarifications ADD COLUMN source_ref VARCHAR(160) NULL',
    'ALTER TABLE project_clarifications ADD COLUMN suggested_owner_role VARCHAR(120) NULL',
    'CREATE INDEX idx_project_clarifications_track ON project_clarifications (tenant_id, project_id, track)',
  ]);
});

test('0052-0056 create every requirements table, and a second run is a no-op', async () => {
  const fresh = createRecordingExecutor({ present: false });
  for (const step of STEPS.slice(1, 6)) await step(fresh);
  const created = fresh.ddl.map((statement) => /^CREATE TABLE (\w+)/.exec(statement)?.[1]).filter(Boolean);
  assert.deepEqual(created, [
    'requirements_access_links',
    'requirements_access_link_tokens',
    'review_packages',
    'review_package_screens',
    'review_rounds',
    'review_round_reviewers',
    'review_annotations',
    'review_comments',
    'review_verdicts',
    'review_answers',
    'requirements_decisions',
    'requirements_summaries',
    'requirements_plans',
  ]);

  const links = fresh.ddl.find((statement) => statement.startsWith('CREATE TABLE requirements_access_links '));
  assert.match(links, /UNIQUE KEY uq_requirements_access_links_stakeholder \(tenant_id, project_id, stakeholder_id\)/);
  assert.doesNotMatch(links, /token/, 'the link row carries no token');
  const tokens = fresh.ddl.find((statement) => statement.startsWith('CREATE TABLE requirements_access_link_tokens'));
  assert.match(tokens, /token_hash CHAR\(64\) NOT NULL/);
  assert.match(tokens, /UNIQUE KEY uq_requirements_access_link_tokens_hash \(token_hash\)/);
  for (const column of ['link_id VARCHAR(36) NOT NULL', 'purpose VARCHAR(16) NOT NULL', 'last_used_at DATETIME(3) NULL', 'revoked_at DATETIME(3) NULL']) {
    assert.ok(tokens.includes(column), column);
  }
  assert.doesNotMatch(tokens, /\btoken VARCHAR/, 'only the hash is stored');
  const decisions = fresh.ddl.find((statement) => statement.startsWith('CREATE TABLE requirements_decisions'));
  for (const column of ['decided_by VARCHAR(80) NOT NULL', 'supersedes_id', 'superseded_by_id', 'source_summary_id', 'version INT NOT NULL DEFAULT 1', 'sources_json JSON NOT NULL']) {
    assert.ok(decisions.includes(column), column);
  }
  assert.equal(/\bai_|drafted/i.test(decisions), false, 'decisions carry no AI flag (Q-14)');

  // 0063 is a data backfill: its UPDATE runs every time and matches nothing once applied.
  const populated = createRecordingExecutor({ present: true });
  for (const step of STEPS.filter((item) => item !== backfillMysqlClarificationTopics)) await step(populated);
  assert.deepEqual(populated.ddl, []);
});

test('0063 makes every clarification without a track an Experience topic and leaves tracked topics alone', async () => {
  const executor = createRecordingExecutor({ present: true });
  await backfillMysqlClarificationTopics(executor);
  assert.equal(executor.ddl.length, 1);
  assert.match(executor.ddl[0], /^UPDATE project_clarifications SET track = 'experience', topic_origin = COALESCE\(topic_origin, 'clarification'\) WHERE track IS NULL$/);
});

test('0064 lets an upload URL name the draft it replaces, once', async () => {
  const fresh = createRecordingExecutor({ present: false });
  await ensureMysqlReviewPackageReplacementSchema(fresh);
  assert.deepEqual(fresh.ddl, ['ALTER TABLE review_package_uploads ADD COLUMN replaces_package_id VARCHAR(36) NULL']);
  const applied = createRecordingExecutor({ present: true });
  await ensureMysqlReviewPackageReplacementSchema(applied);
  assert.deepEqual(applied.ddl, []);
});
