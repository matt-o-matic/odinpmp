import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { settleForAxe } from './fixtures/axe-settle.js';
import { createChannelsWorld, installChannelsApi } from './fixtures/channels-api.js';
import { createChatWorld, installChatApi } from './fixtures/chat-api.js';
import { installPursuitApi } from './fixtures/pursuit-api.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

// The Tasks tab of a channel in Odin Chat: a delivery project's
// stories and tasks, or an engagement's pursuit tasks, as a board or a list beside the
// conversation. Quick add, moving a card, the Mine filter, read-only members, the phone's list and
// Ask Odin. The project's board API is mocked here; the pursuit board is fixtures/pursuit-api.js.

const API_ORIGIN = 'http://localhost:3001';
const PROJECT = syntheticProject.id;
const COLUMNS = ['Not Started', 'In Progress', 'Review', 'Completed'].map((status) => ({ defaultStatus: status, key: status.toLowerCase().replace(/\s+/g, '-'), name: status, statuses: [status] }));

const json = (route, body, status = 200) => route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status });

async function expectNoSeriousAxe(page) {
  await settleForAxe(page);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).include('.chat-tasks').analyze();
  expect(results.violations.filter(({ impact }) => ['critical', 'serious'].includes(impact)).map(({ id, nodes }) => `${id}: ${nodes.map((node) => node.target.join(' ')).join(', ')}`)).toEqual([]);
}

// The delivery project's board: one epic with a story and two tasks, the person's own task among them.
async function installDeliveryBoard(page, { canEditPlan = true, empty = false } = {}) {
  const calls = [];
  const epics = [];
  const stories = [{ assigneeId: 'user-pat', assigneeName: 'Pat Seller', id: 'story-synthetic', name: 'Release pilot', priority: 2, status: 'In Progress', targetEndDate: '2026-08-20', version: 2 }];
  const tasks = [
    { assigneeId: 'user-synthetic', assigneeName: 'Synthetic Demo', id: 'task-synthetic', name: 'Validate rollout', priority: 4, status: 'Not Started', targetEndDate: null, version: 1 },
    { assigneeId: 'user-synthetic', assigneeName: 'Synthetic Demo', id: 'task-done', name: 'Kick-off notes', priority: 4, status: 'Completed', targetEndDate: null, version: 1 },
  ];
  if (empty) { stories.length = 0; tasks.length = 0; }
  const project = () => ({ ...syntheticProject, epics: empty ? epics : [{ id: 'epic-synthetic', name: 'Delivery', status: 'In Progress', stories: stories.map((story) => ({ ...story, tasks: structuredClone(tasks) })), version: 1 }] });
  const cards = () => [
    ...stories.map((story) => ({ ...story, epicId: 'epic-synthetic', epicName: 'Delivery', issueType: 'story', parentId: 'epic-synthetic', sprintId: null })),
    ...tasks.map((task) => ({ ...task, epicId: 'epic-synthetic', epicName: 'Delivery', issueType: 'task', parentId: 'story-synthetic', sprintId: null })),
  ];
  await page.route(`${API_ORIGIN}/api/projects/${PROJECT}**`, async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const action = url.pathname.slice(`/api/projects/${PROJECT}`.length);
    if (method === 'GET' && action === '') return json(route, { ok: true, permissions: { canDelete: false, canEditPlan, canManage: canEditPlan }, project: project() });
    if (method === 'GET' && action === '/kanban/config') return json(route, { config: { columns: COLUMNS, swimlane: 'none' }, ok: true });
    if (method === 'GET' && action === '/kanban') return json(route, { board: { cards: cards(), columns: COLUMNS, members: [], sprints: [], swimlane: 'none' }, ok: true });
    if (method === 'POST' && action === '/items') {
      const body = request.postDataJSON();
      calls.push({ body, method, path: url.pathname });
      if (body.itemType === 'epic') {
        const epic = { ...body.item, id: 'epic-backlog', stories: [], version: 1 };
        epics.push(epic);
        return json(route, { item: epic, ok: true, project: project() }, 201);
      }
      stories.push({ ...body.item, version: 1 });
      return json(route, { item: { ...body.item, version: 1 }, ok: true, project: project() }, 201);
    }
    const item = /^\/items\/([^/]+)$/.exec(action);
    if (method === 'PATCH' && item) {
      const body = request.postDataJSON();
      calls.push({ body, method, path: url.pathname });
      const target = [...stories, ...tasks].find((entry) => entry.id === item[1]);
      if (body.expectedVersion !== target.version) return json(route, { details: { code: 'project_item_version_conflict' }, error: 'Conflict', ok: false }, 409);
      Object.assign(target, body.patch, { version: target.version + 1 });
      return json(route, { item: target, ok: true, project: project() });
    }
    return route.fallback();
  });
  return { calls };
}

