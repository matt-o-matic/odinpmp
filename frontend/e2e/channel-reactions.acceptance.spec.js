import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { settleForAxe } from './fixtures/axe-settle.js';
import { createChannelsWorld, installChannelsApi } from './fixtures/channels-api.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

// Reactions and replies to a reply: the quick row and the searchable picker, toggling, who
// reacted, and the quote above a reply that answers another reply. The server side is in
// backend/test/channels.test.js.

test.describe.configure({ timeout: 60_000 });

const CHANNELS = `projects/${syntheticProject.id}/channels`;
const at = (minutes) => new Date(Date.UTC(2026, 10, 14, 10, minutes)).toISOString();

async function expectNoSeriousAxe(page, selector = '#main-content') {
  await settleForAxe(page);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).include(selector).analyze();
  expect(results.violations.filter(({ impact }) => ['critical', 'serious'].includes(impact)).map(({ id }) => id)).toEqual([]);
}

async function signedIn(page, world) {
  const api = await installSyntheticApi(page);
  await installChannelsApi(page, { world });
  await authenticateSyntheticUser(page);
  return api;
}

const reactionCalls = (world) => world.calls.filter((call) => call.method === 'PUT' && call.path.endsWith('/reactions')).map((call) => call.body);

test('reactions: the quick row, search, toggling, counts and who reacted', async ({ page }, testInfo) => {
  const world = createChannelsWorld();
  world.reactions.push({ emoji: '🎉', postId: 'post-welcome', userId: 'user-pat' });
  const api = await signedIn(page, world);
  await page.goto(`${CHANNELS}?channel=channel-general`);
  const post = page.locator('.channel-post').filter({ hasText: 'Kick-off notes are in the library.' }).first();
  await expect(post).toBeVisible();

  // Pat's reaction: its count, and who on hover.
  const party = post.getByRole('button', { name: /^🎉 1 person: Pat Seller\. Add yours$/ });
  await expect(party).toHaveAttribute('aria-pressed', 'false');
  await party.hover();
  await expect(post.getByRole('tooltip')).toHaveText('Pat Seller reacted with 🎉');

  // The quick row.
  const react = post.getByRole('button', { name: 'React to Pat Seller\'s message' });
  await react.click();
  const picker = page.getByRole('dialog', { name: 'React to Pat Seller\'s message' });
  await expect(picker.getByRole('searchbox', { name: 'Search emoji' })).toBeFocused();
  await expect(picker.getByRole('group', { name: 'Quick reactions' }).getByRole('button')).toHaveCount(8);
  await expect(picker.getByRole('button', { name: 'React with pizza' })).toHaveCount(0);
  await expectNoSeriousAxe(page, '.emoji-picker');
  if (testInfo.project.name === 'chromium-desktop') await page.screenshot({ path: testInfo.outputPath('reaction-picker.png') });
  await picker.getByRole('button', { name: 'React with thumbs up' }).click();
  await expect(picker).toHaveCount(0);
  await expect(react).toBeFocused();
  const thumbs = post.getByRole('button', { name: /^👍 1 person: You\. Remove your reaction$/ });
  await expect(thumbs).toHaveAttribute('aria-pressed', 'true');

  // Search the whole set.
  await react.click();
  await picker.getByRole('searchbox', { name: 'Search emoji' }).fill('pizza');
  await picker.getByRole('button', { name: 'React with pizza' }).click();
  await expect(post.getByRole('button', { name: /^🍕 1 person: You\./ })).toBeVisible();

  // Pressing someone else's adds yours; pressing yours takes it back.
  await party.click();
  await expect(post.getByRole('button', { name: /^🎉 2 people: You and Pat Seller\. Remove your reaction$/ })).toBeVisible();
  await thumbs.click();
  await expect(post.getByRole('button', { name: /^👍/ })).toHaveCount(0);
  expect(reactionCalls(world)).toEqual([
    { emoji: '👍', reacted: true },
    { emoji: '🍕', reacted: true },
    { emoji: '🎉', reacted: true },
    { emoji: '👍', reacted: false },
  ]);

  // Escape closes the picker, back on the button that opened it.
  await post.getByRole('button', { name: 'Add a reaction to Pat Seller\'s message' }).click();
  await expect(picker).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await expect(post.getByRole('button', { name: 'Add a reaction to Pat Seller\'s message' })).toBeFocused();

  // Others' reactions arrive with the conversation after a reload.
  await page.reload();
  await expect(page.locator('.channel-post').filter({ hasText: 'Kick-off notes' }).first().getByRole('button', { name: /^🎉 2 people/ })).toBeVisible();
  if (testInfo.project.name === 'chromium-desktop') await page.screenshot({ path: testInfo.outputPath('reactions.png') });
  await expectNoSeriousAxe(page);
  api.assertNoUnexpectedRequests();
});

