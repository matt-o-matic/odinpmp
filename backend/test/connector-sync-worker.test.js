import assert from 'node:assert/strict';
import test from 'node:test';

import { createInMemoryConnectorRepository } from '../src/modules/connectors/connector.repository.js';
import { createConnectorSyncTransport } from '../src/modules/connectors/connector-sync-transport.js';
import { processConnectorSyncBatch } from '../src/modules/connectors/connector-sync-worker.js';

const providerCases = [
  ['jira', { projectKey: 'ODIN' }, { issues: [{ id: '1', fields: { summary: 'Issue' } }], nextPageToken: 'next' }],
  ['azure_devops', { organization: 'acme', project: 'odin' }, { workItems: [{ id: '1', title: 'Work' }] }],
  ['github', { owner: 'acme', repository: 'odin' }, [{ id: '1', title: 'Issue' }]],
  ['gitlab', { projectId: '1' }, [{ id: '1', title: 'Issue' }]],
  ['slack', { channelId: 'C1' }, { messages: [{ event_id: '1', text: 'Update' }], response_metadata: { next_cursor: 'next' } }],
  ['microsoft_teams', { channelId: 'C1', teamId: 'T1' }, { value: [{ id: '1', body: { content: 'Update' } }] }],
  ['google_calendar', { calendarId: 'primary' }, { items: [{ id: '1', summary: 'Review' }], nextPageToken: 'next' }],
  ['microsoft_calendar', {}, { value: [{ id: '1', subject: 'Review' }] }],
  ['google_drive', {}, { files: [{ id: '1', name: 'Plan' }], nextPageToken: 'next' }],
  ['microsoft_sharepoint', { siteId: 'S1' }, { value: [{ id: '1', name: 'Plan' }] }],
];

test('sync transport owns authenticated polling and outbound protocol contracts for every priority non-ERP provider', async () => {
  for (const [provider, settings, pollBody] of providerCases) {
    const requests = []; const transport = createConnectorSyncTransport({ request: async (input) => { requests.push(input); return { body: input.method === 'GET' || (provider === 'azure_devops' && requests.length === 1) ? pollBody : { id: 'created-1' }, headers: {}, status: 200 }; }, secretResolver: async () => 'provider-token' }); const connection = { authType: 'pat', id: 'connection-1', provider, secretReference: 'env:PROVIDER_TOKEN', settings, tenantId: 'tenant-1' };
    const page = await transport.poll({ connection, cursor: null }); assert.equal(page.records.length, 1); assert.equal(requests[0].headers.authorization, 'Bearer provider-token');
    await transport.pushProject({ connection, idempotencyKey: `push-${provider}`, project: { description: 'Delivery', endDate: '2026-12-31', id: 'project-1', name: 'Odin', startDate: '2026-01-01', status: 'active' } }); assert.equal(requests[1].headers['idempotency-key'], `push-${provider}`); assert.ok(['POST', 'PUT'].includes(requests[1].method));
  }
});

test('sync worker leases inbound and outbound runs, persists normalized events, and advances the connection cursor', async () => {
  const repository = createInMemoryConnectorRepository(); const tenantId = 'tenant-1'; const connection = await repository.createConnection({ inboundSecretHash: 'unused', input: { authType: 'pat', conflictPolicy: 'manual', name: 'GitHub', projectIds: ['project-1'], provider: 'github', scopes: ['issues'], secretReference: 'env:GITHUB_TOKEN', settings: { owner: 'acme', repository: 'odin' }, status: 'active', syncDirection: 'bidirectional' }, tenantId, userId: 'admin' });
  await repository.createSyncRun({ connectionId: connection.id, direction: 'inbound', idempotencyKey: 'inbound-run-1', tenantId }); const pushed = [];
  const projectRepository = { async getProjectDetail() { return { description: 'Delivery', id: 'project-1', name: 'Odin', status: 'active' }; } }; const transport = { async poll() { return { cursor: 'page-2', records: [{ id: 'issue-1', title: 'Risk' }] }; }, async pushProject(input) { pushed.push(input); return { externalId: 'created-1' }; } };
  assert.deepEqual((await processConnectorSyncBatch({ now: new Date('2030-01-01T00:00:00Z'), projectRepository, repository, transport, workerId: 'worker-1' })).map((item) => item.status), ['completed']); let snapshot = await repository.listSnapshot({ tenantId }); assert.equal(snapshot.events.length, 1); assert.equal(snapshot.runs[0].cursorAfter, 'page-2'); assert.equal(snapshot.connections[0].cursor, 'page-2');
  await repository.createSyncRun({ connectionId: connection.id, direction: 'outbound', idempotencyKey: 'outbound-run-1', tenantId }); assert.deepEqual((await processConnectorSyncBatch({ now: new Date('2030-01-01T00:01:00Z'), projectRepository, repository, transport, workerId: 'worker-1' })).map((item) => item.status), ['completed']); assert.equal(pushed.length, 1); assert.equal(pushed[0].idempotencyKey, 'outbound-run-1:project-1');
});
