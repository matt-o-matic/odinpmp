import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { settleForAxe } from './fixtures/axe-settle.js';
import { installEngagementsApi } from './fixtures/engagements-api.js';
import { installPursuitApi } from './fixtures/pursuit-api.js';
import { authenticateSyntheticUser, installSyntheticApi, openTopMenu } from './fixtures/synthetic-api.js';

// The pursuit board, the Convert option for pursuit tasks, the board and Odin settings, and the
// engagement Insights tab.

const API_ORIGIN = 'http://localhost:3001';

async function expectNoSeriousAxe(page) {
  await settleForAxe(page);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).include('#main-content').analyze();
  expect(results.violations.filter(({ impact }) => ['critical', 'serious'].includes(impact))).toEqual([]);
}

async function openEngagement(page, options = {}) {
  await installSyntheticApi(page);
  const engagements = await installEngagementsApi(page);
  const pursuit = await installPursuitApi(page, options);
  await authenticateSyntheticUser(page);
  return { engagements, pursuit };
}

// Holds the engagement's event stream until `release()`, then sends one change made elsewhere.
async function holdChangeEvent(page, projectId) {
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  let delivered = false;
  const event = { actor: { id: 'user-pat', name: 'Pat Seller' }, originClientId: 'tab-elsewhere', projectId, type: 'project.assets.invalidated' };
  await page.route(`${API_ORIGIN}/api/projects/${projectId}/events`, async (route) => {
    if (delivered) return route.fulfill({ body: '', contentType: 'text/event-stream', status: 200 });
    await released;
    try {
      await route.fulfill({ body: `event: connected\ndata: {}\n\nevent: project.assets.invalidated\ndata: ${JSON.stringify(event)}\n\n`, contentType: 'text/event-stream', status: 200 });
      delivered = true;
    } catch {
      // The page closed while the stream was held.
    }
  });
  return () => release();
}

