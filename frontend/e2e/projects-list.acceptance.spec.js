import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { authenticateSyntheticUser, installSyntheticApi, openPhoneMenu, openTopMenu } from './fixtures/synthetic-api.js';

const API_ORIGIN = 'http://localhost:3001';
const NOW = new Date(2026, 9, 12, 10, 0, 0);

function project(id, name, status, extra = {}) {
  return { description: 'A very long statement of work that the list must not print. '.repeat(40), endDate: null, id, name, rank: null, role: 'admin', startDate: null, status, tenantId: 'tenant-synthetic', updatedAt: '2026-10-01T12:00:00.000Z', ...extra };
}

const projects = [
  project('p-filing', 'Agency Filing Portal (V1)', 'Planned', { rank: 1 }),
  project('p-portal', 'Client Portal Rebuild', 'In Progress', { endDate: '2026-10-20', rank: 2, startDate: '2026-08-01' }),
  project('p-payroll', 'Payroll Sync', 'At Risk', { endDate: '2026-10-09', rank: 3, startDate: '2026-06-01' }),
  project('p-benefits', 'Benefits Enrollment 2025', 'Completed', { endDate: '2026-09-30', rank: 4, startDate: '2026-05-01' }),
  project('p-legacy', 'Legacy Reporting Sunset', 'Archived', { rank: 5 }),
  project('p-warehouse', 'Data Warehouse Migration', 'Review'),
  project('p-mobile', 'Mobile App Pilot', 'Planned'),
];

const waiting = (counts) => ({ answer: 0, decide: 0, drafts: 0, review: 0, ...counts, total: Object.values(counts).reduce((sum, value) => sum + value, 0) });

const signals = [
  { projectId: 'p-filing', review: { awaitingYou: true, dueAt: new Date(2026, 9, 14, 17, 0).toISOString(), id: 'round-filing', number: 2, openCount: 1, required: true, reviewer: true, submitted: false, track: 'experience' }, waiting: waiting({ answer: 2, review: 1 }) },
  { projectId: 'p-portal', review: { awaitingYou: false, dueAt: new Date(2026, 9, 10, 17, 0).toISOString(), id: 'round-portal', number: 1, openCount: 2, required: false, reviewer: true, submitted: true, track: 'architecture' }, waiting: waiting({}) },
  { projectId: 'p-payroll', review: null, waiting: waiting({ decide: 1 }) },
  { projectId: 'p-benefits', review: null, waiting: waiting({}) },
  { projectId: 'p-warehouse', review: null, waiting: waiting({}) },
  { projectId: 'p-mobile', review: { awaitingYou: false, dueAt: null, id: 'round-mobile', number: 1, openCount: 1, required: false, reviewer: false, submitted: false, track: 'experience' }, waiting: waiting({}) },
];

async function installProjectList(page) {
  const api = await installSyntheticApi(page, { admin: true });
  await page.clock.setFixedTime(NOW);
  await page.route(`${API_ORIGIN}/api/projects`, (route) => (route.request().method() === 'GET'
    ? route.fulfill({ body: JSON.stringify({ ok: true, projects }), contentType: 'application/json' })
    : route.fallback()));
  await page.route(`${API_ORIGIN}/api/requirements/project-signals`, (route) => route.fulfill({ body: JSON.stringify({ ok: true, projects: signals }), contentType: 'application/json' }));
  return api;
}

function projectRows(page) {
  return page.getByRole('table').locator('tbody tr');
}

