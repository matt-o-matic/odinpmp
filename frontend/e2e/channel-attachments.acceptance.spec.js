import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { settleForAxe } from './fixtures/axe-settle.js';
import { createChannelsWorld, installChannelsApi } from './fixtures/channels-api.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

// Files on a channel message: images show inline and open full screen in one press, other files
// open their preview, and each file's ⋯ menu has Open, Download and Show in files. A picked or
// pasted image shows as a thumbnail in the box before it is sent. The API is the channels fixture,
// which signs preview and download links and serves a 1-pixel PNG and a small PDF.

test.describe.configure({ timeout: 60_000 });

const CHANNELS = `projects/${syntheticProject.id}/channels`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const at = (minutes) => new Date(Date.UTC(2026, 10, 14, 10, minutes)).toISOString();
const channelFile = (id, fileName, contentType, extra = {}) => ({ contentType, createdAt: at(0), fileName, fileSize: 48_000, folderId: null, id, targetId: 'channel-general', updatedAt: at(0), version: 1, ...extra });

function attachmentsWorld() {
  const world = createChannelsWorld();
  world.files.push(
    channelFile('file-site', 'Site photo.png', 'image/png'),
    channelFile('file-plan', 'Floor plan.png', 'image/png'),
    channelFile('file-sow', 'SOW.pdf', 'application/pdf'),
    channelFile('file-board', 'Whiteboard.png', 'image/png'),
  );
  world.posts.push(
    { authorId: 'user-pat', body: 'Photos from the site visit, and the SOW.', createdAt: at(1), fileIds: ['file-site', 'file-plan', 'file-sow'], id: 'post-site', parentId: null, targetId: 'channel-general' },
    { authorId: 'user-pat', body: 'The whiteboard from today.', createdAt: at(2), fileIds: ['file-board'], id: 'post-board', parentId: null, targetId: 'channel-general' },
  );
  return world;
}

async function signedIn(page, world) {
  const api = await installSyntheticApi(page);
  await installChannelsApi(page, { world });
  await authenticateSyntheticUser(page);
  return api;
}

async function expectNoSeriousAxe(page) {
  await settleForAxe(page);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).include('#main-content').analyze();
  expect(results.violations.filter(({ impact }) => ['critical', 'serious'].includes(impact)).map(({ id }) => id)).toEqual([]);
}

const postWith = (page, text) => page.locator('.channel-post').filter({ hasText: text }).first();
const thumbnailLoaded = (locator) => locator.evaluate((image) => image.complete && image.naturalWidth > 0);

test('an attached image shows inline and opens full screen in one press; Escape closes it and focus goes back', async ({ page }, testInfo) => {
  const world = attachmentsWorld();
  const api = await signedIn(page, world);
  await page.goto(`${CHANNELS}?channel=channel-general`);

  const post = postWith(page, 'Photos from the site visit');
  const site = post.getByRole('button', { name: 'Open Site photo.png' });
  await expect(site.getByRole('img', { name: 'Site photo.png' })).toBeVisible();
  await expect.poll(() => thumbnailLoaded(site.getByRole('img'))).toBe(true);
  await expect(post.getByRole('button', { name: 'Open Floor plan.png' }).getByRole('img')).toBeVisible();
  // The PDF is a card beside the pictures.
  await expect(post.getByRole('list', { name: 'Attached files' }).getByRole('button', { name: 'Open SOW.pdf' })).toBeVisible();
  await expect(postWith(page, 'The whiteboard from today.').getByRole('img', { name: 'Whiteboard.png' })).toBeVisible();
  await post.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('attachments-inline.png') });
  await expectNoSeriousAxe(page);

  await site.click();
  const lightbox = page.getByRole('dialog', { name: 'Site photo.png' });
  await expect(lightbox).toBeVisible();
  await expect(lightbox.getByRole('img', { name: 'Site photo.png' })).toBeVisible();
  await expect(lightbox).toContainText('1 of 2');
  await expect(lightbox.getByRole('button', { name: 'Download Site photo.png' })).toBeVisible();
  await expect(lightbox.getByRole('button', { name: 'Show Site photo.png in files' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('attachments-lightbox.png') });

  // The arrow keys and the side buttons step through the post's pictures.
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('dialog', { name: 'Floor plan.png' })).toContainText('2 of 2');
  await page.getByRole('dialog', { name: 'Floor plan.png' }).getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('dialog', { name: 'Site photo.png' })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(site).toBeFocused();
  api.assertNoUnexpectedRequests();
});

