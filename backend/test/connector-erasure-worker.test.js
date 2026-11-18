import assert from 'node:assert/strict';
import test from 'node:test';

import { createConnectorErasureTransport } from '../src/modules/connectors/connector-erasure-transport.js';
import { processConnectorErasureBatch } from '../src/modules/connectors/connector-erasure-worker.js';
import { createInMemoryConnectorRepository } from '../src/modules/connectors/connector.repository.js';

const cases = [
  ['jira', { baseUrl: 'https://acme.atlassian.net' }], ['azure_devops', { organization: 'acme' }], ['github', { organization: 'acme' }], ['gitlab', {}], ['slack', { teamId: 'T1' }], ['microsoft_teams', {}], ['google_calendar', {}], ['microsoft_calendar', {}], ['google_drive', {}], ['microsoft_sharepoint', {}], ['netsuite', { accountId: 'acme', baseUrl: 'https://acme.suitetalk.api.netsuite.com' }], ['sap_s4hana', { baseUrl: 'https://acme.s4hana.ondemand.com' }],
];

test('connector erasure transport owns authenticated provider lifecycle contracts for every adapter', async () => {
  for (const [provider, settings] of cases) { const requests = []; const transport = createConnectorErasureTransport({ request: async (input) => { requests.push(input); return { headers: { 'x-request-id': 'request-1' }, status: 204 }; }, secretResolver: async () => 'provider-token' }); const evidence = await transport.eraseSubject({ connection: { id: 'connection-1', provider, secretReference: 'env:TOKEN', settings, tenantId: 'tenant-1' }, externalSubjectId: 'external-user-1' }); assert.equal(evidence.providerStatus, 'accepted'); assert.equal(requests[0].headers.authorization, 'Bearer provider-token'); assert.match(`${requests[0].url} ${JSON.stringify(requests[0].body ?? {})}`, /external-user-1/); }
});

test('connector erasure worker leases, fences, and records provider completion evidence', async () => {
  const repository = createInMemoryConnectorRepository(); const tenantId = 'tenant-1'; const connection = await repository.createConnection({ inboundSecretHash: 'unused', input: { authType: 'oauth2', conflictPolicy: 'manual', name: 'GitHub', projectIds: ['project-1'], provider: 'github', scopes: ['admin:org'], secretReference: 'env:GITHUB_TOKEN', settings: { organization: 'acme' }, status: 'active', syncDirection: 'bidirectional' }, tenantId, userId: 'admin' }); const created = await repository.enqueueProviderErasure({ connectionId: connection.id, externalSubjectId: 'external-user-1', subjectHash: 'a'.repeat(64), tenantId }); assert.equal(created.duplicate, false); assert.equal((await repository.enqueueProviderErasure({ connectionId: connection.id, externalSubjectId: 'external-user-1', subjectHash: 'a'.repeat(64), tenantId })).duplicate, true);
  const result = await processConnectorErasureBatch({ now: new Date('2030-01-01T00:00:00Z'), repository, transport: { async eraseSubject() { return { providerStatus: 'accepted', requestId: 'request-1' }; } }, workerId: 'worker-1' }); assert.deepEqual(result.map((item) => item.status), ['completed']); const snapshot = await repository.listSnapshot({ tenantId }); assert.equal(snapshot.erasures[0].providerEvidence.requestId, 'request-1'); assert.equal(snapshot.erasures[0].status, 'completed');
});
