import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import mysql from 'mysql2/promise';

import { createMysqlTenantsRepository } from '../src/modules/tenants/tenants.repository.js';

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();

test('MySQL enterprise provisioning creates, updates, and deprovisions one tenant membership', { skip: !databaseUrl, timeout: 15_000 }, async () => {
  const parsed = databaseUrl ? new URL(databaseUrl) : null; const pool = mysql.createPool(databaseUrl);
  try {
    const [tables] = await pool.execute(`SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'users'`);
    if (!tables.length) { const importer = await mysql.createConnection({ database: decodeURIComponent(parsed.pathname.slice(1)), host: parsed.hostname, multipleStatements: true, password: decodeURIComponent(parsed.password), port: Number(parsed.port || 3306), user: decodeURIComponent(parsed.username) }); try { await importer.query(await readFile(new URL('../db/base-schema.sql', import.meta.url), 'utf8')); } finally { await importer.end(); } }
    const tenantId = randomUUID(); await pool.execute('INSERT INTO tenants (id, name) VALUES (?, ?)', [tenantId, 'SCIM Test Tenant']); const repository = createMysqlTenantsRepository({ pool });
    const created = await repository.provisionUser({ email: 'provisioned@example.com', name: 'Provisioned User', role: 'user', tenantId }); assert.equal(created.email, 'provisioned@example.com');
    const updated = await repository.provisionUser({ email: 'provisioned@example.com', name: 'Provisioned Manager', role: 'manager', tenantId }); assert.equal(updated.id, created.id);
    const users = await repository.listExistingUsers({ tenantId }); assert.equal(users.length, 1); assert.equal(users[0].name, 'Provisioned Manager'); assert.equal(users[0].role, 'manager');
    const [memberships] = await pool.execute('SELECT COUNT(*) AS count FROM user_tenant WHERE tenant_id = ? AND user_id = ?', [tenantId, created.id]); assert.equal(Number(memberships[0].count), 1);
    assert.equal(await repository.removeUserFromTenant({ tenantId, userId: created.id }), true); assert.deepEqual(await repository.listExistingUsers({ tenantId }), []);
  } finally { await pool.end(); }
});
