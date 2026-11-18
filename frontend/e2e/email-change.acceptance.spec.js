import { expect, test } from '@playwright/test';

import { authenticateSyntheticUser, installSyntheticApi, syntheticUser } from './fixtures/synthetic-api.js';

// Changing an account's email: the profile only asks for it and says where the link went, and
// the emailed link opens a page that confirms on a press, never on load (mail scanners open links).

const API = 'http://localhost:3001';

test('a new email waits for its link: the profile keeps the old one and says where the link went', async ({ page }) => {
  const api = await installSyntheticApi(page);
  const profile = { email: syntheticUser.email, firstName: 'Synthetic', lastName: 'Demo', name: 'Synthetic Demo', preferences: {} };
  const saves = [];
  let pendingEmail = null;
  await page.route(`${API}/api/users/me`, (route) => {
    if (route.request().method() === 'PUT') {
      saves.push(route.request().postDataJSON().email);
      pendingEmail = saves.at(-1);
      return route.fulfill({ json: { ok: true, pendingEmail, user: profile } });
    }
    return route.fulfill({ json: { ok: true, pendingEmail, sessions: [], user: profile } });
  });
  await authenticateSyntheticUser(page);
  await page.goto('user?tab=contact');

  const email = page.getByLabel('Email Address');
  await expect(email).toHaveValue(syntheticUser.email);
  await email.fill('new-address@example.com');
  await page.getByRole('button', { name: 'Save Changes' }).click();

  await expect(page.getByText('Saved. We sent a link to new-address@example.com. Your email changes when you open it.')).toBeVisible();
  expect(saves).toEqual(['new-address@example.com']);
  await expect(email).toHaveValue(syntheticUser.email);
  await expect(email).toHaveAccessibleDescription(/Waiting for you to confirm new-address@example\.com/);
  api.assertNoUnexpectedRequests();
});

test('the emailed link confirms the new address on a press, not on load', async ({ page }) => {
  const api = await installSyntheticApi(page);
  const confirmations = [];
  await page.route(`${API}/api/account/email-change/confirm`, (route) => {
    confirmations.push(route.request().postDataJSON());
    return route.fulfill({ json: { email: 'new-address@example.com', ok: true } });
  });
  await page.goto('account/confirm-email#emailed-token-0123456789abcdef');
  await expect(page.getByRole('heading', { name: 'Confirm your new email address' })).toBeVisible();
  expect(confirmations).toEqual([]);

  await page.getByRole('button', { name: 'Confirm my new email' }).click();
  await expect(page.getByRole('status')).toContainText('Your account now uses new-address@example.com');
  expect(confirmations).toEqual([{ token: 'emailed-token-0123456789abcdef' }]);
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
  api.assertNoUnexpectedRequests();
});