test('members see the pursuit tasks on the engagement Board, add one for a person without a login, and change one', async ({ page }, testInfo) => {
  const { pursuit } = await openEngagement(page);
  await page.goto('engagements/eng-northwind/board');
  const sections = page.getByRole('navigation', { name: 'Engagement sections' });
  await expect(sections.getByRole('link')).toHaveText(['Channels', 'Board', 'Insights', 'Files', 'People', 'Settings']);
  await expect(sections.getByRole('link', { name: 'Board' })).toHaveAttribute('aria-current', 'page');

  const board = page.getByRole('region', { name: 'Pursuit board' });
  for (const name of ['Kickoff deck', 'Network diagrams', 'Pricing model']) await expect(board.getByRole('button', { name, exact: true })).toBeVisible();
  await expect(board.locator('.kanban-card').filter({ hasText: 'Network diagrams' })).toContainText('Casey Contractor');
  await expect(board.getByText('Pursuit tasks')).toHaveCount(0);
  expect(pursuit.calls.find((call) => call.path.includes('/kanban'))?.path).toContain('scope=pursuit');
  await expectNoSeriousAxe(page);
  await page.screenshot({ fullPage: true, path: testInfo.outputPath('pursuit-board.png') });

  await board.getByRole('button', { name: 'New task' }).click();
  const create = page.getByRole('dialog', { name: 'New task' });
  await expect(create.getByLabel('Type')).toHaveCount(0);
  await expect(create.getByLabel('Sprint')).toHaveCount(0);
  await create.getByLabel('Name').fill('Send the licence list');
  // The engagement's guests are offered too, as `stakeholder:<id>`.
  await expect(create.getByLabel('Assignee').locator('option', { hasText: 'Gina Guest (guest)' })).toHaveAttribute('value', 'stakeholder:sh-gina');
  await create.getByLabel('Assignee').selectOption({ label: 'Casey Contractor (no login)' });
  await create.getByLabel('Due date').fill('2026-12-04');
  await create.getByRole('button', { name: 'Create task' }).click();
  await expect(create).toHaveCount(0);
  const created = pursuit.calls.find((call) => call.method === 'POST' && call.path.endsWith('/items'));
  expect([created.body.itemType, created.body.parentId, created.body.item.name, created.body.item.assigneeId, created.body.item.targetEndDate]).toEqual(['task', 'story-pursuit', 'Send the licence list', 'resource:res-casey', '2026-12-04']);

  await board.getByRole('button', { name: 'Network diagrams', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Network diagrams' });
  await expect(drawer.getByLabel('Name')).toHaveValue('Network diagrams');
  await expect(drawer.getByRole('region', { name: 'Comments' })).toBeVisible();
  await expect(drawer.getByRole('region', { name: 'Attachments' })).toBeVisible();
  await drawer.getByLabel('Status').selectOption('In Progress');
  await drawer.getByRole('button', { name: 'Save' }).click();
  await expect(drawer).toHaveCount(0);
  const saved = pursuit.calls.find((call) => call.method === 'PATCH');
  expect(saved).toEqual({ body: { expectedVersion: 1, patch: { status: 'In Progress' } }, method: 'PATCH', path: '/api/projects/eng-northwind/items/task-diagrams' });
  await expect(page.getByRole('status').filter({ hasText: 'Task saved.' })).toBeVisible();
});

test('the Convert dialog leaves pursuit tasks on the Pursuit tab unless asked, and Settings holds the board switch', async ({ page }, testInfo) => {
  const { engagements, pursuit } = await openEngagement(page);
  await page.goto('engagements/eng-northwind/settings');

  const guests = page.getByRole('switch', { name: 'Guests see the whole board' });
  await expect(guests).not.toBeChecked();
  // Odin's switch is each channel's, in Channel settings (odin-channels.acceptance.spec.js).
  await expect(page.getByRole('switch', { name: 'Let Odin answer when tagged' })).toHaveCount(0);
  await guests.check();
  await expect(guests).toBeChecked();
  expect(pursuit.calls.at(-1)).toEqual({ body: { expectedVersion: 0, guestsSeeBoard: true }, method: 'PUT', path: '/api/projects/eng-northwind/settings' });
  expect(pursuit.settings.version).toBe(1);

  await page.getByRole('button', { name: 'Convert to project' }).click();
  const convert = page.getByRole('dialog', { name: 'Convert to project' });
  const move = convert.getByRole('checkbox', { name: 'Move open pursuit tasks to the project board' });
  await expect(move).not.toBeChecked();
  await expectNoSeriousAxe(page);
  await move.check();
  await page.screenshot({ path: testInfo.outputPath('convert-dialog.png') });
  await convert.getByRole('button', { name: 'Convert' }).click();
  await expect(page).toHaveURL(/\/app\/projects\/eng-northwind$/);
  expect(engagements.calls.at(-1)).toEqual({ body: { moveOpenPursuitTasks: true, templateId: null }, method: 'POST', path: '/api/projects/eng-northwind/convert' });
});

test('the engagement Insights tab shows the SOW, tasks, activity, people and age, and refreshes when someone else changes the engagement', async ({ page }, testInfo) => {
  const { pursuit } = await openEngagement(page);
  const release = await holdChangeEvent(page, 'eng-northwind');
  await page.goto('engagements/eng-northwind/insights');
  const insights = page.getByRole('region', { name: 'Insights' });
  await expect(insights.getByRole('heading', { level: 2, name: 'Insights' })).toBeVisible();

  const sow = insights.getByRole('article', { name: 'SOW' });
  await expect(sow.getByRole('link', { name: /Northwind data platform SOW/ })).toHaveAttribute('href', 'https://invoice.example/sows/41');
  await expect(sow.locator('[aria-current="step"]')).toContainText('Awaiting signature');
  const tasks = insights.getByRole('article', { name: 'Tasks' });
  await expect(tasks.getByRole('definition').nth(0)).toHaveText('2');
  await expect(tasks.getByRole('definition').nth(1)).toHaveText('1');
  await expect(tasks.getByRole('definition').nth(2)).toHaveText('1');
  await expect(tasks.getByRole('listitem').filter({ hasText: 'Kickoff deck' })).toBeVisible();
  await expect(insights.getByRole('article', { name: 'Activity' }).getByRole('img')).toBeVisible();
  await expect(insights.getByRole('article', { name: 'People' })).toContainText('Pat Seller');
  await expect(insights.getByRole('article', { name: 'Age' })).toContainText('13 days');
  await expectNoSeriousAxe(page);
  await page.screenshot({ fullPage: true, path: testInfo.outputPath('pursuit-insights.png') });

  // The table view gives the same numbers without the drawing.
  await tasks.getByRole('button', { name: 'Show Tasks as a table' }).click();
  await expect(tasks.getByRole('table')).toContainText('2026-11-14');

  const loads = pursuit.insightsLoads;
  release();
  await expect.poll(() => pursuit.insightsLoads).toBeGreaterThan(loads);
});

test('without a linked SOW the SOW card says so', async ({ page }) => {
  await openEngagement(page, { sowLinked: false });
  await page.goto('engagements/eng-northwind/insights');
  await expect(page.getByRole('article', { name: 'SOW' })).toContainText('No SOW is linked to this engagement.');
});

test('an engagement opened from the Work menu keeps its Channels, Board and Insights tabs', async ({ page }) => {
  await openEngagement(page);
  await page.goto('projects');
  const work = await openTopMenu(page, 'Work');
  await work.getByRole('link', { name: 'Engagements' }).click();
  await expect(page).toHaveURL(/\/app\/engagements/);
  await page.getByRole('link', { name: 'Northwind data platform' }).first().click();
  const sections = page.getByRole('navigation', { name: 'Engagement sections' });
  await expect(sections.getByRole('link')).toHaveText(['Channels', 'Board', 'Insights', 'Files', 'People', 'Settings']);
  await sections.getByRole('link', { name: 'Board' }).click();
  await expect(page.getByRole('region', { name: 'Pursuit board' }).getByRole('button', { name: 'Kickoff deck', exact: true })).toBeVisible();
  await sections.getByRole('link', { name: 'Insights' }).click();
  await expect(page).toHaveURL(/\/engagements\/eng-northwind\/insights$/);
  await expect(page.getByRole('heading', { name: 'SOW' })).toBeVisible();
});
