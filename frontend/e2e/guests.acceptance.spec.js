import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { settleForAxe } from './fixtures/axe-settle.js';
import { createChannelsWorld, installChannelsApi } from './fixtures/channels-api.js';
import { GUEST, WORKSPACE_ID, createGuestWorld, installChannelGuestsApi, installGuestApi } from './fixtures/guests-api.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

// Channel guests in the browser: signing in with an emailed code, seeing only their channel with
// no Odin navigation, posting, uploading in parts and commenting on a file, on desktop, a phone
// and Safari. Members invite guests from the channel's Guests dialog. The API is the stateful
// fixture in fixtures/guests-api.js; guests.test.js in the backend proves the server's checks.

async function expectNoSeriousAxe(page, selector) {
  await settleForAxe(page);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).include(selector).analyze();
  expect(results.violations.filter(({ impact }) => ['critical', 'serious'].includes(impact)).map(({ id }) => id)).toEqual([]);
}

async function asGuest(page, world = createGuestWorld()) {
  const api = await installSyntheticApi(page);
  await installGuestApi(page, world);
  return { api, world };
}

test('a guest signs in with an emailed code and sees only their channel, with no Odin navigation', async ({ page }, testInfo) => {
  const { api, world } = await asGuest(page);
  // The invitation's link: the channel, which asks them to sign in first.
  await page.goto(`guest/channels/channel-deal?workspace=${WORKSPACE_ID}`);
  await expect(page).toHaveURL(/\/guest\/sign-in\?/);
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  await expect(page.getByText('Your session ended')).toHaveCount(0, { timeout: 1000 });
  await expect(page.getByRole('navigation', { name: /main/i })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('guest-sign-in.png') });

  await page.getByLabel('Email').fill(GUEST.email);
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await expect(page.getByText('If g***@northwind.example is invited, a code is on its way.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Send a new code in \d:\d\d/ })).toBeDisabled();
  expect(world.calls.find((call) => call.path === '/sign-in/code').body).toEqual({ email: GUEST.email, workspace: WORKSPACE_ID });

  await page.getByLabel('Code').fill('111111');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('That code is not right. 4 tries are left.');
  await page.getByLabel('Code').fill(GUEST.code);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Back to the channel they were invited to.
  await expect(page).toHaveURL(/\/guest\/channels\/channel-deal/);
  await expect(page.getByRole('heading', { level: 1, name: 'Deal room' })).toBeVisible();
  await expect(page.getByText('Welcome, Gina. The draft SOW goes here this week.')).toBeVisible();
  await expect(page.getByText('Margin notes')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Projects' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Channel settings' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('guest-channel.png') });

  // Guests are in Odin Chat's layout: their channels in the sidebar beside the channel,
  // with no direct messages, Mentions or Odin. On a phone the channel takes the sidebar's
  // place, with a link back to it.
  const sidebar = page.getByRole('navigation', { name: 'Conversations' });
  const back = page.getByRole('link', { name: 'Your channels' });
  if (await back.isVisible()) {
    await expect(sidebar).toBeHidden();
    await back.click();
  } else {
    await expect(sidebar.getByTestId('chat-sidebar-channel')).toHaveText([/Deal room/]);
    await page.locator('.guest-head__brand').click();
  }
  await expect(sidebar.getByRole('link', { name: 'Mentions' })).toHaveCount(0);
  await expect(sidebar.getByRole('button', { name: 'New message' })).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: 'Your channels' })).toBeVisible();
  await expect(sidebar.getByTestId('chat-sidebar-channel')).toHaveText([/Deal room/]);
  await expectNoSeriousAxe(page, '.guest-chat');

  // Another channel by URL: not theirs, so back to their list with a notice.
  await page.goto('guest/channels/channel-internal');
  await expect(page).toHaveURL(/\/guest\?notice=ended/);
  await expect(page.getByText('You no longer have access there.')).toBeVisible();
  expect(world.calls.some((call) => call.path.startsWith('/channels/channel-internal/posts'))).toBe(false);

  // Signing out ends it.
  await page.getByTestId('guest-sign-out').click();
  await expect(page).toHaveURL(/\/guest\/sign-in\?notice=signed-out/);
  await expect(page.getByText('You signed out.')).toBeVisible();
  api.assertNoUnexpectedRequests();
});

