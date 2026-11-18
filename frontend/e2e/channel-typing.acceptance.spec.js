import { expect, test } from '@playwright/test';

import { createChannelsWorld, holdProjectStream, installChannelsApi } from './fixtures/channels-api.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

// Typing indicators in a channel and a thread, and the message list staying at its newest
// message while that message finishes laying out. The API is fixtures/channels-api.js; what the
// server publishes arrives on the held project stream.

const GENERAL = `projects/${syntheticProject.id}/channels?channel=channel-general`;

async function signedIn(page, world) {
  await installSyntheticApi(page);
  await installChannelsApi(page, { world });
  await authenticateSyntheticUser(page);
}

const typingEvent = (data) => ({ actor: { id: 'user-pat', name: 'Pat Seller', type: 'user' }, channelId: 'channel-general', originClientId: 'tab-elsewhere', parentId: null, projectId: syntheticProject.id, type: 'channel.typing', typing: true, ...data });

// How far the conversation is from its end, in pixels.
const gapToEnd = (page) => page.locator('.channel-conversation__scroller').evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight);

// A General channel long enough to scroll.
function longWorld() {
  const world = createChannelsWorld();
  for (let index = 0; index < 40; index += 1) {
    world.posts.push({ authorId: 'user-pat', body: `Status line ${index + 1}. The rollout plan moves one step forward.`, createdAt: new Date(Date.UTC(2026, 10, 14, 10, index)).toISOString(), id: `post-long-${index}`, parentId: null, targetId: 'channel-general' });
  }
  return world;
}

// Makes the next new message grow twice after it first lays out, as a poll and then an image in
// it do: 100 px, then 300 px. The first growth makes the list move to the end again, which queues
// a scroll event; the second lands before that event runs. The old rule read that event as the
// reader leaving the end and stopped following, 300 px short.
async function growNextMessageLate(page) {
  await page.locator('.channel-conversation__posts').evaluate((list) => {
    const known = new Set([...list.children].map((item) => item.querySelector('article')?.id));
    const grow = (item, height) => {
      const late = document.createElement('div');
      late.className = 'late-content';
      late.style.height = `${height}px`;
      item.querySelector('.channel-post__main').append(late);
    };
    // Runs after the list's own observer, which was made first.
    new ResizeObserver(() => {
      const fresh = [...list.children].find((item) => !known.has(item.querySelector('article')?.id));
      if (!fresh) return;
      const step = Number(fresh.dataset.grown ?? 0);
      if (step >= 2) return;
      fresh.dataset.grown = String(step + 1);
      setTimeout(() => grow(fresh, step === 0 ? 100 : 300), 0);
    }).observe(list);
  });
}

function addPatPost(world, body) {
  world.posts.push({ authorId: 'user-pat', body, createdAt: new Date(Date.UTC(2026, 10, 14, 13, 0)).toISOString(), id: 'post-arrived', parentId: null, targetId: 'channel-general' });
}

const postsChanged = { actor: { id: 'user-pat', name: 'Pat Seller' }, area: 'posts', channelId: 'channel-general', originClientId: 'tab-elsewhere', projectId: syntheticProject.id, type: 'channel.updated' };

test('typing sends one signal per burst and a stop on send; others typing show by the box and in their thread, then expire', async ({ page }) => {
  const world = createChannelsWorld();
  await signedIn(page, world);
  const release = await holdProjectStream(page);
  await page.goto(GENERAL);
  const composer = page.getByRole('textbox', { name: 'Message General' });
  await expect(composer).toBeVisible();

  await composer.click();
  await page.keyboard.type('Pricing is ready');
  await expect.poll(() => world.typing ?? []).toEqual([{ channelId: 'channel-general', typing: true, userId: 'user-synthetic' }]);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect.poll(() => (world.typing ?? []).at(-1)).toEqual({ channelId: 'channel-general', typing: false, userId: 'user-synthetic' });

  // A reply box signals for its thread.
  const welcome = page.locator('.channel-post').filter({ hasText: 'Kick-off notes are in the library.' });
  await welcome.getByRole('button', { name: 'Reply to Pat Seller' }).click();
  await page.keyboard.type('On it');
  await expect.poll(() => (world.typing ?? []).at(-1)).toEqual({ channelId: 'channel-general', parentId: 'post-welcome', typing: true, userId: 'user-synthetic' });
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(() => (world.typing ?? []).at(-1)).toEqual({ channelId: 'channel-general', parentId: 'post-welcome', typing: false, userId: 'user-synthetic' });

  // Pat types in the channel's box and in the welcome thread; another channel's typing stays out.
  release([typingEvent({}), typingEvent({ parentId: 'post-welcome' }), typingEvent({ actor: { id: 'user-x', name: 'Xan Elsewhere', type: 'user' }, channelId: 'channel-deal' })]);
  const line = page.locator('.channel-conversation__typing');
  await expect(line).toHaveText('Pat Seller is typing…');
  await expect(welcome.locator('.channel-post__typing')).toHaveText('Pat Seller is typing…');
  await expect(page.getByText('Xan Elsewhere')).toHaveCount(0);
  // No further signal: gone a few seconds later.
  await expect(line).toHaveText('', { timeout: 9000 });
  await expect(welcome.locator('.channel-post__typing')).toHaveCount(0);
});

test('at the end, a new message that keeps growing after it renders leaves the list at the very end', async ({ page }) => {
  test.skip(test.info().project.name === 'chromium-mobile', 'On a phone the page scrolls, not the message list.');
  const world = longWorld();
  await signedIn(page, world);
  const release = await holdProjectStream(page);
  await page.goto(GENERAL);
  await expect(page.getByText('Status line 40.', { exact: false })).toBeVisible();
  await expect.poll(() => gapToEnd(page)).toBeLessThanOrEqual(1);

  await growNextMessageLate(page);
  addPatPost(world, 'Arrived while you were watching.');
  release([postsChanged]);
  await expect(page.locator('.late-content')).toHaveCount(2);
  await expect.poll(() => gapToEnd(page)).toBeLessThanOrEqual(1);
  // And it stays there once the layout settles.
  await page.waitForTimeout(300);
  expect(await gapToEnd(page)).toBeLessThanOrEqual(1);
});

test('a reader who scrolled up to read history is not moved when a new message arrives', async ({ page }) => {
  test.skip(test.info().project.name === 'chromium-mobile', 'On a phone the page scrolls, not the message list.');
  const world = longWorld();
  await signedIn(page, world);
  const release = await holdProjectStream(page);
  await page.goto(GENERAL);
  await expect(page.getByText('Status line 40.', { exact: false })).toBeVisible();
  const scroller = page.locator('.channel-conversation__scroller');
  await scroller.hover();
  await page.mouse.wheel(0, -600);
  await expect.poll(() => gapToEnd(page)).toBeGreaterThan(200);
  const top = await scroller.evaluate((element) => element.scrollTop);

  await growNextMessageLate(page);
  addPatPost(world, 'Arrived while you were reading.');
  release([postsChanged]);
  await expect(page.locator('.late-content')).toHaveCount(2);
  await page.waitForTimeout(300);
  expect(await scroller.evaluate((element) => element.scrollTop)).toBeCloseTo(top, 0);
});
