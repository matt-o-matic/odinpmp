import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { defaultRequirementsScenario, installRequirementsApi } from './fixtures/requirements-api.js';
import { createReviewWorld, installTeamReviewApi } from './fixtures/requirements-portal-api.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';
import { settleForAxe } from './fixtures/axe-settle.js';

// A team member reviews a round inside the app (route project-requirements-round-review):
// the same guided review on the team review API, inside the normal app shell.
const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];
const base = `projects/${syntheticProject.id}/requirements`;

test('a team member reviews a round in the app with the same guided review', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const world = createReviewWorld();
  const api = await installSyntheticApi(page);
  await installRequirementsApi(page, defaultRequirementsScenario());
  await installTeamReviewApi(page, world);
  await authenticateSyntheticUser(page);

  await page.goto(`${base}/review/rounds/round-2/review`);
  await expect(page.getByRole('heading', { level: 2, name: 'Client booking — price and booking flow' })).toBeVisible();
  // Inside the app shell, with the project's tabs and a way back to the round.
  await expect(page.getByRole('link', { name: 'Requirements', exact: true }).first()).toBeVisible();
  const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
  await expect(crumbs.getByRole('link', { name: 'Round 2' })).toHaveAttribute('href', /\/requirements\/review\/rounds\/round-2$/);
  await expect(crumbs.getByText('Your review')).toBeVisible();

  await page.getByRole('navigation', { name: 'Review steps' }).getByRole('button', { name: /Directions/ }).click();
  await page.getByRole('group', { name: 'Your view of Action first' }).getByRole('radio', { name: 'Preferred' }).check();
  await expect.poll(() => world.stances.team['action-first']?.stance).toBe('preferred');
  expect(world.callsTo('PUT', /^\/directions\/action-first$/)[0]).toMatchObject({ actor: 'team', audience: 'team' });

  await page.getByRole('navigation', { name: 'Review steps' }).getByRole('button', { name: /Screens/ }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Booking home' })).toBeFocused();
  await expect.poll(() => page.locator('.annotation-canvas__image').evaluate((image) => image.naturalWidth)).toBe(1280);
  await page.getByRole('group', { name: 'Overall, this screen' }).getByRole('radio', { name: 'Keep', exact: true }).check();
  await expect.poll(() => world.verdicts.team['booking-home']?.overall).toBe('keep');
  await expect(page.getByTestId('rq-save-status')).toContainText(/Saved \d/);
  await settleForAxe(page);
  const results = await new AxeBuilder({ page }).include('.rq-workspace').withTags(wcagTags).analyze();
  await testInfo.attach('axe-team-review.json', { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' });
  expect(results.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact)).map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`)).toEqual([]);

  await page.getByRole('navigation', { name: 'Review steps' }).getByRole('button', { name: /Submit/ }).click();
  await page.getByRole('button', { name: 'Submit review' }).click();
  await expect(page.getByTestId('rq-submitted')).toBeVisible();
  await expect.poll(() => world.reviewers.team.submittedAt).not.toBeNull();
  api.assertNoUnexpectedRequests();
});
