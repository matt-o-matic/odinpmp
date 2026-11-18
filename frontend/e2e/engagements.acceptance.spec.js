import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { settleForAxe } from './fixtures/axe-settle.js';
import { installEngagementsApi } from './fixtures/engagements-api.js';
import { authenticateSyntheticUser, installSyntheticApi, openTopMenu } from './fixtures/synthetic-api.js';

async function expectNoSeriousAxe(page) {
  await settleForAxe(page);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).include('#main-content').analyze();
  expect(results.violations.filter(({ impact }) => ['critical', 'serious'].includes(impact))).toEqual([]);
}

test('with the Consulting module off, Engagements is not in the navigation and its page says so (AC-18)', async ({ page }) => {
  const api = await installSyntheticApi(page);
  await authenticateSyntheticUser(page);
  const work = await openTopMenu(page, 'Work');
  await expect(work.getByRole('link', { exact: true, name: 'All tickets' })).toBeVisible();
  await expect(work.getByRole('heading', { name: 'Engagements' })).toHaveCount(0);
  await expect(work.getByRole('link', { name: /engagement/i })).toHaveCount(0);
  api.assertNoUnexpectedRequests();
});

test('a member lists engagements by status, creates one, and lands on its page with only the engagement sections (AC-01)', async ({ page }) => {
  await installSyntheticApi(page);
  const engagements = await installEngagementsApi(page);
  await authenticateSyntheticUser(page);
  const work = await openTopMenu(page, 'Work');
  // With the module on, Work has a column for engagements, the most recently active open ones.
  await expect(work.getByRole('heading', { level: 2 })).toHaveText(['Projects', 'Engagements', 'Tickets']);
  const column = work.locator('section', { has: page.getByRole('heading', { name: 'Engagements' }) });
  await expect(column.getByRole('link', { name: /Northwind data platform/ })).toHaveAttribute('href', '/app/engagements/eng-northwind');
  await expect(column.getByRole('link', { name: /Fabrikam CRM pilot/ })).toHaveCount(0);
  // New engagement… opens the page's form.
  await column.getByRole('link', { exact: true, name: 'New engagement…' }).click();
  await expect(page.getByRole('dialog', { name: 'New engagement' })).toBeVisible();
  await expect(page).toHaveURL(/\/app\/engagements$/);
  await page.getByRole('dialog', { name: 'New engagement' }).getByRole('button', { name: 'Cancel' }).click();
  await (await openTopMenu(page, 'Work')).getByRole('link', { exact: true, name: 'All engagements' }).click();
  await expect(page).toHaveURL(/\/app\/engagements$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Engagements' })).toBeVisible();

  const table = page.getByRole('table');
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(table.getByRole('rowheader', { name: 'Northwind data platform' })).toBeVisible();
  await expect(table.getByRole('row', { name: /Northwind data platform/ })).toContainText('Pat Seller');
  await expect(table.getByRole('row', { name: /Northwind data platform/ })).toContainText('3 unread');
  await expectNoSeriousAxe(page);

  await page.getByRole('radio', { name: /^Lost/ }).check();
  await expect(page).toHaveURL(/status=lost/);
  await expect(table.getByRole('rowheader', { name: 'Fabrikam CRM pilot' })).toBeVisible();
  await page.reload();
  await expect(table.getByRole('rowheader', { name: 'Fabrikam CRM pilot' })).toBeVisible();
  await page.getByRole('radio', { name: /^Won/ }).check();
  await expect(table.getByRole('link', { name: 'Contoso rollout' })).toHaveAttribute('href', '/app/projects/eng-contoso');

  await page.getByRole('button', { name: 'New engagement' }).click();
  const dialog = page.getByRole('dialog', { name: 'New engagement' });
  await dialog.getByLabel('Name').fill('Litware migration');
  await dialog.getByRole('button', { name: 'Create engagement' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Enter the customer.');
  await dialog.getByLabel('Customer').fill('Litware');
  await dialog.getByRole('button', { name: 'Create engagement' }).click();
  // A new engagement opens on its General channel.
  await expect(page).toHaveURL(/\/app\/engagements\/eng-new-1\/channels\?channel=general$/);
  expect(engagements.calls.at(-1)).toEqual({ body: { customer: 'Litware', name: 'Litware migration' }, method: 'POST', path: '/api/engagements' });

  await expect(page.getByRole('heading', { level: 1, name: 'Litware migration' })).toBeVisible();
  const sections = page.getByRole('navigation', { name: 'Engagement sections' });
  await expect(sections.getByRole('link')).toHaveText(['Channels', 'Board', 'Insights', 'Files', 'People', 'Settings']);
  await expect(page.getByRole('heading', { exact: true, level: 3, name: 'General' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message General' })).toBeVisible();
  await sections.getByRole('link', { name: 'Files' }).click();
  await expect(page.locator('.project-files__name', { hasText: 'Proposal v3.docx' })).toBeVisible();
  await sections.getByRole('link', { name: 'People' }).click();
  await expect(page).toHaveURL(/\/eng-new-1\/people$/);
  await expect(page.getByRole('main')).toContainText('Pat Seller');
  await expectNoSeriousAxe(page);
});

test('an engagement is marked lost, shown read-only, reopened, and converted with a template (AC-12, AC-13)', async ({ page }) => {
  await installSyntheticApi(page);
  const engagements = await installEngagementsApi(page);
  await authenticateSyntheticUser(page);
  // An engagement's project address opens its engagement page.
  await page.goto('projects/eng-northwind');
  await expect(page).toHaveURL(/\/app\/engagements\/eng-northwind$/);
  await page.getByRole('navigation', { name: 'Engagement sections' }).getByRole('link', { name: 'Settings' }).click();

  // The customer and owner change here (E-09).
  await page.getByRole('button', { name: 'Customer and owner' }).click();
  const details = page.getByRole('dialog', { name: 'Customer and owner' });
  await details.getByLabel('Customer').fill('Northwind Traders');
  await details.getByLabel('Owner').selectOption({ label: 'Synthetic Demo' });
  await details.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('main')).toContainText('Northwind Traders');
  expect(engagements.calls.shift()).toEqual({ body: { customer: 'Northwind Traders', ownerId: 'user-synthetic' }, method: 'PATCH', path: '/api/projects/eng-northwind/engagement' });

  await page.getByRole('button', { name: 'Mark lost' }).click();
  const confirmLost = page.getByRole('dialog', { name: 'Mark this engagement lost?' });
  await confirmLost.getByRole('button', { name: 'Mark lost' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Files and people are read-only' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Convert to project' })).toHaveCount(0);
  await expectNoSeriousAxe(page);

  await page.getByRole('button', { name: 'Reopen' }).click();
  await expect(page.getByText('Files and people are read-only')).toHaveCount(0);
  expect(engagements.calls.map((call) => call.path)).toEqual(['/api/projects/eng-northwind/close', '/api/projects/eng-northwind/reopen']);

  await page.getByRole('button', { name: 'Convert to project' }).click();
  const convert = page.getByRole('dialog', { name: 'Convert to project' });
  await expect(convert.getByLabel('Project template')).toBeEnabled();
  await convert.getByLabel('Project template').selectOption({ label: 'Consulting delivery' });
  await convert.getByRole('button', { name: 'Convert' }).click();
  await expect(page).toHaveURL(/\/app\/projects\/eng-northwind$/);
  expect(engagements.calls.at(-1)).toEqual({ body: { moveOpenPursuitTasks: false, templateId: 'template-delivery' }, method: 'POST', path: '/api/projects/eng-northwind/convert' });
});

test('a workspace admin switches the Consulting module on and off; switching off says how many open engagements it hides (AC-18)', async ({ page }) => {
  await installSyntheticApi(page, { admin: true });
  await page.route('**/api/tenants/**', (route) => route.fulfill({ json: { domains: [], invites: [], requests: [], statuses: [], task_types: [], tenant_name: 'Synthetic workspace', users: [] } }));
  const engagements = await installEngagementsApi(page, { enabled: false, openEngagementCount: 4 });
  await authenticateSyntheticUser(page);
  await page.goto('admin?section=modules');
  await expect(page.getByRole('heading', { level: 3, name: 'Modules' })).toBeVisible();
  const row = page.getByRole('list', { name: 'Modules' }).getByRole('listitem');
  await expect(row).toContainText('Consulting');
  await expect(row).toContainText('Off');
  await expect((await openTopMenu(page, 'Work')).getByRole('link', { name: 'Engagements' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  if (await page.getByRole('button', { name: 'Toggle navigation' }).isVisible()) await page.getByRole('button', { name: 'Toggle navigation' }).click();

  await page.getByRole('button', { name: 'Switch on Consulting' }).click();
  await page.getByRole('dialog', { name: 'Switch on Consulting?' }).getByRole('button', { name: 'Switch on' }).click();
  await expect(row).toContainText('On');
  expect(engagements.calls.at(-1)).toEqual({ body: { enabled: true, expectedVersion: 0, key: 'consulting' }, method: 'PUT', path: '/api/workspace/modules' });
  await expect((await openTopMenu(page, 'Work')).getByRole('link', { name: 'Engagements' })).toBeVisible();
  await page.keyboard.press('Escape');
  if (await page.getByRole('button', { name: 'Toggle navigation' }).isVisible()) await page.getByRole('button', { name: 'Toggle navigation' }).click();

  await page.getByRole('button', { name: 'Switch off Consulting' }).click();
  const off = page.getByRole('dialog', { name: 'Switch off Consulting?' });
  await expect(off).toContainText('4 open engagements will be hidden');
  await expectNoSeriousAxe(page);
  await off.getByRole('button', { name: 'Switch off' }).click();
  await expect(row).toContainText('Off');
  expect(engagements.module.enabled).toBe(false);
});
