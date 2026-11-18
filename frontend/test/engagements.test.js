import assert from 'node:assert/strict';
import test from 'node:test';

import {
  engagementErrorMessage,
  engagementStatusCounts,
  filterEngagements,
  formatLastActivity,
  normalizeEngagementSection,
  normalizeEngagementStatusFilter,
} from '../src/lib/engagements/engagements.js';
import { createWorkspaceModulesStore } from '../src/lib/workspace/workspace-modules.js';

const rows = [
  { customer: 'Northwind', id: 'a', lastActivityAt: '2026-11-10T10:00:00.000Z', name: 'Data platform', ownerName: 'Pat', status: 'open' },
  { customer: 'Contoso', id: 'b', lastActivityAt: '2026-11-12T10:00:00.000Z', name: 'Rollout', ownerName: 'Lee', status: 'open' },
  { customer: 'Fabrikam', id: 'c', lastActivityAt: '2026-11-13T10:00:00.000Z', name: 'CRM pilot', ownerName: 'Pat', status: 'lost' },
  { customer: 'Litware', id: 'd', lastActivityAt: '2026-11-01T10:00:00.000Z', name: 'Migration', ownerName: null, status: 'won' },
];

test('the status filter starts on Open and accepts only known statuses', () => {
  assert.equal(normalizeEngagementStatusFilter(undefined), 'open');
  assert.equal(normalizeEngagementStatusFilter('LOST'), 'lost');
  assert.equal(normalizeEngagementStatusFilter('stalled'), 'open');
  assert.equal(normalizeEngagementSection('people'), 'people');
  assert.equal(normalizeEngagementSection('kanban'), 'channels', 'an engagement has no delivery board; it opens on its channels');
  assert.equal(normalizeEngagementSection('board'), 'board', 'its Board tab is the pursuit board');
  assert.equal(normalizeEngagementSection('insights'), 'insights');
});

test('engagements filter by status and text, newest activity first, and count by status', () => {
  assert.deepEqual(filterEngagements(rows).map((row) => row.id), ['b', 'a']);
  assert.deepEqual(filterEngagements(rows, { status: 'all' }).map((row) => row.id), ['c', 'b', 'a', 'd']);
  assert.deepEqual(filterEngagements(rows, { query: 'pat', status: 'all' }).map((row) => row.id), ['c', 'a'], 'matches the owner');
  assert.deepEqual(filterEngagements(rows, { query: 'contoso', status: 'open' }).map((row) => row.id), ['b'], 'matches the customer');
  assert.deepEqual(engagementStatusCounts(rows), { all: 4, lost: 1, open: 2, won: 1 });
});

test('last activity reads as a day, then a date', () => {
  const now = new Date('2026-11-14T15:00:00');
  assert.equal(formatLastActivity('2026-11-14T08:00:00', now), 'Today');
  assert.equal(formatLastActivity('2026-11-13T08:00:00', now), 'Yesterday');
  assert.equal(formatLastActivity('2026-11-10T08:00:00', now), '4 days ago');
  assert.equal(formatLastActivity('', now), '');
});

test('engagement errors read by their code', () => {
  assert.match(engagementErrorMessage({ data: { details: { code: 'module_disabled' } }, message: 'x' }, 'fallback'), /switched off/);
  assert.match(engagementErrorMessage({ data: { details: { code: 'engagement_closed' } } }, 'fallback'), /Reopen it/);
  assert.equal(engagementErrorMessage({ message: 'Server said no.' }, 'fallback'), 'Server said no.');
  assert.equal(engagementErrorMessage(null, 'fallback'), 'fallback');
});

function storeWith(response) {
  const calls = [];
  const authSession = { state: { currentUser: { tenantId: 'tenant-1' }, isAuthenticated: true, token: 'token' } };
  const apiClient = { passive: { async getWorkspaceModules() { calls.push('get'); if (response instanceof Error) throw response; return response; } } };
  return { authSession, calls, store: createWorkspaceModulesStore({ apiClient, authSession }) };
}

test('the module store reads the Consulting switch once per workspace, and treats a failed read as off', async () => {
  const on = storeWith({ modules: [{ enabled: true, key: 'consulting' }] });
  await on.store.load();
  await on.store.load();
  assert.equal(on.store.state.consulting, true);
  assert.deepEqual(on.calls, ['get']);
  on.authSession.state.currentUser = { tenantId: 'tenant-2' };
  await on.store.load();
  assert.deepEqual(on.calls, ['get', 'get'], 'another workspace reads again');

  const failed = storeWith(new Error('offline'));
  await failed.store.load();
  assert.equal(failed.store.state.consulting, false);

  const signedOut = storeWith({ modules: [{ enabled: true, key: 'consulting' }] });
  signedOut.authSession.state.isAuthenticated = false;
  await signedOut.store.load();
  assert.deepEqual(signedOut.calls, [], 'nothing is read before sign-in');
  on.store.apply([]);
  assert.equal(on.store.state.consulting, false);
});
