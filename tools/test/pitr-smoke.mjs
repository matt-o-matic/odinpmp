import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../backend/package.json', import.meta.url));
const mysql = require('mysql2/promise');

function run(command, args, { env, input = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(`${command} failed (${code}): ${Buffer.concat(stderr).toString('utf8').slice(-2000)}`));
    });
    child.stdin.end(input ?? undefined);
  });
}

const configured = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();
if (!configured) throw new Error('PITR smoke requires ODIN_TEST_DATABASE_URL.');
const parsed = new URL(configured);
if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
  throw new Error('PITR smoke only permits local MySQL.');
}
const prefix = decodeURIComponent(parsed.pathname.slice(1)).replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 28);
const suffix = createHash('sha256').update(`${process.pid}:${Date.now()}`).digest('hex').slice(0, 8);
const sourceDb = `${prefix}_pitr_source_${suffix}`;
const restoreDb = `${prefix}_pitr_restore_${suffix}`;
const connectionOptions = {
  host: parsed.hostname,
  password: decodeURIComponent(parsed.password),
  port: Number(parsed.port || 3306),
  user: decodeURIComponent(parsed.username),
};
const cliEnv = { ...process.env, MYSQL_PWD: connectionOptions.password };
const commonArgs = [
  '--protocol=TCP',
  `--host=${connectionOptions.host}`,
  `--port=${connectionOptions.port}`,
  `--user=${connectionOptions.user}`,
];
const admin = await mysql.createConnection(connectionOptions);
const artifactPath = path.join(process.env.TMPDIR || process.cwd(), 'pitr.json');
const startedAt = new Date().toISOString();

try {
  const [[settings]] = await admin.query('SELECT @@log_bin AS logBin, @@binlog_format AS binlogFormat, @@binlog_expire_logs_seconds AS retentionSeconds');
  if (!Number(settings.logBin) || settings.binlogFormat !== 'ROW') {
    throw new Error('PITR requires enabled ROW-format MySQL binary logs.');
  }
  await admin.query(`CREATE DATABASE \`${sourceDb}\``);
  await admin.query(`CREATE DATABASE \`${restoreDb}\``);
  await admin.query(`CREATE TABLE \`${sourceDb}\`.pitr_markers (id INT PRIMARY KEY, label VARCHAR(64) NOT NULL)`);
  await admin.query(`INSERT INTO \`${sourceDb}\`.pitr_markers VALUES (1, 'base-backup')`);
  await admin.query('FLUSH BINARY LOGS');

  const dump = await run('mysqldump', [
    ...commonArgs,
    '--no-tablespaces',
    '--set-gtid-purged=OFF',
    '--single-transaction',
    sourceDb,
  ], { env: cliEnv });
  const [[start]] = await admin.query('SHOW BINARY LOG STATUS');
  await admin.query(`INSERT INTO \`${sourceDb}\`.pitr_markers VALUES (2, 'inside-recovery-point')`);
  const [[target]] = await admin.query('SHOW BINARY LOG STATUS');
  if (start.File !== target.File) throw new Error('PITR probe crossed a binary-log rotation boundary.');
  await admin.query(`INSERT INTO \`${sourceDb}\`.pitr_markers VALUES (3, 'after-recovery-point')`);

  await run('mysql', [...commonArgs, restoreDb], { env: cliEnv, input: dump });
  const binlog = await run('mysqlbinlog', [
    '--read-from-remote-server',
    '--skip-gtids',
    `--host=${connectionOptions.host}`,
    `--port=${connectionOptions.port}`,
    `--user=${connectionOptions.user}`,
    `--start-position=${start.Position}`,
    `--stop-position=${target.Position}`,
    `--rewrite-db=${sourceDb}->${restoreDb}`,
    start.File,
  ], { env: cliEnv });
  await run('mysql', [...commonArgs, restoreDb], { env: cliEnv, input: binlog });
  const [markers] = await admin.query(`SELECT id, label FROM \`${restoreDb}\`.pitr_markers ORDER BY id`);
  if (markers.length !== 2 || markers[1]?.label !== 'inside-recovery-point') {
    throw new Error('Point-in-time restore did not include exactly the intended transactions.');
  }

  const result = {
    baseBackupMarker: markers[0].label,
    binaryLog: start.File,
    completedAt: new Date().toISOString(),
    excludedPostRecoveryPointWrite: true,
    includedRecoveryPointMarker: markers[1].label,
    logRetentionSeconds: Number(settings.retentionSeconds),
    ok: true,
    startedAt,
  };
  await fs.writeFile(artifactPath, JSON.stringify(result, null, 2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await admin.query(`DROP DATABASE IF EXISTS \`${sourceDb}\``);
  await admin.query(`DROP DATABASE IF EXISTS \`${restoreDb}\``);
  await admin.end();
  delete cliEnv.MYSQL_PWD;
}
