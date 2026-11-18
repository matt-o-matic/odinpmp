import { expect, test } from '@playwright/test';
import { authenticateSyntheticUser, installSyntheticApi, syntheticUser } from './fixtures/synthetic-api.js';

const invitation = { email: 'invited@example.com', workspaceName: 'Inviting workspace', role: 'manager', accountExists: false };

// The invitation page reads the sign-up config for a reCAPTCHA site key. Without one (as on a
// server with no key configured) the form submits straight away with an empty token.
async function routeSignupConfig(page) {
  const configReads = [];
  await page.route('**/api/auth/register/config', (route) => {
    configReads.push(route.request().method());
    return route.fulfill({ json: { ok: true, recaptchaSiteKey: null } });
  });
  return configReads;
}

test('new invitee creates an account in the invited workspace', async ({ page }, testInfo) => {
  const api = await installSyntheticApi(page);
  const configReads = await routeSignupConfig(page);
  let joined = false;
  let registration;
  await page.route('**/api/auth/me', route => route.fulfill({ status: joined ? 200 : 401, json: joined ? { user: { ...syntheticUser, email: invitation.email, tenantName: invitation.workspaceName } } : { error: 'Authentication required.' } }));
  await page.route('**/api/auth/invites/synthetic-invite', route => route.fulfill({ json: { invitation } }));
  await page.route('**/api/auth/invites/synthetic-invite/register', route => {
    joined = true;
    registration = route.request().postDataJSON();
    return route.fulfill({ json: { session: { user: { ...syntheticUser, email: invitation.email, tenantName: invitation.workspaceName } } } });
  });
  await page.goto('invites/synthetic-invite');
  await expect(page.getByRole('heading', { name: 'Join Inviting workspace' })).toBeVisible();
  await expect(page.getByText('invited@example.com', { exact: true })).toBeVisible();
  await page.getByLabel('Full name').fill('Invited Person');
  await page.getByLabel('Password', { exact: true }).fill('TestingPass123!');
  await page.screenshot({ path: testInfo.outputPath('invitation-light.png') });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({ path: testInfo.outputPath('invitation-dark.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Create account and join' }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/app\/$/);
  // The honeypot stays empty and, with no site key, no CAPTCHA token is attached.
  expect(registration).toEqual({ name: 'Invited Person', password: 'TestingPass123!', recaptchaToken: '', website: '' });
  expect(configReads).toEqual(['GET']);
  api.assertNoUnexpectedRequests();
});

test('existing invitee signs in and returns to accept the invitation', async ({ page }) => {
  const api = await installSyntheticApi(page);
  await routeSignupConfig(page);
  let accepted = false;
  await page.route('**/api/auth/invites/synthetic-existing', route => route.fulfill({ json: { invitation: { ...invitation, email: syntheticUser.email, accountExists: true } } }));
  await page.route('**/api/auth/invites/synthetic-existing/accept', route => {
    accepted = true;
    return route.fulfill({ json: { session: { user: syntheticUser } } });
  });
  await page.goto('invites/synthetic-existing');
  await page.getByRole('link', { name: 'Sign in to join' }).click();
  await expect(page.getByLabel('Work email')).toHaveValue(syntheticUser.email);
  await page.getByLabel('Password', { exact: true }).fill('SyntheticPass123!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/invites\/synthetic-existing$/);
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(page).toHaveURL(/\/app\/$/);
  expect(accepted).toBe(true);
  api.assertNoUnexpectedRequests();
});

test('admin sees an unsent invite and can resend it', async ({ page }) => {
  await installSyntheticApi(page, { admin: true });
  let resendCount = 0;
  const invites = [{ email: invitation.email, role: 'admin', invite_token: 'old-token', sentOn: '2026-09-22', status: 'Pending Acceptance', deliveryStatus: 'not_queued' }];
  await page.route('**/api/tenants/**', route => {
    if (route.request().url().endsWith('/invites/resend')) {
      expect(route.request().postDataJSON()).toEqual({ invite_token: 'old-token' });
      resendCount += 1;
      Object.assign(invites[0], { invite_token: 'new-token', deliveryStatus: 'pending' });
      return route.fulfill({ json: { ok: true, message: 'Invitation email queued.' } });
    }
    return route.fulfill({ json: { tenant_name: 'Synthetic workspace', domains: [], users: [], requests: [], invites, statuses: [], task_types: [] } });
  });
  await authenticateSyntheticUser(page);
  await page.goto('admin');
  await page.getByRole('link', { name: /User Management/ }).click();
  await page.getByRole('tab', { name: 'Invites' }).click();
  const row = page.getByRole('row').filter({ hasText: invitation.email });
  await expect(row.getByText('Not queued', { exact: true })).toBeVisible();
  await row.getByRole('button', { name: 'Resend' }).click();
  await expect(row.getByText('Queued', { exact: true })).toBeVisible();
  expect(resendCount).toBe(1);
});

test('expired or revoked invitation shows an error instead of registration', async ({ page }) => {
  await installSyntheticApi(page);
  await page.route('**/api/auth/invites/synthetic-invalid', route => route.fulfill({ status: 410, json: { error: 'This invitation is no longer available. Ask your workspace administrator for a new invite.' } }));
  await page.goto('invites/synthetic-invalid');
  await expect(page.getByRole('alert')).toContainText('no longer available');
  await expect(page.getByRole('button', { name: 'Create account and join' })).toHaveCount(0);
});
