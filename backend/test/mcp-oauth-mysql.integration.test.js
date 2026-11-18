import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import mysql from 'mysql2/promise';
import { createMysqlMcpOAuthRepository } from '../src/mcp/oauth.repository.js';
import { applyMysqlMigrations } from './helpers/mysql-migrations.js';

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();
const hash = (value) => createHash('sha256').update(value).digest('hex');

test('MySQL MCP OAuth persists grants, serializes races, rolls back failures and revokes applications', { skip: !databaseUrl, timeout: 20_000 }, async () => {
  const target = new URL(databaseUrl);
  assert.equal(target.protocol, 'mysql:');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname), 'MCP database tests require loopback MySQL.');
  assert.match(decodeURIComponent(target.pathname.slice(1)), /^odinpmp_test_[A-Za-z0-9_]+$/, 'MCP database tests require a disposable test schema.');
  const pool = mysql.createPool({ uri: databaseUrl, connectionLimit: 4, connectTimeout: 3000 });
  const repository = createMysqlMcpOAuthRepository(pool);
  const clientId = `test_${randomUUID()}`, applicationId = randomUUID(), tenantId = randomUUID(), userId = randomUUID();
  const resource = 'https://odin.example.test/mcp', now = Date.now();
  const codeHashes = [], familyIds = [];
  function code(expiry = now + 300_000) {
    const record = { codeHash: hash(randomUUID()), clientId, applicationId, tenantId, userId, resource, redirectUri: 'http://127.0.0.1/callback', codeChallenge: 'fixture-challenge', scopes: ['projects.read'], projectIds: [], expiresAt: new Date(expiry).toISOString(), consumedAt: null };
    codeHashes.push(record.codeHash); return record;
  }
  function family() {
    const record = { id: randomUUID(), clientId, applicationId, tenantId, userId, resource, scopes: ['projects.read'], projectIds: [], expiresAt: new Date(now + 30 * 86400_000).toISOString(), revokedAt: null };
    familyIds.push(record.id); return record;
  }
  function tokens(grant) {
    return ['access', 'refresh'].map((kind) => ({ tokenHash: hash(randomUUID()), familyId: grant.id, kind, scopes: ['projects.read'], expiresAt: kind === 'access' ? new Date(now + 3600_000).toISOString() : grant.expiresAt, consumedAt: null }));
  }
  try {
    await applyMysqlMigrations(pool, ['0086_mcp_oauth']);
    await repository.createClient({ clientId, applicationId, tenantId, scopes: ['projects.read'], redirectUris: ['http://127.0.0.1/callback'] });
    const fresh = createMysqlMcpOAuthRepository(pool);
    assert.equal((await fresh.getClient(clientId)).applicationId, applicationId);
    const authorization = code(), grantA = family(), grantB = family(), tokensA = tokens(grantA), tokensB = tokens(grantB);
    await repository.createCode(authorization);
    const expected = { clientId, resource, redirectUri: authorization.redirectUri, codeChallenge: authorization.codeChallenge };
    const races = await Promise.all([
      repository.redeemCode({ codeHash: authorization.codeHash, expected, family: grantA, tokens: tokensA, now }),
      fresh.redeemCode({ codeHash: authorization.codeHash, expected, family: grantB, tokens: tokensB, now }),
    ]);
    assert.equal(races.filter(Boolean).length, 1);
    const winningGrant = races[0] ? grantA : grantB, winningTokens = races[0] ? tokensA : tokensB;
    const access = winningTokens.find((token) => token.kind === 'access'), refresh = winningTokens.find((token) => token.kind === 'refresh');
    assert.equal((await fresh.getToken(access.tokenHash)).family.userId, userId);
    const rotatedA = tokens(winningGrant), rotatedB = tokens(winningGrant);
    const rotations = await Promise.all([
      repository.rotateRefresh({ tokenHash: refresh.tokenHash, clientId, resource, tokens: rotatedA, now: now + 1 }),
      fresh.rotateRefresh({ tokenHash: refresh.tokenHash, clientId, resource, tokens: rotatedB, now: now + 1 }),
    ]);
    assert.equal(rotations.filter(Boolean).length, 1);
    assert.ok((await fresh.getToken(access.tokenHash)).family.revokedAt, 'A concurrent refresh replay must revoke the winning family.');

    const rollbackCode = code(), rollbackFamily = family(); await repository.createCode(rollbackCode);
    const duplicates = [{ ...access, familyId: rollbackFamily.id }];
    await assert.rejects(repository.redeemCode({ codeHash: rollbackCode.codeHash, expected, family: rollbackFamily, tokens: duplicates, now }));
    assert.equal((await repository.getCode(rollbackCode.codeHash)).consumedAt, null);
    assert.equal((await pool.execute('SELECT id FROM mcp_oauth_families WHERE id = ?', [rollbackFamily.id]))[0].length, 0);
    const recoveredTokens = tokens(rollbackFamily);
    assert.equal(await repository.redeemCode({ codeHash: rollbackCode.codeHash, expected, family: rollbackFamily, tokens: recoveredTokens, now }), true);

    const expired = code(now); await repository.createCode(expired);
    assert.equal(await repository.redeemCode({ codeHash: expired.codeHash, expected, family: family(), tokens: [], now }), false);
    const outstanding = code(); await repository.createCode(outstanding);
    await repository.revokeApplication({ applicationId, tenantId: randomUUID(), now: now + 2 });
    assert.equal((await fresh.getToken(recoveredTokens[0].tokenHash)).family.revokedAt, null);
    await repository.revokeApplication({ applicationId, tenantId, now: now + 3 });
    assert.ok((await fresh.getToken(recoveredTokens[0].tokenHash)).family.revokedAt);
    assert.ok((await fresh.getCode(outstanding.codeHash)).revokedAt);
    assert.equal(await fresh.redeemCode({ codeHash: outstanding.codeHash, expected, family: family(), tokens: [], now: now + 4 }), false);
  } finally {
    try {
      for (const id of familyIds) {
        await pool.execute('DELETE FROM mcp_oauth_tokens WHERE family_id = ?', [id]);
        await pool.execute('DELETE FROM mcp_oauth_families WHERE id = ?', [id]);
      }
      for (const codeHash of codeHashes) await pool.execute('DELETE FROM mcp_oauth_codes WHERE code_hash = ?', [codeHash]);
      await pool.execute('DELETE FROM mcp_oauth_clients WHERE client_id = ?', [clientId]);
    } finally { await pool.end(); }
  }
});
