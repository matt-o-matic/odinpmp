import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { settleForAxe } from './fixtures/axe-settle.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

// Large files in the files panel (docs/engagements/plan.md, Files): uploads in parts with
// resume and conflicts, Scanning and Virus found states, signed downloads, deleting old
// versions, and storage used. The routes are stand-ins; backend/test/large-files.test.js runs
// the real ones.

const PROJECT = syntheticProject.id;
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];
const AT = '2026-11-14T10:00:00.000Z';
const uploader = { id: 'user-synthetic', name: 'Synthetic Demo' };
const PART = 8;

const file = (overrides) => ({
  audience: 'internal', contentType: 'application/pdf', createdAt: AT, description: '', fileName: 'file.pdf', fileSize: 2048, id: 'file-1', links: [], projectId: PROJECT, scanStatus: 'clean', signature: 'sig',
  targetId: PROJECT, targetName: null, targetType: 'project', updatedAt: AT, uploadedBy: uploader, version: 1, versionNote: '', versionUploadedAt: AT, ...overrides,
});

async function installLargeFilesApi(page, { conflictOnce = false, receivedParts = [] } = {}) {
  const files = [
    file({ fileName: 'Contract.pdf', id: 'file-contract', version: 3 }),
    file({ contentType: 'video/mp4', fileName: 'Demo.mp4', fileSize: 600 * 1024 * 1024, id: 'file-demo', scanStatus: 'pending' }),
    file({ contentType: 'application/zip', fileName: 'Bundle.zip', id: 'file-bundle', scanStatus: 'infected' }),
  ];
  const versions = {
    'file-contract': [
      { contentType: 'application/pdf', current: true, deletedAt: null, fileName: 'Contract.pdf', fileSize: 2048, note: '', scanStatus: 'clean', uploadedAt: AT, uploadedBy: uploader, version: 3 },
      { contentType: 'application/pdf', current: false, deletedAt: null, fileName: 'Contract.pdf', fileSize: 1024, note: '', scanStatus: 'clean', uploadedAt: AT, uploadedBy: uploader, version: 2 },
      { contentType: 'application/pdf', current: false, deletedAt: AT, fileName: 'Contract.pdf', fileSize: 512, note: '', scanStatus: 'clean', uploadedAt: AT, uploadedBy: uploader, version: 1 },
    ],
  };
  const writes = [];
  let storageBytes = 600 * 1024 * 1024 + 3072;
  let conflict = conflictOnce;
  let upload = null;

  await page.route(/\/api\/projects\/[^/]+\/files(\?.*)?$/, (route) => route.fulfill({ json: { canWrite: true, files, ok: true } }));
  await page.route(/\/api\/projects\/[^/]+\/file-storage$/, (route) => route.fulfill({ json: { canDeleteVersions: true, maxUploadBytes: 1_073_741_824, ok: true, storage: { bytes: storageBytes, files: files.length, versions: 5 }, uploadsByParts: true } }));
  await page.route(/\/api\/projects\/[^/]+\/files\/[^/]+\/versions$/, (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2);
    return route.fulfill({ json: { file: files.find((entry) => entry.id === id), ok: true, versions: versions[id] ?? [] } });
  });
  await page.route(/\/api\/projects\/[^/]+\/files\/[^/]+\/versions\/\d+$/, (route) => {
    const parts = new URL(route.request().url()).pathname.split('/');
    const version = versions[parts.at(-3)].find((entry) => entry.version === Number(parts.at(-1)));
    writes.push(['delete-version', parts.at(-3), version.version]);
    version.deletedAt = AT;
    storageBytes -= version.fileSize;
    return route.fulfill({ json: { deletedVersion: version.version, ok: true, storage: { bytes: storageBytes } } });
  });
  await page.route(/\/api\/projects\/[^/]+\/files\/[^/]+\/download-url(\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    const entry = files.find((candidate) => candidate.id === url.pathname.split('/').at(-2));
    writes.push(['download-url', entry.id, url.searchParams.get('version'), url.searchParams.get('disposition')]);
    return route.fulfill({ json: { fileName: entry.fileName, ok: true, url: `/api/file-transfers/files/signed-${entry.id}` } });
  });
  await page.route(/\/api\/file-transfers\/files\/[^/]+$/, (route) => route.fulfill({
    body: 'contents',
    headers: { 'Content-Disposition': 'attachment; filename="Contract.pdf"', 'Content-Type': 'application/pdf' },
    status: 200,
  }));
  await page.route(/\/api\/projects\/[^/]+\/uploads(\/.*)?$/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path.endsWith('/uploads')) {
      const body = request.postDataJSON();
      writes.push(['start', body.fileName, body.fileSize, body.fileId ?? null, body.expectedVersion ?? null]);
      upload = { expiresAt: '2099-01-01T00:00:00.000Z', id: 'upload-1', partCount: Math.ceil(body.fileSize / PART), partSize: PART, size: body.fileSize, status: 'uploading' };
      return route.fulfill({ json: { ok: true, upload: { ...upload, parts: [] } }, status: 201 });
    }
    if (request.method() === 'GET') {
      upload ??= { expiresAt: '2099-01-01T00:00:00.000Z', id: 'upload-1', partCount: 3, partSize: PART, size: 20, status: 'uploading' };
      return route.fulfill({ json: { ok: true, upload: { ...upload, parts: receivedParts } } });
    }
    if (path.endsWith('/parts')) {
      const { partNumbers } = request.postDataJSON();
      return route.fulfill({ json: { ok: true, parts: partNumbers.map((partNumber) => ({ method: 'PUT', partNumber, url: `/api/file-transfers/parts/part-${partNumber}` })) } });
    }
    if (path.endsWith('/complete')) {
      const body = request.postDataJSON();
      writes.push(['complete', body]);
      if (conflict) {
        conflict = false;
        return route.fulfill({ json: { details: { canKeepBoth: true, code: 'file_changed', currentVersion: 4, uploadId: 'upload-1' }, error: 'Someone uploaded a newer version.', ok: false }, status: 409 });
      }
      const saved = file({ fileName: body.keepBoth ? 'Contract (2).pdf' : 'Plan.pdf', id: `file-new-${files.length}`, scanStatus: 'pending' });
      files.unshift(saved);
      return route.fulfill({ json: { file: saved, ok: true }, status: 201 });
    }
    writes.push(['cancel']);
    return route.fulfill({ json: { cancelled: true, ok: true } });
  });
  await page.route(/\/api\/file-transfers\/parts\/[^/]+$/, (route) => {
    writes.push(['part', Number(route.request().url().split('-').at(-1))]);
    return route.fulfill({ json: { ok: true }, status: 200 });
  });
  return { writes };
}

