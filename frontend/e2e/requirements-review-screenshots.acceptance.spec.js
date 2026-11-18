import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { defaultRequirementsScenario, installRequirementsApi } from './fixtures/requirements-api.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

// Review screenshots of the Review stage, package preview, and summary freshness with
// synthetic data. Files go to output/playwright/u6b/ (gitignored). Opt-in, like the other
// screenshot spec: run with ODIN_REVIEW_SCREENSHOTS=1.
test.skip(!process.env.ODIN_REVIEW_SCREENSHOTS, 'Set ODIN_REVIEW_SCREENSHOTS=1 to write review screenshots.');
const outputDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'output', 'playwright', 'u6b');
const base = `projects/${syntheticProject.id}/requirements`;
const ZIP_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);

async function open(page, adjust = () => {}) {
  const scenario = defaultRequirementsScenario();
  adjust(scenario);
  const api = await installSyntheticApi(page);
  const requirements = await installRequirementsApi(page, scenario);
  await authenticateSyntheticUser(page);
  return { api, requirements };
}

// Full-page captures stitch the page together; sticky and fixed chrome would repeat or
// float mid-page, so it is made static for those shots only.
const STATIC_CHROME = '.app-topbar, .app-frame > .navbar, .project-detail-tabs-bar, .rq-jumpbar { position: static !important; } .skip-link { display: none !important; }';

async function shot(page, name, { fullPage = true } = {}) {
  await page.evaluate(() => document.fonts.ready);
  const style = fullPage ? await page.addStyleTag({ content: STATIC_CHROME }) : null;
  if (fullPage) await page.evaluate(() => { document.scrollingElement.scrollTop = 0; });
  await page.screenshot({ animations: 'disabled', fullPage, path: path.join(outputDir, `${name}.png`) });
  await style?.evaluate((element) => element.remove());
}

async function drawFlows(page) {
  const flows = page.getByRole('region', { name: /^Flows/ });
  await flows.scrollIntoViewIfNeeded();
  await expect(flows.locator('.rq-flow__svg svg')).toBeVisible({ timeout: 20_000 });
  await page.evaluate(() => { document.scrollingElement.scrollTop = 0; });
}

