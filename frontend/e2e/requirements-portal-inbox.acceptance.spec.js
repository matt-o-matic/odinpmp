import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { PORTAL_TOKENS, createReviewWorld, installPortalApi } from './fixtures/requirements-portal-api.js';
import { installSyntheticApi } from './fixtures/synthetic-api.js';
import { settleForAxe } from './fixtures/axe-settle.js';

// The stakeholder portal (U7, AC-06 portal part, AC-17): the inbox, link problems with
// "Request a new link", and the question page, with no app chrome and no sign-in.
// Synthetic data: e2e/fixtures/requirements-portal-api.js.
const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];

async function expectNoSeriousIssues(page, testInfo, name) {
  await settleForAxe(page);
  const results = await new AxeBuilder({ page }).include('.rq-portal').withTags(wcagTags).analyze();
  await testInfo.attach(`axe-${name}.json`, { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' });
  const serious = results.violations
    .filter((violation) => ['serious', 'critical'].includes(violation.impact))
    .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`);
  expect(serious, name).toEqual([]);
}

async function openPortal(page, { token = PORTAL_TOKENS.ravi, world = createReviewWorld() } = {}) {
  const api = await installSyntheticApi(page);
  await installPortalApi(page, world, { token });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`requirements/${token}`);
  return { api, errors, world };
}

async function noHorizontalOverflow(page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no horizontal scrolling').toBeLessThanOrEqual(1);
}

test.describe('Stakeholder portal inbox', () => {
  test('shows one clear ask per open round, the questions waiting, and recent decisions without app chrome', async ({ page }, testInfo) => {
    const { api, errors } = await openPortal(page);

    const ask = page.getByTestId('rq-round-ask');
    await expect(ask).toHaveCount(1);
    await expect(ask.getByRole('heading', { level: 2 })).toHaveText(/^Morgan Lee asked you to review Client booking — price and booking flow by \w+day, \w{3} \d+$/);
    await expect(ask.getByText('2', { exact: true })).toBeVisible();
    await expect(ask.getByText('directions to compare')).toBeVisible();
    await expect(ask.getByText('screens to mark up')).toBeVisible();
    await expect(ask.getByText('questions to answer')).toBeVisible();
    await expect(ask.getByText('From Morgan:')).toBeVisible();
    await expect(ask.getByText('0 of 10 steps')).toBeVisible();
    await expect(ask.getByRole('link', { name: /Start review/ })).toBeVisible();
    await expect(ask.getByText('Anything you skip shows as “Not reviewed”. Nobody assumes you agree.')).toBeVisible();

    // The portal header, and none of the app's navigation.
    const header = page.locator('.rq-portal-head');
    await expect(header.getByText('Ravi Shah · Finance')).toBeVisible();
    await expect(header.getByText('Link valid until Oct 31')).toBeVisible();
    await expect(page.locator('.app-frame > .navbar')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'AI Workspace' })).toHaveCount(0);
    await header.getByRole('button', { name: 'Not you?' }).click();
    await expect(page.getByRole('region', { name: 'About this link' })).toContainText('This link was sent to Ravi Shah');

    const questions = page.getByRole('region', { name: /Questions waiting for you/ });
    await expect(questions.getByRole('heading')).toHaveText('Questions waiting for you · 3');
    await expect(questions.getByRole('listitem')).toHaveCount(3);
    const first = questions.getByRole('listitem').first();
    await expect(first).toContainText('Functional');
    await expect(first).toContainText('Assigned to you');
    await expect(first).toContainText('3 comments');
    await expect(first).toContainText('Odin summary: Agreed: Estimates come from job type and duration. Still split: Who maintains the rate table.');
    await expect(questions.getByRole('listitem').nth(1)).toContainText('You own this');
    await expect(questions.getByRole('listitem').nth(1)).toContainText('Odin summary: Not enough input yet.');
    await expect(questions.getByRole('listitem').nth(2)).toContainText('Open question');
    await expect(questions.getByText('You can also reply to any question by answering its email.')).toBeVisible();
    await expect(page.getByText(/person:|stakeholder-|user:/)).toHaveCount(0);

    const decided = page.getByRole('region', { name: 'Recently decided' });
    await expect(decided.getByRole('link', { name: 'Booking is the first task on the home screen.' })).toBeVisible();
    await expect(decided).toContainText(/Agreed by Morgan Lee · \w{3} \d+/);
    await expect(decided).toContainText(/Decided by Sam Patel · \w{3} \d+/);
    await expect(decided.getByText('Disagree with a decision? Comment on it and the team will see it.')).toBeVisible();

    await expect(page.getByRole('region', { name: 'Earlier rounds' }).getByRole('link', { name: /View your review/ })).toBeVisible();
    await noHorizontalOverflow(page);
    await expectNoSeriousIssues(page, testInfo, 'portal-inbox');
    expect(errors).toEqual([]);
    api.assertNoUnexpectedRequests();
  });

  test('an expired link explains itself and requests a new link once', async ({ page }, testInfo) => {
    const { api, world } = await openPortal(page, { token: PORTAL_TOKENS.expired });
    const problem = page.getByTestId('rq-link-problem');
    await expect(problem.getByRole('heading', { name: 'This link has expired' })).toBeFocused();
    await expect(problem).toContainText('then for 14 more days. This one ended on Sep 30.');
    await expectNoSeriousIssues(page, testInfo, 'portal-expired');
    await problem.getByRole('button', { name: 'Request a new link' }).click();
    await expect(problem.getByRole('status')).toHaveText('Request sent. The project team will send a new link to your email.');
    expect(world.calls.filter((call) => call.path === '/link-request')).toHaveLength(1);

    // A second visit says the request already went in.
    await page.reload();
    await problem.getByRole('button', { name: 'Request a new link' }).click();
    await expect(problem.getByRole('status')).toContainText('You already asked for a new link.');
    await expect(page.locator('.app-frame > .navbar')).toHaveCount(0);
    await noHorizontalOverflow(page);
    api.assertNoUnexpectedRequests();
  });

  test('a revoked link explains itself with no request button', async ({ page }, testInfo) => {
    const { api } = await openPortal(page, { token: PORTAL_TOKENS.revoked });
    const problem = page.getByTestId('rq-link-problem');
    await expect(problem.getByRole('heading', { name: 'This link was turned off' })).toBeVisible();
    await expect(problem).toContainText('The project team turned this link off.');
    await expect(problem.getByRole('button')).toHaveCount(0);
    await expectNoSeriousIssues(page, testInfo, 'portal-revoked');
    api.assertNoUnexpectedRequests();
  });

  test('a link that does not exist says so', async ({ page }, testInfo) => {
    const { api } = await openPortal(page, { token: PORTAL_TOKENS.missing });
    const problem = page.getByTestId('rq-link-problem');
    await expect(problem.getByRole('heading', { name: 'This link doesn’t work' })).toBeVisible();
    await expect(problem).toContainText('Check that you opened the whole link from your email.');
    await expectNoSeriousIssues(page, testInfo, 'portal-not-found');
    api.assertNoUnexpectedRequests();
  });

  test('too many requests asks the stakeholder to try again shortly', async ({ page }, testInfo) => {
    const { api } = await openPortal(page, { token: PORTAL_TOKENS.busy });
    const problem = page.getByTestId('rq-link-problem');
    await expect(problem.getByRole('heading', { name: 'Too many requests for a moment' })).toBeVisible();
    await expectNoSeriousIssues(page, testInfo, 'portal-rate-limited');
    await problem.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByTestId('rq-round-ask')).toBeVisible();
    api.assertNoUnexpectedRequests();
  });
});

test.describe('Portal question page', () => {
  test('a stakeholder reads the Odin summary, comments, replies, votes, edits and deletes their own comment, with no status controls', async ({ page }, testInfo) => {
    const { api, errors, world } = await openPortal(page);
    await page.getByRole('link', { name: 'How do price estimates get calculated, and by which service?' }).click();
    await expect(page).toHaveURL(/\/requirements\/link-ravi-0001\/questions\/topic-price-calc$/);
    await expect(page.getByRole('heading', { level: 1, name: 'How do price estimates get calculated, and by which service?' })).toBeVisible();

    const summary = page.getByRole('region', { name: 'Odin summary' });
    await expect(summary).toContainText('Estimates come from job type and duration.');
    await expect(summary.getByRole('button', { name: 'Source C1: go to comment' })).toBeVisible();
    await expect(summary.getByText('Refresh')).toHaveCount(0);
    await expect(page.getByText(/\bAI\b|drafted by/)).toHaveCount(0);

    const discussion = page.getByRole('region', { name: 'Discussion' });
    await expect(discussion.getByRole('article', { name: 'C1, Jamie Ortiz' })).toBeVisible();
    await expect(discussion.getByRole('article', { name: 'C2, Ravi Shah' })).toBeVisible();

    // No status, decision, assign, or delete-topic controls anywhere.
    for (const name of [/Dismiss/, /Reopen/, /Record a decision/, /Assign/, /Delete topic/, /Resolve/]) {
      await expect(page.getByRole('button', { name })).toHaveCount(0);
    }

    await discussion.getByLabel('Add to the discussion').fill('Finance can own the rate table if it stays in billing.');
    await discussion.getByRole('button', { name: 'Post comment' }).click();
    await expect(discussion.getByText('Finance can own the rate table if it stays in billing.')).toBeVisible();
    expect(world.calls.some((call) => call.method === 'POST' && call.path === '/topics/topic-price-calc/comments' && call.body.parentCommentId === '')).toBe(true);

    await discussion.getByRole('button', { name: 'Reply to C1' }).click();
    await discussion.getByRole('textbox', { name: 'Reply to C1' }).fill('Duration varies a lot for repairs.');
    await discussion.getByRole('button', { name: 'Post reply' }).click();
    await expect(discussion.getByText('Duration varies a lot for repairs.')).toBeVisible();

    await discussion.getByRole('button', { name: /Agree with C1/ }).click();
    await expect(discussion.getByRole('button', { name: /Agree with C1/ })).toHaveAttribute('aria-pressed', 'true');

    await discussion.getByRole('button', { name: 'Edit C2' }).click();
    await discussion.getByRole('textbox', { name: 'Edit C2' }).fill('Finance can own the rate table.');
    await discussion.getByRole('button', { name: 'Save edit' }).click();
    await expect(discussion.getByText('Finance can own the rate table.', { exact: true })).toBeVisible();

    await discussion.getByRole('button', { name: 'Remove C2' }).click();
    await page.getByRole('dialog', { name: 'Delete this comment?' }).getByRole('button', { name: 'Delete comment' }).click();
    await expect(discussion.getByRole('article', { name: 'C2, Ravi Shah' })).toContainText('Comment removed.');
    // Someone else's comment can't be edited.
    await expect(discussion.getByRole('button', { name: 'Edit C1' })).toHaveCount(0);

    await noHorizontalOverflow(page);
    await expectNoSeriousIssues(page, testInfo, 'portal-question');

    // A decided question shows the decision and still takes comments.
    await page.getByRole('link', { name: 'All your questions and reviews' }).click();
    await page.getByRole('link', { name: 'Booking is the first task on the home screen.' }).click();
    const decision = page.getByRole('region', { name: 'Decision' });
    await expect(decision).toContainText('Booking is the first task on the home screen.');
    await expect(decision).toContainText(/Agreed by Morgan Lee/);
    await expect(page.getByLabel('Add to the discussion')).toBeVisible();
    await expectNoSeriousIssues(page, testInfo, 'portal-question-decided');
    expect(errors).toEqual([]);
    api.assertNoUnexpectedRequests();
  });
});
