import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { defaultRequirementsScenario, installRequirementsApi } from './fixtures/requirements-api.js';
import { createReviewWorld, installTeamReviewApi } from './fixtures/requirements-portal-api.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';
import { settleForAxe } from './fixtures/axe-settle.js';

// A round's Marks and comments for a team member who can collaborate: each mark beside the
// picture it was made on, the discussion continued there through the same review API the
// guided review uses, and links back and forth with the guided review on the same mark.
const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];
const base = `projects/${syntheticProject.id}/requirements`;
const MARK = '0b6f2f5e-1d3c-4a58-9b6a-6c1d8b2f7a01';

async function openMarks(page) {
  const world = createReviewWorld({ withOutdated: false });
  const api = await installSyntheticApi(page);
  await installRequirementsApi(page, defaultRequirementsScenario());
  await installTeamReviewApi(page, world);
  await authenticateSyntheticUser(page);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/review/rounds/round-2/annotations`);
  await expect(page.getByRole('heading', { level: 2, name: 'Round 2 · Marks and comments' })).toBeVisible();
  return { api, errors, world };
}

test('reply to a mark beside its picture, then pick up the same mark in the review and come back', async ({ isMobile, page }, testInfo) => {
  test.setTimeout(90_000);
  const { api, errors, world } = await openMarks(page);
  if (isMobile) await page.getByRole('button', { name: /^Mark 1 by Jamie Ortiz/ }).click();
  const mark = page.getByRole('region', { name: 'Mark 1 · Booking home' });
  await expect(mark).toBeVisible();
  // The picture is the screen the mark was made on, with the mark on it.
  await expect.poll(() => mark.locator('.rq-markpreview__image').evaluate((image) => image.naturalWidth)).toBeGreaterThan(0);
  await expect(mark.locator('.rq-markpreview [data-pin-id]')).toHaveCount(1);
  await expect(mark.locator('.rq-markpeople')).toContainText('Posted by');

  // The thread is the review's own: reply in it, and it saves through the review API.
  const thread = mark.getByTestId('rq-annotation-thread');
  await expect(thread.getByRole('article', { name: 'Jamie Ortiz, comment C1' })).toContainText('The Book a visit button should be bigger.');
  await thread.getByRole('button', { name: 'Reply to Jamie Ortiz' }).click();
  await page.keyboard.type('Agreed. Make it the main action.');
  await thread.getByRole('button', { name: 'Send reply' }).click();
  await expect(thread.getByRole('article', { name: /^You, reply/ })).toContainText('Agreed. Make it the main action.');
  expect(world.comments.find((comment) => comment.body.startsWith('Agreed.'))).toMatchObject({ annotationId: MARK, author: 'team', parentCommentId: 'ac-1' });

  await settleForAxe(page);
  const results = await new AxeBuilder({ page }).include('.rq-workspace').withTags(wcagTags).analyze();
  await testInfo.attach('axe-round-marks.json', { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' });
  expect(results.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact)).map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`)).toEqual([]);

  // Open in your review: the review opens on this mark's screen with its thread.
  await mark.getByRole('link', { name: 'Open in your review' }).click();
  await expect(page).toHaveURL(/\/review\/rounds\/round-2\/review$/);
  await expect(page.getByRole('heading', { level: 2, name: 'Booking home' })).toBeVisible();
  const reviewThread = page.getByTestId('rq-annotation-thread');
  await expect(reviewThread).toContainText('The Book a visit button should be bigger.');
  await expect(reviewThread).toContainText('Agreed. Make it the main action.');

  // And back: the mark's thread links to it in Marks and comments.
  await reviewThread.getByRole('link', { name: 'Open mark 1 in Marks and comments' }).click();
  await expect(page).toHaveURL(new RegExp(`/review/rounds/round-2/annotations#mark-${MARK}$`));
  await expect(page.getByRole('region', { name: 'Mark 1 · Booking home' })).toBeVisible();
  expect(errors).toEqual([]);
  api.assertNoUnexpectedRequests();
});

test('the review links every mark in the round from its Marks tab', async ({ isMobile, page }) => {
  test.skip(isMobile, 'The Marks tab is a side panel on wide screens.');
  const world = createReviewWorld({ withOutdated: false });
  world.reviewers.team.position = { screenId: 'booking-home', step: 'screens' };
  await installSyntheticApi(page);
  await installRequirementsApi(page, defaultRequirementsScenario());
  await installTeamReviewApi(page, world);
  await authenticateSyntheticUser(page);
  await page.goto(`${base}/review/rounds/round-2/review`);
  await expect(page.getByRole('heading', { level: 2, name: 'Booking home' })).toBeVisible();
  const views = page.getByRole('navigation', { name: 'Round views' });
  await expect(views.getByRole('link', { name: 'Your review' })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('tab', { name: /^Marks · / }).click();
  await page.getByRole('link', { name: 'Every mark in this round, with its discussion' }).click();
  await expect(page).toHaveURL(/\/review\/rounds\/round-2\/annotations$/);
  await expect(views.getByRole('link', { name: /^Marks and comments/ })).toHaveAttribute('aria-current', 'page');
});
