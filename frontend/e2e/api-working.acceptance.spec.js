import { expect, test } from '@playwright/test';

import { authenticateSyntheticUser, installSyntheticApi } from './fixtures/synthetic-api.js';

const API_ORIGIN = 'http://localhost:3001';

// Holds a request open until the test releases it, so the working indicator can be inspected.
async function holdRequest(page, matcher) {
  let release = () => {};
  const released = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(matcher, async (route) => {
    await released;
    try {
      await route.fallback();
    } catch {
      // The page cancelled the request while it was held.
    }
  });
  return () => release();
}

// On narrow viewports the navigation links sit in the collapsed navbar.
async function openNavbarIfCollapsed(page) {
  const toggler = page.getByRole('button', { name: 'Toggle navigation' });
  if (await toggler.isVisible()) {
    await toggler.click();
    await expect(page.locator('#navbarSupportedContent.show:not(.collapsing)')).toBeVisible();
  }
}

test('sign-in blocks the page behind a cancellable working dialog', async ({ page }) => {
  const api = await installSyntheticApi(page);
  api.resetAuthentication();
  const releaseLogin = await holdRequest(page, `${API_ORIGIN}/api/auth/login`);

  await page.goto('/app/login');
  await page.getByLabel('Work email').fill('demo@example.com');
  await page.getByLabel('Password').fill('SyntheticPass123!');
  const signIn = page.getByRole('button', { name: 'Sign in' });
  await signIn.click();

  const dialog = page.getByRole('alertdialog', { name: 'Working...' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expect(page.locator('#app')).toHaveJSProperty('inert', true);

  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.locator('#app')).toHaveJSProperty('inert', false);
  await expect(page.getByText('Request cancelled.')).toBeVisible();
  await expect(signIn).toBeFocused();
  await expect(page).toHaveURL(/\/app\/login/);
  releaseLogin();
});

test('a user-started call shows the banner at once and the dialog after 5 seconds', async ({ page }) => {
  await installSyntheticApi(page);
  await authenticateSyntheticUser(page);
  const releaseLeaderboard = await holdRequest(page, (url) => url.pathname === '/api/metrics/leaderboard');

  await openNavbarIfCollapsed(page);
  await page.getByRole('button', { exact: true, name: 'Insights' }).click();
  await page.getByRole('link', { name: 'Leaderboard', exact: true }).click();
  const banner = page.getByRole('status').filter({ hasText: 'Working...' });
  await expect(banner).toBeVisible();
  await expect(page.getByRole('alertdialog')).toBeHidden();

  await expect(page.getByRole('alertdialog', { name: 'Working...' })).toBeVisible({ timeout: 7_000 });
  releaseLeaderboard();
  await expect(page.getByRole('alertdialog')).toBeHidden();
  await expect(banner).toBeHidden();
});

test('the working dialog stays on top of an open modal and can be cancelled', async ({ page }) => {
  await installSyntheticApi(page);
  await authenticateSyntheticUser(page);
  await page.goto('reports');
  await expect(page.getByRole('heading', { name: 'Search & reporting' })).toBeVisible();
  const reportingTabs = page.getByRole('navigation', { name: 'Search and reporting sections' });
  await reportingTabs.getByRole('button', { name: 'reports', exact: true }).click();
  await page.getByRole('button', { name: 'Add report' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Slow report');
  const releaseSave = await holdRequest(page, (url) => url.pathname === '/api/reporting/reports');

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const working = page.getByRole('alertdialog', { name: 'Working...' });
  await expect(working).toBeVisible({ timeout: 7_000 });

  await working.getByRole('button', { name: 'Cancel' }).click();
  await expect(working).toBeHidden();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Slow report');
  releaseSave();
});
