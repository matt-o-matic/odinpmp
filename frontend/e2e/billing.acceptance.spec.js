// invoice-gen billing in Odin (docs/invoice-gen-connection): the Billing tab, story milestone
// assignment in bulk and on a story, claimed time entries, and the SOW on an engagement.
// All data is synthetic (fixtures/billing-api.js).
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { settleForAxe } from './fixtures/axe-settle.js';
import { SOW, installBillingApi } from './fixtures/billing-api.js';
import { installEngagementsApi } from './fixtures/engagements-api.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

async function expectNoSeriousAxe(page) {
  await settleForAxe(page);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).include('#main-content').analyze();
  expect(results.violations.filter(({ impact }) => ['critical', 'serious'].includes(impact))).toEqual([]);
}

async function noHorizontalOverflow(page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

const tabs = (page) => page.getByRole('navigation', { name: 'Project workspace tabs' });

// The plan editor on the synthetic story. On a phone the outline sits behind the structure navigator.
async function openStory(page) {
  await expect(tabs(page).getByRole('link', { name: 'Insights' })).toBeVisible();
  const structureNavigator = page.getByRole('button', { name: 'Open structure navigator' });
  if (await structureNavigator.isVisible()) await structureNavigator.click();
  await page.locator('button.outline-row--story').filter({ hasText: 'Release pilot' }).click();
  await expect(page.getByRole('heading', { name: 'Release pilot', exact: true })).toBeVisible();
}

test('a manager sees the Billing tab: the client, the SOW, each milestone\'s hours and the invoices (AC-I05, AC-I06)', async ({ page }) => {
  const api = await installSyntheticApi(page);
  await installBillingApi(page);
  await authenticateSyntheticUser(page);
  await page.goto(`projects/${syntheticProject.id}`);
  await tabs(page).getByRole('link', { name: 'Billing' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${syntheticProject.id}/billing$`));

  await expect(page.getByText('Synthetic Client · Consulting')).toBeVisible();
  const sowLink = page.getByTestId('billing-sow-link');
  await expect(sowLink).toHaveAttribute('href', SOW.url);
  await expect(sowLink).toHaveAttribute('target', '_blank');
  await expect(page.getByText('Signed', { exact: true })).toBeVisible();

  const milestones = page.getByTestId('billing-milestones');
  const discovery = milestones.getByRole('row', { name: /^Discovery/ });
  await expect(discovery.getByRole('cell')).toHaveText(['40 h', '12 h', '8 h', '6 h', '20 h', '1']);
  const build = milestones.getByRole('row', { name: /^Build/ });
  await expect(build.getByRole('cell').nth(4)).toContainText('-2.5 h');
  await expect(build.getByRole('cell').nth(4)).toContainText('over budget');
  await expect(milestones.getByRole('row', { name: /^No SOW/ }).getByRole('cell').nth(3)).toHaveText('2.5 h');

  const invoices = page.getByTestId('billing-invoices');
  const submitted = invoices.getByRole('row', { name: /NESLLC-20260712-001/ });
  await expect(submitted).toContainText('Submitted');
  await expect(submitted).toContainText('Overdue');
  await expect(submitted.getByRole('link', { name: /NESLLC-20260712-001/ })).toHaveAttribute('href', 'https://invoices.example/invoices/70');
  await expect(invoices.getByRole('row', { name: /Draft invoice/ })).toContainText('Draft');
  await noHorizontalOverflow(page);
  await expectNoSeriousAxe(page);
  api.assertNoUnexpectedRequests();
});

test('the Billing tab is not there for someone without finance visibility, or with the Consulting module off', async ({ page }) => {
  await installSyntheticApi(page);
  const billing = await installBillingApi(page, { canManage: false });
  await authenticateSyntheticUser(page);
  await page.goto(`projects/${syntheticProject.id}`);
  await expect(tabs(page).getByRole('link', { name: 'Insights' })).toBeVisible();
  await expect(tabs(page).getByRole('link', { name: 'Billing' })).toHaveCount(0);
  await page.goto(`projects/${syntheticProject.id}/billing`);
  await expect(page.getByRole('alert')).toContainText('Billing is shown to project admins and managers');
  expect(billing.calls.filter((call) => call.method === 'PUT')).toEqual([]);
});

test('with the module off the tab stays hidden even for a manager', async ({ page }) => {
  await installSyntheticApi(page);
  await installBillingApi(page, { consulting: false });
  await authenticateSyntheticUser(page);
  await page.goto(`projects/${syntheticProject.id}`);
  await expect(tabs(page).getByRole('link', { name: 'Insights' })).toBeVisible();
  await expect(tabs(page).getByRole('link', { name: 'Billing' })).toHaveCount(0);
});

test('a manager assigns stories from any epic to a milestone in one dialog (AC-I11)', async ({ page }) => {
  await installSyntheticApi(page);
  const billing = await installBillingApi(page);
  await authenticateSyntheticUser(page);
  await page.goto(`projects/${syntheticProject.id}/billing`);
  await page.getByTestId('billing-assign').click();
  const dialog = page.getByRole('dialog', { name: 'Assign stories to a milestone' });
  await expect(dialog).toBeVisible();

  await dialog.getByRole('button', { name: /Assign/ }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Choose at least one story.');

  await dialog.getByLabel('Find stories').fill('pilot');
  await expect(dialog.getByRole('checkbox')).toHaveCount(2);
  await dialog.getByRole('checkbox', { name: /Release pilot/ }).check();
  await dialog.getByLabel('Find stories').fill('');
  await dialog.getByLabel('Epic').selectOption({ label: 'Build' });
  await expect(dialog.locator('label').filter({ hasText: 'Data model' })).toContainText('now Discovery');
  await dialog.getByRole('checkbox', { name: /Reports/ }).check();
  await dialog.getByLabel('Milestone').selectOption({ label: 'Build' });
  await expect(dialog.getByTestId('billing-assign-submit')).toHaveText('Assign 2 stories');
  await dialog.getByTestId('billing-assign-submit').click();

  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: '2 stories now bill to Build.' })).toBeVisible();
  expect(billing.calls.find((call) => call.method === 'PUT').body).toEqual({ assignments: [{ milestoneId: 102, storyId: 'story-synthetic' }, { milestoneId: 102, storyId: 'story-reports' }] });
  await expect(page.getByTestId('billing-milestones').getByRole('row', { name: /^Build/ }).getByRole('cell').last()).toHaveText('2');
});

test('a story shows its SOW milestone in the plan editor, and a manager changes it there', async ({ page }) => {
  await installSyntheticApi(page);
  const billing = await installBillingApi(page);
  await authenticateSyntheticUser(page);
  await page.goto(`projects/${syntheticProject.id}`);
  await openStory(page);

  const field = page.getByTestId('story-milestone-field');
  await expect(field).toContainText('None (No SOW)');
  await field.getByRole('button', { name: 'Change SOW milestone' }).click();
  const dialog = page.getByRole('dialog', { name: 'SOW milestone' });
  await dialog.getByLabel('Milestone this story bills to').selectOption({ label: 'Discovery' });
  await dialog.getByRole('button', { name: 'Save milestone' }).click();
  await expect(dialog).toBeHidden();
  await expect(field).toContainText('Discovery');
  expect(billing.calls.filter((call) => call.method === 'PUT').map((call) => call.body)).toEqual([{ assignments: [{ milestoneId: 101, storyId: 'story-synthetic' }] }]);
});

test('a contributor does not see the SOW milestone field', async ({ page }) => {
  await installSyntheticApi(page);
  await installBillingApi(page, { canManage: false });
  await authenticateSyntheticUser(page);
  await page.goto(`projects/${syntheticProject.id}`);
  await openStory(page);
  await expect(page.getByTestId('story-milestone-field')).toHaveCount(0);
});

test('a claimed time entry shows its invoice and has no edit or delete (AC-I03)', async ({ page }) => {
  const api = await installSyntheticApi(page, {
    timeEntries: [
      { billable: true, hours: 3, id: 'time-invoiced', invoice: { draft: false, number: 'NESLLC-20260712-001', status: 'submitted', url: 'https://invoices.example/invoices/70' }, invoiced: true, note: '', projectId: syntheticProject.id, resourceId: 'resource-synthetic', status: 'approved', version: 1, workDate: '2026-07-08', workItemId: null },
      { billable: true, hours: 2, id: 'time-draft', invoice: { draft: true, number: null, status: 'draft' }, invoiced: true, note: '', projectId: syntheticProject.id, resourceId: 'resource-synthetic', status: 'approved', version: 1, workDate: '2026-07-09', workItemId: null },
    ],
  });
  await authenticateSyntheticUser(page);
  await page.goto('finance');
  await page.getByRole('button', { name: 'Time & expenses' }).click();
  const table = page.getByRole('table', { name: 'Time entries' });
  const invoiced = table.getByRole('row').filter({ hasText: '2026-07-08' });
  await expect(invoiced.getByTestId('time-entry-invoice')).toContainText('NESLLC-20260712-001');
  await expect(invoiced.getByRole('link', { name: 'NESLLC-20260712-001' })).toHaveAttribute('href', 'https://invoices.example/invoices/70');
  await expect(invoiced.getByRole('button', { name: 'Edit time entry' })).toHaveCount(0);
  await expect(invoiced.getByRole('button', { name: 'Delete time entry' })).toHaveCount(0);
  const draft = table.getByRole('row').filter({ hasText: '2026-07-09' });
  await expect(draft.getByTestId('time-entry-invoice')).toContainText('Draft invoice');
  await expect(draft.getByRole('button', { name: 'Edit time entry' })).toHaveCount(0);
  const open = table.getByRole('row').filter({ hasText: '2026-07-10' });
  await expect(open.getByRole('button', { name: 'Edit time entry' })).toBeVisible();
  await noHorizontalOverflow(page);
  api.assertNoUnexpectedRequests();
});

test('an engagement with a signed SOW says so, and the Convert dialog shows the SOW and its milestones (AC-I07)', async ({ page }) => {
  await installSyntheticApi(page);
  await installEngagementsApi(page);
  await installBillingApi(page);
  await authenticateSyntheticUser(page);
  await page.goto('engagements/eng-northwind/settings');
  await expect(page.getByTestId('engagement-sow-signed')).toContainText('SOW signed');
  await expect(page.getByTestId('engagement-sow-signed').getByRole('link')).toHaveAttribute('href', SOW.url);
  await page.getByRole('button', { name: 'Convert to project' }).click();
  const dialog = page.getByRole('dialog', { name: 'Convert to project' });
  const sow = dialog.getByTestId('convert-sow');
  await expect(sow).toContainText('Synthetic phase 2 SOW');
  await expect(sow).toContainText('Signed');
  await expect(sow.getByRole('listitem')).toHaveText(['Discovery 40 h', 'Build 80 h']);
  await expect(sow).toContainText('creates no work from it');
  await expectNoSeriousAxe(page);
});
