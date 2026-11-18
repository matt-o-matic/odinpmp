import assert from 'node:assert/strict';
import test from 'node:test';

import { assertRecordsNotHeld } from '../src/modules/compliance/legal-hold.js';
import { createInMemoryComplianceRepository } from '../src/modules/compliance/compliance.repository.js';
import { createInMemoryReportingRepository } from '../src/modules/reporting/reporting.repository.js';
import { deleteReportingRecordForUser } from '../src/modules/reporting/reporting.service.js';
import { deleteResourceFinanceForUser } from '../src/modules/resource-finance/resource-finance.service.js';

const tenantId = 'tenant-1';
const manager = { id: 'manager', memberships: [{ role: 'manager', tenantId }] };

test('record-scoped holds block report deletion until explicitly released', async () => {
  const complianceRepository = createInMemoryComplianceRepository();
  const reportingRepository = createInMemoryReportingRepository();
  const report = await reportingRepository.createReport({
    input: { columns: ['projectId'], dataset: 'project', name: 'Held report', visibility: 'tenant' },
    ownerUserId: manager.id,
    tenantId,
  });
  const hold = await complianceRepository.createLegalHold({
    input: { reason: 'Preserve this report for active litigation.', resourceId: report.id, resourceType: 'report' },
    tenantId,
    userId: 'admin',
  });

  await assert.rejects(deleteReportingRecordForUser({
    complianceRepository,
    expectedVersion: 1,
    id: report.id,
    kind: 'report',
    repository: reportingRepository,
    user: manager,
  }), (error) => error.statusCode === 423 && error.details?.code === 'record_legal_hold_active');

  await complianceRepository.releaseLegalHold({ expectedVersion: 1, holdId: hold.id, reason: 'The preservation duty has ended.', tenantId, userId: 'admin' });
  assert.deepEqual(await deleteReportingRecordForUser({ complianceRepository, expectedVersion: 1, id: report.id, kind: 'report', repository: reportingRepository, user: manager }), { ok: true });
});

test('financial and file destruction honor record and tenant legal holds', async () => {
  const complianceRepository = createInMemoryComplianceRepository();
  const financialHold = await complianceRepository.createLegalHold({
    input: { reason: 'Preserve the source financial entry.', resourceId: 'entry-1', resourceType: 'financial_entry' },
    tenantId,
    userId: 'admin',
  });
  let deleted = false;
  await assert.rejects(deleteResourceFinanceForUser({
    complianceRepository,
    expectedVersion: 1,
    operation: async () => { deleted = true; return true; },
    recordId: 'entry-1',
    repository: {},
    resourceType: 'financial',
    user: manager,
  }), (error) => error.statusCode === 423 && error.details?.resourceType === 'financial_entry');
  assert.equal(deleted, false);

  await complianceRepository.releaseLegalHold({ expectedVersion: 1, holdId: financialHold.id, reason: 'The preservation duty has ended.', tenantId, userId: 'admin' });
  assert.deepEqual(await deleteResourceFinanceForUser({ complianceRepository, expectedVersion: 1, operation: async () => true, recordId: 'entry-1', repository: {}, resourceType: 'financial', user: manager }), { ok: true });

  await complianceRepository.updatePolicy({ input: { auditRetentionDays: 365, dataRegion: 'us', expectedVersion: 0, legalHold: true, privacyDeletionDays: 30, wormRetentionDays: 365 }, tenantId, userId: 'admin' });
  await assert.rejects(assertRecordsNotHeld({ repository: complianceRepository, resources: [{ resourceId: 'file-1', resourceType: 'file' }], tenantId }), (error) => error.statusCode === 423 && error.details?.code === 'tenant_legal_hold_active');
});
