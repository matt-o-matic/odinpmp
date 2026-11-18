import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';

import { getTenantMembership } from '../../lib/auth/project-capabilities.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { assertTenantSecretReference } from '../../lib/secrets/tenant-secret-reference.js';
import { serializeAuthUser } from '../auth/auth.service.js';

const BUILTIN_ROLE_KEYS = new Set(['admin', 'manager', 'user']);
function tenantIdFor(user) { const tenantId = user?.memberships?.[0]?.tenantId; if (!tenantId) throw new HttpError(403, 'This account is not assigned to a tenant.'); return tenantId; }
function requireAdmin(user, tenantId) { if (getTenantMembership(user, tenantId)?.role !== 'admin' && !user?.capabilities?.includes('identity.manage')) throw new HttpError(404, 'Identity record not found.'); }
function hash(value) { return createHash('sha256').update(String(value)).digest('hex'); }
function publicDomain(record) { if (!record) return record; const { tokenHash: _tokenHash, ...value } = record; return value; }
function publicCredential(record) { if (!record) return record; const { secretHash: _secretHash, ...value } = record; return value; }
function find(collection, id) { return collection.find((record) => record.id === id); }
function assertRecord(record) { if (!record) throw new HttpError(404, 'Identity record not found.'); return record; }
async function assertTenantUser(authRepository, tenantId, userId) { const user = await authRepository.findUserById(userId); if (!user || !getTenantMembership(user, tenantId)) throw new HttpError(404, 'Tenant user not found.'); return user; }

export async function getIdentityWorkspaceForUser({ input, repository, user }) {
  const tenantId = tenantIdFor(user); requireAdmin(user, tenantId); const snapshot = await repository.listSnapshot({ tenantId });
  const credentials = snapshot.credentials.map(publicCredential); const domains = snapshot.domains.map(publicDomain);
  const collections = ['domains', 'roles', 'groups', 'accessReviewCampaigns', 'accessReviews', 'serviceAccounts', 'impersonationGrants']; const total = collections.reduce((sum, name) => sum + (name === 'domains' ? domains.length : snapshot[name].length), 0);
  return { ...snapshot, credentials, domains, limit: input.limit, offset: input.offset, total };
}

export async function saveIdentityPolicyForUser({ input, repository, user }) {
  const tenantId = tenantIdFor(user); requireAdmin(user, tenantId);
  for (const [field, label] of [['secretReference', 'Client secret reference'], ['spSigningKeyReference', 'SP signing key reference'], ['spSigningCertReference', 'SP signing certificate reference'], ['decryptionKeyReference', 'Decryption key reference']]) {
    assertTenantSecretReference(input.provider?.[field], { field: label, tenantId });
  }
  if (input.loginEnforcement === 'required') {
    const snapshot = await repository.listSnapshot({ tenantId });
    if (!snapshot.domains.some((domain) => domain.status === 'verified')) throw new HttpError(409, 'Verify at least one tenant domain before requiring SSO.');
  }
  return { ok: true, value: await repository.upsertPolicy({ input, tenantId, updatedBy: user.id }) };
}

export async function saveBreakGlassPolicyForUser({ authRepository, input, repository, user }) {
  const tenantId = tenantIdFor(user); requireAdmin(user, tenantId);
  for (const userId of input.userIds) {
    const designated = await assertTenantUser(authRepository, tenantId, userId);
    const membership = getTenantMembership(designated, tenantId);
    if (designated.authMethod !== 'basic' || membership?.role !== 'admin' || !designated.preferences?.twoFactorEnabled) {
      throw new HttpError(409, 'Break-glass accounts must be local tenant administrators with two-factor authentication enabled.');
    }
  }
  return { ok: true, value: await repository.upsertBreakGlassPolicy({ input, tenantId, updatedBy: user.id }) };
}

