import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { settleForAxe } from './fixtures/axe-settle.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

const PROJECT = syntheticProject.id;
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];
const AT = '2026-10-20T10:00:00.000Z';
const uploader = { id: 'user-synthetic', name: 'Synthetic Demo' };

const file = (overrides) => ({
  contentType: 'application/pdf', createdAt: AT, description: '', fileName: 'file.pdf', fileSize: 2048, id: 'file-1', links: [], projectId: PROJECT, signature: 'sig',
  targetId: PROJECT, targetName: null, targetType: 'project', updatedAt: AT, uploadedBy: uploader, version: 1, versionNote: '', versionUploadedAt: AT, ...overrides,
});

// A small stand-in for the file routes, keeping versions and links as Odin does.
async function installFilesApi(page, { canWrite = true } = {}) {
  const files = [
    file({ description: 'Signed statement of work', fileName: 'SOW.pdf', id: 'file-sow', version: 2, versionNote: 'Countersigned' }),
    file({ contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fileName: 'Rollout plan.docx', id: 'file-plan', targetId: 'story-synthetic', targetName: 'Release pilot', targetType: 'story' }),
  ];
  const history = { 'file-sow': [{ contentType: 'application/pdf', current: false, fileName: 'SOW draft.pdf', fileSize: 1024, note: '', uploadedAt: '2026-10-01T10:00:00.000Z', uploadedBy: uploader, version: 1 }] };
  const names = { 'epic-synthetic': 'Delivery', 'story-synthetic': 'Release pilot', 'task-synthetic': 'Validate rollout' };
  const writes = [];
  const versionsOf = (entry) => [
    { contentType: entry.contentType, current: true, fileName: entry.fileName, fileSize: entry.fileSize, note: entry.versionNote, uploadedAt: entry.versionUploadedAt, uploadedBy: uploader, version: entry.version },
    ...(history[entry.id] ?? []),
  ];
  const supersede = (entry, next) => {
    history[entry.id] = [{ ...versionsOf(entry)[0], current: false }, ...(history[entry.id] ?? [])];
    Object.assign(entry, next, { version: entry.version + 1, versionUploadedAt: '2026-11-04T10:00:00.000Z' });
  };

  // A server without uploads in parts: bytes go through the API and downloads come back as blobs,
  // and Open covers what a browser shows itself. Signed links, parts and Office previews are
  // covered by large-files.acceptance.spec.js and file-previews.acceptance.spec.js.
  await page.route(/\/api\/projects\/[^/]+\/file-storage$/, (route) => route.fulfill({ json: { canDeleteVersions: false, maxUploadBytes: 15 * 1024 * 1024, ok: true, storage: { bytes: 4096, files: files.length, versions: 3 }, uploadsByParts: false } }));
  await page.route(/\/api\/projects\/[^/]+\/files(\?.*)?$/, async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      const body = request.postDataJSON();
      writes.push(['upload', body.fileName, body.targetType, body.targetId]);
      const same = files.find((entry) => entry.fileName === body.fileName && entry.targetId === body.targetId);
      if (same) supersede(same, { versionNote: '' });
      else files.unshift(file({ contentType: body.fileType, description: body.fileDescription, fileName: body.fileName, id: `file-${files.length + 1}`, targetId: body.targetId, targetName: names[body.targetId] ?? null, targetType: body.targetType }));
      return route.fulfill({ json: { file: same ?? files[0], ok: true }, status: 201 });
    }
    const url = new URL(request.url());
    const targetId = url.searchParams.get('targetId');
    const listed = url.searchParams.get('targetType') === 'project' ? files : files.filter((entry) => entry.targetId === targetId || entry.links.some((link) => link.targetId === targetId));
    return route.fulfill({ json: { canWrite, files: listed, ok: true } });
  });
  await page.route(/\/api\/projects\/[^/]+\/files\/[^/]+\/versions$/, async (route) => {
    const entry = files.find((candidate) => candidate.id === new URL(route.request().url()).pathname.split('/').at(-2));
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      writes.push(['version', entry.id, body.expectedVersion, body.fileName, body.note]);
      supersede(entry, { fileName: body.fileName ?? entry.fileName, versionNote: body.note });
      return route.fulfill({ json: { file: entry, ok: true, unchanged: false }, status: 201 });
    }
    return route.fulfill({ json: { file: entry, ok: true, versions: versionsOf(entry) } });
  });
  await page.route(/\/api\/projects\/[^/]+\/files\/[^/]+\/versions\/\d+\/restore$/, async (route) => {
    const parts = new URL(route.request().url()).pathname.split('/');
    const entry = files.find((candidate) => candidate.id === parts.at(-4));
    const earlier = history[entry.id].find((version) => version.version === Number(parts.at(-2)));
    writes.push(['restore', entry.id, earlier.version, route.request().postDataJSON().expectedVersion]);
    supersede(entry, { fileName: earlier.fileName, versionNote: `Restored from version ${earlier.version}` });
    return route.fulfill({ json: { file: entry, ok: true, unchanged: false } });
  });
  await page.route(/\/api\/projects\/[^/]+\/files\/[^/]+\/links(\/[^/]+)?$/, async (route) => {
    const request = route.request();
    const parts = new URL(request.url()).pathname.split('/');
    if (request.method() === 'POST') {
      const entry = files.find((candidate) => candidate.id === parts.at(-2));
      const body = request.postDataJSON();
      writes.push(['link', entry.id, body.targetType, body.targetId]);
      entry.links.push({ id: `link-${entry.links.length + 1}`, linkedAt: AT, targetId: body.targetId, targetName: names[body.targetId] ?? body.targetId, targetType: body.targetType });
      return route.fulfill({ json: { file: entry, linked: true, ok: true }, status: 201 });
    }
    const entry = files.find((candidate) => candidate.id === parts.at(-3));
    writes.push(['unlink', entry.id, parts.at(-1)]);
    entry.links = entry.links.filter((link) => link.id !== parts.at(-1));
    return route.fulfill({ json: { file: entry, ok: true } });
  });
  await page.route(/\/api\/files\/[^/]+(\/content(\?.*)?)?$/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'DELETE') {
      const id = url.pathname.split('/').at(-1);
      writes.push(['delete', id]);
      files.splice(files.findIndex((entry) => entry.id === id), 1);
      return route.fulfill({ json: { deletedFileId: id, ok: true } });
    }
    writes.push(['content', url.pathname.split('/').at(-2), url.searchParams.get('version'), url.searchParams.get('download')]);
    return route.fulfill({ body: 'contents', contentType: 'application/pdf', status: 200 });
  });
  return { files, writes };
}