test('a guest posts, uploads a file in parts and comments on it in their channel', async ({ page }, testInfo) => {
  const { api, world } = await asGuest(page, createGuestWorld({ signedIn: true }));
  await page.goto('guest/channels/channel-deal');
  await expect(page.getByRole('heading', { level: 1, name: 'Deal room' })).toBeVisible();
  // Odin Chat's Tasks tab is for members; a guest's own tasks are on their home page.
  await expect(page.getByRole('button', { exact: true, name: 'Tasks' })).toHaveCount(0);

  const composer = page.getByRole('textbox', { name: 'Message Deal room' });
  await composer.click();
  await page.keyboard.type('Thanks Pat, I will review by Friday');
  await page.getByRole('button', { name: 'Send' }).click();
  const posted = page.locator('.channel-post').filter({ hasText: 'I will review by Friday' });
  await expect(posted).toHaveCount(1);
  await expect(posted.getByRole('article')).toHaveAccessibleName(/^Gina Guest/);
  expect(world.calls.find((call) => call.method === 'POST' && call.path === '/channels/channel-deal/posts').body.body).toBe('Thanks Pat, I will review by Friday');

  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: 'Upload file' }).click();
  const dialog = page.getByRole('dialog', { name: 'Upload a file' });
  await dialog.getByLabel('File', { exact: true }).setInputFiles({ buffer: Buffer.from('Network diagram v1'), mimeType: 'text/plain', name: 'diagram.txt' });
  await dialog.getByRole('button', { name: 'Upload file' }).click();
  await expect(dialog).toBeHidden();
  const row = page.locator('.project-files__row').filter({ hasText: 'diagram.txt' });
  await expect(row).toBeVisible();
  await expect(row).toContainText(GUEST.name);
  expect(world.calls.filter((call) => /^\/uploads/.test(call.path)).map((call) => `${call.method} ${call.path.replace(/upload-\d+/, 'upload')}`)).toEqual(['POST /uploads', 'POST /uploads/upload/parts', 'POST /uploads/upload/complete']);
  expect(world.calls.some((call) => call.method === 'PUT' && call.path.startsWith('/api/file-transfers/parts/'))).toBe(true);

  await row.getByRole('button', { name: 'Show versions and links for diagram.txt' }).click();
  await expect(row.getByText('Who can see it')).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Delete file' })).toHaveCount(0);
  const comment = row.getByRole('textbox', { name: 'Comment on diagram.txt' });
  await comment.click();
  await page.keyboard.type('WAN links updated');
  await row.getByRole('button', { name: 'Post comment' }).click();
  await expect(row.locator('.channel-post').filter({ hasText: 'WAN links updated' })).toHaveCount(1);
  await row.getByRole('button', { name: 'Mark as editing' }).click();
  await expect(row.getByText(/You are editing/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('guest-files.png') });
  await expectNoSeriousAxe(page, '.guest-channel');
  api.assertNoUnexpectedRequests();
});

