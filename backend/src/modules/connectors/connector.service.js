import { createHash, randomBytes } from 'node:crypto';

import { HttpError } from '../../lib/errors/http-error.js';
import { assertTenantSecretReference } from '../../lib/secrets/tenant-secret-reference.js';
import { CONNECTOR_CATALOG } from './connector-catalog.js';
import { DEFAULT_CONNECTOR_ADAPTER_REGISTRY } from './connector-adapter-registry.js';

const hash = (value) =>
  createHash('sha256').update(String(value)).digest('hex');

function tenantIdFor(user) {
  const membership = user?.memberships?.[0];
  if (
    !membership?.tenantId ||
    (membership.role !== 'admin' &&
      !user.capabilities?.includes('integrations.manage'))
  ) {
    throw new HttpError(404, 'Connector record not found.');
  }
  return membership.tenantId;
}
function tenantAdminIdFor(user) { const tenantId = user?.memberships?.[0]?.tenantId; if (!tenantId || user.memberships?.[0]?.role !== 'admin') throw new HttpError(404, 'Connector record not found.'); return tenantId; }

function effectiveProviderPolicy(snapshot, provider) {
  const configured = snapshot.policies?.find((policy) => policy.provider === provider);
  if (configured) return configured;
  const adapter = DEFAULT_CONNECTOR_ADAPTER_REGISTRY.get(provider);
  return { allowedAuthTypes: adapter?.catalog.authTypes ?? [], allowedDirections: ['bidirectional', 'inbound', 'outbound'], allowedScopes: [], approvalRequired: false, dataClassification: 'confidential', enabled: true, maxProjects: 500, outboundEnabled: true, provider };
}

function enforceProviderPolicy(input, policy, current = null) {
  if (!policy.enabled) throw new HttpError(403, 'This connector provider is disabled by tenant policy.');
  if (!policy.allowedAuthTypes.includes(input.authType)) throw new HttpError(403, 'Connector authentication type is not allowed by tenant policy.');
  if (!policy.allowedDirections.includes(input.syncDirection)) throw new HttpError(403, 'Connector direction is not allowed by tenant policy.');
  if (!policy.outboundEnabled && ['bidirectional', 'outbound'].includes(input.syncDirection)) throw new HttpError(403, 'Outbound connector activity is disabled by tenant policy.');
  if (input.projectIds.length > policy.maxProjects) throw new HttpError(403, 'Connector project scope exceeds tenant policy.');
  if (policy.allowedScopes.length && input.scopes.some((scope) => !policy.allowedScopes.includes(scope))) throw new HttpError(403, 'One or more connector scopes are not allowed by tenant policy.');
  if (policy.approvalRequired && input.status === 'active' && !current?.approvedAt) throw new HttpError(409, 'Connector activation requires approval by a different tenant administrator.');
}

async function assertProjects({
  projectIds,
  projectRepository,
  tenantId,
  user,
}) {
  const visible = new Set(
    (await projectRepository.listProjectsForTenant({ tenantId, user })).map(
      (item) => item.id,
    ),
  );
  if (projectIds.some((id) => !visible.has(id))) {
    throw new HttpError(400, 'One or more connector project ids are invalid.');
  }
}

export async function getConnectorWorkspaceForUser({
  input,
  repository,
  user,
}) {
  const tenantId = tenantIdFor(user);
  const complete = await repository.listSnapshot({ tenantId });
  const sliced = Object.fromEntries(
    Object.entries(complete).map(([name, values]) => [
      name,
      values.slice(input.offset, input.offset + input.limit),
    ]),
  );
  const health = sliced.connections.map((connection) => {
    const events = complete.events.filter(
      (item) => item.connectionId === connection.id,
    );
    const runs = complete.runs.filter(
      (item) => item.connectionId === connection.id,
    );
    const failures = [...events, ...runs].filter(
      (item) => item.status === 'failed',
    ).length;
    const pending = [...events, ...runs].filter(
      (item) => item.status === 'pending',
    ).length;
    return {
      connectionId: connection.id,
      failures,
      lastFailureAt: connection.lastFailureAt,
      lastSuccessAt: connection.lastSuccessAt,
      pending,
      status:
        connection.status !== 'active'
          ? connection.status
          : failures
            ? 'degraded'
            : 'healthy',
    };
  });
  return {
    ...sliced,
    catalog: CONNECTOR_CATALOG,
    health,
    limit: input.limit,
    offset: input.offset,
    total: complete.connections.length,
  };
}

