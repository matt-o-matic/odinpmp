import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAccessLinkUrl, computeAccessLinkStatus } from '../src/modules/access/access-links.js';
import { createInMemoryAccessRepository } from '../src/modules/access/access.repository.js';

// The access link's lifetime (docs/task-access/plan.md): valid while any grant is active; after
// the last one ends, 14 days from the latest of issuing and that end, or until an extension.

const NOW = new Date('2026-10-29T12:00:00.000Z');
const daysAgo = (days) => new Date(NOW.valueOf() - days * 24 * 60 * 60 * 1000).toISOString();
const link = (fields = {}) => ({ extendedUntil: null, issuedAt: daysAgo(30), revokedAt: null, ...fields });

test('an active grant keeps the link valid with no end, however long ago it was issued', () => {
  const status = computeAccessLinkStatus({ grants: [{ active: false, endedAt: daysAgo(40) }, { active: true, endedAt: null }], link: link({ issuedAt: daysAgo(400) }), now: NOW });
  assert.deepEqual([status.status, status.valid, status.expiresAt, status.grantActive], ['active', true, null, true]);
});

test('without an active grant the link lasts 14 days from the latest of issuing and the last grant ending', () => {
  const ended = computeAccessLinkStatus({ grants: [{ active: false, endedAt: daysAgo(10) }, { active: false, endedAt: daysAgo(20) }], link: link(), now: NOW });
  assert.deepEqual([ended.status, ended.lastGrantEndedAt, ended.expiresAt], ['active', daysAgo(10), daysAgo(-4)]);
  const issuedLater = computeAccessLinkStatus({ grants: [{ active: false, endedAt: daysAgo(20) }], link: link({ issuedAt: daysAgo(13) }), now: NOW });
  assert.deepEqual([issuedLater.status, issuedLater.expiresAt], ['active', daysAgo(-1)]);
  const lapsed = computeAccessLinkStatus({ grants: [{ active: false, endedAt: daysAgo(15) }], link: link(), now: NOW });
  assert.deepEqual([lapsed.status, lapsed.valid, lapsed.expiresAt], ['expired', false, daysAgo(1)]);
  // Never granted anything: 14 days from issue. A grant whose end is unknown does not count.
  assert.equal(computeAccessLinkStatus({ grants: [{ active: false, endedAt: null }], link: link({ issuedAt: daysAgo(14) }), now: NOW }).status, 'expired');
  assert.equal(computeAccessLinkStatus({ grants: [], link: link({ issuedAt: daysAgo(13) }), now: NOW }).status, 'active');
});

test('an extension keeps the link past its grace period, and a revoked link never works', () => {
  const extended = computeAccessLinkStatus({ grants: [{ active: false, endedAt: daysAgo(40) }], link: link({ extendedUntil: daysAgo(-5) }), now: NOW });
  assert.deepEqual([extended.status, extended.expiresAt, extended.extendedUntil], ['active', daysAgo(-5), daysAgo(-5)]);
  const pastExtension = computeAccessLinkStatus({ grants: [], link: link({ extendedUntil: daysAgo(1) }), now: NOW });
  assert.equal(pastExtension.status, 'expired');
  const revoked = computeAccessLinkStatus({ grants: [{ active: true, endedAt: null }], link: link({ revokedAt: daysAgo(1) }), now: NOW });
  assert.deepEqual([revoked.status, revoked.valid], ['revoked', false]);
});

test('link URLs point at the app\'s access route', () => {
  assert.equal(buildAccessLinkUrl({ frontendAppUrl: 'https://odinpmp.com/app/', token: 'abc' }), 'https://odinpmp.com/app/access/abc');
});

test('the in-memory repository keeps one link per workspace and email, and starts a revoked link afresh', async () => {
  const repository = createInMemoryAccessRepository();
  const issue = (tokenHash, now, tenantId = 'tenant-1') => repository.issueLinkToken({ createdBy: 'user:manager', email: ' Casey@Vendor.Example ', now, purpose: 'manual', tenantId, tokenHash });
  const first = await issue('hash-1', daysAgo(5));
  const second = await issue('hash-2', daysAgo(1));
  assert.deepEqual([first.linkCreated, second.linkCreated, second.link.id, second.link.email, second.link.issuedAt], [true, false, first.link.id, 'casey@vendor.example', daysAgo(1)]);
  assert.notEqual((await issue('hash-3', daysAgo(1), 'tenant-2')).link.id, first.link.id);

  const revoked = await repository.revokeLink({ linkId: first.link.id, now: NOW, revokedBy: 'user:manager', tenantId: 'tenant-1' });
  assert.equal(revoked.revokedAt, NOW.toISOString());
  assert.equal((await repository.findTokenByHash({ tokenHash: 'hash-2' })).token.revokedAt, NOW.toISOString());
  assert.equal(await repository.revokeLink({ linkId: first.link.id, now: NOW, revokedBy: 'user:x', tenantId: 'tenant-2' }), null);

  const reissued = await issue('hash-4', NOW);
  assert.deepEqual([reissued.reactivated, reissued.link.revokedAt, reissued.link.id], [true, null, first.link.id]);
  assert.ok((await repository.findTokenByHash({ tokenHash: 'hash-1' })).token.revokedAt, 'old tokens stay revoked');
  assert.equal((await repository.findTokenByHash({ tokenHash: 'hash-4' })).token.revokedAt, null);
});

test('task access turned off keeps its row with the time it ended, and turning it on again starts a new grant', async () => {
  const repository = createInMemoryAccessRepository();
  const set = (scope, now) => repository.setTaskAccess({ by: 'manager', now, projectId: 'project-1', resourceId: 'res-1', scope, tenantId: 'tenant-1' });
  assert.equal(await set('off', daysAgo(9)), null);
  const own = await set('own', daysAgo(8));
  const all = await set('all', daysAgo(7));
  assert.deepEqual([all.id, all.scope, all.grantedAt], [own.id, 'all', daysAgo(8)]);
  const off = await set('off', daysAgo(6));
  assert.deepEqual([off.id, off.scope, off.revokedAt], [own.id, 'all', daysAgo(6)]);
  const again = await set('own', daysAgo(2));
  assert.deepEqual([again.id, again.revokedAt, again.grantedAt], [own.id, null, daysAgo(2)]);
  assert.deepEqual((await repository.listTaskAccess({ resourceIds: ['res-1'], tenantId: 'tenant-1' })).map((grant) => grant.scope), ['own']);
  assert.deepEqual(await repository.listTaskAccess({ projectId: 'project-1', tenantId: 'tenant-2' }), []);
});
