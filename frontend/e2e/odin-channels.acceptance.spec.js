import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { settleForAxe } from './fixtures/axe-settle.js';
import { createChannelsWorld, holdProjectStream, installChannelsApi } from './fixtures/channels-api.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

// Odin in channels: the mention picker offers Odin, the thread shows "Odin is replying" until
// its answer arrives live, and an action Odin waits on shows Confirm and Cancel only to the
// person who tagged it. The API is the channels fixture with Odin's fields; the server side is
// covered by backend/test/odin-channels.test.js.

// Each test signs in and loads the app twice; with parallel workers the dev server takes about
// 10 seconds a load, which left too little of the default 30 seconds for the steps themselves.
test.describe.configure({ timeout: 60_000 });

const CHANNELS = `projects/${syntheticProject.id}/channels`;
const ODIN_TOKEN = '@[Odin](odin:odin)';
const at = (minutes) => new Date(Date.UTC(2026, 10, 14, 10, minutes)).toISOString();

// Screenshots wait for Odin's mark to load.
async function screenshot(page, path) {
  await page.waitForFunction(() => [...document.querySelectorAll('img.odin-avatar__mark')].every((image) => image.complete && image.naturalWidth > 0));
  await page.screenshot({ fullPage: false, path });
}

async function expectNoSeriousAxe(page) {
  await settleForAxe(page);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).include('#main-content').analyze();
  expect(results.violations.filter(({ impact }) => ['critical', 'serious'].includes(impact)).map(({ id }) => id)).toEqual([]);
}

function odinWorld() {
  const world = createChannelsWorld();
  world.odin = { available: true };
  // The server marks a new post that tags Odin as being answered.
  world.onPost = (post) => {
    if (post.body.includes('](odin:odin)')) post.odin = { status: 'replying' };
  };
  return world;
}

// A tag Odin answered with an action it waits on, asked by `askerId`.
function withPendingConfirmation(world, askerId) {
  world.posts.push(
    { authorId: askerId, body: `${ODIN_TOKEN} delete the old pricing draft`, createdAt: at(1), id: 'post-ask', odin: { status: 'waiting' }, parentId: null, targetId: 'channel-general' },
    {
      authorId: 'reply-1', authorType: 'odin', body: 'This needs your go-ahead first.', createdAt: at(2), id: 'post-odin-ask', parentId: 'post-ask', targetId: 'channel-general',
      odinReply: { askerId, confirmation: { callId: 'call-delete', label: 'Delete a file', status: 'pending', target: 'pricing-draft.xlsx' }, forYou: askerId === 'user-synthetic' },
    },
  );
  return world;
}

async function signedIn(page, world, { userId = 'user-synthetic' } = {}) {
  const api = await installSyntheticApi(page);
  await installChannelsApi(page, { userId, world });
  // Odin's confirm button, in front of the channels fixture.
  await page.route(`http://localhost:3001/api/projects/${world.projectId}/posts/*/odin/confirmation`, async (route) => {
    const body = route.request().postDataJSON();
    world.calls.push({ body, method: 'POST', path: new URL(route.request().url()).pathname, userId });
    const post = world.posts.find((entry) => entry.odinReply?.confirmation?.callId === body.callId);
    post.odinReply.confirmation.status = body.decision === 'approve' ? 'approved' : 'declined';
    world.posts.find((entry) => entry.id === post.parentId).odin = { status: 'replying' };
    await route.fulfill({ body: JSON.stringify({ channelId: post.targetId, ok: true }), contentType: 'application/json', status: 202 });
  });
  await authenticateSyntheticUser(page);
  return api;
}