async function openVault(page) {
  await page.goto(`projects/${PROJECT}?projectSettings=files`);
  const panel = page.locator('.project-files');
  await expect(panel.getByRole('heading', { name: /^Files/ })).toBeVisible();
  return panel;
}

const rowFor = (panel, name) => panel.locator('.project-files__row').filter({ hasText: name });
const pick = (dialog, name, contents = 'twenty bytes of file') => dialog.getByLabel('File', { exact: true }).setInputFiles({ buffer: Buffer.from(contents), mimeType: 'application/pdf', name });

test.describe('large files', () => {
  test('files being scanned or infected say so and cannot be downloaded; the vault shows storage used', async ({ page }) => {
    await installSyntheticApi(page);
    await installLargeFilesApi(page);
    await authenticateSyntheticUser(page);
    const panel = await openVault(page);
    await expect(panel.getByRole('heading', { name: /^Files/ })).toContainText('600.0 MB used');
    const demo = rowFor(panel, 'Demo.mp4');
    await expect(demo.getByText('Scanning')).toBeVisible();
    await expect(demo.getByRole('button', { name: 'Download' })).toBeDisabled();
    await expect(demo.getByRole('button', { name: 'Open' })).toHaveCount(0);
    const bundle = rowFor(panel, 'Bundle.zip');
    await expect(bundle.getByText('Virus found')).toBeVisible();
    await expect(bundle.getByRole('button', { name: 'Download' })).toBeDisabled();
    await settleForAxe(page);
    const results = await new AxeBuilder({ page }).include('.project-files').withTags(WCAG).analyze();
    expect(results.violations).toEqual([]);
  });

  test('a download goes through a signed link, and an old version is deleted after asking', async ({ page }, testInfo) => {
    await installSyntheticApi(page);
    const api = await installLargeFilesApi(page);
    await authenticateSyntheticUser(page);
    const panel = await openVault(page);
    const row = rowFor(panel, 'Contract.pdf');
    // Playwright's WebKit does not report a download for a routed attachment, so there the
    // request for the signed link is what is checked.
    const fetched = page.waitForRequest(/\/api\/file-transfers\/files\/signed-file-contract$/);
    const download = testInfo.project.name === 'webkit' ? null : page.waitForEvent('download');
    await row.getByRole('button', { name: 'Download' }).click();
    await fetched;
    if (download) expect((await download).suggestedFilename()).toBe('Contract.pdf');
    expect(api.writes).toContainEqual(['download-url', 'file-contract', '3', null]);

    await row.getByRole('button', { name: 'Show versions and links for Contract.pdf' }).click();
    await expect(row.locator('.project-files__version-row').filter({ hasText: 'Version 1' }).getByText('Deleted')).toBeVisible();
    await expect(row.getByRole('button', { name: 'Delete version 1' })).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Delete version 3' })).toHaveCount(0);
    await row.getByRole('button', { name: 'Delete version 2' }).click();
    const confirm = page.locator('dialog.rq-dialog[open]');
    await expect(confirm.getByRole('heading', { name: 'Delete version 2?' })).toBeVisible();
    await confirm.getByRole('button', { name: 'Delete version' }).click();
    await expect(panel.getByRole('status').filter({ hasText: 'Version 2 deleted.' })).toBeVisible();
    expect(api.writes).toContainEqual(['delete-version', 'file-contract', 2]);
  });

  test('an upload goes in parts and waits for its scan; a version conflict offers keep both', async ({ page }) => {
    await installSyntheticApi(page);
    const api = await installLargeFilesApi(page, { conflictOnce: true });
    await authenticateSyntheticUser(page);
    const panel = await openVault(page);
    const row = rowFor(panel, 'Contract.pdf');
    await row.getByRole('button', { name: 'Show versions and links for Contract.pdf' }).click();
    await row.getByRole('button', { name: 'New version' }).click();
    const dialog = page.locator('dialog.rq-dialog[open]');
    await expect(dialog.getByText('Up to 1.00 GB.')).toBeVisible();
    await pick(dialog, 'Contract.pdf');
    await dialog.getByRole('button', { name: 'Upload version' }).click();
    await expect(dialog.getByText('Someone saved version 4 while this uploaded.')).toBeVisible();
    expect(api.writes.filter(([kind]) => kind === 'part').map(([, number]) => number).sort()).toEqual([1, 2, 3]);
    expect(api.writes).toContainEqual(['start', 'Contract.pdf', 20, 'file-contract', 3]);
    await dialog.getByLabel('Keep both: save this as a new file next to it').check();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(panel.getByRole('status').filter({ hasText: 'Contract (2).pdf uploaded. It can be downloaded once the virus scan finishes.' })).toBeVisible();
    expect(api.writes.filter(([kind]) => kind === 'complete').at(-1)[1]).toMatchObject({ keepBoth: true });
    await expect(rowFor(panel, 'Contract (2).pdf').getByText('Scanning')).toBeVisible();
  });

  test('after a reload an unfinished upload resumes with the parts storage lacks, or is discarded', async ({ page }) => {
    await installSyntheticApi(page);
    const api = await installLargeFilesApi(page, { receivedParts: [{ partNumber: 1, size: PART }] });
    await authenticateSyntheticUser(page);
    await page.addInitScript(([projectId]) => {
      window.localStorage.setItem('odin.largeUploads.v1', JSON.stringify([{ expiresAt: '2099-01-01T00:00:00.000Z', fileId: null, fileName: 'Plan.pdf', lastModified: 0, projectId, size: 20, startedAt: '2026-11-14T09:00:00.000Z', targetId: projectId, targetType: 'project', uploadId: 'upload-1' }]));
    }, [PROJECT]);
    const panel = await openVault(page);
    await expect(panel.getByText('Plan.pdf stopped before it finished. Upload the same file again to continue.')).toBeVisible();
    await panel.getByRole('button', { name: 'Upload file' }).click();
    const dialog = page.locator('dialog.rq-dialog[open]');
    // The same file as before the reload, down to its modified time, which setInputFiles cannot set.
    await dialog.getByLabel('File', { exact: true }).evaluate((input) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['twenty bytes of file'], 'Plan.pdf', { lastModified: 0, type: 'application/pdf' }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(dialog.getByText('This continues the upload of Plan.pdf that stopped. Parts already sent are kept.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Upload file' }).click();
    await expect(panel.getByRole('status').filter({ hasText: 'Plan.pdf uploaded.' })).toBeVisible();
    expect(api.writes.filter(([kind]) => kind === 'part').map(([, number]) => number).sort()).toEqual([2, 3]);
    expect(api.writes.some(([kind]) => kind === 'start')).toBe(false);
    await expect(panel.getByText('stopped before it finished')).toHaveCount(0);
  });
});