test.describe('projects list', () => {
  test('hides archived projects, shows what is waiting, and filters and sorts', async ({ page }, testInfo) => {
    const api = await installProjectList(page);
    await authenticateSyntheticUser(page);
    await page.goto('projects');

    const table = page.getByRole('table');
    await expect(table.getByRole('link', { name: 'Agency Filing Portal (V1)' })).toBeVisible();
    await expect(projectRows(page)).toHaveCount(6);
    await expect(table.getByText('Legacy Reporting Sunset')).toHaveCount(0);
    await expect(table.getByText('A very long statement of work')).toHaveCount(0);

    await expect(page.getByText(/4 items\s+waiting on you in 2 projects\./)).toBeVisible();
    await expect(page.getByText(/closes in 2 days/)).toBeVisible();

    const filing = projectRows(page).filter({ hasText: 'Agency Filing Portal (V1)' });
    await expect(filing.getByRole('link', { name: '3 items' })).toHaveAttribute('href', /\/projects\/p-filing\/requirements$/);
    await expect(filing.getByText('2 to answer · 1 to review')).toBeVisible();
    await expect(filing.getByRole('link', { name: /Closes in 2 days/ })).toBeVisible();
    await expect(filing.getByText("You haven't reviewed yet")).toBeVisible();

    const portal = projectRows(page).filter({ hasText: 'Client Portal Rebuild' });
    await expect(portal.getByRole('link', { name: /2 days overdue/ })).toBeVisible();
    await expect(portal.getByText('1 more open')).toBeVisible();
    await expect(portal.getByText('Ends in 8 days')).toBeVisible();
    await expect(projectRows(page).filter({ hasText: 'Payroll Sync' }).getByText('Past end date')).toBeVisible();
    await expect(projectRows(page).filter({ hasText: 'Mobile App Pilot' }).getByText('Open, no close date')).toBeVisible();

    await testInfo.attach('projects-desktop.png', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });

    const results = await new AxeBuilder({ page }).include('#main-content').analyze();
    await testInfo.attach('axe-projects-list.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
    expect(results.violations.filter(({ impact }) => ['critical', 'serious'].includes(impact))).toEqual([]);

    await page.getByLabel('Filter projects').fill('pay');
    await expect(projectRows(page)).toHaveCount(1);
    await expect(page).toHaveURL(/[?&]q=pay/);
    await page.getByLabel('Filter projects').fill('');

    await page.getByLabel('Waiting on me').check();
    await expect(projectRows(page)).toHaveCount(2);
    await page.getByLabel('Waiting on me').uncheck();

    await page.getByRole('radio', { name: /Archived/ }).check({ force: true });
    await expect(projectRows(page)).toHaveCount(1);
    await expect(table.getByRole('link', { name: 'Legacy Reporting Sunset' })).toBeVisible();
    await expect(page).toHaveURL(/[?&]status=Archived/);

    await page.getByRole('radio', { name: /All active/ }).check({ force: true });
    await page.getByLabel('Sort').selectOption('name');
    await expect(projectRows(page).first()).toContainText('Agency Filing Portal (V1)');
    await expect(projectRows(page).nth(1)).toContainText('Benefits Enrollment 2025');

    // Phones hide the column headers; the Sort menu covers them there.
    if (testInfo.project.name === 'chromium-mobile') await page.getByLabel('Sort').selectOption('review');
    else await table.getByRole('button', { name: 'Open review' }).click();
    await expect(page.getByLabel('Sort')).toHaveValue('review');
    await expect(projectRows(page).first()).toContainText('Client Portal Rebuild');

    // Leaving with a filter set lands where the user went, and Back restores the filter.
    await page.getByLabel('Filter projects').fill('pay');
    await expect(page).toHaveURL(/[?&]q=pay/);
    const home = page.getByRole('link', { name: 'Home', exact: true });
    if (!await home.isVisible()) await openPhoneMenu(page);
    await home.click();
    await expect(page).toHaveURL(/\/app\/$/);
    await page.goBack();
    await expect(page.getByLabel('Filter projects')).toHaveValue('pay');
    await expect(projectRows(page)).toHaveCount(1);

    api.assertNoUnexpectedRequests();
  });

  test('the navbar project menu leaves archived projects out', async ({ page }) => {
    const api = await installProjectList(page);
    await authenticateSyntheticUser(page);
    await page.goto('projects');
    await expect(projectRows(page)).toHaveCount(6);

    const menu = await openTopMenu(page, 'Work');
    await expect(menu.getByRole('link', { name: 'Payroll Sync' })).toBeVisible();
    await expect(menu.getByRole('link', { name: 'Legacy Reporting Sunset' })).toHaveCount(0);
    api.assertNoUnexpectedRequests();
  });

  test('a project created elsewhere, such as by an MCP client, appears without a reload', async ({ page }) => {
    const api = await installProjectList(page);
    let listed = projects;
    await page.route(`${API_ORIGIN}/api/projects`, (route) => (route.request().method() === 'GET'
      ? route.fulfill({ body: JSON.stringify({ ok: true, projects: listed }), contentType: 'application/json' })
      : route.fallback()));
    // Workspace streams are held until the project exists, then told of it. Signing in opens
    // Home first, whose stream closes on the way here. Reconnects after that carry nothing new.
    let delivered = false;
    let release;
    const created = new Promise((resolve) => { release = resolve; });
    await page.route(`${API_ORIGIN}/api/workspace/events`, async (route) => {
      if (delivered) return route.fulfill({ body: '', contentType: 'text/event-stream', status: 200 });
      await created;
      const frames = 'event: connected\ndata: {}\n\nevent: workspace.changed\ndata: {"area":"projects","originClientId":"tab-elsewhere"}\n\n';
      try {
        await route.fulfill({ body: frames, contentType: 'text/event-stream', status: 200 });
        delivered = true;
      } catch {
        // That screen closed while its stream was held.
      }
    });

    await authenticateSyntheticUser(page);
    await page.goto('projects');
    await expect(projectRows(page)).toHaveCount(6);
    await expect(projectRows(page).filter({ hasText: 'Agent-made Project' })).toHaveCount(0);

    listed = [...projects, project('p-agent', 'Agent-made Project', 'Planned')];
    release();
    await expect(projectRows(page).filter({ hasText: 'Agent-made Project' })).toBeVisible();
    await expect(projectRows(page)).toHaveCount(7);
    api.assertNoUnexpectedRequests();
  });

  test('dark mode and narrow screens keep the list readable', async ({ page }, testInfo) => {
    const api = await installProjectList(page);
    await authenticateSyntheticUser(page);
    await page.goto('projects');
    await expect(projectRows(page)).toHaveCount(6);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await testInfo.attach('projects-light.png', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });

    await page.evaluate(() => document.documentElement.classList.add('dark'));
    // Buttons ease their colors over 180ms; let them settle before the contrast check.
    await page.waitForTimeout(400);
    await testInfo.attach('projects-dark.png', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    const results = await new AxeBuilder({ page }).include('#main-content').analyze();
    await testInfo.attach('axe-projects-list-dark.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
    expect(results.violations.filter(({ impact }) => ['critical', 'serious'].includes(impact))).toEqual([]);
    api.assertNoUnexpectedRequests();
  });
});
