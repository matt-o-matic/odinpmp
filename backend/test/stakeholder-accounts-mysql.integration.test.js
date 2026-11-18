import assert from 'node:assert/strict';
import test from 'node:test';
import mysql from 'mysql2/promise';
import { createMysqlAuthRepository } from '../src/modules/auth/auth.repository.js';
import { isStakeholderEmail } from '../src/modules/auth/stakeholder-accounts.js';
import { createMysqlTenantsRepository } from '../src/modules/tenants/tenants.repository.js';

const databaseUrl = process.env.ODIN_TEST_DATABASE_URL;
// Column types, keys and collation follow production's legacy tables.
const TABLE = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci';

test('MySQL stakeholder file owners cannot sign in until an invitation claims them', { skip: !databaseUrl, timeout: 30000 }, async () => {
  const parsed = new URL(databaseUrl);
  const database = `odin_stakeholder_owner_${process.pid}`;
  const admin = await mysql.createConnection({ host: parsed.hostname, port: Number(parsed.port || 3306), user: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) });
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  parsed.pathname = `/${database}`;
  const pool = mysql.createPool(parsed.toString());
  try {
    await pool.query(`CREATE TABLE tenants (id char(36) NOT NULL PRIMARY KEY, name varchar(255) NOT NULL) ${TABLE}`);
    await pool.query(`CREATE TABLE authentication_methods (id int NOT NULL PRIMARY KEY, name varchar(64) NOT NULL, description varchar(255) NULL) ${TABLE}`);
    await pool.query(`CREATE TABLE users (id char(36) NOT NULL PRIMARY KEY, name varchar(255) NOT NULL, email varchar(255) NOT NULL, password varchar(255) DEFAULT NULL,
      authentication_method_id int NOT NULL DEFAULT 1, UNIQUE KEY email (email), FOREIGN KEY (authentication_method_id) REFERENCES authentication_methods (id)) ${TABLE}`);
    await pool.query(`CREATE TABLE user_tenant (id char(36) NOT NULL PRIMARY KEY, user_id char(36) NOT NULL, tenant_id char(36) NOT NULL, role varchar(16) NOT NULL,
      UNIQUE KEY membership (user_id, tenant_id), FOREIGN KEY (user_id) REFERENCES users (id), FOREIGN KEY (tenant_id) REFERENCES tenants (id)) ${TABLE}`);
    await pool.query(`CREATE TABLE preferences (id char(36) NOT NULL PRIMARY KEY, tenant_id char(36) NULL, user_id char(36) NULL, project_id char(36) NULL, \`key\` varchar(255) NOT NULL, \`value\` text) ${TABLE}`);
    await pool.query(`CREATE TABLE backup_codes (id char(36) NOT NULL PRIMARY KEY, user_id char(36) NOT NULL, code varchar(64) NOT NULL, used tinyint NOT NULL DEFAULT 0) ${TABLE}`);
    await pool.query(`CREATE TABLE user_invites (id varchar(36) PRIMARY KEY, tenant_id varchar(36) NOT NULL, email varchar(255) NOT NULL, role varchar(16), invite_token varchar(255) NOT NULL UNIQUE, invited_at datetime NOT NULL, accepted tinyint NOT NULL DEFAULT 0) ${TABLE}`);
    await pool.query(`CREATE TABLE file_vault (id char(36) NOT NULL PRIMARY KEY, tenant_id char(36) NOT NULL, user_id char(36) NOT NULL, target_id char(36) NOT NULL, target_type char(30) NOT NULL,
      file_name varchar(1024) DEFAULT NULL, FOREIGN KEY (tenant_id) REFERENCES tenants (id), FOREIGN KEY (user_id) REFERENCES users (id)) ${TABLE}`);
    await pool.query("INSERT INTO authentication_methods VALUES (1, 'basic', 'Email and password authentication'), (2, 'google', 'Google OAuth authentication')");
    await pool.query("INSERT INTO tenants VALUES ('tenant-one', 'Workspace')");
    await pool.query("INSERT INTO users (id, name, email, password, authentication_method_id) VALUES ('member', 'Project member', 'member@example.com', 'hash', 1), ('former', 'Former member', 'former@example.com', 'hash', 1)");
    await pool.query("INSERT INTO user_tenant VALUES ('membership-1', 'member', 'tenant-one', 'user')");
    const auth = createMysqlAuthRepository({ pool });

    // Before any stakeholder exists there is no table, and no account is a stakeholder's.
    assert.equal(await isStakeholderEmail(pool, 'tester@client.example'), false);
    assert.equal(await auth.findOrCreateStakeholderOwner({ email: 'tester@client.example', name: 'Tester' }), null);

    await pool.query(`CREATE TABLE project_stakeholders (id varchar(36) NOT NULL PRIMARY KEY, tenant_id varchar(36) NOT NULL, project_id varchar(36) NOT NULL, name varchar(255) NOT NULL,
      email varchar(255) NOT NULL, UNIQUE KEY uq_project_stakeholders_project_email (project_id, email)) ${TABLE}`);
    await pool.query("INSERT INTO project_stakeholders VALUES ('s-1', 'tenant-one', 'project-a', 'External tester', 'tester@client.example'), ('s-2', 'tenant-one', 'project-b', 'Same tester', 'tester@client.example'), ('s-3', 'tenant-one', 'project-a', 'Listed member', 'member@example.com')");

    // Only stakeholder emails get an owner; simultaneous uploads make one account.
    assert.equal(await auth.findOrCreateStakeholderOwner({ email: 'nobody@client.example', name: 'Nobody' }), null);
    const owners = await Promise.all(Array.from({ length: 5 }, () => auth.findOrCreateStakeholderOwner({ email: 'Tester@Client.example', name: 'External tester' })));
    assert.equal(new Set(owners.map((owner) => owner.id)).size, 1);
    const [[row]] = await pool.query("SELECT COUNT(*) AS accounts, MIN(password) AS password, MIN(authentication_method_id) AS method FROM users WHERE email = 'tester@client.example'");
    assert.deepEqual({ ...row }, { accounts: 1, password: null, method: 1 });
    const [{ id: ownerId }] = owners;

    // The account satisfies the file owner foreign key, has no membership, and cannot sign in.
    await pool.query("INSERT INTO file_vault VALUES ('file-1', 'tenant-one', ?, 'ticket-1', 'ticket', 'bug-reporter-1-shot.png')", [ownerId]);
    assert.equal((await auth.findUserById(ownerId)).loginDisabled, true);
    assert.equal((await auth.findUserByEmail('tester@client.example')).loginDisabled, true);
    assert.equal((await auth.findUserById('member')).loginDisabled, false);
    // A user without a membership whose email is not a stakeholder's is not affected.
    assert.equal((await auth.findUserById('former')).loginDisabled, false);

    // A stakeholder whose email is an existing account is that person; the account is reused unchanged.
    assert.deepEqual(await auth.findOrCreateStakeholderOwner({ email: 'member@example.com', name: 'Listed member' }), { id: 'member', name: 'Project member' });

    // An invitation to the stakeholder's address claims the account and keeps its id, so its files stay theirs.
    const tenants = createMysqlTenantsRepository({ pool });
    await pool.query("INSERT INTO user_invites VALUES ('invite-1', 'tenant-one', 'tester@client.example', 'user', 'token-claim', NOW(), 0), ('invite-2', 'tenant-one', 'former@example.com', 'user', 'token-taken', NOW(), 0)");
    assert.deepEqual(await tenants.acceptInvite({ inviteToken: 'token-claim', registration: { name: 'Tess Tester', passwordHash: 'new-hash' } }), { userId: ownerId, tenantId: 'tenant-one' });
    const claimed = await auth.findUserById(ownerId);
    assert.equal(claimed.loginDisabled, false);
    assert.equal(claimed.name, 'Tess Tester');
    assert.equal(claimed.passwordHash, 'new-hash');
    assert.deepEqual(claimed.memberships, [{ role: 'user', tenantId: 'tenant-one' }]);
    // An ordinary account still has to sign in to accept.
    await assert.rejects(tenants.acceptInvite({ inviteToken: 'token-taken', registration: { name: 'Someone', passwordHash: 'other' } }), { statusCode: 409 });
    const [[former]] = await pool.query("SELECT password FROM users WHERE id = 'former'");
    assert.equal(former.password, 'hash');
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});
