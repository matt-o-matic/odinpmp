import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { playwrightAppOrigin } from './fixtures/requirements-api.js';
import { PORTAL_TOKENS, closeThread, createReviewWorld, drawMark, installCaptureFailingPrototype, installPortalApi } from './fixtures/requirements-portal-api.js';
import { installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';
import { settleForAxe } from './fixtures/axe-settle.js';

// Prototype screens in the guided review (AC-09 UI). Browse to a second state, switch to
// Annotate, pin an element: the snapshot uploads as a PNG and the mark records the state
// key, the snapshot, and the element hint from the real bridge. The real review origin
// (backend/src/review-origin/app.js) serves the example package with a signed grant, as in
// requirements-prototype-origin.acceptance.spec.js. The second test covers a prototype
// whose snapshot fails: the reviewer marks up a blank frame, saved with a note.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const backendModule = (relative) => import(pathToFileURL(path.join(REPO_ROOT, 'backend', 'src', relative)).href);
const GRANT_SECRET = 'playwright-review-grant-secret-0123456789abcdef';
const REVIEW = `requirements/${PORTAL_TOKENS.ravi}/rounds/round-2`;
const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];

let reviewServer = null;
let entryUrls = null;
let setupError = '';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

async function examplePackageBytes() {
  const built = path.join(REPO_ROOT, 'output', 'review-packages', 'fieldwork-round-2.zip');
  if (existsSync(built)) return readFileSync(built);
  const { buildExample } = await import(pathToFileURL(path.join(REPO_ROOT, 'tools', 'review-package', 'build-examples.mjs')).href);
  const dir = mkdtempSync(path.join(tmpdir(), 'odin-u7-package-'));
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
    const requirementsRepository = { getTopicTrack: async () => 'experience', listRounds: async () => [] };
    const outcome = await service.ingestPackage({ mermaidValidator: null, packageStorage: storage, packagesRepository, requirementsRepository }, {
      bytes: await examplePackageBytes(), projectId: syntheticProject.id, source: 'mcp', tenantId: 'tenant-synthetic', track: 'experience', uploadedBy: 'user:user-dana',
    });
    if (outcome.status !== 'accepted') throw new Error(`The example package was rejected: ${JSON.stringify(outcome.errors)}`);
    const app = createReviewOriginApp({ frontendAppUrl: `${playwrightAppOrigin()}/app`, grantSecret: GRANT_SECRET, mayViewGrant: async () => true, packagesRepository, storage });
    reviewServer = http.createServer(app);
    const origin = await listen(reviewServer);
    const issued = await service.issuePackageGrant(
      { packagesRepository, reviewGrantSecret: GRANT_SECRET, reviewPublicUrl: origin },
      { linkId: 'link-ravi', packageId: outcome.package.id, tokenId: 'token-ravi', viewerRef: 'stakeholder:stakeholder-ravi' },
    );
    entryUrls = issued.entryUrls;
  } catch (error) {
    setupError = String(error?.stack ?? error);
  }
});

test.afterAll(async () => {
  if (reviewServer) await new Promise((resolve) => reviewServer.close(resolve));
});

