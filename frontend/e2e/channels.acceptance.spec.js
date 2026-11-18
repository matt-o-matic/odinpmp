import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { settleForAxe } from './fixtures/axe-settle.js';
import { createChannelsWorld, holdProjectStream, installChannelsApi } from './fixtures/channels-api.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

// Channels on a project: channels, posts and replies with tags, a second person seeing a post
// live, unread counts, library folders and uploads, and file comments that show their
// version. The API is the stateful fixture in fixtures/channels-api.js; live events are
// delivered on the held stream.

const CHANNELS = `projects/${syntheticProject.id}/channels`;

async function expectNoSeriousAxe(page) {
  await settleForAxe(page);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).include('#main-content').analyze();
  expect(results.violations.filter(({ impact }) => ['critical', 'serious'].includes(impact)).map(({ id }) => id)).toEqual([]);
}

async function signedIn(page, world) {
  const api = await installSyntheticApi(page);
  await installChannelsApi(page, { world });
  await authenticateSyntheticUser(page);
  return api;
}

// The channel list is beside the channel on wide screens, and before it on a phone.
async function openChannel(page, name) {
  await page.getByRole('complementary', { name: 'Channel list' }).getByRole('button', { name: new RegExp(`^${name}`) }).click();
  await expect(page.getByRole('heading', { exact: true, level: 3, name })).toBeVisible();
}

async function composeWithTag(page, textbox, before, query, after) {
  await textbox.click();
  await page.keyboard.type(`${before} @${query}`);
  const list = page.getByRole('listbox', { name: 'People to tag' });
  await expect(list.getByRole('option')).toHaveText([/Pat Seller/]);
  await page.keyboard.press('Enter');
  await expect(textbox.locator('.mention')).toHaveText('@Pat Seller');
  await page.keyboard.type(after);
}

