import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { installRequirementsApi } from './fixtures/requirements-api.js';
import { installRequirementsRoundsApi, roundsScenario } from './fixtures/requirements-rounds-api.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

// Review screenshots of the round views (U6c) with synthetic data. Files go to
// output/playwright/u6c/ (gitignored). Opt-in: run with ODIN_REVIEW_SCREENSHOTS=1.
test.skip(!process.env.ODIN_REVIEW_SCREENSHOTS, 'Set ODIN_REVIEW_SCREENSHOTS=1 to write review screenshots.');
const outputDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'output', 'playwright', 'u6c');
const base = `projects/${syntheticProject.id}/requirements`;

async function open(page, adjust = () => {}) {
  const scenario = roundsScenario();
  adjust(scenario);
  await installSyntheticApi(page);
  const requirements = await installRequirementsApi(page, scenario);
  await installRequirementsRoundsApi(page, requirements);
  await authenticateSyntheticUser(page);
}

async function shot(page, name) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ animations: 'disabled', fullPage: true, path: path.join(outputDir, `${name}.png`) });
}

test.describe('Review round screenshots @screenshots', () => {
  test('desktop', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop', 'Desktop screenshots use the desktop project.');
    test.setTimeout(120_000);
    await page.setViewportSize({ height: 1000, width: 1440 });
    await open(page);

    await page.goto(`${base}/review`);
    await expect(page.getByRole('list', { name: 'Rounds' })).toBeVisible();
    await shot(page, 'desktop-review-stage');

    await page.goto(`${base}/review/rounds/round-2`);
    await expect(page.getByRole('heading', { name: /Round 2 results/ })).toBeVisible();
    await expect(page.getByText('Keep one primary "Book a visit" action.')).toBeVisible();
    await shot(page, 'desktop-round-results');

    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await shot(page, 'desktop-round-results-dark');
    await page.evaluate(() => document.documentElement.classList.remove('dark'));

    await page.getByRole('button', { name: 'Ravi Shah, Booking home: Keep with changes' }).click();
    await shot(page, 'desktop-round-verdict-detail');

    await page.getByRole('button', { name: 'Close round' }).click();
    await page.getByRole('dialog').getByText('Direction chosen').click();
    await page.getByRole('dialog').getByLabel('Direction', { exact: true }).selectOption('action-first');
    await shot(page, 'desktop-round-close-dialog');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

    await page.getByRole('button', { name: 'Edit reviewers and dates' }).click();
    await shot(page, 'desktop-round-edit-dialog');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

    await page.goto(`${base}/review/packages/package-3/publish`);
    await expect(page.getByRole('heading', { name: /Round 3 ·/ })).toBeVisible();
    await page.getByRole('checkbox', { name: /Jamie Ortiz/ }).check();
    await page.getByRole('checkbox', { name: /Ravi Shah/ }).check();
    await page.getByRole('checkbox', { name: /Noor Haddad/ }).check();
    await page.getByRole('checkbox', { name: /Alex Kim/ }).check();
    await page.getByRole('checkbox', { name: 'Jamie Ortiz is required' }).check();
    await shot(page, 'desktop-publish');

    await page.getByText('Screens accepted').click();
    await page.getByRole('button', { name: /Close round 2 and publish round 3/ }).click();
    await expect(page.getByRole('heading', { name: 'Round 3 published' })).toBeVisible();
    await shot(page, 'desktop-publish-done');

    await page.goto(base);
    await expect(page.getByRole('region', { name: 'Your drafts' })).toHaveCount(0);
    await page.goto(`${base}/review/rounds/round-1`);
    await expect(page.getByRole('heading', { name: /Round 1 results/ })).toBeVisible();
    await shot(page, 'desktop-round-closed');
  });

  test('my open items with a draft to publish', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop', 'Desktop screenshots use the desktop project.');
    await page.setViewportSize({ height: 1000, width: 1440 });
    await open(page);
    await page.goto(base);
    await expect(page.getByRole('region', { name: 'Your drafts' })).toBeVisible();
    await shot(page, 'desktop-my-items');
  });

  test('phone', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-mobile', 'Phone screenshots use the mobile project.');
    test.setTimeout(120_000);
    await open(page);
    await page.goto(`${base}/review/rounds/round-2`);
    await expect(page.getByText('Keep one primary "Book a visit" action.')).toBeVisible();
    await shot(page, 'phone-round-results');

    await page.goto(`${base}/review/packages/package-3/publish`);
    await expect(page.getByRole('heading', { name: /Round 3 ·/ })).toBeVisible();
    await shot(page, 'phone-publish');

    await page.goto(`${base}/review`);
    await expect(page.getByRole('list', { name: 'Rounds' })).toBeVisible();
    await shot(page, 'phone-review-stage');
  });
});
