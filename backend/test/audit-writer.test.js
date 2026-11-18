import assert from 'node:assert/strict';
import test from 'node:test';

import { createAuditWriter, ensureMysqlAuditLogActorSchema } from '../src/lib/audit/audit-writer.js';

function recordingExecutor() {
  const calls = [];
  return {
    calls,
    async execute(sql, params) {
      calls.push({ params, sql });
      return [{ affectedRows: 1 }];
    },
  };
}

test('audit writer appends a normalized record using INSERT only', async () => {
  const executor = recordingExecutor();
  const writer = createAuditWriter({
    executor,
    idFactory: () => 'audit-1',
  });

  const record = await writer.append({
    action: 'project.plan.updated',
    detail: { changedFields: ['name'] },
    ipAddress: '127.0.0.1',
    projectId: 'project-1',
    result: 'success',
    tenantId: 'tenant-1',
    userId: 'user-1',
  });

  assert.equal(executor.calls.length, 1);
  assert.match(executor.calls[0].sql, /^\s*INSERT INTO audit_log/);
  assert.doesNotMatch(executor.calls[0].sql, /UPDATE|DELETE/i);
  assert.deepEqual(executor.calls[0].params, [
    'audit-1',
    'user-1',
    'tenant-1',
    'project-1',
    '127.0.0.1',
    'project.plan.updated',
    'success',
    JSON.stringify({ changedFields: ['name'] }),
  ]);
  assert.equal(Object.isFrozen(record), true);
});

test('audit writer joins the caller transaction when an executor is supplied', async () => {
  const pool = recordingExecutor();
  const transaction = recordingExecutor();
  const writer = createAuditWriter({ executor: pool, idFactory: () => 'audit-2' });

  await writer.append({
    action: 'project.tree.replaced',
    ipAddress: '127.0.0.1',
    result: 'success',
    userId: 'user-1',
  }, { executor: transaction });

  assert.equal(pool.calls.length, 0);
  assert.equal(transaction.calls.length, 1);
});

test('audit writer records OAuth application actors whose ids exceed a UUID', async () => {
  const executor = recordingExecutor();
  const writer = createAuditWriter({ executor, idFactory: () => 'audit-3' });
  const userId = 'oauth-application:849be5e2-4608-478f-a290-af11a60f660a';

  await writer.append({ action: 'http.put./tickets', ipAddress: '127.0.0.1', result: 'success:200', userId });

  assert.equal(executor.calls[0].params[1], userId);
  await assert.rejects(
    writer.append({ action: 'http.put./tickets', ipAddress: '127.0.0.1', result: 'success:200', userId: 'x'.repeat(256) }),
    /userId must not exceed 255 characters/,
  );
});

test('the audit actor migration drops the user foreign key and widens the column once', async () => {
  const statements = [];
  const executorFor = ({ foreignKeys, maxLength }) => ({
    async execute(sql) {
      statements.push(sql.trim());
      if (sql.includes('information_schema.KEY_COLUMN_USAGE')) return [foreignKeys.map((name) => ({ name }))];
      if (sql.includes('information_schema.COLUMNS')) return [[{ maxLength }]];
      return [{ affectedRows: 0 }];
    },
  });

  await ensureMysqlAuditLogActorSchema(executorFor({ foreignKeys: ['audit_log_ibfk_1'], maxLength: 36 }));
  const changes = statements.filter((sql) => sql.startsWith('ALTER TABLE'));
  assert.deepEqual(changes, [
    'ALTER TABLE audit_log DROP FOREIGN KEY `audit_log_ibfk_1`',
    'ALTER TABLE audit_log MODIFY COLUMN user_id VARCHAR(255) NOT NULL',
  ]);

  statements.length = 0;
  await ensureMysqlAuditLogActorSchema(executorFor({ foreignKeys: [], maxLength: 255 }));
  assert.equal(statements.filter((sql) => sql.startsWith('ALTER TABLE')).length, 0);
});

test('audit writer rejects incomplete events before touching storage', async () => {
  const executor = recordingExecutor();
  const writer = createAuditWriter({ executor });

  await assert.rejects(
    writer.append({ action: '', ipAddress: '127.0.0.1', result: 'success', userId: 'user-1' }),
    /action is required/,
  );
  assert.equal(executor.calls.length, 0);
});
