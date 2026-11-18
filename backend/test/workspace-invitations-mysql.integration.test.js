import assert from 'node:assert/strict';
import test from 'node:test';
import mysql from 'mysql2/promise';
import { createMysqlTenantsRepository } from '../src/modules/tenants/tenants.repository.js';
import { createMysqlMailRepository, ensureMysqlMailDeliverySchema } from '../src/modules/mail/mail.repository.js';
import { inviteUserForUser, listInvitesForUser, resendInviteForUser } from '../src/modules/tenants/tenants.service.js';

const databaseUrl = process.env.ODIN_TEST_DATABASE_URL;
test('MySQL invitations queue, redeem once, preserve membership and roll back failures', { skip: !databaseUrl, timeout: 30000 }, async () => {
  const parsed = new URL(databaseUrl);
  const database = `odin_invites_${process.pid}`;
  const admin = await mysql.createConnection({ host: parsed.hostname, port: Number(parsed.port || 3306), user: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) });
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  parsed.pathname = `/${database}`;
  const pool = mysql.createPool(parsed.toString());
  try {
    await pool.query('CREATE TABLE tenants (id VARCHAR(36) PRIMARY KEY, name VARCHAR(255) NOT NULL)');
    await pool.query('CREATE TABLE tenant_domains (id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36), domain VARCHAR(255))');
    await pool.query('CREATE TABLE users (id VARCHAR(36) PRIMARY KEY, name VARCHAR(120) NOT NULL, email VARCHAR(255) NOT NULL UNIQUE, password VARCHAR(255), authentication_method_id INT)');
    await pool.query('CREATE TABLE user_tenant (id VARCHAR(36) PRIMARY KEY, user_id VARCHAR(36) NOT NULL, tenant_id VARCHAR(36) NOT NULL, role VARCHAR(16) NOT NULL, UNIQUE KEY membership (user_id,tenant_id), FOREIGN KEY (user_id) REFERENCES users(id), FOREIGN KEY (tenant_id) REFERENCES tenants(id))');
    await pool.query('CREATE TABLE user_invites (id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, email VARCHAR(255) NOT NULL, role VARCHAR(16), invite_token VARCHAR(255) NOT NULL UNIQUE, invited_at DATETIME NOT NULL, accepted TINYINT NOT NULL DEFAULT 0)');
    await pool.query("INSERT INTO tenants VALUES ('tenant-one', 'Inviting workspace')");
    await pool.query("INSERT INTO users VALUES ('existing-user', 'Existing user', 'existing@example.com', 'unchanged', 1)");
    await ensureMysqlMailDeliverySchema(pool);
    const repository = createMysqlTenantsRepository({ pool });
    const mailRepository = createMysqlMailRepository({ pool });
    const user = { id: 'admin', memberships: [{ tenantId: 'tenant-one', role: 'admin' }] };
    const options = { frontendAppUrl: 'https://odin.example/app', mailRepository };
    await inviteUserForUser(user, { email: 'new@example.com', role: 'manager' }, repository, options);
    const listed = await listInvitesForUser(user, repository, options);
    assert.equal(listed.invites[0].deliveryStatus, 'pending');
    const inviteToken = listed.invites[0].invite_token;
    const publicInvite = await repository.findInviteByToken({ inviteToken });
    assert.equal(publicInvite.tenantName, 'Inviting workspace');
    const results = await Promise.allSettled([
      repository.acceptInvite({ inviteToken, registration: { name: 'New Person', passwordHash: 'hashed-password' } }),
      repository.acceptInvite({ inviteToken, registration: { name: 'Duplicate', passwordHash: 'different-password' } }),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.statusCode, 410);
    const [accounts] = await pool.query("SELECT u.name, ut.role FROM users u JOIN user_tenant ut ON ut.user_id = u.id WHERE u.email = 'new@example.com'");
    assert.deepEqual(accounts, [{ name: 'New Person', role: 'manager' }]);
    assert.equal((await repository.findInviteByToken({ inviteToken })).accepted, true);

    const { invitation: existingInvite } = await repository.inviteUser({ tenantId: 'tenant-one', email: 'existing@example.com', role: 'user' });
    await assert.rejects(repository.acceptInvite({ inviteToken: existingInvite.inviteToken, registration: { name: 'Reset', passwordHash: 'new-password' } }), error => error.statusCode === 409);
    assert.equal((await repository.findInviteByToken({ inviteToken: existingInvite.inviteToken })).accepted, false);
    await repository.acceptInvite({ inviteToken: existingInvite.inviteToken, userId: 'existing-user' });
    const { invitation: roleChange } = await repository.inviteUser({ tenantId: 'tenant-one', email: 'existing@example.com', role: 'admin' });
    await repository.acceptInvite({ inviteToken: roleChange.inviteToken, userId: 'existing-user' });
    const [[membership]] = await pool.query("SELECT role FROM user_tenant WHERE user_id = 'existing-user'");
    assert.equal(membership.role, 'user');

    const { invitation: failed } = await repository.inviteUser({ tenantId: 'missing-tenant', email: 'rollback@example.com', role: 'user' });
    await assert.rejects(repository.acceptInvite({ inviteToken: failed.inviteToken, registration: { name: 'Roll back', passwordHash: 'hashed-password' } }));
    const [[count]] = await pool.query("SELECT COUNT(*) AS count FROM users WHERE email = 'rollback@example.com'");
    assert.equal(count.count, 0);
    const [[notConsumed]] = await pool.query('SELECT accepted FROM user_invites WHERE id = ?', [failed.id]);
    assert.equal(notConsumed.accepted, 0);

    await inviteUserForUser(user, { email: 'resend@example.com', role: 'user' }, repository, options);
    const previous = (await repository.listInvites({ tenantId: 'tenant-one' })).find(invite => invite.email === 'resend@example.com');
    await resendInviteForUser(user, { invite_token: previous.invite_token }, repository, options);
    assert.equal(await repository.findInviteByToken({ inviteToken: previous.invite_token }), null);
    assert.equal((await listInvitesForUser(user, repository, options)).invites.find(invite => invite.email === 'resend@example.com').deliveryStatus, 'pending');
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});