test('the mention picker offers Odin, the thread shows Odin replying, and its answer arrives as Odin', async ({ page }, testInfo) => {
  const world = odinWorld();
  const api = await signedIn(page, world);
  const release = await holdProjectStream(page);
  await page.goto(`${CHANNELS}?channel=channel-general`);
  await expect(page.getByText('Kick-off notes are in the library.')).toBeVisible();

  const composer = page.getByRole('textbox', { name: 'Message General' });
  await composer.click();
  await page.keyboard.type('@od');
  const list = page.getByRole('listbox', { name: 'People to tag' });
  await expect(list.getByRole('option')).toHaveText([/Odin/]);
  await page.keyboard.press('Enter');
  await expect(composer.locator('.mention')).toHaveText('@Odin');
  await page.keyboard.type('where are we on the workshop plan?');
  await page.getByRole('button', { name: 'Send' }).click();

  const asked = page.locator('.channel-post').filter({ hasText: 'where are we on the workshop plan?' }).first();
  await expect(asked.locator('.mention[data-mention-kind="odin"]')).toHaveText('@Odin');
  expect(world.calls.find((call) => call.method === 'POST' && call.path.endsWith('/posts')).body.body).toBe(`${ODIN_TOKEN} where are we on the workshop plan?`);
  await expect(asked.getByRole('status').filter({ hasText: 'Odin is replying…' })).toBeVisible();

  // Odin's answer lands in the thread, and the server says so on the stream.
  const tagPost = world.posts.at(-1);
  world.posts.push({ authorId: 'reply-2', authorType: 'odin', body: 'The workshop plan is **drafted**: two sessions next week, agenda in the library.', createdAt: new Date(Date.parse(tagPost.createdAt) + 1000).toISOString(), id: 'post-odin-answer', parentId: tagPost.id, targetId: 'channel-general' });
  tagPost.odin = { status: 'replied' };
  release([{ actor: { id: null, name: 'Odin' }, area: 'posts', channelId: 'channel-general', originClientId: null, projectId: syntheticProject.id, type: 'channel.updated' }]);

  const answer = page.locator('.channel-post--reply').filter({ hasText: 'The workshop plan is drafted' });
  await expect(answer).toBeVisible({ timeout: 4000 });
  await expect(answer.getByText('Odin', { exact: true })).toBeVisible();
  // No label beside the name: the sparkle on the avatar says Odin is AI, and hover shows why.
  const avatar = answer.getByRole('button', { name: 'Odin is an AI assistant' });
  await expect(avatar.locator('.odin-avatar__spark')).toHaveText('✨');
  await expect(answer.getByRole('tooltip')).toHaveCount(0);
  await avatar.hover();
  await expect(answer.getByRole('tooltip')).toHaveText('Odin is an AI assistant');
  await page.mouse.move(0, 0);
  await expect(answer.getByRole('tooltip')).toHaveCount(0);
  await expect(page.getByText('Odin is replying…')).toHaveCount(0);
  await expect(answer.getByRole('button', { name: /^Edit/ })).toHaveCount(0);
  await answer.scrollIntoViewIfNeeded();
  await screenshot(page, testInfo.outputPath('odin-reply.png'));
  await expectNoSeriousAxe(page);
  api.assertNoUnexpectedRequests();
});

