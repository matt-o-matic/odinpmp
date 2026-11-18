import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { defaultRequirementsScenario, emptyRequirementsScenario, installRequirementsApi } from './fixtures/requirements-api.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';
import { settleForAxe } from './fixtures/axe-settle.js';

// Every new Requirements view passes axe with no serious or critical issues.
// Synthetic data only: see e2e/fixtures/requirements-api.js.
const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];
const base = `projects/${syntheticProject.id}/requirements`;

async function expectNoSeriousIssues(page, testInfo, name) {
  await settleForAxe(page);
  const results = await new AxeBuilder({ page }).include('.rq-workspace').withTags(wcagTags).analyze();
  await testInfo.attach(`axe-${name}.json`, { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' });
  const serious = results.violations
    .filter((violation) => ['serious', 'critical'].includes(violation.impact))
    .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`);
  expect(serious, name).toEqual([]);
}

async function expectNoSeriousIssuesInDialog(page, testInfo, name) {
  await settleForAxe(page);
  const results = await new AxeBuilder({ page }).include('dialog[open]').withTags(wcagTags).analyze();
  await testInfo.attach(`axe-${name}.json`, { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' });
  expect(results.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact)).map((violation) => violation.id), name).toEqual([]);
}

async function open(page, scenario = defaultRequirementsScenario()) {
  const api = await installSyntheticApi(page);
  await installRequirementsApi(page, scenario);
  await authenticateSyntheticUser(page);
  return api;
}

test.describe('Requirements accessibility', () => {
  test('every view has no serious or critical axe issues', async ({ page }, testInfo) => {
    // Twelve page loads plus axe runs: allow for a busy dev server under parallel workers.
    test.setTimeout(120_000);
    const api = await open(page);
    const views = [
      ['my-items', base, () => page.getByRole('region', { name: 'Needs your decision' })],
      ['discuss', `${base}/experience/discuss`, () => page.getByRole('list', { name: 'Experience topics' }).getByText('Should clients see an estimated price before they pick a time?')],
      ['brief', `${base}/experience/brief`, () => page.getByText('Clients book a home visit in under two minutes.')],
      ['decide', `${base}/experience/decide`, () => page.getByRole('region', { name: 'Decision log' }).getByText('D-03')],
      ['review', `${base}/experience/review`, () => page.getByRole('region', { name: 'Review packages' }).getByRole('listitem').first()],
      ['package', `${base}/experience/review/packages/package-3`, () => page.getByRole('region', { name: 'What changed since round 2' })],
      ['plan', `${base}/architecture/plan`, () => page.getByText('No plan yet')],
      ['topic', `${base}/topics/topic-price`, () => page.getByRole('region', { name: 'Record a decision' })],
      ['topic-not-enough-input', `${base}/topics/topic-reminder`, () => page.getByText('Not enough input yet')],
      ['topic-decided', `${base}/topics/topic-home`, () => page.getByText('Recorded by Morgan Lee', { exact: false })],
      ['links', `${base}/links`, () => page.getByRole('table', { name: 'Stakeholder links' })],
    ];
    for (const [name, path, ready] of views) {
      await page.goto(path);
      await expect(ready()).toBeVisible();
      await expectNoSeriousIssues(page, testInfo, name);
    }

    await page.goto(`${base}/topics/topic-price`);
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await expect(page.getByRole('region', { name: 'Record a decision' })).toBeVisible();
    await expectNoSeriousIssues(page, testInfo, 'topic-dark');
    api.assertNoUnexpectedRequests();
  });

  test('empty states have no serious or critical axe issues', async ({ page }, testInfo) => {
    const api = await open(page, emptyRequirementsScenario());
    await page.goto(base);
    await expect(page.getByText('Nothing is waiting on you.')).toBeVisible();
    await expectNoSeriousIssues(page, testInfo, 'my-items-empty');
    await page.goto(`${base}/experience/discuss`);
    await expect(page.getByText('No topics yet.')).toBeVisible();
    await expectNoSeriousIssues(page, testInfo, 'discuss-empty');
    await page.goto(`${base}/experience/review`);
    await expect(page.getByText('No packages yet')).toBeVisible();
    await expectNoSeriousIssues(page, testInfo, 'review-empty');
    api.assertNoUnexpectedRequests();
  });

  test('dialogs are labeled, keep focus inside, close on Escape, and return focus', async ({ page }, testInfo) => {
    const api = await open(page);
    await page.goto(`${base}/topics/topic-price`);
    const opener = page.getByRole('button', { name: 'Assign' });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Edit topic' });
    await expect(dialog.getByRole('tab', { name: /People/ })).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.getByLabel('Owner')).toBeFocused();
    await expectNoSeriousIssuesInDialog(page, testInfo, 'assign-dialog');
    for (let step = 0; step < 12; step += 1) {
      await page.keyboard.press('Tab');
      const inside = await dialog.evaluate((element) => element.contains(document.activeElement) || document.activeElement === document.body);
      expect(inside).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();

    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Edit topic' }).getByLabel('Question')).toBeFocused();
    await expectNoSeriousIssuesInDialog(page, testInfo, 'edit-dialog');
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expectNoSeriousIssuesInDialog(page, testInfo, 'delete-dialog');
    await page.keyboard.press('Escape');
    api.assertNoUnexpectedRequests();
  });

  test('the workspace tabs, stage tabs, and register work from the keyboard', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'chromium-mobile', 'Keyboard-only flow is checked on desktop.');
    const api = await open(page);
    await page.goto(base);
    const views = page.getByRole('navigation', { name: 'Requirements views' });
    await views.getByRole('link', { name: 'Experience' }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/experience\/discuss$|\/experience$/);
    const stages = page.getByRole('navigation', { name: 'Experience stages' });
    await stages.getByRole('link', { name: /Decide/ }).focus();
    await page.keyboard.press('Enter');
    await expect(stages.getByRole('link', { name: /Decide/ })).toHaveAttribute('aria-current', 'page');
    await stages.getByRole('link', { name: /Discuss/ }).focus();
    await page.keyboard.press('Enter');

    const filters = page.getByRole('group', { name: 'Show topics' });
    await filters.getByRole('radio', { name: 'Needs a decision first' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(filters.getByRole('radio', { name: 'Open · 4' })).toBeChecked();

    await page.getByRole('link', { name: 'Do technicians see client notes before the visit?' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Do technicians see client notes before the visit?' })).toBeFocused();
    api.assertNoUnexpectedRequests();
  });
});
