import { randomUUID } from 'node:crypto';

function projectIdFor({ connection, event, mappings }) {
  const externalProjectId = String(event.payload?.fields?.projectExternalId ?? '').trim();
  const mapping = externalProjectId
    ? mappings.find((item) => item.connectionId === connection.id && item.objectType === 'project' && item.externalId === externalProjectId)
    : null;
  if (mapping && connection.projectIds.includes(mapping.projectId)) return mapping.projectId;
  return connection.projectIds.length === 1 ? connection.projectIds[0] : null;
}

export async function processConnectorInboundBatch({
  leaseMs = 30_000,
  limit = 20,
  maxAttempts = 5,
  now = new Date(),
  repository,
  workerId = `connector-worker-${randomUUID()}`,
} = {}) {
  if (!repository?.claimInboundEvents || !repository?.upsertConnectorObject) throw new Error('Connector inbound worker requires a worker-capable repository.');
  const claimed = await repository.claimInboundEvents({ leaseMs, limit, now, workerId }); const results = [];
  for (const { connection, event } of claimed) {
    try {
      const snapshot = await repository.listSnapshot({ tenantId: event.tenantId });
      const projected = await repository.upsertConnectorObject({ event, projectId: projectIdFor({ connection, event, mappings: snapshot.mappings }) });
      const completed = await repository.completeClaimedInboundEvent({ eventId: event.id, leaseToken: event.leaseToken, now, workerId });
      results.push({ duplicate: projected.duplicate, eventId: event.id, objectId: projected.object.id, status: completed ? 'processed' : 'lease_lost' });
    } catch (error) {
      const retryDelayMs = Math.min(60_000, 1_000 * (2 ** Math.max(0, event.attempts - 1)));
      const failed = await repository.failClaimedInboundEvent({ availableAt: new Date(now.getTime() + retryDelayMs), error: error?.message ?? error, eventId: event.id, leaseToken: event.leaseToken, maxAttempts, now, workerId });
      results.push({ error: error?.message ?? String(error), eventId: event.id, status: failed ? (event.attempts >= maxAttempts ? 'dead' : 'retry') : 'lease_lost' });
    }
  }
  return results;
}

export function startConnectorInboundWorker({ intervalMs = 1_000, onError = () => {}, repository, workerId = `connector-worker-${process.pid}` } = {}) {
  let inFlight = false; let stopped = false; const idleWaiters = new Set();
  const poll = async () => {
    if (stopped || inFlight) return [];
    inFlight = true;
    try { return await processConnectorInboundBatch({ repository, workerId }); }
    catch (error) { onError(error); return []; }
    finally { inFlight = false; for (const resolve of idleWaiters) resolve(true); idleWaiters.clear(); }
  };
  const timer = setInterval(poll, Math.max(100, Number(intervalMs) || 1_000)); timer.unref?.(); void poll();
  return {
    isHealthy: () => !stopped,
    isIdle: () => !inFlight,
    poll,
    stop() { stopped = true; clearInterval(timer); },
    waitForIdle({ timeoutMs = 30_000 } = {}) {
      if (!inFlight) return Promise.resolve(true);
      return new Promise((resolve) => { const done = (value) => { clearTimeout(timerId); idleWaiters.delete(done); resolve(value); }; const timerId = setTimeout(() => done(false), timeoutMs); idleWaiters.add(done); });
    },
  };
}
