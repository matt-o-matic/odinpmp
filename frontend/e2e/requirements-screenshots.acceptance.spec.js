import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { defaultRequirementsScenario, installRequirementsApi } from './fixtures/requirements-api.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

// Review screenshots of every Requirements view with synthetic data. Files go to
// output/playwright/u6a/ (gitignored).
// Opt-in: this writes review images rather than asserting behavior, so it stays out of the
// normal acceptance runs. Run with ODIN_REVIEW_SCREENSHOTS=1.
test.skip(!process.env.ODIN_REVIEW_SCREENSHOTS, 'Set ODIN_REVIEW_SCREENSHOTS=1 to write review screenshots.');
const outputDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'output', 'playwright', 'u6a');
const base = `projects/${syntheticProject.id}/requirements`;

async function open(page) {
  const api = await installSyntheticApi(page);
  await installRequirementsApi(page, defaultRequirementsScenario());
  await authenticateSyntheticUser(page);
  return api;
}

async function waitForScrollToSettle(page) {
  await page.waitForFunction(() => new Promise((resolve) => {
    const start = window.scrollY;
    setTimeout(() => resolve(window.scrollY === start), 150);
  }));
}

async function shot(page, name) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ animations: 'disabled', fullPage: true, path: path.join(outputDir, `${name}.png`) });
}

test.describe('Requirements review screenshots @screenshots', () => {
  test('desktop views', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop', 'Desktop screenshots use the desktop project.');
    test.setTimeout(120_000);
    await page.setViewportSize({ height: 1000, width: 1440 });
    const api = await open(page);

    await page.goto(base);
    await expect(page.getByRole('region', { name: 'Needs your decision' })).toBeVisible();
    await shot(page, 'desktop-my-items');

    await page.goto(`${base}/experience/discuss`);
    await expect(page.getByText('Clients should never be surprised by the final price.')).toBeVisible();
    await shot(page, 'desktop-track-discuss');

    await page.goto(`${base}/experience/brief`);
    await expect(page.getByText('Clients book a home visit in under two minutes.')).toBeVisible();
    await shot(page, 'desktop-track-brief');

    await page.goto(`${base}/experience/decide`);
    await expect(page.getByText('Booking is the first task on the home screen.').first()).toBeVisible();
    await shot(page, 'desktop-track-decide');

    await page.goto(`${base}/experience/review`);
    await expect(page.getByRole('region', { name: 'Review rounds' }).getByText('Round 2 · Client booking, booking first')).toBeVisible();
    await shot(page, 'desktop-track-review');

    await page.goto(`${base}/experience/plan`);
    await expect(page.getByText('No plan yet')).toBeVisible();
    await shot(page, 'desktop-track-plan');

    await page.goto(`${base}/topics/topic-price`);
    await expect(page.getByRole('heading', { name: 'Should clients see an estimated price before they pick a time?' })).toBeVisible();
    await shot(page, 'desktop-topic');

    await page.goto(`${base}/topics/topic-reminder`);
    await expect(page.getByText('Not enough input yet')).toBeVisible();
    await shot(page, 'desktop-topic-not-enough-input');

    await page.goto(`${base}/topics/topic-home`);
    await expect(page.getByText('Recorded by Morgan Lee', { exact: false })).toBeVisible();
    await shot(page, 'desktop-topic-decided');

    await page.goto(`${base}/links`);
    await expect(page.getByRole('heading', { name: 'Stakeholder links' })).toBeVisible();
    await shot(page, 'desktop-links');

    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.goto(`${base}/topics/topic-price`);
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await expect(page.getByRole('heading', { name: 'Should clients see an estimated price before they pick a time?' })).toBeVisible();
    await shot(page, 'desktop-topic-dark');
    api.assertNoUnexpectedRequests();
  });

  test('phone topic', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-mobile', 'Phone screenshots use the Pixel 7 project.');
    const api = await open(page);
    await page.goto(`${base}/topics/topic-price`);
    await expect(page.getByRole('navigation', { name: 'Jump to section' })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ animations: 'disabled', path: path.join(outputDir, 'phone-topic-top.png') });
    await page.getByRole('navigation', { name: 'Jump to section' }).getByRole('link', { name: 'Summary' }).click();
    await expect(page.locator('#rq-summary-heading')).toBeFocused();
    await waitForScrollToSettle(page);
    await page.screenshot({ animations: 'disabled', path: path.join(outputDir, 'phone-topic-summary.png') });
    await page.getByRole('navigation', { name: 'Jump to section' }).getByRole('link', { name: /Decision/ }).click();
    await expect(page.locator('#rq-decision-heading')).toBeFocused();
    await waitForScrollToSettle(page);
    await page.screenshot({ animations: 'disabled', path: path.join(outputDir, 'phone-topic-decision.png') });
    await shot(page, 'phone-topic-full');

    await page.goto(base);
    await expect(page.getByRole('region', { name: 'Needs your decision' })).toBeVisible();
    await shot(page, 'phone-my-items');
    await page.goto(`${base}/experience/discuss`);
    await expect(page.getByText('Do technicians see client notes before the visit?')).toBeVisible();
    await shot(page, 'phone-track-discuss');
    api.assertNoUnexpectedRequests();
  });
});
