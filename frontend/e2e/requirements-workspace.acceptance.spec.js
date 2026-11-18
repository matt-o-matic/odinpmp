import { expect, test } from '@playwright/test';

import { emptyRequirementsScenario, installRequirementsApi, myItemsScenario } from './fixtures/requirements-api.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

// Synthetic data only: see e2e/fixtures/requirements-api.js.

async function openRequirements(page, scenario) {
  const api = await installSyntheticApi(page);
  const requirements = await installRequirementsApi(page, scenario);
  const consoleErrors = [];
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  await authenticateSyntheticUser(page);
  await page.goto(`projects/${syntheticProject.id}/requirements`);
  return { api, consoleErrors, requirements };
}

test.describe('Requirements workspace: My open items', () => {
  test('a manager sees exactly their four items in the right groups, each with its track', async ({ page }) => {
    const { api, consoleErrors } = await openRequirements(page, myItemsScenario());

    const projectTabs = page.getByRole('navigation', { name: 'Project workspace tabs' });
    const requirementsTab = projectTabs.getByRole('link', { name: /Requirements/ });
    await expect(requirementsTab).toHaveAttribute('aria-current', 'page');
    await expect(requirementsTab).toContainText('4');

    const views = page.getByRole('navigation', { name: 'Requirements views' });
    await expect(views.getByRole('link', { name: /My open items/ })).toHaveAttribute('aria-current', 'page');

    const decide = page.getByRole('region', { name: 'Needs your decision' });
    const answer = page.getByRole('region', { name: 'Needs your answer' });
    const review = page.getByRole('region', { name: 'Needs your review' });
    await expect(decide.getByRole('listitem')).toHaveCount(2);
    await expect(answer.getByRole('listitem')).toHaveCount(1);
    await expect(review.getByRole('listitem')).toHaveCount(1);
    await expect(page.getByRole('region', { name: 'Your drafts' })).toHaveCount(0);
    await expect(page.locator('.rq-item')).toHaveCount(4);

    await expect(decide.getByText('Should clients see an estimated price before they pick a time?')).toBeVisible();
    await expect(decide.getByRole('link', { name: /^Decide: / })).toHaveCount(2);
    await expect(answer.getByText('Do technicians see client notes before the visit?')).toBeVisible();
    await expect(answer.getByRole('link', { name: /^Reply: / })).toBeVisible();
    await expect(review.getByText('Round 2')).toBeVisible();
    await expect(review.getByText(/^due /)).toBeVisible();
    for (const item of await page.locator('.rq-item').all()) {
      await expect(item.locator('.rq-track-chip')).toHaveText(/Experience|Functional/);
    }

    await decide.getByRole('link', { name: 'Decide: Should clients see an estimated price before they pick a time?' }).click();
    await expect(page).toHaveURL(/\/requirements\/topics\/topic-price\?focus=decision$/);
    await expect(page.getByLabel('Decision statement', { exact: true })).toBeFocused();

    expect(consoleErrors).toEqual([]);
    api.assertNoUnexpectedRequests();
  });

  test('a viewer sees no decision group and no decision-only controls', async ({ page }) => {
    const scenario = myItemsScenario();
    scenario.canDecide = false;
    scenario.projectRole = 'viewer';
    const { api } = await openRequirements(page, scenario);

    await expect(page.getByRole('region', { name: 'Needs your answer' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Needs your review' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Needs your decision' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /^Decide: / })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Stakeholder links' })).toHaveCount(0);
    api.assertNoUnexpectedRequests();
  });

  test('with nothing waiting, the empty state says so and links to both tracks', async ({ page }) => {
    const { api } = await openRequirements(page, emptyRequirementsScenario());

    await expect(page.getByText('Nothing is waiting on you.')).toBeVisible();
    const projectTabs = page.getByRole('navigation', { name: 'Project workspace tabs' });
    await expect(projectTabs.getByRole('link', { name: /Requirements/ })).not.toContainText(/\d/);
    await page.locator('.rq-empty').getByRole('link', { name: 'Functional' }).click();
    await expect(page).toHaveURL(/\/requirements\/architecture\/discuss$/);
    await expect(page.getByRole('navigation', { name: 'Functional stages' }).getByRole('link', { name: /Discuss/ })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByText('No topics yet.')).toBeVisible();
    api.assertNoUnexpectedRequests();
  });
});
