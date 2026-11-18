import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { settleForAxe } from './fixtures/axe-settle.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';
import { INTAKE_TOKENS, createIntakeWorld, installTicketIntakeApi } from './fixtures/ticket-intake-api.js';

// External ticket intake (D-011, D-021): the reporter's public page at /report/:token and
// the project's Intake links tab. Synthetic data: e2e/fixtures/ticket-intake-api.js.
const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];
// The reference of the fixture's in-progress ticket, which the email link points at.
const LINKED_REFERENCE = 'AAAA1111';

async function expectNoSeriousIssues(page, testInfo, name, include) {
  await settleForAxe(page);
  const results = await new AxeBuilder({ page }).include(include).withTags(wcagTags).analyze();
  await testInfo.attach(`axe-${name}.json`, { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' });
  const serious = results.violations
    .filter((violation) => ['serious', 'critical'].includes(violation.impact))
    .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`);
  expect(serious, name).toEqual([]);
}

async function noHorizontalOverflow(page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no horizontal scrolling').toBeLessThanOrEqual(1);
}

async function openReportPage(page, { hash = '', options = {}, token = INTAKE_TOKENS.valid } = {}) {
  const api = await installSyntheticApi(page);
  const world = await installTicketIntakeApi(page, createIntakeWorld(), options);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`report/${token}${hash}`);
  return { api, errors, world };
}

test.describe('Reporter page', () => {
  test('files a ticket with attachments and shows it in the reporter list, without app chrome', async ({ page }, testInfo) => {
    const { api, errors, world } = await openReportPage(page, { hash: `#ticket-${LINKED_REFERENCE}` });

    await expect(page.getByRole('heading', { level: 1, name: `Report an issue to ${syntheticProject.name}` })).toBeVisible();
    await expect(page.locator('.app-frame > .navbar')).toHaveCount(0);
    await expect(page.getByText('Hello Ann Client.', { exact: false })).toBeVisible();

    const list = page.getByTestId('ticket-report-list');
    await expect(list.getByRole('listitem')).toHaveCount(2);
    const linked = list.locator(`#ticket-${LINKED_REFERENCE}`);
    await expect(linked).toHaveClass(/ticket-report__item--linked/);
    await expect(linked.getByText('In Progress', { exact: true })).toBeVisible();
    await expect(list.getByText('Closed', { exact: true })).toBeVisible();
    await list.getByLabel('Show').selectOption('open');
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await list.getByLabel('Show').selectOption('all');

    await noHorizontalOverflow(page);
    await expectNoSeriousIssues(page, testInfo, 'report-form', '.ticket-report');

    // A missing summary is caught before anything is sent.
    await page.getByRole('button', { name: 'Send report' }).click();
    await expect(page.getByRole('alert')).toHaveText('Check the highlighted fields.');
    const summary = page.getByLabel(/^Summary/);
    await expect(summary).toHaveAttribute('aria-invalid', 'true');
    await expect(summary).toBeFocused();
    await expect(page.getByText('Enter a short summary of the issue.')).toBeVisible();
    expect(world.submissions).toEqual([]);

    // An unsupported file is refused on the spot.
    await page.getByLabel('Attachments').setInputFiles({ buffer: Buffer.from('MZ'), mimeType: 'application/x-msdownload', name: 'tool.exe' });
    await expect(page.getByText(/tool\.exe isn’t a supported file type/)).toBeVisible();
    await page.getByRole('button', { name: 'Remove tool.exe' }).click();
    await expect(page.getByText(/tool\.exe isn’t a supported file type/)).toHaveCount(0);

    await summary.fill('Export button downloads an empty file');
    await page.getByLabel('Severity').selectOption('S2');
    await page.getByLabel('What happened?').fill('The CSV has headers only.');
    await page.getByLabel('Steps to reproduce').fill('1. Open reports\n2. Click Export');
    await page.getByText('More detail (optional)').click();
    await page.getByLabel('Environment').selectOption({ label: 'Production' });
    await page.getByLabel('Found in release').selectOption({ label: '2.4.0' });
    await page.getByLabel('Build or version').fill('2.4.0+build.17');
    await page.getByLabel('Attachments').setInputFiles({ buffer: Buffer.from('screenshot-bytes'), mimeType: 'image/png', name: 'export.png' });
    await expect(page.getByRole('list', { name: 'Chosen files' }).getByText('export.png')).toBeVisible();
    await page.getByRole('button', { name: 'Send report' }).click();

    const success = page.getByTestId('ticket-report-success');
    await expect(success).toContainText('Thanks, we received your report.');
    await expect(success).toContainText('reference CCCC3333');
    await expect(success).toBeFocused();
    await expect(list.getByRole('listitem')).toHaveCount(3);
    await expect(list.getByRole('listitem').first()).toContainText('Export button downloads an empty file');

    expect(world.submissions).toHaveLength(1);
    expect(world.submissions[0]).toMatchObject({
      buildVersion: '2.4.0+build.17',
      description: 'The CSV has headers only.',
      environmentId: 'env-production',
      foundInReleaseId: 'release-2-4',
      name: 'Export button downloads an empty file',
      severity: 'S2',
    });
    expect(world.submissions[0].attachments).toEqual([{ contentBase64: Buffer.from('screenshot-bytes').toString('base64'), contentType: 'image/png', fileName: 'export.png' }]);

    await expectNoSeriousIssues(page, testInfo, 'report-success', '.ticket-report');
    await page.getByRole('button', { name: 'Report another issue' }).click();
    await expect(page.getByLabel(/^Summary/)).toBeFocused();
    await expect(page.getByLabel(/^Summary/)).toHaveValue('');

    expect(errors).toEqual([]);
    api.assertNoUnexpectedRequests();
  });

  test('shows server validation errors against the field', async ({ page }) => {
    const { api } = await openReportPage(page, { options: { invalidSubmission: true } });

    await page.getByLabel(/^Summary/).fill('A summary the server rejects');
    await page.getByRole('button', { name: 'Send report' }).click();

    await expect(page.getByRole('alert')).toHaveText('Check the highlighted fields.');
    await expect(page.getByLabel(/^Summary/)).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText('Enter a summary of up to 200 characters.')).toBeVisible();
    api.assertNoUnexpectedRequests();
  });

  test('an unknown, revoked, or expired link gets a friendly unavailable page', async ({ page }, testInfo) => {
    const { api } = await openReportPage(page, { token: INTAKE_TOKENS.missing });

    const problem = page.getByTestId('ticket-report-unavailable');
    await expect(problem.getByRole('heading', { level: 1, name: 'This link isn’t available' })).toBeFocused();
    await expect(problem).toContainText('Contact the team that sent it to you');
    await expect(page.getByRole('button', { name: 'Send report' })).toHaveCount(0);
    await noHorizontalOverflow(page);
    await expectNoSeriousIssues(page, testInfo, 'report-unavailable', '.ticket-report');
    api.assertNoUnexpectedRequests();
  });
});

