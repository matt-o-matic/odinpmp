import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { BROWSER_SESSION_MARKER, createApiClient } from '../src/lib/api/client.js';
import {
  EMAIL_NOTIFICATION_TOGGLES,
  NOTIFICATION_PREFERENCES_VERSION,
  effectiveEmailNotifications,
  preferencesForSave,
} from '../src/lib/users/notification-preferences.js';
import {
  JOIN_REQUEST_ROLES,
  pageOfRequests,
  requesterStatus,
  verificationLabel,
} from '../src/lib/workspace-access/join-requests.js';

const source = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

test('email toggles show what Odin does: on until the current form saves them off', () => {
  assert.deepEqual(EMAIL_NOTIFICATION_TOGGLES.map((toggle) => toggle.key), ['emailNotifMentions', 'emailNotifTopicReplies', 'emailNotifTasks', 'emailNotifSummaries', 'emailNotifChannelDigest']);
  const allOn = { emailNotifChannelDigest: true, emailNotifMentions: true, emailNotifSummaries: true, emailNotifTasks: true, emailNotifTopicReplies: true };
  assert.deepEqual(effectiveEmailNotifications(), allOn);
  // Unchecked boxes saved by the old form never stopped any email.
  assert.deepEqual(effectiveEmailNotifications({ emailNotifMentions: false, emailNotifTasks: false }), allOn);
  assert.deepEqual(
    effectiveEmailNotifications({ emailNotifMentions: false, notificationPrefsVersion: NOTIFICATION_PREFERENCES_VERSION }),
    { ...allOn, emailNotifMentions: false },
  );
  assert.deepEqual(preferencesForSave({ darkMode: true }), { darkMode: true, notificationPrefsVersion: NOTIFICATION_PREFERENCES_VERSION });
  // The profile form never sends the two-factor flag; only the Security pane changes it.
  assert.deepEqual(preferencesForSave({ darkMode: false, twoFactorEnabled: false }), { darkMode: false, notificationPrefsVersion: NOTIFICATION_PREFERENCES_VERSION });
});

