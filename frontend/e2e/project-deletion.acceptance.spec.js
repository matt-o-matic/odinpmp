import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { settleForAxe } from './fixtures/axe-settle.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];
const API = 'http://localhost:3001';

async function expectNoAxeViolations(page, testInfo, name, include = '#main-content') {
  await settleForAxe(page);
  const results = await new AxeBuilder({ page }).include(include).withTags(wcagTags).analyze();
  await testInfo.attach(`axe-${name}.json`, { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
  expect(results.violations).toEqual([]);
}

// The app's touch-target rule is 2.75rem against its root font size.
async function expectTouchTarget(page, locator) {
  const rootPx = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize));
  expect((await locator.boundingBox()).height).toBeGreaterThanOrEqual(2.75 * rootPx - 0.5);
}

async function expectNoHorizontalOverflow(page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

// Overrides for the shared synthetic API: project detail with a delete permission, and DELETE.
async function installProjectDeletion(page, { canDelete }) {
  const state = { deleted: false, deleteCalls: 0 };
  await page.route(`${API}/api/projects`, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ json: { ok: true, projects: state.deleted ? [] : [syntheticProject] } });
  });
  await page.route(`${API}/api/projects/${syntheticProject.id}`, (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      return state.deleted
        ? route.fulfill({ json: { error: 'Project not found.' }, status: 404 })
        : route.fulfill({ json: { ok: true, permissions: { canDelete }, project: syntheticProject } });
    }
    if (method === 'DELETE') {
      state.deleteCalls += 1;
      state.deleted = true;
      return route.fulfill({ json: { ok: true, project: { deletedAt: '2026-10-09T12:00:00.000Z', deletedBy: 'user-synthetic', id: syntheticProject.id, name: syntheticProject.name } } });
    }
    return route.fallback();
  });
  return state;
}

async function openProjectSettings(page) {
  await page.goto(`projects/${syntheticProject.id}`);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Project settings drawer' })).toBeVisible();
}

