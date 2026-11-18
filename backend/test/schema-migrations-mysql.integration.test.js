import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import mysql from 'mysql2/promise';

import { bootstrapMysqlSchema } from '../src/jobs/bootstrap-schema.lib.js';

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();

test('MySQL legacy base plus versioned migrations reconstructs the enterprise extension schema exactly once', { skip: !databaseUrl, timeout: 600_000 }, async () => {
  const parsed = databaseUrl ? new URL(databaseUrl) : null;
  const database = `${decodeURIComponent(parsed.pathname.slice(1)).slice(0, 38)}_migration_${process.pid}`;
  const connectionOptions = { host: parsed.hostname, password: decodeURIComponent(parsed.password), port: Number(parsed.port || 3306), user: decodeURIComponent(parsed.username) };
  const admin = await mysql.createConnection(connectionOptions);
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const importer = await mysql.createConnection({ ...connectionOptions, database, multipleStatements: true });
  const isolatedUrl = new URL(databaseUrl); isolatedUrl.pathname = `/${database}`;
  const pool = mysql.createPool(isolatedUrl.toString());
  try {
    const legacyBaseSchema = await readFile(new URL('../db/base-schema.sql', import.meta.url), 'utf8');
    await importer.query(legacyBaseSchema);
    const first = await bootstrapMysqlSchema({ executor: pool });
    const second = await bootstrapMysqlSchema({ executor: pool });
    assert.equal(first.applied.includes('0009_agent_goal_automation'), true);
    assert.deepEqual(second.applied, []);
    const [migrations] = await pool.execute('SELECT id FROM schema_migrations ORDER BY id');
    assert.equal(migrations.length, first.total, 'every registered migration is recorded once');
    const [columns] = await pool.execute(`SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'agent_goals' AND column_name = 'version'`);
    assert.equal(columns.length, 1);
    const [tables] = await pool.execute(`SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'agent_goal_monitors'`);
    assert.equal(tables.length, 1);
    const [notificationTables] = await pool.execute(`SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'agent_goal_notifications'`);
    assert.equal(notificationTables.length, 1);
    const [memoryTables] = await pool.execute(`SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'agent_memory_items'`);
    assert.equal(memoryTables.length, 1);
    const [outboxTables] = await pool.execute(`SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'domain_event_outbox'`);
    assert.equal(outboxTables.length, 1);
    const [retentionColumns] = await pool.execute(`SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'agent_memory_items' AND column_name IN ('expires_at', 'legal_hold', 'retention_policy_id')`);
    assert.equal(retentionColumns.length, 3);
    const [semanticMemoryColumns] = await pool.execute(`SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'agent_memory_items' AND column_name IN ('embedding_model', 'embedding_dimensions', 'embedding_vector_json', 'embedding_content_hash', 'embedded_at')`);
    assert.equal(semanticMemoryColumns.length, 5);
    const [portfolioTables] = await pool.execute(`SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('portfolio_nodes', 'strategy_objectives', 'portfolio_project_alignments')`);
    assert.equal(portfolioTables.length, 3);
    const [portfolioPlanningTables] = await pool.execute(`SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('portfolio_scenario_plans', 'portfolio_baselines')`);
    assert.equal(portfolioPlanningTables.length, 2);
    const [portfolioPlanningColumns] = await pool.execute(`SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'portfolio_project_alignments' AND column_name IN ('requested_funding', 'funding_currency', 'requested_hours')`);
    assert.equal(portfolioPlanningColumns.length, 3);
    const [resourceFinanceTables] = await pool.execute(`SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('resource_pools', 'enterprise_resources', 'resource_calendar_entries', 'resource_allocations', 'project_financial_entries', 'project_time_entries', 'project_expense_entries')`);
    assert.equal(resourceFinanceTables.length, 7);
    const [advancedResourceFinanceTables] = await pool.execute(`SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('resource_rate_history', 'timesheet_periods', 'expense_receipts', 'currency_exchange_rates')`);
    assert.equal(advancedResourceFinanceTables.length, 4);
    const [timesheetPeriodColumns] = await pool.execute(`SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'project_time_entries' AND column_name = 'period_id'`);
    assert.equal(timesheetPeriodColumns.length, 1);
    const [resourceCalendarColumns] = await pool.execute(`SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'resource_calendar_entries' AND column_name IN ('weekdays_json', 'timezone')`);
    assert.equal(resourceCalendarColumns.length, 2);
    const [resourceFinanceControlTables] = await pool.execute(`SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('accounting_periods', 'finance_control_policies')`);
    assert.equal(resourceFinanceControlTables.length, 2);
    const [workflowTables] = await pool.execute(`SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('workflow_definitions', 'project_workflow_bindings', 'workflow_transition_approvals', 'workflow_transition_history', 'project_baselines', 'project_templates', 'custom_field_definitions', 'custom_field_values')`);
    assert.equal(workflowTables.length, 8);
    const [reportingTables] = await pool.execute(`SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('search_documents', 'saved_views', 'report_definitions', 'report_subscriptions', 'report_runs', 'report_snapshots')`);
    assert.equal(reportingTables.length, 6);
    const [warehouseTables] = await pool.execute(`SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('reporting_cdc_events', 'reporting_metric_facts', 'reporting_cache_entries', 'report_subscription_leases')`);
    assert.equal(warehouseTables.length, 4);
    const [semanticSearchColumns] = await pool.execute(`SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'search_documents' AND column_name IN ('source_hash', 'index_generation', 'embedding_model', 'embedding_dimensions', 'embedding_vector_json', 'embedding_content_hash', 'embedded_at')`);
    assert.equal(semanticSearchColumns.length, 7);
    const [identityTables] = await pool.execute(`SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('tenant_identity_policies', 'tenant_verified_domains', 'tenant_custom_roles', 'identity_groups', 'identity_group_memberships', 'access_reviews', 'access_review_items', 'service_accounts', 'service_account_credentials', 'impersonation_grants', 'identity_oidc_transactions')`);
    assert.equal(identityTables.length, 11);
    const [platformTables] = await pool.execute(`SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('platform_oauth_applications', 'platform_oauth_tokens', 'webhook_subscriptions', 'webhook_deliveries')`);
    assert.equal(platformTables.length, 4);
    const [platformIdempotencyTables] = await pool.execute(`SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'api_idempotency_records'`);
    assert.equal(platformIdempotencyTables.length, 1);
    const [platformDelegationTables] = await pool.execute(`SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'platform_oauth_authorization_codes'`);
    assert.equal(platformDelegationTables.length, 1);
    const [platformDelegationColumns] = await pool.execute(`SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND ((table_name = 'platform_oauth_applications' AND column_name = 'redirect_uris_json') OR (table_name = 'platform_oauth_tokens' AND column_name IN ('grant_type', 'user_id')))`);
    assert.equal(platformDelegationColumns.length, 3);
    const [liveEventTables] = await pool.execute(`SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'shared_live_events'`);
    assert.equal(liveEventTables.length, 1);
    const [projectItemVersionColumns] = await pool.execute(`SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'tasks' AND column_name = 'version'`);
    assert.equal(projectItemVersionColumns.length, 1);
    const [projectItemRevisionTables] = await pool.execute(`SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'project_item_revisions'`);
    assert.equal(projectItemRevisionTables.length, 1);
    const [scheduleControlTables] = await pool.execute(`SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('project_working_calendars', 'project_schedule_baselines')`);
    assert.equal(scheduleControlTables.length, 2);
    const [workflowAutomationColumns] = await pool.execute(`SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'workflow_transition_history' AND column_name IN ('transition_event_enqueued_at', 'sla_event_enqueued_at')`);
    assert.equal(workflowAutomationColumns.length, 2);
    const [workflowSequenceColumns] = await pool.execute(`SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'workflow_transition_history' AND column_name = 'sequence_id'`);
    assert.equal(workflowSequenceColumns.length, 1);
    const [connectorTables] = await pool.execute(`SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('connector_connections', 'connector_mappings', 'connector_conflicts', 'connector_inbound_events', 'connector_sync_runs')`);
    assert.equal(connectorTables.length, 5);
    const [connectorObjectTables] = await pool.execute(`SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'connector_objects'`);
    assert.equal(connectorObjectTables.length, 1);
    const [connectorLeaseColumns] = await pool.execute(`SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'connector_inbound_events' AND column_name IN ('available_at', 'lease_worker_id', 'lease_token', 'lease_expires_at')`);
    assert.equal(connectorLeaseColumns.length, 4);
    const [connectorSyncLeaseColumns] = await pool.execute(`SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'connector_sync_runs' AND column_name IN ('attempts', 'available_at', 'lease_worker_id', 'lease_token', 'lease_expires_at')`);
    assert.equal(connectorSyncLeaseColumns.length, 5);
    const [connectorMarketplaceTables] = await pool.execute(`SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'connector_provider_policies'`);
    assert.equal(connectorMarketplaceTables.length, 1);
    const [connectorErpPostingTables] = await pool.execute(`SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'connector_erp_postings'`);
    assert.equal(connectorErpPostingTables.length, 1);
    const [complianceGovernanceTables] = await pool.execute(`SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('compliance_legal_holds', 'compliance_control_attestations')`);
    assert.equal(complianceGovernanceTables.length, 2);
    const [connectorErasureTables] = await pool.execute(`SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'connector_provider_erasure_jobs'`);
    assert.equal(connectorErasureTables.length, 1);
    const [connectorOAuthTables] = await pool.execute(`SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('connector_oauth_transactions', 'connector_oauth_credentials')`);
    assert.equal(connectorOAuthTables.length, 2);
    const [connectorApprovalColumns] = await pool.execute(`SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'connector_connections' AND column_name IN ('approved_by', 'approved_at')`);
    assert.equal(connectorApprovalColumns.length, 2);
    const [complianceTables] = await pool.execute(`SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('tenant_compliance_policies', 'compliance_evidence_exports')`);
    assert.equal(complianceTables.length, 2);
    const [complianceTriggers] = await pool.execute(`SELECT trigger_name FROM information_schema.triggers WHERE trigger_schema = DATABASE() AND trigger_name IN ('compliance_exports_no_update', 'compliance_exports_no_delete')`);
    assert.equal(complianceTriggers.length, 2);
    const [privacyTables] = await pool.execute(`SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'privacy_erasure_requests'`);
    assert.equal(privacyTables.length, 1);
    const [authenticationMethods] = await pool.execute('SELECT id, name FROM authentication_methods ORDER BY id');
    assert.deepEqual(authenticationMethods.map((row) => [row.id, row.name]), [[1, 'basic'], [2, 'google']]);
    const [runtimeTables] = await pool.execute(`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('pending_registrations', 'mcp_oauth_clients', 'mcp_oauth_codes', 'mcp_oauth_families', 'mcp_oauth_tokens', 'bug_reporter_mail_deliveries', 'bug_reporter_reply_tokens', 'bug_reporter_replies', 'bug_reporter_reply_files') ORDER BY table_name`);
    assert.equal(runtimeTables.length, 9, 'tables request code used to create on first use come from migrations 0085, 0086, 0088 and 0089');
    const [resourceLinkColumns] = await pool.execute(`SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND ((table_name = 'enterprise_resources' AND column_name = 'min_bill_rate') OR (table_name = 'resource_allocations' AND column_name IN ('bill_rate', 'origin')))`);
    assert.equal(resourceLinkColumns.length, 3);
    const [mailTargetColumns] = await pool.execute(`SELECT CHARACTER_MAXIMUM_LENGTH AS maxLength FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'mail_queue' AND column_name = 'mail_target_id'`);
    assert.equal(Number(mailTargetColumns[0].maxLength), 128);
    const [replyTemplates] = await pool.execute("SELECT id FROM mail_templates WHERE id = 'bug-reporter-reply-not-added-v1'");
    assert.equal(replyTemplates.length, 1);
  } finally {
    await importer.end(); await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``); await admin.end();
  }
});

