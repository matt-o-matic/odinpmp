import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { installAdminScreensApi } from './fixtures/admin-screens-api.js';
import { settleForAxe } from './fixtures/axe-settle.js';
import { authenticateSyntheticUser, installSyntheticApi, openPhoneMenu, syntheticProject } from './fixtures/synthetic-api.js';

const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];

async function expectAccessible(page, testInfo, name) {
  await settleForAxe(page);
  const results = await new AxeBuilder({ page }).include('#main-content').withTags(wcagTags).analyze();
  await testInfo.attach(`axe-${name}.json`, { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' });
  expect(results.violations, `${name}: ${results.violations.map((violation) => violation.id).join(', ')}`).toEqual([]);
}

async function expectNoHorizontalOverflow(page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

async function openAccountMenuLink(page, name) {
  if (!await page.getByRole('button', { name: 'Account menu' }).isVisible()) await openPhoneMenu(page);
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('link', { name, exact: true }).click();
}

test('compliance sections browse, edit, and explain blocked actions', async ({ page }, testInfo) => {
  // One walkthrough of every compliance section, which takes WebKit close to the default 30 s.
  test.setTimeout(90_000);
  const api = await installSyntheticApi(page, { admin: true });
  const admin = await installAdminScreensApi(page);
  await authenticateSyntheticUser(page);
  await page.goto('projects');
  await openAccountMenuLink(page, 'Compliance');
  await expect(page).toHaveURL(/\/admin\/compliance$/);
  await expect(page.getByRole('heading', { name: 'Compliance', exact: true })).toBeVisible();

  // Policy: read-only until Edit, one focused form, versioned save.
  await expect(page.getByRole('definition').filter({ hasText: 'United States' })).toBeVisible();
  await expectAccessible(page, testInfo, 'compliance-policy');
  await page.getByRole('button', { name: 'Edit policy' }).click();
  const policyDialog = page.getByRole('dialog', { name: 'Edit compliance policy' });
  await expect(policyDialog.getByLabel('Data region')).toBeFocused();
  await policyDialog.getByLabel('Audit log retention (days)').fill('20');
  await policyDialog.getByRole('button', { name: 'Save policy' }).click();
  await expect(policyDialog.getByText('Enter a whole number from 30 to 3650.')).toBeVisible();
  await policyDialog.getByLabel('Audit log retention (days)').fill('730');
  await policyDialog.getByLabel('Data region').selectOption('eu');
  await page.screenshot({ path: testInfo.outputPath('compliance-policy-dialog.png') });
  await policyDialog.getByRole('button', { name: 'Save policy' }).click();
  await expect(policyDialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'Compliance policy saved.' })).toBeVisible();
  await expect(page.getByRole('definition').filter({ hasText: 'European Union' })).toBeVisible();
  expect(admin.calls.find((call) => call.path === '/api/compliance/policy').body).toEqual({ auditRetentionDays: 730, dataRegion: 'eu', expectedVersion: 2, legalHold: false, privacyDeletionDays: 30, wormRetentionDays: 365 });

  // Audit exports: storage-not-configured is explained in the dialog.
  await page.getByRole('link', { name: 'Audit exports' }).click();
  await expect(page).toHaveURL(/\/admin\/compliance\/exports$/);
  await expect(page.getByRole('cell', { name: '2026-09-01 to 2026-09-30' })).toBeVisible();
  await expectAccessible(page, testInfo, 'compliance-exports');
  await page.getByRole('button', { name: 'New export' }).click();
  const exportDialog = page.getByRole('dialog', { name: 'New audit export' });
  await exportDialog.getByRole('button', { name: 'Create export' }).click();
  await expect(exportDialog.getByRole('alert')).toContainText('Immutable evidence storage is not configured');
  await exportDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(exportDialog).toBeHidden();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /^Download export created/ }).click();
  expect((await download).suggestedFilename()).toBe('audit-evidence-export-1.json');

  // Legal holds: a held project that was soft-deleted keeps its name; the picker lists live
  // projects by name; release needs a reason.
  await page.getByRole('link', { name: 'Legal holds' }).click();
  await expect(page.getByRole('cell', { name: /^Synthetic Delivery Plan/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: /^Retired Pilot \(deleted\)/ })).toBeVisible();
  await page.getByLabel('Status').selectOption('all');
  await expect(page.getByRole('cell', { name: /^Export 2026-09-01 to 2026-09-30/ })).toBeVisible();
  await expectAccessible(page, testInfo, 'compliance-legal-holds');
  await page.getByRole('button', { name: 'Place hold' }).click();
  const holdDialog = page.getByRole('dialog', { name: 'Place legal hold' });
  await expect(holdDialog.getByLabel('Project', { exact: true }).locator('option')).toHaveText(['Choose…', syntheticProject.name]);
  await holdDialog.getByLabel('Record type').selectOption('privacy_subject');
  await holdDialog.getByLabel('Person (privacy subject)').selectOption({ label: 'Evan Member (evan@example.com)' });
  await holdDialog.getByLabel('Reason').fill('Preserve records for the pending employment claim.');
  await holdDialog.getByRole('button', { name: 'Place hold' }).click();
  await expect(holdDialog).toBeHidden();
  expect(admin.calls.find((call) => call.path === '/api/compliance/legal-holds').body).toEqual({ reason: 'Preserve records for the pending employment claim.', resourceId: 'user-evan', resourceType: 'privacy_subject' });
  await page.getByRole('button', { name: 'Release hold on Synthetic Delivery Plan' }).click();
  const releaseDialog = page.getByRole('dialog', { name: 'Release legal hold' });
  await releaseDialog.getByLabel('Release reason').fill('Vendor dispute settled; counsel approved release.');
  await releaseDialog.getByRole('button', { name: 'Release hold' }).click();
  await expect(releaseDialog).toBeHidden();
  expect(admin.calls.find((call) => call.path === '/api/compliance/legal-holds/hold-active/release').body).toEqual({ expectedVersion: 1, reason: 'Vendor dispute settled; counsel approved release.' });

  // Attestations: create-only, details by inline expansion.
  await page.getByRole('link', { name: 'Attestations' }).click();
  await page.getByRole('button', { name: 'Show statement and evidence for legal_hold' }).click();
  await expect(page.getByText('Legal holds were reviewed weekly')).toBeVisible();
  await expectAccessible(page, testInfo, 'compliance-attestations');
  await page.getByRole('button', { name: 'New attestation' }).click();
  const attestationDialog = page.getByRole('dialog', { name: 'New control attestation' });
  await attestationDialog.getByLabel('Control key').fill('privacy_rights');
  await attestationDialog.getByLabel('Period start').fill('2026-07-01');
  await attestationDialog.getByLabel('Period end').fill('2026-09-30');
  await attestationDialog.getByLabel('Statement').fill('Every erasure request this quarter was executed by a second administrator.');
  await attestationDialog.getByLabel('Evidence references').fill('privacy-olive\nhttps://docs.example.com/privacy/q3');
  await attestationDialog.getByRole('button', { name: 'Record attestation' }).click();
  await expect(attestationDialog).toBeHidden();
  await expect(page.getByRole('cell', { name: 'privacy_rights', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Edit|^Delete/ })).toHaveCount(0);

  // Privacy erasure: execute only another admin's request, behind a typed confirmation.
  await page.getByRole('link', { name: 'Privacy erasure' }).click();
  await expect(page.getByText('Waiting for another administrator')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Execute erasure for Drew Member' })).toHaveCount(0);
  await expectAccessible(page, testInfo, 'compliance-privacy');
  await page.getByRole('button', { name: 'Execute erasure for Casey Member' }).click();
  const eraseDialog = page.getByRole('dialog', { name: 'Erase personal data' });
  await expect(eraseDialog.getByText('This cannot be undone.')).toBeVisible();
  await expect(eraseDialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  const eraseButton = eraseDialog.getByRole('button', { name: 'Erase personal data' });
  await expect(eraseButton).toBeDisabled();
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({ path: testInfo.outputPath('compliance-erasure-dark.png') });
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  await eraseDialog.getByLabel('Type ERASE to confirm').fill('ERASE');
  await eraseButton.click();
  await expect(eraseDialog).toBeHidden();
  expect(admin.calls.find((call) => call.path === '/api/compliance/privacy-erasure-requests/privacy-olive/execute').body).toEqual({ expectedVersion: 1 });
  await page.getByLabel('Status').selectOption('completed');
  await expect(page.getByText('identity pseudonymized, 2 sessions revoked')).toBeVisible();

  await expectNoHorizontalOverflow(page);
  api.assertNoUnexpectedRequests();
});

test('ticket environments and releases edit as one list with a conflict guard', async ({ page }, testInfo) => {
  const api = await installSyntheticApi(page, { admin: true });
  const admin = await installAdminScreensApi(page);
  await authenticateSyntheticUser(page);
  await page.goto('projects');
  await openAccountMenuLink(page, 'Ticket environments & releases');
  await expect(page).toHaveURL(/\/admin\/ticketing$/);
  await expect(page.getByRole('heading', { name: 'Environments', exact: true })).toBeVisible();

  // Read-only list with filters: inactive UAT is hidden until the status filter includes it.
  await expect(page.getByRole('cell', { name: 'UAT' })).toHaveCount(0);
  await page.getByLabel('Status').selectOption('all');
  await expect(page.getByRole('cell', { name: 'UAT' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Name' })).toHaveCount(0);
  await expectAccessible(page, testInfo, 'ticket-config-read');

  await page.getByRole('button', { name: 'Edit list' }).click();
  await expect(page.getByRole('button', { name: /^Save environments/ })).toBeDisabled();
  await page.getByLabel('Name').nth(1).fill('Pre-production');
  await page.getByLabel('Available in').nth(1).selectOption({ label: syntheticProject.name });
  await page.getByRole('button', { name: 'Reactivate UAT' }).click();
  await page.getByRole('button', { name: 'Deactivate Development' }).click();
  await page.getByRole('button', { name: 'Move Production up' }).click();
  await page.getByRole('button', { name: 'Add environment' }).click();
  await page.getByLabel('Name').last().fill('Hotfix');
  await expectAccessible(page, testInfo, 'ticket-config-edit');
  await page.screenshot({ path: testInfo.outputPath('ticket-config-edit.png'), fullPage: true });
  await page.getByRole('button', { name: 'Save environments' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Environments saved.' })).toBeVisible();
  expect(admin.calls.at(-1).body).toEqual({
    entries: [
      { id: 'env-development', name: 'Development', projectId: null, sortOrder: 0, status: 'inactive' },
      { id: 'env-staging', name: 'Pre-production', projectId: syntheticProject.id, sortOrder: 1, status: 'active' },
      { id: 'env-production', name: 'Production', projectId: null, sortOrder: 2, status: 'active' },
      { id: 'env-uat', name: 'UAT', projectId: null, sortOrder: 3, status: 'active' },
      { name: 'Hotfix', projectId: null, sortOrder: 4, status: 'active' },
    ],
    expectedRevision: 'rev-environments-1',
  });
  await expect(page.getByRole('cell', { name: 'Pre-production' })).toBeVisible();
  await page.getByLabel('Status').selectOption('active');
  await expect(page.getByRole('cell', { name: 'Development' })).toHaveCount(0);

  // Another admin saved in between: the save is refused and the list reloads on request.
  await page.getByRole('link', { name: 'Releases' }).click();
  await expect(page.getByRole('heading', { name: 'Releases', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit list' }).click();
  await page.getByRole('button', { name: 'Add release' }).click();
  await page.getByLabel('Name').last().fill('2026.10.0');
  admin.control.conflictNextTicketConfigSave = true;
  await page.getByRole('button', { name: 'Save releases' }).click();
  await expect(page.getByRole('alert')).toContainText('Another administrator saved this list');
  await page.getByRole('button', { name: 'Reload list' }).click();
  await expect(page.getByRole('button', { name: 'Edit list' })).toBeVisible();

  // Leaving with unsaved edits asks first.
  await page.getByRole('button', { name: 'Edit list' }).click();
  await page.getByLabel('Name').first().fill('2026.09.1');
  await page.getByRole('link', { name: 'Environments' }).click();
  const discard = page.getByRole('dialog', { name: 'Discard unsaved changes?' });
  await expect(discard).toBeVisible();
  await discard.getByRole('button', { name: 'Cancel' }).click();
  await expect(page).toHaveURL(/\/admin\/ticketing\/releases$/);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await discard.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page.getByRole('button', { name: 'Edit list' })).toBeVisible();

  await expectNoHorizontalOverflow(page);
  api.assertNoUnexpectedRequests();
});

test('project tickets pick environment and releases from the project-scoped lists', async ({ page }, testInfo) => {
  const api = await installSyntheticApi(page, { admin: true });
  const admin = await installAdminScreensApi(page);
  await authenticateSyntheticUser(page);
  await page.goto(`projects/${syntheticProject.id}/tickets`);
  await expect(page.getByRole('heading', { name: 'Tickets', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'New ticket' }).click();
  const environment = page.getByRole('combobox', { name: /^Environment/ });
  await expect(environment.locator('option')).toHaveText(['Not set', 'Development', 'Staging', 'Production']);
  await page.getByLabel('Summary').fill('Login fails on staging');
  await environment.selectOption({ label: 'Staging' });
  await page.getByLabel('Found in release').selectOption({ label: 'Pilot RC1' });
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const created = admin.calls.find((call) => call.method === 'POST' && call.path.endsWith('/items')).body;
  expect(created.item).toMatchObject({ environmentId: 'env-staging', foundInReleaseId: 'rel-pilot', name: 'Login fails on staging' });

  await page.getByRole('button', { name: 'List', exact: true }).click();
  const row = page.getByRole('row', { name: /Checkout total rounds down/ });
  await expect(row.getByRole('cell', { name: 'UAT (inactive)' })).toBeVisible();
  await expectAccessible(page, testInfo, 'project-ticket-list');
  await page.getByRole('button', { name: 'Edit environment and releases for Checkout total rounds down' }).click();
  const dialog = page.getByRole('dialog', { name: 'Environment and releases' });
  await expect(dialog.getByRole('combobox', { name: /^Environment/ })).toHaveValue('env-uat');
  await dialog.getByLabel('Fixed in release').selectOption({ label: 'Pilot RC1' });
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  const patch = admin.calls.find((call) => call.method === 'PATCH').body;
  expect(patch).toEqual({ expectedVersion: 4, patch: { fixedInReleaseId: 'rel-pilot' } });
  await expect(row.getByRole('cell', { name: 'Pilot RC1' })).toBeVisible();

  await expectNoHorizontalOverflow(page);
  api.assertNoUnexpectedRequests();
});
