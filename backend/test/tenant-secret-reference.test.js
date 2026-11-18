import assert from 'node:assert/strict';
import test from 'node:test';

import { assertTenantSecretReference, resolveTenantSecretReference, tenantSecretPrefix } from '../src/lib/secrets/tenant-secret-reference.js';
import { createConnectorCredentialVault } from '../src/modules/connectors/connector-oauth.js';
import { createConnectorSyncTransport } from '../src/modules/connectors/connector-sync-transport.js';
import { createConnectorConnectionForUser } from '../src/modules/connectors/connector.service.js';
import { createEnterpriseOidcService } from '../src/modules/identity/oidc.service.js';
import { saveIdentityPolicyForUser } from '../src/modules/identity/identity.service.js';

// A workspace admin must not be able to make Odin send a server setting, or another
// workspace's secret, to an identity provider or API host the admin controls.

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const OWN = 'ODIN_TENANT_11111111111141118111111111111111_OIDC_SECRET';
const OTHERS = 'ODIN_TENANT_22222222222242228222222222222222_OIDC_SECRET';
const env = { DATABASE_URL: 'mysql://root:pw@db/odin', JWT_SECRET: 'server-signing-secret', [OTHERS]: 'other-workspace-secret', [OWN]: 'own-secret' };
const admin = { id: 'admin-1', memberships: [{ role: 'admin', tenantId: TENANT }] };

test('the prefix is the tenant id without dashes, so two workspaces never share one', () => {
  assert.equal(tenantSecretPrefix(TENANT), 'ODIN_TENANT_11111111111141118111111111111111_');
  assert.notEqual(tenantSecretPrefix(TENANT), tenantSecretPrefix(OTHER_TENANT));
  assert.throws(() => tenantSecretPrefix(''), /needs a workspace/);
});

test('a workspace resolves only variables under its own prefix', () => {
  assert.equal(resolveTenantSecretReference(`env:${OWN}`, { env, tenantId: TENANT }), 'own-secret');
  assert.equal(resolveTenantSecretReference('', { env, tenantId: TENANT }), '');
  assert.equal(resolveTenantSecretReference(`env:${OWN}_UNSET`, { env, tenantId: TENANT }), '');
  for (const reference of ['env:JWT_SECRET', 'env:DATABASE_URL', `env:${OTHERS}`, 'env:ODIN_TENANT_11111111111141118111111111111111_', 'vault://connectors/github', OWN]) {
    assert.throws(() => resolveTenantSecretReference(reference, { env, tenantId: TENANT }), (error) => error.statusCode === 503, reference);
    assert.throws(() => assertTenantSecretReference(reference, { tenantId: TENANT }), (error) => error.statusCode === 400 && error.message.includes(tenantSecretPrefix(TENANT)), reference);
  }
  assert.doesNotThrow(() => assertTenantSecretReference(`env:${OWN}`, { tenantId: TENANT }));
  assert.doesNotThrow(() => assertTenantSecretReference('', { tenantId: TENANT }));
});

test('saving an SSO policy that names a server setting is refused before it is stored', async () => {
  const repository = { async upsertPolicy() { throw new Error('must not store'); } };
  for (const field of ['secretReference', 'spSigningKeyReference', 'spSigningCertReference', 'decryptionKeyReference']) {
    await assert.rejects(
      saveIdentityPolicyForUser({ input: { loginEnforcement: 'optional', provider: { issuer: 'https://idp.attacker.example', [field]: 'env:JWT_SECRET' }, ssoMode: 'oidc' }, repository, user: admin }),
      (error) => error.statusCode === 400,
      field,
    );
  }
});

test('an OIDC policy stored before the fix cannot send a server setting to the identity provider', async () => {
  const previous = process.env.JWT_SECRET; process.env.JWT_SECRET = 'server-signing-secret';
  const discovered = [];
  const service = createEnterpriseOidcService({
    callbackBaseUrl: 'https://odin.example',
    identityRepository: {
      async getPolicy() { return { provider: { clientId: 'client', issuer: 'https://idp.attacker.example', secretReference: 'env:JWT_SECRET' }, ssoMode: 'oidc', version: 1 }; },
      async listSnapshot() { return { domains: [{ domain: 'attacker.example', status: 'verified' }], groups: [] }; },
    },
    oidcClient: { async discovery(...args) { discovered.push(args); return {}; } },
  });
  try {
    await assert.rejects(service.begin({ tenantId: TENANT }), (error) => error.statusCode === 503);
    assert.deepEqual(discovered, []);
  } finally {
    if (previous === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous;
  }
});

test('a connector cannot be saved with, or send, a server setting as its credential', async () => {
  await assert.rejects(
    createConnectorConnectionForUser({ input: { authType: 'pat', projectIds: [], provider: 'jira', secretReference: 'env:DATABASE_URL' }, projectRepository: {}, repository: {}, user: admin }),
    (error) => error.statusCode === 400,
  );

  const previous = process.env.DATABASE_URL; process.env.DATABASE_URL = 'mysql://root:pw@db/odin';
  const sent = [];
  try {
    const vault = createConnectorCredentialVault({ encryptionKey: 'vault-encryption-key-that-is-at-least-32-bytes', repository: { async getOAuthCredential() { return null; } } });
    await assert.rejects(vault.resolve('env:DATABASE_URL', { connectionId: 'connection-1', tenantId: TENANT }), (error) => error.statusCode === 503);
    assert.throws(() => vault.resolveClientSecret('env:DATABASE_URL', { tenantId: TENANT }), (error) => error.statusCode === 503);

    const transport = createConnectorSyncTransport({ async request(input) { sent.push(input); return { body: [], headers: {}, status: 200 }; } });
    await assert.rejects(transport.poll({ connection: { id: 'connection-1', provider: 'github', secretReference: 'env:DATABASE_URL', settings: { repository: 'acme/app' }, tenantId: TENANT }, cursor: null }), (error) => error.statusCode === 503);
    assert.deepEqual(sent, []);
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
  }
});