test('the profile offers only the email notifications Odin sends, and marks its saves', () => {
  const userView = source('views/UserView.vue');
  assert.doesNotMatch(userView, /inAppNotif|In-app/);
  assert.match(userView, /v-for="toggle in EMAIL_NOTIFICATION_TOGGLES"/);
  assert.match(userView, /preferences: preferencesForSave\(\{/);
  assert.match(userView, /\.\.\.effectiveEmailNotifications\(profile\.preferences\)/);
});

test('request labels and the admin list paging', () => {
  assert.equal(requesterStatus({ emailConfirmed: false, status: 'pending' }).label, 'Confirm your email');
  assert.equal(requesterStatus({ emailConfirmed: true, status: 'pending' }).label, 'Waiting for an admin');
  assert.equal(requesterStatus({ status: 'declined' }).label, 'Declined');
  assert.equal(verificationLabel({ emailVerifiedAt: '2026-10-10T12:00:00Z', verificationMethod: 'email_link' }), 'Confirmed by email link');
  assert.equal(verificationLabel({ emailVerifiedAt: '2026-10-10T12:00:00Z', verificationMethod: 'earlier_confirmation' }), 'Confirmed on an earlier request');
  assert.deepEqual(JOIN_REQUEST_ROLES.map((role) => role.value), ['user', 'manager', 'admin']);

  const requests = Array.from({ length: 12 }, (_, index) => ({
    email: `person${index}@example.com`, id: `r${index}`, name: index === 3 ? 'Grace Hopper' : `Person ${index}`,
    requestedAt: new Date(Date.UTC(2026, 9, 1 + index)).toISOString(),
  }));
  const first = pageOfRequests(requests);
  assert.deepEqual([first.items.length, first.pageCount, first.items[0].id], [10, 2, 'r11']);
  assert.deepEqual(pageOfRequests(requests, { page: 2, sort: 'oldest' }).items.map((row) => row.id), ['r10', 'r11']);
  assert.deepEqual(pageOfRequests(requests, { query: 'grace' }).items.map((row) => row.id), ['r3']);
  assert.equal(pageOfRequests(requests, { page: 9 }).page, 2);
});

test('workspace access client calls the requester and admin endpoints', async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ body: options.body ? JSON.parse(options.body) : null, method: options.method ?? 'GET', url: String(url) });
    return { ok: true, status: 200, async json() { return { ok: true }; } };
  };
  try {
    const client = createApiClient({ baseUrl: 'http://localhost:3001' });
    await client.listWorkspaceAccessRequests(BROWSER_SESSION_MARKER);
    await client.requestWorkspaceAccess({ workspaceName: 'Acme' }, BROWSER_SESSION_MARKER);
    await client.resendWorkspaceAccessConfirmation('req/1', BROWSER_SESSION_MARKER);
    await client.cancelWorkspaceAccessRequest('req-1', BROWSER_SESSION_MARKER);
    await client.confirmWorkspaceAccessEmail('emailed-token');
    await client.approveTenantUserRequest('req-1', { role: 'manager' }, BROWSER_SESSION_MARKER);
    await client.declineTenantUserRequest('req-1', BROWSER_SESSION_MARKER);
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url.replace('http://localhost:3001', '')}`), [
    'GET /api/workspace-access/requests',
    'POST /api/workspace-access/requests',
    'POST /api/workspace-access/requests/req%2F1/resend-confirmation',
    'POST /api/workspace-access/requests/req-1/cancel',
    'POST /api/workspace-access/confirm',
    'POST /api/tenants/user-requests/req-1/approve',
    'POST /api/tenants/user-requests/req-1/decline',
  ]);
  assert.deepEqual(calls[4].body, { token: 'emailed-token' }, 'the confirmation token travels in the body, not the URL');
  assert.deepEqual(calls[5].body, { role: 'manager' });
});

test('admins review requests in a focused panel with app dialogs, not the old email-based accept', () => {
  const adminView = source('views/AdminView.vue');
  assert.match(adminView, /<WorkspaceJoinRequestsPanel @count="joinRequestCount = \$event" \/>/);
  assert.doesNotMatch(adminView, /accepted_requests|declined_requests|acceptRequest|declineRequest/);
  assert.match(adminView, /route\.query\.tab === 'requests'/);

  const panel = source('components/admin/WorkspaceJoinRequestsPanel.vue');
  assert.match(panel, /<RequirementsDialog[\s\S]*Role in this workspace[\s\S]*<\/RequirementsDialog>/);
  assert.match(panel, /<RequirementsConfirmDialog[\s\S]*confirm-label="Decline request"/);
  assert.match(panel, /approveTenantUserRequest\(target\.id, \{ role: approveRole\.value \}/);
  // No native dialogs, and no title-attribute tooltips (the dialogs' :title prop is fine).
  assert.doesNotMatch(panel, /window\.confirm|\bconfirm\(|alert\(|\s title="/);
});

test('the requester page, its email confirmation and the menu entry', () => {
  const router = source('router/index.js');
  assert.match(router, /path: '\/workspace-access', name: 'workspace-access', component: WorkspaceAccessView, meta: \{ requiresAuth: true \}/);
  assert.match(router, /path: '\/workspace-access\/confirm', name: 'workspace-access-confirm', component: WorkspaceAccessConfirmView \}/);

  const confirmView = source('views/WorkspaceAccessConfirmView.vue');
  assert.match(confirmView, /const token = route\.hash\.replace\(\/\^#\/, ''\);/);
  assert.doesNotMatch(confirmView, /onMounted/, 'the link waits for a click so mail scanners cannot use it');

  const accessView = source('views/WorkspaceAccessView.vue');
  assert.match(accessView, /<RequirementsConfirmDialog[\s\S]*confirm-label="Cancel request"/);
  assert.doesNotMatch(accessView, /window\.confirm|alert\(/);

  assert.match(source('App.vue'), /<li v-if="!authSession\.state\.impersonation && !authSession\.state\.breakGlass">\s*<RouterLink class="dropdown-item" to="\/workspace-access">Request workspace access<\/RouterLink>/);
  assert.match(source('views/RegisterView.vue'), /Request workspace access<\/strong> from your account menu/);
});
