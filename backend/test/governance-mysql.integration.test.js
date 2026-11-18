import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import mysql from 'mysql2/promise';

import { createMysqlGovernanceRepository } from '../src/modules/governance/governance.repository.js';
import { applyMysqlMigrations } from './helpers/mysql-migrations.js';

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();

test('MySQL governance repository persists versioned records and rejects stale writes', { skip: !databaseUrl, timeout: 10_000 }, async () => {
  const parsed = databaseUrl ? new URL(databaseUrl) : null;
  const database = `${decodeURIComponent(parsed.pathname.slice(1)).slice(0, 34)}_governance_${randomUUID().slice(0, 8)}`;
  const connectionOptions = { host: parsed.hostname, password: decodeURIComponent(parsed.password), port: Number(parsed.port || 3306), user: decodeURIComponent(parsed.username) };
  const admin = await mysql.createConnection(connectionOptions);
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const isolatedUrl = new URL(databaseUrl); isolatedUrl.pathname = `/${database}`;
  const pool = mysql.createPool(isolatedUrl.toString());
  try {
    await applyMysqlMigrations(pool, ['0008_governance', '0025_schedule_controls']);
    const repository = createMysqlGovernanceRepository({ pool });
    const item = await repository.createItem({
      input: { description: '', dueDate: null, impact: 'high', kind: 'risk', ownerId: null, probability: 'high', responsePlan: '', status: 'open', title: 'Capacity risk' },
      projectId: 'project-1', tenantId: 'tenant-1',
    });
    assert.equal(item.version, 1);
    const updated = await repository.updateItem({ input: { expectedVersion: 1, status: 'monitoring' }, itemId: item.id, projectId: 'project-1', tenantId: 'tenant-1' });
    assert.equal(updated.version, 2);
    await assert.rejects(
      repository.updateItem({ input: { expectedVersion: 1, status: 'resolved' }, itemId: item.id, projectId: 'project-1', tenantId: 'tenant-1' }),
      (error) => error.statusCode === 409 && error.details.code === 'governance_version_conflict',
    );
    const dependency = await repository.createDependency({ input: { dependencyType: 'FS', lagDays: 0, predecessorId: 'task-1', successorId: 'task-2' }, projectId: 'project-1', tenantId: 'tenant-1' });
    const updatedDependency = await repository.updateDependency({
      dependencyId: dependency.id,
      input: { dependencyType: 'SS', expectedVersion: 1, lagDays: 2, predecessorId: 'task-1', successorId: 'task-2' },
      projectId: 'project-1', tenantId: 'tenant-1',
    });
    assert.equal(updatedDependency.version, 2);
    assert.equal(updatedDependency.dependencyType, 'SS');
    await assert.rejects(
      repository.updateDependency({
        dependencyId: dependency.id,
        input: { dependencyType: 'FS', expectedVersion: 1, lagDays: 0, predecessorId: 'task-1', successorId: 'task-2' },
        projectId: 'project-1', tenantId: 'tenant-1',
      }),
      (error) => error.statusCode === 409 && error.details.code === 'governance_version_conflict',
    );
    await repository.createMilestone({ input: { status: 'planned', targetDate: '2026-07-31', title: 'Launch', workItemId: null }, projectId: 'project-1', tenantId: 'tenant-1' });
    const calendar = await repository.putWorkingCalendar({
      input: { expectedVersion: null, holidays: ['2026-07-03'], hoursPerDay: 7.5, timezone: 'America/New_York', workingDays: [1, 2, 3, 4, 5] },
      projectId: 'project-1', tenantId: 'tenant-1',
    });
    assert.equal(calendar.version, 1);
    assert.equal(calendar.hoursPerDay, 7.5);
    const updatedCalendar = await repository.putWorkingCalendar({
      input: { expectedVersion: 1, holidays: ['2026-07-03', '2026-11-26'], hoursPerDay: 8, timezone: 'America/New_York', workingDays: [1, 2, 3, 4, 5] },
      projectId: 'project-1', tenantId: 'tenant-1',
    });
    assert.equal(updatedCalendar.version, 2);
    await assert.rejects(
      repository.putWorkingCalendar({ input: { expectedVersion: 1, holidays: [], hoursPerDay: 8, timezone: 'UTC', workingDays: [1, 2, 3, 4, 5] }, projectId: 'project-1', tenantId: 'tenant-1' }),
      (error) => error.statusCode === 409 && error.details.code === 'governance_version_conflict',
    );
    const baseline = await repository.createScheduleBaseline({
      createdBy: 'user-1', input: { name: 'Approved plan', note: 'Board approved.' }, projectId: 'project-1',
      snapshot: { capturedSchema: 'schedule-baseline.v1', project: { endDate: '2026-07-31' } }, tenantId: 'tenant-1',
    });
    assert.equal(baseline.snapshot.capturedSchema, 'schedule-baseline.v1');
    const snapshot = await repository.listSnapshot({ projectId: 'project-1', tenantId: 'tenant-1' });
    assert.deepEqual([snapshot.items.length, snapshot.dependencies.length, snapshot.milestones.length], [1, 1, 1]);
    assert.equal(snapshot.workingCalendar.version, 2);
    assert.equal(snapshot.scheduleBaselines[0].name, 'Approved plan');
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end();
  }
});