test.describe('Project intake links', () => {
  test('shows and copies each active link, creates and emails a new one, and revokes through a confirmation', async ({ context, page }, testInfo) => {
    if (testInfo.project.name.startsWith('chromium')) await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const api = await installSyntheticApi(page);
    const world = await installTicketIntakeApi(page);
    await authenticateSyntheticUser(page);
    await page.goto(`projects/${syntheticProject.id}/tickets`);
    await page.getByRole('button', { name: 'Intake links' }).click();

    const table = page.getByRole('table', { name: 'Intake links' });
    await expect(table.getByRole('row')).toHaveCount(2, { timeout: 10_000 });
    await expect(table.getByTestId('intake-link-url')).toHaveText(`http://127.0.0.1/app/report/${INTAKE_TOKENS.valid}`);
    await table.getByRole('button', { name: 'Copy the link for Ann Client' }).click();
    await expect(table.getByText('Link copied.')).toBeVisible();

    await page.getByLabel('Show').selectOption('all');
    await expect(table.getByRole('row')).toHaveCount(3);
    await expect(table.getByText('No longer works')).toBeVisible();
    await page.getByLabel('Show').selectOption('active');

    await noHorizontalOverflow(page);
    await expectNoSeriousIssues(page, testInfo, 'intake-links', '.intake-links');

    await page.getByRole('button', { name: 'New intake link' }).click();
    const dialog = page.getByRole('dialog', { name: 'New intake link' });
    await dialog.getByRole('button', { name: 'Create and send link' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Enter the reporter’s email address.');
    await dialog.getByLabel('Reporter email').fill('new.reporter@example.com');
    await dialog.getByLabel(/^Reporter name/).fill('New Reporter');
    await dialog.getByLabel(/^Works until/).fill('2099-12-31');
    await expectNoSeriousIssues(page, testInfo, 'intake-new-link', '.rq-dialog');
    await dialog.getByRole('button', { name: 'Create and send link' }).click();

    const sent = page.getByRole('dialog', { name: 'Link sent' });
    await expect(sent.getByText('Sent to new.reporter@example.com.')).toBeVisible();
    await expect(sent.getByTestId('intake-new-link-url')).toHaveText('http://127.0.0.1/app/report/intake-new-0001');
    await sent.getByRole('button', { name: 'Copy link' }).click();
    await expect(sent.getByText('Link copied.')).toBeVisible();
    expect(world.created).toMatchObject({ reporterEmail: 'new.reporter@example.com', reporterName: 'New Reporter' });
    // The end of the chosen local day, which can fall on the next UTC date.
    expect(world.created.expiresAt).toMatch(/^(2099-12-31|2100-01-01)T/);
    await sent.getByRole('button', { name: 'Done' }).click();
    await expect(table.getByRole('row')).toHaveCount(3);

    await table.getByRole('button', { name: 'Revoke the link for New Reporter' }).click();
    const confirm = page.getByRole('dialog', { name: 'Revoke this intake link?' });
    await expect(confirm).toContainText('New Reporter can no longer file tickets');
    await confirm.getByRole('button', { name: 'Revoke link' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(table.getByRole('row')).toHaveCount(2);

    api.assertNoUnexpectedRequests();
  });
});