test('a press on the dark backdrop closes the picture', async ({ page }) => {
  const world = attachmentsWorld();
  const api = await signedIn(page, world);
  await page.goto(`${CHANNELS}?channel=channel-general`);
  const board = postWith(page, 'The whiteboard from today.').getByRole('button', { name: 'Open Whiteboard.png' });
  await board.click();
  const lightbox = page.getByRole('dialog', { name: 'Whiteboard.png' });
  await expect(lightbox).toBeVisible();
  await expect(lightbox.getByRole('button', { name: 'Next' })).toHaveCount(0);
  const box = await lightbox.boundingBox();
  await page.mouse.click(box.x + 10, box.y + box.height - 10);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(board).toBeFocused();
  api.assertNoUnexpectedRequests();
});

test('each file\'s ⋯ menu opens, downloads, or shows it in the library, and a PDF opens its preview', async ({ page }, testInfo) => {
  const world = attachmentsWorld();
  const api = await signedIn(page, world);
  await page.goto(`${CHANNELS}?channel=channel-general`);
  const post = postWith(page, 'Photos from the site visit');

  // A PDF card opens the preview dialog, not the library.
  await post.getByRole('button', { name: 'Open SOW.pdf' }).click();
  const viewer = page.getByRole('dialog', { name: 'SOW.pdf' });
  await expect(viewer.locator('object[type="application/pdf"]')).toBeAttached();
  await viewer.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // The menu on a picture.
  await post.getByRole('button', { name: 'More actions for Floor plan.png' }).click();
  const menu = page.getByRole('menu').filter({ visible: true });
  await expect(menu.getByRole('menuitem')).toHaveText(['Open', 'Download', 'Show in files']);
  await menu.getByRole('menuitem', { name: 'Open' }).click();
  await expect(page.getByRole('dialog', { name: 'Floor plan.png' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(post.getByRole('button', { name: 'Open Floor plan.png' })).toBeFocused();

  // Download asks for a signed link and goes to it.
  await post.getByRole('button', { name: 'More actions for SOW.pdf' }).click();
  const fileMenu = page.getByRole('menu').filter({ visible: true });
  await expect(fileMenu.getByRole('menuitem')).toHaveText(['Preview', 'Download', 'Show in files']);
  const fetched = page.waitForRequest(/\/api\/file-transfers\/files\/channel-download-file-sow$/);
  // WebKit in Playwright does not report a download started by navigation.
  const download = testInfo.project.name === 'webkit' ? null : page.waitForEvent('download');
  await fileMenu.getByRole('menuitem', { name: 'Download' }).click();
  await fetched;
  if (download) expect((await download).suggestedFilename()).toBe('SOW.pdf');
  expect(world.calls.some((call) => call.path === '/files/file-sow/download-url')).toBe(true);

  // Show in files is the library, at the file.
  await post.getByRole('button', { name: 'More actions for SOW.pdf' }).click();
  await page.getByRole('menu').filter({ visible: true }).getByRole('menuitem', { name: 'Show in files' }).click();
  await expect(page).toHaveURL(/tab=files/);
  await expect(page).toHaveURL(/file=file-sow/);
  api.assertNoUnexpectedRequests();
});

test('an image still in its virus scan says so, then shows once the scan passes', async ({ page }) => {
  const world = attachmentsWorld();
  world.scanning = { 'file-board': 1 };
  const api = await signedIn(page, world);
  await page.goto(`${CHANNELS}?channel=channel-general`);
  const post = postWith(page, 'The whiteboard from today.');
  await expect(post.getByText('Checking the file…')).toBeVisible();
  await expect(post.getByRole('img', { name: 'Whiteboard.png' })).toBeVisible({ timeout: 10_000 });
  await expect(post.getByText('Checking the file…')).toHaveCount(0);
  api.assertNoUnexpectedRequests();
});

test('a picked or pasted image shows as a thumbnail in the box, and both are sent', async ({ page }, testInfo) => {
  const world = attachmentsWorld();
  const api = await signedIn(page, world);
  await page.goto(`${CHANNELS}?channel=channel-general`);
  const box = page.getByRole('textbox', { name: 'Message General' });
  await expect(box).toBeVisible();

  await page.locator('input[type="file"][multiple]').setInputFiles({ buffer: PNG, mimeType: 'image/png', name: 'Before.png' });
  const waiting = page.getByRole('list', { name: 'Files to attach' });
  await expect(waiting.getByRole('img', { name: 'Before.png' })).toBeVisible();

  // A screenshot pasted into the box.
  await box.click();
  await box.evaluate((element, bytes) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes)], 'Pasted.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, [...PNG]);
  await expect(waiting.getByRole('img', { name: 'Pasted.png' })).toBeVisible();
  await expect(box).toHaveText('');
  await page.screenshot({ path: testInfo.outputPath('attachments-composer.png') });

  // Text pasted with a picture of itself beside (as Word copies) stays text.
  await box.evaluate((element, bytes) => {
    const data = new DataTransfer();
    data.setData('text/plain', 'Quarterly numbers');
    data.items.add(new File([new Uint8Array(bytes)], 'image.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, [...PNG]);
  await expect(waiting.getByRole('listitem')).toHaveCount(2);

  await page.getByRole('button', { name: 'Remove Before.png' }).click();
  await expect(waiting.getByRole('listitem')).toHaveCount(1);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('list', { name: 'Files to attach' })).toHaveCount(0);
  const sent = world.calls.find((call) => call.method === 'POST' && call.path.endsWith('/posts'));
  expect(sent.body.fileIds).toHaveLength(1);
  const mine = page.locator('.channel-post').last();
  await expect(mine.getByRole('img', { name: 'Pasted.png' })).toBeVisible();
  api.assertNoUnexpectedRequests();
});

test('an image pasted into a reply waits in the reply box, is sent with the reply, and shows inline in the thread', async ({ page }, testInfo) => {
  const world = attachmentsWorld();
  const api = await signedIn(page, world);
  await page.goto(`${CHANNELS}?channel=channel-general`);

  const thread = postWith(page, 'The whiteboard from today.');
  await thread.getByRole('button', { name: /^Reply to / }).first().click();
  const box = page.getByRole('textbox', { name: /^Reply to / });
  await expect(box).toBeFocused();

  await box.evaluate((element, bytes) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes)], 'Reply shot.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, [...PNG]);
  const waiting = thread.getByRole('list', { name: 'Files to attach' });
  await expect(waiting.getByRole('img', { name: 'Reply shot.png' })).toBeVisible();
  // The box at the bottom stays out of it: the paste went to the reply.
  await expect(page.getByRole('textbox', { name: 'Message General' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('attachments-reply.png') });

  // An image alone is enough to send, past the tag the reply starts with.
  await thread.getByRole('button', { name: 'Post reply' }).click();
  await expect(thread.getByRole('list', { name: 'Files to attach' })).toHaveCount(0);
  const sent = world.calls.find((call) => call.method === 'POST' && call.path.endsWith('/posts'));
  expect(sent.body.parentId).toBe('post-board');
  expect(sent.body.fileIds).toHaveLength(1);
  await expect(thread.locator('.channel-post--reply').getByRole('img', { name: 'Reply shot.png' })).toBeVisible();
  api.assertNoUnexpectedRequests();
});
