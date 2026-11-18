import { randomUUID } from 'node:crypto';

export async function processConnectorErpPostingBatch({ leaseMs = 30_000, limit = 20, maxAttempts = 8, now = new Date(), repository, resourceFinanceRepository, transport, workerId = `connector-erp-${randomUUID()}` } = {}) {
  const claimed = await repository.claimErpPostings({ leaseMs, limit, now, workerId }); const results = [];
  for (const { connection, posting } of claimed) {
    try {
      const snapshot = await resourceFinanceRepository.listSnapshot({ tenantId: posting.tenantId }); const entry = snapshot.financialEntries.find((item) => item.id === posting.financialEntryId);
      if (!entry) throw new Error('Financial ledger entry no longer exists.'); if (!['approved', 'posted'].includes(entry.status)) throw new Error('Financial ledger entry is not approved for ERP posting.');
      const delivered = await transport.postAndReconcile({ connection, financialEntry: entry, idempotencyKey: posting.idempotencyKey });
      if (entry.status !== 'posted') await resourceFinanceRepository.updateFinancialEntry({ financialEntryId: entry.id, input: { expectedVersion: entry.version, status: 'posted' }, tenantId: posting.tenantId });
      const completed = await repository.completeErpPosting({ externalId: delivered.externalId, leaseToken: posting.leaseToken, now, postingId: posting.id, reconciliation: delivered.reconciliation, workerId }); results.push({ externalId: delivered.externalId, postingId: posting.id, status: completed ? delivered.reconciliation.matched ? 'reconciled' : 'delivered' : 'lease_lost' });
    } catch (error) { const availableAt = new Date(now.getTime() + Math.min(300_000, 2_000 * (2 ** Math.max(0, posting.attempts - 1)))); const failed = await repository.failErpPosting({ availableAt, error: error?.message ?? error, leaseToken: posting.leaseToken, maxAttempts, now, postingId: posting.id, workerId }); results.push({ error: error?.message ?? String(error), postingId: posting.id, status: failed ? posting.attempts >= maxAttempts ? 'dead' : 'retry' : 'lease_lost' }); }
  }
  return results;
}

export function startConnectorErpWorker({ intervalMs = 1_000, onError = () => {}, repository, resourceFinanceRepository, transport, workerId = `connector-erp-${process.pid}` } = {}) {
  let inFlight = false; let stopped = false; const idleWaiters = new Set(); const poll = async () => { if (stopped || inFlight) return []; inFlight = true; try { return await processConnectorErpPostingBatch({ repository, resourceFinanceRepository, transport, workerId }); } catch (error) { onError(error); return []; } finally { inFlight = false; for (const resolve of idleWaiters) resolve(true); idleWaiters.clear(); } }; const timer = setInterval(poll, Math.max(100, Number(intervalMs) || 1_000)); timer.unref?.(); void poll();
  return { isHealthy: () => !stopped, isIdle: () => !inFlight, poll, stop() { stopped = true; clearInterval(timer); }, waitForIdle({ timeoutMs = 30_000 } = {}) { if (!inFlight) return Promise.resolve(true); return new Promise((resolve) => { const done = (value) => { clearTimeout(timerId); idleWaiters.delete(done); resolve(value); }; const timerId = setTimeout(() => done(false), timeoutMs); idleWaiters.add(done); }); } };
}
