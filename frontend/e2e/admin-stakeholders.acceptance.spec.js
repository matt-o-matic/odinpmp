import { expect, test } from '@playwright/test';
import { authenticateSyntheticUser, installSyntheticApi, openPhoneMenu, syntheticProject } from './fixtures/synthetic-api.js';

test('admin navigation opens user management and invitations', async ({ page }) => {
  await installSyntheticApi(page, { admin: true });
  let invite;
  await page.route('**/api/tenants/**', route => {
    if (route.request().method() === 'POST' && route.request().url().endsWith('/invites')) invite = route.request().postDataJSON();
    return route.fulfill({ json: { tenant_name: 'Synthetic workspace', domains: [], users: [], requests: [], invites: [], statuses: [], task_types: [] } });
  });
  await authenticateSyntheticUser(page);
  await page.goto('projects');
  if (!await page.getByRole('button', { name: 'Account menu' }).isVisible()) await openPhoneMenu(page);
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('link', { name: 'Tenant Admin', exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await page.getByRole('link', { name: /User Management/ }).click();
  await expect(page.getByRole('heading', { name: 'User Management' })).toBeVisible();
  await page.getByRole('tab', { name: /Invites/ }).click();
  await expect(page.getByRole('button', { name: 'Send Invite' })).toBeVisible();
  await page.locator('#invites input[type="email"]').fill('new-user@example.com');
  await page.getByRole('button', { name: 'Send Invite' }).click();
  await expect(page.locator('#invites input[type="email"]')).toHaveValue('');
  expect(invite).toEqual({ email: 'new-user@example.com', role: 'user' });
});

test('project stakeholder creation saves contacts for Bug Reporter', async ({ page }, testInfo) => {
  const api = await installSyntheticApi(page, { admin: true });
  const contacts = [];
  await page.route('**/api/assistant/projects/*/clarifications', route => route.fulfill({ json: { clarifications: [], stakeholders: contacts } }));
  await page.route('**/api/projects/*/requirements/rounds', route => route.fulfill({ json: { ok: true, rounds: [] } }));
  await page.route('**/api/assistant/projects/*/stakeholder-contacts', async route => {
    const contact = { ...route.request().postDataJSON(), id: 'contact-synthetic' };
    contacts.push(contact);
    await route.fulfill({ json: { contact, stakeholders: contacts } });
  });
  await authenticateSyntheticUser(page);
  await page.goto(`projects/${syntheticProject.id}`);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: /Stakeholders/ }).click();
  await expect(page.getByText('No project stakeholders have been added yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Add stakeholder', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add stakeholder' });
  await expect(dialog.getByLabel('Name', { exact: true })).toBeFocused();
  await dialog.getByLabel('Name', { exact: true }).fill('Casey Reporter');
  await dialog.getByLabel('Email', { exact: true }).fill('casey@example.com');
  await dialog.getByLabel('Role or title').fill('Customer tester');
  await page.screenshot({ path: testInfo.outputPath('stakeholder-light.png') });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({ path: testInfo.outputPath('stakeholder-dark.png') });
  expect(await dialog.evaluate(element => element.getBoundingClientRect().width <= innerWidth)).toBe(true);
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  await dialog.getByRole('button', { name: 'Add stakeholder', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'Casey Reporter' })).toBeVisible();
  expect(contacts).toEqual([{ id: 'contact-synthetic', name: 'Casey Reporter', email: 'casey@example.com', roleTitle: 'Customer tester' }]);
  await page.getByRole('button', { name: 'Add stakeholder', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: /Stakeholders/ }).click();
  await expect(page.getByRole('heading', { name: 'Casey Reporter' })).toBeVisible();
  api.assertNoUnexpectedRequests();
});

test('a stakeholder is edited in place and their review rounds are listed', async ({ page }) => {
  const api = await installSyntheticApi(page, { admin: true });
  const contacts = [{ email: 'casey@example.com', id: 'contact-casey', name: 'Casey Reporter', roleTitle: 'Customer tester' }];
  const edits = [];
  await page.route('**/api/assistant/projects/*/clarifications', route => route.fulfill({ json: { clarifications: [], stakeholders: contacts } }));
  await page.route('**/api/projects/*/requirements/rounds', route => route.fulfill({ json: { ok: true, rounds: [
    { dueAt: '2030-11-02T17:00:00.000Z', id: 'round-2', number: 2, reviewers: [{ actorId: 'contact-casey', actorType: 'stakeholder', id: 'r-2', mailStatus: 'sent', required: true, submittedAt: null }], status: 'open', title: 'Client booking', track: 'experience' },
    { dueAt: null, id: 'round-1', number: 1, reviewers: [{ actorId: 'contact-casey', actorType: 'stakeholder', id: 'r-1', mailStatus: 'sent', required: false, submittedAt: '2030-10-20T12:00:00.000Z' }], status: 'closed', title: 'Client booking', track: 'experience' },
  ] } }));
  await page.route('**/api/assistant/projects/*/stakeholder-contacts/contact-casey', async route => {
    const body = route.request().postDataJSON();
    edits.push({ body, method: route.request().method() });
    Object.assign(contacts[0], body);
    await route.fulfill({ json: { contact: contacts[0], stakeholders: contacts } });
  });
  await authenticateSyntheticUser(page);
  await page.goto(`projects/${syntheticProject.id}`);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: /Stakeholders/ }).click();

  const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Casey Reporter' }) });
  await expect(card.getByText('2 reviews')).toBeVisible();
  await expect(card.getByRole('link', { name: 'Experience round 2 · Client booking' })).toBeVisible();
  await expect(card.getByRole('listitem').filter({ hasText: 'Experience round 2' })).toContainText('Not submitted · due');
  await expect(card.getByRole('listitem').filter({ hasText: 'Experience round 2' })).toContainText('required · invitation sent');
  await expect(card.getByRole('listitem').filter({ hasText: 'Experience round 1' })).toContainText('Submitted');

  await card.getByRole('button', { name: 'Edit Casey Reporter' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit stakeholder' });
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Casey Reporter');
  await dialog.getByLabel('Name', { exact: true }).fill('Casey Rivera');
  await dialog.getByLabel('Role or title').fill('Operations lead');
  await expect(dialog.getByText('Odin sends their next emails to the new address.')).toHaveCount(0);
  await dialog.getByLabel('Email', { exact: true }).fill('casey.rivera@example.com');
  await expect(dialog.getByText(/Odin sends their next emails to the new address/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'Casey Rivera' })).toBeVisible();
  await expect(page.getByText('Operations lead')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Stakeholder updated.' })).toBeVisible();
  expect(edits).toEqual([{ body: { email: 'casey.rivera@example.com', name: 'Casey Rivera', roleTitle: 'Operations lead' }, method: 'PATCH' }]);
  api.assertNoUnexpectedRequests();
});
