import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import { createInMemoryIdentityRepository } from '../src/modules/identity/identity.repository.js';
import { createEnterpriseSamlService } from '../src/modules/identity/saml.service.js';

test('real node-saml integration rejects unsigned responses and consumes RelayState once', async () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const repository = createInMemoryIdentityRepository();
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const idpCertificate = publicKey.export({ format: 'pem', type: 'spki' });
  const domain = await repository.createDomain({ input: { domain: 'example.com', verificationMethod: 'manual' }, tenantId, tokenHash: 'a'.repeat(64) });
  await repository.updateDomain({ domainId: domain.id, input: { expectedVersion: 1, status: 'verified', verifiedAt: new Date().toISOString() }, tenantId });
  await repository.upsertPolicy({
    input: {
      defaultRoleKey: 'user', expectedVersion: 0, jitEnabled: true, loginEnforcement: 'required',
      provider: { audience: 'https://odin.example.com/saml/metadata', emailAttribute: 'email', entryPoint: 'https://id.example.com/saml/login', groupsAttribute: 'groups', idpCertificate, issuer: 'https://id.example.com/saml' },
      ssoMode: 'saml',
    },
    tenantId,
    updatedBy: 'admin-1',
  });
  const service = createEnterpriseSamlService({
    authRepository: {}, callbackBaseUrl: 'http://localhost:3001', identityRepository: repository,
    sessionsRepository: {}, tenantsRepository: {}, tokenService: {},
  });
  const authorizeUrl = new URL(await service.begin({ redirect: '/projects', tenantId }));
  const relayState = authorizeUrl.searchParams.get('RelayState');
  const transaction = [...repository.state.samlTransactions.values()][0];
  assert.ok(relayState); assert.ok(transaction.requestId); assert.match(authorizeUrl.searchParams.get('SAMLRequest'), /.+/);

  const unsignedResponse = Buffer.from(`<?xml version="1.0"?><samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_response" Version="2.0" IssueInstant="${new Date().toISOString()}" InResponseTo="${transaction.requestId}" Destination="http://localhost:3001/api/auth/sso/saml/callback"><saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">https://id.example.com/saml</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status></samlp:Response>`).toString('base64');
  await assert.rejects(service.callback({ body: { RelayState: relayState, SAMLResponse: unsignedResponse } }), /signature|assertion/i);
  await assert.rejects(service.callback({ body: { RelayState: relayState, SAMLResponse: unsignedResponse } }), /RelayState is invalid or expired/);
});
