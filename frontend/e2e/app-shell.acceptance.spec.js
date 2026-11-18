import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { settleForAxe } from './fixtures/axe-settle.js';
import { installShellApi } from './fixtures/shell-api.js';
import { authenticateSyntheticUser, installSyntheticApi, openTopMenu, syntheticProject } from './fixtures/synthetic-api.js';

const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21aa'];

async function expectNoSeriousAxe(page, testInfo, selector, name) {
  await settleForAxe(page);
  const builder = new AxeBuilder({ page }).withTags(wcagTags);
  for (const item of [selector].flat()) builder.include(item);
  const results = await builder.analyze();
  await testInfo.attach(`axe-${name}.json`, { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
  expect(results.violations.filter(({ impact }) => ['critical', 'serious'].includes(impact))).toEqual([]);
}

async function attachScreenshot(page, testInfo, name) {
  await testInfo.attach(`${name}.png`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
}

async function openNavbarIfCollapsed(page) {
  const toggler = page.getByRole('button', { name: 'Toggle navigation' });
  if (await toggler.isVisible()) {
    await toggler.click();
    await expect(page.locator('#navbarSupportedContent.show:not(.collapsing)')).toBeVisible();
  }
}

async function expectNoHorizontalOverflow(page) {
  const viewport = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth + 1);
}

test.describe('app shell', () => {
  test('navbar search opens grouped, filterable, paginated results with governance deep links', async ({ page }, testInfo) => {
    const api = await installSyntheticApi(page); const shell = await installShellApi(page);
    await authenticateSyntheticUser(page);

    await openNavbarIfCollapsed(page);
    const navbarSearch = page.getByRole('search', { name: 'Workspace' }).getByLabel('Search workspace');
    await navbarSearch.fill('pilot');
    await navbarSearch.press('Enter');
    await expect(page).toHaveURL(/\/app\/search\?q=pilot$/);
    await expect(page.getByRole('heading', { name: 'Search', level: 1 })).toBeVisible();
    await expect(page.getByRole('main').getByRole('status')).toHaveText('27 results for “pilot”');
    // On a phone the collapsed menu closes so the results aren't hidden behind it.
    await expect(page.locator('#navbarSupportedContent')).not.toHaveClass(/show/);

    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { level: 2 })).toHaveText([/Projects/, /Risks, issues & milestones/, /Portfolio & strategy/, /Work items/]);
    await expect(main.getByRole('link', { name: 'Vendor capacity' })).toHaveAttribute('href', `/app/projects/${syntheticProject.id}/governance`);
    await expect(main.getByRole('link', { name: 'Pilot ready' })).toHaveAttribute('href', `/app/projects/${syntheticProject.id}/governance`);
    await expect(main.getByRole('link', { name: 'Customer launch' })).toHaveAttribute('href', '/app/portfolio');
    await expect(main.getByRole('link', { name: 'Pilot task 01' })).toHaveAttribute('href', `/app/projects/${syntheticProject.id}`);
    await expect(main.getByText('Page 1 of 2')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectNoSeriousAxe(page, testInfo, '#main-content', 'search-results');
    await attachScreenshot(page, testInfo, 'search-results');

    await main.getByRole('button', { name: 'Next' }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(main.getByRole('link', { name: 'Pilot task 22' })).toBeVisible();
    await expect(main.getByText('Page 2 of 2')).toBeVisible();
    expect(shell.searchRequests.at(-1)).toMatchObject({ limit: '20', offset: '20', query: 'pilot' });

    await main.getByLabel('Type').selectOption('work');
    await expect(page).toHaveURL(/type=work/);
    await expect(page).not.toHaveURL(/page=/);
    await expect(main.getByRole('status')).toHaveText('23 results for “pilot”');
    expect(shell.searchRequests.at(-1)).toMatchObject({ types: 'epic,story,task' });

    await main.getByLabel('Project').selectOption({ label: 'Archive Migration' });
    await expect(main.getByRole('status')).toHaveText('1 result for “pilot”');
    await expect(main.getByRole('link', { name: 'Archive pilot copy' })).toBeVisible();
    expect(shell.searchRequests.at(-1)).toMatchObject({ projectId: 'project-archive' });

    await main.getByLabel('Search', { exact: true }).fill('nothing-matches');
    await main.getByRole('button', { name: 'Run search' }).click();
    await expect(main.getByRole('heading', { name: 'No matches' })).toBeVisible();

    await page.goto(`search?q=vendor`);
    await main.getByRole('link', { name: 'Vendor capacity' }).click();
    await expect(page).toHaveURL(new RegExp(`/app/projects/${syntheticProject.id}/governance$`));
    api.assertNoUnexpectedRequests();
  });

  test('the search page prompts for a query without calling the API', async ({ page }, testInfo) => {
    const api = await installSyntheticApi(page); const shell = await installShellApi(page);
    await authenticateSyntheticUser(page);
    await page.goto('search');
    await expect(page.getByRole('heading', { name: 'Search your workspace' })).toBeVisible();
    expect(shell.searchRequests).toEqual([]);
    await page.goto('reports');
    await page.getByRole('navigation', { name: 'Search and reporting sections' }).getByRole('button', { name: 'search', exact: true }).click();
    await expect(page.getByText(/Enter a word or phrase to search projects/)).toBeVisible();
    expect(shell.searchRequests).toEqual([]);
    await expectNoSeriousAxe(page, testInfo, '#main-content', 'reports-search-empty');
    api.assertNoUnexpectedRequests();
  });

  test('Rank Projects is hidden from members and a direct visit explains why', async ({ page }, testInfo) => {
    const api = await installSyntheticApi(page);
    await authenticateSyntheticUser(page);
    const plan = await openTopMenu(page, 'Plan');
    await expect(plan.getByRole('link', { name: 'Portfolio' })).toBeVisible();
    await expect(plan.getByRole('link', { name: 'Rank projects' })).toHaveCount(0);
    await page.goto('ranking');
    await expect(page).toHaveURL(/\/app\/\?notice=rankProjects$/);
    const notice = page.getByRole('status').filter({ hasText: 'Rank Projects is available to workspace admins and managers.' });
    await expect(notice).toBeVisible();
    await expectNoSeriousAxe(page, testInfo, ['nav.navbar', 'aside.alert-info'], 'ranking-notice');
    await notice.getByRole('button', { name: 'Dismiss' }).click();
    await expect(page).toHaveURL(/\/app\/$/);
    await expect(notice).toHaveCount(0);
    api.assertNoUnexpectedRequests();
  });

  test('admins still see Rank Projects in the menu', async ({ page }) => {
    const api = await installSyntheticApi(page, { admin: true });
    await authenticateSyntheticUser(page);
    const plan = await openTopMenu(page, 'Plan');
    await expect(plan.getByRole('link', { name: 'Rank projects' })).toBeVisible();
    api.assertNoUnexpectedRequests();
  });

  test('two-factor setup lives in the profile Security tab and the old settings link lands there', async ({ page }, testInfo) => {
    const api = await installSyntheticApi(page); const shell = await installShellApi(page);
    await authenticateSyntheticUser(page);

    // Home shows a notice while two-factor sign-in is off.
    await page.getByRole('link', { name: 'Set up two-factor sign-in' }).click();
    await expect(page).toHaveURL(/\/app\/user\?tab=security$/);
    await page.goto('settings');
    await expect(page).toHaveURL(/\/app\/user\?tab=security$/);
    await expect(page.getByRole('tab', { name: 'Security' })).toHaveAttribute('aria-selected', 'true');
    const twoFactor = page.getByRole('region', { name: 'Two-factor authentication' });
    await expect(twoFactor).toContainText('Off.');

    await twoFactor.getByRole('button', { name: 'Set up' }).click();
    const dialog = page.getByRole('dialog', { name: 'Set up two-factor authentication' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Show QR code' }).click();
    await expect(dialog.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
    await expect(dialog.getByLabel('Verification code')).toBeFocused();
    await dialog.getByLabel('Verification code').fill('000000');
    await dialog.getByRole('button', { name: 'Turn on' }).click();
    await expect(dialog.getByRole('alert')).toContainText('verification code is invalid');
    await dialog.getByLabel('Verification code').fill('123456');
    await dialog.getByRole('button', { name: 'Turn on' }).click();
    const codesDialog = page.getByRole('dialog', { name: 'Save your backup codes' });
    await expect(codesDialog.getByRole('list', { name: 'Backup codes' }).getByRole('listitem')).toHaveCount(8);
    await expectNoSeriousAxe(page, testInfo, 'dialog[open]', 'two-factor-codes');
    await attachScreenshot(page, testInfo, 'two-factor-codes');
    await codesDialog.getByRole('button', { name: 'Done' }).click();
    await expect(codesDialog).toHaveCount(0);
    await expect(twoFactor).toContainText('On.');

    await twoFactor.getByRole('button', { name: 'Backup codes' }).click();
    const viewCodes = page.getByRole('dialog', { name: 'Backup codes' });
    await expect(viewCodes.getByRole('listitem')).toHaveCount(8);
    await viewCodes.getByRole('button', { name: 'Close', exact: true }).last().click();
    await expect(viewCodes).toHaveCount(0);

    await twoFactor.getByRole('button', { name: 'Turn off' }).click();
    const confirm = page.getByRole('dialog', { name: 'Turn off two-factor authentication?' });
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await confirm.getByRole('button', { name: 'Turn off' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(twoFactor).toContainText('Off.');
    expect(shell.twoFactor.events).toEqual(['init', 'enable', 'disable']);

    await expectNoHorizontalOverflow(page);
    await expectNoSeriousAxe(page, testInfo, '#main-content', 'profile-security');
    api.assertNoUnexpectedRequests();
  });

  test('saving the profile after turning on two-factor keeps it on and never sends the flag', async ({ page }) => {
    const api = await installSyntheticApi(page); const shell = await installShellApi(page);
    const saves = [];
    // Like the server, the profile save keeps the stored two-factor flag whatever the form sends.
    await page.route((url) => url.pathname === '/api/users/me', (route) => {
      if (route.request().method() !== 'PUT') return route.fallback();
      const body = route.request().postDataJSON();
      saves.push(body);
      return route.fulfill({ json: { ok: true, user: { email: body.email, firstName: body.firstName, lastName: body.lastName, name: body.profileDisplayName, preferences: { ...body.preferences, twoFactorEnabled: shell.twoFactor.enabled } } } });
    });
    await authenticateSyntheticUser(page);
    await page.goto('user?tab=security');
    const twoFactor = page.getByRole('region', { name: 'Two-factor authentication' });
    await expect(twoFactor).toContainText('Off.');
    await twoFactor.getByRole('button', { name: 'Set up' }).click();
    const dialog = page.getByRole('dialog', { name: 'Set up two-factor authentication' });
    await dialog.getByRole('button', { name: 'Show QR code' }).click();
    await dialog.getByLabel('Verification code').fill('123456');
    await dialog.getByRole('button', { name: 'Turn on' }).click();
    await page.getByRole('dialog', { name: 'Save your backup codes' }).getByRole('button', { name: 'Done' }).click();
    await expect(twoFactor).toContainText('On.');

    // The profile form was loaded while two-factor was off; saving it must not undo that.
    await page.getByRole('tab', { name: 'Preferences' }).click();
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect.poll(() => saves.length).toBe(1);
    expect(Object.hasOwn(saves[0].preferences, 'twoFactorEnabled')).toBe(false);
    await page.getByRole('tab', { name: 'Security' }).click();
    await expect(twoFactor).toContainText('On.');
    api.assertNoUnexpectedRequests();
  });

  test('OAuth applications capture, show and edit redirect URIs', async ({ page }, testInfo) => {
    const api = await installSyntheticApi(page, { admin: true });
    await authenticateSyntheticUser(page);
    await page.goto('admin/integrations');
    const editor = page.locator('dialog[open]');

    await page.getByRole('button', { name: 'Add application' }).click();
    await editor.getByLabel('Name').fill('Partner portal');
    await editor.getByLabel(syntheticProject.name).check();
    const newUri = editor.getByLabel('New redirect URI');
    await newUri.fill('http://partner.example.com/callback');
    await editor.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(editor.getByRole('alert')).toContainText('Use HTTPS');
    await newUri.fill('https://partner.example.com/callback');
    await newUri.press('Enter');
    await expect(editor.getByText('https://partner.example.com/callback', { exact: true })).toBeVisible();
    await expect(editor).toHaveCount(1);
    // Typed but not added: Save still includes it.
    await newUri.fill('http://localhost:8080/callback');
    await expectNoSeriousAxe(page, testInfo, 'dialog[open]', 'oauth-create');
    await attachScreenshot(page, testInfo, 'oauth-create');
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(editor.getByText('Shown once')).toBeVisible();
    await editor.getByRole('button', { name: 'Close', exact: true }).click();
    const partnerRow = page.getByRole('row').filter({ hasText: 'Partner portal' });
    await expect(partnerRow.getByText('https://partner.example.com/callback', { exact: true })).toBeVisible();
    await expect(partnerRow.getByText('http://localhost:8080/callback', { exact: true })).toBeVisible();

    const readerRow = page.getByRole('row').filter({ hasText: 'Portfolio reader' });
    await readerRow.getByRole('button', { name: 'Edit Portfolio reader' }).click();
    await expect(editor.getByRole('heading', { name: 'Edit Portfolio reader' })).toBeVisible();
    await editor.getByLabel('New redirect URI').fill('https://reader.example.com/cb#frag');
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(editor.getByRole('alert')).toContainText('fragment');
    await editor.getByLabel('New redirect URI').fill('https://reader.example.com/cb');
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(editor).toHaveCount(0);
    await expect(readerRow.getByText('https://reader.example.com/cb', { exact: true })).toBeVisible();

    await readerRow.getByRole('button', { name: 'Edit Portfolio reader' }).click();
    await editor.getByRole('button', { name: 'Remove https://reader.example.com/cb' }).click();
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(editor).toHaveCount(0);
    await expect(readerRow.getByText('https://reader.example.com/cb', { exact: true })).toHaveCount(0);
    await expectNoSeriousAxe(page, testInfo, '.integration-page', 'oauth-table');
    api.assertNoUnexpectedRequests();
  });
});

test('choosing a recent project from the Work menu opens it and closes the menu', async ({ page }) => {
  const api = await installSyntheticApi(page);
  await authenticateSyntheticUser(page);
  await page.goto('projects');
  const work = await openTopMenu(page, 'Work');
  const menuItem = work.getByRole('link', { name: syntheticProject.name });
  await expect(menuItem).toBeVisible();
  await menuItem.click();
  await expect(page).toHaveURL(new RegExp(`/projects/${syntheticProject.id}`));
  await expect(menuItem).toBeHidden();
  api.assertNoUnexpectedRequests();
});
