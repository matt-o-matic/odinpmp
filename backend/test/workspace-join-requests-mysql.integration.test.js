import assert from 'node:assert/strict';
import test from 'node:test';
import mysql from 'mysql2/promise';

import { createMysqlJoinRequestsRepository, ensureMysqlJoinRequestSchema } from '../src/modules/tenants/join-requests.repository.js';

const databaseUrl = process.env.ODIN_TEST_DATABASE_URL;
const limits = (now) => ({ declinedSince: new Date(now - 7 * 86_400_000), maxPending: 3, perPeriod: 5, since: new Date(now - 86_400_000) });

test('MySQL join requests: 0072 on the legacy table, single-use confirmation, one approval, membership through the shared path', { skip: !databaseUrl, timeout: 30000 }, async () => {
  const parsed = new URL(databaseUrl);
  const database = `odin_join_requests_${process.pid}`;
  const admin = await mysql.createConnection({ host: parsed.hostname, port: Number(parsed.port || 3306), user: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) });
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  parsed.pathname = `/${database}`;
  const pool = mysql.createPool(parsed.toString());
  try {
    await pool.query('CREATE TABLE tenants (id CHAR(36) PRIMARY KEY, name VARCHAR(255) NOT NULL)');
    await pool.query('CREATE TABLE users (id CHAR(36) PRIMARY KEY, name VARCHAR(255) NOT NULL, email VARCHAR(255) NOT NULL UNIQUE, password VARCHAR(255), authentication_method_id INT)');
    await pool.query('CREATE TABLE user_tenant (id CHAR(36) PRIMARY KEY, user_id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL, role VARCHAR(50) NOT NULL, UNIQUE KEY membership (user_id, tenant_id))');
    await pool.query('CREATE TABLE audit_log (id CHAR(36) PRIMARY KEY, user_id VARCHAR(255) NOT NULL, tenant_id CHAR(36), project_id CHAR(36), ip_addr VARCHAR(100) NOT NULL, action VARCHAR(100) NOT NULL, result VARCHAR(200) NOT NULL, detail TEXT)');
    // The legacy table as production has it.
    await pool.query(`CREATE TABLE user_requests (id char(36) NOT NULL, tenant_id char(36) NOT NULL, name varchar(255) DEFAULT NULL, email varchar(255) NOT NULL,
      requested_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (id), KEY idx_user_requests_tenant_id (tenant_id), KEY idx_user_requests_requested_at (requested_at))`);
    await pool.query("INSERT INTO user_requests (id, tenant_id, name, email) VALUES ('legacy-row', 'tenant-acme', 'Old', 'old@example.com')");
    await pool.query("INSERT INTO tenants VALUES ('tenant-acme', 'Acme'), ('tenant-rita', 'Rita Co')");
    await pool.query("INSERT INTO users VALUES ('user-ada', 'Ada', 'ada@acme.com', 'x', 1), ('user-rita', 'Rita', 'rita@rita.example', 'x', 1)");
    await pool.query("INSERT INTO user_tenant VALUES ('m1', 'user-ada', 'tenant-acme', 'admin'), ('m2', 'user-rita', 'tenant-rita', 'admin')");

    await ensureMysqlJoinRequestSchema(pool);
    await ensureMysqlJoinRequestSchema(pool);
    const repository = createMysqlJoinRequestsRepository({ pool });
    assert.deepEqual(await repository.listPendingForTenant({ tenantId: 'tenant-acme' }), [], 'legacy rows without a requester stay hidden');
    assert.deepEqual((await repository.findWorkspacesByName('ACME')).map((row) => row.id), ['tenant-acme']);

    const now = new Date();
    const token = { expiresAt: new Date(now.valueOf() + 86_400_000), hash: 'a'.repeat(64) };
    const created = await repository.createRequest({ email: 'rita@rita.example', limits: limits(now.valueOf()), name: 'Rita', now, tenantId: 'tenant-acme', token, userId: 'user-rita', verification: null });
    assert.equal(created.outcome, 'created');
    assert.equal(created.request.workspaceName, 'Acme');
    const duplicate = await repository.createRequest({ email: 'rita@rita.example', limits: limits(now.valueOf()), name: 'Rita', now, tenantId: 'tenant-acme', token: { ...token, hash: 'b'.repeat(64) }, userId: 'user-rita', verification: null });
    assert.equal(duplicate.outcome, 'duplicate');
    assert.equal((await repository.createRequest({ email: 'rita@rita.example', limits: limits(now.valueOf()), name: 'Rita', now, tenantId: 'tenant-rita', token: null, userId: 'user-rita', verification: null })).outcome, 'member');

    assert.equal((await repository.findPendingByTokenHash({ tokenHash: token.hash })).id, created.request.id);
    const confirmations = await Promise.all([
      repository.markVerified({ method: 'email_link', now, requestId: created.request.id, tokenHash: token.hash }),
      repository.markVerified({ method: 'email_link', now, requestId: created.request.id, tokenHash: token.hash }),
    ]);
    assert.deepEqual(confirmations.sort(), [false, true]);
    assert.equal(await repository.hasVerifiedEmail({ email: 'RITA@rita.example', userId: 'user-rita' }), true);
    const [pending] = await repository.listPendingForTenant({ tenantId: 'tenant-acme' });
    assert.equal(pending.verificationMethod, 'email_link');

    const audit = { async append(event, { executor }) { await executor.execute('INSERT INTO audit_log (id, user_id, tenant_id, project_id, ip_addr, action, result, detail) VALUES (UUID(), ?, ?, NULL, ?, ?, ?, ?)', [event.userId, event.tenantId, event.ipAddress, event.action, event.result, JSON.stringify(event.detail)]); } };
    const decide = () => repository.decide({ auditEvent: { action: 'tenant.join_request.approved', detail: {}, ipAddress: '127.0.0.1', result: 'success', tenantId: 'tenant-acme', userId: 'user-ada' }, auditWriter: audit, decidedBy: 'user-ada', decision: 'approved', now, requestId: pending.id, role: 'manager', tenantId: 'tenant-acme' });
    const decisions = await Promise.allSettled([decide(), decide()]);
    assert.equal(decisions.filter((outcome) => outcome.status === 'fulfilled' && outcome.value).length, 1);
    const [[membership]] = await pool.query("SELECT role FROM user_tenant WHERE user_id = 'user-rita' AND tenant_id = 'tenant-acme'");
    assert.equal(membership.role, 'manager');
    const [[{ count }]] = await pool.query("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'tenant.join_request.approved'");
    assert.equal(Number(count), 1);
    const [own] = await repository.listForRequester({ since: new Date(now.valueOf() - 86_400_000), userId: 'user-rita' });
    assert.deepEqual([own.status, own.grantedRole], ['approved', 'manager']);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end();
  }
});
