import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

const API = `http://localhost:3001/api/projects/${syntheticProject.id}`;
const STATUSES = ['Not Started', 'In Progress', 'At Risk', 'Review', 'Completed'];
const COLUMNS = [
  { defaultStatus: 'Not Started', key: 'to-do', name: 'To do', statuses: ['Not Started'] },
  { defaultStatus: 'In Progress', key: 'doing', name: 'Doing', statuses: ['In Progress', 'At Risk'] },
  { defaultStatus: 'Review', key: 'review', name: 'Review', statuses: ['Review'] },
  { defaultStatus: 'Completed', key: 'done', name: 'Done', statuses: ['Completed'] },
];

// Stubs the board and the item create call. Creates are recorded so tests can count them,
// and an optional delay keeps the create in flight while the user keeps clicking.
async function installKanbanCreateApi(page, { createDelayMs = 0, createStatus = 200 } = {}) {
  const creates = [];
  const project = structuredClone(syntheticProject);
  let cards = [
    { boardColumn: null, epicId: 'epic-synthetic', id: 'story-synthetic', issueType: 'story', name: 'Release pilot', parentName: 'Delivery', sprintId: null, status: 'In Progress', storyId: 'story-synthetic' },
  ];

  const json = (route, body, status = 200) => route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status });

  await page.route(`${API}/kanban/config`, (route) => json(route, { config: { columns: COLUMNS, presets: [], swimlane: 'none' }, ok: true }));
  await page.route(
    (url) => url.pathname === `/api/projects/${syntheticProject.id}/kanban`,
    (route) => json(route, { board: { cards, columns: COLUMNS, members: [], sprints: [], swimlane: 'none' }, ok: true }),
  );
  await page.route(`${API}/items`, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = route.request().postDataJSON();
    creates.push(body);
    if (createDelayMs) await new Promise((resolve) => setTimeout(resolve, createDelayMs));
    if (createStatus !== 200) return json(route, { error: 'You do not have permission to edit this project plan.' }, createStatus);

    const item = { ...body.item, version: 1 };
    const epic = project.epics.find((entry) => entry.id === body.parentId);
    const story = project.epics.flatMap((entry) => entry.stories).find((entry) => entry.id === body.parentId);
    if (body.itemType === 'story') epic.stories.push({ ...item, tasks: [] });
    else story.tasks.push(item);
    cards = [...cards, {
      boardColumn: null,
      epicId: 'epic-synthetic',
      id: item.id,
      issueType: body.itemType,
      name: item.name,
      parentName: epic?.name ?? story?.name,
      sprintId: item.sprintId,
      status: item.status,
      storyId: body.itemType === 'task' ? body.parentId : item.id,
    }];
    return json(route, { item, ok: true, project }, 201);
  });

  return { creates };
}

async function openBoard(page, options) {
  const api = await installSyntheticApi(page);
  const kanban = await installKanbanCreateApi(page, options);
  await authenticateSyntheticUser(page);
  await page.goto(`projects/${syntheticProject.id}/kanban`);
  await expect(page.locator('[data-card-id="story-synthetic"]')).toBeVisible();
  return { api, kanban };
}

function dialog(page) {
  return page.getByRole('dialog', { name: 'New card' });
}

function cardsIn(page, columnKey) {
  return page.locator(`.kanban-column__cards[data-column-key="${columnKey}"] .kanban-card`);
}

test('new card defaults to Not Started and lands in that column', async ({ page }) => {
  const { api, kanban } = await openBoard(page);

  await page.getByRole('button', { name: 'New card' }).click();
  const modal = dialog(page);
  await expect(modal).toBeVisible();
  await expect(modal.getByLabel('Name')).toBeFocused();
  await expect(modal.getByLabel('Status')).toHaveValue('Not Started');
  await expect(modal.getByLabel('Status').locator('option')).toHaveText(STATUSES);
  // The synthetic project has one epic, so it is already chosen.
  await expect(modal.getByLabel('Epic')).toHaveValue('epic-synthetic');

  await modal.getByLabel('Name').fill('Write rollout notes');
  await modal.getByRole('button', { name: 'Create card' }).click();

  await expect(modal).toBeHidden();
  await expect(cardsIn(page, 'to-do').filter({ hasText: 'Write rollout notes' })).toBeVisible();
  await expect(page.getByText('"Write rollout notes" created in Not Started.')).toBeVisible();
  expect(kanban.creates).toHaveLength(1);
  expect(kanban.creates[0]).toMatchObject({ item: { name: 'Write rollout notes', status: 'Not Started' }, itemType: 'story', parentId: 'epic-synthetic' });
  api.assertNoUnexpectedRequests();
});

