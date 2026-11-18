import { expect, test } from '@playwright/test';

import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

const API = `http://localhost:3001/api/projects/${syntheticProject.id}`;

// One story with three tasks, one of them unestimated, under an epic with stale stored totals.
const rollupProject = {
  ...structuredClone(syntheticProject),
  epics: [{
    estimateOverride: false,
    id: 'epic-synthetic',
    name: 'Delivery',
    points: 40,
    status: 'In Progress',
    stories: [{
      estimateOverride: false,
      id: 'story-synthetic',
      name: 'Release pilot',
      points: 99,
      status: 'In Progress',
      targetHourEstimate: 999,
      tasks: [
        { id: 'task-synthetic', name: 'Validate rollout', points: 2, status: 'Not Started', targetHourEstimate: 16, version: 1 },
        { id: 'task-receipts', name: 'Import receipts', points: 3, status: 'Not Started', targetHourEstimate: 24, version: 1 },
        { id: 'task-unsized', name: 'Unsized follow-up', points: null, status: 'Not Started', targetHourEstimate: null, version: 1 },
      ],
      version: 2,
    }],
    targetHourEstimate: 400,
    version: 1,
  }],
};

async function openProject(page) {
  const api = await installSyntheticApi(page);
  await page.route(API, (route) => (route.request().method() === 'GET'
    ? route.fulfill({ body: JSON.stringify({ project: rollupProject }), contentType: 'application/json', status: 200 })
    : route.fallback()));
  await authenticateSyntheticUser(page);
  await page.goto(`projects/${syntheticProject.id}`);
  await expect(page.locator('button.outline-row--project')).toBeAttached();
  return api;
}

async function openOutline(page) {
  const structureNavigator = page.getByRole('button', { name: 'Open structure navigator' });
  if (await structureNavigator.isVisible()) await structureNavigator.click();
}

function field(page, label) {
  return page.locator('.workbench-pane--editor .field-group').filter({ has: page.locator('label', { hasText: new RegExp(`^${label}$`) }) });
}

test.describe('estimate rollups', () => {
  test('a story shows its tasks totals and follows a task re-estimate', async ({ page }) => {
    const api = await openProject(page);
    await openOutline(page);
    await page.locator('button.outline-row--story').filter({ hasText: 'Release pilot' }).click();

    await expect(field(page, 'Points').locator('input')).toHaveValue('5');
    await expect(field(page, 'Target hours').locator('input')).toHaveValue('40');
    await expect(field(page, 'Points')).toContainText('Sum of 3 tasks; 1 without an estimate.');
    await expect(page.locator('.field-hint--warning')).toHaveCount(0);

    await openOutline(page);
    await page.locator('button.outline-row--task').filter({ hasText: 'Validate rollout' }).click();
    await field(page, 'Points').locator('input').fill('5');

    await openOutline(page);
    await expect(page.locator('button.outline-row--story').filter({ hasText: 'Release pilot' })).toContainText('Points: 8 | Hours: 64h');
    await expect(page.locator('.outline-row').filter({ hasText: 'Delivery' }).first()).toContainText('Total Points: 8');
    api.assertNoUnexpectedRequests();
  });

  test('typing over a story total sets it by hand until the task total is restored', async ({ page }) => {
    const api = await openProject(page);
    await openOutline(page);
    await page.locator('button.outline-row--story').filter({ hasText: 'Release pilot' }).click();

    await field(page, 'Points').locator('input').fill('8');
    await expect(field(page, 'Points')).toContainText('Set by hand. Tasks add up to 5.');
    await expect(field(page, 'Target hours').locator('input')).toHaveValue('40');
    await expect(field(page, 'Target hours')).toContainText('Set by hand. Tasks add up to 40h.');

    await openOutline(page);
    await expect(page.locator('.outline-row').filter({ hasText: 'Delivery' }).first()).toContainText('Total Points: 8');
    await page.locator('button.outline-row--story').filter({ hasText: 'Release pilot' }).click();

    await field(page, 'Points').getByRole('button', { name: 'Use task total' }).click();
    await expect(field(page, 'Points').locator('input')).toHaveValue('5');
    await expect(field(page, 'Points')).toContainText('Sum of 3 tasks');
    api.assertNoUnexpectedRequests();
  });
});
