import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { installRequirementsApi } from './fixtures/requirements-api.js';
import { installRequirementsPlansApi, plansScenario } from './fixtures/requirements-plans-api.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

// Review screenshots of the Plan & work stage (U6d) with synthetic data. Files go to
// output/playwright/u6d/ (gitignored). Opt-in: run with ODIN_REVIEW_SCREENSHOTS=1.
test.skip(!process.env.ODIN_REVIEW_SCREENSHOTS, 'Set ODIN_REVIEW_SCREENSHOTS=1 to write review screenshots.');
const outputDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'output', 'playwright', 'u6d');
const planPath = `projects/${syntheticProject.id}/requirements/experience/plan`;

async function open(page, options) {
  await installSyntheticApi(page);
  const requirements = await installRequirementsApi(page, plansScenario(options));
  await installRequirementsPlansApi(page, requirements);
  await authenticateSyntheticUser(page);
}

async function shot(page, name) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ animations: 'disabled', fullPage: true, path: path.join(outputDir, `${name}.png`) });
}

test.describe('Plan & work screenshots @screenshots', () => {
  test('desktop', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop', 'Desktop screenshots use the desktop project.');
    test.setTimeout(120_000);
    await page.setViewportSize({ height: 1000, width: 1440 });

    await open(page, { latest: 'approved' });
    await page.goto(planPath);
    await expect(page.getByText('Owner: Morgan Lee')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Proposed work · pending review' })).toBeVisible();
    await shot(page, 'desktop-plan-approved');
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await shot(page, 'desktop-plan-approved-dark');
    await page.evaluate(() => document.documentElement.classList.remove('dark'));

    await page.getByRole('button', { name: 'Propose work' }).click();
    await expect(page.getByRole('link', { name: 'Review in AI Workspace' })).toBeVisible();
    await shot(page, 'desktop-plan-proposed');

    await page.getByRole('button', { name: 'Edit as new draft' }).click();
    await shot(page, 'desktop-plan-edit-approved');
  });

  test('desktop draft and empty', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop', 'Desktop screenshots use the desktop project.');
    test.setTimeout(120_000);
    await page.setViewportSize({ height: 1000, width: 1440 });
    await open(page);
    await page.goto(planPath);
    await expect(page.getByRole('heading', { name: 'Experience plan · v3' })).toBeVisible();
    await shot(page, 'desktop-plan-draft');
    await page.getByRole('button', { name: 'Approve' }).click();
    await shot(page, 'desktop-plan-approve-dialog');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('link', { name: 'View version 1' }).click();
    await expect(page.getByText('You’re viewing v1.')).toBeVisible();
    await shot(page, 'desktop-plan-v1-stale');
  });

  test('desktop empty', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop', 'Desktop screenshots use the desktop project.');
    await page.setViewportSize({ height: 1000, width: 1440 });
    await open(page, { latest: 'none' });
    await page.goto(planPath);
    await expect(page.getByText('No plan yet')).toBeVisible();
    await shot(page, 'desktop-plan-empty');
  });

  test('phone', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-mobile', 'Phone screenshots use the mobile project.');
    test.setTimeout(120_000);
    await open(page, { latest: 'approved' });
    await page.goto(planPath);
    await expect(page.getByText('Owner: Morgan Lee')).toBeVisible();
    await shot(page, 'phone-plan-approved');
    await page.getByRole('button', { name: 'Edit as new draft' }).click();
    await shot(page, 'phone-plan-edit');
  });
});
