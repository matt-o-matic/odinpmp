import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

export function runWithAuditContext(context, callback) {
  return storage.run(context, callback);
}

export function currentAuditContext() {
  return storage.getStore() ?? null;
}

export function recordAuditPolicyDecision(decision) {
  const context = currentAuditContext();
  if (!context) return;
  context.policyDecisions.push({
    capability: String(decision?.capability ?? '').trim(),
    decision: decision?.allowed ? 'allow' : 'deny',
    projectId: decision?.projectId ?? null,
    projectRole: decision?.projectRole ?? null,
    tenantRole: decision?.tenantRole ?? null,
  });
}
