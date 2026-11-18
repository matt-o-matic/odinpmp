import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { installRequirementsApi } from './fixtures/requirements-api.js';
import { installRequirementsRoundsApi, roundsScenario } from './fixtures/requirements-rounds-api.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';
import { settleForAxe } from './fixtures/axe-settle.js';

// Publishing a draft package as a round:
// reviewers with required flags, the ask, the summary line, closing the open round first
// with decision rights, and every publish error the form handles. Synthetic API only.
const base = `projects/${syntheticProject.id}/requirements`;
const publishPath = `${base}/review/packages/package-3/publish`;
const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];

async function open(page, path, adjust = () => {}) {
  const scenario = roundsScenario();
  adjust(scenario);
  const api = await installSyntheticApi(page);
  const requirements = await installRequirementsApi(page, scenario);
  const rounds = await installRequirementsRoundsApi(page, requirements);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await authenticateSyntheticUser(page);
  await page.goto(path);
  return { api, pageErrors, requirements, rounds };
}

async function expectNoSeriousIssues(page, testInfo, name) {
  // Sticky app bars can cover a control after scrolling, which axe's target-size rule reads as
  // a small target; check from the top of the page.
  await page.evaluate(() => window.scrollTo(0, 0));
  await settleForAxe(page);
  const results = await new AxeBuilder({ page }).include('.rq-workspace').withTags(wcagTags).analyze();
  await testInfo.attach(`axe-${name}.json`, { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' });
  const serious = results.violations
    .filter((violation) => ['serious', 'critical'].includes(violation.impact))
    .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`);
  expect(serious, name).toEqual([]);
}

function closeOpenRound(scenario) {
  const open = scenario.roundsState.rounds.find((round) => round.id === 'round-2');
  Object.assign(open, { closedAt: new Date().toISOString(), closedBy: 'user:user-morgan', outcome: 'screens-accepted', status: 'closed' });
}

async function chooseReviewers(page) {
  const reviewers = page.getByRole('region', { name: 'Reviewers' });
  for (const name of ['Jamie Ortiz', 'Ravi Shah', 'Noor Haddad', 'Alex Kim', 'Synthetic Demo']) {
    await reviewers.getByRole('checkbox', { name: new RegExp(`^${name} ·`) }).check();
  }
  await reviewers.getByRole('checkbox', { name: 'Jamie Ortiz is required' }).check();
  await reviewers.getByRole('checkbox', { name: 'Noor Haddad is required' }).check();
}

test.describe('Publish a round', () => {
  test('a manager publishes from the package page, closing the open round first, and sees what publishing did', async ({ page }, testInfo) => {
    const { api, pageErrors, rounds } = await open(page, `${base}/review/packages/package-3`);
    await page.getByRole('link', { name: 'Publish as a round' }).click();
    await expect(page).toHaveURL(/\/review\/packages\/package-3\/publish$/);
    await expect(page.getByRole('heading', { level: 2, name: 'Round 3 · Client booking — price and booking flow' })).toBeVisible();

    // 1 Package
    const pkg = page.getByRole('region', { name: 'Package' });
    await expect(pkg.getByText('Valid · draft v3')).toBeVisible();
    await expect(pkg).toContainText('Dana Cho · uploaded through MCP · 4.2 MB · 38 files');
    await expect(pkg).toContainText('4 questions: 2 linked to topics, 2 will create new topics');
    await expect(pkg.getByRole('region', { name: 'What changed since round 2' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Preview as a reviewer' })).toHaveAttribute('href', /\/packages\/package-3$/);

    // The open round has to close first; the submit says so.
    const openRound = page.getByRole('region', { name: 'Round 2 is still open' });
    await expect(openRound).toContainText('Close round 2 first; publishing does both in one step.');
    const publish = page.getByRole('button', { name: 'Close round 2 and publish round 3' });

    // 2 Reviewers: externals labeled, the link lifetime note, required only once picked.
    const reviewers = page.getByRole('region', { name: 'Reviewers' });
    await expect(reviewers.getByRole('listitem')).toHaveCount(5);
    await expect(reviewers.getByRole('listitem').nth(0)).toContainText('Jamie Ortiz · external · link');
    await expect(reviewers.getByRole('listitem').nth(3)).toContainText('Alex Kim · member');
    await expect(reviewers.getByRole('listitem').nth(4)).toContainText('Synthetic Demo · manager');
    await expect(reviewers).toContainText('It stays valid while they have an open round or topic, then for 14 more days.');
    // "required" appears once someone is picked.
    await expect(reviewers.getByRole('checkbox', { name: 'Jamie Ortiz is required' })).toBeHidden();

    const summary = page.locator('#rq-publish-summary');
    await expect(summary).toHaveText(/^Choose at least one reviewer\./);

    // Nothing picked and no outcome: the form explains, and nothing is sent.
    await publish.click();
    await expect(page.getByRole('alert').first()).toHaveText('Fix the highlighted fields, then publish again.');
    await expect(reviewers.getByText('Choose at least one reviewer.')).toBeVisible();
    await expect(openRound.getByRole('alert')).toHaveText('Choose how the round ends.');
    expect(rounds.calls.filter((call) => call.method === 'POST')).toHaveLength(0);

    await chooseReviewers(page);
    await expect(summary).toHaveText('Publishing emails 3 external reviewers and notifies 2 members. Reviewers see the package exactly as in Preview.');

    // 3 Ask
    const ask = page.getByRole('region', { name: 'Ask' });
    await ask.getByLabel('Due').fill('2030-10-17T17:00');
    await expect(ask.getByLabel('Reminder')).toHaveValue('2');
    await ask.getByLabel('Reminder').selectOption('3');
    await ask.getByLabel('Note to reviewers').fill('Round 3 adds the reschedule flow. Does the tax wording work for you?');

    await openRound.getByText('Direction chosen').click();
    await openRound.getByLabel('Direction', { exact: true }).selectOption('action-first');
    await expect(openRound.getByLabel(/^Statement/)).toHaveAttribute('placeholder', 'Round 2: Direction chosen: Action first.');
    await publish.click();

    const done = page.getByRole('region', { name: 'Round 3 published' });
    await expect(done.getByRole('heading', { name: 'Round 3 published' })).toBeFocused();
    await expect(done).toContainText('Invited 3 external reviewers and 2 members.');
    await expect(done).toContainText('From the previous round: 2 annotations carried forward, 5 outdated, 1 superseded.');
    await expect(done).toContainText('2 new topics created for package questions.');
    const topics = done.getByRole('list', { name: 'Topics created for package questions' });
    await expect(topics.getByRole('link')).toHaveText(['Should the price range say "before tax"?', 'How quick did booking feel?']);

    const call = rounds.calls.find((entry) => entry.method === 'POST' && entry.path === '/');
    expect(call.body).toEqual({
      closePrevious: { directionId: 'action-first', outcome: 'direction-chosen', statement: '' },
      dueAt: new Date(2030, 9, 17, 17, 0).toISOString(),
      note: 'Round 3 adds the reschedule flow. Does the tax wording work for you?',
      packageId: 'package-3',
      reminder: { daysBefore: 3 },
      reviewers: [
        { actorId: 'stakeholder-jamie', actorType: 'stakeholder', required: true },
        { actorId: 'stakeholder-ravi', actorType: 'stakeholder', required: false },
        { actorId: 'stakeholder-noor', actorType: 'stakeholder', required: true },
        { actorId: 'user-alex', actorType: 'user', required: false },
        { actorId: 'user-synthetic', actorType: 'user', required: false },
      ],
    });
    await expectNoSeriousIssues(page, testInfo, 'publish-done');

    await done.getByRole('link', { name: 'Open round 3' }).click();
    await expect(page.getByRole('heading', { level: 2, name: /^Round 3 results/ })).toBeVisible();
    await page.goto(`${base}/review/rounds/round-2`);
    await expect(page.locator('.rq-topic-head')).toContainText(/Closed by Synthetic Demo on \w{3} \d+: Round 2: Direction chosen: Action first\./);
    expect(pageErrors).toEqual([]);
    api.assertNoUnexpectedRequests();
  });

  test('without an open round, a draft row in the Review stage publishes straight away', async ({ page }) => {
    const { rounds } = await open(page, `${base}/review`, closeOpenRound);
    await page.getByRole('region', { name: 'Review packages' }).getByRole('link', { name: 'Publish version 3 as a round' }).click();
    await expect(page).toHaveURL(/\/packages\/package-3\/publish$/);
    await expect(page.getByRole('region', { name: /is still open$/ })).toHaveCount(0);
    await page.getByRole('region', { name: 'Reviewers' }).getByRole('checkbox', { name: /^Ravi Shah ·/ }).check();
    await expect(page.locator('#rq-publish-summary')).toHaveText(/^Publishing emails 1 external reviewer\./);
    const ask = page.getByRole('region', { name: 'Ask' });
    await ask.getByLabel('Due').fill('');
    await expect(ask.getByLabel('Reminder')).toBeDisabled();
    await page.getByRole('button', { name: 'Publish round 3' }).click();
    await expect(page.getByRole('heading', { name: 'Round 3 published' })).toBeVisible();
    const call = rounds.calls.find((entry) => entry.method === 'POST' && entry.path === '/');
    expect(call.body).toEqual({ dueAt: null, note: '', packageId: 'package-3', reminder: null, reviewers: [{ actorId: 'stakeholder-ravi', actorType: 'stakeholder', required: false }] });
  });

  test('a revoked link is flagged, and a reviewer without email shows up in the result', async ({ page }) => {
    await open(page, publishPath, (scenario) => {
      closeOpenRound(scenario);
      scenario.links[0] = { ...scenario.links[0], revokedAt: new Date().toISOString(), status: 'revoked' };
      scenario.roundsState.reviewerWithoutEmail = 'stakeholder:stakeholder-noor';
    });
    const ravi = page.getByRole('region', { name: 'Reviewers' }).getByRole('checkbox', { name: /^Ravi Shah ·/ });
    await expect(ravi).toHaveAccessibleDescription(/Link revoked, so no invitation will be sent/);
    await page.getByRole('region', { name: 'Reviewers' }).getByRole('checkbox', { name: /^Noor Haddad ·/ }).check();
    await page.getByRole('button', { name: 'Publish round 3' }).click();
    await expect(page.getByRole('region', { name: 'Round 3 published' })).toContainText('Not emailed: Noor Haddad (no email address on file). Resend from the round once it’s fixed.');
  });

  test('a member sees that an admin or manager has to close the open round, and cannot publish over it', async ({ page }, testInfo) => {
    const { rounds } = await open(page, publishPath, (scenario) => {
      scenario.canDecide = false;
      scenario.projectRole = 'member';
    });
    const openRound = page.getByRole('region', { name: 'Round 2 is still open' });
    await expect(openRound).toContainText('An admin or manager has to close round 2 before this package can be published.');
    await expect(openRound.getByRole('radio')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Publish round 3' })).toBeDisabled();
    await expect(openRound.getByRole('link', { name: 'See round 2 results' })).toHaveAttribute('href', /\/review\/rounds\/round-2$/);
    expect(rounds.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    await expectNoSeriousIssues(page, testInfo, 'publish-member');
  });

  test('a round opened after the page loaded: 409 round_open offers Close round N first only with decision rights', async ({ page }) => {
    const { rounds } = await open(page, publishPath, (scenario) => {
      scenario.roundsState.listHidesOpenRound = true;
    });
    await page.getByRole('region', { name: 'Reviewers' }).getByRole('checkbox', { name: /^Jamie Ortiz ·/ }).check();
    await page.getByRole('button', { name: 'Publish round 2' }).click();
    await expect(page.getByRole('alert').first()).toHaveText('Round 2 is still open for this track. Close it first, then this package is published as the next round.');
    const openRound = page.getByRole('region', { name: 'Round 2 is still open' });
    await openRound.getByText('Changes requested').click();
    await openRound.getByLabel(/^Statement/).fill('Round 2: the tax wording needs another pass.');
    await page.getByRole('button', { name: 'Close round 2 and publish round 3' }).click();
    await expect(page.getByRole('heading', { name: 'Round 3 published' })).toBeVisible();
    const posts = rounds.calls.filter((entry) => entry.method === 'POST' && entry.path === '/');
    expect(posts).toHaveLength(2);
    expect(posts[0].body.closePrevious).toBeUndefined();
    expect(posts[1].body.closePrevious).toEqual({ directionId: '', outcome: 'changes-requested', statement: 'Round 2: the tax wording needs another pass.' });
  });

  test('a member who hits 409 round_open is told who can close it', async ({ page }) => {
    await open(page, publishPath, (scenario) => {
      scenario.roundsState.listHidesOpenRound = true;
      scenario.canDecide = false;
      scenario.projectRole = 'member';
    });
    await page.getByRole('region', { name: 'Reviewers' }).getByRole('checkbox', { name: /^Jamie Ortiz ·/ }).check();
    await page.getByRole('button', { name: 'Publish round 2' }).click();
    await expect(page.getByRole('alert').first()).toHaveText('Round 2 is still open for this track. An admin or manager has to close it before another round can be published.');
    await expect(page.getByRole('region', { name: 'Round 2 is still open' }).getByRole('radio')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Publish round/ })).toBeDisabled();
  });

  for (const { mode, message } of [
    { message: /^A question in this package links to a topic that was deleted or belongs to the other track \(price-placement\)\./, mode: 'question_topic_missing' },
    { message: /^Jamie Ortiz can’t review this round: they are no longer a stakeholder of this project\./, mode: 'reviewer_invalid' },
    { message: /^This package was already published or withdrawn, so it can’t be published again\./, mode: 'package_not_draft' },
  ]) {
    test(`publish error ${mode} is explained`, async ({ page }) => {
      await open(page, publishPath, (scenario) => {
        closeOpenRound(scenario);
        scenario.roundsState.publishMode = mode;
      });
      await page.getByRole('region', { name: 'Reviewers' }).getByRole('checkbox', { name: /^Jamie Ortiz ·/ }).check();
      await page.getByRole('button', { name: 'Publish round 3' }).click();
      await expect(page.getByRole('alert').first()).toHaveText(message);
      await expect(page.getByRole('heading', { name: 'Round 3 published' })).toHaveCount(0);
      if (mode === 'package_not_draft') {
        await expect(page.getByRole('note')).toContainText('Version 3 is already published, so it can’t be published again.');
        await expect(page.getByRole('button', { name: /^Publish round/ })).toHaveCount(0);
      }
    });
  }

  test('a viewer can read the package but not publish', async ({ page }) => {
    await open(page, publishPath, (scenario) => {
      scenario.canDecide = false;
      scenario.projectRole = 'viewer';
    });
    await expect(page.getByRole('note')).toContainText('Publishing a round needs member access or above on this project.');
    await expect(page.getByRole('button', { name: /^Publish round/ })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Reviewers' })).toHaveCount(0);
    await page.goto(`${base}/review/packages/package-3`);
    await expect(page.getByRole('heading', { level: 2, name: /^Version 3/ })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Publish as a round' })).toHaveCount(0);
  });

  test('the publish page passes axe and fits a phone', async ({ page }, testInfo) => {
    await open(page, publishPath);
    await expect(page.getByRole('region', { name: 'Round 2 is still open' })).toBeVisible();
    await chooseReviewers(page);
    await expectNoSeriousIssues(page, testInfo, 'publish-form');
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await expectNoSeriousIssues(page, testInfo, 'publish-form-dark');
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
