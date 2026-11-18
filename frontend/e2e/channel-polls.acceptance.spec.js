import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { settleForAxe } from './fixtures/axe-settle.js';
import { createChannelsWorld, installChannelsApi } from './fixtures/channels-api.js';
import { storedPoll } from './fixtures/polls-fixture.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

// Polls in channels: the composer's Poll dialog, voting in each
// kind, changing a vote, results, anonymous polls and closing. The API is the channels fixture
// (fixtures/polls-fixture.js); backend/test/polls.test.js covers the server's rules and tallies.

test.describe.configure({ timeout: 60_000 });

const CHANNELS = `projects/${syntheticProject.id}/channels?channel=channel-general`;
const at = (minutes) => new Date(Date.UTC(2026, 10, 14, 10, minutes)).toISOString();

async function expectNoSeriousAxe(page) {
  await settleForAxe(page);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).include('#main-content').analyze();
  expect(results.violations.filter(({ impact }) => ['critical', 'serious'].includes(impact)).map(({ id, nodes }) => `${id}: ${nodes.map((node) => node.target).join(', ')}`)).toEqual([]);
}

/** A poll Pat posted, and any votes already in it ({ userId, answer }). */
function withPoll(world, id, input, votes = []) {
  world.posts.push({ authorId: 'user-pat', body: input.question, createdAt: at(id.length), id, parentId: null, poll: storedPoll(input), targetId: 'channel-general' });
  world.pollVotes = [...(world.pollVotes ?? []), ...votes.map((vote) => ({ ...vote, postId: id }))];
  return world;
}

async function openGeneral(page, world) {
  const api = await installSyntheticApi(page);
  await installChannelsApi(page, { world });
  await authenticateSyntheticUser(page);
  await page.goto(CHANNELS);
  await expect(page.getByText('Kick-off notes are in the library.')).toBeVisible();
  return api;
}

// The composer's option fields, in order.
const optionValues = (dialog) => dialog.locator('.poll-composer__option input').evaluateAll((inputs) => inputs.map((input) => input.value));

const pollIn = (page, question) => page.locator('.post-poll').filter({ has: page.getByText(question, { exact: true }) });

test('a member posts a single-choice poll, votes, changes the vote, and closes it', async ({ page }, testInfo) => {
  const world = createChannelsWorld();
  const api = await openGeneral(page, world);

  await page.getByRole('button', { exact: true, name: 'Poll' }).click();
  const dialog = page.getByRole('dialog', { name: 'New poll' });
  await expect(dialog.getByLabel('Question')).toBeFocused();
  await dialog.getByLabel('Question').fill('Kick-off day?');
  // Yes / No / Maybe fills the options; then they are edited.
  await dialog.getByRole('button', { name: 'Yes / No / Maybe' }).click();
  await expect.poll(() => optionValues(dialog)).toEqual(['Yes', 'No', 'Maybe']);
  await dialog.getByLabel('Option 1', { exact: true }).fill('Monday');
  await dialog.getByLabel('Option 2', { exact: true }).fill('Tuesday');
  await dialog.getByRole('button', { name: 'Remove option 3' }).click();
  await dialog.getByRole('button', { name: 'Post poll' }).click();
  await expect(dialog).toBeHidden();
  const sent = world.calls.find((call) => call.method === 'POST' && call.path.endsWith('/posts'));
  expect(sent.body.poll).toEqual({ kind: 'single', options: ['Monday', 'Tuesday'], question: 'Kick-off day?', settings: { anonymous: false, showResults: 'always' } });

  const poll = pollIn(page, 'Kick-off day?');
  await expect(poll.getByRole('radio')).toHaveCount(2);
  // The question shows once: in the poll, not again as the post's text.
  await expect(page.locator('.channel-post').filter({ has: poll }).locator('.channel-post__body')).toHaveCount(0);
  await expect(poll.getByRole('button', { name: 'Vote' })).toBeDisabled();
  await poll.getByRole('radio', { name: 'Tuesday' }).check();
  await poll.getByRole('button', { name: 'Vote' }).click();
  await expect(poll.getByText('1 person voted')).toBeVisible();
  await expect(poll.getByRole('group', { name: /Results/ })).toContainText('Tuesday');
  await expect(poll.getByRole('group', { name: /Results/ })).toContainText('Synthetic Demo');
  await poll.scrollIntoViewIfNeeded();
  if (testInfo.project.name === 'chromium-desktop') await page.screenshot({ path: testInfo.outputPath('poll-single-results.png') });

  await poll.getByRole('button', { name: 'Change vote' }).click();
  await expect(poll.getByRole('radio', { name: 'Tuesday' })).toBeChecked();
  await poll.getByRole('radio', { name: 'Monday' }).check();
  await poll.getByRole('button', { name: 'Save vote' }).click();
  await expect(poll.locator('.post-poll__bar--mine')).toContainText('Monday');
  expect(world.pollVotes.filter((vote) => vote.userId === 'user-synthetic')).toHaveLength(1);
  await expectNoSeriousAxe(page);

  await poll.getByRole('button', { name: 'Close poll' }).click();
  await page.getByRole('dialog', { name: 'Close this poll?' }).getByRole('button', { name: 'Close poll' }).click();
  await expect(poll.getByText('Closed', { exact: true })).toBeVisible();
  await expect(poll.getByRole('button', { name: 'Change vote' })).toHaveCount(0);
  await expect(poll.getByRole('button', { name: 'Close poll' })).toHaveCount(0);
  api.assertNoUnexpectedRequests();
});

