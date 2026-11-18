import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { settleForAxe } from './fixtures/axe-settle.js';
import { createChannelsWorld, installChannelsApi } from './fixtures/channels-api.js';
import { createChatWorld, installChatApi } from './fixtures/chat-api.js';
import { authenticateSyntheticUser, installSyntheticApi, openPhoneMenu, openTopMenu } from './fixtures/synthetic-api.js';

// Odin proper's grouped top bar and Odin Chat (docs/odin-chat/plan.md, workstream 2; AC-N07 to
// AC-N10): the Work, Plan and Insights menus and Ctrl+K, every former top-level page reachable,
// Odin Chat's own shell with its sidebar and unread counts, a channel, a new direct message, Odin
// as a direct message, the phone's screens and bottom bar, Odin Chat's own manifest, and the Chat
// start page. The APIs are the stateful fixtures in fixtures/.

const ODIN_CHAT = {
  createdAt: '2026-11-14T09:00:00.000Z',
  id: 'chat-budget',
  messages: [
    { content: 'Where does the budget stand?', createdAt: '2026-11-14T09:00:00.000Z', id: 'message-1', role: 'user' },
    { activity: [], content: 'The budget is 82% spent.', createdAt: '2026-11-14T09:00:05.000Z', id: 'message-2', role: 'assistant' },
  ],
  pending: null,
  projectId: null,
  projectName: null,
  run: { id: 'run-1', status: 'completed' },
  settings: { allowWebResearch: true },
  title: 'Budget check',
  updatedAt: '2026-11-14T09:00:05.000Z',
};

async function expectNoSeriousAxe(page, selector) {
  await settleForAxe(page);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).include(selector).analyze();
  expect(results.violations.filter(({ impact }) => ['critical', 'serious'].includes(impact)).map(({ id, nodes }) => `${id}: ${nodes.map((node) => node.target.join(' ')).join(', ')}`)).toEqual([]);
}

async function signedInToChat(page, { preferences = {} } = {}) {
  const api = await installSyntheticApi(page, { assistantChat: ODIN_CHAT, preferences });
  const channelsWorld = createChannelsWorld();
  // Pat tags the person in General, after they last read it.
  channelsWorld.posts.push({ authorId: 'user-pat', body: '@[Synthetic Demo](user:user-synthetic) the kick-off deck is final', createdAt: new Date(Date.UTC(2026, 10, 14, 9, 40)).toISOString(), id: 'post-tag', parentId: null, targetId: 'channel-general' });
  await installChannelsApi(page, { world: channelsWorld });
  const chatWorld = createChatWorld({ channelsWorld });
  await installChatApi(page, { world: chatWorld });
  return { api, channelsWorld, chatWorld };
}

const sidebarOf = (page) => page.getByRole('navigation', { name: 'Conversations' });

// On a phone, opens the top bar's menu once any closing has finished.
async function openBarIfCollapsed(page) {
  if (!await page.getByRole('button', { name: 'Toggle navigation' }).isVisible()) return;
  await expect(page.locator('#navbarSupportedContent.collapsing')).toHaveCount(0);
  if (!await page.locator('#navbarSupportedContent.show').count()) await openPhoneMenu(page);
}