test('Odin\'s confirm and cancel buttons show only for the person who tagged it, and confirming sends their answer', async ({ page }, testInfo) => {
  const world = withPendingConfirmation(odinWorld(), 'user-synthetic');
  const api = await signedIn(page, world);
  await page.goto(`${CHANNELS}?channel=channel-general`);
  const card = page.getByRole('region', { name: 'Odin is asking to confirm' });
  await expect(card).toContainText('Delete a file: pricing-draft.xlsx');
  await expect(card.getByRole('button', { name: 'Confirm' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  await screenshot(page, testInfo.outputPath('odin-pending-confirmation.png'));
  await expectNoSeriousAxe(page);

  await card.getByRole('button', { name: 'Confirm' }).click();
  await expect(card.getByRole('button', { name: 'Confirm' })).toHaveCount(0);
  await expect(card).toContainText('Confirmed.');
  const call = world.calls.find((entry) => entry.path.endsWith('/odin/confirmation'));
  expect(call.path).toBe(`/api/projects/${syntheticProject.id}/posts/post-odin-ask/odin/confirmation`);
  expect(call.body).toEqual({ callId: 'call-delete', decision: 'approve' });
  await expect(page.getByText('Odin is replying…')).toBeVisible();
  api.assertNoUnexpectedRequests();
});

test('Mermaid and Graphviz blocks in a post draw inline, and an unclosed fence stays text', async ({ page }, testInfo) => {
  const world = odinWorld();
  world.posts.push(
    { authorId: 'user-synthetic', body: `${ODIN_TOKEN} draw the SDLC with AI in the loop`, createdAt: at(1), id: 'post-draw', odin: { status: 'replied' }, parentId: null, targetId: 'channel-general' },
    {
      authorId: 'reply-1', authorType: 'odin', createdAt: at(2), id: 'post-odin-draw', parentId: 'post-draw', targetId: 'channel-general',
      body: 'The loop:\n\n```mermaid\nflowchart LR\n  A["Plan"] --> B["Build"]\n  B --> C["Release"]\n  C -. "AI: summarize incidents" .-> A\n```\n\nAnd the dependencies:\n\n```dot\ndigraph { rankdir=LR; Foundation -> Content; Content -> Launch }\n```',
    },
    { authorId: 'user-synthetic', body: 'Half a fence:\n\n```mermaid\nflowchart LR', createdAt: at(3), id: 'post-open-fence', parentId: null, targetId: 'channel-general' },
  );
  const api = await signedIn(page, world);
  await page.goto(`${CHANNELS}?channel=channel-general`);

  const answer = page.locator('.channel-post--reply').filter({ hasText: 'The loop:' });
  await expect(answer.locator('.assistant-visual--mermaid svg')).toBeVisible({ timeout: 15000 });
  await expect(answer.locator('.assistant-visual--mermaid svg')).toContainText('Release');
  await expect(answer.locator('.assistant-visual--graphviz svg')).toContainText('Foundation');
  await expect(answer.getByText('flowchart LR')).toHaveCount(0);
  await expect(answer.getByText('And the dependencies:')).toBeVisible();
  // A stored post is whole, so an open fence is just text, not a drawing that never finishes.
  const open = page.locator('.channel-post').filter({ hasText: 'Half a fence:' }).first();
  await expect(open.locator('.assistant-visual')).toHaveCount(0);
  await expect(open).toContainText('flowchart LR');
  await answer.scrollIntoViewIfNeeded();
  await screenshot(page, testInfo.outputPath('odin-diagram.png'));
  await expectNoSeriousAxe(page);
  api.assertNoUnexpectedRequests();
});

test('someone else sees what Odin is waiting on, without the buttons', async ({ page }) => {
  const world = withPendingConfirmation(odinWorld(), 'user-pat');
  const api = await signedIn(page, world);
  await page.goto(`${CHANNELS}?channel=channel-general`);
  const card = page.getByRole('region', { name: 'Odin is asking to confirm' });
  await expect(card).toContainText('Delete a file: pricing-draft.xlsx');
  await expect(card).toContainText('Waiting for the person who tagged Odin to confirm.');
  await expect(card.getByRole('button')).toHaveCount(0);
  api.assertNoUnexpectedRequests();
});

test('with Odin switched off in a channel, its picker does not offer Odin; the switch is in Channel settings, saved with Save', async ({ page }) => {
  const world = odinWorld();
  world.channels.find((channel) => channel.id === 'channel-general').odinEnabled = false;
  const api = await signedIn(page, world);
  // The channel list carries no Odin switch any more.
  await page.goto(CHANNELS);
  await expect(page.getByRole('switch', { name: 'Let Odin answer when tagged' })).toHaveCount(0);
  await page.goto(`${CHANNELS}?channel=channel-general`);
  const composer = page.getByRole('textbox', { name: 'Message General' });
  await composer.click();
  await page.keyboard.type('@od');
  await expect(page.getByRole('listbox', { name: 'People to tag' }).getByRole('option', { name: /Odin/ })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Channel settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Channel settings' });
  const odinSwitch = dialog.getByRole('switch', { name: 'Let Odin answer when tagged' });
  await expect(odinSwitch).not.toBeChecked();
  await expect(odinSwitch).toBeEnabled();
  await odinSwitch.check();
  // Nothing is saved until Save.
  expect(world.calls.filter((call) => call.method === 'PATCH' && call.path.endsWith('/channels/channel-general'))).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  const saved = world.calls.filter((call) => call.method === 'PATCH' && call.path.endsWith('/channels/channel-general')).at(-1);
  expect(saved.body).toEqual({ description: 'Everyone on the project', odinEnabled: true });
  // The box asks again who it may tag, and now offers Odin.
  await composer.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('@od');
  await expect(page.getByRole('listbox', { name: 'People to tag' }).getByRole('option')).toHaveText([/Odin/]);
  api.assertNoUnexpectedRequests();
});

test('someone without decision rights sees the channel’s Odin switch in Channel settings, but cannot change it', async ({ page }) => {
  const world = odinWorld();
  world.canSwitchOdin = false;
  const api = await signedIn(page, world);
  await page.goto(`${CHANNELS}?channel=channel-deal`);
  await page.getByRole('button', { name: 'Channel settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Channel settings' });
  const odinSwitch = dialog.getByRole('switch', { name: 'Let Odin answer when tagged' });
  await expect(odinSwitch).toBeChecked();
  await expect(odinSwitch).toBeDisabled();
  await expect(dialog.getByText('Only a project admin or manager can change this.')).toBeVisible();
  await expectNoSeriousAxe(page);
  api.assertNoUnexpectedRequests();
});
