// Synthetic API for the compliance and ticket-configuration admin screens and the project
// ticket pickers. Install after installSyntheticApi(): Playwright runs the newest route first,
// and anything this fixture does not own falls back to the base synthetic API.
import { syntheticProject, syntheticUser } from './synthetic-api.js';

const API_ORIGIN = 'http://localhost:3001';

function json(route, body, status = 200) {
  return route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status });
}

export const adminScreenUsers = [
  { email: syntheticUser.email, id: syntheticUser.id, name: syntheticUser.name, role: 'admin' },
  { email: 'olive@example.com', id: 'admin-olive', name: 'Olive Admin', role: 'admin' },
  { email: 'casey@example.com', id: 'user-casey', name: 'Casey Member', role: 'user' },
  { email: 'drew@example.com', id: 'user-drew', name: 'Drew Member', role: 'user' },
  { email: 'evan@example.com', id: 'user-evan', name: 'Evan Member', role: 'user' },
];

export async function installAdminScreensApi(page, { storageConfigured = false } = {}) {
  const calls = [];
  let sequence = 0;
  const nextId = (prefix) => `${prefix}-new-${(sequence += 1)}`;
  const compliance = {
    controlAttestations: [{
      attestedAt: '2026-10-01T12:00:00.000Z', contentHash: 'b'.repeat(64), controlKey: 'legal_hold', evidenceRefs: ['hold-active', 'https://docs.example.com/legal/q3'],
      id: 'attestation-1', ownerUserId: 'admin-olive', periodEnd: '2026-09-30', periodStart: '2026-07-01',
      statement: 'Legal holds were reviewed weekly and every release was approved by counsel.',
    }],
    exports: [{
      contentHash: 'c'.repeat(64), createdAt: '2026-10-02T09:00:00.000Z', createdBy: 'admin-olive', dataRegion: 'us', endAt: '2026-10-01T00:00:00.000Z',
      id: 'export-1', previousExportHash: null, recordCount: 1824, retentionUntil: '2027-10-02T09:00:00.000Z', rootHash: 'a'.repeat(64), startAt: '2026-09-01T00:00:00.000Z',
    }],
    legalHolds: [
      { createdAt: '2026-09-15T10:00:00.000Z', createdBy: 'admin-olive', id: 'hold-active', reason: 'Preserve the delivery plan for the vendor dispute.', releaseReason: '', releasedAt: null, releasedBy: null, resourceId: syntheticProject.id, resourceType: 'project', status: 'active', version: 1 },
      { createdAt: '2026-09-20T10:00:00.000Z', createdBy: 'admin-olive', id: 'hold-deleted-project', reason: 'Keep the retired pilot for the insurance claim.', releaseReason: '', releasedAt: null, releasedBy: null, resourceId: 'project-retired', resourceType: 'project', status: 'active', version: 1 },
      { createdAt: '2026-08-01T10:00:00.000Z', createdBy: syntheticUser.id, id: 'hold-released', reason: 'Audit sample preserved for the external auditor.', releaseReason: 'Audit closed without findings.', releasedAt: '2026-08-20T10:00:00.000Z', releasedBy: 'admin-olive', resourceId: 'export-1', resourceType: 'audit_export', status: 'released', version: 2 },
    ],
    ok: true,
    policy: { auditRetentionDays: 365, createdAt: '2026-07-01T00:00:00.000Z', dataRegion: 'us', legalHold: false, privacyDeletionDays: 30, tenantId: syntheticUser.tenantId, updatedAt: '2026-09-01T12:00:00.000Z', updatedBy: 'admin-olive', version: 2, wormRetentionDays: 365 },
    privacyRequests: [
      { completedAt: null, completedBy: null, createdAt: '2026-10-03T09:00:00.000Z', id: 'privacy-olive', reason: 'Verified data subject request received by support.', requestedBy: 'admin-olive', result: null, status: 'pending', subjectUserId: 'user-casey', version: 1 },
      { completedAt: null, completedBy: null, createdAt: '2026-10-04T09:00:00.000Z', id: 'privacy-mine', reason: 'Former contractor asked to be forgotten.', requestedBy: syntheticUser.id, result: null, status: 'pending', subjectUserId: 'user-drew', version: 1 },
    ],
  };
  const ticketConfig = {
    environments: [
      { id: 'env-development', name: 'Development', projectId: null, sortOrder: 0, status: 'active', version: 1 },
      { id: 'env-staging', name: 'Staging', projectId: null, sortOrder: 1, status: 'active', version: 1 },
      { id: 'env-uat', name: 'UAT', projectId: null, sortOrder: 2, status: 'inactive', version: 2 },
      { id: 'env-production', name: 'Production', projectId: null, sortOrder: 3, status: 'active', version: 1 },
    ],
    releases: [
      { id: 'rel-2026-09', name: '2026.09.0', projectId: null, sortOrder: 0, status: 'active', version: 1 },
      { id: 'rel-pilot', name: 'Pilot RC1', projectId: syntheticProject.id, sortOrder: 1, status: 'active', version: 1 },
    ],
  };
  const revisions = { environments: 1, releases: 1 };
  const tickets = [{
    category: 'defect', environmentId: 'env-uat', externalReviewState: 'not_external', fixedInReleaseId: null, foundInReleaseId: 'rel-2026-09',
    id: 'ticket-1', name: 'Checkout total rounds down', priority: 3, projectId: syntheticProject.id, projectName: syntheticProject.name,
    severity: 'S2', status: 'new', updatedAt: '2026-10-05T10:00:00.000Z', version: 4,
  }];
  const control = { conflictNextTicketConfigSave: false };

  await page.route(`${API_ORIGIN}/**`, async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;
    const body = () => request.postDataJSON();
    const record = (extra = {}) => calls.push({ body: method === 'GET' ? null : body(), method, path, ...extra });

    if (method === 'GET' && path === '/api/compliance') return json(route, structuredClone(compliance));
    if (method === 'GET' && path === '/api/tenants/existing-users') return json(route, { ok: true, users: adminScreenUsers });
    if (method === 'GET' && path === '/api/projects/deleted') {
      return json(route, { ok: true, projects: [{ deletedAt: '2026-09-25T10:00:00.000Z', deletedBy: 'admin-olive', deletedByName: 'Olive Admin', id: 'project-retired', name: 'Retired Pilot' }] });
    }
    if (method === 'PUT' && path === '/api/compliance/policy') {
      record();
      const input = body();
      if (input.expectedVersion !== compliance.policy.version) return json(route, { details: { code: 'compliance_version_conflict' }, error: 'Compliance policy changed since it was loaded.', ok: false }, 409);
      const { expectedVersion: _expectedVersion, ...changes } = input;
      compliance.policy = { ...compliance.policy, ...changes, updatedAt: '2026-10-09T12:00:00.000Z', updatedBy: syntheticUser.id, version: compliance.policy.version + 1 };
      return json(route, { ok: true, value: compliance.policy });
    }
    if (method === 'POST' && path === '/api/compliance/audit-exports') {
      record();
      if (!storageConfigured) return json(route, { error: 'Immutable compliance object storage is unavailable.', ok: false }, 503);
      const input = body();
      const manifest = { ...compliance.exports[0], createdAt: '2026-10-09T12:00:00.000Z', createdBy: syntheticUser.id, endAt: `${input.endDate}T00:00:00.000Z`, id: nextId('export'), recordCount: 12, startAt: `${input.startDate}T00:00:00.000Z` };
      compliance.exports.push(manifest);
      return json(route, { manifest, ok: true }, 201);
    }
    if (method === 'GET' && /^\/api\/compliance\/audit-exports\/[^/]+\/content$/.test(path)) {
      record();
      return route.fulfill({ body: JSON.stringify({ manifest: { format: 'odin.audit-evidence.v1' }, records: [] }), contentType: 'application/json', headers: { 'Content-Disposition': 'attachment; filename="audit-evidence.json"' }, status: 200 });
    }
    if (method === 'POST' && path === '/api/compliance/legal-holds') {
      record();
      const input = body();
      if (compliance.legalHolds.some((hold) => hold.status === 'active' && hold.resourceType === input.resourceType && hold.resourceId === input.resourceId)) {
        return json(route, { error: 'An active legal hold already covers this record.', ok: false }, 409);
      }
      const hold = { ...input, createdAt: '2026-10-09T12:00:00.000Z', createdBy: syntheticUser.id, id: nextId('hold'), releaseReason: '', releasedAt: null, releasedBy: null, status: 'active', version: 1 };
      compliance.legalHolds.push(hold);
      return json(route, { ok: true, value: hold }, 201);
    }
    const release = /^\/api\/compliance\/legal-holds\/([^/]+)\/release$/.exec(path);
    if (method === 'POST' && release) {
      record();
      const hold = compliance.legalHolds.find((item) => item.id === release[1]);
      Object.assign(hold, { releaseReason: body().reason, releasedAt: '2026-10-09T12:00:00.000Z', releasedBy: syntheticUser.id, status: 'released', version: hold.version + 1 });
      return json(route, { ok: true, value: hold });
    }
    if (method === 'POST' && path === '/api/compliance/control-attestations') {
      record();
      const attestation = { ...body(), attestedAt: '2026-10-09T12:00:00.000Z', contentHash: 'd'.repeat(64), id: nextId('attestation'), ownerUserId: syntheticUser.id };
      compliance.controlAttestations.push(attestation);
      return json(route, { ok: true, value: attestation }, 201);
    }
    if (method === 'POST' && path === '/api/compliance/privacy-erasure-requests') {
      record();
      const value = { ...body(), completedAt: null, completedBy: null, createdAt: '2026-10-09T12:00:00.000Z', id: nextId('privacy'), requestedBy: syntheticUser.id, result: null, status: 'pending', version: 1 };
      compliance.privacyRequests.push(value);
      return json(route, { ok: true, value }, 201);
    }
    const execute = /^\/api\/compliance\/privacy-erasure-requests\/([^/]+)\/execute$/.exec(path);
    if (method === 'POST' && execute) {
      record();
      const value = compliance.privacyRequests.find((item) => item.id === execute[1]);
      Object.assign(value, { completedAt: '2026-10-09T12:00:00.000Z', completedBy: syntheticUser.id, result: { identityPseudonymized: true, memoriesDeleted: 0, projectMembershipsRemoved: 1, sessionsRevoked: 2 }, status: 'completed', version: 2 });
      return json(route, { ok: true, value });
    }

    const configKind = /^\/api\/tenants\/ticket-config\/(environments|releases)$/.exec(path)?.[1];
    if (configKind && method === 'GET') return json(route, { entries: structuredClone(ticketConfig[configKind]), kind: configKind, ok: true, revision: `rev-${configKind}-${revisions[configKind]}` });
    if (configKind && method === 'PUT') {
      record();
      const input = body();
      if (control.conflictNextTicketConfigSave || input.expectedRevision !== `rev-${configKind}-${revisions[configKind]}`) {
        control.conflictNextTicketConfigSave = false;
        revisions[configKind] += 1;
        return json(route, { details: { code: 'ticket_config_revision_conflict' }, error: 'This list changed since it was loaded. Reload it and reapply your changes.', ok: false }, 409);
      }
      const kept = new Set(input.entries.map((entry) => entry.id).filter(Boolean));
      const retired = ticketConfig[configKind].filter((entry) => !kept.has(entry.id)).map((entry) => ({ ...entry, status: 'inactive' }));
      ticketConfig[configKind] = [...input.entries.map((entry) => ({ ...entry, id: entry.id ?? nextId(configKind === 'environments' ? 'env' : 'rel'), version: 2 })), ...retired];
      revisions[configKind] += 1;
      return json(route, { entries: ticketConfig[configKind], kind: configKind, ok: true, revision: `rev-${configKind}-${revisions[configKind]}` });
    }

    const projectPath = `/api/projects/${syntheticProject.id}`;
    if (method === 'GET' && path === `${projectPath}/ticket-config`) {
      const scoped = (entries) => entries.filter((entry) => !entry.projectId || entry.projectId === syntheticProject.id).map(({ version: _version, ...entry }) => entry);
      return json(route, { environments: scoped(ticketConfig.environments), ok: true, releases: scoped(ticketConfig.releases) });
    }
    if (method === 'GET' && path === `${projectPath}/tickets`) return json(route, { nextCursor: null, ok: true, tickets: structuredClone(tickets), total: tickets.length });
    if (method === 'GET' && path === `${projectPath}/ticket-intake-invitations`) return json(route, { invitations: [], ok: true });
    if (method === 'POST' && path === `${projectPath}/items`) {
      record();
      const input = body();
      const item = { ...input.item, environmentId: input.item.environmentId || null, foundInReleaseId: input.item.foundInReleaseId || null, id: nextId('ticket'), projectId: syntheticProject.id, projectName: syntheticProject.name, updatedAt: '2026-10-09T12:00:00.000Z', version: 1 };
      tickets.unshift(item);
      return json(route, { item, ok: true }, 201);
    }
    const itemPatch = new RegExp(`^${projectPath}/items/([^/]+)$`).exec(path);
    if (method === 'PATCH' && itemPatch) {
      record();
      const ticket = tickets.find((item) => item.id === itemPatch[1]);
      Object.assign(ticket, body().patch, { version: ticket.version + 1 });
      return json(route, { item: ticket, ok: true });
    }

    return route.fallback();
  });

  return {
    calls,
    compliance,
    control,
    ticketConfig,
    tickets,
  };
}
