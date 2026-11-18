import assert from 'node:assert/strict';
import test from 'node:test';

import { createErpConnectorTransport } from '../src/modules/connectors/connector-erp-transport.js';
import { processConnectorErpPostingBatch } from '../src/modules/connectors/connector-erp-worker.js';
import { createInMemoryConnectorRepository } from '../src/modules/connectors/connector.repository.js';
import { createInMemoryResourceFinanceRepository } from '../src/modules/resource-finance/resource-finance.repository.js';

const entry = { amount: 1250, category: 'Implementation accrual', currency: 'USD', effectiveDate: '2026-07-11', id: 'entry-1', note: 'July delivery', projectId: 'project-1' };

test('ERP transport emits provider-native idempotent NetSuite and SAP journal requests and reconciles by external id', async () => {
  for (const provider of ['netsuite', 'sap_s4hana']) {
    const requests = []; const transport = createErpConnectorTransport({ request: async (input) => { requests.push(input); return input.method === 'POST' ? { body: provider === 'netsuite' ? { id: 'J-100' } : { AccountingDocument: 'J-100' }, headers: {}, status: 201 } : { body: { status: 'posted' }, headers: {}, status: 200 }; }, secretResolver: async () => JSON.stringify({ accessToken: 'provider-token' }) });
    const connection = { authType: 'oauth2', id: 'connection-1', provider, secretReference: 'vault:erp', settings: provider === 'netsuite' ? { accountId: 'acme_1', debitAccountId: '6000' } : { baseUrl: 'https://acme.s4hana.ondemand.com', companyCode: '1000', glAccount: '6000' }, tenantId: 'tenant-1' };
    const result = await transport.postAndReconcile({ connection, financialEntry: entry, idempotencyKey: 'posting-entry-1' });
    assert.equal(result.externalId, 'J-100'); assert.equal(result.reconciliation.matched, true); assert.equal(requests.length, 2); assert.equal(requests[0].headers.authorization, 'Bearer provider-token'); assert.equal(requests[0].headers['idempotency-key'], 'posting-entry-1'); assert.equal(requests[1].method, 'GET'); assert.match(requests[1].url, /J-100$/);
    if (provider === 'netsuite') assert.equal(requests[0].body.line.item[0].debit, 1250); else assert.equal(requests[0].body.to_JournalEntryItem[0].AmountInTransactionCurrency, 1250);
  }
});

test('ERP worker fences delivery, marks the approved ledger posted, and persists reconciliation evidence', async () => {
  const repository = createInMemoryConnectorRepository(); const finance = createInMemoryResourceFinanceRepository(); const tenantId = 'tenant-1';
  const connection = await repository.createConnection({ inboundSecretHash: 'unused', input: { authType: 'pat', conflictPolicy: 'manual', name: 'NetSuite', projectIds: ['project-1'], provider: 'netsuite', scopes: ['journal_entries'], secretReference: 'env:NETSUITE_TOKEN', settings: { accountId: 'acme_1' }, status: 'active', syncDirection: 'outbound' }, tenantId, userId: 'admin' });
  const financialEntry = await finance.createFinancialEntry({ input: { ...entry, entryKind: 'actual_cost', sourceId: null, sourceType: 'manual', status: 'approved' }, tenantId });
  const created = await repository.createErpPosting({ connectionId: connection.id, financialEntry, idempotencyKey: 'posting-entry-1', tenantId, userId: 'admin' }); assert.equal(created.duplicate, false); assert.equal((await repository.createErpPosting({ connectionId: connection.id, financialEntry, idempotencyKey: 'posting-entry-1', tenantId, userId: 'admin' })).duplicate, true);
  const results = await processConnectorErpPostingBatch({ now: new Date('2030-07-11T12:00:00.000Z'), repository, resourceFinanceRepository: finance, transport: { async postAndReconcile() { return { externalId: 'J-100', reconciliation: { matched: true, providerStatus: 'posted' } }; } }, workerId: 'worker-1' });
  assert.deepEqual(results.map((item) => item.status), ['reconciled']); const snapshot = await repository.listSnapshot({ tenantId }); assert.equal(snapshot.postings[0].externalId, 'J-100'); assert.equal(snapshot.postings[0].status, 'reconciled'); assert.equal((await finance.listSnapshot({ tenantId })).financialEntries[0].status, 'posted');
});