export async function createConnectorConnectionForUser({
  input,
  projectRepository,
  repository,
  user,
}) {
  const tenantId = tenantIdFor(user);
  assertTenantSecretReference(input.secretReference, { field: 'Credential reference', tenantId });
  await assertProjects({
    projectIds: input.projectIds,
    projectRepository,
    tenantId,
    user,
  });
  const snapshot = await repository.listSnapshot({ tenantId }); const policy = effectiveProviderPolicy(snapshot, input.provider);
  const governedInput = { ...input, status: policy.approvalRequired ? 'draft' : input.status }; enforceProviderPolicy(governedInput, policy);
  const inboundSecret = `odin_connector_${randomBytes(40).toString('base64url')}`;
  const value = await repository.createConnection({
    inboundSecretHash: hash(inboundSecret),
    input: governedInput,
    tenantId,
    userId: user.id,
  });
  return { inboundSecret, ok: true, value };
}

export async function updateConnectorConnectionForUser({
  connectionId,
  input,
  projectRepository,
  repository,
  user,
}) {
  const tenantId = tenantIdFor(user);
  assertTenantSecretReference(input.secretReference, { field: 'Credential reference', tenantId });
  if (input.projectIds)
    await assertProjects({
      projectIds: input.projectIds,
      projectRepository,
      tenantId,
      user,
    });
  const snapshot = await repository.listSnapshot({ tenantId }); const current = snapshot.connections.find((item) => item.id === connectionId);
  if (!current) throw new HttpError(404, 'Connector record not found.');
  if (input.provider && input.provider !== current.provider && current.approvedAt) throw new HttpError(409, 'Create a new connection when changing an approved provider.');
  const effective = { ...current, ...input }; enforceProviderPolicy(effective, effectiveProviderPolicy(snapshot, effective.provider), current);
  const value = await repository.updateConnection({
    connectionId,
    input,
    tenantId,
  });
  if (!value) throw new HttpError(404, 'Connector record not found.');
  return { ok: true, value };
}

export async function createConnectorProviderPolicyForUser({ input, repository, user }) { const tenantId = tenantAdminIdFor(user); return { ok: true, value: await repository.createProviderPolicy({ input, tenantId, userId: user.id }) }; }
export async function updateConnectorProviderPolicyForUser({ input, policyId, repository, user }) { const tenantId = tenantAdminIdFor(user); const value = await repository.updateProviderPolicy({ input, policyId, tenantId }); if (!value) throw new HttpError(404, 'Connector record not found.'); return { ok: true, value }; }
export async function approveConnectorConnectionForUser({ connectionId, expectedVersion, repository, user }) {
  const tenantId = tenantAdminIdFor(user); const snapshot = await repository.listSnapshot({ tenantId }); const connection = snapshot.connections.find((item) => item.id === connectionId);
  if (!connection) throw new HttpError(404, 'Connector record not found.'); const policy = effectiveProviderPolicy(snapshot, connection.provider);
  if (!policy.enabled || !policy.approvalRequired) throw new HttpError(409, 'This connector does not require marketplace approval.');
  const value = await repository.approveConnection({ approvedBy: user.id, connectionId, expectedVersion, tenantId }); if (!value) throw new HttpError(404, 'Connector record not found.'); return { ok: true, value };
}

export async function createConnectorMappingForUser({
  input,
  projectRepository,
  repository,
  user,
}) {
  const tenantId = tenantIdFor(user);
  await assertProjects({
    projectIds: [input.projectId],
    projectRepository,
    tenantId,
    user,
  });
  const snapshot = await repository.listSnapshot({ tenantId });
  if (!snapshot.connections.some((item) => item.id === input.connectionId)) {
    throw new HttpError(404, 'Connector record not found.');
  }
  return {
    ok: true,
    value: await repository.createMapping({ input, tenantId }),
  };
}

export async function resolveConnectorConflictForUser({
  conflictId,
  input,
  repository,
  user,
}) {
  const tenantId = tenantIdFor(user);
  const value = await repository.resolveConflict({
    conflictId,
    input,
    tenantId,
    userId: user.id,
  });
  if (!value) throw new HttpError(404, 'Connector record not found.');
  return { ok: true, value };
}

export async function createConnectorSyncRunForUser({
  connectionId,
  input,
  repository,
  user,
}) {
  const tenantId = tenantIdFor(user);
  const snapshot = await repository.listSnapshot({ tenantId });
  if (!snapshot.connections.some((item) => item.id === connectionId)) {
    throw new HttpError(404, 'Connector record not found.');
  }
  return {
    ok: true,
    ...(await repository.createSyncRun({
      connectionId,
      direction: input.direction,
      idempotencyKey: input.idempotencyKey,
      tenantId,
    })),
  };
}