test('a ranking poll orders by keyboard, and results list Borda points and average ranks', async ({ page }, testInfo) => {
  const world = withPoll(createChannelsWorld(), 'post-rank', { kind: 'ranking', options: ['Mon 17', 'Tue 18', 'Wed 19'], question: 'Which workshop date?' }, [{ answer: { order: ['o2', 'o1', 'o3'] }, userId: 'user-pat' }]);
  const api = await openGeneral(page, world);
  const poll = pollIn(page, 'Which workshop date?');
  const order = poll.getByRole('list', { name: /Your order/ });
  await expect(order.getByRole('listitem')).toHaveText([/Mon 17/, /Tue 18/, /Wed 19/]);
  // Wed to the top with the keyboard: its Up button twice, each move announced.
  await poll.getByRole('button', { name: 'Move Wed 19 up' }).focus();
  await page.keyboard.press('Enter');
  await expect(poll.locator('[aria-live="polite"]')).toHaveText('Wed 19 moved to place 2 of 3.');
  await poll.getByRole('button', { name: 'Move Wed 19 up' }).focus();
  await page.keyboard.press('Enter');
  await expect(order.getByRole('listitem')).toHaveText([/Wed 19/, /Mon 17/, /Tue 18/]);
  await expect(poll.getByRole('button', { name: 'Move Wed 19 up' })).toBeDisabled();
  await expectNoSeriousAxe(page);
  await poll.getByRole('button', { name: 'Vote' }).click();

  const results = poll.getByRole('group', { name: /Results: 2 people voted/ });
  // Pat ranked Tue, Mon, Wed; this person Wed, Mon, Tue. With 3 options first place scores 2,
  // second 1, last 0: Mon 1+1, Tue 2+0 and Wed 0+2, so all three tie on 2 points.
  await expect(results.getByRole('listitem')).toHaveCount(3);
  await expect(results).toContainText('2 pts');
  await expect(results).toContainText('avg. rank 2');
  expect(world.pollVotes.find((vote) => vote.userId === 'user-synthetic').answer).toEqual({ order: ['o3', 'o1', 'o2'] });
  if (testInfo.project.name === 'chromium-desktop') {
    await poll.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('poll-ranking-results.png') });
  }
  api.assertNoUnexpectedRequests();
});

test('an anonymous fill-in-the-blank poll hides results until you answer, groups answers, and names nobody', async ({ page }) => {
  const world = withPoll(createChannelsWorld(), 'post-text', { kind: 'text', question: 'One word for the launch?', settings: { anonymous: true, showResults: 'after_vote' } }, [{ answer: { text: 'Smooth' }, userId: 'user-pat' }]);
  const api = await openGeneral(page, world);
  const poll = pollIn(page, 'One word for the launch?');
  await expect(poll).toContainText('Anonymous');
  await expect(poll.getByText('1 person voted')).toBeVisible();
  await expect(poll.getByRole('group', { name: /Results/ })).toHaveCount(0);
  await expect(poll.getByRole('button', { name: 'See results' })).toHaveCount(0);
  await poll.getByRole('textbox', { name: 'Your answer' }).fill('  smooth ');
  await poll.getByRole('button', { name: 'Vote' }).click();
  const results = poll.getByRole('group', { name: /Results: 2 people voted/ });
  await expect(results.getByRole('listitem')).toHaveText([/Smooth\s*×2/]);
  await expect(poll).not.toContainText('Pat Seller');
  await expect(poll).not.toContainText('Synthetic Demo');
  await expectNoSeriousAxe(page);
  api.assertNoUnexpectedRequests();
});

