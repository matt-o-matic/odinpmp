import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { settleForAxe } from './fixtures/axe-settle.js';
import { authenticateSyntheticUser, installSyntheticApi, openPhoneMenu, syntheticUser } from './fixtures/synthetic-api.js';

const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];
const API = 'http://localhost:3001';
const RECEIVED = 'Request received. If a workspace has exactly that name, your request is listed below.';

async function expectNoAxeViolations(page, testInfo, name, include = '#main-content') {
  await settleForAxe(page);
  const results = await new AxeBuilder({ page }).include(include).withTags(wcagTags).analyze();
  await testInfo.attach(`axe-${name}.json`, { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
  expect(results.violations).toEqual([]);
}

async function expectTouchTarget(page, locator) {
  const rootPx = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize));
  expect((await locator.boundingBox()).height).toBeGreaterThanOrEqual(2.75 * rootPx - 0.5);
}

async function expectNoHorizontalOverflow(page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

async function checkLightAndDark(page, testInfo, name, include) {
  await expectNoAxeViolations(page, testInfo, `${name}-light`, include);
  await page.screenshot({ fullPage: true, path: testInfo.outputPath(`${name}-light.png`) });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await expectNoAxeViolations(page, testInfo, `${name}-dark`, include);
  await page.screenshot({ fullPage: true, path: testInfo.outputPath(`${name}-dark.png`) });
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
}

async function openAccountMenu(page) {
  if (!await page.getByRole('button', { name: 'Account menu' }).isVisible()) await openPhoneMenu(page);
  await page.getByRole('button', { name: 'Account menu' }).click();
}

test.describe('workspace join requests', () => {
  test.describe.configure({ timeout: 90_000 });

  test('a signed-in person asks to join a workspace, sees the email step, and can cancel', async ({ page }, testInfo) => {
    const api = await installSyntheticApi(page);
    const calls = [];
    const requests = [{
      decidedAt: '2026-10-08T15:00:00.000Z', email: syntheticUser.email, emailConfirmed: true, grantedRole: 'user',
      id: 'req-approved', requestedAt: '2026-10-07T15:00:00.000Z', status: 'approved', tenantId: '22222222-2222-4222-8222-222222222222',
      verificationSentAt: null, workspaceName: 'Beta Labs',
    }];
    await page.route(`${API}/api/workspace-access/**`, (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      calls.push(`${request.method()} ${path}`);
      if (request.method() === 'GET') return route.fulfill({ json: { limits: { maxPending: 3 }, ok: true, requests } });
      if (path === '/api/workspace-access/requests') {
        expect(request.postDataJSON()).toEqual({ workspaceName: 'Acme Corp' });
        requests.unshift({
          decidedAt: null, email: syntheticUser.email, emailConfirmed: false, grantedRole: null, id: 'req-1',
          requestedAt: '2026-10-10T12:00:00.000Z', status: 'pending', tenantId: null, verificationSentAt: '2026-10-10T12:00:00.000Z', workspaceName: 'Acme Corp',
        });
        return route.fulfill({ json: { message: RECEIVED, ok: true }, status: 202 });
      }
      if (path.endsWith('/resend-confirmation')) return route.fulfill({ json: { message: `We sent a new confirmation link to ${syntheticUser.email}. Earlier links no longer work.`, ok: true } });
      if (path.endsWith('/cancel')) {
        Object.assign(requests[0], { decidedAt: '2026-10-10T12:05:00.000Z', status: 'cancelled' });
        return route.fulfill({ json: { message: 'Request cancelled.', ok: true } });
      }
      return route.fallback();
    });

    await authenticateSyntheticUser(page);
    await openAccountMenu(page);
    await page.getByRole('link', { name: 'Request workspace access' }).click();
    await expect(page).toHaveURL(/\/workspace-access$/);
    await expect(page.getByRole('heading', { name: 'Request workspace access', level: 1 })).toBeVisible();
    const list = page.getByRole('list', { name: 'Your requests to join workspaces' });
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await expect(list).toContainText('You joined as user.');
    await expect(list.getByRole('button', { name: 'Switch to Beta Labs' })).toBeVisible();

    const name = page.getByLabel('Workspace name');
    await name.fill('Acme Corp');
    const submit = page.getByRole('button', { name: 'Request access' });
    await expectTouchTarget(page, submit);
    await submit.click();
    await expect(page.getByRole('status').filter({ hasText: RECEIVED })).toBeVisible();
    await expect(name).toHaveValue('');
    const pending = list.getByRole('listitem').filter({ hasText: 'Acme Corp' });
    await expect(pending).toContainText('Confirm your email');
    await expect(pending).toContainText(`Open the link we sent to ${syntheticUser.email} within 24 hours`);
    await expectNoHorizontalOverflow(page);
    await checkLightAndDark(page, testInfo, 'workspace-access');

    await pending.getByRole('button', { name: 'Send another confirmation email for Acme Corp' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'We sent a new confirmation link' })).toBeVisible();

    await pending.getByRole('button', { name: 'Cancel your request to join Acme Corp' }).click();
    const dialog = page.getByRole('dialog', { name: 'Cancel this request?' });
    await expect(dialog).toContainText('Acme Corp');
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await expectNoAxeViolations(page, testInfo, 'cancel-dialog', 'dialog');
    await dialog.getByRole('button', { name: 'Cancel request' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Your request to join Acme Corp is cancelled.' })).toBeVisible();
    await expect(pending).toContainText('Cancelled');
    expect(calls.filter((call) => !call.startsWith('GET'))).toEqual([
      'POST /api/workspace-access/requests',
      'POST /api/workspace-access/requests/req-1/resend-confirmation',
      'POST /api/workspace-access/requests/req-1/cancel',
    ]);
    api.assertNoUnexpectedRequests();
  });

  test('the emailed confirmation link waits for a click and sends its token only in the body', async ({ page }, testInfo) => {
    const api = await installSyntheticApi(page);
    const confirmations = [];
    await page.route(`${API}/api/workspace-access/confirm`, (route) => {
      confirmations.push({ body: route.request().postDataJSON(), url: route.request().url() });
      return route.fulfill({ json: { ok: true, workspaceName: 'Acme Corp' } });
    });
    await page.goto('workspace-access/confirm#emailed-token-0123456789abcdef');
    await expect(page.getByRole('heading', { name: 'Confirm your request to join a workspace' })).toBeVisible();
    await expect(page.getByText('It doesn’t give you access')).toBeVisible();
    expect(confirmations).toEqual([]);
    await expectNoHorizontalOverflow(page);
    await checkLightAndDark(page, testInfo, 'access-confirm', '.access-confirm');

    const confirm = page.getByRole('button', { name: 'Confirm my email' });
    await expectTouchTarget(page, confirm);
    await confirm.click();
    await expect(page.getByRole('status')).toContainText('The admins of Acme Corp can now see your request.');
    expect(confirmations).toEqual([{ body: { token: 'emailed-token-0123456789abcdef' }, url: `${API}/api/workspace-access/confirm` }]);
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
    api.assertNoUnexpectedRequests();
  });

  test('admins approve a request with a chosen role, or decline one, through app dialogs', async ({ page }, testInfo) => {
    const api = await installSyntheticApi(page, { admin: true });
    let requests = [
      { email: 'rita@partner.example', emailVerifiedAt: '2026-10-10T11:00:00.000Z', id: 'req-1', name: 'Rita Requester', requestedAt: '2026-10-10T10:55:00.000Z', verificationMethod: 'email_link' },
      { email: 'sam@partner.example', emailVerifiedAt: '2026-10-09T09:00:00.000Z', id: 'req-2', name: 'Sam Second', requestedAt: '2026-10-09T09:00:00.000Z', verificationMethod: 'earlier_confirmation' },
    ];
    const decisions = [];
    await page.route('**/api/tenants/**', (route) => route.fulfill({ json: { domains: [], invites: [], requests: [], statuses: [], task_types: [], tenant_name: 'Synthetic workspace', users: [] } }));
    await page.route(`${API}/api/tenants/user-requests**`, (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === 'GET') return route.fulfill({ json: { ok: true, requests } });
      const [, , , , id, action] = path.split('/');
      decisions.push({ action, body: request.postDataJSON(), id });
      requests = requests.filter((item) => item.id !== id);
      return route.fulfill({ json: { message: action === 'approve' ? 'Rita Requester joined as manager.' : 'Request declined.', ok: true } });
    });

    await authenticateSyntheticUser(page);
    // The admin notification email links straight to this tab.
    await page.goto('admin?section=user-management&tab=requests');
    const panel = page.locator('.join-requests');
    await expect(panel.getByRole('heading', { name: 'Requests to join' })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Requests to Join/ })).toContainText('2');
    const list = panel.getByRole('list', { name: 'Requests to join' });
    await expect(list.getByRole('listitem')).toHaveCount(2);
    await expect(list.getByRole('listitem').first()).toContainText('Confirmed by email link');
    await expect(list.getByRole('listitem').nth(1)).toContainText('Confirmed on an earlier request');
    await panel.getByRole('searchbox', { name: 'Search requests' }).fill('sam');
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await panel.getByRole('searchbox', { name: 'Search requests' }).fill('');
    // The legacy admin layout keeps its sidebar on phones, so the panel must fit a narrow column.
    const panelBox = await panel.boundingBox();
    expect(panelBox.width).toBeLessThanOrEqual(page.viewportSize().width);
    for (const control of [panel.getByRole('searchbox', { name: 'Search requests' }), panel.getByLabel('Sort by'), list.getByRole('button', { name: 'Decline Sam Second' })]) {
      const box = await control.boundingBox();
      expect(box.x + box.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 1);
    }
    await checkLightAndDark(page, testInfo, 'join-requests-panel', '.join-requests');

    const approve = list.getByRole('button', { name: 'Approve Rita Requester' });
    await expectTouchTarget(page, approve);
    await approve.click();
    const approveDialog = page.getByRole('dialog', { name: 'Approve Rita Requester?' });
    await expect(approveDialog).toContainText('rita@partner.example');
    const role = approveDialog.getByLabel('Role in this workspace');
    await expect(role).toHaveValue('user');
    await role.selectOption('manager');
    await expectNoAxeViolations(page, testInfo, 'approve-dialog', 'dialog');
    await approveDialog.getByRole('button', { name: 'Approve and add' }).click();
    await expect(approveDialog).not.toBeVisible();
    await expect(panel.getByRole('status')).toContainText('Rita Requester joined as manager.');
    await expect(page.getByRole('tab', { name: /Requests to Join/ })).toContainText('1');

    await list.getByRole('button', { name: 'Decline Sam Second' }).click();
    const declineDialog = page.getByRole('dialog', { name: 'Decline Sam Second?' });
    await expect(declineDialog).toContainText('can’t ask again for 7 days');
    await expectNoAxeViolations(page, testInfo, 'decline-dialog', 'dialog');
    await declineDialog.getByRole('button', { name: 'Decline request' }).click();
    await expect(declineDialog).not.toBeVisible();
    await expect(panel.getByText('No one is waiting to join.')).toBeVisible();
    expect(decisions).toEqual([
      { action: 'approve', body: { role: 'manager' }, id: 'req-1' },
      { action: 'decline', body: {}, id: 'req-2' },
    ]);
    api.assertNoUnexpectedRequests();
  });

  test('profile email notifications offer only what Odin sends and save with the honored marker', async ({ page }, testInfo) => {
    const api = await installSyntheticApi(page);
    const saves = [];
    // Saved by the old form: every box unchecked, which never stopped an email.
    const profile = { email: syntheticUser.email, firstName: 'Synthetic', lastName: 'Demo', name: 'Synthetic Demo', preferences: { emailNotifMentions: false, emailNotifTasks: false, inAppNotifComments: false, twoFactorEnabled: false } };
    await page.route(`${API}/api/users/me`, (route) => {
      if (route.request().method() === 'PUT') {
        saves.push(route.request().postDataJSON().preferences);
        return route.fulfill({ json: { ok: true, user: { ...profile, preferences: saves.at(-1) } } });
      }
      return route.fulfill({ json: { ok: true, sessions: [], user: profile } });
    });
    await authenticateSyntheticUser(page);
    await page.goto('user?tab=preferences');
    const settings = page.getByRole('group', { name: 'Email me when' });
    await expect(settings.getByRole('checkbox')).toHaveCount(5);
    for (const label of ['Someone mentions me', 'Someone replies on my topics', 'Something needs my attention', 'Scheduled reports sent to me', 'Chat email digest']) {
      await expect(settings.getByRole('checkbox', { name: label })).toBeChecked();
    }
    await expect(page.getByText(/in-app/i)).toHaveCount(0);
    await checkLightAndDark(page, testInfo, 'notification-preferences', '.notification-settings');

    await expect(settings.getByText('Notifications you have not seen in Odin within 10 minutes', { exact: false })).toBeVisible();
    await settings.getByRole('checkbox', { name: 'Someone mentions me' }).uncheck();
    await settings.getByRole('checkbox', { name: 'Chat email digest' }).uncheck();
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect.poll(() => saves.length).toBe(1);
    expect(saves[0]).toMatchObject({ emailNotifChannelDigest: false, emailNotifMentions: false, emailNotifSummaries: true, emailNotifTasks: true, emailNotifTopicReplies: true, notificationPrefsVersion: 1 });
    api.assertNoUnexpectedRequests();
  });
});
