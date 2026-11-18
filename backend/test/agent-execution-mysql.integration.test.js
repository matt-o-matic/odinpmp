import assert from 'node:assert/strict';
import test from 'node:test';

import mysql from 'mysql2/promise';

import { createMysqlAgentExecutionRepository } from '../src/modules/assistant/agent-execution.repository.js';
import { applyMysqlMigrations } from './helpers/mysql-migrations.js';

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();
const MIGRATIONS = ['0001_agent_execution', '0009_agent_goal_automation', '0010_agent_goal_notifications', '0077_agent_monitor_editor'];

test('MySQL durable execution atomically claims, budgets, and traces a run', {
  skip: !databaseUrl,
  timeout: 10_000,
}, async () => {
  const pool = mysql.createPool(databaseUrl);
  try {
    await applyMysqlMigrations(pool, MIGRATIONS);
    const repository = createMysqlAgentExecutionRepository({ pool });
    const { run } = await repository.enqueueRun({
      budgets: { costUsd: 0.01, inputTokens: 100, outputTokens: 50, toolCalls: 2, wallClockMs: 1_000 },
      idempotencyKey: `integration:${process.env.ODIN_TEST_RUN_ID}`,
      payload: { prompt: 'integration' },
      tenantId: 'integration-tenant',
    });
    const claims = await Promise.all([
      repository.claimRun({ leaseMs: 1_000, runId: run.id, workerId: 'worker-a' }),
      repository.claimRun({ leaseMs: 1_000, runId: run.id, workerId: 'worker-b' }),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    const claimed = claims.find(Boolean);
    await repository.consumeRunUsage({ runId: run.id, usage: { costUsd: 0.005, inputTokens: 80, toolCalls: 1 } });
    await assert.rejects(
      repository.consumeRunUsage({ runId: run.id, usage: { inputTokens: 21 } }),
      (error) => error.code === 'agent_run_budget_exceeded',
    );
    await repository.recordTrace({
      costUsd: 0.005, idempotencyKey: 'response-1', inputTokens: 80,
      model: 'gpt-5.4-nano', requestId: 'response-1', runId: run.id,
    });
    assert.equal((await repository.listTraces(run.id)).length, 1);
    const completed = await repository.completeRun({
      leaseToken: claimed.leaseToken, output: { ok: true }, runId: run.id, workerId: claimed.leaseWorkerId,
    });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.usage.inputTokens, 80);
  } finally {
    await pool.end();
  }
});

test('MySQL agent goals and monitors persist versions, due schedules, and run history', {
  skip: !databaseUrl,
  timeout: 10_000,
}, async () => {
  const pool = mysql.createPool(databaseUrl);
  try {
    await applyMysqlMigrations(pool, MIGRATIONS);
    const repository = createMysqlAgentExecutionRepository({ pool });
    const goal = await repository.createGoal({ ownerUserId: 'owner-1', projectId: 'project-1', tenantId: 'goal-tenant', title: 'Protect launch' });
    assert.equal(goal.version, 1);
    const updatedGoal = await repository.updateGoal({ expectedVersion: 1, goalId: goal.id, patch: { status: 'paused' }, tenantId: 'goal-tenant' });
    assert.equal(updatedGoal.version, 2);
    await assert.rejects(
      repository.updateGoal({ expectedVersion: 1, goalId: goal.id, patch: { status: 'active' }, tenantId: 'goal-tenant' }),
      (error) => error.code === 'agent_goal_version_conflict' && error.actualVersion === 2,
    );
    const monitor = await repository.createMonitor({
      goalId: goal.id,
      input: { intervalMinutes: 15, nextRunAt: new Date('2030-01-01T12:00:00Z'), payload: { sessionId: 'session-1' }, title: 'Schedule health', triggerType: 'schedule' },
      ownerUserId: 'owner-1', projectId: 'project-1', tenantId: 'goal-tenant',
    });
    assert.equal(monitor.version, 1);
    assert.equal((await repository.listDueMonitors({ now: new Date('2030-01-01T12:00:00Z') })).some((item) => item.id === monitor.id), true);
    const fired = await repository.markMonitorFired({ monitorId: monitor.id, nextRunAt: new Date('2030-01-01T12:15:00Z'), now: new Date('2030-01-01T12:00:00Z'), scheduledFor: new Date('2030-01-01T12:00:00Z'), tenantId: 'goal-tenant' });
    assert.equal(fired.runCount, 1);
    assert.equal(fired.version, 2);
    assert.equal(monitor.updatedByUserId, 'owner-1');
    const disabled = await repository.updateMonitor({ expectedVersion: 2, monitorId: monitor.id, patch: { enabled: false }, tenantId: 'goal-tenant' });
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.updatedByUserId, 'owner-1', 'an update naming no one keeps who set it up');
    const edited = await repository.updateMonitor({ expectedVersion: 3, monitorId: monitor.id, patch: { title: 'Schedule health, edited' }, tenantId: 'goal-tenant', updatedByUserId: 'editor-1' });
    assert.equal(edited.updatedByUserId, 'editor-1');
    const run = await repository.enqueueRun({ goalId: goal.id, idempotencyKey: `goal-integration:${process.env.ODIN_TEST_RUN_ID}`, payload: {}, projectId: 'project-1', tenantId: 'goal-tenant' });
    assert.equal((await repository.listRuns({ goalId: goal.id, tenantId: 'goal-tenant' }))[0].id, run.run.id);
    const attention = await repository.createNotification({ dedupeKey: `goal-attention:${process.env.ODIN_TEST_RUN_ID}`, evidence: { failedCheckIds: ['schedule.no_cycles'] }, goalId: goal.id, kind: 'verifier_failed', message: 'Schedule check failed.', monitorId: monitor.id, ownerUserId: 'owner-1', projectId: 'project-1', severity: 'warning', tenantId: 'goal-tenant', title: 'Goal needs attention' });
    assert.equal(attention.created, true);
    const duplicateAttention = await repository.createNotification({ dedupeKey: `goal-attention:${process.env.ODIN_TEST_RUN_ID}`, goalId: goal.id, kind: 'verifier_failed', message: 'Duplicate.', ownerUserId: 'owner-1', tenantId: 'goal-tenant', title: 'Duplicate' });
    assert.equal(duplicateAttention.created, false);
    const readAttention = await repository.updateNotification({ expectedVersion: 1, notificationId: attention.notification.id, patch: { status: 'read' }, tenantId: 'goal-tenant' });
    assert.equal(readAttention.status, 'read');
  } finally {
    await pool.end();
  }
});