async function signedIn(page, { projectKind = 'delivery' } = {}) {
  const api = await installSyntheticApi(page);
  const channelsWorld = createChannelsWorld();
  channelsWorld.odin = { available: true };
  await installChannelsApi(page, { world: channelsWorld });
  await installChatApi(page, { world: createChatWorld({ channelsWorld, projectKind }) });
  return { api, channelsWorld };
}

const tasksTab = (page) => page.getByRole('navigation', { name: 'General sections' }).getByRole('button', { exact: true, name: 'Tasks' });

test('a delivery project\'s open work shows as a board in a channel\'s Tasks tab; quick add, moving a card and Mine work', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'chromium-mobile', 'The phone has its own test below.');
  const { api } = await signedIn(page);
  const board = await installDeliveryBoard(page);
  await authenticateSyntheticUser(page);
  await page.goto(`chat/channels/${PROJECT}/channel-general`);
  await tasksTab(page).click();
  await expect(page).toHaveURL(/tab=tasks/);

  const tasks = page.locator('.chat-tasks');
  await expect(tasks.locator('.chat-tasks__column-head')).toHaveText([/Not Started\s*1/, /In Progress\s*1/, /Review\s*0/, /Completed\s*0/]);
  const story = tasks.locator('.chat-tasks__card').filter({ hasText: 'Release pilot' });
  await expect(story).toContainText('Story');
  await expect(story).toContainText('P2');
  await expect(story).toContainText('2026-08-20');
  await expect(story.getByLabel('Assigned to Pat Seller')).toHaveText('PS');
  await expect(story.getByRole('link', { name: 'Release pilot' })).toHaveAttribute('href', `/app/projects/${PROJECT}?item=story-synthetic`);
  // Done work shows under All only.
  await expect(tasks.getByRole('link', { name: 'Kick-off notes' })).toHaveCount(0);
  await tasks.getByRole('button', { exact: true, name: 'All' }).click();
  await expect(tasks.getByRole('link', { name: 'Kick-off notes' })).toBeVisible();
  await tasks.getByRole('button', { exact: true, name: 'Mine' }).click();
  await expect(page).toHaveURL(/tasks=mine/);
  await expect(tasks.locator('.chat-tasks__card')).toHaveText([/Validate rollout/]);
  await tasks.getByRole('button', { exact: true, name: 'Open' }).click();

  // Quick add: a story under the project's one epic, in the first column.
  await tasks.getByRole('textbox', { name: 'New story' }).fill('Plan the cutover');
  await page.keyboard.press('Enter');
  await expect(tasks.locator('.chat-tasks__card').filter({ hasText: 'Plan the cutover' })).toBeVisible();
  const created = board.calls.find((call) => call.method === 'POST');
  expect(created.body).toMatchObject({ item: { name: 'Plan the cutover', status: 'Not Started' }, itemType: 'story', parentId: 'epic-synthetic' });
  await expect(tasks.getByRole('textbox', { name: 'New story' })).toHaveValue('');

  // Moving a card changes its status, with the version the project tree holds.
  await tasks.getByLabel('Column for Validate rollout').selectOption({ label: 'In Progress' });
  await expect(tasks.locator('.chat-tasks__column').filter({ hasText: /^In Progress/ })).toContainText('Validate rollout');
  const moved = board.calls.find((call) => call.method === 'PATCH');
  expect(moved.path).toBe(`/api/projects/${PROJECT}/items/task-synthetic`);
  expect(moved.body).toMatchObject({ expectedVersion: 1, patch: { status: 'In Progress' } });

  if (testInfo.project.name === 'chromium-desktop') await page.screenshot({ path: testInfo.outputPath('chat-tasks-board.png') });
  await expectNoSeriousAxe(page);
  api.assertNoUnexpectedRequests();
});

test('on a project with no epic yet, the first quick add starts a Backlog epic and adds the story to it', async ({ page }) => {
  const { api } = await signedIn(page);
  const board = await installDeliveryBoard(page, { empty: true });
  await authenticateSyntheticUser(page);
  await page.goto(`chat/channels/${PROJECT}/channel-general?tab=tasks`);
  await expect(page.getByText('The first one starts a "Backlog" epic in the project plan.')).toBeVisible();
  await page.getByRole('textbox', { name: 'New story' }).fill('Draft the cutover plan');
  await page.keyboard.press('Enter');
  await expect.poll(() => board.calls.filter((call) => call.method === 'POST').length).toBe(2);
  const [epic, story] = board.calls.filter((call) => call.method === 'POST');
  expect(epic.body).toMatchObject({ item: { name: 'Backlog' }, itemType: 'epic', parentId: null });
  expect(story.body).toMatchObject({ item: { name: 'Draft the cutover plan' }, itemType: 'story', parentId: 'epic-backlog' });
  api.assertNoUnexpectedRequests();
});

