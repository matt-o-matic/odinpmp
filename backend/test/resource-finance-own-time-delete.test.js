import assert from 'node:assert/strict';
import test from 'node:test';
import { createInMemoryResourceFinanceRepository, createMysqlResourceFinanceRepository } from '../src/modules/resource-finance/resource-finance.repository.js';
import { deleteResourceFinanceForUser } from '../src/modules/resource-finance/resource-finance.service.js';

// A person deleting their own time: the entry must still be theirs and submitted, and its period
// open, when the delete runs, not only when it was checked. Payroll locking the period in between wins.

const TENANT = 'tenant-1';
const member = { id: 'member', memberships: [{ role: 'user', tenantId: TENANT }] };

test('a period locked between the check and the delete keeps the time, in memory', async () => {
  const repository = createInMemoryResourceFinanceRepository();
  const resource = await repository.createResource({ input: { billRate: 0, capacityHoursPerWeek: 40, costRate: 0, currency: 'USD', location: '', minBillRate: null, name: 'Member', poolId: null, roles: [], skills: [], status: 'active', userId: 'member' }, tenantId: TENANT });
  const period = await repository.createTimesheetPeriod({ input: { approvalDueDate: null, endDate: '2026-08-31', name: 'August', startDate: '2026-08-01', status: 'open' }, tenantId: TENANT });
  const entry = await repository.createTimeEntry({ input: { billable: false, hours: 2, note: '', periodId: period.id, projectId: 'project-1', resourceId: resource.id, status: 'submitted', workDate: '2026-08-03', workItemId: null }, tenantId: TENANT });
  const remove = (store, args) => store.deleteTimeEntry({ ...args, timeEntryId: entry.id });
  // Payroll locks August just as the delete reaches the repository.
  const racing = { ...repository, async deleteTimeEntry(args) {
    await repository.updateTimesheetPeriod({ input: { expectedVersion: period.version, status: 'locked' }, tenantId: TENANT, timesheetPeriodId: period.id });
    return repository.deleteTimeEntry(args);
  } };
  await assert.rejects(deleteResourceFinanceForUser({ expectedVersion: entry.version, operation: remove, recordId: entry.id, repository: racing, resourceType: 'time', user: member }), (error) => error.statusCode === 423);
  assert.equal((await repository.listSnapshot({ tenantId: TENANT })).timeEntries.length, 1);
});

// A pool whose statements `answer` replies to by their text, logged in order with BEGIN, COMMIT and ROLLBACK.
function fakePool(answer) {
  const log = [];
  const run = async (sql, params = []) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    log.push(text);
    return answer(text, params) ?? [[]];
  };
  const connection = {
    async beginTransaction() { log.push('BEGIN'); },
    async commit() { log.push('COMMIT'); },
    execute: run,
    query: run,
    release() {},
    async rollback() { log.push('ROLLBACK'); },
  };
  return { log, pool: { execute: run, getConnection: async () => connection, query: run } };
}

test('on MySQL the delete reads the entry and its period under lock, and a locked period keeps the time', async () => {
  for (const status of ['locked', 'open']) {
    const { log, pool } = fakePool((text) => {
      if (text.startsWith('SELECT id, version, resource_id, status, period_id, invoice_claim_id FROM project_time_entries')) return [[{ id: 'time-1', period_id: 'per-1', resource_id: 'res-1', status: 'submitted', version: 1 }]];
      if (text.startsWith('SELECT name, status FROM timesheet_periods')) return [[{ name: 'August', status }]];
      if (text.startsWith('DELETE FROM project_time_entries')) return [{ affectedRows: 1 }];
      return undefined;
    });
    const repository = createMysqlResourceFinanceRepository({ pool });
    const run = repository.deleteTimeEntry({ expectedVersion: 1, ownSubmitted: { resourceId: 'res-1' }, tenantId: TENANT, timeEntryId: 'time-1' });
    const ours = log.length;
    if (status === 'locked') {
      await assert.rejects(run, (error) => error.statusCode === 423);
      assert.ok(log.slice(ours).includes('ROLLBACK'));
      assert.ok(!log.some((line) => line.startsWith('DELETE FROM project_time_entries')));
    } else {
      assert.equal(await run, true);
      const tail = log.slice(log.indexOf('BEGIN'));
      assert.deepEqual(tail.map((line) => line.split(' ').slice(0, 2).join(' ')), ['BEGIN', 'SELECT id,', 'SELECT name,', 'DELETE FROM', 'COMMIT']);
      assert.match(tail[1], /FOR UPDATE$/);
      assert.match(tail[2], /FOR UPDATE$/);
    }
  }
});

test('on MySQL someone else\'s or approved time is not deleted as one\'s own', async () => {
  for (const row of [{ resource_id: 'res-other', status: 'submitted' }, { resource_id: 'res-1', status: 'approved' }]) {
    const { log, pool } = fakePool((text) => (text.startsWith('SELECT id, version, resource_id, status, period_id, invoice_claim_id FROM project_time_entries') ? [[{ id: 'time-1', period_id: null, version: 1, ...row }]] : undefined));
    assert.equal(await createMysqlResourceFinanceRepository({ pool }).deleteTimeEntry({ expectedVersion: 1, ownSubmitted: { resourceId: 'res-1' }, tenantId: TENANT, timeEntryId: 'time-1' }), false);
    assert.ok(!log.some((line) => line.startsWith('DELETE FROM project_time_entries')));
  }
});
