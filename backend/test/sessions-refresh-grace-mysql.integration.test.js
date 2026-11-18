import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import mysql from 'mysql2/promise';

import { bootstrapMysqlSchema } from '../src/jobs/bootstrap-schema.lib.js';
import { createMysqlSessionsRepository, REFRESH_GRACE_SECONDS } from '../src/modules/sessions/sessions.repository.js';

// Migration 0104_refresh_grace on MySQL: a session accepts the refresh token it just replaced for
// REFRESH_GRACE_SECONDS after the rotation, and says so (`grace`), and nothing older.
// auth-api.test.js covers the refresh route on the in-memory repository.

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();

test('MySQL: 0104 refresh grace', { skip: !databaseUrl, timeout: 300_000 }, async () => {
  const parsed = new URL(databaseUrl);
  const database = `${decodeURIComponent(parsed.pathname.slice(1)).slice(0, 36)}_grace_${process.pid}`;
  const connectionOptions = { host: parsed.hostname, password: decodeURIComponent(parsed.password), port: Number(parsed.port || 3306), user: decodeURIComponent(parsed.username) };
  const admin = await mysql.createConnection(connectionOptions);
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  const isolatedUrl = new URL(databaseUrl); isolatedUrl.pathname = `/${database}`;
  const pool = mysql.createPool(isolatedUrl.toString());
  try {
    const importer = await mysql.createConnection({ ...connectionOptions, database, multipleStatements: true });
    try { await importer.query(await readFile(new URL('../db/base-schema.sql', import.meta.url), 'utf8')); }
    finally { await importer.end(); }
    await bootstrapMysqlSchema({ executor: pool });
    await bootstrapMysqlSchema({ executor: pool });

    const userId = randomUUID();
    await pool.execute('INSERT INTO users (id, name, email, authentication_method_id) VALUES (?, ?, ?, 1)', [userId, 'Ada', `${userId}@acme.test`]);
    const repository = createMysqlSessionsRepository({ pool });
    const sessionId = randomUUID();
    const expiryDate = new Date(Date.now() + 86_400_000);
    await repository.createSession({ expiryDate, id: sessionId, ipAddr: '127.0.0.1', token: 'token-1', userAgent: 'test', userId });
    const check = (refreshToken) => repository.validateRefreshToken({ refreshToken, sessionId, userId });

    assert.deepEqual([(await check('token-1')).ok, (await check('token-1')).grace], [true, false]);
    assert.equal((await check('nope')).ok, false);

    assert.equal(await repository.rotateRefreshToken({ expiryDate, refreshToken: 'token-2', sessionId, userId }), true);
    const current = await check('token-2');
    assert.deepEqual([current.ok, current.grace], [true, false]);
    const replaced = await check('token-1');
    assert.deepEqual([replaced.ok, replaced.grace, replaced.session.token], [true, true, 'token-2'], 'the replaced token gets the current one');

    await repository.rotateRefreshToken({ expiryDate, refreshToken: 'token-3', sessionId, userId });
    assert.equal((await check('token-1')).ok, false, 'two rotations back is refused');
    assert.equal((await check('token-2')).grace, true);

    // Past the grace time, only the current token works.
    await pool.execute('UPDATE tokens SET rotated_at = NOW(3) - INTERVAL ? SECOND WHERE id = ?', [REFRESH_GRACE_SECONDS + 5, sessionId]);
    assert.equal((await check('token-2')).ok, false);
    assert.equal((await check('token-3')).ok, true);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end();
  }
});
