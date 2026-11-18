import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { settleForAxe } from './fixtures/axe-settle.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

const API = 'http://localhost:3001/api/projects';
const PROJECT_API = `${API}/${syntheticProject.id}`;
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];

function ticket(id, name, overrides = {}) {
  return {
    category: 'defect', externalReviewState: 'not_external', id, name, priority: 3, projectId: syntheticProject.id,
    projectName: syntheticProject.name, severity: 'S2', status: 'new', updatedAt: '2026-07-14T00:00:00.000Z', version: 1, ...overrides,
  };
}

const tickets = [
  ticket('ticket-checkout', 'Checkout fails on retry'),
  ticket('ticket-retry', 'Retry button does nothing', { status: 'open' }),
];
const project = { ...structuredClone(syntheticProject), tickets: tickets.map(({ projectId: _p, projectName: _n, ...entry }) => entry) };

function itemIndex() {
  const index = new Map();
  for (const epic of project.epics) {
    index.set(epic.id, { id: epic.id, itemType: 'epic', name: epic.name, status: epic.status });
    for (const story of epic.stories) {
      index.set(story.id, { epicId: epic.id, id: story.id, itemType: 'story', name: story.name, status: story.status });
      for (const task of story.tasks) index.set(task.id, { epicId: epic.id, id: task.id, itemType: 'task', name: task.name, status: task.status, storyId: story.id });
    }
  }
  for (const entry of project.tickets) index.set(entry.id, { id: entry.id, itemType: 'ticket', name: entry.name, status: entry.status });
  return index;
}

// A small stand-in for the relation routes: same directional storage, described lists, idempotent create.
async function installRelationsApi(page, { canEdit = true, relations = [] } = {}) {
  const stored = structuredClone(relations);
  const writes = [];
  await page.route(`${API}/tickets*`, (route) => route.fulfill({ json: { nextCursor: null, tickets, total: tickets.length } }));
  await page.route(`${API}/ticket-review-queue*`, (route) => route.fulfill({ json: { tickets: [] } }));
  await page.route(PROJECT_API, (route) => (route.request().method() === 'GET' ? route.fulfill({ json: { project } }) : route.fallback()));
  await page.route(new RegExp(`/api/projects/${syntheticProject.id}/items/[^/]+/relations$`), async (route) => {
    const request = route.request();
    const itemId = new URL(request.url()).pathname.split('/').at(-2);
    if (request.method() === 'POST') {
      const { relationType, toItemId } = request.postDataJSON();
      writes.push(['POST', itemId, relationType, toItemId]);
      let relation = stored.find((entry) => entry.fromItemId === itemId && entry.toItemId === toItemId && entry.relationType === relationType);
      if (!relation) {
        relation = { fromItemId: itemId, id: `relation-${stored.length + 1}`, relationType, toItemId };
        stored.push(relation);
      }
      return route.fulfill({ json: { ok: true, relation }, status: 201 });
    }
    const index = itemIndex();
    const described = stored
      .filter((entry) => entry.fromItemId === itemId || entry.toItemId === itemId)
      .map((entry) => {
        const direction = entry.fromItemId === itemId ? 'outgoing' : 'incoming';
        const related = index.get(direction === 'outgoing' ? entry.toItemId : entry.fromItemId);
        return { ...entry, direction, relatedItem: { ...related, available: true } };
      });
    return route.fulfill({ json: { canEdit, ok: true, relations: described } });
  });
  await page.route(new RegExp(`/api/projects/${syntheticProject.id}/relations/[^/]+$`), (route) => {
    const relationId = new URL(route.request().url()).pathname.split('/').at(-1);
    writes.push(['DELETE', relationId]);
    stored.splice(stored.findIndex((entry) => entry.id === relationId), 1);
    return route.fulfill({ json: { ok: true } });
  });
  return { stored, writes };
}