test('a member adds a channel, posts with a tag, and replies', async ({ page }) => {
  const world = createChannelsWorld();
  const api = await signedIn(page, world);
  await page.goto(CHANNELS);
  await expect(page.getByRole('link', { name: 'Channels' })).toHaveAttribute('aria-current', 'page');

  await page.getByRole('button', { name: 'New channel' }).click();
  const dialog = page.getByRole('dialog', { name: 'New channel' });
  await dialog.getByLabel('Name').fill('Launch plan');
  await dialog.getByRole('button', { name: 'Add channel' }).click();
  await expect(page.getByRole('heading', { exact: true, level: 3, name: 'Launch plan' })).toBeVisible();
  await expect(page.getByText('No messages yet.')).toBeVisible();

  const composer = page.getByRole('textbox', { name: 'Message Launch plan' });
  await composeWithTag(page, composer, 'Ready to go,', 'pa', ' please review the dates');
  await page.getByRole('button', { name: 'Send' }).click();
  const posted = page.locator('.channel-post').filter({ hasText: 'please review the dates' });
  await expect(posted).toHaveCount(1);
  await expect(posted.locator('.mention')).toHaveText('@Pat Seller');
  expect(world.calls.find((call) => call.method === 'POST' && call.path.endsWith('/posts')).body.body).toBe('Ready to go, @[Pat Seller](user:user-pat) please review the dates');

  await posted.getByRole('button', { name: 'Reply to Synthetic Demo' }).click();
  await expect(composer).toHaveCount(0);
  const reply = page.getByRole('textbox', { name: 'Reply to Synthetic Demo' });
  await reply.click();
  await page.keyboard.type('Timeline is in Files');
  await page.getByRole('button', { name: 'Post reply' }).click();
  await expect(page.locator('.channel-post--reply').filter({ hasText: 'Timeline is in Files' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message Launch plan' })).toBeVisible();
  expect(world.posts.at(-1).parentId).toBe(world.posts.at(-2).id);
  await expectNoSeriousAxe(page);
  api.assertNoUnexpectedRequests();
});

test('a post in one browser appears in a second one live, and once in the first', async ({ browser, page }, testInfo) => {
  // Two people sign in.
  test.setTimeout(60_000);
  const world = createChannelsWorld();
  await signedIn(page, world);
  const { baseURL, deviceScaleFactor, hasTouch, isMobile, userAgent, viewport } = testInfo.project.use;
  const other = await browser.newContext({ baseURL, deviceScaleFactor, hasTouch, isMobile, userAgent, viewport });
  const second = await other.newPage();
  try {
    await signedIn(second, world);
    const release = await holdProjectStream(second);
    await second.goto(`${CHANNELS}?channel=channel-general`);
    await expect(second.getByText('Kick-off notes are in the library.')).toBeVisible();

    await page.goto(`${CHANNELS}?channel=channel-general`);
    await page.getByRole('textbox', { name: 'Message General' }).click();
    await page.keyboard.type('Pricing approved by finance');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.channel-post').filter({ hasText: 'Pricing approved by finance' })).toHaveCount(1);

    // What the server publishes for that post, on the other person's stream.
    release([{ actor: { id: 'user-synthetic', name: 'Synthetic Demo' }, area: 'posts', channelId: 'channel-general', originClientId: 'tab-elsewhere', projectId: syntheticProject.id, type: 'channel.updated' }]);
    await expect(second.locator('.channel-post').filter({ hasText: 'Pricing approved by finance' })).toHaveCount(1, { timeout: 2000 });
    // The writer's own page shows it once, whatever its stream says.
    await expect(page.locator('.channel-post').filter({ hasText: 'Pricing approved by finance' })).toHaveCount(1);
  } finally {
    await other.close();
  }
});

test('an unread count shows on the channel list and clears when the channel opens', async ({ page }) => {
  const world = createChannelsWorld();
  await signedIn(page, world);
  await page.goto(CHANNELS);
  const list = page.getByRole('complementary', { name: 'Channel list' });
  const deal = list.getByRole('button', { name: /^Deal room/ });
  await expect(deal).toHaveAccessibleName(/^Deal room\s*,\s*2 unread$/);
  await expect(list.getByRole('button', { name: /^General/ })).toHaveAccessibleName(/^General$/);
  await openChannel(page, 'Deal room');
  await expect(page.getByText('Can we hold the rate?')).toBeVisible();
  await expect.poll(() => world.calls.some((call) => call.method === 'POST' && call.path === '/channels/channel-deal/read')).toBe(true);
  if (!(await list.isVisible())) await page.getByRole('button', { name: 'Channels', exact: true }).click();
  await expect(list.getByRole('button', { name: /^Deal room/ })).toHaveAccessibleName(/^Deal room$/);
});

test('a folder is added, opened, and a file uploads into it', async ({ page }) => {
  const world = createChannelsWorld();
  const api = await signedIn(page, world);
  await page.goto(`${CHANNELS}?channel=channel-general&tab=files`);
  await expect(page.getByRole('navigation', { name: 'Folder' })).toContainText('Library');

  await page.getByRole('button', { name: 'New folder' }).click();
  const dialog = page.getByRole('dialog', { name: 'New folder' });
  await dialog.getByLabel('Name').fill('Proposals');
  await dialog.getByRole('button', { name: 'Add folder' }).click();
  await page.getByRole('button', { name: /^Proposals/ }).click();
  await expect(page.getByRole('navigation', { name: 'Folder' }).locator('[aria-current="location"]')).toHaveText('Proposals');
  await expect(page).toHaveURL(/folder=folder-/);
  await expect(page.getByText('No files in this folder yet.')).toBeVisible();

  await page.getByRole('button', { name: 'Upload file' }).click();
  const upload = page.getByRole('dialog', { name: 'Upload a file' });
  await upload.getByLabel('File').setInputFiles({ buffer: Buffer.from('Statement of work'), mimeType: 'text/plain', name: 'sow.txt' });
  await upload.getByRole('button', { name: 'Upload file' }).click();
  await expect(page.locator('.project-files__name', { hasText: 'sow.txt' })).toBeVisible();
  expect(world.files[0].folderId).toBe(world.folders[0].id);
  await page.getByRole('navigation', { name: 'Folder' }).getByRole('button', { name: 'Library' }).click();
  await expect(page.locator('.project-files__name', { hasText: 'sow.txt' })).toHaveCount(0);
  await expectNoSeriousAxe(page);
  api.assertNoUnexpectedRequests();
});

test('a file comment shows the version it was made on, and the editing marker shows who and when', async ({ page }) => {
  const world = createChannelsWorld();
  world.files.push({ contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', createdAt: '2026-11-14T09:00:00.000Z', fileName: 'sow.docx', fileSize: 48_000, folderId: null, id: 'file-sow', targetId: 'channel-general', updatedAt: '2026-11-14T10:00:00.000Z', version: 2 });
  await signedIn(page, world);
  await page.goto(`${CHANNELS}?channel=channel-general&tab=files`);
  await page.getByRole('button', { name: 'Show versions and links for sow.docx' }).click();
  const comments = page.getByRole('region', { name: /^Comments/ });
  await expect(comments.getByText('No comments yet.')).toBeVisible();
  await comments.getByRole('textbox', { name: 'Comment on sow.docx' }).click();
  await page.keyboard.type('Clause 4 needs the new rate');
  await comments.getByRole('button', { name: 'Post comment' }).click();
  const comment = comments.locator('.channel-post').filter({ hasText: 'Clause 4 needs the new rate' });
  await expect(comment).toContainText('On version 2');

  await page.getByRole('button', { name: 'Mark as editing' }).click();
  await expect(page.locator('.project-files__tag--editing')).toContainText('You are editing');
  await page.getByRole('button', { name: 'Done editing' }).click();
  await expect(page.locator('.project-files__tag--editing')).toHaveCount(0);
});