test('a rating poll averages the scale, and a multiple-choice poll stops at its most choices', async ({ page }) => {
  const world = createChannelsWorld();
  withPoll(world, 'post-rating', { kind: 'rating', question: 'How did the workshop go?', settings: { scaleMax: 10 } }, [{ answer: { value: 6 }, userId: 'user-pat' }]);
  withPoll(world, 'post-multiple-choice', { kind: 'multiple', options: ['Agenda', 'Room', 'Lunch'], question: 'What needs work?', settings: { maxChoices: 2 } });
  const api = await openGeneral(page, world);

  const rating = pollIn(page, 'How did the workshop go?');
  // Results show to all here, so they can be looked at first.
  await rating.getByRole('button', { name: 'See results' }).click();
  await expect(rating.locator('.post-poll__average strong')).toHaveText('6');
  await rating.getByRole('radio', { name: '10' }).check();
  await rating.getByRole('button', { name: 'Vote' }).click();
  await expect(rating.locator('.post-poll__average strong')).toHaveText('8');
  await expect(rating).toContainText('average of 10');

  const multiple = pollIn(page, 'What needs work?');
  await expect(multiple.getByText('Pick up to 2.')).toBeVisible();
  await multiple.getByRole('checkbox', { name: 'Agenda' }).check();
  await multiple.getByRole('checkbox', { name: 'Lunch' }).check();
  await expect(multiple.getByRole('checkbox', { name: 'Room' })).toBeDisabled();
  await multiple.getByRole('button', { name: 'Vote' }).click();
  await expect(multiple.getByRole('group', { name: /Results/ }).locator('.post-poll__bar--mine')).toHaveText([/Agenda/, /Lunch/]);
  // Pat made it, so this person can't close it.
  await expect(multiple.getByRole('button', { name: 'Close poll' })).toHaveCount(0);
  await expectNoSeriousAxe(page);
  api.assertNoUnexpectedRequests();
});

test('the Poll dialog makes ranking, rating and fill-in-the-blank polls with their settings', async ({ page }) => {
  const world = createChannelsWorld();
  const api = await openGeneral(page, world);
  const box = page.getByRole('textbox', { name: 'Message General' });
  await box.click();
  await page.keyboard.type('Please rank these before Friday.');
  await page.getByRole('button', { exact: true, name: 'Poll' }).click();
  const dialog = page.getByRole('dialog', { name: 'New poll' });
  await dialog.getByLabel('Question').fill('Which vendor?');
  await dialog.getByRole('radio', { name: 'Ranking' }).check();
  await dialog.getByLabel('Option 1', { exact: true }).fill('Contoso');
  await dialog.getByLabel('Option 2', { exact: true }).fill('Fabrikam');
  await dialog.getByRole('button', { name: 'Add option' }).click();
  await dialog.getByLabel('Option 3', { exact: true }).fill('Northwind');
  await dialog.getByRole('button', { name: 'Move option 3 up' }).click();
  await expect.poll(() => optionValues(dialog)).toEqual(['Contoso', 'Northwind', 'Fabrikam']);
  await dialog.getByRole('checkbox', { name: /Anonymous/ }).check();
  await expectNoSeriousAxe(page);
  await dialog.getByRole('button', { name: 'Post poll' }).click();
  await expect(dialog).toBeHidden();
  const posted = world.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/posts')).at(-1).body;
  expect(posted).toMatchObject({ body: 'Please rank these before Friday.', poll: { kind: 'ranking', options: ['Contoso', 'Northwind', 'Fabrikam'], question: 'Which vendor?', settings: { anonymous: true, showResults: 'always' } } });
  // The text above the poll shows with it.
  await expect(page.locator('.channel-post').filter({ has: pollIn(page, 'Which vendor?') })).toContainText('Please rank these before Friday.');
  await expect(box).toHaveText('');

  // A rating with no options, and a check that a question is required.
  await page.getByRole('button', { exact: true, name: 'Poll' }).click();
  await dialog.getByRole('radio', { name: 'Rating scale' }).check();
  await expect(dialog.locator('.poll-composer__option')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Post poll' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Write the question.');
  await dialog.getByLabel('Question').fill('Confidence in the date?');
  await dialog.getByRole('radio', { name: '1 to 10' }).check();
  await dialog.getByRole('checkbox', { name: /only after/ }).check();
  await dialog.getByRole('button', { name: 'Post poll' }).click();
  await expect(dialog).toBeHidden();
  expect(world.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/posts')).at(-1).body.poll).toEqual({ kind: 'rating', options: [], question: 'Confidence in the date?', settings: { anonymous: false, scaleMax: 10, showResults: 'after_vote' } });

  await page.getByRole('button', { exact: true, name: 'Poll' }).click();
  await dialog.getByLabel('Question').fill('Project code name?');
  await dialog.getByRole('radio', { name: 'Fill in the blank' }).check();
  await dialog.getByRole('button', { name: 'Post poll' }).click();
  await expect(pollIn(page, 'Project code name?').getByRole('textbox', { name: 'Your answer' })).toBeVisible();
  api.assertNoUnexpectedRequests();
});
