import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

const API = `http://localhost:3001/api/projects/${syntheticProject.id}`;

// One finished story with no tasks, and one in-flight story whose tasks carry estimates.
const progressProject = {
  ...structuredClone(syntheticProject),
  epics: [{
    id: 'epic-synthetic',
    name: 'Delivery',
    status: 'In Progress',
    version: 1,
    stories: [
      { id: 'story-done', name: 'Parity decisions', points: 2, status: 'Completed', targetHourEstimate: 16, tasks: [], version: 1 },
      {
        id: 'story-synthetic',
        name: 'Release pilot',
        status: 'In Progress',
        version: 2,
        tasks: [
          { id: 'task-synthetic', name: 'Validate rollout', status: 'Not Started', targetHourEstimate: 8, version: 1 },
          { id: 'task-build', name: 'Build pilot', percentComplete: 25, status: 'In Progress', targetHourEstimate: 8, version: 1 },
        ],
      },
    ],
  }],
};

async function openProject(page) {
  const api = await installSyntheticApi(page);
  await page.route(API, (route) => (route.request().method() === 'GET'
    ? route.fulfill({ body: JSON.stringify({ project: progressProject }), contentType: 'application/json', status: 200 })
    : route.fallback()));
  await authenticateSyntheticUser(page);
  await page.goto(`projects/${syntheticProject.id}`);
  await openOutline(page);
  return api;
}

async function openOutline(page) {
  // The navigator button only exists at narrow widths, so wait for the outline before looking.
  await expect(page.locator('button.outline-row--project')).toBeAttached();
  const structureNavigator = page.getByRole('button', { name: 'Open structure navigator' });
  if (await structureNavigator.isVisible()) await structureNavigator.click();
}

test.describe('estimate-weighted progress bars', () => {
  test('a completed story without tasks shows a full done bar with a hover breakdown', async ({ page }) => {
    const api = await openProject(page);
    const bar = page.getByRole('button', { name: 'Parity decisions progress: 100% complete, 16h of 16h' });

    await expect(bar.locator('.status-progress__segment')).toHaveCount(1);
    await expect(bar.locator('.status-progress__segment')).toHaveClass(/progress-done/);

    await bar.hover();
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toContainText('100% complete');
    await expect(tooltip).toContainText('16h from 1 completed item');
    api.assertNoUnexpectedRequests();
  });

  test('the breakdown is reachable by keyboard and closes with Escape', async ({ page }, testInfo) => {
    const api = await openProject(page);
    const bar = page.getByRole('button', { name: 'Release pilot progress: 13% complete, 2h of 16h' });

    await bar.focus();
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toBeVisible();
    await expect(bar).toHaveAttribute('aria-describedby', await tooltip.getAttribute('id'));
    await expect(tooltip.locator('.work-progress-tip__row')).toHaveText([
      /Done\s*13%\s*2h earned on work in flight/,
      /In progress\s*38%\s*6h left on 1 item/,
      /Not started\s*50%\s*8h across 1 item/,
    ]);

    const results = await new AxeBuilder({ page }).include('.work-progress-tip').analyze();
    await testInfo.attach('axe-work-progress-tip.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
    expect(results.violations.filter(({ impact }) => ['critical', 'serious'].includes(impact))).toEqual([]);

    await page.keyboard.press('Escape');
    await expect(tooltip).toHaveCount(0);
    api.assertNoUnexpectedRequests();
  });

  test('completing a story in the editor completes its tasks and fills its bar', async ({ page }) => {
    const api = await openProject(page);
    await page.locator('button.outline-row--story').filter({ hasText: 'Release pilot' }).click();
    await expect(page.getByRole('heading', { name: 'Release pilot', exact: true })).toBeVisible();

    const status = page.locator('.workbench-pane--editor .field-group').filter({ has: page.locator('label', { hasText: /^Status$/ }) }).locator('select');
    await status.selectOption('Completed');

    await openOutline(page);
    await expect(page.getByRole('button', { name: 'Release pilot progress: 100% complete, 16h of 16h' })).toBeVisible();
    const taskRows = page.locator('button.outline-row--task');
    await expect(taskRows.filter({ hasText: 'Validate rollout' })).toContainText('Status: Completed');
    await expect(taskRows.filter({ hasText: 'Build pilot' })).toContainText('Status: Completed');
    api.assertNoUnexpectedRequests();
  });

  test('every task shows percent complete and actual hours, and progress starts untouched work', async ({ page }) => {
    const api = await openProject(page);
    await page.locator('button.outline-row--task').filter({ hasText: 'Validate rollout' }).click();
    await expect(page.getByRole('heading', { name: 'Validate rollout', exact: true })).toBeVisible();

    const percent = page.getByLabel('% complete', { exact: true });
    const status = page.locator('.workbench-pane--editor .field-group').filter({ has: page.locator('label', { hasText: /^Status$/ }) }).locator('select');
    await expect(status).toHaveValue('Not Started');
    await expect(percent).toBeEnabled();
    await percent.fill('30');
    await expect(status).toHaveValue('In Progress');
    await page.getByLabel('Actual hours', { exact: true }).fill('2.5');

    await openOutline(page);
    // 8h in flight at 30% plus 2h earned on the 8h build task.
    const bar = page.getByRole('button', { name: 'Release pilot progress: 28% complete, 4.4h of 16h' });
    await bar.focus();
    await expect(page.getByRole('tooltip')).toContainText('2.5h actually spent, logged on 1 item');
    api.assertNoUnexpectedRequests();
  });

  test('a completed work item shows 100% complete and keeps it locked', async ({ page }) => {
    const api = await openProject(page);
    await page.locator('button.outline-row--story').filter({ hasText: 'Parity decisions' }).click();
    await expect(page.getByRole('heading', { name: 'Parity decisions', exact: true })).toBeVisible();

    const percent = page.getByLabel('% complete', { exact: true });
    await expect(percent).toBeDisabled();
    await expect(percent).toHaveValue('100');
    await expect(page.getByLabel('Actual hours', { exact: true })).toBeEnabled();
    api.assertNoUnexpectedRequests();
  });
});