for (const [status, columnKey] of [['In Progress', 'doing'], ['At Risk', 'doing'], ['Review', 'review'], ['Completed', 'done']]) {
  test(`new card can start in ${status}`, async ({ page }) => {
    const { kanban } = await openBoard(page);

    await page.getByRole('button', { name: 'New card' }).click();
    const modal = dialog(page);
    await modal.getByLabel('Name').fill(`Card in ${status}`);
    await modal.getByLabel('Status').selectOption(status);
    await modal.getByRole('button', { name: 'Create card' }).click();

    await expect(modal).toBeHidden();
    await expect(cardsIn(page, columnKey).filter({ hasText: `Card in ${status}` })).toBeVisible();
    expect(kanban.creates.map((body) => body.item.status)).toEqual([status]);
  });
}

test('new task card hangs off the chosen story', async ({ page }) => {
  const { kanban } = await openBoard(page);

  await page.getByRole('button', { name: 'New card' }).click();
  const modal = dialog(page);
  await modal.getByLabel('Type').selectOption('task');
  await expect(modal.getByLabel('Story')).toHaveValue('story-synthetic');
  await modal.getByLabel('Name').fill('Check dashboards');
  await modal.getByLabel('Status').selectOption('Review');
  await modal.getByRole('button', { name: 'Create card' }).click();

  await expect(cardsIn(page, 'review').filter({ hasText: 'Check dashboards' })).toBeVisible();
  expect(kanban.creates[0]).toMatchObject({ item: { status: 'Review' }, itemType: 'task', parentId: 'story-synthetic' });
});

test('new card requires a name and sends nothing until it is valid', async ({ page }) => {
  const { kanban } = await openBoard(page);

  await page.getByRole('button', { name: 'New card' }).click();
  const modal = dialog(page);
  await modal.getByLabel('Name').fill('   ');
  await modal.getByRole('button', { name: 'Create card' }).click();

  await expect(modal.getByText('Enter a card name.')).toBeVisible();
  await expect(modal.getByLabel('Name')).toHaveAttribute('aria-invalid', 'true');
  const axe = await new AxeBuilder({ page }).include('[aria-labelledby="kanban-card-create-title"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(axe.violations).toEqual([]);
  await modal.getByLabel('Points').fill('-2');
  await expect(modal.getByText('Points must be a whole number from 0 to 999.')).toBeVisible();
  expect(kanban.creates).toHaveLength(0);

  await modal.getByLabel('Name').fill('Valid now');
  await modal.getByLabel('Points').fill('3');
  await expect(modal.getByText('Enter a card name.')).toBeHidden();
  await modal.getByRole('button', { name: 'Create card' }).click();
  await expect(modal).toBeHidden();
  expect(kanban.creates).toHaveLength(1);
  expect(kanban.creates[0].item.points).toBe(3);
});

test('cancel discards the draft and reopening starts fresh', async ({ page }) => {
  const { kanban } = await openBoard(page);

  await page.getByRole('button', { name: 'New card' }).click();
  let modal = dialog(page);
  await modal.getByLabel('Name').fill('Throwaway');
  await modal.getByLabel('Status').selectOption('Completed');
  await modal.getByRole('button', { name: 'Cancel' }).click();
  await expect(modal).toBeHidden();

  await page.getByRole('button', { name: 'New card' }).click();
  modal = dialog(page);
  await expect(modal.getByLabel('Name')).toHaveValue('');
  await expect(modal.getByLabel('Status')).toHaveValue('Not Started');
  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();

  expect(kanban.creates).toHaveLength(0);
  await expect(page.locator('.kanban-card').filter({ hasText: 'Throwaway' })).toHaveCount(0);
});

test('repeated submits create one card', async ({ page }) => {
  const { kanban } = await openBoard(page, { createDelayMs: 800 });

  await page.getByRole('button', { name: 'New card' }).click();
  const modal = dialog(page);
  await modal.getByLabel('Name').fill('Only once');
  const submit = modal.getByRole('button', { name: 'Create card' });
  await submit.click();
  await expect(modal.getByRole('button', { name: 'Creating...' })).toBeDisabled();
  await expect(modal.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  // Enter in the form and a forced click must not send a second create.
  await modal.getByLabel('Name').press('Enter', { timeout: 1000 }).catch(() => {});
  await modal.getByRole('button', { name: 'Creating...' }).click({ force: true });

  await expect(modal).toBeHidden({ timeout: 5000 });
  await expect(cardsIn(page, 'to-do').filter({ hasText: 'Only once' })).toHaveCount(1);
  expect(kanban.creates).toHaveLength(1);
});

test('a rejected create keeps the dialog open with the server message', async ({ page }) => {
  const { kanban } = await openBoard(page, { createStatus: 403 });

  await page.getByRole('button', { name: 'New card' }).click();
  const modal = dialog(page);
  await modal.getByLabel('Name').fill('Not allowed');
  await modal.getByRole('button', { name: 'Create card' }).click();

  await expect(modal.getByRole('alert')).toContainText('You do not have permission to edit this project plan.');
  await expect(modal.getByLabel('Name')).toHaveValue('Not allowed');
  await expect(modal.getByRole('button', { name: 'Create card' })).toBeEnabled();
  expect(kanban.creates).toHaveLength(1);
  await expect(page.locator('.kanban-card').filter({ hasText: 'Not allowed' })).toHaveCount(0);
});