test('Ask Odin from the Tasks tab starts a message to Odin in the conversation', async ({ page }) => {
  const { api } = await signedIn(page);
  await installDeliveryBoard(page);
  await authenticateSyntheticUser(page);
  await page.goto(`chat/channels/${PROJECT}/channel-general?tab=tasks`);
  await page.locator('.chat-tasks').getByRole('button', { name: 'Ask Odin' }).click();
  await expect(page).not.toHaveURL(/tab=tasks/);
  const composer = page.getByRole('textbox', { name: 'Message General' });
  await expect(composer.locator('.mention')).toHaveText('@Odin');
  await expect(composer).toContainText('add a task:');
  await expect(composer).toBeFocused();
  api.assertNoUnexpectedRequests();
});

test('a member who can\'t plan sees the board read-only', async ({ page }) => {
  const { api } = await signedIn(page);
  await installDeliveryBoard(page, { canEditPlan: false });
  await authenticateSyntheticUser(page);
  await page.goto(`chat/channels/${PROJECT}/channel-general?tab=tasks`);
  const tasks = page.locator('.chat-tasks');
  await expect(tasks.getByText('Release pilot')).toBeVisible();
  await expect(tasks.getByRole('textbox', { name: /^New/ })).toHaveCount(0);
  await expect(tasks.getByRole('combobox')).toHaveCount(0);
  api.assertNoUnexpectedRequests();
});

test('an engagement\'s Tasks tab shows its pursuit tasks, and quick add adds one to the pursuit board', async ({ page }) => {
  const { api } = await signedIn(page, { projectKind: 'engagement' });
  const pursuit = await installPursuitApi(page, { projectId: PROJECT });
  await authenticateSyntheticUser(page);
  await page.goto(`chat/channels/${PROJECT}/channel-general?tab=tasks&view=list`);
  const tasks = page.locator('.chat-tasks');
  await expect(tasks.locator('.chat-tasks__row')).toHaveCount(2);
  await expect(tasks.locator('.chat-tasks__row').filter({ hasText: 'Network diagrams' })).toContainText('(late)');
  await expect(tasks.getByRole('link', { name: 'Kickoff deck' })).toHaveAttribute('href', `/app/engagements/${PROJECT}/board`);
  await tasks.getByRole('textbox', { name: 'New task' }).fill('Confirm the venue');
  await tasks.getByRole('button', { exact: true, name: 'Add' }).click();
  await expect(tasks.locator('.chat-tasks__row').filter({ hasText: 'Confirm the venue' })).toBeVisible();
  const created = pursuit.calls.find((call) => call.method === 'POST' && call.path.endsWith('/items'));
  expect(created.body).toMatchObject({ item: { name: 'Confirm the venue' }, itemType: 'task', parentId: 'story-pursuit' });
  await expectNoSeriousAxe(page);
  api.assertNoUnexpectedRequests();
});

test('on a phone the Tasks tab opens as a list', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-mobile', 'Phone layout only.');
  const { api } = await signedIn(page);
  await installDeliveryBoard(page);
  await authenticateSyntheticUser(page);
  await page.goto(`chat/channels/${PROJECT}/channel-general?tab=tasks`);
  const tasks = page.locator('.chat-tasks');
  await expect(tasks.locator('.chat-tasks__list')).toBeVisible();
  await expect(tasks.locator('.chat-tasks__board')).toHaveCount(0);
  await expect(tasks.locator('.chat-tasks__row')).toHaveCount(2);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: testInfo.outputPath('chat-tasks-phone.png') });
  await expectNoSeriousAxe(page);
  api.assertNoUnexpectedRequests();
});

test('the project\'s own Channels tab keeps Conversation and Files only', async ({ page }) => {
  const { api } = await signedIn(page);
  await authenticateSyntheticUser(page);
  await page.goto(`projects/${PROJECT}/channels?channel=channel-general&tab=tasks`);
  const sections = page.getByRole('navigation', { name: 'General sections' });
  await expect(sections.getByRole('button')).toHaveText(['Conversation', 'Files']);
  await expect(page.getByRole('textbox', { name: 'Message General' })).toBeVisible();
  api.assertNoUnexpectedRequests();
});
