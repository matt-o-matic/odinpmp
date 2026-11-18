import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { createMysqlPlatformRepository, ensureMysqlPlatformDelegationSchema } from '../src/modules/platform/platform.repository.js';
import { createMysqlMailRepository } from '../src/modules/mail/mail.repository.js';
import { processMailQueueBatch } from '../src/jobs/process-mail-queue.lib.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// This test accepts only the explicitly named disposable fixture database.
const enabled = process.env.BUGREPORTER_EPHEMERAL_MYSQL === 'true';
test('companion migration CLI creates schema idempotently without queueing mail', { skip: !enabled }, async t => {
  const host=process.env.BUGREPORTER_TEST_MYSQL_HOST;assert.match(host ?? '',/^172\.\d+\.\d+\.\d+$/);
  const directory=mkdtempSync(join(tmpdir(),'reporting-migration-env-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const legacy=await mysql.createConnection({host,user:'reporter_test',password:'synthetic-reporting-test-password',database:'bugreporter_session_validation'});
  try {
    await legacy.execute('CREATE TABLE mail_templates (id VARCHAR(128) PRIMARY KEY, template_name VARCHAR(100) NOT NULL, template_contents TEXT NOT NULL, template_styles TEXT NULL) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
    await legacy.execute("CREATE TABLE mail_queue (id INT AUTO_INCREMENT PRIMARY KEY, recipient_email VARCHAR(255) NOT NULL, subject VARCHAR(255) NOT NULL, body LONGTEXT NOT NULL, reply_to VARCHAR(255) NULL, status ENUM('pending','processing','sent','failed') DEFAULT 'pending', attempts INT DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, mail_target_id VARCHAR(36) NULL, mail_template_id VARCHAR(128) NOT NULL) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    await legacy.execute("INSERT INTO mail_queue(recipient_email,subject,body,status,mail_target_id,mail_template_id) VALUES('legacy@example.test','Existing invitation','Existing body','sent',?,'legacy-template')",['12345678-1234-1234-1234-123456789012']);
  } finally { await legacy.end(); }
  const script=fileURLToPath(new URL('../scripts/bug-reporter-migrate.mjs',import.meta.url));
  for(let attempt=0;attempt<2;attempt++){
    const result=spawnSync(process.execPath,[script],{cwd:directory,env:{PATH:process.env.PATH,NODE_ENV:'test',DATABASE_URL:`mysql://reporter_test:synthetic-reporting-test-password@${host}:3306/bugreporter_session_validation`},encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/No mail was queued/);
  }
  const connection=await mysql.createConnection({host,user:'reporter_test',password:'synthetic-reporting-test-password',database:'bugreporter_session_validation'});
  try {
    const [columns]=await connection.execute("SELECT CHARACTER_MAXIMUM_LENGTH AS maxLength, IS_NULLABLE AS nullable FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='mail_queue' AND column_name='mail_target_id'");
    assert.equal(columns[0].maxLength,128);
    assert.equal(columns[0].nullable,'YES');
    assert.deepEqual((await connection.execute('SELECT subject,body,status,mail_target_id AS target FROM mail_queue'))[0],[{subject:'Existing invitation',body:'Existing body',status:'sent',target:'12345678-1234-1234-1234-123456789012'}]);
    assert.equal((await connection.execute('SELECT COUNT(*) AS count FROM bug_reporter_mail_deliveries'))[0][0].count,0);
  } finally { await connection.end(); }
});
test('MySQL reporting grants persist, renew conditionally, expire and revoke across connections', { skip: !enabled }, async t => {
  assert.match(process.env.BUGREPORTER_TEST_MYSQL_HOST ?? '', /^172\.\d+\.\d+\.\d+$/);
  const config = {
    host: process.env.BUGREPORTER_TEST_MYSQL_HOST,
    user: 'reporter_test', password: 'synthetic-reporting-test-password',
    database: 'bugreporter_session_validation', connectionLimit: 3,
  };
  let pool = mysql.createPool(config);
  t.after(async () => { await pool.end(); });
  await ensureMysqlPlatformDelegationSchema(pool);
  let repository = createMysqlPlatformRepository({ pool });
  const tenantId = randomUUID();
  const application = await repository.createOAuthApplication({ clientId: 'synthetic-client-' + randomUUID(), clientSecretHash: 'a'.repeat(64), createdBy: 'synthetic-user', tenantId, input: { name: 'Reporting session fixture', scopes: ['projects.read'], projectIds: ['synthetic-project'], redirectUris: ['https://reporter.example.test/callback'] } });
  async function make(expiresAt) {
    const tokenHash = createHash('sha256').update(randomUUID()).digest('hex');
    const token = await repository.createOAuthAccessToken({ applicationId: application.id, expiresAt, grantType: 'bug_reporter_session', scopes: ['projects.read'], tenantId, tokenHash, userId: 'synthetic-user' });
    return { token, tokenHash, key: { applicationId: application.id, tenantId, tokenId: token.id } };
  }
  const grant = await make(new Date(Date.now() + 86400000).toISOString());
  assert.equal((await repository.authenticateOAuthAccessToken({ tokenHash: grant.tokenHash })).token.userId, 'synthetic-user');
  const originalExpiry = grant.token.expiresAt;
  assert.equal(await repository.updateReportingSession(grant.key), true);
  assert.equal((await repository.authenticateOAuthAccessToken({ tokenHash: grant.tokenHash })).token.expiresAt, originalExpiry);
  const extended = new Date(Date.now() + 30 * 86400000).toISOString();
  assert.equal(await repository.updateReportingSession({ ...grant.key, expiresAt: extended }), true);
  assert.equal(await repository.updateReportingSession({ ...grant.key, expiresAt: originalExpiry }), true);
  assert.equal((await repository.authenticateOAuthAccessToken({ tokenHash: grant.tokenHash })).token.expiresAt, extended);

  await pool.end(); pool = mysql.createPool(config); repository = createMysqlPlatformRepository({ pool });
  assert.equal((await repository.authenticateOAuthAccessToken({ tokenHash: grant.tokenHash })).token.expiresAt, extended);
  assert.equal(await repository.updateReportingSession({ ...grant.key, applicationId: 'wrong-application', expiresAt: extended }), false);
  assert.equal(await repository.updateReportingSession({ ...grant.key, tenantId: randomUUID(), expiresAt: extended }), false);
  assert.equal(await repository.updateReportingSession({ ...grant.key, revoke: true }), true);
  assert.equal(await repository.authenticateOAuthAccessToken({ tokenHash: grant.tokenHash }), null);
  assert.equal(await repository.updateReportingSession({ ...grant.key, expiresAt: extended }), false);

  for (const interval of ['NOW(3)', 'DATE_SUB(NOW(3), INTERVAL 1 MICROSECOND)']) {
    const expired = await make(extended);
    await pool.execute(`UPDATE platform_oauth_tokens SET expires_at=${interval} WHERE id=?`, [expired.token.id]);
    assert.equal(await repository.authenticateOAuthAccessToken({ tokenHash: expired.tokenHash }), null);
    assert.equal(await repository.updateReportingSession({ ...expired.key, expiresAt: extended }), false);
  }
  const fresh = await make(extended);
  await pool.execute('UPDATE platform_oauth_tokens SET expires_at=DATE_ADD(NOW(3), INTERVAL 10 SECOND) WHERE id=?', [fresh.token.id]);
  assert.equal(await repository.updateReportingSession({ ...fresh.key, expiresAt: extended }), true);

  const concurrent = await make(extended);
  const results = await Promise.all([
    repository.updateReportingSession({ ...concurrent.key, expiresAt: extended }),
    repository.updateReportingSession({ ...concurrent.key, revoke: true }),
  ]);
  assert.equal(results[1], true);
  assert.equal(await repository.authenticateOAuthAccessToken({ tokenHash: concurrent.tokenHash }), null);
  assert.equal(await repository.updateReportingSession({ ...concurrent.key, expiresAt: extended }), false);

  const disabled = await make(extended);
  await pool.execute('UPDATE platform_oauth_applications SET enabled=0 WHERE id=?', [application.id]);
  assert.equal(await repository.updateReportingSession({ ...disabled.key, expiresAt: extended }), false);
  assert.equal(await repository.authenticateOAuthAccessToken({ tokenHash: disabled.tokenHash }), null);
});

test('MySQL Odin mail registry rolls back failures and deduplicates enqueue and delivery retry', { skip: !enabled }, async t => {
  assert.match(process.env.BUGREPORTER_TEST_MYSQL_HOST ?? '', /^172\.\d+\.\d+\.\d+$/);
  const config = { host:process.env.BUGREPORTER_TEST_MYSQL_HOST,user:'reporter_test',password:'synthetic-reporting-test-password',database:'bugreporter_session_validation',connectionLimit:4 };
  let pool=mysql.createPool(config), repository=createMysqlMailRepository({pool});t.after(async()=>pool.end());
  const input={recipientEmail:'tester@example.test',subject:'Synthetic reporting key',body:'<p>A synthetic reporting key.</p>',templateId:'bug-reporter-key-v1',targetId:'bugreporter:'+createHash('sha256').update(randomUUID()).digest('hex'),requestHash:'b'.repeat(64),retryVersion:0};
  const rejected={...input,targetId:input.targetId+'bad',subject:'x'.repeat(300)};
  await assert.rejects(repository.queueReportingMail(rejected));
  assert.equal((await pool.execute('SELECT COUNT(*) AS count FROM bug_reporter_mail_deliveries WHERE target_id=?',[rejected.targetId]))[0][0].count,0);
  const results=await Promise.all([repository.queueReportingMail(input),repository.queueReportingMail(input)]);assert.ok(results.every(value=>value.status==='queued'));
  assert.equal((await pool.execute('SELECT COUNT(*) AS count FROM mail_queue WHERE mail_target_id=?',[input.targetId]))[0][0].count,1);
  await pool.end();pool=mysql.createPool(config);repository=createMysqlMailRepository({pool});
  assert.equal((await repository.queueReportingMail(input)).status,'queued');
  assert.equal((await repository.queueReportingMail({...input,requestHash:'c'.repeat(64)})).conflict,true);
  const delivered=[],transport={async sendMail(message){delivered.push(message);return {messageId:'synthetic-mysql-delivery'};}};
  const deliverBatch=selected=>processMailQueueBatch({mailRepository:repository,env:{mailFromAddress:'odin@example.test',mailFromName:'Odin fixture'},transport:selected});
  assert.equal((await deliverBatch(transport)).sent,1);assert.equal((await repository.getReportingMail({targetId:input.targetId})).status,'sent');assert.equal((await repository.queueReportingMail(input)).status,'sent');assert.equal((await deliverBatch(transport)).processed,0);assert.equal(delivered.length,1);
  const failed={...input,targetId:input.targetId+'retry'};await repository.queueReportingMail(failed);
  for(let attempt=0;attempt<4;attempt++)await deliverBatch({async sendMail(){throw new Error('Synthetic provider unavailable');}});
  assert.equal((await repository.getReportingMail({targetId:failed.targetId})).status,'failed');
  await pool.execute('DELETE FROM email_opt_out WHERE email=?',[input.recipientEmail]);
  const retried=await Promise.all([repository.queueReportingMail({...failed,retryVersion:1}),repository.queueReportingMail({...failed,retryVersion:1})]);assert.ok(retried.every(value=>value.status==='queued'&&value.retryVersion===1));
  assert.equal((await deliverBatch(transport)).sent,1);assert.equal((await deliverBatch(transport)).processed,0);assert.equal(delivered.length,2);
  assert.equal((await pool.execute('SELECT COUNT(*) AS count FROM mail_queue WHERE mail_target_id=?',[failed.targetId]))[0][0].count,1);
});