test.describe('project deletion', () => {
  // The dev server compiles each screen on first use, which can exceed the default 30s on a busy machine.
  test.describe.configure({ timeout: 90_000 });

  test('deleting a project needs its typed name, then returns to the project list', async ({ page }, testInfo) => {
    const api = await installSyntheticApi(page);
    const state = await installProjectDeletion(page, { canDelete: true });
    await authenticateSyntheticUser(page);
    await openProjectSettings(page);

    const deleteAction = page.getByRole('button', { name: 'Delete project', exact: true });
    await expect(deleteAction).toBeVisible();
    await expectTouchTarget(page, deleteAction);
    await expectNoAxeViolations(page, testInfo, 'settings-rail-light', '.project-settings-drawer__rail');
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await expectNoAxeViolations(page, testInfo, 'settings-rail-dark', '.project-settings-drawer__rail');
    await page.screenshot({ path: testInfo.outputPath('settings-rail-dark.png') });
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    await deleteAction.click();

    const dialog = page.getByRole('dialog', { name: 'Delete this project?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    const confirm = dialog.getByRole('button', { name: 'Delete project' });
    await expect(confirm).toBeDisabled();
    const nameField = dialog.getByLabel('Type the project name to confirm');
    await nameField.fill('Synthetic');
    await expect(confirm).toBeDisabled();
    await nameField.press('Enter');
    await expect(dialog).toBeVisible();
    expect(state.deleteCalls).toBe(0);

    await nameField.fill(syntheticProject.name);
    await expect(confirm).toBeEnabled();
    expect(await dialog.evaluate((element) => element.getBoundingClientRect().width <= innerWidth)).toBe(true);
    await expectNoAxeViolations(page, testInfo, 'delete-dialog-light', 'dialog');
    await page.screenshot({ path: testInfo.outputPath('delete-dialog-light.png') });
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await expectNoAxeViolations(page, testInfo, 'delete-dialog-dark', 'dialog');
    await page.screenshot({ path: testInfo.outputPath('delete-dialog-dark.png') });
    await page.evaluate(() => document.documentElement.classList.remove('dark'));

    await confirm.click();
    await expect(page).toHaveURL(/\/app\/projects$/);
    const notice = page.getByRole('status').filter({ hasText: `Deleted ${syntheticProject.name}.` });
    await expect(notice).toBeVisible();
    await expect(page.getByRole('link', { name: syntheticProject.name })).toHaveCount(0);
    expect(state.deleteCalls).toBe(1);
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo, 'projects-after-delete');
    await page.screenshot({ path: testInfo.outputPath('projects-after-delete.png'), fullPage: true });

    await page.getByRole('button', { name: 'Dismiss message' }).click();
    await expect(notice).toHaveCount(0);
    api.assertNoUnexpectedRequests();
  });

  test('a legal hold keeps the project and explains why', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await installProjectDeletion(page, { canDelete: true });
    await page.route(`${API}/api/projects/${syntheticProject.id}`, (route) => (route.request().method() === 'DELETE'
      ? route.fulfill({ json: { error: 'A record-scoped legal hold blocks this change.' }, status: 423 })
      : route.fallback()));
    await authenticateSyntheticUser(page);
    await openProjectSettings(page);
    await page.getByRole('button', { name: 'Delete project', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete this project?' });
    await dialog.getByLabel('Type the project name to confirm').fill(syntheticProject.name);
    await dialog.getByRole('button', { name: 'Delete project' }).click();
    await expect(dialog.getByRole('alert')).toContainText('legal hold');
    await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
    await expect(dialog).not.toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/projects/${syntheticProject.id}`));
    api.assertNoUnexpectedRequests();
  });

  test('people who cannot delete the project do not see the action', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await installProjectDeletion(page, { canDelete: false });
    await authenticateSyntheticUser(page);
    await openProjectSettings(page);
    await expect(page.getByRole('link', { name: /Resources and access/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete project', exact: true })).toHaveCount(0);
    api.assertNoUnexpectedRequests();
  });

  test('tenant admins find deleted projects and restore one', async ({ page }, testInfo) => {
    const api = await installSyntheticApi(page, { admin: true });
    await page.route('**/api/tenants/**', (route) => route.fulfill({ json: { domains: [], invites: [], requests: [], statuses: [], task_types: [], tenant_name: 'Synthetic workspace', users: [] } }));
    let deleted = Array.from({ length: 12 }, (_, index) => ({
      deletedAt: new Date(Date.UTC(2026, 9, 9, 12 - index)).toISOString(),
      deletedBy: 'user-synthetic',
      deletedByName: index % 2 ? 'Synthetic Demo' : 'Pat Manager',
      id: `deleted-${index + 1}`,
      name: index === 0 ? 'Retired Pilot' : `Archive candidate ${String(index + 1).padStart(2, '0')}`,
      status: 'Planned',
      updatedAt: '2026-10-01T12:00:00.000Z',
    }));
    const restored = [];
    await page.route(`${API}/api/projects/deleted`, (route) => route.fulfill({ json: { ok: true, projects: deleted } }));
    await page.route(/http:\/\/localhost:3001\/api\/projects\/deleted-\d+\/restore$/, (route) => {
      const projectId = new URL(route.request().url()).pathname.split('/')[3];
      const project = deleted.find((item) => item.id === projectId);
      deleted = deleted.filter((item) => item.id !== projectId);
      restored.push(projectId);
      return route.fulfill({ json: { ok: true, project: { id: project.id, name: project.name, status: project.status } } });
    });

    await authenticateSyntheticUser(page);
    await page.goto('admin');
    await page.getByRole('link', { name: /Deleted Projects/ }).click();
    await expect(page.getByRole('heading', { name: 'Deleted Projects', level: 3 })).toBeVisible();
    const list = page.getByRole('list', { name: 'Deleted projects' });
    await expect(list.getByRole('listitem')).toHaveCount(10);
    await expect(page.getByText('Page 1 of 2')).toBeVisible();
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(list.getByRole('listitem')).toHaveCount(2);
    await page.getByRole('button', { name: 'Previous' }).click();

    await page.getByRole('searchbox', { name: 'Search deleted projects' }).fill('retired');
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await expect(list).toContainText('Retired Pilot');
    await expect(list).toContainText('by Pat Manager');
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo, 'deleted-projects-light', '.deleted-projects');
    await page.screenshot({ path: testInfo.outputPath('deleted-projects-light.png'), fullPage: true });
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await expectNoAxeViolations(page, testInfo, 'deleted-projects-dark', '.deleted-projects');
    await page.screenshot({ path: testInfo.outputPath('deleted-projects-dark.png'), fullPage: true });
    await page.evaluate(() => document.documentElement.classList.remove('dark'));

    const restoreButton = list.getByRole('button', { name: 'Restore Retired Pilot' });
    await expectTouchTarget(page, restoreButton);
    await restoreButton.click();
    const dialog = page.getByRole('dialog', { name: 'Restore this project?' });
    await expect(dialog).toContainText('Retired Pilot');
    await expectNoAxeViolations(page, testInfo, 'restore-dialog', 'dialog');
    await dialog.getByRole('button', { name: 'Restore project' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('status')).toContainText('Restored Retired Pilot.');
    await expect(page.getByText('No deleted projects match your search.')).toBeVisible();
    expect(restored).toEqual(['deleted-1']);

    await page.getByRole('searchbox', { name: 'Search deleted projects' }).fill('');
    await expect(list.getByRole('listitem')).toHaveCount(10);
    await expect(page.getByText('Page 2 of 2')).toHaveCount(0);
    await page.getByLabel('Sort by').selectOption('name');
    await expect(list.getByRole('listitem').first()).toContainText('Archive candidate 02');
    api.assertNoUnexpectedRequests();
  });
});
