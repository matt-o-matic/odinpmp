import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

import { bootstrapMysqlSchema } from '../../backend/src/jobs/bootstrap-schema.lib.js';
import { createMysqlDomainEventOutboxRepository } from '../../backend/src/lib/events/domain-event-outbox.js';
import { createMysqlPlatformRepository } from '../../backend/src/modules/platform/platform.repository.js';

const require = createRequire(new URL('../../backend/package.json', import.meta.url));
const mysql = require('mysql2/promise');

function run(command, args, { env, input = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] }); const stdout = []; const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk)); child.stderr.on('data', (chunk) => stderr.push(chunk)); child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(Buffer.concat(stdout)) : reject(new Error(`${command} failed (${code}): ${Buffer.concat(stderr).toString('utf8').slice(-2000)}`)));
    if (input) child.stdin.end(input); else child.stdin.end();
  });
}

const configured = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();
if (!configured) throw new Error('backup/restore smoke requires ODIN_TEST_DATABASE_URL.');
const parsed = new URL(configured); if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) throw new Error('backup/restore smoke only permits local MySQL.');
const prefix = decodeURIComponent(parsed.pathname.slice(1)).replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 32); const suffix = createHash('sha256').update(`${process.pid}:${Date.now()}`).digest('hex').slice(0, 8); const sourceDb = `${prefix}_dr_source_${suffix}`; const restoreDb = `${prefix}_dr_restore_${suffix}`;
const connectionOptions = { host: parsed.hostname, password: decodeURIComponent(parsed.password), port: Number(parsed.port || 3306), user: decodeURIComponent(parsed.username) };
const admin = await mysql.createConnection(connectionOptions); const cliEnv = { ...process.env, MYSQL_PWD: connectionOptions.password }; const commonArgs = ['--protocol=TCP', `--host=${connectionOptions.host}`, `--port=${connectionOptions.port}`, `--user=${connectionOptions.user}`];
const artifactPath = path.join(process.env.TMPDIR || process.cwd(), 'backup-restore.json'); const startedAt = new Date().toISOString();
let expectedMigrations = 0;
try {
  await admin.query(`CREATE DATABASE \`${sourceDb}\``); await admin.query(`CREATE DATABASE \`${restoreDb}\``);
  const legacy = await fs.readFile(new URL('../../backend/db/base-schema.sql', import.meta.url)); await run('mysql', [...commonArgs, sourceDb], { env: cliEnv, input: legacy });
  const sourceUrl = new URL(configured); sourceUrl.pathname = `/${sourceDb}`; const sourcePool = mysql.createPool(sourceUrl.toString());
  try {
    const migrationResult = await bootstrapMysqlSchema({ executor: sourcePool }); const platform = createMysqlPlatformRepository({ pool: sourcePool }); const outbox = createMysqlDomainEventOutboxRepository({ pool: sourcePool }); const tenantId = '11111111-1111-4111-8111-111111111111';
    await platform.createOAuthApplication({ clientId: 'odin_client_restore_drill', clientSecretHash: createHash('sha256').update('restore-drill-secret').digest('hex'), createdBy: 'restore-drill', input: { name: 'Restore drill client', projectIds: [], scopes: ['projects.read'] }, tenantId });
    await platform.createWebhookSubscription({ createdBy: 'restore-drill', input: { description: 'Restore drill.', eventTypes: ['governance.changed'], name: 'Restore drill webhook', url: 'https://hooks.example.com/restore' }, tenantId });
    await outbox.enqueue({ eventType: 'governance.changed', idempotencyKey: 'restore-drill-event', payload: { action: 'restore.test' }, projectId: null, tenantId });
    const dump = await run('mysqldump', [...commonArgs, '--no-tablespaces', '--set-gtid-purged=OFF', '--single-transaction', '--triggers', sourceDb], { env: cliEnv });
    await platform.createWebhookSubscription({ createdBy: 'restore-drill', input: { description: 'Created after recovery point.', eventTypes: ['governance.changed'], name: 'Post-backup webhook', url: 'https://hooks.example.com/post-backup' }, tenantId });
    await run('mysql', [...commonArgs, restoreDb], { env: cliEnv, input: dump });
    expectedMigrations = migrationResult.total;
  } finally { await sourcePool.end(); }
  const restoreUrl = new URL(configured); restoreUrl.pathname = `/${restoreDb}`; const restoredPool = mysql.createPool(restoreUrl.toString());
  try {
    const [migrations] = await restoredPool.query('SELECT id FROM schema_migrations ORDER BY id'); const snapshot = await createMysqlPlatformRepository({ pool: restoredPool }).listSnapshot({ tenantId: '11111111-1111-4111-8111-111111111111' }); const events = await createMysqlDomainEventOutboxRepository({ pool: restoredPool }).list();
    if (migrations.length !== expectedMigrations) throw new Error(`Expected ${expectedMigrations} restored migrations, received ${migrations.length}.`); if (snapshot.applications.length !== 1 || snapshot.subscriptions.length !== 1 || events.length !== 1) throw new Error('Restored application invariants did not match the recovery point.');
    const result = { completedAt: new Date().toISOString(), migrations: migrations.length, ok: true, outboxEvents: events.length, recoveryPointExcludedPostBackupWrite: true, startedAt, webhookSubscriptions: snapshot.subscriptions.length }; await fs.writeFile(artifactPath, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  } finally { await restoredPool.end(); }
} finally {
  await admin.query(`DROP DATABASE IF EXISTS \`${sourceDb}\``); await admin.query(`DROP DATABASE IF EXISTS \`${restoreDb}\``); await admin.end(); delete cliEnv.MYSQL_PWD;
}