test.describe('Review stage screenshots @screenshots', () => {
  test('desktop', async ({ context, page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop', 'Desktop screenshots use the desktop project.');
    test.setTimeout(180_000);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize({ height: 1000, width: 1440 });
    await open(page, (scenario) => { scenario.uploadMode = 'reject'; });

    await page.goto(`${base}/experience/review`);
    await expect(page.getByRole('region', { name: 'Review packages' }).getByRole('listitem')).toHaveCount(3);
    await shot(page, 'desktop-review-stage');

    await page.getByLabel('Upload package').setInputFiles({ buffer: ZIP_BYTES, mimeType: 'application/zip', name: 'round-4.zip' });
    await expect(page.getByTestId('rq-package-rejection')).toBeVisible();
    await shot(page, 'desktop-upload-rejected');

    await page.getByRole('button', { name: 'Upload URL for a coding agent' }).click();
    await page.getByRole('button', { name: 'Create upload URL' }).click();
    await expect(page.getByTestId('rq-upload-url')).toBeVisible();
    await shot(page, 'desktop-upload-url-dialog', { fullPage: false });
    await page.getByRole('button', { name: 'Done' }).click();

    await page.goto(`${base}/architecture/review`);
    await expect(page.getByText('No packages yet')).toBeVisible();
    await shot(page, 'desktop-review-empty');

    await page.goto(`${base}/experience/review/packages/package-3`);
    await expect(page.getByRole('region', { name: 'What changed since round 2' })).toBeVisible();
    await expect.poll(() => page.getByRole('img', { name: /Fieldwork home screen/ }).evaluate((element) => element.naturalWidth)).toBe(1280);
    await drawFlows(page);
    await shot(page, 'desktop-package-detail');
    await shot(page, 'desktop-package-detail-top', { fullPage: false });

    await page.goto(`${base}/experience/review/packages/package-3?screen=booking-flow`);
    const screens = page.getByRole('region', { name: /^Screens/ });
    await expect(screens.getByTestId('rq-proto-status')).toHaveText('Showing Choose service', { timeout: 20_000 });
    await screens.getByRole('group', { name: 'States' }).getByRole('button', { name: 'Pick a time' }).click();
    await expect(screens.getByTestId('rq-proto-status')).toHaveText('Showing Pick a time');
    await screens.getByRole('button', { name: 'Check snapshot' }).click();
    await expect(screens.getByTestId('rq-snapshot-status')).toHaveText('Snapshot taken, 1280 × 800.', { timeout: 40_000 });
    const frameBox = await screens.locator('iframe').boundingBox();
    const target = await page.frameLocator('.rq-proto__frame').locator('[data-odin-id="continue"]').boundingBox();
    const snap = screens.getByRole('img', { name: 'Snapshot of Booking flow' });
    const snapBox = await snap.boundingBox();
    await snap.click({ position: { x: ((target.x + target.width / 2 - frameBox.x) / frameBox.width) * snapBox.width, y: ((target.y + target.height / 2 - frameBox.y) / frameBox.height) * snapBox.height } });
    await expect(screens.getByTestId('rq-hint-result')).toContainText('continue');
    await screens.scrollIntoViewIfNeeded();
    await shot(page, 'desktop-package-prototype', { fullPage: false });
    const chrome = await page.addStyleTag({ content: STATIC_CHROME });
    await screens.screenshot({ animations: 'disabled', path: path.join(outputDir, 'desktop-package-prototype-section.png') });
    await chrome.evaluate((element) => element.remove());

    await page.getByRole('button', { name: 'Withdraw' }).click();
    await shot(page, 'desktop-withdraw-dialog', { fullPage: false });
    await page.getByRole('button', { name: 'Withdraw package' }).click();
    await expect(page.getByRole('note').filter({ hasText: 'Withdrawn' })).toBeVisible();
    await shot(page, 'desktop-package-withdrawn', { fullPage: false });
  });

  test('desktop: grant missing, dark mode, and summary freshness', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop', 'Desktop screenshots use the desktop project.');
    test.setTimeout(120_000);
    await page.setViewportSize({ height: 1000, width: 1440 });
    await open(page, (scenario) => {
      scenario.grantMode = 'not-configured';
      scenario.summaryRefreshMode = 'failed';
    });

    await page.goto(`${base}/experience/review/packages/package-3`);
    await expect(page.getByRole('region', { name: /^Screens/ }).getByText('Image unavailable')).toBeVisible();
    await page.getByRole('region', { name: /^Screens/ }).scrollIntoViewIfNeeded();
    await shot(page, 'desktop-package-no-review-origin', { fullPage: false });

    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);
    await shot(page, 'desktop-package-dark', { fullPage: false });
    await page.evaluate(() => document.documentElement.classList.remove('dark'));

    await page.goto(`${base}/topics/topic-price`);
    const summary = page.getByRole('region', { name: 'Odin summary' });
    await summary.getByRole('button', { name: 'Refresh the Odin summary' }).click();
    await expect(summary.getByText(/refresh failed/)).toBeVisible();
    await summary.screenshot({ animations: 'disabled', path: path.join(outputDir, 'desktop-summary-refresh-failed.png') });
    await shot(page, 'desktop-topic-refresh-failed', { fullPage: false });
  });

  test('mobile', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-mobile', 'Phone screenshots use the Pixel 7 project.');
    test.setTimeout(120_000);
    await open(page);

    await page.goto(`${base}/experience/review`);
    await expect(page.getByRole('region', { name: 'Review packages' }).getByRole('listitem')).toHaveCount(3);
    await shot(page, 'mobile-review-stage');

    await page.goto(`${base}/experience/review/packages/package-3`);
    await expect(page.getByRole('region', { name: 'What changed since round 2' })).toBeVisible();
    await expect.poll(() => page.getByRole('img', { name: /Fieldwork home screen/ }).evaluate((element) => element.naturalWidth)).toBe(1280);
    await drawFlows(page);
    await shot(page, 'mobile-package-detail');

    await page.goto(`${base}/experience/review/packages/package-3?screen=booking-flow`);
    const screens = page.getByRole('region', { name: /^Screens/ });
    await expect(screens.getByTestId('rq-proto-status')).toHaveText('Showing Choose service', { timeout: 20_000 });
    await screens.scrollIntoViewIfNeeded();
    await shot(page, 'mobile-package-prototype', { fullPage: false });
  });
});