async function expectNoAxeViolations(page, selector, testInfo, name) {
  await settleForAxe(page);
  const results = await new AxeBuilder({ page }).include(selector).withTags(WCAG).analyze();
  await testInfo.attach(`axe-${name}.json`, { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' });
  expect(results.violations).toEqual([]);
}

async function openOutline(page) {
  const structureNavigator = page.getByRole('button', { name: 'Open structure navigator' });
  if (await structureNavigator.isVisible()) await structureNavigator.click();
}

test.describe('item relations', () => {
  test('a ticket lists related work by label, adds a relation to a story and removes it', async ({ page }, testInfo) => {
    const api = await installSyntheticApi(page);
    const relationsApi = await installRelationsApi(page, {
      relations: [{ fromItemId: 'ticket-retry', id: 'relation-existing', relationType: 'duplicate_of', toItemId: 'ticket-checkout' }],
    });
    await authenticateSyntheticUser(page);
    await page.goto('tickets');

    await page.getByRole('button', { name: /Checkout fails on retry/ }).first().click();
    const detail = page.locator('dialog.ticket-dialog');
    const relations = detail.locator('.item-relations');
    await expect(relations.getByRole('heading', { name: 'Related work' })).toBeVisible();
    await expect(relations.getByRole('heading', { name: 'Duplicated by' })).toBeVisible();
    await expect(relations.getByRole('link', { name: 'Retry button does nothing' })).toBeVisible();
    await expect(relations).toContainText('Ticket');
    await expect(relations).not.toContainText('ticket-retry');

    await relations.getByRole('button', { name: 'Add relation' }).click();
    const dialog = page.locator('dialog.rq-dialog[open]');
    await expect(dialog.getByRole('heading', { name: 'Add relation' })).toBeVisible();
    await dialog.getByLabel('This item').selectOption({ label: 'is caused by' });
    await dialog.getByLabel('Find the related item').fill('release');
    await expect(dialog.getByRole('radio')).toHaveCount(1);
    await dialog.getByRole('radio', { name: /Release pilot/ }).check();
    await expectNoAxeViolations(page, 'dialog.rq-dialog[open]', testInfo, 'add-relation-dialog');
    await page.screenshot({ path: testInfo.outputPath('add-relation-dialog.png') });
    await dialog.getByRole('button', { name: 'Add relation' }).click();

    await expect(dialog).toHaveCount(0);
    await expect(relations.getByRole('heading', { name: 'Caused by' })).toBeVisible();
    await expect(relations.getByRole('link', { name: 'Release pilot' })).toHaveAttribute('href', /projects\/project-synthetic\?item=story-synthetic/);
    expect(relationsApi.writes).toContainEqual(['POST', 'ticket-checkout', 'caused_by', 'story-synthetic']);
    await expectNoAxeViolations(page, 'dialog.ticket-dialog', testInfo, 'ticket-relations');
    await page.screenshot({ path: testInfo.outputPath('ticket-relations.png') });

    await relations.getByRole('button', { name: 'Remove relation: Caused by Release pilot' }).click();
    const confirm = page.locator('dialog.rq-dialog[open]');
    await expect(confirm.getByRole('heading', { name: 'Remove relation?' })).toBeVisible();
    await confirm.getByRole('button', { name: 'Remove relation' }).click();
    await expect(relations.getByRole('heading', { name: 'Caused by' })).toHaveCount(0);
    await expect(relations.getByRole('link', { name: 'Retry button does nothing' })).toBeVisible();

    // A related ticket opens in place.
    await relations.getByRole('link', { name: 'Retry button does nothing' }).click();
    await expect(detail.getByRole('heading', { name: 'Retry button does nothing', level: 2 })).toBeVisible();
    await expect(detail.locator('.item-relations').getByRole('heading', { name: 'Duplicate of' })).toBeVisible();
    api.assertNoUnexpectedRequests();
  });

  test('a story links a blocking task, the link opens the task, and the task removes it', async ({ page }, testInfo) => {
    const api = await installSyntheticApi(page);
    const relationsApi = await installRelationsApi(page);
    await authenticateSyntheticUser(page);
    await page.goto(`projects/${syntheticProject.id}`);
    await expect(page.locator('button.outline-row--project')).toBeAttached();
    await openOutline(page);
    await page.locator('button.outline-row--story').filter({ hasText: 'Release pilot' }).click();

    const relations = page.locator('.workbench-pane--editor .item-relations');
    await expect(relations.getByText('No related work yet.')).toBeVisible();
    await relations.getByRole('button', { name: 'Add relation' }).click();
    const dialog = page.locator('dialog.rq-dialog[open]');
    await expect(dialog.getByText('Linking “Release pilot” to another item in this project.')).toBeVisible();
    await dialog.getByLabel('Find the related item').fill('validate');
    await dialog.getByRole('radio', { name: /Validate rollout/ }).check();
    await dialog.getByRole('button', { name: 'Add relation' }).click();

    await expect(relations.getByRole('heading', { name: 'Blocks' })).toBeVisible();
    expect(relationsApi.writes).toContainEqual(['POST', 'story-synthetic', 'blocks', 'task-synthetic']);
    await expectNoAxeViolations(page, '.workbench-pane--editor .item-relations', testInfo, 'story-relations');
    await relations.screenshot({ path: testInfo.outputPath('story-relations.png') });
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await expectNoAxeViolations(page, '.workbench-pane--editor .item-relations', testInfo, 'story-relations-dark');
    await relations.screenshot({ path: testInfo.outputPath('story-relations-dark.png') });
    await page.evaluate(() => document.documentElement.classList.remove('dark'));

    await relations.getByRole('link', { name: 'Validate rollout' }).click();
    await expect(page.locator('.workbench-editor__title')).toHaveText('Validate rollout');
    await expect(page).not.toHaveURL(/item=/);
    const taskRelations = page.locator('.workbench-pane--editor .item-relations');
    await expect(taskRelations.getByRole('heading', { name: 'Blocked by' })).toBeVisible();
    await taskRelations.getByRole('button', { name: 'Remove relation: Blocked by Release pilot' }).click();
    await page.locator('dialog.rq-dialog[open]').getByRole('button', { name: 'Remove relation' }).click();
    await expect(taskRelations.getByText('No related work yet.')).toBeVisible();
    expect(relationsApi.stored).toEqual([]);
    api.assertNoUnexpectedRequests();
  });

  test('readers without plan-edit rights see relations but no add or remove controls', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await installRelationsApi(page, {
      canEdit: false,
      relations: [{ fromItemId: 'story-synthetic', id: 'relation-1', relationType: 'affects', toItemId: 'epic-synthetic' }],
    });
    await authenticateSyntheticUser(page);
    await page.goto(`projects/${syntheticProject.id}`);
    await openOutline(page);
    await page.locator('button.outline-row--story').filter({ hasText: 'Release pilot' }).click();
    const relations = page.locator('.workbench-pane--editor .item-relations');
    await expect(relations.getByRole('heading', { name: 'Affects' })).toBeVisible();
    await expect(relations.getByRole('link', { name: 'Delivery' })).toBeVisible();
    await expect(relations.getByRole('button')).toHaveCount(0);
    api.assertNoUnexpectedRequests();
  });
});