// Production's state on 2026-10-12: 0001-0049 recorded from a Windows checkout (CRLF
// checksums), 0003, 0004 and 0024 edited since they ran, and the newest migration not yet
// applied. A plain run re-records the line-ending-only rows and stops at the first real
// edit; a reconcile run re-applies the edited ones and applies the new one.
test('MySQL migration runner accepts CRLF-era checksums and reconciles edited migrations on request', { skip: !databaseUrl, timeout: 120_000 }, async () => {
  const { legacyCrlfChecksum, migrationChecksum } = await import('../src/lib/database/schema-migrations.js');
  const parsed = new URL(databaseUrl);
  const database = `${decodeURIComponent(parsed.pathname.slice(1)).slice(0, 38)}_reconcile_${process.pid}`;
  const connectionOptions = { host: parsed.hostname, password: decodeURIComponent(parsed.password), port: Number(parsed.port || 3306), user: decodeURIComponent(parsed.username) };
  const admin = await mysql.createConnection(connectionOptions);
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const importer = await mysql.createConnection({ ...connectionOptions, database, multipleStatements: true });
  const isolatedUrl = new URL(databaseUrl); isolatedUrl.pathname = `/${database}`;
  const pool = mysql.createPool(isolatedUrl.toString());
  try {
    await importer.query(await readFile(new URL('../db/base-schema.sql', import.meta.url), 'utf8'));
    await bootstrapMysqlSchema({ executor: pool });
    let migrations;
    await bootstrapMysqlSchema({ executor: pool, runMigrations: async (options) => { migrations = options.migrations; return {}; } });
    const edited = ['0003_clarifications', '0004_project_planning', '0024_project_item_versioning'];
    const newest = migrations.at(-1);
    for (const migration of migrations.filter((entry) => entry.id < '0050')) {
      const checksum = edited.includes(migration.id) ? 'e'.repeat(64) : legacyCrlfChecksum(migration);
      await pool.execute('UPDATE schema_migrations SET checksum = ? WHERE id = ?', [checksum, migration.id]);
    }
    await pool.execute('DELETE FROM schema_migrations WHERE id = ?', [newest.id]);

    await assert.rejects(bootstrapMysqlSchema({ executor: pool }), (error) => error.code === 'schema_migration_checksum_mismatch' && error.migrationId === '0003_clarifications');
    const reconciled = await bootstrapMysqlSchema({ executor: pool, reconcile: true });
    assert.deepEqual(reconciled.reconciled, edited);
    assert.equal(reconciled.restamped.length, 46 - 2, '46 rows differ only in line endings; the plain run re-recorded 0001 and 0002 before stopping at 0003');
    assert.deepEqual(reconciled.applied, [newest.id]);

    const again = await bootstrapMysqlSchema({ executor: pool });
    assert.deepEqual(again, { applied: [], total: migrations.length }, 'nothing is left to apply or re-record');
    const [rows] = await pool.query('SELECT id, checksum FROM schema_migrations ORDER BY id');
    const byId = new Map(migrations.map((migration) => [migration.id, migration]));
    assert.equal(rows.length, migrations.length);
    assert.ok(rows.every((row) => row.checksum === migrationChecksum(byId.get(row.id))));
  } finally {
    await importer.end(); await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``); await admin.end();
  }
});