test('a reply to a reply shows a quote of it, and the quote leads back to it', async ({ page }, testInfo) => {
  const world = createChannelsWorld();
  world.posts.push(
    { authorId: 'user-pat', body: 'Add the **budget** review, and ask @[Synthetic Demo](user:user-synthetic)', createdAt: at(1), id: 'post-r1', parentId: 'post-welcome', targetId: 'channel-general' },
    { authorId: 'user-pat', body: '', createdAt: at(2), deletedAt: at(3), id: 'post-r2', parentId: 'post-welcome', targetId: 'channel-general' },
    { authorId: 'user-synthetic', body: 'Too late', createdAt: at(4), id: 'post-r3', parentId: 'post-welcome', replyToId: 'post-r2', targetId: 'channel-general' },
  );
  const api = await signedIn(page, world);
  await page.goto(`${CHANNELS}?channel=channel-general`);

  // A deleted reply is quoted as such.
  const late = page.locator('.channel-post--reply').filter({ hasText: 'Too late' });
  await expect(late.getByRole('button', { name: 'In reply to a deleted message' })).toHaveText(/Deleted message/);

  // Reply on Pat's reply: the form says what it answers.
  const first = page.locator('li.channel-post--reply:has(> #channel-post-post-r1)');
  await first.getByRole('button', { name: 'Reply to Pat Seller' }).click();
  const form = page.locator('.channel-post__replying-to');
  await expect(form).toHaveText(/Pat Seller: Add the budget review, and ask @Synthetic Demo/);
  // The reply starts by tagging Pat, with the cursor after the tag.
  const box = page.locator('.channel-post__form [contenteditable="true"]');
  await expect(box.locator('.mention')).toHaveText('@Pat Seller');
  await page.keyboard.type('Agreed, I will add it');
  await page.getByRole('button', { name: 'Post reply' }).click();
  const posted = world.calls.find((call) => call.method === 'POST' && call.path.endsWith('/posts'));
  expect(posted.body).toMatchObject({ body: '@[Pat Seller](user:user-pat) Agreed, I will add it', parentId: 'post-welcome', replyToId: 'post-r1' });

  // The new reply quotes it; the quote brings it into view and marks it.
  const answer = page.locator('.channel-post--reply').filter({ hasText: 'Agreed, I will add it' });
  const quote = answer.getByRole('button', { name: /^In reply to Pat Seller: Add the budget review, and ask @Synthetic Demo\. Show that message$/ });
  await expect(quote).toBeVisible();
  await quote.click();
  await expect(first).toHaveClass(/channel-post--focused/);
  await expect(first.locator('article')).toBeInViewport();
  if (testInfo.project.name === 'chromium-desktop') await page.screenshot({ path: testInfo.outputPath('reply-quote.png') });

  // Dropping the quote replies to the thread instead.
  await first.getByRole('button', { name: 'Reply to Pat Seller' }).click();
  await page.getByRole('button', { name: 'Reply to the thread instead' }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Post reply' })).toBeVisible();
  await expectNoSeriousAxe(page);
  api.assertNoUnexpectedRequests();
});

test('the Emoji button in the message box puts an emoji where the cursor was, and the message carries it', async ({ page }, testInfo) => {
  const world = createChannelsWorld();
  const api = await signedIn(page, world);
  await page.goto(`${CHANNELS}?channel=channel-general`);
  const box = page.getByRole('textbox', { name: 'Message General' });
  await box.click();
  await page.keyboard.type('Ship it ');

  const button = page.getByRole('button', { name: 'Emoji' });
  await button.click();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  const picker = page.getByRole('dialog', { name: 'Insert an emoji' });
  await expect(picker.getByRole('group', { name: 'Frequently used' }).getByRole('button')).toHaveCount(8);
  await expect(picker.getByRole('searchbox', { name: 'Search emoji' })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('editor-emoji-picker.png') });
  await expectNoSeriousAxe(page, '.emoji-picker');

  // A search, then a pick: it goes in after the text, and typing carries on in the box.
  await picker.getByRole('searchbox', { name: 'Search emoji' }).fill('rocket');
  await picker.getByRole('button', { name: 'Insert rocket' }).click();
  await expect(picker).toHaveCount(0);
  await expect(box).toBeFocused();
  await page.keyboard.type(' now');
  await expect(box).toHaveText('Ship it 🚀 now');

  // Escape closes it without inserting, and focus goes back to the text.
  await button.click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Insert an emoji' })).toHaveCount(0);
  await expect(box).toBeFocused();

  await page.getByRole('button', { name: 'Send' }).click();
  const sent = world.calls.find((call) => call.method === 'POST' && call.path.endsWith('/posts'));
  expect(sent.body.body).toBe('Ship it 🚀 now');
  api.assertNoUnexpectedRequests();
});