test('the top bar groups Odin into Home, Work, Chat, Plan and Insights, with Ctrl+K search, and every former page stays reachable (AC-N07)', async ({ page }, testInfo) => {
  const api = await installSyntheticApi(page, { admin: true });
  await installChatApi(page, { world: createChatWorld({ channelsWorld: createChannelsWorld() }) });
  await authenticateSyntheticUser(page);

  // Ctrl+K goes to search from anywhere in Odin.
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('combobox', { name: 'Search workspace' })).toBeFocused();
  await page.keyboard.press('Escape');

  // Work: a column each for projects and tickets (engagements need the Consulting module), with
  // the main page, New and the recent ones.
  const work = await openTopMenu(page, 'Work');
  await expect(work.getByRole('heading', { level: 2 })).toHaveText(['Projects', 'Tickets']);
  await expect(work.getByRole('heading', { level: 3, name: 'Recent' })).toHaveCount(2);
  await expect(work.getByRole('link')).toHaveText(['All projects', 'New project…', 'Synthetic Delivery Plan', 'All tickets', 'New ticket…']);
  await expect(work.getByText('No tickets yet')).toBeVisible();
  if (testInfo.project.name === 'chromium-desktop') {
    // Side by side on a wide screen.
    const [projects, tickets] = await work.locator('.app-work-menu__column').evaluateAll((columns) => columns.map((column) => column.getBoundingClientRect().top));
    expect(Math.abs(projects - tickets)).toBeLessThan(2);
    await page.screenshot({ path: testInfo.outputPath('topbar-work-menu.png') });
  }
  // Keyboard: arrows move through the open menu.
  await page.keyboard.press('ArrowDown');
  await expect(work.getByRole('link', { name: 'All projects' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(work).toBeHidden();

  const plan = await openTopMenu(page, 'Plan');
  await expect(plan.getByRole('link')).toHaveText(['Portfolio', 'Rank projects', 'Resources', 'Finance', 'Workflows']);
  if (testInfo.project.name === 'chromium-desktop') await page.screenshot({ path: testInfo.outputPath('topbar-plan-menu.png') });
  await page.keyboard.press('Escape');
  const insights = await openTopMenu(page, 'Insights');
  await expect(insights.getByRole('link')).toHaveText(['Reports', 'Leaderboard']);
  await page.keyboard.press('Escape');

  // Every page the old top bar linked, through its menu.
  for (const [menu, name, url] of [
    ['Work', 'All projects', /\/app\/projects$/],
    ['Work', 'All tickets', /\/app\/tickets$/],
    ['Work', 'Synthetic Delivery Plan', /\/app\/projects\/project-synthetic$/],
    ['Plan', 'Portfolio', /\/app\/portfolio$/],
    ['Plan', 'Rank projects', /\/app\/ranking$/],
    ['Plan', 'Resources', /\/app\/resources$/],
    ['Plan', 'Finance', /\/app\/finance$/],
    ['Plan', 'Workflows', /\/app\/workflows$/],
    ['Insights', 'Reports', /\/app\/reports$/],
    ['Insights', 'Leaderboard', /\/app\/leaderboard$/],
  ]) {
    await (await openTopMenu(page, menu)).getByRole('link', { exact: true, name }).click();
    await expect(page, `${menu} > ${name}`).toHaveURL(url);
    await expect(page.locator(`#${menu.toLowerCase()}Menu`)).toHaveAttribute('aria-current', 'true');
    await expect(page.locator(`#${menu.toLowerCase()}Menu + .dropdown-menu`)).toBeHidden();
  }
  // Home and Chat are links of their own.
  await openBarIfCollapsed(page);
  await page.getByRole('link', { exact: true, name: 'Home' }).click();
  await expect(page).toHaveURL(/\/app\/$/);
  // New project opens the projects page's new-project form.
  await (await openTopMenu(page, 'Work')).getByRole('link', { exact: true, name: 'New project…' }).click();
  await expect(page.getByRole('dialog', { name: /Create Project/ })).toBeVisible();
  // New ticket asks which project, then opens that project's new-ticket form.
  await page.goto('/app/');
  await (await openTopMenu(page, 'Work')).getByRole('link', { exact: true, name: 'New ticket…' }).click();
  const which = page.getByRole('dialog', { name: 'New ticket' });
  await expect(which.getByLabel('Project')).toHaveValue('project-synthetic');
  await which.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/app\/projects\/project-synthetic\/tickets$/);
  await expect(page.locator('.project-tickets__dialog[open]')).toContainText('New ticket');
  await page.goto('/app/');
  await openBarIfCollapsed(page);
  await page.getByTestId('topbar-chat').click();
  await expect(page).toHaveURL(/\/app\/chat$/);
  expect(api).toBeTruthy();
});

test('Odin Chat lists channels and direct messages with unread counts, opens a channel, starts a direct message, and opens Odin (AC-N08 to AC-N10)', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'chromium-mobile', 'The phone has its own test below.');
  const { api, chatWorld } = await signedInToChat(page);
  await authenticateSyntheticUser(page);

  // Odin's own manifest, as this server serves the page.
  const odinManifest = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(odinManifest).toMatch(/manifest\.webmanifest$/);
  // The Chat badge: 2 unread in Deal room, 1 in General, and Pat's direct message.
  const chat = page.getByTestId('topbar-chat');
  await expect(chat).toContainText('4');
  await expect(chat).toHaveAccessibleName(/^Chat ?, 4 unread$/);
  await chat.click();
  await expect(page).toHaveURL(/\/app\/chat$/);
  await expect(page.locator('nav.navbar')).toHaveCount(0);
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/app/chat.webmanifest');
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute('content', 'Odin Chat');
  await expect(page).toHaveTitle('Odin Chat');

  const sidebar = sidebarOf(page);
  await expect(sidebar.getByRole('link', { name: /^Mentions ?, 1 mention$/ })).toBeVisible();
  await expect(sidebar.getByRole('link', { name: 'Odin' })).toBeVisible();
  await expect(sidebar.getByRole('link', { name: /^Pat Seller ?, 1 unread$/ })).toBeVisible();
  await expect(sidebar.getByRole('link', { name: /^Deal room ?, 2 unread$/ })).toHaveClass(/chat-sidebar__item--unread/);
  await expect(sidebar.getByRole('link', { name: /^General ?, 1 unread, 1 mention$/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('odin-chat-desktop.png') });
  await expectNoSeriousAxe(page, '.chat-layout');

  // Sections collapse.
  await sidebar.getByRole('button', { name: 'Synthetic Delivery Plan' }).click();
  await expect(sidebar.getByRole('link', { name: /^Deal room/ })).toBeHidden();
  await sidebar.getByRole('button', { name: /^Synthetic Delivery Plan/ }).click();

  // A channel: the project's own conversation and files.
  await sidebar.getByRole('link', { name: /^Deal room/ }).click();
  await expect(page).toHaveURL(/\/app\/chat\/channels\/project-synthetic\/channel-deal$/);
  await expect(page.getByRole('heading', { exact: true, level: 3, name: 'Deal room' })).toBeVisible();
  await expect(page.getByText('Can we hold the rate?')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Files', exact: true })).toBeVisible();
  await expect(sidebar.getByRole('link', { exact: true, name: 'Deal room' })).toBeVisible();

  // A new direct message.
  await sidebar.getByRole('button', { name: 'New message' }).click();
  const dialog = page.getByRole('dialog', { name: 'New message' });
  await dialog.getByLabel('Find people').fill('quinn');
  await dialog.getByRole('button', { name: /Quinn Analyst/ }).click();
  await dialog.getByRole('button', { name: 'Open conversation' }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/app\/chat\/dm\/dm-\d+$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Quinn Analyst' })).toBeVisible();
  const composer = page.getByRole('textbox', { name: 'Message Quinn Analyst' });
  await composer.click();
  await page.keyboard.type('Can you send the Q3 numbers?');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('.channel-post').filter({ hasText: 'Can you send the Q3 numbers?' })).toHaveCount(1);
  expect(chatWorld.calls.find((call) => call.method === 'POST' && call.path === '/conversations').body).toEqual({ memberIds: ['user-quinn'] });
  await expect(sidebar.getByRole('link', { exact: true, name: 'Quinn Analyst' })).toBeVisible();

  // Odin: the person's AI Workspace chats, in the page; a message there is an AI Workspace turn.
  await sidebar.getByRole('link', { name: 'Odin' }).click();
  await expect(page).toHaveURL(/\/app\/chat\/odin$/);
  const workspace = page.getByRole('region', { name: 'AI Workspace' });
  await expect(workspace.getByRole('navigation', { name: 'Chats' })).toContainText('Budget check');
  await expect(workspace.getByRole('button', { name: 'Close assistant' })).toHaveCount(0);
  await workspace.getByRole('navigation', { name: 'Chats' }).getByRole('button', { name: /Budget check/ }).first().click();
  await expect(workspace.getByText('The budget is 82% spent.')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('odin-chat-odin.png') });

  // Jump to with Ctrl+K.
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('combobox', { name: 'Search or jump to' })).toBeFocused();
  await page.keyboard.type('deal');
  await expect(page.getByRole('option', { name: /#Deal room/ })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/channels\/project-synthetic\/channel-deal$/);

  // Back to Odin proper: its top bar and its own manifest.
  await page.getByTestId('chat-open-odin').click();
  await expect(page).toHaveURL(/\/app\/$/);
  await expect(page.locator('nav.navbar')).toBeVisible();
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', odinManifest);
  api.assertNoUnexpectedRequests();
});

test('on a phone Odin Chat opens on the sidebar, a conversation replaces it with Back, and the bottom bar holds Chat, Mentions, Search and More', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-mobile', 'The phone layout.');
  const { api } = await signedInToChat(page);
  await authenticateSyntheticUser(page);
  await page.goto('chat');
  const sidebar = sidebarOf(page);
  const bottom = page.getByRole('navigation', { name: 'Chat' });
  await expect(sidebar).toBeVisible();
  await expect(bottom.getByRole('link')).toHaveText(['Chat', 'Mentions', 'Search']);
  await expect(bottom.getByRole('button', { name: 'More' })).toBeVisible();
  await expect(bottom.getByRole('link', { name: 'Chat' })).toHaveAttribute('aria-current', 'page');
  await page.screenshot({ path: testInfo.outputPath('odin-chat-phone-sidebar.png') });
  await expectNoSeriousAxe(page, '.chat-layout');

  await sidebar.getByRole('link', { name: /^Pat Seller/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Pat Seller' })).toBeVisible();
  await expect(page.getByText('Can you look at the rate card before Friday?')).toBeVisible();
  await expect(sidebar).toBeHidden();
  await expect(bottom).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('odin-chat-phone-conversation.png') });
  await page.getByRole('link', { name: 'Back' }).click();
  await expect(sidebar).toBeVisible();

  await bottom.getByRole('link', { name: 'Mentions' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Mentions' })).toBeVisible();
  await expect(page.getByTestId('chat-mention')).toContainText('@Synthetic Demo the kick-off deck is final');
  await page.getByTestId('chat-mention').click();
  await expect(page).toHaveURL(/\/channels\/project-synthetic\/channel-general\?post=post-tag$/);

  await bottom.getByRole('link', { name: 'Search' }).click();
  const search = page.getByRole('combobox', { name: 'Search or jump to' });
  await expect(search).toBeFocused();
  await search.fill('deal');
  await page.getByRole('option', { name: /#Deal room/ }).click();
  await expect(page.getByRole('heading', { exact: true, level: 3, name: 'Deal room' })).toBeVisible();

  await bottom.getByRole('button', { name: 'More' }).click();
  await expect(page.getByRole('link', { name: 'Threads' })).toBeVisible();
  await page.getByRole('link', { name: 'Threads' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Threads' })).toBeVisible();
  api.assertNoUnexpectedRequests();
});

test('a member who chose Odin Chat as their start page lands there when Odin opens (AC-N10)', async ({ page }) => {
  await signedInToChat(page, { preferences: { startPage: 'chat' } });
  await page.goto('/app/login');
  await page.getByLabel('Work email').fill('demo@example.com');
  await page.getByLabel('Password').fill('SyntheticPass123!');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app\/chat$/);
  await expect(sidebarOf(page)).toBeVisible();
  // Odin proper's Home stays reachable from there.
  const odin = page.getByTestId('chat-open-odin');
  if (await odin.isVisible()) await odin.click();
  else {
    await page.getByRole('navigation', { name: 'Chat' }).getByRole('button', { name: 'More' }).click();
    await page.getByRole('link', { name: 'Open Odin' }).click();
  }
  await expect(page).toHaveURL(/\/app\/$/);
  await expect(page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening), Synthetic$/ })).toBeVisible();
});

test('an @odin answer shows as Odin\u2019s in a channel opened in Odin Chat', async ({ page }) => {
  const api = await installSyntheticApi(page, { assistantChat: ODIN_CHAT });
  const channelsWorld = createChannelsWorld();
  channelsWorld.odin = { available: true };
  channelsWorld.posts.push(
    { authorId: 'user-pat', body: '@[Odin](odin:odin) where is the SOW?', createdAt: new Date(Date.UTC(2026, 10, 14, 9, 30)).toISOString(), id: 'post-ask-odin', odin: { status: 'replied' }, parentId: null, targetId: 'channel-general' },
    { authorId: 'reply-1', authorType: 'odin', body: 'The SOW is awaiting signature.', createdAt: new Date(Date.UTC(2026, 10, 14, 9, 31)).toISOString(), id: 'post-odin-answer', parentId: 'post-ask-odin', targetId: 'channel-general' },
  );
  await installChannelsApi(page, { world: channelsWorld });
  await installChatApi(page, { world: createChatWorld({ channelsWorld }) });
  await authenticateSyntheticUser(page);
  await page.goto(`chat/channels/${channelsWorld.projectId}/channel-general`);
  // The reply's own post (its thread's first post holds it too).
  const answer = page.getByRole('article', { name: /^Odin/ }).filter({ hasText: 'The SOW is awaiting signature.' });
  await expect(answer).toHaveCount(1);
  await expect(page.locator('nav.navbar')).toHaveCount(0, { timeout: 1000 });
  api.assertNoUnexpectedRequests();
});

for (const viewport of [{ height: 900, label: 'desktop', width: 1440 }, { height: 1024, label: 'iPad', width: 768 }, { height: 844, label: 'phone', width: 390 }]) {
  test(`a channel in Odin Chat fills the window, its box at the bottom, and opens on the newest message after diagrams draw (${viewport.label})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ height: viewport.height, width: viewport.width });
    const api = await installSyntheticApi(page, { assistantChat: ODIN_CHAT });
    const channelsWorld = createChannelsWorld();
    const at = (minute) => new Date(Date.UTC(2026, 10, 14, 9, minute)).toISOString();
    for (let index = 0; index < 12; index += 1) channelsWorld.posts.push({ authorId: 'user-pat', body: `Update ${index + 1}: notes for the workshop.`, createdAt: at(index), id: `post-${index}`, parentId: null, targetId: 'channel-general' });
    // The newest post holds a diagram, which grows the list after the first scroll to the end.
    channelsWorld.posts.push({ authorId: 'user-pat', body: 'The loop:\n\n```mermaid\nflowchart TD\n  A["Plan"] --> B["Build"]\n  B --> C["Test"]\n  C --> D["Release"]\n  D --> E["Operate"]\n```\n\nNewest line.', createdAt: at(30), id: 'post-newest', parentId: null, targetId: 'channel-general' });
    await installChannelsApi(page, { world: channelsWorld });
    await installChatApi(page, { world: createChatWorld({ channelsWorld }) });
    await authenticateSyntheticUser(page);
    await page.goto(`chat/channels/${channelsWorld.projectId}/channel-general`);

    const scroller = page.locator('.channel-conversation__scroller');
    await expect(scroller.locator('.assistant-visual--mermaid svg')).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('Newest line.')).toBeInViewport();
    await expect.poll(() => scroller.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(4);

    // The box sits at the bottom of the window (above the phone's bottom bar), with no page scroll.
    // The channel spans the pane's width.
    const pane = await page.locator('.chat-layout__main').boundingBox();
    const conversation = await page.locator('.channel-conversation').boundingBox();
    expect(pane.width - conversation.width).toBeLessThan(48);
    const box = await page.getByRole('textbox', { name: /^Message/ }).boundingBox();
    const bottomBar = await page.locator('.chat-layout__bottom').boundingBox();
    const floor = bottomBar?.height ? bottomBar.y : viewport.height;
    expect(floor - (box.y + box.height)).toBeLessThan(100);
    expect(await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBeLessThanOrEqual(1);
    // Focusing the box shows the formatting tools floating above it; nothing moves.
    const composer = page.getByRole('textbox', { name: /^Message/ });
    const sendBefore = await page.getByRole('button', { name: 'Send' }).boundingBox();
    await composer.click();
    const tools = page.getByRole('group', { name: 'Text formatting' });
    await expect(tools).toBeVisible();
    expect(Math.abs((await composer.boundingBox()).y - box.y)).toBeLessThanOrEqual(1);
    expect(Math.abs((await page.getByRole('button', { name: 'Send' }).boundingBox()).y - sendBefore.y)).toBeLessThanOrEqual(1);
    const toolsBox = await tools.boundingBox();
    expect(toolsBox.y + toolsBox.height).toBeLessThanOrEqual(box.y + 1);
    await page.screenshot({ path: testInfo.outputPath(`chat-fill-${viewport.label}.png`) });
    api.assertNoUnexpectedRequests();
  });
}