export async function createVerifiedDomainForUser({ input, repository, user }) {
  const tenantId = tenantIdFor(user); requireAdmin(user, tenantId); const snapshot = await repository.listSnapshot({ tenantId });
  if (snapshot.domains.some((record) => record.domain === input.domain)) throw new HttpError(409, 'This domain already exists.');
  const verificationToken = `odin-domain-${randomBytes(24).toString('base64url')}`;
  const record = await repository.createDomain({ input, tenantId, tokenHash: hash(verificationToken) });
  return { ok: true, value: publicDomain(record), verification: { dnsName: `_odin-verify.${input.domain}`, dnsValue: verificationToken, token: input.verificationMethod === 'manual' ? verificationToken : undefined } };
}

export async function verifyDomainForUser({ domainId, input, repository, resolveTxtRecords = resolveTxt, user }) {
  const tenantId = tenantIdFor(user); requireAdmin(user, tenantId); const snapshot = await repository.listSnapshot({ tenantId }); const domain = assertRecord(find(snapshot.domains, domainId));
  let values = [];
  if (domain.verificationMethod === 'manual') values = [input.proof];
  else { try { values = (await resolveTxtRecords(`_odin-verify.${domain.domain}`)).flat(); } catch { throw new HttpError(409, 'The required DNS verification record was not found.'); } }
  if (!values.some((value) => hash(value) === domain.tokenHash)) throw new HttpError(409, 'Domain verification proof did not match.');
  const value = await repository.updateDomain({ domainId, input: { expectedVersion: input.expectedVersion, status: 'verified', verifiedAt: new Date().toISOString() }, tenantId });
  return { ok: true, value: publicDomain(value) };
}

export async function deleteIdentityRecordForUser({ expectedVersion, id, kind, repository, user }) {
  const tenantId = tenantIdFor(user); requireAdmin(user, tenantId); const methods = { domain: ['deleteDomain', 'domainId'], group: ['deleteGroup', 'groupId'], role: ['deleteRole', 'roleId'] }; const [method, key] = methods[kind] ?? [];
  if (!method || !await repository[method]({ expectedVersion, [key]: id, tenantId })) throw new HttpError(404, 'Identity record not found.'); return { ok: true };
}

function validateRoleKeys(roleKeys, snapshot) { const allowed = new Set([...BUILTIN_ROLE_KEYS, ...snapshot.roles.map((role) => role.key)]); const invalid = roleKeys.filter((key) => !allowed.has(key)); if (invalid.length) throw new HttpError(400, `Unknown role keys: ${invalid.join(', ')}.`); }
export async function createIdentityRecordForUser({ input, kind, repository, user }) { const tenantId = tenantIdFor(user); requireAdmin(user, tenantId); const snapshot = await repository.listSnapshot({ tenantId }); if (kind === 'group') validateRoleKeys(input.roleKeys, snapshot); const method = kind === 'group' ? 'createGroup' : 'createRole'; if (kind === 'role' && [...BUILTIN_ROLE_KEYS].includes(input.key)) throw new HttpError(409, 'Built-in role keys cannot be replaced.'); return { ok: true, value: await repository[method]({ input, tenantId }) }; }
export async function updateIdentityRecordForUser({ id, input, kind, repository, user }) { const tenantId = tenantIdFor(user); requireAdmin(user, tenantId); const snapshot = await repository.listSnapshot({ tenantId }); const collection = kind === 'group' ? snapshot.groups : snapshot.roles; const current = assertRecord(find(collection, id)); const effective = { ...current, ...input }; if (kind === 'group') validateRoleKeys(effective.roleKeys, snapshot); if (kind === 'role' && BUILTIN_ROLE_KEYS.has(effective.key)) throw new HttpError(409, 'Built-in role keys cannot be replaced.'); const method = kind === 'group' ? 'updateGroup' : 'updateRole'; const key = kind === 'group' ? 'groupId' : 'roleId'; return { ok: true, value: await repository[method]({ input, [key]: id, tenantId }) }; }

export async function changeGroupMembershipForUser({ authRepository, groupId, remove = false, repository, targetUserId, user }) { const tenantId = tenantIdFor(user); requireAdmin(user, tenantId); const snapshot = await repository.listSnapshot({ tenantId }); assertRecord(find(snapshot.groups, groupId)); await assertTenantUser(authRepository, tenantId, targetUserId); const method = remove ? 'removeGroupMember' : 'addGroupMember'; const value = await repository[method]({ groupId, tenantId, userId: targetUserId }); return { ok: true, value }; }

