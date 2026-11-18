import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { REVIEW_ORIGIN, defaultRequirementsScenario, installRequirementsApi, packageDetail, FIELDWORK_MANIFEST } from './fixtures/requirements-api.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';
import { settleForAxe } from './fixtures/axe-settle.js';

// Review stage, package upload, and package preview (AC-03 UI, AC-04 UI, AC-12 changes list,
// AC-17 for the new views). Synthetic API; screens come from the stand-in review origin in
// the fixture, which serves the fieldwork example files with the real bridge script.
const base = `projects/${syntheticProject.id}/requirements`;
const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];
// A zip's first bytes; the synthetic API never unpacks it.
const ZIP_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]);

async function open(page, path, adjust = () => {}) {
  const scenario = defaultRequirementsScenario();
  adjust(scenario);
  const api = await installSyntheticApi(page);
  const requirements = await installRequirementsApi(page, scenario);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await authenticateSyntheticUser(page);
  await page.goto(path);
  return { api, pageErrors, requirements };
}

// Prototype frames hold the package author's own markup, which is not Odin's UI.
async function expectNoSeriousIssues(page, testInfo, name, include = '.rq-workspace') {
  await settleForAxe(page);
  const results = await new AxeBuilder({ page }).include(include).exclude('.rq-proto__frame').withTags(wcagTags).analyze();
  await testInfo.attach(`axe-${name}.json`, { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' });
  const serious = results.violations
    .filter((violation) => ['serious', 'critical'].includes(violation.impact))
    .map((violation) => `${violation.id}: ${violation.nodes.map((node) => {
      const data = node.any?.[0]?.data;
      const colors = data?.contrastRatio ? ` (${data.fgColor} on ${data.bgColor}, ${data.contrastRatio}:1)` : '';
      return `${node.target.join(' ')}${colors} "${String(node.html).slice(0, 80)}"`;
    }).join(', ')}`);
  expect(serious, name).toEqual([]);
}

const packagesRegion = (page) => page.getByRole('region', { name: 'Review packages' });

test.describe('Requirements Review stage: packages', () => {
  test('lists packages with drafts first, the uploader by name, the source, and warnings; rounds stay below', async ({ page }) => {
    const { api } = await open(page, `${base}/review`);
    const list = packagesRegion(page).getByRole('list', { name: 'Review packages' });
    const rows = list.getByRole('listitem');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('Client booking — price and booking flow');
    await expect(rows.nth(0)).toContainText('Dana Cho · uploaded through MCP · 4.2 MB · 38 files');
    await expect(rows.nth(0)).toContainText('1 warning');
    await expect(rows.nth(0)).toContainText('Draft');
    await expect(rows.nth(1)).toContainText('Published');
    await expect(rows.nth(2)).toContainText('Morgan Lee · uploaded in Odin');
    await expect(packagesRegion(page).getByText('1 draft', { exact: true })).toBeVisible();
    const rounds = page.getByRole('region', { name: 'Review rounds' });
    await expect(rounds).toContainText('Round 2 · Client booking, booking first');
    await expect(rounds).toContainText('package v2 · 3 of 5 submitted');

    await rows.nth(0).getByRole('link', { name: 'Version 3: Client booking — price and booking flow' }).click();
    await expect(page).toHaveURL(/\/requirements\/review\/packages\/package-3$/);
    await expect(page.getByRole('heading', { name: 'Version 3 · Client booking — price and booking flow' })).toBeVisible();

    // Review is project-wide: the old Functional (architecture) Review address opens the same Review tab.
    await page.goto(`${base}/architecture/review?round=`);
    await expect(page).toHaveURL(/\/requirements\/review(\?round=)?$/);
    await expect(packagesRegion(page).getByRole('list', { name: 'Review packages' }).getByRole('listitem')).toHaveCount(3);
    await expect(page.getByRole('navigation', { name: 'Requirements views' }).getByRole('link', { name: /^Review/ })).toHaveAttribute('aria-current', 'page');
    api.assertNoUnexpectedRequests();
  });

  test('an accepted upload shows progress, sends the raw zip, and opens the new draft', async ({ page }, testInfo) => {
    const { api, requirements } = await open(page, `${base}/review`, (scenario) => { scenario.uploadDelayMs = 800; });
    await expect(packagesRegion(page).getByRole('listitem')).toHaveCount(3);
    await page.getByLabel('Upload package').setInputFiles({ buffer: ZIP_BYTES, mimeType: 'application/zip', name: 'round-4.zip' });
    await expect(page.getByRole('progressbar')).toBeVisible();
    await expect(packagesRegion(page).getByText('round-4.zip')).toBeVisible();

    await expect(page).toHaveURL(/\/review\/packages\/package-uploaded-4$/);
    await expect(page.getByRole('heading', { name: 'Version 4 · Client booking, reschedule flow' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Version 4 uploaded as a draft.' })).toBeVisible();
    await expect(page.getByText('Uploaded by Synthetic Demo · uploaded in Odin', { exact: false })).toBeVisible();

    const upload = requirements.calls.find((call) => call.path === '/packages/upload');
    // Playwright's WebKit gives a route no body for a File sent by XMLHttpRequest, so the size
    // reads 0 there. The other projects check the bytes.
    expect(upload).toMatchObject({ contentType: 'application/zip', method: 'POST', search: '?track=experience', ...(testInfo.project.name === 'webkit' ? {} : { size: ZIP_BYTES.length }) });
    api.assertNoUnexpectedRequests();
  });

  test('a rejected upload lists every error with its file, JSON Pointer, and meaning, plus warnings', async ({ page }, testInfo) => {
    const { api, requirements } = await open(page, `${base}/review`, (scenario) => { scenario.uploadMode = 'reject'; });
    await page.getByLabel('Upload package').setInputFiles({ buffer: ZIP_BYTES, mimeType: 'application/zip', name: 'round-4.zip' });
    const rejection = page.getByTestId('rq-package-rejection');
    await expect(rejection).toBeVisible();
    await expect(rejection).toHaveAttribute('role', 'alert');
    await expect(rejection).toContainText('round-4.zip was not uploaded. Odin found 3 problems, and nothing was stored.');

    const problems = rejection.getByRole('list').first().getByRole('listitem');
    await expect(problems).toHaveCount(3);
    await expect(problems.nth(0)).toContainText('The manifest names a file that is not in the zip. Paths are case-sensitive.');
    await expect(problems.nth(0)).toContainText('screens/confirm.png is not in the package.');
    await expect(problems.nth(0)).toContainText('In manifest.json at /sections/3/items/1/src');
    await expect(problems.nth(0)).toContainText('code missing_file');
    await expect(problems.nth(1)).toContainText('A prototype file links to an outside web address.');
    await expect(problems.nth(1)).toContainText('In prototypes/booking/index.html');
    await expect(problems.nth(2)).toContainText('The zip is over a size, file-count, path-length, or compression limit.');
    await expect(problems.nth(2)).toContainText('The zip as a whole');

    await expect(rejection.getByText('Warnings · 1')).toBeVisible();
    await expect(rejection).toContainText('Odin does not use this top-level field, so it was ignored.');
    await expect(rejection).toContainText('In manifest.json at /theme');
    await expectNoSeriousIssues(page, testInfo, 'upload-rejected');

    expect(requirements.state.packages).toHaveLength(3);
    await expect(packagesRegion(page).getByRole('list', { name: 'Review packages' }).getByRole('listitem')).toHaveCount(3);
    api.assertNoUnexpectedRequests();
  });

  test('files that are not zips or are over 50 MB are refused before anything is sent', async ({ page }) => {
    const { api, requirements } = await open(page, `${base}/review`);
    await page.getByLabel('Upload package').setInputFiles({ buffer: Buffer.from('hello'), mimeType: 'text/plain', name: 'notes.txt' });
    await expect(page.getByRole('alert')).toContainText('notes.txt is not a zip.');

    const dir = mkdtempSync(path.join(tmpdir(), 'odin-u6b-'));
    const big = path.join(dir, 'huge-round.zip');
    try {
      writeFileSync(big, ZIP_BYTES);
      truncateSync(big, 51 * 1024 * 1024);
      await page.getByLabel('Upload package').setInputFiles(big);
      await expect(page.getByRole('alert')).toContainText('huge-round.zip is 51 MB. Packages can be up to 50 MB.');
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
    expect(requirements.calls.filter((call) => call.path === '/packages/upload')).toEqual([]);
    api.assertNoUnexpectedRequests();
  });

  test('an upload URL for a coding agent is shown once, with Copy and its expiry', async ({ context, page }, testInfo) => {
    if (testInfo.project.name.startsWith('chromium')) await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const { api, requirements } = await open(page, `${base}/review`);
    const opener = page.getByRole('button', { name: 'Upload URL for a coding agent' });
    await opener.click();
    let dialog = page.getByRole('dialog', { name: 'Upload URL for a coding agent' });
    await expect(dialog).toContainText('The URL works once and expires after 10 minutes.');
    await dialog.getByRole('button', { name: 'Create upload URL' }).click();

    dialog = page.getByRole('dialog', { name: 'Upload URL created' });
    const url = dialog.getByTestId('rq-upload-url');
    await expect(url).toHaveText(/^http:\/\/localhost:3001\/api\/public\/requirements-uploads\/odin_pkgup_synthetic-once-\d+$/);
    await expect(dialog).toContainText('This is the only time the URL is shown.');
    await expect(dialog).toContainText(/Expires .+, in about (9|10) min\./);
    await expect(dialog.getByRole('button', { name: 'Copy URL' })).toBeFocused();
    await expectNoSeriousIssues(page, testInfo, 'upload-url-dialog', 'dialog[open]');
    await dialog.getByRole('button', { name: 'Copy URL' }).click();
    await expect(dialog.getByRole('status')).toHaveText(/URL copied\.|Copying failed/);
    if (testInfo.project.name.startsWith('chromium')) {
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await url.textContent());
    }
    expect(requirements.calls.find((call) => call.path === '/packages/upload-urls').body).toEqual({ track: 'experience' });

    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    await opener.click();
    await expect(page.getByRole('dialog', { name: 'Upload URL for a coding agent' })).toBeVisible();
    await expect(page.getByTestId('rq-upload-url')).toHaveCount(0);
    await page.keyboard.press('Escape');
    api.assertNoUnexpectedRequests();
  });

  test('viewers see packages but no upload or withdraw controls', async ({ page }) => {
    const { api } = await open(page, `${base}/review`, (scenario) => { scenario.projectRole = 'viewer'; scenario.canDecide = false; });
    await expect(packagesRegion(page).getByRole('listitem')).toHaveCount(3);
    await expect(page.getByLabel('Upload package')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Upload URL for a coding agent' })).toHaveCount(0);
    await page.goto(`${base}/review/packages/package-3`);
    await expect(page.getByRole('heading', { name: /^Version 3/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Withdraw' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Replace' })).toHaveCount(0);
    api.assertNoUnexpectedRequests();
  });

  test('a packages event refreshes the list without reloading', async ({ page }) => {
    const { api, requirements } = await open(page, `${base}/review`, (scenario) => { scenario.liveEvents = true; });
    await expect(packagesRegion(page).getByRole('listitem')).toHaveCount(3);
    requirements.state.packages.push(packageDetail({
      createdAt: new Date().toISOString(), id: 'package-live', manifest: { ...structuredClone(FIELDWORK_MANIFEST), title: 'Uploaded through an agent while you watched' }, version: 4,
    }));
    requirements.pushEvent({ data: { packageIds: ['package-live'], reason: 'uploaded', track: 'experience' }, type: 'requirements.packages.invalidated' });
    await expect(packagesRegion(page).getByText('Uploaded through an agent while you watched')).toBeVisible();
    api.assertNoUnexpectedRequests();
  });
});

test.describe('Requirements package preview', () => {
  test('shows the header, checks, what changed since round 2, and every manifest section', async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    const { api, pageErrors } = await open(page, `${base}/review/packages/package-3`);
    await expect(page.getByRole('heading', { name: 'Version 3 · Client booking — price and booking flow' })).toBeVisible();
    await expect(page.getByText('Uploaded by Dana Cho · uploaded through MCP · 4.2 MB · 38 files')).toBeVisible();
    await expect(page.getByRole('region', { name: 'For reviewers' })).toContainText('price range');

    const checks = page.getByRole('region', { name: 'Checks' });
    await expect(checks.getByRole('listitem')).toHaveCount(5);
    await expect(checks).toContainText('3 screens (2 images, 1 prototype) · 2 directions · 1 flow');
    await expect(checks).toContainText('4 questions: 2 linked to topics, 2 will create new topics');
    await expect(checks.getByRole('listitem').last()).toContainText('Warning: Unknown field "theme" was ignored.');
    await expect(checks).toContainText('Reviewers rate: Type & size, Density & spacing, Hierarchy & navigation, Color, Branding, Behavior.');

    const changes = page.getByRole('region', { name: 'What changed since round 2' });
    await expect(changes.getByRole('listitem')).toHaveCount(4);
    await expect(changes.locator('.rq-chip')).toHaveText(['changed', 'new', 'removed', 'carried']);
    await expect(changes.getByRole('listitem').nth(0)).toContainText('Booking home');
    await expect(changes.getByRole('listitem').nth(0)).toContainText('Outdated');
    await expect(changes.getByRole('listitem').nth(2)).toContainText('Superseded');
    await expect(changes).toContainText('1 changed · 1 new · 1 removed · 1 carried, compared with version 2.');

    await expect(page.getByRole('region', { name: 'What we heard in round 1' })).toContainText('Finance needs the price visible before clients commit.');
    const reference = page.getByRole('region', { name: /References/ }).getByRole('link');
    await expect(reference).toHaveAttribute('target', '_blank');
    await expect(reference).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(reference).toHaveAttribute('href', /^https:\/\//);
    await expect(page.getByRole('region', { name: /References/ })).toContainText('Opened by the author');

    const directions = page.getByRole('region', { name: /^Directions/ });
    await expect(directions.getByRole('article')).toHaveCount(2);
    await expect(directions.getByRole('heading', { name: 'Action first' })).toBeVisible();

    const screens = page.getByRole('region', { name: /^Screens/ });
    await expect(screens.getByRole('list', { name: 'Screens in this package' }).getByRole('button')).toHaveCount(3);
    const image = screens.getByRole('img', { name: /Fieldwork home screen with a Book a visit button/ });
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute('src', `${REVIEW_ORIGIN}/p/package-3/grant-synthetic/screens/booking-home.png`);
    await expect.poll(() => image.evaluate((element) => element.naturalWidth)).toBe(1280);
    await expect(screens.getByRole('group', { name: 'Booking home, zoomable screen image' })).toBeVisible();
    // Zoom reads the real scale. It opens at Fit, and 100% draws the image pixel for pixel.
    const zoomValue = screens.locator('.annotation-canvas__zoom-value');
    const drawnWidth = () => image.evaluate((element) => element.getBoundingClientRect().width);
    await expect(screens.getByRole('button', { name: 'Fit' })).toBeDisabled();
    const fitPercent = Number.parseInt(await zoomValue.textContent(), 10);
    expect(Math.abs((await drawnWidth()) / 1280 * 100 - fitPercent)).toBeLessThan(1);
    await screens.getByRole('button', { name: 'Zoom to 100%, pixel for pixel' }).click();
    await expect(zoomValue).toHaveText('100%');
    await expect.poll(async () => Math.round(await drawnWidth())).toBe(1280);
    await screens.getByRole('button', { name: 'Zoom in' }).click();
    await expect(zoomValue).toHaveText('110%');
    await screens.getByRole('button', { name: 'Fit' }).click();
    await expect(zoomValue).toHaveText(`${fitPercent}%`);

    const flows = page.getByRole('region', { name: /^Flows/ });
    // Diagrams draw when they scroll near the viewport.
    await flows.scrollIntoViewIfNeeded();
    await expect(flows.locator('.rq-flow__svg svg')).toBeVisible({ timeout: 20_000 });
    await expect(flows.getByRole('img', { name: /Book a visit, diagram/ })).toBeVisible();
    await flows.getByText('Mermaid source').click();
    await expect(flows.locator('pre')).toContainText('flowchart TD');

    const questions = page.getByRole('region', { name: /^Questions/ });
    await expect(questions.getByRole('listitem').filter({ has: page.locator('.rq-chip') })).toHaveCount(4);
    await expect(questions).toContainText('Choose one');
    await expect(questions).toContainText('Written answer');
    await expect(questions).toContainText('Scale 1 to 5');
    await expect(questions).toContainText('A range on the home screen, exact before payment');
    await expect(questions).toContainText('1 = Slow, 5 = Very quick');
    await expect(questions.getByRole('link', { name: 'its linked topic' }).first()).toHaveAttribute('href', /\/requirements\/topics\/topic-exp-01$/);
    await expect(page.getByRole('region', { name: /does not cover|What this round/ })).toBeVisible();

    await expectNoSeriousIssues(page, testInfo, 'package-detail');
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    // Buttons animate their colors; let the switch to dark finish before measuring.
    await page.waitForTimeout(500);
    await expectNoSeriousIssues(page, testInfo, 'package-detail-dark');
    expect(pageErrors).toEqual([]);
    api.assertNoUnexpectedRequests();
  });

  test('a prototype runs in the sandboxed frame and answers state, goto-state, snapshot, and hint', async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const { api } = await open(page, `${base}/review/packages/package-3?screen=booking-flow`);
    const screens = page.getByRole('region', { name: /^Screens/ });
    const frameElement = screens.locator('iframe');
    await expect(frameElement).toHaveAttribute('sandbox', 'allow-scripts allow-forms');
    await expect(frameElement).toHaveAttribute('src', /^http:\/\/review\.odin\.test\/p\/package-3\/grant-synthetic\/prototypes\/booking\/index\.html\?odin-parent=http%3A%2F%2F127\.0\.0\.1%3A\d+$/);
    await expect(frameElement).toHaveAttribute('title', 'Booking flow, prototype');

    const status = screens.getByTestId('rq-proto-status');
    await expect(status).toHaveText('Showing Choose service', { timeout: 20_000 });
    const states = screens.getByRole('group', { name: 'States' });
    await expect(states.getByRole('button', { name: 'Choose service' })).toHaveAttribute('aria-pressed', 'true');

    await states.getByRole('button', { name: 'Pick a time' }).click();
    await expect(status).toHaveText('Showing Pick a time');
    await expect(states.getByRole('button', { name: 'Pick a time' })).toHaveAttribute('aria-pressed', 'true');
    const frame = page.frameLocator('.rq-proto__frame');
    await expect(frame.locator('section[data-state="pick-time"]')).toBeVisible();

    // A message posted by the app window itself is not from the frame and changes nothing.
    await page.evaluate(() => window.postMessage({ declared: true, hash: '#confirm', key: 'confirm', path: 'x', source: 'odin-review-bridge', type: 'state', version: 1 }, '*'));
    await page.waitForTimeout(300);
    await expect(status).toHaveText('Showing Pick a time');

    await screens.getByRole('button', { name: 'Check snapshot' }).click();
    await expect(screens.getByTestId('rq-snapshot-status')).toHaveText('Snapshot taken, 1280 × 800.', { timeout: 40_000 });
    const shot = screens.getByRole('img', { name: 'Snapshot of Booking flow' });
    await expect(shot).toBeVisible();
    await expect.poll(() => shot.evaluate((element) => element.naturalWidth)).toBe(1280);

    // Click the snapshot where the Continue link is in the live frame.
    const frameBox = await frameElement.boundingBox();
    const target = await frame.locator('[data-odin-id="continue"]').boundingBox();
    const shotBox = await shot.boundingBox();
    const relativeX = (target.x + target.width / 2 - frameBox.x) / frameBox.width;
    const relativeY = (target.y + target.height / 2 - frameBox.y) / frameBox.height;
    await shot.click({ position: { x: relativeX * shotBox.width, y: relativeY * shotBox.height } });
    const hint = screens.getByTestId('rq-hint-result');
    await expect(hint).toContainText('data-odin-id continue');
    await expect(hint).toContainText('“Continue to confirm →”');
    await expect(hint.locator('code').first()).toHaveText('a');

    await expectNoSeriousIssues(page, testInfo, 'package-prototype');
    api.assertNoUnexpectedRequests();
  });

  test('withdrawing a draft asks first, then shows it as withdrawn', async ({ page }) => {
    const { api, requirements } = await open(page, `${base}/review/packages/package-3`);
    const opener = page.getByRole('button', { name: 'Withdraw' });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Withdraw version 3?' });
    await expect(dialog).toContainText('Withdrawing deletes this draft’s files.');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(opener).toBeFocused();
    expect(requirements.calls.filter((call) => call.method === 'DELETE')).toEqual([]);

    await opener.click();
    await page.getByRole('dialog', { name: 'Withdraw version 3?' }).getByRole('button', { name: 'Withdraw package' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Version 3 withdrawn.' })).toBeVisible();
    await expect(page.getByRole('note').filter({ hasText: 'Withdrawn' })).toContainText('Its files were deleted');
    await expect(page.locator('.rq-topic-head .rq-chip').nth(0)).toHaveText('Withdrawn');
    await expect(page.getByRole('button', { name: 'Withdraw' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: /^Screens/ })).toContainText('This package was withdrawn, so its files were deleted.');
    await expect(page.locator('#rq-package-title')).toBeFocused();
    api.assertNoUnexpectedRequests();
  });

  test('a 409 on withdraw explains why and reloads the package', async ({ page }) => {
    const { api, requirements } = await open(page, `${base}/review/packages/package-3`, (scenario) => { scenario.withdrawConflict = true; });
    await page.getByRole('button', { name: 'Withdraw' }).click();
    const dialog = page.getByRole('dialog', { name: 'Withdraw version 3?' });
    await dialog.getByRole('button', { name: 'Withdraw package' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('A round uses this package, so it cannot be withdrawn.');
    await expect(dialog.getByRole('button', { name: 'Withdraw package' })).toHaveCount(0);
    await dialog.locator('.rq-dialog__foot').getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => requirements.calls.filter((call) => call.method === 'GET' && call.path === '/packages/package-3').length).toBeGreaterThan(1);
    await expect(page.locator('.rq-topic-head .rq-chip').nth(0)).toHaveText('Draft');
    api.assertNoUnexpectedRequests();
  });

  test('replacing a draft uploads the zip as the next version, withdraws the draft, and opens the new version', async ({ page }, testInfo) => {
    const { api, requirements } = await open(page, `${base}/review/packages/package-3`);
    const opener = page.getByRole('button', { name: 'Replace' });
    // From the keyboard: WebKit does not focus a clicked button, so there would be no opener to return to.
    await opener.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Replace version 3' });
    await expect(dialog).toContainText('If it passes, it becomes the next Experience draft and version 3 is withdrawn. If not, version 3 stays as it is.');
    await expectNoSeriousIssues(page, testInfo, 'replace-dialog', 'dialog[open]');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();

    await opener.click();
    await page.getByRole('dialog', { name: 'Replace version 3' }).getByLabel('Upload replacement').setInputFiles({ buffer: ZIP_BYTES, mimeType: 'application/zip', name: 'corrected.zip' });
    await expect(page).toHaveURL(/\/review\/packages\/package-replacement-4$/);
    await expect(page.getByRole('status').filter({ hasText: 'Version 4 replaced version 3.' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Version 4 · Client booking, corrected price copy' })).toBeVisible();
    await expect(page.locator('.rq-topic-head .rq-chip').nth(0)).toHaveText('Draft');
    expect(requirements.calls.filter((call) => call.method === 'POST' && call.path === '/packages/package-3/replace')).toHaveLength(1);
    expect(requirements.state.packages.find((entry) => entry.id === 'package-3').status).toBe('withdrawn');
    // The new draft can be replaced in turn, and its dialog is not left busy.
    await page.getByRole('button', { name: 'Replace' }).click();
    await expect(page.getByRole('dialog', { name: 'Replace version 4' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Replace version 4' })).toBeHidden();

    await page.getByRole('link', { name: 'Review', exact: true }).click();
    const rows = packagesRegion(page).getByRole('list', { name: 'Review packages' }).getByRole('listitem');
    await expect(rows).toHaveCount(4);
    await expect(rows.filter({ hasText: 'Client booking — price and booking flow' })).toContainText('Withdrawn');
    api.assertNoUnexpectedRequests();
  });

  test('a rejected replacement lists the problems in the dialog and keeps the draft', async ({ page }) => {
    const { api, requirements } = await open(page, `${base}/review/packages/package-3`, (scenario) => { scenario.uploadMode = 'reject'; });
    await page.getByRole('button', { name: 'Replace' }).click();
    const dialog = page.getByRole('dialog', { name: 'Replace version 3' });
    await dialog.getByLabel('Upload replacement').setInputFiles({ buffer: ZIP_BYTES, mimeType: 'application/zip', name: 'broken.zip' });
    await expect(dialog.getByTestId('rq-package-rejection')).toContainText('The manifest names a file that is not in the zip.');
    await dialog.locator('.rq-dialog__foot').getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.rq-topic-head .rq-chip').nth(0)).toHaveText('Draft');
    expect(requirements.state.packages.find((entry) => entry.id === 'package-3').status).toBe('draft');
    expect(requirements.state.packages).toHaveLength(3);
    api.assertNoUnexpectedRequests();
  });

  test('a 409 on replace says the draft changed, stores nothing, and reloads the package', async ({ page }) => {
    const { api, requirements } = await open(page, `${base}/review/packages/package-3`, (scenario) => { scenario.replaceConflict = true; });
    await page.getByRole('button', { name: 'Replace' }).click();
    const dialog = page.getByRole('dialog', { name: 'Replace version 3' });
    await dialog.getByLabel('Upload replacement').setInputFiles({ buffer: ZIP_BYTES, mimeType: 'application/zip', name: 'late.zip' });
    await expect(dialog.getByRole('alert')).toHaveText('Version 3 is no longer a draft: it was published, withdrawn, or replaced. Nothing was stored.');
    await expect(page.locator('.rq-topic-head .rq-chip').nth(0)).toHaveText('Published');
    await dialog.locator('.rq-dialog__foot').getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Replace' })).toHaveCount(0);
    await expect(page.locator('#rq-package-title')).toBeFocused();
    expect(requirements.state.packages).toHaveLength(3);
    api.assertNoUnexpectedRequests();
  });

  test('cancelling a replacement does not claim nothing was stored, and reloads the draft to show what happened', async ({ page }) => {
    const { api, requirements } = await open(page, `${base}/review/packages/package-3`, (scenario) => { scenario.uploadDelayMs = 3000; });
    await page.getByRole('button', { name: 'Replace' }).click();
    const dialog = page.getByRole('dialog', { name: 'Replace version 3' });
    await dialog.getByLabel('Upload replacement').setInputFiles({ buffer: ZIP_BYTES, mimeType: 'application/zip', name: 'corrected.zip' });
    // The synthetic server stores the replacement, then answers slowly.
    await expect.poll(() => requirements.state.packages.find((entry) => entry.id === 'package-3').status).toBe('withdrawn');
    await dialog.getByRole('button', { name: 'Cancel upload' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Upload cancelled. If Odin had already received the zip, it may still have replaced version 3. The package below shows its current state.');
    await expect(page.locator('.rq-topic-head .rq-chip').nth(0)).toHaveText('Withdrawn');
    await dialog.locator('.rq-dialog__foot').getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('#rq-package-title')).toBeFocused();
    api.assertNoUnexpectedRequests();
  });

  test('going Back during a replacement closes its dialog and leaves the previous package’s Replace usable', async ({ page }) => {
    const { api, requirements } = await open(page, `${base}/review/packages/package-3`);
    await page.getByRole('button', { name: 'Replace' }).click();
    await page.getByRole('dialog', { name: 'Replace version 3' }).getByLabel('Upload replacement').setInputFiles({ buffer: ZIP_BYTES, mimeType: 'application/zip', name: 'corrected.zip' });
    await expect(page).toHaveURL(/\/packages\/package-replacement-4$/);

    // Synthetic setup: version 3 is a draft again, so its page offers Replace after Back.
    requirements.state.packages.find((entry) => entry.id === 'package-3').status = 'draft';
    requirements.state.uploadDelayMs = 5000;
    await page.getByRole('button', { name: 'Replace' }).click();
    const dialog = page.getByRole('dialog', { name: 'Replace version 4' });
    await dialog.getByLabel('Upload replacement').setInputFiles({ buffer: ZIP_BYTES, mimeType: 'application/zip', name: 'second.zip' });
    await expect(dialog.getByRole('button', { name: 'Cancel upload' })).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(/\/packages\/package-3$/);
    await expect(page.getByRole('heading', { name: /^Version 3/ })).toBeVisible();
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Replace' }).click();
    const next = page.getByRole('dialog', { name: 'Replace version 3' });
    await expect(next.getByLabel('Upload replacement')).toBeVisible();
    await expect(next.locator('.rq-dialog__foot').getByRole('button', { name: 'Cancel' })).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(next).toBeHidden();
    api.assertNoUnexpectedRequests();
  });

  test('without a review origin, screens explain why and the rest of the package still shows', async ({ page }) => {
    const { api, requirements } = await open(page, `${base}/review/packages/package-3`, (scenario) => { scenario.grantMode = 'not-configured'; });
    const screens = page.getByRole('region', { name: /^Screens/ });
    await expect(screens.getByText('Image unavailable')).toBeVisible();
    await expect(screens).toContainText('the review site isn’t set up on this server');
    await expect(page.getByRole('region', { name: 'What changed since round 2' })).toBeVisible();
    await expect(page.getByRole('region', { name: /^Questions/ })).toBeVisible();
    await screens.getByRole('button', { name: /Booking flow/ }).click();
    await expect(screens.getByText('Prototype unavailable')).toBeVisible();
    expect(requirements.reviewOrigin.requests).toEqual([]);
    api.assertNoUnexpectedRequests();
  });

  test('choosing a screen from the changes list opens it in the viewer', async ({ page }) => {
    const { api } = await open(page, `${base}/review/packages/package-3`);
    await page.getByRole('region', { name: 'What changed since round 2' }).getByRole('button', { name: 'Booking home, schedule first' }).click();
    await expect(page).toHaveURL(/\?screen=booking-home-schedule$/);
    const heading = page.getByRole('heading', { name: 'Booking home, schedule first', level: 4 });
    await expect(heading).toBeFocused();
    await expect(page.getByRole('region', { name: /^Screens/ }).getByRole('button', { name: /Booking home, schedule first/ })).toHaveAttribute('aria-pressed', 'true');
    api.assertNoUnexpectedRequests();
  });

  test('flow labels and package markdown cannot run script', async ({ page }) => {
    const { api, pageErrors } = await open(page, `${base}/review/packages/package-3`, (scenario) => {
      const pkg = scenario.packages.find((entry) => entry.id === 'package-3');
      pkg.manifest.summary = `Hello <img src=x onerror="window.__pwned = 'summary'"> [click](javascript:window.__pwned=1) ![pic](https://example.com/x.png)`;
      pkg.manifest.sections.find((section) => section.type === 'flows').items.push({
        id: 'hostile',
        mermaid: [
          'flowchart TD',
          `  a["<img src=x onerror=window.__pwned='flow'>"] --> b["<script>window.__pwned='script'</script>"]`,
          `  click a "javascript:window.__pwned='click'"`,
        ].join('\n'),
        title: 'Hostile labels',
      });
    });
    const summary = page.getByRole('region', { name: 'For reviewers' });
    await expect(summary).toContainText('<img src=x onerror=');
    await expect(summary.locator('img, a[href^="javascript"]')).toHaveCount(0);
    const flows = page.getByRole('region', { name: /^Flows/ });
    await flows.scrollIntoViewIfNeeded();
    await expect(flows.locator('.rq-flow__svg svg')).toHaveCount(2, { timeout: 20_000 });
    await flows.locator('.rq-flow').nth(1).locator('svg').click({ force: true });
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
    expect(await flows.locator('[onerror], [onclick], script, a[href^="javascript"]').count()).toBe(0);
    expect(pageErrors).toEqual([]);
    api.assertNoUnexpectedRequests();
  });

  test('an unknown package says so and links back to Review', async ({ page }) => {
    const { api } = await open(page, `${base}/review/packages/package-missing`);
    await expect(page.getByRole('heading', { name: 'This package doesn’t exist' })).toBeVisible();
    await page.getByRole('link', { name: 'Back to Review' }).click();
    await expect(page).toHaveURL(/\/requirements\/review$/);
    api.assertNoUnexpectedRequests();
  });
});
