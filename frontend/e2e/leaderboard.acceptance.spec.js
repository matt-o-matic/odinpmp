import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { settleForAxe } from './fixtures/axe-settle.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticUser } from './fixtures/synthetic-api.js';

const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21aa'];
const LEADERBOARD = 'http://localhost:3001/api/metrics/leaderboard';

// Synthetic contributors: ten ahead of the signed-in user, who ranks twelfth.
const contributors = Array.from({ length: 11 }, (_, index) => ({
  hoursLogged: index === 0 ? 12.5 : index,
  id: `user-${index}`,
  isCurrentUser: false,
  name: index === 0 ? 'Margaret Hamilton-Bartholomew' : `Contributor ${index + 1}`,
  picture: null,
  points: 60 - (index * 4),
  rank: index + 1,
  tasksCompleted: 12 - index,
}));
const me = { hoursLogged: 1.5, id: syntheticUser.id, isCurrentUser: true, name: syntheticUser.name, picture: null, points: 3, rank: 12, tasksCompleted: 1 };

function leaderboardFor(days) {
  if (days === 7) return { contributorCount: 0, currentUser: null, days, leaderboard: [], ok: true };
  return { contributorCount: 12, currentUser: me, days, leaderboard: contributors.slice(0, 10), ok: true };
}

async function openLeaderboard(page) {
  const api = await installSyntheticApi(page);
  const requestedDays = [];
  await page.route(`${LEADERBOARD}**`, (route) => {
    const days = Number(new URL(route.request().url()).searchParams.get('days'));
    requestedDays.push(days);
    return route.fulfill({ body: JSON.stringify(leaderboardFor(days)), contentType: 'application/json', status: 200 });
  });
  await authenticateSyntheticUser(page);
  await page.goto('leaderboard');
  await expect(page.getByRole('heading', { level: 1, name: 'Leaderboard' })).toBeVisible();
  return { api, requestedDays };
}

async function expectNoAxeViolations(page, testInfo, name) {
  await settleForAxe(page);
  const results = await new AxeBuilder({ page }).include('.leaderboard-page').withTags(wcagTags).analyze();
  await testInfo.attach(`axe-${name}.json`, { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
  expect(results.violations).toEqual([]);
}

async function expectNoHorizontalOverflow(page) {
  const viewport = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth + 1);
}

test.describe('contributor leaderboard', () => {
  test('ranks contributors and keeps the signed-in user visible below the top ten', async ({ page }, testInfo) => {
    const { api, requestedDays } = await openLeaderboard(page);
    const table = page.getByRole('table', { name: /Top contributors in the last 30 days/ });
    const rows = table.locator('tbody tr:not(.leaderboard-gap)');

    await expect(rows).toHaveCount(11);
    await expect(rows.first()).toContainText('#1');
    await expect(rows.first()).toContainText('Margaret Hamilton-Bartholomew');
    await expect(rows.first()).toContainText('60');
    await expect(rows.first()).toContainText('12.5h');
    await expect(table.getByText('Contributor 11')).toHaveCount(0);

    const mine = table.locator('tr[aria-current="true"]');
    await expect(mine).toContainText('#12');
    await expect(mine).toContainText('Synthetic Demo');
    await expect(mine.getByText('You', { exact: true })).toBeVisible();
    await expect(page.getByText('You are #12 of 12 with 3 points and 1 item done in the last 30 days.')).toBeVisible();
    expect(requestedDays).toEqual([30]);

    await expect(page.getByRole('radio', { name: '30 days' })).toBeChecked();
    // Touch targets are 2.75rem; the app shrinks the root font on small screens.
    const minimumTarget = await page.evaluate(() => 2.75 * parseFloat(getComputedStyle(document.documentElement).fontSize));
    for (const period of ['7 days', '30 days', '90 days']) {
      const box = await page.locator('label', { hasText: period }).boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(minimumTarget - 0.5);
    }

    const help = page.locator('.leaderboard-help summary');
    await help.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Unassigned work counts for whoever marks it done.')).toBeVisible();

    await expectNoHorizontalOverflow(page);
    await page.screenshot({ fullPage: true, path: testInfo.outputPath('leaderboard-light.png') });
    await expectNoAxeViolations(page, testInfo, 'leaderboard-light');

    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.screenshot({ fullPage: true, path: testInfo.outputPath('leaderboard-dark.png') });
    await expectNoAxeViolations(page, testInfo, 'leaderboard-dark');
    api.assertNoUnexpectedRequests();
  });

  test('switching to a quiet period shows how points are earned', async ({ page }, testInfo) => {
    const { api, requestedDays } = await openLeaderboard(page);
    await expect(page.locator('tr[aria-current="true"]')).toBeVisible();

    await page.getByText('7 days', { exact: true }).click();
    await expect(page.getByRole('radio', { name: '7 days' })).toBeChecked();
    await expect(page.getByRole('heading', { name: 'No completed work in the last 7 days' })).toBeVisible();
    await expect(page.getByText('Marking a task, a ticket, or a story or epic without tasks as done earns its assignee one item and its story points.')).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
    expect(requestedDays).toEqual([30, 7]);

    await page.getByRole('radio', { name: '7 days' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', { name: '30 days' })).toBeChecked();
    await expect(page.locator('tr[aria-current="true"]')).toBeVisible();
    expect(requestedDays).toEqual([30, 7, 30]);

    await page.getByText('7 days', { exact: true }).click();
    await expect(page.getByRole('heading', { name: 'No completed work in the last 7 days' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ fullPage: true, path: testInfo.outputPath('leaderboard-empty.png') });
    await expectNoAxeViolations(page, testInfo, 'leaderboard-empty');
    api.assertNoUnexpectedRequests();
  });

  test('a failed load shows an application-styled error', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.route(`${LEADERBOARD}**`, (route) => route.fulfill({ body: JSON.stringify({ error: 'Leaderboard is unavailable.', ok: false }), contentType: 'application/json', status: 503 }));
    await authenticateSyntheticUser(page);
    await page.goto('leaderboard');
    await expect(page.getByRole('alert')).toContainText('Leaderboard is unavailable.');
    await expect(page.getByRole('table')).toHaveCount(0);
    api.assertNoUnexpectedRequests();
  });
});