function accessReviewItemsForScope(snapshot, scope) { const items = []; if (scope !== 'service_accounts') for (const membership of snapshot.groupMemberships) items.push({ access: { groupId: membership.groupId }, subjectId: membership.userId, subjectType: 'user' }); if (scope !== 'groups') for (const account of snapshot.serviceAccounts) items.push({ access: { enabled: account.enabled, scopes: account.scopes }, subjectId: account.id, subjectType: 'service_account' }); return items; }
async function assertAccessReviewer(authRepository, tenantId, reviewerUserId) { const reviewer = await assertTenantUser(authRepository, tenantId, reviewerUserId); if (getTenantMembership(reviewer, tenantId)?.role !== 'admin') throw new HttpError(409, 'Access review campaigns require a tenant administrator as reviewer.'); return reviewer; }
export async function createAccessReviewForUser({ input, repository, user }) { const tenantId = tenantIdFor(user); requireAdmin(user, tenantId); const snapshot = await repository.listSnapshot({ tenantId }); const items = accessReviewItemsForScope(snapshot, input.scope); if (!items.length) throw new HttpError(409, 'No access records are available for this review scope.'); return { ok: true, value: await repository.createAccessReview({ input, items, tenantId, userId: user.id }) }; }
export async function createAccessReviewCampaignForUser({ authRepository, input, repository, user }) { const tenantId = tenantIdFor(user); requireAdmin(user, tenantId); await assertAccessReviewer(authRepository, tenantId, input.reviewerUserId); return { ok: true, value: await repository.createAccessReviewCampaign({ input, tenantId, userId: user.id }) }; }
export async function updateAccessReviewCampaignForUser({ authRepository, campaignId, input, repository, user }) { const tenantId = tenantIdFor(user); requireAdmin(user, tenantId); const snapshot = await repository.listSnapshot({ tenantId }); const campaign = assertRecord(find(snapshot.accessReviewCampaigns, campaignId)); if (campaign.version !== input.expectedVersion) throw new HttpError(409, 'Access review campaign changed since it was loaded.', { details: { actualVersion: campaign.version, code: 'identity_version_conflict', expectedVersion: input.expectedVersion } }); if (input.reviewerUserId) await assertAccessReviewer(authRepository, tenantId, input.reviewerUserId); const value = await repository.updateAccessReviewCampaign({ campaignId, input, tenantId }); return { ok: true, value: assertRecord(value) }; }
export async function materializeDueAccessReviewCampaigns({ limit = 100, now = new Date(), repository }) { const campaigns = await repository.listDueAccessReviewCampaigns({ limit, now }); const results = []; for (const campaign of campaigns) { const scheduledFor = campaign.nextRunAt; const scheduledAt = new Date(scheduledFor); const nextRunAt = new Date(scheduledAt.getTime() + campaign.intervalDays * 86_400_000).toISOString(); const dueAt = new Date(scheduledAt.getTime() + campaign.durationDays * 86_400_000).toISOString(); const snapshot = await repository.listSnapshot({ tenantId: campaign.tenantId }); const items = accessReviewItemsForScope(snapshot, campaign.scope); results.push(await repository.materializeAccessReviewCampaign({ campaignId: campaign.id, items, nextRunAt, reviewInput: { dueAt, name: `${campaign.name} · ${scheduledFor.slice(0, 10)}`, reviewerUserId: campaign.reviewerUserId, scope: campaign.scope }, scheduledFor, tenantId: campaign.tenantId })); } return { campaigns: campaigns.length, created: results.filter((item) => item.created).length, results }; }
export async function decideAccessReviewItemForUser({ input, itemId, repository, user }) { const tenantId = tenantIdFor(user); requireAdmin(user, tenantId); const snapshot = await repository.listSnapshot({ tenantId }); const item = assertRecord(find(snapshot.accessReviewItems, itemId)); const review = assertRecord(find(snapshot.accessReviews, item.reviewId)); if (review.reviewerUserId !== user.id) throw new HttpError(404, 'Identity record not found.'); if (item.decision !== 'pending') throw new HttpError(409, 'This access review item is already decided.'); if (input.decision === 'revoke' && item.subjectType === 'user' && item.access.groupId) await repository.removeGroupMember({ groupId: item.access.groupId, tenantId, userId: item.subjectId }); if (input.decision === 'revoke' && item.subjectType === 'service_account') { const account = assertRecord(find(snapshot.serviceAccounts, item.subjectId)); await repository.updateServiceAccount({ accountId: account.id, input: { enabled: false, expectedVersion: account.version }, tenantId }); await repository.revokeCredentials({ accountId: account.id, tenantId }); } const value = await repository.updateAccessReviewItem({ input, itemId, tenantId, userId: user.id }); await repository.completeAccessReviewIfReady({ reviewId: review.id, tenantId }); return { ok: true, value }; }

