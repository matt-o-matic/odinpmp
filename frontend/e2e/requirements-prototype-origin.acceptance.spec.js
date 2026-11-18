import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { settleForAxe } from './fixtures/axe-settle.js';
import { defaultRequirementsScenario, installRequirementsApi, playwrightAppOrigin } from './fixtures/requirements-api.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

// ReviewPrototypeFrame against the real review origin (backend/src/review-origin/app.js)
// serving the example package output/review-packages/fieldwork-round-2.zip. The package is
// validated and stored by the backend's own ingest code in memory, the grant is a real
// signed grant, and the app API around it is synthetic. Proves ready, state, goto-state,
// capture, and hint round-trip through the component.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const backendModule = (relative) => import(pathToFileURL(path.join(REPO_ROOT, 'backend', 'src', relative)).href);
const GRANT_SECRET = 'playwright-review-grant-secret-0123456789abcdef';
const base = `projects/${syntheticProject.id}/requirements`;

let reviewServer = null;
let reviewOrigin = '';
let detail = null;
let grant = null;
let setupError = '';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

async function examplePackageBytes() {
  const built = path.join(REPO_ROOT, 'output', 'review-packages', 'fieldwork-round-2.zip');
  if (existsSync(built)) return readFileSync(built);
  const { buildExample } = await import(pathToFileURL(path.join(REPO_ROOT, 'tools', 'review-package', 'build-examples.mjs')).href);
  const dir = mkdtempSync(path.join(tmpdir(), 'odin-u6b-package-'));
  try {
    const result = await buildExample('fieldwork-round-2', dir);
    return readFileSync(result.target);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

test.beforeAll(async () => {
  try {
    const [{ createInMemoryObjectStorage }, { createInMemoryPackagesRepository }, service, { createReviewOriginApp }] = await Promise.all([
      backendModule('modules/requirements/packages/package-storage.js'),
      backendModule('modules/requirements/packages/packages.repository.js'),
      backendModule('modules/requirements/packages/packages.service.js'),
      backendModule('review-origin/app.js'),
    ]);
    const packagesRepository = createInMemoryPackagesRepository();
    const storage = createInMemoryObjectStorage();
    // The example's questions name topics in the Experience track; rounds don't exist yet.
    const requirementsRepository = { getTopicTrack: async () => 'experience', listRounds: async () => [] };
    const deps = { mermaidValidator: null, packageStorage: storage, packagesRepository, requirementsRepository };
    const outcome = await service.ingestPackage(deps, {
      bytes: await examplePackageBytes(), projectId: syntheticProject.id, source: 'mcp', tenantId: 'tenant-synthetic', track: 'experience', uploadedBy: 'user:user-dana',
    });
    if (outcome.status !== 'accepted') throw new Error(`The example package was rejected: ${JSON.stringify(outcome.errors)}`);

    const app = createReviewOriginApp({ frontendAppUrl: `${playwrightAppOrigin()}/app`, grantSecret: GRANT_SECRET, mayViewGrant: async () => true, packagesRepository, storage });
    reviewServer = http.createServer(app);
    reviewOrigin = await listen(reviewServer);
    const issued = await service.issuePackageGrant(
      { packagesRepository, reviewGrantSecret: GRANT_SECRET, reviewPublicUrl: reviewOrigin },
      { packageId: outcome.package.id, viewerRef: 'user:user-synthetic' },
    );
    grant = { entryUrls: issued.entryUrls, expiresAt: issued.expiresAt, ok: true };
    detail = await service.describePackage({ packagesRepository, requirementsRepository }, outcome.package);
    detail.uploader = { ...detail.uploader, name: 'Dana Cho' };
  } catch (error) {
    setupError = String(error?.stack ?? error);
  }
});

test.afterAll(async () => {
  if (reviewServer) await new Promise((resolve) => reviewServer.close(resolve));
});

test('the prototype frame round-trips ready, state, goto-state, capture, and hint with the real review origin', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  expect(setupError, 'review origin setup').toBe('');

  const scenario = defaultRequirementsScenario();
  scenario.packages = [detail];
  scenario.grants = { [detail.id]: grant };
  scenario.standInReviewOrigin = false;
  const api = await installSyntheticApi(page);
  await installRequirementsApi(page, scenario);
  const consoleErrors = [];
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  await authenticateSyntheticUser(page);

  const reviewResponses = [];
  page.on('response', (response) => {
    if (response.url().startsWith(reviewOrigin)) reviewResponses.push({ headers: response.headers(), status: response.status(), url: response.url() });
  });

  await page.goto(`${base}/experience/review/packages/${detail.id}?screen=booking-flow`);
  await expect(page.getByRole('heading', { name: `Version 1 · ${detail.title}` })).toBeVisible();
  const screens = page.getByRole('region', { name: /^Screens/ });
  const frameElement = screens.locator('iframe');
  await expect(frameElement).toHaveAttribute('src', new RegExp(`^${reviewOrigin.replace(/[.]/g, '\\.')}/p/${detail.id}/[^/]+/prototypes/booking/index\\.html\\?odin-parent=`));
  await expect(frameElement).toHaveAttribute('sandbox', 'allow-scripts allow-forms');

  // ready: the bridge reports the declared first state.
  const status = screens.getByTestId('rq-proto-status');
  await expect(status).toHaveText('Showing Choose service', { timeout: 30_000 });
  await expect(screens.getByTestId('rq-proto-notice')).toHaveText('This is a mockup. Don\'t type real personal or payment details into it.');
  await screens.locator('.rq-proto').first().screenshot({ path: testInfo.outputPath(`prototype-frame-${testInfo.project.name}.png`) });
  // The frame chrome and the reviewer notice, light and dark. The prototype inside the
  // frame is the package author's content, not Odin's, so axe skips it.
  for (const theme of ['light', 'dark']) {
    await page.evaluate((dark) => document.documentElement.classList.toggle('dark', dark), theme === 'dark');
    await settleForAxe(page);
    const results = await new AxeBuilder({ page }).include('.rq-proto').exclude('.rq-proto__frame').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    const serious = results.violations
      .filter((violation) => ['serious', 'critical'].includes(violation.impact))
      .map((violation) => `${violation.id}: ${violation.nodes.map((node) => `${node.target.join(' ')} (${node.any[0]?.message ?? ''})`).join(', ')}`);
    expect(serious, `axe ${theme}`).toEqual([]);
  }
  await page.evaluate(() => document.documentElement.classList.remove('dark'));

  // goto-state, then the state message the prototype sends back.
  const states = screens.getByRole('group', { name: 'States' });
  await states.getByRole('button', { name: 'Confirm' }).click();
  await expect(status).toHaveText('Showing Confirm');
  await states.getByRole('button', { name: 'Pick a time' }).click();
  await expect(status).toHaveText('Showing Pick a time');
  await expect(states.getByRole('button', { name: 'Pick a time' })).toHaveAttribute('aria-pressed', 'true');

  // A state change made inside the prototype reaches the app too.
  const frame = page.frameLocator('.rq-proto__frame');
  await frame.locator('[data-odin-id="continue"]').click();
  await expect(status).toHaveText('Showing Confirm');
  await states.getByRole('button', { name: 'Pick a time' }).click();
  await expect(status).toHaveText('Showing Pick a time');

  // capture: a real PNG from the bridge, at the frame's CSS size.
  await screens.getByRole('button', { name: 'Check snapshot' }).click();
  await expect(screens.getByTestId('rq-snapshot-status')).toHaveText('Snapshot taken, 1280 × 800.', { timeout: 60_000 });
  const shot = screens.getByRole('img', { name: 'Snapshot of Booking flow' });
  await expect.poll(() => shot.evaluate((element) => element.naturalWidth)).toBe(1280);
  const sample = await shot.evaluate((element) => {
    const canvas = document.createElement('canvas');
    canvas.width = element.naturalWidth;
    canvas.height = element.naturalHeight;
    const context = canvas.getContext('2d');
    context.drawImage(element, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set();
    for (let index = 0; index < pixels.length; index += 4 * 97) colors.add(`${pixels[index]},${pixels[index + 1]},${pixels[index + 2]}`);
    return colors.size;
  });
  expect(sample, 'the snapshot is not blank').toBeGreaterThan(20);

  // hint: click the snapshot over the Continue link and get its data-odin-id back.
  const frameBox = await frameElement.boundingBox();
  const target = await frame.locator('[data-odin-id="continue"]').boundingBox();
  const shotBox = await shot.boundingBox();
  await shot.click({
    position: {
      x: ((target.x + target.width / 2 - frameBox.x) / frameBox.width) * shotBox.width,
      y: ((target.y + target.height / 2 - frameBox.y) / frameBox.height) * shotBox.height,
    },
  });
  const hint = screens.getByTestId('rq-hint-result');
  await expect(hint).toContainText('data-odin-id continue');
  await expect(hint).toContainText('“Continue to confirm →”');

  // The image screens load from the same origin under the same grant.
  await screens.getByRole('button', { name: /Booking home, schedule first/ }).click();
  const image = screens.getByRole('img', { name: /week calendar/ });
  await expect.poll(() => image.evaluate((element) => element.naturalWidth)).toBe(1280);

  const html = reviewResponses.find((entry) => entry.url.includes('/prototypes/booking/index.html'));
  expect(html?.status).toBe(200);
  expect(html.headers['content-security-policy']).toContain('sandbox allow-scripts allow-forms');
  expect(html.headers['content-security-policy']).toContain(`frame-ancestors ${playwrightAppOrigin()}`);
  expect(html.headers['set-cookie']).toBeUndefined();
  await testInfo.attach('review-origin-responses.json', { body: JSON.stringify(reviewResponses.map(({ status, url }) => ({ status, url: url.replace(/\/p\/[^/]+\/[^/]+\//, '/p/<id>/<grant>/') })), null, 2), contentType: 'application/json' });
  expect(consoleErrors).toEqual([]);
  api.assertNoUnexpectedRequests();
});
