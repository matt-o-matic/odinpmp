import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { installRequirementsApi } from './fixtures/requirements-api.js';
import { installRequirementsRoundsApi, roundsScenario } from './fixtures/requirements-rounds-api.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';
import { settleForAxe } from './fixtures/axe-settle.js';

// A round's results and the team's round actions: the rounds list, the header, verdicts by
// reviewer, direction preference, Odin summaries with their sources, questions, closing with each
// outcome, reminders, reviewer edits, proposed preferences, live updates, and My open items.
// Synthetic API only.
const base = `projects/${syntheticProject.id}/requirements`;
const roundPath = `${base}/review/rounds/round-2`;
const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];
const AI_LABELS = /AI proposal|AI-drafted|drafted by AI|not a decision/i;
const routerSource = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'router', 'index.js'), 'utf8');
// The guided review route comes from the stakeholder-review unit; without it, rounds open their results.
const hasGuidedReview = routerSource.includes("name: 'project-requirements-round-review'");

async function open(page, target, adjust = () => {}) {
  const scenario = roundsScenario();
  adjust(scenario);
  const api = await installSyntheticApi(page);
  const requirements = await installRequirementsApi(page, scenario);
  const rounds = await installRequirementsRoundsApi(page, requirements);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await authenticateSyntheticUser(page);
  await page.goto(target);
  return { api, pageErrors, requirements, rounds };
}

