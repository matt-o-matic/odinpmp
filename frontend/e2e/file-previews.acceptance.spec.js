import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { settleForAxe } from './fixtures/axe-settle.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

// The files panel's viewer (docs/engagements/plan.md, Download and preview; AC-08): images, PDFs,
// Markdown through the sanitized renderer, and Office files as their converted PDF, preparing, or
// with no preview and a download. The routes are stand-ins; backend/test/file-previews.test.js
// runs the real ones.

const API_ORIGIN = 'http://localhost:3001';
const PROJECT = syntheticProject.id;
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];
const AT = '2026-11-14T10:00:00.000Z';
const uploader = { id: 'user-synthetic', name: 'Synthetic Demo' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/MediaBox[0 0 200 200]/Parent 2 0 R>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
const MARKDOWN = '# Kickoff notes\n\n- Scope agreed\n\n<script>window.__previewXss = true</script>\n\n[Unsafe](javascript:window.__previewXss=true) and [Spec](https://example.com/spec)\n';

const file = (overrides) => ({
  audience: 'internal', contentType: 'application/pdf', createdAt: AT, description: '', fileName: 'file.pdf', fileSize: 2048, id: 'file-1', links: [], projectId: PROJECT, scanStatus: 'clean', signature: 'sig',
  targetId: PROJECT, targetName: null, targetType: 'project', updatedAt: AT, uploadedBy: uploader, version: 1, versionNote: '', versionUploadedAt: AT, ...overrides,
});

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const FILES = [
  file({ contentType: 'image/png', fileName: 'Site photo.png', id: 'file-photo' }),
  file({ fileName: 'Spec.pdf', id: 'file-spec' }),
  file({ contentType: 'text/markdown', fileName: 'Notes.md', id: 'file-notes' }),
  file({ contentType: DOCX, fileName: 'Plan.docx', id: 'file-plan' }),
  file({ contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileName: 'Budget.xlsx', id: 'file-budget' }),
  file({ contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', fileName: 'Kickoff.pptx', id: 'file-deck' }),
  file({ contentType: 'text/html', fileName: 'Page.html', id: 'file-page' }),
];

async function installPreviewApi(page) {
  const writes = [];
  const state = { deckReady: false };
  const previews = {
    'file-budget': { kind: 'none', reason: 'failed' },
    'file-notes': { kind: 'markdown' },
    'file-photo': { kind: 'image' },
    'file-plan': { kind: 'pdf' },
    'file-spec': { kind: 'pdf' },
  };
  await page.route(/\/api\/projects\/[^/]+\/files(\?.*)?$/, (route) => route.fulfill({ json: { canWrite: true, files: FILES, ok: true } }));
  await page.route(/\/api\/projects\/[^/]+\/file-storage$/, (route) => route.fulfill({ json: { canDeleteVersions: false, maxUploadBytes: 1_073_741_824, ok: true, storage: { bytes: 4096, files: FILES.length, versions: FILES.length }, uploadsByParts: true } }));
  await page.route(/\/api\/projects\/[^/]+\/files\/[^/]+\/preview-url(\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    const id = url.pathname.split('/').at(-2);
    writes.push(['preview-url', id, url.searchParams.get('version')]);
    const preview = id === 'file-deck' ? (state.deckReady ? { kind: 'pdf' } : { kind: 'preparing' }) : previews[id];
    const signed = ['image', 'markdown', 'pdf', 'text', 'video'].includes(preview.kind);
    return route.fulfill({ json: { expiresAt: signed ? '2099-01-01T00:00:00.000Z' : null, fileName: FILES.find((entry) => entry.id === id).fileName, ok: true, reason: preview.reason ?? null, url: signed ? `/api/file-transfers/files/preview-${id}` : null, version: 1, ...preview } });
  });
  await page.route(/\/api\/file-transfers\/files\/preview-[^/]+$/, (route) => {
    const id = route.request().url().split('/preview-').at(-1);
    const [body, type] = id === 'file-photo' ? [PNG, 'image/png'] : id === 'file-notes' ? [MARKDOWN, 'text/plain; charset=utf-8'] : [PDF, 'application/pdf'];
    return route.fulfill({ body, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Disposition': 'inline', 'Content-Type': type }, status: 200 });
  });
  await page.route(/\/api\/projects\/[^/]+\/files\/[^/]+\/download-url(\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    const id = url.pathname.split('/').at(-2);
    writes.push(['download-url', id, url.searchParams.get('version')]);
    return route.fulfill({ json: { fileName: FILES.find((entry) => entry.id === id).fileName, ok: true, url: `/api/file-transfers/files/signed-${id}` } });
  });
  await page.route(/\/api\/file-transfers\/files\/signed-[^/]+$/, (route) => {
    const name = FILES.find((entry) => route.request().url().endsWith(`signed-${entry.id}`)).fileName;
    return route.fulfill({ body: 'contents', headers: { 'Content-Disposition': `attachment; filename="${name}"`, 'Content-Type': 'application/octet-stream' }, status: 200 });
  });
  return { state, writes };
}

// Holds the project's event stream until release(), then sends one change event.
async function holdProjectEvents(page) {
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  let delivered = false;
  const event = { actor: null, originClientId: null, projectId: PROJECT, reason: 'file preview', type: 'project.assets.invalidated' };
  await page.route(`${API_ORIGIN}/api/projects/${PROJECT}/events`, async (route) => {
    if (delivered) return route.fulfill({ body: '', contentType: 'text/event-stream', status: 200 });
    await released;
    try {
      await route.fulfill({ body: `event: connected\ndata: {}\n\nevent: project.assets.invalidated\ndata: ${JSON.stringify(event)}\n\n`, contentType: 'text/event-stream', status: 200 });
      delivered = true;
    } catch {
      // The screen closed while its stream was held.
    }
  });
  return () => release();
}

async function openVault(page) {
  await page.goto(`projects/${PROJECT}?projectSettings=files`);
  const panel = page.locator('.project-files');
  await expect(panel.getByRole('heading', { name: /^Files/ })).toBeVisible();
  return panel;
}

const rowFor = (panel, name) => panel.locator('.project-files__row').filter({ hasText: name });
const viewer = (page) => page.locator('dialog.file-preview-dialog[open]');

async function openPreview(page, panel, name) {
  await rowFor(panel, name).getByRole('button', { name: 'Open' }).click();
  const dialog = viewer(page);
  await expect(dialog.getByRole('heading', { name })).toBeVisible();
  return dialog;
}

async function expectFits(page, dialog) {
  const box = await dialog.boundingBox();
  const width = page.viewportSize().width;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

test.describe('file previews', () => {
  test('an image and a PDF show in the viewer from their signed URLs, and Download stays in reach', async ({ page }, testInfo) => {
    await installSyntheticApi(page);
    const api = await installPreviewApi(page);
    await authenticateSyntheticUser(page);
    const panel = await openVault(page);
    // HTML is never shown, so it has no Open.
    await expect(rowFor(panel, 'Page.html').getByRole('button', { name: 'Open' })).toHaveCount(0);

    const photo = await openPreview(page, panel, 'Site photo.png');
    const image = photo.getByRole('img', { name: 'Site photo.png' });
    await expect(image).toHaveAttribute('src', /\/api\/file-transfers\/files\/preview-file-photo$/);
    await expect.poll(() => image.evaluate((element) => element.complete && element.naturalWidth)).toBe(1);
    await expectFits(page, photo);
    await settleForAxe(page);
    expect((await new AxeBuilder({ page }).include('dialog.file-preview-dialog').withTags(WCAG).analyze()).violations).toEqual([]);
    await photo.getByRole('button', { name: 'Close' }).click();
    await expect(viewer(page)).toHaveCount(0);

    const spec = await openPreview(page, panel, 'Spec.pdf');
    await expect(spec.locator('object.file-preview__pdf')).toHaveAttribute('data', /\/api\/file-transfers\/files\/preview-file-spec$/);
    await expect(spec.locator('object.file-preview__pdf')).toHaveAttribute('type', 'application/pdf');
    await expect(spec.getByRole('link', { name: 'Open in new tab' })).toHaveAttribute('href', /preview-file-spec$/);
    await expectFits(page, spec);
    const fetched = page.waitForRequest(/\/api\/file-transfers\/files\/signed-file-spec$/);
    const download = testInfo.project.name === 'webkit' ? null : page.waitForEvent('download');
    await spec.getByRole('button', { name: 'Download' }).click();
    await fetched;
    if (download) expect((await download).suggestedFilename()).toBe('Spec.pdf');
    expect(api.writes).toContainEqual(['preview-url', 'file-spec', '1']);
    expect(api.writes).toContainEqual(['download-url', 'file-spec', '1']);
  });

  test('Markdown renders through the sanitized renderer: no script runs and no unsafe link is made', async ({ page }) => {
    await installSyntheticApi(page);
    await installPreviewApi(page);
    await authenticateSyntheticUser(page);
    const panel = await openVault(page);
    const notes = await openPreview(page, panel, 'Notes.md');
    const body = notes.locator('.file-preview__markdown');
    await expect(body.getByRole('heading', { name: 'Kickoff notes' })).toBeVisible();
    await expect(body.getByRole('listitem').filter({ hasText: 'Scope agreed' })).toBeVisible();
    await expect(body.getByRole('link', { name: 'Spec' })).toHaveAttribute('href', 'https://example.com/spec');
    await expect(body.getByRole('link', { name: 'Unsafe' })).toHaveCount(0);
    await expect(body.locator('script')).toHaveCount(0);
    expect(await page.evaluate(() => window.__previewXss)).toBeUndefined();
    await expectFits(page, notes);
  });

  test('an Office file shows its converted PDF; a failed one says No preview and still downloads', async ({ page }) => {
    await installSyntheticApi(page);
    const api = await installPreviewApi(page);
    await authenticateSyntheticUser(page);
    const panel = await openVault(page);

    const plan = await openPreview(page, panel, 'Plan.docx');
    await expect(plan.locator('object.file-preview__pdf')).toHaveAttribute('data', /preview-file-plan$/);
    await plan.getByRole('button', { name: 'Close' }).click();

    const budget = await openPreview(page, panel, 'Budget.xlsx');
    await expect(budget.getByRole('status').filter({ hasText: 'No preview' })).toContainText('This file could not be converted for a preview.');
    await expect(budget.locator('object, img, video')).toHaveCount(0);
    await expectFits(page, budget);
    await settleForAxe(page);
    expect((await new AxeBuilder({ page }).include('dialog.file-preview-dialog').withTags(WCAG).analyze()).violations).toEqual([]);
    const fetched = page.waitForRequest(/\/api\/file-transfers\/files\/signed-file-budget$/);
    await budget.getByRole('button', { name: 'Download' }).click();
    await fetched;
    expect(api.writes).toContainEqual(['download-url', 'file-budget', '1']);
  });

  test('an Office file being converted shows Preparing preview, then its PDF when the live event arrives', async ({ page }) => {
    await installSyntheticApi(page);
    const api = await installPreviewApi(page);
    const release = await holdProjectEvents(page);
    await authenticateSyntheticUser(page);
    const panel = await openVault(page);
    const deck = await openPreview(page, panel, 'Kickoff.pptx');
    await expect(deck.getByRole('status').filter({ hasText: 'Preparing preview' })).toBeVisible();
    await expect(deck.getByRole('button', { name: 'Download' })).toBeEnabled();

    api.state.deckReady = true;
    release();
    await expect(deck.locator('object.file-preview__pdf')).toHaveAttribute('data', /preview-file-deck$/);
    await expect(deck.getByText('Preparing preview')).toHaveCount(0);
    expect(api.writes.filter(([kind, id]) => kind === 'preview-url' && id === 'file-deck').length).toBeGreaterThanOrEqual(2);
  });
});