export async function createConnectorErpPostingForUser({ connectionId, input, repository, resourceFinanceRepository, user }) {
  const tenantId = tenantAdminIdFor(user); const [snapshot, finance] = await Promise.all([repository.listSnapshot({ tenantId }), resourceFinanceRepository.listSnapshot({ tenantId })]); const connection = snapshot.connections.find((item) => item.id === connectionId); const entry = finance.financialEntries.find((item) => item.id === input.financialEntryId);
  if (!connection || !['netsuite', 'sap_s4hana'].includes(connection.provider) || connection.status !== 'active' || !['outbound', 'bidirectional'].includes(connection.syncDirection)) throw new HttpError(404, 'Connector record not found.');
  enforceProviderPolicy(connection, effectiveProviderPolicy(snapshot, connection.provider), connection);
  if (!entry || entry.status !== 'approved' || !connection.projectIds.includes(entry.projectId)) throw new HttpError(409, 'ERP posting requires an approved ledger entry in the connection project scope.');
  return { ok: true, ...(await repository.createErpPosting({ connectionId, financialEntry: entry, idempotencyKey: input.idempotencyKey, tenantId, userId: user.id })) };
}
export async function beginConnectorOAuthForUser({ connectionId, oauthService, user }) { const tenantId = tenantAdminIdFor(user); if (!oauthService) throw new HttpError(503, 'Connector OAuth is unavailable.'); return { ok: true, ...(await oauthService.begin({ connectionId, tenantId, userId: user.id })) }; }
export async function completeConnectorOAuthForUser({ code, oauthService, state, user }) { tenantAdminIdFor(user); if (!oauthService) throw new HttpError(503, 'Connector OAuth is unavailable.'); return oauthService.callback({ code, state, userId: user.id }); }

export async function receiveConnectorInboundEvent({
  connectionId,
  input,
  repository,
  secret,
}) {
  const connection = await repository.authenticateInbound({
    connectionId,
    secretHash: hash(secret),
  });
  if (!connection) throw new HttpError(401, 'Invalid connector credential.');
  const payloadHash = hash(JSON.stringify(input.payload));
  const normalized = DEFAULT_CONNECTOR_ADAPTER_REGISTRY.normalizeInbound(connection.provider, { eventType: input.eventType, payload: input.payload });
  const result = await repository.recordInboundEvent({
    connection,
    eventId: input.eventId,
    eventType: normalized.eventType,
    payload: { ...normalized.object, sourcePayloadHash: payloadHash },
    payloadHash,
  });
  return {
    accepted: !result.duplicate,
    duplicate: result.duplicate,
    eventId: result.event.id,
    ok: true,
  };
}

export async function applyConnectorInboundEventForUser({ eventId, expectedVersion, projectRepository, repository, resourceFinanceRepository, user }) {
  const tenantId = tenantIdFor(user);
  if (!resourceFinanceRepository?.createFinancialEntry) throw new HttpError(503, 'Resource and finance storage is unavailable.');
  const snapshot = await repository.listSnapshot({ tenantId });
  const event = snapshot.events.find((item) => item.id === eventId);
  const connection = event ? snapshot.connections.find((item) => item.id === event.connectionId) : null;
  if (!event || !connection || event.status !== 'pending') throw new HttpError(404, 'Connector event not found.');
  if (!['netsuite', 'sap_s4hana'].includes(connection.provider) || event.payload?.kind !== 'journal_entry') throw new HttpError(400, 'Only normalized ERP journal events can be applied to the financial ledger.');
  const projectExternalId = String(event.payload.fields?.projectExternalId ?? '').trim();
  const mapping = snapshot.mappings.find((item) => item.connectionId === connection.id && item.objectType === 'project' && item.externalId === projectExternalId);
  if (!mapping || !connection.projectIds.includes(mapping.projectId)) throw new HttpError(409, 'ERP journal requires an allowlisted project mapping.');
  await assertProjects({ projectIds: [mapping.projectId], projectRepository, tenantId, user });
  const fields = event.payload.fields ?? {}; const amount = Number(fields.amount);
  if (!Number.isFinite(amount) || !/^[A-Z]{3}$/.test(String(fields.currency ?? '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(fields.effectiveDate ?? ''))) throw new HttpError(422, 'ERP journal amount, currency, or effective date is invalid.');
  const allowedKinds = new Set(['actual_cost', 'budget', 'capitalized_cost', 'commitment', 'forecast', 'funding', 'revenue']);
  const financialSnapshot = await resourceFinanceRepository.listSnapshot({ tenantId });
  const sourceType = `connector:${connection.provider}`; const existing = financialSnapshot.financialEntries.find((item) => item.sourceType === sourceType && item.sourceId === event.payload.externalId);
  const value = existing ?? await resourceFinanceRepository.createFinancialEntry({ input: { amount, category: String(fields.memo || fields.sourceType || 'ERP journal').slice(0, 160), currency: fields.currency, effectiveDate: fields.effectiveDate, entryKind: allowedKinds.has(fields.entryKind) ? fields.entryKind : 'actual_cost', note: `Imported from ${connection.name}.`, projectId: mapping.projectId, sourceId: event.payload.externalId, sourceType, status: 'draft' }, tenantId });
  const completedEvent = await repository.completeInboundEvent({ eventId, expectedVersion, tenantId });
  return { duplicate: Boolean(existing), event: completedEvent, ok: true, value };
}
