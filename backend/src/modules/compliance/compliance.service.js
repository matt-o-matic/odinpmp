import { createHash, randomUUID } from 'node:crypto';

import { HttpError } from '../../lib/errors/http-error.js';

function requireAdmin(user) {
  const membership = user?.memberships?.[0];
  if (!membership?.tenantId || membership.role !== 'admin') throw new HttpError(404, 'Compliance record not found.');
  return membership.tenantId;
}
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const canonicalEvent = (event) => JSON.stringify({
  action: event.action, detail: event.detail, id: event.id, ipAddress: event.ipAddress,
  projectId: event.projectId, result: event.result, timestamp: event.timestamp, userId: event.userId,
});

export async function getComplianceWorkspaceForUser({ repository, user }) {
  const tenantId = requireAdmin(user);
  const [policy, exports, privacyRequests, legalHolds, controlAttestations] = await Promise.all([repository.getPolicy({ tenantId }), repository.listAuditExports({ tenantId }), repository.listPrivacyRequests({ tenantId }), repository.listLegalHolds({ tenantId }), repository.listControlAttestations({ tenantId })]);
  return { controlAttestations, exports, legalHolds, ok: true, policy, privacyRequests };
}

export async function updateCompliancePolicyForUser({ input, repository, user }) {
  const tenantId = requireAdmin(user);
  return { ok: true, value: await repository.updatePolicy({ input, tenantId, userId: user.id }) };
}

export async function createComplianceAuditExportForUser({ input, objectStorage, repository, user }) {
  const tenantId = requireAdmin(user);
  if (!objectStorage?.writeImmutable || !objectStorage?.verifyImmutable) throw new HttpError(503, 'Immutable compliance object storage is unavailable.');
  await objectStorage.verifyImmutable().catch(() => { throw new HttpError(503, 'Immutable compliance object storage is unavailable.'); });
  const policy = await repository.getPolicy({ tenantId });
  const storageRegion = String(objectStorage.region ?? '').toLowerCase(); const regionPrefix = { au: 'ap-southeast-', ca: 'ca-', eu: 'eu-', uk: 'eu-west-2', us: 'us-' }[policy.dataRegion]; if (storageRegion && !storageRegion.startsWith(regionPrefix)) throw new HttpError(409, 'Compliance object storage region does not satisfy tenant residency policy.');
  const startAt = `${input.startDate}T00:00:00.000Z`;
  const endExclusive = new Date(`${input.endDate}T00:00:00.000Z`); endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
  const events = await repository.listAuditEvents({ endDate: endExclusive.toISOString(), limit: 100_001, startDate: startAt, tenantId });
  if (events.length > 100_000) throw new HttpError(413, 'Audit evidence exports are limited to 100,000 events; select a smaller date range.');
  let previousHash = '0'.repeat(64);
  const records = events.map((event, index) => {
    const eventJson = canonicalEvent(event); const hash = sha256(`${previousHash}\n${eventJson}`);
    const record = { event: JSON.parse(eventJson), hash, previousHash, sequence: index + 1 };
    previousHash = hash; return record;
  });
  const priorExports = await repository.listAuditExports({ tenantId });
  const prior = priorExports.at(-1) ?? null;
  const retentionUntil = new Date(); retentionUntil.setUTCDate(retentionUntil.getUTCDate() + policy.wormRetentionDays);
  const manifest = {
    dataRegion: policy.dataRegion, endAtExclusive: endExclusive.toISOString(), format: 'odin.audit-evidence.v1',
    previousExportHash: prior?.contentHash ?? null, recordCount: records.length, retentionUntil: retentionUntil.toISOString(),
    rootHash: previousHash, startAt, tenantId,
  };
  const bytes = Buffer.from(JSON.stringify({ manifest, records }));
  const contentHash = sha256(bytes); const objectKey = `compliance-evidence-${randomUUID()}`;
  const stored = await objectStorage.writeImmutable(objectKey, bytes, { retainUntil: retentionUntil });
  const value = await repository.createAuditExport({ input: {
    contentHash, createdBy: user.id, dataRegion: policy.dataRegion, endAt: endExclusive.toISOString(), objectKey,
    objectVersionId: stored?.versionId ?? null, previousExportHash: prior?.contentHash ?? null, recordCount: records.length,
    retentionUntil: retentionUntil.toISOString(), rootHash: previousHash, startAt,
  }, tenantId });
  return { manifest: value, ok: true };
}

export async function createLegalHoldForUser({ input, repository, user }) { const tenantId = requireAdmin(user); return { ok: true, value: await repository.createLegalHold({ input, tenantId, userId: user.id }) }; }
export async function releaseLegalHoldForUser({ expectedVersion, holdId, reason, repository, user }) { const tenantId = requireAdmin(user); const value = await repository.releaseLegalHold({ expectedVersion, holdId, reason, tenantId, userId: user.id }); if (!value) throw new HttpError(404, 'Compliance record not found.'); return { ok: true, value }; }
export async function createControlAttestationForUser({ input, repository, user }) { const tenantId = requireAdmin(user); return { ok: true, value: await repository.createControlAttestation({ input, tenantId, userId: user.id }) }; }

export async function readComplianceAuditExportForUser({ exportId, objectStorage, repository, user }) {
  const tenantId = requireAdmin(user);
  if (!objectStorage?.read) throw new HttpError(503, 'Compliance object storage is unavailable.');
  const evidence = await repository.getAuditExport({ exportId, tenantId });
  if (!evidence) throw new HttpError(404, 'Compliance record not found.');
  const asset = await objectStorage.read(evidence.objectKey).catch(() => null);
  if (!asset || sha256(asset.bytes) !== evidence.contentHash) throw new HttpError(409, 'Compliance evidence integrity verification failed.');
  return { asset, evidence };
}

function decodeSiemCursor(value) {
  if (!value) return { id: '', timestamp: '1970-01-01T00:00:00.000Z' };
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!/^[0-9T:.+-]+Z$/.test(String(parsed.timestamp ?? '')) || typeof parsed.id !== 'string' || parsed.id.length > 128) throw new Error('invalid');
    return { id: parsed.id, timestamp: new Date(parsed.timestamp).toISOString() };
  } catch {
    throw new HttpError(400, 'Invalid SIEM feed cursor.');
  }
}

export async function getComplianceSiemFeed({ application, input, repository }) {
  const cursor = decodeSiemCursor(input.cursor);
  const events = await repository.listSiemEvents({ afterId: cursor.id, afterTimestamp: cursor.timestamp, limit: input.limit, tenantId: application.tenantId });
  const last = events.at(-1);
  const nextCursor = last ? Buffer.from(JSON.stringify({ id: last.id, timestamp: last.timestamp })).toString('base64url') : input.cursor;
  return { data: events, hasMore: events.length === input.limit, limit: input.limit, nextCursor };
}

export async function createPrivacyErasureRequestForUser({ input, repository, user }) {
  const tenantId = requireAdmin(user);
  if (input.subjectUserId === user.id) throw new HttpError(403, 'Administrators cannot request their own privacy erasure.');
  const value = await repository.createPrivacyRequest({ input, tenantId, userId: user.id });
  if (!value) throw new HttpError(404, 'Compliance record not found.');
  return { ok: true, value };
}

export async function executePrivacyErasureForUser({ expectedVersion, repository, requestId, user }) {
  const tenantId = requireAdmin(user);
  const value = await repository.executePrivacyErasure({ expectedVersion, executedBy: user.id, requestId, tenantId });
  if (!value) throw new HttpError(404, 'Compliance record not found.');
  return { ok: true, value };
}