function createServiceSecret() { const prefix = randomBytes(6).toString('hex'); const secret = `odin_sa_${prefix}_${randomBytes(32).toString('base64url')}`; return { prefix: `odin_sa_${prefix}`, secret, secretHash: hash(secret) }; }
export async function createServiceAccountForUser({ input, repository, user }) { const tenantId = tenantIdFor(user); requireAdmin(user, tenantId); const account = await repository.createServiceAccount({ input, tenantId, userId: user.id }); const generated = createServiceSecret(); const credential = await repository.createCredential({ accountId: account.id, expiresAt: input.expiresAt, prefix: generated.prefix, secretHash: generated.secretHash, tenantId, userId: user.id }); return { credential: publicCredential(credential), ok: true, secret: generated.secret, value: account }; }
export async function updateServiceAccountForUser({ accountId, input, repository, user }) { const tenantId = tenantIdFor(user); requireAdmin(user, tenantId); const snapshot = await repository.listSnapshot({ tenantId }); assertRecord(find(snapshot.serviceAccounts, accountId)); const value = await repository.updateServiceAccount({ accountId, input, tenantId }); if (input.enabled === false) await repository.revokeCredentials({ accountId, tenantId }); return { ok: true, value }; }
export async function rotateServiceCredentialForUser({ accountId, input, repository, user }) { const tenantId = tenantIdFor(user); requireAdmin(user, tenantId); const snapshot = await repository.listSnapshot({ tenantId }); const account = assertRecord(find(snapshot.serviceAccounts, accountId)); if (account.version !== input.expectedVersion) throw new HttpError(409, 'Service account changed since it was loaded.'); if (!account.enabled) throw new HttpError(409, 'Enable the service account before rotating credentials.'); const updatedAccount = await repository.updateServiceAccount({ accountId, input: { expectedVersion: input.expectedVersion }, tenantId }); await repository.revokeCredentials({ accountId, tenantId }); const generated = createServiceSecret(); const credential = await repository.createCredential({ accountId, expiresAt: input.expiresAt, prefix: generated.prefix, secretHash: generated.secretHash, tenantId, userId: user.id }); return { credential: publicCredential(credential), ok: true, secret: generated.secret, value: updatedAccount };
}

export async function requestImpersonationForUser({ authRepository, input, repository, user }) { const tenantId = tenantIdFor(user); requireAdmin(user, tenantId); if (input.targetUserId === user.id) throw new HttpError(400, 'Self-impersonation is not allowed.'); if (Date.parse(input.expiresAt) <= Date.now()) throw new HttpError(400, 'Impersonation expiry must be in the future.'); await assertTenantUser(authRepository, tenantId, input.targetUserId); return { ok: true, value: await repository.createImpersonationGrant({ input, requesterUserId: user.id, tenantId }) }; }
export async function decideImpersonationForUser({ grantId, input, repository, user }) { const tenantId = tenantIdFor(user); requireAdmin(user, tenantId); const snapshot = await repository.listSnapshot({ tenantId }); const grant = assertRecord(find(snapshot.impersonationGrants, grantId)); if (grant.requesterUserId === user.id) throw new HttpError(403, 'Impersonation approval requires a different administrator.'); if (grant.status !== 'pending') throw new HttpError(409, 'This impersonation request is already decided.'); const now = new Date().toISOString(); const value = await repository.updateImpersonationGrant({ grantId, input: { approvedAt: input.decision === 'approved' ? now : null, approvedBy: user.id, decisionNote: input.note, endedAt: null, expectedVersion: input.expectedVersion, status: input.decision }, tenantId }); return { ok: true, value }; }

