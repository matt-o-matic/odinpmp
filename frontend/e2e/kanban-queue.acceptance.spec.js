import { expect, test } from '@playwright/test';

import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

const API = `http://localhost:3001/api/projects/${syntheticProject.id}`;
const SAVE_DELAY_MS = 700;

const COLUMNS = [
  { defaultStatus: 'Not Started', key: 'to-do', name: 'To do', statuses: ['Not Started'] },
  { defaultStatus: 'In Progress', key: 'doing', name: 'Doing', statuses: ['In Progress'] },
];

function card(id, name, status, issueType = 'story') {
  return { boardColumn: null, epicId: 'epic-synthetic', id, issueType, name, parentName: 'Delivery', sprintId: null, status, storyId: issueType === 'task' ? 'story-synthetic' : id };
}

// Stubs the Kanban endpoints with slow writes, and records when each write starts and ends
// so the test can prove the board never sends two writes at once.
async function installSlowKanbanApi(page) {
  const writes = [];
  let inFlight = 0;
  let overlapped = false;
  let cards = [
    card('story-a', 'Alpha', 'In Progress'),
    card('story-b', 'Bravo', 'In Progress'),
    card('story-c', 'Charlie', 'In Progress'),
    card('task-synthetic', 'Validate rollout', 'Not Started', 'task'),
  ];

  // The first save waits for the test, so the second drop lands while it is still in flight,
  // however long a drag takes on the device.
  let releaseFirstSave;
  const firstSaveReleased = new Promise((resolve) => { releaseFirstSave = resolve; });

  async function slowWrite(label, apply) {
    const first = writes.length === 0;
    inFlight += 1;
    overlapped ||= inFlight > 1;
    writes.push(`start ${label}`);
    if (first) await firstSaveReleased;
    await new Promise((resolve) => setTimeout(resolve, SAVE_DELAY_MS));
    apply();
    writes.push(`end ${label}`);
    inFlight -= 1;
  }

  const json = (route, body) => route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status: 200 });

  await page.route(`${API}/kanban/config`, (route) => json(route, { config: { columns: COLUMNS, presets: [], swimlane: 'none' }, ok: true }));
  await page.route(
    (url) => url.pathname === `/api/projects/${syntheticProject.id}/kanban`,
    (route) => json(route, { board: { cards, columns: COLUMNS, members: [], sprints: [], swimlane: 'none' }, ok: true }),
  );
  await page.route(`${API}/kanban/reorder`, async (route) => {
    const { afterItemId, beforeItemId, itemId } = route.request().postDataJSON();
    await slowWrite(`reorder ${itemId}`, () => {
      const moved = cards.find((entry) => entry.id === itemId);
      const rest = cards.filter((entry) => entry.id !== itemId);
      const afterIndex = rest.findIndex((entry) => entry.id === afterItemId);
      const beforeIndex = rest.findIndex((entry) => entry.id === beforeItemId);
      const insertAt = afterIndex >= 0 ? afterIndex + 1 : beforeIndex >= 0 ? beforeIndex : rest.length;
      rest.splice(insertAt, 0, moved);
      cards = rest;
    });
    await json(route, { ok: true });
  });
  await page.route(`${API}/items/task-synthetic`, async (route) => {
    const { patch } = route.request().postDataJSON();
    await slowWrite('update task-synthetic', () => {
      cards = cards.map((entry) => (entry.id === 'task-synthetic' ? { ...entry, ...patch } : entry));
    });
    await json(route, { item: { id: 'task-synthetic', version: 2 }, ok: true, project: syntheticProject });
  });

  return {
    get overlapped() {
      return overlapped;
    },
    releaseFirstSave,
    writes,
  };
}

// On a touch screen a card moves by press, hold (TOUCH_REORDER_DELAY_MS) and drag.
async function touchDrag(page, source, target) {
  const session = await page.context().newCDPSession(page);
  await source.scrollIntoViewIfNeeded();
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  const point = (x, y) => ({ touchPoints: [{ x, y }] });
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', ...point(start.x, start.y) });
  await page.waitForTimeout(300);
  const end = { x: to.x + 20, y: to.y + 4 };
  for (let step = 1; step <= 10; step += 1) {
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', ...point(start.x + ((end.x - start.x) * step) / 10, start.y + ((end.y - start.y) * step) / 10) });
    await page.waitForTimeout(20);
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
}

async function dragCard(page, cardId, targetCardId) {
  const target = page.locator(`[data-card-id="${targetCardId}"]`);
  const source = page.locator(`[data-card-id="${cardId}"] .kanban-card__title`);
  if (test.info().project.name === 'chromium-mobile') await touchDrag(page, source, target);
  else await source.dragTo(target, { targetPosition: { x: 20, y: 4 } });
}

async function columnOrder(page, columnKey) {
  return page.locator(`.kanban-column__cards[data-column-key="${columnKey}"] .kanban-card`).evaluateAll(
    (elements) => elements.map((element) => element.getAttribute('data-card-id')),
  );
}

test('kanban drops update at once and save one at a time behind a working indicator', async ({ page }) => {
  const api = await installSyntheticApi(page);
  const kanban = await installSlowKanbanApi(page);
  await authenticateSyntheticUser(page);
  await page.goto(`projects/${syntheticProject.id}/kanban`);
  await expect(page.locator('[data-card-id="story-c"]')).toBeVisible();

  await dragCard(page, 'story-c', 'story-a');
  // A person's second drag starts after the first drop settles, well inside the first save.
  await page.waitForTimeout(250);
  await dragCard(page, 'task-synthetic', 'story-b');

  // Both moves show while the first save is still in flight and the second waits behind it.
  await expect.poll(() => columnOrder(page, 'doing'), { timeout: 1000 }).toEqual(['story-c', 'story-a', 'task-synthetic', 'story-b']);
  await expect(page.getByRole('status').filter({ hasText: /Saving \d changes?\.\.\./ })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Working...' })).toBeVisible();
  expect(kanban.writes).toEqual(['start reorder story-c']);
  kanban.releaseFirstSave();

  await expect(page.locator('.kanban-shell__saving')).toBeHidden({ timeout: 10_000 });
  await expect(page.getByRole('status').filter({ hasText: 'Working...' })).toBeHidden();
  await expect.poll(() => columnOrder(page, 'doing')).toEqual(['story-c', 'story-a', 'task-synthetic', 'story-b']);

  expect(kanban.overlapped, `writes overlapped: ${kanban.writes.join(', ')}`).toBe(false);
  expect(kanban.writes).toEqual([
    'start reorder story-c',
    'end reorder story-c',
    'start update task-synthetic',
    'end update task-synthetic',
    'start reorder task-synthetic',
    'end reorder task-synthetic',
  ]);
  api.assertNoUnexpectedRequests();
});