function asMember(scenario) {
  scenario.canDecide = false;
  scenario.projectRole = 'member';
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

const grid = (page) => page.getByRole('region', { name: 'Verdicts by reviewer' });

test.describe('Rounds in the Review stage', () => {
  test('lists rounds with the open one first and links each to its results', async ({ page }, testInfo) => {
    const { api } = await open(page, `${base}/review`);
    const list = page.getByRole('region', { name: 'Review rounds' }).getByRole('list', { name: 'Rounds' });
    const rows = list.getByRole('listitem');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Round 2 · Client booking, booking first');
    await expect(rows.nth(0)).toContainText(/package v2 · 3 of 5 submitted · due \w{3}, \w{3} \d+/);
    await expect(rows.nth(0)).toContainText(/Open · closes/);
    await expect(rows.nth(1)).toContainText('Closed · Changes requested');
    await expect(rows.nth(1)).toContainText(/package v1 · 3 of 3 submitted · closed/);
    if (hasGuidedReview) {
      await expect(rows.nth(0).getByRole('link', { name: 'Review: round 2' })).toHaveAttribute('href', /\/review\/rounds\/round-2\/review$/);
    }
    // Every round, open or closed, links straight to its marks and their discussions.
    await expect(rows.nth(0).getByRole('link', { name: 'Marks and comments: round 2' })).toHaveAttribute('href', /\/review\/rounds\/round-2\/annotations$/);
    await expect(rows.nth(1).getByRole('link', { name: 'Marks and comments: round 1' })).toHaveAttribute('href', /\/review\/rounds\/round-1\/annotations$/);
    const packages = page.getByRole('region', { name: 'Review packages' });
    await expect(packages.getByRole('link', { name: 'Round 2 results' })).toHaveAttribute('href', /\/review\/rounds\/round-2$/);
    await expectNoSeriousIssues(page, testInfo, 'review-stage-rounds');

    await rows.nth(0).getByRole('link', { name: /^Round 2:/ }).click();
    await expect(page).toHaveURL(/\/review\/rounds\/round-2$/);
    await expect(page.getByRole('heading', { level: 2, name: 'Round 2 results · Client booking, booking first' })).toBeFocused();
    api.assertNoUnexpectedRequests();
  });

  test('the Review tab says a round is open, and Edit reviewers and dates opens the round with its dialog', async ({ page }) => {
    const { api } = await open(page, `${base}/experience/discuss`);
    const tabs = page.getByRole('navigation', { name: 'Requirements views' });
    await expect(tabs.getByRole('link', { name: /^Review/ })).toContainText('Round 2 open');
    await tabs.getByRole('link', { name: /^Review/ }).click();
    await expect(page).toHaveURL(/\/requirements\/review$/);
    const openRow = page.getByRole('region', { name: 'Review rounds' }).getByRole('listitem').first();
    await openRow.getByRole('link', { name: 'Edit reviewers and dates: round 2' }).click();
    await expect(page.getByRole('dialog', { name: 'Edit round 2' })).toBeVisible();
    await expect(page).toHaveURL(/\/review\/rounds\/round-2$/, { timeout: 5000 });
    api.assertNoUnexpectedRequests();
  });

  test('a link to the old per-track Review stage, as in invitations already sent, opens the round', async ({ page }) => {
    await open(page, `${base}/architecture/review?round=round-2`);
    await expect(page).toHaveURL(/\/requirements\/review\/rounds\/round-2$/);
    await expect(page.getByRole('heading', { level: 2, name: 'Round 2 results · Client booking, booking first' })).toBeVisible();
  });

  test('the member invitation link opens the round, and Upload v4 focuses the upload', async ({ page }) => {
    await open(page, `${base}/review?round=round-2`);
    await expect(page).toHaveURL(/\/review\/rounds\/round-2$/);
    await page.getByRole('link', { name: 'Upload v4' }).click();
    await expect(page).toHaveURL(/\/review\?upload=1$/);
    await expect(page.getByLabel('Upload package')).toBeFocused();
  });
});

test.describe('Round results', () => {
  test('the header shows status, progress, package, marks, comments, and the actions a manager has', async ({ page }) => {
    const { api, pageErrors } = await open(page, roundPath);
    const header = page.locator('.rq-topic-head');
    await expect(header.getByRole('heading', { level: 2 })).toHaveText('Round 2 results · Client booking, booking first');
    await expect(header).toContainText(/Open · closes \w{3}, \w{3} \d+/);
    await expect(header).toContainText('3 of 5 submitted · package v2 · 14 marks · 11 comments');
    await expect(header).toContainText('Note to reviewers: Round 2 adds a schedule-first direction.');
    await expect(header.getByRole('button', { name: 'Remind (2)' })).toBeVisible();
    await expect(header.getByRole('link', { name: 'Upload v4' })).toHaveAttribute('href', /\/review\?upload=1$/);
    await expect(header.getByRole('button', { name: 'Close round' })).toBeVisible();
    // Results, Marks and comments, and the member's own review sit side by side.
    const views = page.getByRole('navigation', { name: 'Round views' });
    await expect(views.getByRole('link', { name: 'Results' })).toHaveAttribute('aria-current', 'page');
    await expect(views.getByRole('link', { name: 'Marks and comments 14' })).toHaveAttribute('href', /\/rounds\/round-2\/annotations$/);
    if (hasGuidedReview) {
      await expect(views.getByRole('link', { exact: true, name: 'Review' })).toHaveAttribute('href', /\/rounds\/round-2\/review$/);
    }
    await expect(page.locator('.rq-workspace')).not.toContainText(AI_LABELS);
    expect(pageErrors).toEqual([]);
    api.assertNoUnexpectedRequests();
  });

  test('verdicts by reviewer: hatched Not reviewed cells, required flags, tallies, and verdict notes', async ({ page }) => {
    await open(page, roundPath);
    const table = grid(page).getByRole('table');
    await expect(table.getByRole('columnheader')).toHaveText([
      'Reviewer', 'Booking home6 marks', 'Booking home, schedule first5 marks', 'Booking flow2 marks', 'Price details1 mark',
    ]);
    await expect(table.getByRole('rowheader')).toHaveText([/^JOJamie Ortiz/, /^RSRavi Shah/, /^AKAlex Kim/, /^NHNoor Haddad/, /^SDSynthetic Demo/, 'Reviewed']);
    await expect(table.getByRole('rowheader', { name: /Jamie Ortiz/ })).toContainText('required reviewer');
    await expect(table.getByRole('button', { name: 'Ravi Shah, Booking home: Keep with changes' })).toHaveText('KEEP+');
    await expect(table.getByRole('button', { name: 'Alex Kim, Booking flow: Undecided' })).toHaveText('UNSURE');
    await expect(table.getByRole('button', { name: /: Not reviewed$/ })).toHaveCount(7);
    await expect(table.getByRole('button', { name: 'Synthetic Demo, Booking home: Not reviewed' })).toHaveClass(/rq-vcell--none/);
    // Not reviewed counts as nothing: Booking flow has 2 of 5 verdicts.
    await expect(table.locator('tfoot td').nth(2)).toContainText('2 of 5');
    await expect(table.locator('tfoot td').nth(2)).toContainText('Booking flow: 1 keep · 1 undecided · 3 not reviewed');
    const legend = page.getByRole('list', { name: 'Legend' });
    await expect(legend.getByRole('listitem')).toHaveText(['Keep', 'Keep with changes', 'Change', 'Undecided', 'Not reviewed']);

    await table.getByRole('button', { name: 'Jamie Ortiz, Booking home: Keep' }).click();
    const detail = page.locator('.rq-verdict-detail');
    await expect(detail).toContainText('Jamie Ortiz on Booking home: Keep.');
    await expect(detail).toContainText('Hierarchy & navigationKeep');
    await expect(detail).toContainText('What should stayOne primary "Book a visit" action.');
    await table.getByRole('button', { name: 'Noor Haddad, Price details: Not reviewed' }).click();
    await expect(detail).toContainText('Noor Haddad on Price details: not reviewed yet.');
    await expect(page.getByRole('region', { name: 'Selected screen: Price details' })).toBeVisible();
  });

  test('direction preference: a bar, the full tallies, and remix requests; no answer is not a preference', async ({ page }) => {
    await open(page, roundPath);
    const directions = page.getByRole('region', { name: 'Direction preference' });
    await expect(directions).toContainText('4 of 5 answered');
    await expect(directions.locator('.rq-dirbar__seg')).toHaveText(['A · Action first · 2', 'B · Schedule first · 1', 'No preference · 1', 'Not answered · 1']);
    const rows = directions.getByRole('table').getByRole('row');
    await expect(rows.nth(1)).toHaveText(/A · Action first\s*2\s*1\s*0/);
    await expect(rows.nth(2)).toHaveText(/B · Schedule first\s*1\s*2\s*1/);
    await expect(directions).toContainText('1 answered without preferring a direction. 1 not answered yet; they count toward no direction.');
    await expect(directions).toContainText('B · Schedule first: “Keep the schedule-first week calendar on the confirm step.” (Ravi Shah); “Keep the week calendar.” (Noor Haddad)');
  });

  test('the selected screen’s Odin summary cites its sources by name, and other screens show their state', async ({ page }) => {
    const { rounds } = await open(page, roundPath);
    const selected = page.getByRole('region', { name: 'Selected screen: Booking home' });
    await expect(selected.getByRole('heading', { name: 'Odin summary · Booking home' })).toBeVisible();
    await expect(selected).toContainText(/Last updated \d+ min ago/);
    const aligned = selected.locator('.rq-sum__group--aligned');
    await expect(aligned).toContainText('Keep one primary "Book a visit" action.');
    await expect(aligned.locator('.rq-source')).toHaveText(['#1', 'V-JO', 'V-AK']);
    // Annotation and comment citations open in the round's annotations and comments.
    await expect(aligned.getByRole('link', { name: 'Annotation 1 on Booking home, open in Marks and comments' })).toHaveAttribute('href', /\/review\/rounds\/round-2\/annotations#mark-ann-1$/);
    await expect(aligned.getByRole('note', { name: 'Verdict by Jamie Ortiz on Booking home' })).toBeVisible();
    await expect(aligned.getByRole('img', { name: 'Jamie Ortiz' })).toBeVisible();
    await expect(selected.locator('.rq-sum__group--divergent').getByRole('note', { name: 'Source no longer available' })).toHaveText('Removed');
    await expect(selected.locator('.rq-sum__group--outstanding')).toContainText('blocking');
    await expect(selected.getByRole('link', { name: 'Open Booking home in the package' })).toHaveAttribute('href', /\/packages\/package-2\?screen=booking-home$/);

    await selected.getByRole('button', { name: 'Refresh the Odin summary of Booking home' }).click();
    await expect(selected.getByRole('status').filter({ hasText: 'Odin summary updated.' })).toBeVisible();
    expect(rounds.calls.find((call) => call.path === '/round-2/summary/refresh').body).toEqual({ screenId: 'booking-home' });

    await grid(page).getByRole('button', { name: /^Booking home, schedule first/ }).click();
    await expect(grid(page).getByRole('button', { name: /^Booking home, schedule first/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(/screen=booking-home-schedule/);
    const pending = page.getByRole('region', { name: 'Selected screen: Booking home, schedule first' });
    await expect(pending).toContainText('No summary yet. Odin summarizes once reviewers start giving feedback.');
    await expect(pending).toContainText('update queued');
    await grid(page).getByRole('button', { name: /^Booking flow/ }).click();
    await expect(page.getByRole('region', { name: 'Selected screen: Booking flow' })).toContainText('Not enough input yet');
    await grid(page).getByRole('button', { name: /^Price details/ }).click();
    await expect(page.getByRole('region', { name: 'Selected screen: Price details' })).toContainText('Odin couldn’t summarize this feedback yet.');

    const roundSummary = page.getByRole('region', { name: 'Odin summary · Round 2' });
    await expect(roundSummary.locator('.rq-sum__group--aligned').getByRole('note')).toHaveText(['D-JO', 'D-RS']);
    await expect(roundSummary.locator('.rq-sum__group--divergent .rq-source')).toHaveText(['D-AK', 'Booking home #3', 'Q-RS']);
    await roundSummary.getByRole('button', { name: 'Refresh the Odin summary of Round 2' }).click();
    await expect.poll(() => rounds.calls.filter((call) => call.path === '/round-2/summary/refresh').at(-1)?.body).toEqual({ screenId: '' });
  });

  test('questions list each reviewer’s answer and who has not answered', async ({ page }) => {
    await open(page, roundPath);
    const questions = page.getByRole('region', { name: 'Questions · 4' });
    const first = questions.getByRole('listitem').filter({ hasText: 'Where should the price first appear?' }).first();
    await expect(first).toContainText('3 of 5 answered');
    await expect(first.getByRole('list', { name: /^Answers to/ }).getByRole('listitem')).toHaveText([
      'Jamie Ortiz: Only after a time is picked',
      'Ravi Shah: A range on the home screen, exact before payment',
      'Alex Kim: A range on the home screen, exact before payment',
    ]);
    await expect(first).toContainText('Not answered: Noor Haddad, Synthetic Demo');
    await expect(first.getByRole('link', { name: /^Open its topic/ })).toHaveAttribute('href', /\/requirements\/topics\/topic-price$/);
    await expect(questions.getByRole('listitem').filter({ hasText: 'How much notice' }).first()).toContainText('0 of 5 answered');
  });

  test('a closed round shows its outcome, who closed it, and no round actions', async ({ page }, testInfo) => {
    await open(page, `${base}/review/rounds/round-1`);
    const header = page.locator('.rq-topic-head');
    await expect(header).toContainText('Closed · Changes requested');
    await expect(header).toContainText(/Closed by Morgan Lee on \w{3} \d+: Round 1: Changes requested\./);
    await expect(header.getByRole('button', { name: /Close round|Remind/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Edit reviewers and dates' })).toHaveCount(0);
    await expectNoSeriousIssues(page, testInfo, 'round-closed');
  });
});

test.describe('Closing a round', () => {
  for (const { body, label, outcome, setup } of [
    { body: { directionId: 'schedule-first', outcome: 'direction-chosen', statement: '' }, label: 'Direction chosen', outcome: 'direction chosen', setup: async (dialog) => dialog.getByLabel('Direction', { exact: true }).selectOption('schedule-first') },
    { body: { directionId: '', outcome: 'screens-accepted', statement: 'The screens are ready for build.' }, label: 'Screens accepted', outcome: 'screens accepted', setup: async (dialog) => dialog.getByLabel(/^Statement/).fill('The screens are ready for build.') },
    { body: { directionId: '', outcome: 'changes-requested', statement: '' }, label: 'Changes requested', outcome: 'changes requested', setup: async () => {} },
    { body: { directionId: '', outcome: 'abandoned', statement: '' }, label: 'Abandoned', outcome: 'abandoned', setup: async () => {} },
  ]) {
    test(`a manager closes with "${label}" and owns the recorded decision`, async ({ page }) => {
      const { rounds, requirements } = await open(page, roundPath);
      await page.getByRole('button', { name: 'Close round' }).click();
      const dialog = page.getByRole('dialog', { name: 'Close round 2' });
      await expect(dialog.getByRole('radio')).toHaveCount(4);
      await dialog.getByRole('button', { name: 'Close round 2' }).click();
      await expect(dialog.getByRole('alert')).toHaveText('Choose how the round ends.');
      await dialog.getByRole('radio', { name: new RegExp(`^${label}`) }).check();
      if (outcome === 'direction chosen') {
        await dialog.getByRole('button', { name: 'Close round 2' }).click();
        await expect(dialog.getByRole('alert')).toHaveText('Choose the direction that goes forward.');
      }
      await setup(dialog);
      await dialog.getByRole('button', { name: 'Close round 2' }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByRole('status').filter({ hasText: `Round 2 closed: ${outcome}. The decision is recorded in your name.` })).toBeVisible();
      expect(rounds.calls.find((call) => call.path === '/round-2/close').body).toEqual(body);
      const header = page.locator('.rq-topic-head');
      await expect(header).toContainText(`Closed · ${label}`);
      await expect(header).toContainText(/Closed by Synthetic Demo/);
      await expect(header.getByRole('button', { name: 'Close round' })).toHaveCount(0);
      await expect(page.locator('.rq-workspace')).not.toContainText(AI_LABELS);
      expect(requirements.state.decisions.at(-1)).toMatchObject({ decidedBy: { name: 'Synthetic Demo' }, kind: 'round' });
    });
  }

  test('a member sees no Close round, Accept, or Edit, and still edits reviewers and reminds', async ({ page }, testInfo) => {
    const { api } = await open(page, roundPath, asMember);
    await expect(page.getByRole('heading', { level: 2, name: /^Round 2 results/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close round' })).toHaveCount(0);
    const prefs = page.getByRole('region', { name: 'Proposed preferences from this round' });
    await expect(prefs.getByRole('listitem')).toHaveCount(3);
    await expect(prefs.getByRole('button', { name: /^(Accept|Edit) preference/ })).toHaveCount(0);
    await expect(prefs.getByRole('button', { name: /^Ask in round 3/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remind (2)' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit reviewers and dates' })).toBeVisible();
    await expectNoSeriousIssues(page, testInfo, 'round-member');
    api.assertNoUnexpectedRequests();
  });

  test('a viewer reads the round with no actions at all', async ({ page }) => {
    await open(page, roundPath, (scenario) => {
      scenario.canDecide = false;
      scenario.projectRole = 'viewer';
    });
    await expect(page.getByRole('heading', { level: 2, name: /^Round 2 results/ })).toBeVisible();
    for (const name of [/^Remind/, 'Close round', 'Edit reviewers and dates', /^Refresh/, /^Ask in round/, /^Resend|^Remind /]) {
      await expect(page.getByRole('button', { name })).toHaveCount(0);
    }
    await expect(page.getByRole('link', { name: /^Upload v/ })).toHaveCount(0);
  });
});

test.describe('Reviewers', () => {
  test('progress and invitation status per reviewer, with Resend for a failed email', async ({ page }) => {
    const { rounds } = await open(page, roundPath);
    const panel = page.getByRole('region', { name: 'Reviewers' });
    await expect(panel).toContainText('3 of 5 submitted · 2 of 3 required');
    const noor = panel.getByRole('listitem').filter({ hasText: 'Noor Haddad' });
    await expect(noor).toContainText('external · link');
    await expect(noor).toContainText('required');
    await expect(noor).toContainText('In progress · 3 of 9');
    await expect(noor).toContainText('Email failed: the email bounced');
    await expect(panel.getByRole('listitem').filter({ hasText: 'Synthetic Demo' })).toContainText('Not started');
    await expect(panel.getByRole('listitem').filter({ hasText: 'Jamie Ortiz' }).getByRole('button')).toHaveCount(0);

    await noor.getByRole('button', { name: 'Resend invitation to Noor Haddad' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Sent Noor Haddad the invitation again.' })).toBeVisible();
    await expect(noor).toContainText('Invitation queued');
    expect(rounds.calls.filter((call) => call.method === 'POST' && call.path === '/round-2/reviewers/r2-noor/resend')).toHaveLength(1);
  });

  test('Remind sends to the reviewers chosen in the dialog, or straight to the only one left', async ({ page }) => {
    const { rounds } = await open(page, roundPath);
    await page.getByRole('button', { name: 'Remind (2)' }).click();
    const dialog = page.getByRole('dialog', { name: 'Remind reviewers of round 2' });
    await expect(dialog.getByRole('checkbox')).toHaveCount(2);
    await dialog.getByRole('checkbox', { name: /^Synthetic Demo/ }).uncheck();
    await dialog.getByRole('button', { name: 'Send reminders' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('status').filter({ hasText: 'Sent reminders to Noor Haddad.' })).toBeVisible();
    expect(rounds.calls.filter((call) => call.path.endsWith('/resend')).map((call) => call.path)).toEqual(['/round-2/reviewers/r2-noor/resend']);

    rounds.state.rounds.find((round) => round.id === 'round-2').reviewers.find((entry) => entry.id === 'r2-me').submittedAt = new Date().toISOString();
    await page.reload();
    await page.locator('.rq-topic-head').getByRole('button', { name: 'Remind Noor Haddad' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Sent Noor Haddad the invitation again.' })).toBeVisible();
    expect(rounds.calls.filter((call) => call.path.endsWith('/resend'))).toHaveLength(2);
  });

  test('members change required flags, remove and add reviewers, and move the due date and reminder', async ({ page }, testInfo) => {
    const { rounds } = await open(page, roundPath, asMember);
    await page.getByRole('button', { name: 'Edit reviewers and dates' }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit round 2' });
    await expect(dialog.getByLabel('Due')).not.toHaveValue('');
    await expect(dialog.getByLabel('Reminder')).toHaveValue('2');
    await expectNoSeriousIssues(page, testInfo, 'round-edit-dialog');

    await dialog.getByRole('checkbox', { name: 'Alex Kim is required' }).check();
    await dialog.getByRole('button', { name: 'Remove Synthetic Demo' }).click();
    await expect(dialog.getByRole('button', { name: 'Keep Synthetic Demo' })).toHaveAttribute('aria-pressed', 'true');
    // Everyone else is already on the round; the picker lists nobody new.
    await expect(dialog.getByText('Everyone who can review is already on this round.')).toBeVisible();
    await dialog.getByLabel('Due').fill('2030-11-02T12:00');
    await dialog.getByLabel('Reminder').selectOption('');
    await dialog.getByLabel('Note to reviewers').fill('Two more days for the schedule question.');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('status').filter({ hasText: 'Round updated.' })).toBeVisible();

    const patch = rounds.calls.find((call) => call.method === 'PATCH');
    expect(patch.body).toEqual({
      dueAt: new Date(2030, 10, 2, 12, 0).toISOString(),
      note: 'Two more days for the schedule question.',
      reminder: null,
      removeReviewerIds: ['r2-me'],
      updateReviewers: [{ id: 'r2-alex', required: true }],
    });
    const panel = page.getByRole('region', { name: 'Reviewers' });
    await expect(panel).toContainText('3 of 4 submitted · 3 of 4 required');
    await expect(panel.getByRole('listitem').filter({ hasText: 'Synthetic Demo' })).toContainText('Removed');
    await expect(page.locator('.rq-topic-head')).toContainText('Note to reviewers: Two more days for the schedule question.');
  });

  test('adding a reviewer invites them, and an empty reviewer list is refused', async ({ page }) => {
    const { rounds } = await open(page, roundPath, (scenario) => {
      scenario.roundsState.rounds[1].reviewers = scenario.roundsState.rounds[1].reviewers.filter((entry) => entry.id !== 'r2-alex');
    });
    await page.getByRole('button', { name: 'Edit reviewers and dates' }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit round 2' });
    await dialog.getByRole('checkbox', { name: /^Alex Kim ·/ }).check();
    await dialog.getByRole('checkbox', { name: 'Alex Kim is required' }).last().check();
    for (const name of ['Jamie Ortiz', 'Ravi Shah', 'Noor Haddad', 'Synthetic Demo']) await dialog.getByRole('button', { name: `Remove ${name}` }).click();
    await dialog.getByRole('checkbox', { name: /^Alex Kim ·/ }).uncheck();
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Keep at least one reviewer on the round.');
    await dialog.getByRole('checkbox', { name: /^Alex Kim ·/ }).check();
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog).toBeHidden();
    const patch = rounds.calls.find((call) => call.method === 'PATCH');
    expect(patch.body.addReviewers).toEqual([{ actorId: 'user-alex', actorType: 'user', required: false }]);
    expect(patch.body.removeReviewerIds).toEqual(['r2-jamie', 'r2-ravi', 'r2-noor', 'r2-me']);
    await expect(page.getByRole('region', { name: 'Reviewers' }).getByRole('listitem').filter({ hasText: 'Alex Kim' })).toContainText('Invitation queued');
  });
});

test.describe('Editing a round on a tablet', () => {
  // On an iPad, focusing the Due field opens Safari's date picker over the dialog, and Safari
  // can fill the empty field with the current time, which then fails the future-date check.
  test('the dialog opens on its title, a refused save shows why, and a new stakeholder is added', async ({ page }) => {
    const { rounds } = await open(page, roundPath, (scenario) => {
      scenario.stakeholders = [...scenario.stakeholders, { email: 'sam@client.example', id: 'stakeholder-sam', name: 'Sam Stakeholder', roleTitle: 'Operations' }];
    });
    await page.getByRole('button', { name: 'Edit reviewers and dates' }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit round 2' });
    await expect(dialog.getByRole('heading', { name: 'Edit round 2' })).toBeFocused();

    await dialog.getByRole('checkbox', { name: /^Sam Stakeholder ·/ }).check();
    await dialog.getByLabel('Due').fill('2020-01-01T09:00');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    const refusal = dialog.getByRole('alert').filter({ hasText: 'Choose a due date in the future.' });
    await expect(refusal).toBeVisible();
    await expect(refusal).toBeInViewport();
    expect(rounds.calls.some((call) => call.method === 'PATCH')).toBe(false);

    await dialog.getByLabel('Due').fill('2030-11-02T12:00');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog).toBeHidden();
    const patch = rounds.calls.find((call) => call.method === 'PATCH');
    expect(patch.body.addReviewers).toEqual([{ actorId: 'stakeholder-sam', actorType: 'stakeholder', required: false }]);
  });
});

test.describe('Proposed preferences from a round', () => {
  test('a manager accepts one as proposed, and edits another before accepting', async ({ page }) => {
    const { requirements } = await open(page, roundPath);
    const prefs = page.getByRole('region', { name: 'Proposed preferences from this round' });
    await expect(prefs.getByRole('listitem')).toHaveCount(3);
    await expect(prefs).not.toContainText('A preference from a topic, not this round.');
    await expect(prefs.getByRole('listitem').nth(0)).toContainText(/Keep\s*Keep the 14px body text on booking screens\. · type · from the round summary · 2 sources/);
    await expect(prefs.getByRole('listitem').nth(1)).toContainText('hierarchy · from Booking home · 4 sources');

    await prefs.getByRole('button', { name: 'Accept preference: Keep the 14px body text on booking screens.' }).click();
    const dialog = page.getByRole('dialog', { name: 'Accept preference' });
    await expect(dialog.getByRole('button', { name: 'Accept preference' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Accept preference' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('status').filter({ hasText: 'Preference accepted and added to the decision log.' })).toBeVisible();
    await expect(prefs.getByRole('listitem')).toHaveCount(2);
    let call = requirements.calls.filter((entry) => entry.path === '/preferences/accept').at(-1);
    expect(call.body).toMatchObject({ dimension: 'type', key: 'summary-review-2:0', sourceSummaryId: 'summary-review-2', stance: 'keep', statement: 'Keep the 14px body text on booking screens.', track: 'experience' });

    await prefs.getByRole('button', { name: /^Edit preference: Price range/ }).click();
    await expect(dialog.getByLabel('Preference')).toBeFocused();
    await dialog.getByLabel('Preference').fill('Price range says "before tax", under the number, on every screen.');
    await dialog.getByRole('radio', { name: 'keep' }).check();
    await dialog.getByRole('button', { name: 'Accept preference' }).click();
    await expect(dialog).toBeHidden();
    call = requirements.calls.filter((entry) => entry.path === '/preferences/accept').at(-1);
    expect(call.body).toMatchObject({ key: 'summary-home:0', stance: 'keep', statement: 'Price range says "before tax", under the number, on every screen.' });
    await expect(page.locator('.rq-workspace')).not.toContainText(AI_LABELS);
  });

  test('Ask in round 3 copies a ready-to-paste question', async ({ page, context }, testInfo) => {
    test.skip(testInfo.project.name.startsWith('webkit'), 'Clipboard permissions are Chromium-only here.');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await open(page, roundPath);
    const prefs = page.getByRole('region', { name: 'Proposed preferences from this round' });
    await prefs.getByRole('button', { name: /^Ask in round 3: Unavailable time slots/ }).click();
    await expect(prefs.getByRole('status')).toHaveText('Copied the question for round 3. Paste it into the next package’s questions or the next round’s note to reviewers.');
    // Windows clipboards hand text back with CRLF line breaks.
    const copied = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n');
    expect(copied).toBe('Ask in round 3 (Experience): Unavailable time slots: hidden or labeled "fully booked"?\nContext: dimension: behavior; round 2 summary left it undecided.');
  });

  test('without clipboard access, the question opens in a dialog to copy by hand', async ({ page }) => {
    // Both copy paths fail: the Clipboard API and the selection copy (lib/clipboard.js).
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } });
      document.execCommand = () => false;
    });
    await open(page, roundPath);
    await page.getByRole('button', { name: /^Ask in round 3/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Ask in round 3' });
    await expect(dialog.getByRole('textbox')).toHaveValue(/^Ask in round 3 \(Experience\): Unavailable time slots/);
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toBeHidden();
  });
});

test.describe('Live updates', () => {
  test('a submission elsewhere refreshes the round without reloading', async ({ page }) => {
    const { requirements, rounds } = await open(page, roundPath, (scenario) => {
      scenario.liveEvents = true;
    });
    const header = page.locator('.rq-topic-head');
    await expect(header).toContainText('3 of 5 submitted');
    const round = rounds.state.rounds.find((entry) => entry.id === 'round-2');
    round.reviewers.find((entry) => entry.id === 'r2-noor').submittedAt = new Date().toISOString();
    rounds.syncShared();
    requirements.pushEvent({ data: { reason: 'review-submitted', roundId: 'round-2', track: 'experience' }, type: 'requirements.rounds.invalidated' });
    await expect(header).toContainText('4 of 5 submitted', { timeout: 10_000 });
    await expect(page.getByRole('region', { name: 'Reviewers' }).getByRole('listitem').filter({ hasText: 'Noor Haddad' })).toContainText('Submitted');
  });
});

test.describe('My open items', () => {
  test('a review row opens the review and a draft row offers Publish', async ({ page }, testInfo) => {
    const { api } = await open(page, base);
    const review = page.getByRole('region', { name: 'Needs your review' });
    await expect(review.getByRole('link', { name: 'Start review: Round 2' })).toHaveAttribute('href', hasGuidedReview ? /\/review\/rounds\/round-2\/review$/ : /\/review\/rounds\/round-2$/);
    const drafts = page.getByRole('region', { name: 'Your drafts' });
    await expect(drafts.getByRole('link', { name: 'Preview: Client booking — price and booking flow' })).toHaveAttribute('href', /\/packages\/package-3$/);
    await expectNoSeriousIssues(page, testInfo, 'my-items-rounds');
    await drafts.getByRole('link', { name: 'Publish: Client booking — price and booking flow' }).click();
    await expect(page).toHaveURL(/\/packages\/package-3\/publish$/);
    await expect(page.getByRole('heading', { level: 2, name: /^Round 3 ·/ })).toBeVisible();
    api.assertNoUnexpectedRequests();
  });

  test('a viewer sees drafts without Publish', async ({ page }) => {
    await open(page, base, (scenario) => {
      scenario.canDecide = false;
      scenario.projectRole = 'viewer';
    });
    await expect(page.getByRole('region', { name: 'Your drafts' })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Publish:/ })).toHaveCount(0);
  });
});

test.describe('Round views on a phone and with axe', () => {
  test('the round page passes axe, has no page-wide horizontal scroll, and the grid scrolls on its own', async ({ page }, testInfo) => {
    await open(page, roundPath);
    await expect(page.getByText('Keep one primary "Book a visit" action.')).toBeVisible();
    await expectNoSeriousIssues(page, testInfo, 'round-open');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await expect(grid(page)).toHaveAttribute('tabindex', '0');

    // Dark mode keeps the verdict colors, hatching, and text readable.
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await expectNoSeriousIssues(page, testInfo, 'round-open-dark');
    await page.evaluate(() => document.documentElement.classList.remove('dark'));

    await page.getByRole('button', { name: 'Close round' }).click();
    await expectNoSeriousIssues(page, testInfo, 'round-close-dialog');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Close round' })).toBeFocused();
  });

  test('the grid works from the keyboard', async ({ page }) => {
    await open(page, roundPath);
    const first = grid(page).getByRole('button', { name: /^Booking home/ }).first();
    await first.focus();
    await page.keyboard.press('Tab');
    await expect(grid(page).getByRole('button', { name: /^Booking home, schedule first/ })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('region', { name: 'Selected screen: Booking home, schedule first' })).toBeVisible();
  });
});

test.describe('Marks and comments', () => {
  const annotationsPath = `${roundPath}/annotations`;
  const markRows = (scope) => scope.getByRole('button', { name: /^Mark \d+ by/ });
  const detail = (page) => page.getByRole('region', { name: /^Mark \d+ · / });

  test('the round\'s tabs open every mark with its people, and each mark with its discussion', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'chromium-mobile', 'Covered on a phone below.');
    const { pageErrors } = await open(page, roundPath);
    await page.getByRole('navigation', { name: 'Round views' }).getByRole('link', { name: /^Marks and comments/ }).click();
    await expect(page).toHaveURL(/\/review\/rounds\/round-2\/annotations$/);
    await expect(page.getByRole('heading', { level: 2, name: 'Round 2 · Marks and comments' })).toBeVisible();
    await expect(page.getByText('4 marks · 2 comments · 1 written note')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Round views' }).getByRole('link', { name: 'Marks and comments 4' })).toHaveAttribute('aria-current', 'page');

    // Grouped by screen, each mark summed up; resolved marks stay hidden until asked for.
    const home = page.getByRole('region', { exact: true, name: 'Booking home' });
    await expect(markRows(home)).toHaveCount(3);
    await expect(home.getByRole('button', { name: 'Mark 2 by Alex Kim: The price range gets lost under the calendar. Involves Alex Kim, Ravi Shah.' })).toBeVisible();
    await expect(home.getByRole('button', { name: /^Mark 3 by Ravi Shah/ })).toContainText('Calendar open');
    await expect(home).toContainText('One clear booking button.');

    // A wide screen opens the first mark beside the list; picking another opens it there.
    await expect(detail(page).getByRole('heading', { level: 3 })).toHaveText('Mark 1 · Booking home');
    await home.getByRole('button', { name: /^Mark 2 by Alex Kim/ }).click();
    await expect(page).toHaveURL(/#mark-ann-2$/);
    const mark = detail(page);
    await expect(mark.getByRole('heading', { level: 3 })).toHaveText('Mark 2 · Booking home');
    await expect(mark).toContainText('Hierarchy & navigation');
    await expect(mark.getByRole('term').filter({ hasText: 'Posted by' })).toBeVisible();
    await expect(mark.locator('.rq-markpeople')).toContainText('Alex Kim');
    await expect(mark.locator('.rq-markpeople')).toContainText('In the discussion');
    await expect(mark.getByRole('article', { name: 'Ravi Shah, reply C2' })).toContainText('Agree, move it under the main action.');
    // Its picture opens large, and Escape closes it.
    await mark.getByRole('button', { name: 'Enlarge the picture of mark 2' }).click();
    const lightbox = page.getByRole('dialog', { name: 'Mark 2 · Booking home' });
    await expect(lightbox).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(lightbox).toBeHidden();
    await mark.getByRole('button', { name: 'Next: mark 3' }).click();
    await expect(detail(page).getByRole('heading', { level: 3 })).toHaveText('Mark 3 · Booking home · Calendar open');

    await expect(page.getByRole('region', { exact: true, name: 'Price details' })).toHaveCount(0);
    await page.getByLabel('Show resolved').check();
    await expect(page.getByRole('region', { exact: true, name: 'Price details' }).getByRole('button', { name: /^Mark 5 by Noor Haddad/ })).toContainText('Resolved');

    // A reviewer's marks and the marks they replied on.
    await page.getByLabel('Reviewer').selectOption({ label: 'Ravi Shah' });
    await expect(markRows(page)).toHaveCount(2);
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await page.getByLabel('Filter by text').fill('calendar');
    await expect(markRows(page)).toHaveCount(2);
    await page.getByLabel('Filter by text').fill('no such words');
    await expect(page.getByRole('status').filter({ hasText: 'Nothing matches these filters.' })).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).click();

    await expectNoSeriousIssues(page, testInfo, 'round-annotations');
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await expectNoSeriousIssues(page, testInfo, 'round-annotations-dark');
    expect(pageErrors).toEqual([]);
  });

  test('Odin\'s feedback themes cite marks and comments that open in the list', async ({ page }) => {
    await open(page, roundPath);
    const roundSummary = page.getByRole('region', { name: 'Odin summary · Round 2' });
    await expect(roundSummary.getByText('Price visibility')).toBeVisible();
    await expect(roundSummary).toContainText('Reviewers want the price easier to find on the home screen');
    await roundSummary.getByRole('link', { name: 'Annotation comment C2 on Booking home, open in Marks and comments' }).click();
    await expect(page).toHaveURL(/\/review\/rounds\/round-2\/annotations#comment-c-2$/);
    await expect(page.getByRole('article', { name: 'Ravi Shah, reply C2' })).toBeFocused();
  });

  test('on a phone the list comes first, a mark opens on its own, and All marks goes back', async ({ page }) => {
    await page.setViewportSize({ height: 844, width: 390 });
    await open(page, annotationsPath);
    const row = page.getByRole('button', { name: /^Mark 2 by Alex Kim/ });
    await expect(row).toBeVisible();
    await expect(detail(page)).toHaveCount(0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await row.click();
    await expect(detail(page).getByRole('heading', { level: 3 })).toHaveText('Mark 2 · Booking home');
    await expect(row).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await page.getByRole('button', { name: 'All marks' }).click();
    await expect(page.getByRole('button', { name: /^Mark 2 by Alex Kim/ })).toBeFocused();
  });
});
