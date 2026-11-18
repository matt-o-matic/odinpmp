import { expect, test } from '@playwright/test';

import { defaultRequirementsScenario, installRequirementsApi } from './fixtures/requirements-api.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

// Synthetic data only: see e2e/fixtures/requirements-api.js.
const base = `projects/${syntheticProject.id}/requirements`;
const AI_LABELS = /AI proposal|drafted by AI|AI-drafted|AI generated|AI-generated/i;

async function open(page, path, adjust = () => {}) {
  const scenario = defaultRequirementsScenario();
  adjust(scenario);
  const api = await installSyntheticApi(page);
  const requirements = await installRequirementsApi(page, scenario);
  await authenticateSyntheticUser(page);
  await page.goto(path);
  return { api, requirements };
}

test.describe('Requirements Decide stage', () => {
  test('the decision log shows outcomes, owners, and the supersedes chain', async ({ page }) => {
    const { api } = await open(page, `${base}/experience/decide`);
    const log = page.getByRole('region', { name: 'Decision log' });
    const entries = log.getByRole('listitem');
    await expect(entries).toHaveCount(3);
    await expect(entries.nth(0)).toContainText('D-03');
    await expect(entries.nth(0)).toContainText('Preference · keep');
    await expect(entries.nth(1)).toContainText('D-02');
    await expect(entries.nth(1)).toContainText('Agreed');
    await expect(entries.nth(1)).toContainText('Morgan Lee');
    await expect(entries.nth(1)).toContainText('supersedes D-01');
    await expect(entries.nth(2)).toContainText('Superseded');
    await expect(entries.nth(2)).toContainText('replaced by D-02');

    await entries.nth(1).getByRole('button', { name: 'D-01' }).click();
    await expect(entries.nth(2)).toBeFocused();

    const waiting = page.getByRole('region', { name: 'Waiting for a decision' });
    await expect(waiting.getByRole('link', { name: /^Decide: / })).toHaveCount(2);
    await expect(page.locator('.rq-workspace')).not.toContainText(AI_LABELS);
    api.assertNoUnexpectedRequests();
  });

  test('a manager accepts a proposed preference after editing it, and it joins the log in their name', async ({ page }) => {
    const { api, requirements } = await open(page, base);
    // A round's preferences stay on its round page: only the topic one waits here.
    await expect(page.getByRole('link', { name: 'Decide: Preference: Keep the 14px body text on booking screens.' })).toHaveCount(0);
    await page.getByRole('link', { name: 'Decide: Preference: Keep the price card to one line.' }).click();
    await expect(page).toHaveURL(/\/experience\/decide\?preference=summary-price(%3A|:)0$/);
    const queue = page.getByRole('region', { name: 'Proposed preferences' });
    await expect(queue.getByRole('listitem')).toHaveCount(1);
    const proposal = queue.getByRole('listitem').filter({ hasText: 'Keep the price card to one line.' });
    await expect(proposal).toBeFocused();

    await proposal.getByRole('button', { name: /^Accept preference:/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Accept preference' });
    await expect(dialog.getByLabel('Preference')).toBeFocused();
    await dialog.getByLabel('Preference').fill('Keep the price card to one line on every screen.');
    await dialog.getByRole('button', { name: 'Accept preference' }).click();
    await expect(dialog).toBeHidden();

    await expect(queue.getByText('No preferences are waiting.')).toBeVisible();
    const newest = page.getByRole('region', { name: 'Decision log' }).getByRole('listitem').first();
    await expect(newest).toContainText('Keep the price card to one line on every screen.');
    await expect(newest).toContainText('Synthetic Demo');
    const call = requirements.calls.find((entry) => entry.path === '/preferences/accept');
    expect(call.body).toMatchObject({ dimension: 'density', key: 'summary-price:0', sourceSummaryId: 'summary-price', stance: 'keep', track: 'experience' });
    api.assertNoUnexpectedRequests();
  });

  test('without decision rights the queue is read-only', async ({ page }) => {
    const { api } = await open(page, `${base}/experience/decide`, (scenario) => {
      scenario.canDecide = false;
      scenario.projectRole = 'member';
    });
    await expect(page.getByRole('region', { name: 'Proposed preferences' }).getByText('Keep the price card to one line.')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Accept preference/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /^Decide: / })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Waiting for a decision' }).getByRole('link', { name: /^Open: / })).toHaveCount(2);
    api.assertNoUnexpectedRequests();
  });

  test('Functional\'s Review stage opens the project\'s one Review tab, and Plan & work says when there is nothing yet', async ({ page }) => {
    const { api } = await open(page, `${base}/architecture/discuss`);
    const stages = page.getByRole('navigation', { name: 'Functional stages' });
    await expect(stages.getByRole('link', { name: /Review/ })).toHaveAttribute('href', /\/requirements\/review$/);
    await stages.getByRole('link', { name: /Plan & work/ }).click();
    await expect(page.getByRole('region', { name: 'Functional plan' }).getByText('No plan yet')).toBeVisible();
    api.assertNoUnexpectedRequests();
  });
});

test.describe('Requirements stakeholder links', () => {
  test('a manager creates a link (shown once, copyable), extends one, and revokes one', async ({ page, context }, testInfo) => {
    if (testInfo.project.name.startsWith('chromium')) await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const { api, requirements } = await open(page, base);
    await page.getByRole('link', { name: 'Stakeholder links' }).click();
    await expect(page.getByRole('heading', { name: 'Stakeholder links' })).toBeFocused();
    const table = page.getByRole('table', { name: 'Stakeholder links' });
    await expect(table.getByRole('row').filter({ hasText: 'Ravi Shah' })).toContainText('While involved, then 14 days');

    await page.getByRole('button', { name: 'New link' }).click();
    const create = page.getByRole('dialog', { name: 'New stakeholder link' });
    await create.getByLabel('Stakeholder').selectOption('stakeholder-jamie');
    // Emailing the link is the default; without it the link is shown once to copy.
    await expect(create.getByRole('button', { name: 'Send link' })).toBeVisible();
    await create.getByRole('checkbox', { name: 'Email the link to jamie.ortiz@client.example' }).uncheck();
    await create.getByRole('button', { name: 'Create link' }).click();
    const created = page.getByRole('dialog', { name: 'Link created' });
    await expect(created.getByTestId('rq-new-link-url')).toHaveText('http://127.0.0.1/app/requirements/synthetic-once-token');
    await expect(created.getByText('This is the only time the full link is shown.', { exact: false })).toBeVisible();
    await created.getByRole('button', { name: 'Copy link' }).click();
    await expect(created.getByRole('status')).toHaveText(/Link copied\.|Copying failed/);
    await created.getByRole('button', { name: 'Done' }).click();
    await expect(created).toBeHidden();
    await expect(page.getByText('synthetic-once-token')).toHaveCount(0);
    await expect(table.getByRole('row').filter({ hasText: 'Jamie Ortiz' })).toContainText('Active');

    await table.getByRole('button', { name: 'Extend the link for Ravi Shah' }).click();
    const extend = page.getByRole('dialog', { name: 'Extend link' });
    await expect(extend.getByLabel('Keep valid until')).not.toHaveValue('');
    await extend.getByRole('button', { name: 'Extend link' }).click();
    await expect(extend).toBeHidden();
    await expect(page.getByRole('status').filter({ hasText: 'Link for Ravi Shah extended.' })).toBeVisible();
    const extendCall = requirements.calls.find((entry) => entry.path === '/links/link-ravi/extend');
    expect(Date.parse(extendCall.body.until)).toBeGreaterThan(Date.now());

    await table.getByRole('button', { name: 'Revoke the link for Jamie Ortiz' }).click();
    await page.getByRole('dialog', { name: 'Revoke this link?' }).getByRole('button', { name: 'Revoke link' }).click();
    const jamie = table.getByRole('row').filter({ hasText: 'Jamie Ortiz' });
    await expect(jamie).toContainText('Revoked');
    await expect(jamie.getByRole('button')).toHaveCount(0);
    api.assertNoUnexpectedRequests();
  });

  test('members cannot reach link management', async ({ page }) => {
    const { api, requirements } = await open(page, `${base}/links`, (scenario) => {
      scenario.canDecide = false;
      scenario.projectRole = 'member';
    });
    await expect(page.getByText('Only project admins and managers can manage stakeholder links.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'New link' })).toHaveCount(0);
    expect(requirements.calls.some((call) => call.path === '/links')).toBe(false);
    api.assertNoUnexpectedRequests();
  });
});
