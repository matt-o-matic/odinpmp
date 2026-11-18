import { expect, test } from '@playwright/test';

import { createChannelsWorld, installChannelsApi } from './fixtures/channels-api.js';
import { storedPoll } from './fixtures/polls-fixture.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

// Links to one post, as chat emails, push and the bell send them (backend
// notifications.service.js memberNotificationPath): the conversation opens on the post, marked,
// also when it is older than the first page, a reply, or a poll the reader already voted in.

test.describe.configure({ timeout: 60_000 });

const at = (minutes) => new Date(Date.UTC(2026, 10, 14, 10, minutes)).toISOString();
const CHAT = `chat/channels/${syntheticProject.id}/channel-general`;
const PROJECT_CHANNELS = `projects/${syntheticProject.id}/channels?channel=channel-general`;

/** A poll the viewer voted in, a reply in its thread, and 40 newer threads above them. */
function busyChannel() {
  const world = createChannelsWorld();
  world.paged = true;
  world.posts.push({ authorId: 'user-pat', body: 'Lunch on Friday?', createdAt: at(1), id: 'post-poll', parentId: null, poll: storedPoll({ kind: 'single', options: ['Yes', 'No'], question: 'Lunch on Friday?' }), targetId: 'channel-general' });
  world.pollVotes = [{ answer: { optionIds: ['o1'] }, postId: 'post-poll', userId: 'user-synthetic' }];
  world.posts.push({ authorId: 'user-pat', body: 'We have chat now', createdAt: at(2), id: 'post-chat', parentId: 'post-poll', targetId: 'channel-general' });
  for (let index = 0; index < 40; index += 1) world.posts.push({ authorId: 'user-pat', body: `Update ${index + 1}`, createdAt: at(10 + index), id: `post-update-${index + 1}`, parentId: null, targetId: 'channel-general' });
  return world;
}

async function open(page, path) {
  await installSyntheticApi(page);
  await installChannelsApi(page, { world: busyChannel() });
  await authenticateSyntheticUser(page);
  await page.goto(path);
}

// The linked post's card is marked (ChannelPost.vue channel-post--focused).
const marked = (page, postId) => page.locator(`li.channel-post--focused > #channel-post-${postId}`);

test('a link to an older poll the reader voted in opens on it, marked; a link to the reply in its thread opens on the reply', async ({ page }) => {
  await open(page, `${CHAT}?post=post-poll`);
  const poll = page.locator('#channel-post-post-poll');
  await expect(poll.locator('.post-poll')).toContainText('Lunch on Friday?');
  await expect(poll).toBeInViewport();
  await expect(marked(page, 'post-poll')).toHaveCount(1);
  await expect(poll.getByRole('button', { name: 'Change vote' })).toBeVisible();

  // The second email: the reply, in the same thread.
  await page.goto(`${CHAT}?post=post-chat`);
  const reply = page.locator('#channel-post-post-chat');
  await expect(reply).toContainText('We have chat now');
  await expect(reply).toBeInViewport();
  await expect(marked(page, 'post-chat')).toHaveCount(1);
  await expect(marked(page, 'post-poll')).toHaveCount(0);
});

test('the project’s Channels tab opens the same link on the poll', async ({ page }) => {
  await open(page, `${PROJECT_CHANNELS}&post=post-poll`);
  const poll = page.locator('#channel-post-post-poll');
  await expect(poll.locator('.post-poll')).toContainText('Lunch on Friday?');
  await expect(poll).toBeInViewport();
  await expect(marked(page, 'post-poll')).toHaveCount(1);
});
