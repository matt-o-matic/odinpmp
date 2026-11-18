import assert from 'node:assert/strict';
import test from 'node:test';

import { createConnectorAdapterRegistry } from '../src/modules/connectors/connector-adapter-registry.js';

test('connector adapter registry owns every priority and ERP provider normalization contract', () => {
  const registry = createConnectorAdapterRegistry();
  assert.equal(registry.size, 12);
  assert.deepEqual(registry.listCatalog().map((item) => item.key), ['jira', 'azure_devops', 'github', 'gitlab', 'slack', 'microsoft_teams', 'google_calendar', 'microsoft_calendar', 'google_drive', 'microsoft_sharepoint', 'netsuite', 'sap_s4hana']);
  const fixtures = [
    ['jira', { id: 'ISSUE-1', fields: { summary: 'Ship launch' }, status: 'open' }, 'work_item'],
    ['azure_devops', { id: 2, title: 'Validate release' }, 'work_item'],
    ['github', { id: 3, title: 'Fix issue' }, 'source_work'],
    ['gitlab', { id: 4, title: 'Merge change' }, 'source_work'],
    ['slack', { channel_id: 'C1', id: 'm1', text: 'Status update' }, 'message'],
    ['microsoft_teams', { body: { content: 'Status update' }, id: 'm2' }, 'message'],
    ['google_calendar', { end: '2026-07-12', id: 'e1', start: '2026-07-11', summary: 'Launch' }, 'calendar_event'],
    ['microsoft_calendar', { end: { dateTime: '2026-07-12' }, id: 'e2', start: { dateTime: '2026-07-11' }, subject: 'Launch' }, 'calendar_event'],
    ['google_drive', { id: 'd1', mimeType: 'application/pdf', name: 'Plan' }, 'document'],
    ['microsoft_sharepoint', { file: { mimeType: 'application/pdf' }, id: 'd2', name: 'Plan' }, 'document'],
    ['netsuite', { amount: 100, currency: 'usd', date: '2026-07-11', id: 'j1', memo: 'Accrual', projectId: 'p1' }, 'journal_entry'],
    ['sap_s4hana', { id: 'j2', postingDate: '2026-07-11', transactionAmount: 200, transactionCurrency: 'EUR' }, 'journal_entry'],
  ];
  for (const [provider, payload, kind] of fixtures) {
    const result = registry.normalizeInbound(provider, { eventType: 'changed', payload });
    assert.equal(result.object.kind, kind);
    assert.equal(result.object.schemaVersion, 'odin.connector-object.v1');
    assert.ok(result.object.externalId);
  }
});

test('connector adapters fail closed when provider payload identity is absent', () => {
  const registry = createConnectorAdapterRegistry();
  assert.throws(() => registry.normalizeInbound('jira', { eventType: 'changed', payload: { title: 'No id' } }), (error) => error.statusCode === 400);
  assert.throws(() => registry.normalizeInbound('unknown', { eventType: 'changed', payload: { id: 1 } }), (error) => error.statusCode === 400);
});