async function openVault(page) {
  await page.goto(`projects/${PROJECT}?projectSettings=files`);
  const panel = page.locator('.project-files');
  await expect(panel.getByRole('heading', { name: /^Files/ })).toBeVisible();
  return panel;
}

const rowFor = (panel, name) => panel.locator('.project-files__row').filter({ hasText: name });

async function pick(dialog, { contents = 'new contents', name, type = 'application/pdf' }) {
  await dialog.getByLabel('File', { exact: true }).setInputFiles({ buffer: Buffer.from(contents), mimeType: type, name });
}

test.describe('project files', () => {
  test('the vault downloads a file under its own name and lists where each file sits', async ({ page }) => {
    await installSyntheticApi(page);
    const api = await installFilesApi(page);
    await authenticateSyntheticUser(page);
    const panel = await openVault(page);

    const word = rowFor(panel, 'Rollout plan.docx');
    await expect(word.getByRole('link', { name: 'Release pilot' })).toBeVisible();
    await expect(word.getByRole('button', { name: 'Open' })).toHaveCount(0);

    const download = page.waitForEvent('download');
    await word.getByRole('button', { name: 'Download' }).click();
    expect((await download).suggestedFilename()).toBe('Rollout plan.docx');
    expect(api.writes).toContainEqual(['content', 'file-plan', '1', '1']);

    await panel.getByLabel('Search files').fill('statement');
    await expect(rowFor(panel, 'SOW.pdf')).toBeVisible();
    await expect(word).toHaveCount(0);
  });

  test('a new version keeps the old ones, which download and restore', async ({ page }) => {
    await installSyntheticApi(page);
    const api = await installFilesApi(page);
    await authenticateSyntheticUser(page);
    const panel = await openVault(page);

    const row = rowFor(panel, 'SOW.pdf');
    await row.getByRole('button', { name: 'Show versions and links for SOW.pdf' }).click();
    await expect(row.getByText('Countersigned')).toBeVisible();
    await expect(row.locator('.project-files__version-row')).toHaveCount(2);

    const earlier = page.waitForEvent('download');
    await row.getByRole('button', { name: 'Download version 1' }).click();
    expect((await earlier).suggestedFilename()).toBe('SOW draft.pdf');

    await row.getByRole('button', { name: 'New version' }).click();
    const dialog = page.locator('dialog.rq-dialog[open]');
    await expect(dialog.getByRole('heading', { name: 'New version of SOW.pdf' })).toBeVisible();
    await pick(dialog, { name: 'SOW final.pdf' });
    await dialog.getByLabel('What changed (optional)').fill('Final signatures');
    await dialog.getByRole('button', { name: 'Upload version' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(panel.getByRole('status').filter({ hasText: 'Version 3 uploaded.' })).toBeVisible();
    expect(api.writes).toContainEqual(['version', 'file-sow', 2, 'SOW final.pdf', 'Final signatures']);

    const renamed = rowFor(panel, 'SOW final.pdf');
    await expect(renamed.locator('.project-files__version').first()).toHaveText('v3');
    await expect(renamed.locator('.project-files__version-row')).toHaveCount(3);
    await renamed.locator('.project-files__version-row').filter({ hasText: 'Version 1' }).getByRole('button', { name: 'Restore' }).click();
    await expect(panel.getByRole('status').filter({ hasText: 'Version 1 restored as version 4.' })).toBeVisible();
    expect(api.writes).toContainEqual(['restore', 'file-sow', 1, 3]);
  });

  test('a refused restore says why', async ({ page }) => {
    await installSyntheticApi(page);
    await installFilesApi(page);
    await authenticateSyntheticUser(page);
    await page.route(/\/versions\/\d+\/restore$/, (route) => route.fulfill({ json: { error: 'A record-scoped legal hold blocks this change.', ok: false }, status: 423 }));
    const panel = await openVault(page);
    const row = rowFor(panel, 'SOW.pdf');
    await row.getByRole('button', { name: 'Show versions and links for SOW.pdf' }).click();
    await row.getByRole('button', { name: 'Restore' }).click();
    await expect(panel.getByRole('alert')).toContainText('legal hold');
  });

  test('uploading a name already there says it becomes a new version', async ({ page }) => {
    await installSyntheticApi(page);
    const api = await installFilesApi(page);
    await authenticateSyntheticUser(page);
    const panel = await openVault(page);
    await panel.getByRole('button', { name: 'Upload file' }).click();
    const dialog = page.locator('dialog.rq-dialog[open]');
    await pick(dialog, { name: 'SOW.pdf' });
    await expect(dialog.getByText('SOW.pdf is already here, so this becomes version 3. Earlier versions stay.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Upload file' }).click();
    await expect(panel.getByRole('status').filter({ hasText: 'SOW.pdf is now version 3.' })).toBeVisible();
    expect(api.writes).toContainEqual(['upload', 'SOW.pdf', 'project', PROJECT]);
  });

  test('a story shows its files, links one from the vault, and unlinks it without deleting it', async ({ page }, testInfo) => {
    await installSyntheticApi(page);
    const api = await installFilesApi(page);
    await authenticateSyntheticUser(page);
    await page.goto(`projects/${PROJECT}?item=story-synthetic`);
    const panel = page.locator('.project-files');
    await expect(rowFor(panel, 'Rollout plan.docx')).toBeVisible();
    await expect(rowFor(panel, 'SOW.pdf')).toHaveCount(0);

    await panel.getByRole('button', { name: 'Link from vault' }).click();
    const dialog = page.locator('dialog.rq-dialog[open]');
    await expect(dialog.getByRole('heading', { name: 'Link a file from the vault' })).toBeVisible();
    await expect(dialog.getByRole('radio')).toHaveCount(1);
    await dialog.getByRole('radio', { name: /SOW\.pdf/ }).check();
    await dialog.getByRole('button', { name: 'Link file' }).click();
    await expect(dialog).toHaveCount(0);
    expect(api.writes).toContainEqual(['link', 'file-sow', 'story', 'story-synthetic']);

    const linked = rowFor(panel, 'SOW.pdf');
    await expect(linked.getByText('Linked', { exact: true })).toBeVisible();
    await settleForAxe(page);
    const results = await new AxeBuilder({ page }).include('.project-files').withTags(WCAG).analyze();
    expect(results.violations).toEqual([]);
    await testInfo.attach('story-files', { body: await panel.screenshot(), contentType: 'image/png' });

    await linked.getByRole('button', { name: 'Show versions and links for SOW.pdf' }).click();
    await expect(linked.getByRole('button', { name: 'Delete file' })).toHaveCount(0);
    await linked.getByRole('button', { name: 'Unlink from this item' }).click();
    const confirm = page.locator('dialog.rq-dialog[open]');
    await expect(confirm).toContainText('The file stays in the vault.');
    await confirm.getByRole('button', { name: 'Unlink file' }).click();
    await expect(linked).toHaveCount(0);
    expect(api.writes).toContainEqual(['unlink', 'file-sow', 'link-1']);
    expect(api.files.some((entry) => entry.id === 'file-sow')).toBe(true);
  });

  test('the vault links a file to a work item, and deleting asks first', async ({ page }, testInfo) => {
    await installSyntheticApi(page);
    const api = await installFilesApi(page);
    await authenticateSyntheticUser(page);
    const panel = await openVault(page);
    const row = rowFor(panel, 'SOW.pdf');
    await row.getByRole('button', { name: 'Show versions and links for SOW.pdf' }).click();
    await row.getByRole('button', { name: 'Link to work item' }).click();

    const dialog = page.locator('dialog.rq-dialog[open]');
    await dialog.getByLabel('Find a work item').fill('rollout');
    await dialog.getByRole('radio', { name: /Validate rollout/ }).check();
    await dialog.getByRole('button', { name: 'Link file' }).click();
    await expect(row.getByRole('link', { name: 'Validate rollout' }).first()).toBeVisible();
    expect(api.writes).toContainEqual(['link', 'file-sow', 'task', 'task-synthetic']);
    await testInfo.attach('vault', { body: await panel.screenshot(), contentType: 'image/png' });

    await row.getByRole('button', { name: 'Delete file' }).click();
    const confirm = page.locator('dialog.rq-dialog[open]');
    await expect(confirm).toContainText('Delete SOW.pdf and all 2 versions, everywhere it is linked?');
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    expect(api.writes.some(([kind]) => kind === 'delete')).toBe(false);
    await row.getByRole('button', { name: 'Delete file' }).click();
    await page.locator('dialog.rq-dialog[open]').getByRole('button', { name: 'Delete file' }).click();
    await expect(row).toHaveCount(0);
  });

  test('a viewer downloads but changes nothing', async ({ page }) => {
    await installSyntheticApi(page);
    await installFilesApi(page, { canWrite: false });
    await authenticateSyntheticUser(page);
    const panel = await openVault(page);
    await expect(panel.getByRole('button', { name: 'Upload file' })).toHaveCount(0);
    const row = rowFor(panel, 'SOW.pdf');
    await expect(row.getByRole('button', { name: 'Download' })).toBeVisible();
    await row.getByRole('button', { name: 'Show versions and links for SOW.pdf' }).click();
    await expect(row.getByRole('button', { name: 'Download version 1' })).toBeVisible();
    await expect(row.getByRole('button', { name: /Restore|New version|Delete file/ })).toHaveCount(0);
  });

  test('a link from an agent opens the vault at the file', async ({ page }) => {
    await installSyntheticApi(page);
    await installFilesApi(page);
    await authenticateSyntheticUser(page);
    await page.goto(`projects/${PROJECT}?projectSettings=files&file=file-sow`);
    const row = page.locator('.project-files__row--focused');
    await expect(row).toContainText('SOW.pdf');
    await expect(row.getByRole('button', { name: 'Download version 1' })).toBeVisible();
  });
});
