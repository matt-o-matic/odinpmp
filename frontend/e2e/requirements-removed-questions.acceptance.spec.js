import { expect, test } from '@playwright/test';

import { PORTAL_TOKENS, createReviewWorld, installPortalApi } from './fixtures/requirements-portal-api.js';
import { installSyntheticApi } from './fixtures/synthetic-api.js';

// Questions whose topic the team deleted or dismissed after the round was published: the
// reviewer sees a plain "removed" message with nothing to answer, an answer to one removed
// mid-review is refused with the same message, and a portal link to a removed question says
// so. Synthetic API: e2e/fixtures/requirements-portal-api.js (a question marked `removed`).
const REMOVED = 'This question has been removed and no longer needs an answer.';

function questionItems(world) {
  return world.manifest.sections.find((section) => section.type === 'questions').items;
}

async function open(page, world) {
  await installSyntheticApi(page);
  await installPortalApi(page, world);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

test('a removed question shows only that it was removed, and one removed mid-review says so when answered', async ({ page }) => {
  const world = createReviewWorld({ previousAnswers: false });
  const questions = questionItems(world);
  questions.find((question) => question.id === 'price-placement').removed = true;
  world.reviewers.ravi.position = { step: 'questions' };
  const errors = await open(page, world);

  await page.goto(`requirements/${PORTAL_TOKENS.ravi}/rounds/round-2`);
  await expect(page.getByRole('heading', { name: 'Questions from the team' })).toBeVisible();
  await expect(page.getByText('0 of 4 answered')).toBeVisible();
  const removed = page.locator('#rq-question-price-placement');
  await expect(removed).toContainText('Where should the price first appear?');
  await expect(removed).toContainText(REMOVED);
  await expect(removed.locator('input, textarea, button')).toHaveCount(0);

  // The team removes another question while the review is open: answering it is refused with
  // the same message, and the question turns into the removed message.
  questions.find((question) => question.id === 'before-tax').removed = true;
  const beforeTax = page.locator('#rq-question-before-tax');
  await beforeTax.getByRole('radio', { name: 'Yes' }).check();
  await expect(page.getByRole('alert').filter({ hasText: REMOVED })).toBeVisible();
  await expect(beforeTax).toContainText(REMOVED);
  await expect(beforeTax.locator('input, textarea, button')).toHaveCount(0);
  await expect(page.getByText('0 of 3 answered')).toBeVisible();
  expect(world.answers.ravi['before-tax']).toBeUndefined();

  // The questions still asked keep saving.
  await page.locator('#rq-question-reminder-channels').getByRole('checkbox', { name: 'Email' }).check();
  await expect.poll(() => world.answers.ravi['reminder-channels']?.value).toEqual(['email']);
  await expect(page.getByText('1 of 3 answered')).toBeVisible();
  expect(errors).toEqual([]);
});

test('a portal link to a removed question says it was removed', async ({ page }) => {
  const world = createReviewWorld();
  world.portal.removedTopicIds = new Set(['topic-gone']);
  const errors = await open(page, world);

  await page.goto(`requirements/${PORTAL_TOKENS.ravi}/questions/topic-gone`);
  await expect(page.getByRole('heading', { level: 1, name: REMOVED })).toBeVisible();
  await expect(page.getByRole('link', { name: /All your questions and reviews/ })).toBeVisible();
  await expect(page.getByText('This question isn’t available')).toHaveCount(0);
  expect(errors).toEqual([]);
});