test('a guest\u2019s bell shows a mention from their channel and opens it in the guest view', async ({ page }) => {
  const notifications = [{ channelId: 'channel-deal', count: 1, createdAt: '2026-11-14T11:58:00.000Z', excerpt: 'could you confirm the dates?', id: 'n-1', kind: 'mention', path: '/guest/channels/channel-deal?post=post-welcome', projectId: 'project-pursuit', projectName: 'Northwind pursuit', readAt: null, title: 'Pat Seller mentioned you in #Deal room', updatedAt: '2026-11-14T11:58:00.000Z' }];
  const { api, world } = await asGuest(page, createGuestWorld({ notifications, signedIn: true }));
  await page.goto('guest');
  const bell = page.getByRole('button', { name: 'Notifications, 1 unread' });
  await expect(bell).toBeVisible();
  await bell.click();
  await expect(page.getByRole('link', { name: 'Notification settings' })).toHaveCount(0);
  await page.getByRole('button', { name: /Pat Seller mentioned you in #Deal room/ }).click();
  await expect(page).toHaveURL(/\/guest\/channels\/channel-deal\?post=post-welcome$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Deal room' })).toBeVisible();
  expect(world.calls.find((call) => call.path === '/me/notifications/read').body).toEqual({ ids: ['n-1'] });
  await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();
  api.assertNoUnexpectedRequests();
});

test('a guest changes the status of their pursuit task, comments on it and attaches a file; others\u2019 tasks are read-only', async ({ page }, testInfo) => {
  const tasks = [
    { assignedToMe: true, dueDate: '2026-11-20', id: 'task-gina', name: 'Send network diagrams', status: 'Not Started' },
    { assignedToMe: false, assigneeName: 'Otto Outside', dueDate: '2026-11-18', id: 'task-otto', name: 'Confirm licences', status: 'In Progress' },
  ];
  const { api, world } = await asGuest(page, createGuestWorld({ signedIn: true, tasks, wholeBoard: true }));
  await page.goto('guest');
  const list = page.getByTestId('guest-tasks');
  await expect(list.getByRole('heading', { name: 'Tasks' })).toBeVisible();
  const rows = list.locator('.guest-tasks__row');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('Send network diagrams');
  await expect(rows.first()).toContainText('Yours');
  await expect(rows.nth(1)).toContainText('Otto Outside');

  // Someone else's task: shown, nothing to change.
  await rows.nth(1).click();
  await expect(rows.nth(1)).toHaveAttribute('aria-expanded', 'true');
  await expect(list.getByText('Assigned to Otto Outside. Only they can change it.')).toBeVisible();
  await expect(list.getByRole('button', { name: 'Save status' })).toHaveCount(0);
  await expect(list.getByRole('button', { name: 'Post comment' })).toHaveCount(0);
  await expect(list.getByText('Attach a file')).toHaveCount(0);

  // Their own task: status, comment, attachment.
  await rows.first().click();
  await expect(rows.nth(1)).toHaveAttribute('aria-expanded', 'false');
  await list.getByLabel('Status').selectOption('In Progress');
  await list.getByRole('button', { name: 'Save status' }).click();
  await expect(list.getByText('Status saved.')).toBeVisible();
  expect(world.calls.find((call) => call.method === 'PATCH' && call.path === '/projects/project-pursuit/tasks/task-gina').body).toEqual({ status: 'In Progress' });
  await expect(rows.first()).toContainText('In Progress');

  await list.getByRole('textbox', { name: 'Comment on Send network diagrams' }).fill('Diagrams sent by email');
  await list.getByRole('button', { name: 'Post comment' }).click();
  await expect(list.locator('.guest-tasks__comment-body').filter({ hasText: 'Diagrams sent by email' })).toHaveCount(1);

  await list.locator('input[type="file"]').setInputFiles({ buffer: Buffer.from('Network diagram v1'), mimeType: 'text/plain', name: 'diagram.txt' });
  await expect(list.getByText('diagram.txt attached.', { exact: false })).toBeVisible();
  await expect(list.getByRole('button', { name: 'diagram.txt' })).toBeVisible();
  expect(world.calls.find((call) => call.method === 'POST' && call.path === '/uploads').body).toMatchObject({ fileName: 'diagram.txt', targetId: 'task-gina', targetType: 'task' });
  await page.screenshot({ path: testInfo.outputPath('guest-tasks.png') });
  await expectNoSeriousAxe(page, '.guest-home');
  api.assertNoUnexpectedRequests();
});

test('a member opens a channel\u2019s Guests, invites one by name, email and organization, and removes one', async ({ page }) => {
  test.skip(test.info().project.name !== 'chromium-desktop', 'the members\u2019 dialog is covered once; guests run on every device');
  const api = await installSyntheticApi(page);
  await installChannelsApi(page, { world: createChannelsWorld() });
  const guests = await installChannelGuestsApi(page);
  await authenticateSyntheticUser(page);
  await page.goto(`projects/${syntheticProject.id}/channels?channel=channel-deal`);
  await page.getByTestId('channel-guests-open').click();
  const dialog = page.getByRole('dialog', { name: 'Guests in #Deal room' });
  await expect(dialog.getByTestId('channel-guests')).toContainText('Otto Outside');
  await expect(dialog.getByTestId('channel-guests')).toContainText('Not signed in yet');
  await dialog.getByLabel('Name').fill('Gina Guest');
  await dialog.getByLabel('Email').fill(GUEST.email);
  await dialog.getByLabel('Organization (optional)').fill('Northwind');
  await dialog.getByRole('button', { name: 'Invite' }).click();
  await expect(dialog.getByRole('status').filter({ hasText: 'Gina Guest is invited.' })).toBeVisible();
  expect(guests.calls.find((call) => call.method === 'POST').body).toEqual({ email: GUEST.email, name: 'Gina Guest', organization: 'Northwind' });
  await dialog.getByRole('button', { name: 'Remove Otto Outside' }).click();
  await page.getByRole('dialog', { name: 'Remove this guest?' }).getByRole('button', { name: 'Remove guest' }).click();
  await expect(dialog.getByTestId('channel-guests')).not.toContainText('Otto Outside');
  await expect(dialog.getByRole('status').filter({ hasText: 'They were in no other channel, so they are signed out.' })).toBeVisible();
  api.assertNoUnexpectedRequests();
});