export async function activateImpersonationForUser({
  actor = null,
  authRepository,
  grantId,
  identityRepository,
  ipAddr = '',
  sessionsRepository,
  tokenService,
  user,
  userAgent = '',
}) {
  if (actor) throw new HttpError(409, 'Nested impersonation is not allowed.');
  const tenantId = tenantIdFor(user); requireAdmin(user, tenantId);
  const grant = assertRecord(await identityRepository.getImpersonationGrant({ grantId, tenantId }));
  if (grant.requesterUserId !== user.id) throw new HttpError(404, 'Identity record not found.');
  if (grant.status !== 'approved' || !grant.approvedBy || grant.approvedBy === user.id) throw new HttpError(409, 'Impersonation requires approval by a different administrator.');
  const remainingSeconds = Math.floor((Date.parse(grant.expiresAt) - Date.now()) / 1000);
  if (remainingSeconds < 1) throw new HttpError(409, 'The impersonation approval has expired.');
  const target = await assertTenantUser(authRepository, tenantId, grant.targetUserId);
  const authUser = await serializeAuthUser(target, authRepository, { activeTenantId: tenantId });
  authUser.capabilities = await identityRepository.resolveUserCapabilities({ tenantId, userId: target.id });
  const sessionId = randomUUID();
  const expiresInSeconds = Math.min(remainingSeconds, 15 * 60);
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
  const token = tokenService.signImpersonationSessionToken(authUser, {
    actorId: user.id,
    expiresInSeconds,
    impersonationGrantId: grant.id,
    sessionId,
  });
  const value = await identityRepository.updateImpersonationGrant({
    grantId,
    input: { expectedVersion: grant.version, status: 'active' },
    tenantId,
  });
  try {
    await sessionsRepository.createSession({
      expiryDate: expiresAt,
      id: sessionId,
      ipAddr,
      locationName: 'Governed impersonation',
      token: '',
      userAgent,
      userId: target.id,
    });
  } catch (error) {
    await identityRepository.updateImpersonationGrant({
      grantId,
      input: { endedAt: new Date().toISOString(), expectedVersion: value.version, status: 'ended' },
      tenantId,
    });
    throw error;
  }
  return {
    expiresAt: expiresAt.toISOString(),
    grant: value,
    ok: true,
    session: { token, user: authUser },
  };
}

export async function endImpersonationForUser({
  actor = null,
  currentGrantId = '',
  currentSessionId = '',
  expectedVersion,
  grantId,
  repository,
  sessionsRepository,
  user,
}) {
  const effectiveActor = actor ?? user;
  const tenantId = tenantIdFor(effectiveActor); requireAdmin(effectiveActor, tenantId);
  const grant = assertRecord(await repository.getImpersonationGrant({ grantId, tenantId }));
  if (![grant.requesterUserId, grant.approvedBy].includes(effectiveActor.id)) throw new HttpError(404, 'Identity record not found.');
  if (!['approved', 'active'].includes(grant.status)) throw new HttpError(409, 'This impersonation grant is not active.');
  const value = await repository.updateImpersonationGrant({
    grantId,
    input: { endedAt: new Date().toISOString(), expectedVersion, status: 'ended' },
    tenantId,
  });
  if (currentGrantId === grantId && currentSessionId) {
    await sessionsRepository.killSession({ tokenId: currentSessionId, userId: user.id });
  }
  return { ok: true, value };
}