async function expectNoSeriousIssues(page, testInfo, name) {
  await settleForAxe(page);
  const results = await new AxeBuilder({ page }).include('.rq-portal').exclude('iframe').withTags(wcagTags).analyze();
  await testInfo.attach(`axe-${name}.json`, { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' });
  expect(results.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact)).map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`), name).toEqual([]);
}

async function openOnPrototype(page, world) {
  world.reviewers.ravi.position = { screenId: 'booking-flow', step: 'screens' };
  const api = await installSyntheticApi(page);
  await installPortalApi(page, world, { standInOrigin: false });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(REVIEW);
  await expect(page.getByRole('heading', { level: 2, name: 'Booking flow' })).toBeVisible();
  return { api, errors };
}

test('browse to a second state, annotate a snapshot, and save a pin with its state, snapshot, and element hint', async ({ isMobile, page }, testInfo) => {
  test.setTimeout(150_000);
  expect(setupError, 'review origin setup').toBe('');
  const world = createReviewWorld({ entryUrls });
  const { api, errors } = await openOnPrototype(page, world);

  const status = page.getByTestId('rq-proto-status');
  await expect(status).toHaveText('Showing Choose service', { timeout: 30_000 });
  await expect(page.locator('.rq-proto__frame')).toHaveAttribute('sandbox', 'allow-scripts allow-forms');
  await expectNoSeriousIssues(page, testInfo, 'prototype-browse');
  const states = page.getByRole('group', { name: 'States' });
  await states.getByRole('button', { name: 'Pick a time' }).click();
  await expect(status).toHaveText('Showing Pick a time');
  await expect.poll(() => world.reviewers.ravi.position?.stateKey).toBe('pick-time');

  // Where the day row sits in the frame, as a fraction of the viewport.
  const frameBox = await page.locator('.rq-proto__frame').boundingBox();
  const target = await page.frameLocator('.rq-proto__frame').locator('[data-odin-id="day-row"]').boundingBox();
  const at = [(target.x + target.width * 0.3 - frameBox.x) / frameBox.width, (target.y + target.height / 2 - frameBox.y) / frameBox.height];

  await page.getByRole('button', { name: 'Annotate' }).click();
  await expect(page.locator('.rq-snapbanner')).toContainText('Annotating a snapshot of Pick a time', { timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Annotate' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.locator('.annotation-canvas__image').evaluate((image) => image.naturalWidth)).toBe(1280);

  await drawMark(page, 'pin', at);
  const thread = page.getByTestId('rq-annotation-thread');
  await expect(thread).toContainText('Attached to:', { timeout: 15_000 });
  await expect(thread.locator('code')).toHaveText('day-row');
  await thread.getByRole('combobox', { name: 'Category' }).selectOption('behavior');
  await thread.getByRole('textbox').fill('Greyed-out days look clickable. Hide them, or say “fully booked”.');
  await thread.getByRole('button', { name: 'Post comment' }).click();
  await expect(thread.getByText('Greyed-out days look clickable.', { exact: false })).toBeVisible();
  await expectNoSeriousIssues(page, testInfo, 'prototype-annotate');

  const saved = () => world.annotations.find((annotation) => annotation.author === 'ravi' && annotation.screenId === 'booking-flow');
  await expect.poll(() => saved()?.category).toBe('behavior');
  const annotation = saved();
  expect(annotation.stateKey).toBe('pick-time');
  expect(annotation.elementHint).toMatchObject({ odinId: 'day-row' });
  expect(annotation.elementHint.box.width).toBeGreaterThan(0);
  expect(annotation.snapshotFileId).toBeTruthy();
  const snapshot = world.snapshots.get(annotation.snapshotFileId);
  expect(snapshot).toMatchObject({ height: 800, screenId: 'booking-flow', stateKey: 'pick-time', width: 1280 });
  const order = world.calls.map((call) => `${call.method} ${call.path.replace(/\?.*$/, '').replace(/[0-9a-f-]{36}/, ':id')}`).filter((call) => call.includes('snapshots') || call.includes('annotations'));
  expect(order[0]).toBe('POST /snapshots');
  expect(order[1]).toBe('PUT /annotations/:id');

  // Back to browsing, then reopen the saved mark from the list: its own snapshot comes back.
  await page.getByRole('button', { name: 'Back to browsing' }).click();
  await expect(page.getByRole('button', { name: 'Browse' })).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(page.getByRole('heading', { level: 2, name: 'Booking flow' })).toBeVisible();

  // Browsing shows the mark over the live prototype where it was drawn, on its state only.
  await expect(status).toHaveText('Showing Pick a time', { timeout: 30_000 });
  const livePin = page.locator('.rq-proto__overlay').getByRole('button', { name: /Pin · Ravi Shah · Behavior/ });
  await expect(livePin).toBeVisible();
  const liveFrame = await page.locator('.rq-proto__frame').boundingBox();
  const pinBox = await livePin.boundingBox();
  expect(Math.abs(pinBox.x + pinBox.width / 2 - (liveFrame.x + at[0] * liveFrame.width))).toBeLessThan(6);
  expect(Math.abs(pinBox.y + pinBox.height - (liveFrame.y + at[1] * liveFrame.height))).toBeLessThan(6);
  const yourLayer = page.locator('.rq-review-proto__layers').getByRole('button', { name: 'Ravi Shah (you), 1 mark' });
  await yourLayer.click();
  await expect(livePin).toHaveCount(0);
  await yourLayer.click();
  await expect(livePin).toBeVisible();
  await states.getByRole('button', { name: 'Choose service' }).click();
  await expect(status).toHaveText('Showing Choose service');
  await expect(livePin).toHaveCount(0);
  await states.getByRole('button', { name: 'Pick a time' }).click();
  await expect(livePin).toBeVisible();
  // Its pin opens the mark's snapshot and thread.
  await livePin.click();
  await expect(page.locator('.rq-snapbanner')).toContainText('Showing a saved snapshot of Pick a time');
  await expect(page.getByTestId('rq-annotation-thread')).toContainText('Greyed-out days look clickable.');
  await page.getByRole('button', { name: 'Back to browsing' }).click();

  if (isMobile) await page.locator('summary', { hasText: 'Marks · 1' }).click();
  else await page.getByRole('tab', { name: /Marks · 1/ }).click();
  await page.getByRole('option', { name: /^\d+\. Pin · Ravi Shah · Behavior$/ }).click();
  await expect(page.locator('.rq-snapbanner')).toContainText('Showing a saved snapshot of Pick a time');
  await expect.poll(() => page.locator('.annotation-canvas__image').evaluate((image) => image.naturalWidth)).toBe(1280);
  await expect(page.getByRole('button', { name: /Pin · Ravi Shah · Behavior/ })).toBeVisible();
  expect(errors).toEqual([]);
  api.assertNoUnexpectedRequests();
});

test('when the snapshot fails, the reviewer marks up a blank frame saved with a note', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const world = createReviewWorld();
  await installSyntheticApi(page);
  await installPortalApi(page, world);
  // Installed after the stand-in origin, so this route answers first.
  world.entryUrls = { 'booking-flow': await installCaptureFailingPrototype(page) };
  world.reviewers.ravi.position = { screenId: 'booking-flow', step: 'screens' };
  await page.goto(REVIEW);
  await expect(page.getByTestId('rq-proto-status')).toHaveText('Showing Choose service', { timeout: 30_000 });

  await page.getByRole('button', { name: 'Annotate' }).click();
  const banner = page.locator('.rq-snapbanner');
  await expect(banner).toContainText('Snapshot unavailable.');
  await expect(banner).toContainText('This prototype draws on a canvas the snapshot cannot read.');
  await expect(banner).toContainText('blank 1280 × 800 frame');
  await expect(page.locator('.annotation-canvas__blank')).toContainText('Snapshot unavailable');
  await expectNoSeriousIssues(page, testInfo, 'prototype-capture-failed');

  await drawMark(page, 'pin', [0.5, 0.5]);
  const thread = page.getByTestId('rq-annotation-thread');
  await expect(thread).toContainText('Snapshot unavailable. This mark is on a blank frame of the screen.');
  await closeThread(page);
  await expect.poll(() => world.annotations.find((annotation) => annotation.author === 'ravi' && annotation.screenId === 'booking-flow')?.anchor).toEqual({ note: 'Snapshot unavailable', snapshotUnavailable: true });
  const annotation = world.annotations.find((entry) => entry.author === 'ravi' && entry.screenId === 'booking-flow');
  expect(annotation.snapshotFileId).toBeNull();
  expect(annotation.stateKey).toBe('choose-service');
  expect(world.snapshots.size).toBe(0);
});
