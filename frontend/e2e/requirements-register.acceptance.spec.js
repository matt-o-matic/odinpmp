import { expect, test } from '@playwright/test';

import { defaultRequirementsScenario, installRequirementsApi } from './fixtures/requirements-api.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

// Synthetic data only: see e2e/fixtures/requirements-api.js.
const discuss = `projects/${syntheticProject.id}/requirements/experience/discuss`;
const AI_LABELS = /AI proposal|drafted by AI|AI-drafted|AI generated|AI-generated|not a decision/i;

async function openRegister(page, adjust = () => {}) {
  const scenario = defaultRequirementsScenario();
  adjust(scenario);
  const api = await installSyntheticApi(page);
  const requirements = await installRequirementsApi(page, scenario);
  await authenticateSyntheticUser(page);
  await page.goto(discuss);
  await expect(page.getByRole('list', { name: 'Experience topics' })).toBeVisible();
  return { api, requirements };
}

function register(page) {
  return page.getByRole('list', { name: 'Experience topics' });
}

// One card per topic.
function rows(page) {
  return register(page).locator(':scope > li');
}

test.describe('Requirements register: Draft questions from brief', () => {
  test('drafted questions land as ordinary open rows citing their brief line, with no AI label', async ({ page }) => {
    const { api, requirements } = await openRegister(page);
    await expect(rows(page)).toHaveCount(5);

    await page.getByRole('button', { name: 'Draft questions from brief' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Added 2 questions from the brief.' })).toBeVisible();
    await expect(page.getByText('Skipped 1 that repeats an existing topic.')).toBeVisible();
    expect(requirements.calls.filter((call) => call.method === 'POST' && call.path === '/tracks/experience/draft-questions')).toHaveLength(1);

    const reschedule = rows(page).filter({ hasText: 'How do clients reschedule or cancel' });
    await expect(reschedule).toBeVisible();
    await expect(reschedule).toContainText('brief line 3');
    await expect(reschedule.getByText('Open', { exact: true })).toBeVisible();
    await expect(reschedule).toHaveClass(/rq-row--new/);
    await expect(rows(page).filter({ hasText: 'What does "fast" mean for booking' })).toContainText('brief line 5');
    await expect(page.locator('.rq-workspace')).not.toContainText(AI_LABELS);
    api.assertNoUnexpectedRequests();
  });

  test('503: explains that no AI provider is set up and adds nothing', async ({ page }) => {
    const { api } = await openRegister(page, (scenario) => { scenario.draftMode = 'ai_not_configured'; });
    await page.getByRole('button', { name: 'Draft questions from brief' }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'no AI provider is set up' });
    await expect(alert).toBeVisible();
    await expect(alert.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    await expect(rows(page)).toHaveCount(5);
    api.assertNoUnexpectedRequests();
  });

  test('502: offers a retry that succeeds once the provider recovers', async ({ page }) => {
    const { api, requirements } = await openRegister(page, (scenario) => { scenario.draftMode = 'ai_output_invalid'; });
    await page.getByRole('button', { name: 'Draft questions from brief' }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'unexpected shape, so nothing was added' });
    await expect(alert).toBeVisible();
    await expect(rows(page)).toHaveCount(5);

    requirements.state.draftMode = 'success';
    await alert.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByText('Added 2 questions from the brief.')).toBeVisible();
    await expect(rows(page)).toHaveCount(7);
    api.assertNoUnexpectedRequests();
  });

  test('409: an empty brief points to the project brief', async ({ page }) => {
    const { api } = await openRegister(page, (scenario) => { scenario.draftMode = 'brief_empty'; });
    await page.getByRole('button', { name: 'Draft questions from brief' }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'The project brief is empty.' });
    await expect(alert).toBeVisible();
    await expect(alert.getByRole('link', { name: 'Open the project brief' })).toHaveAttribute('href', new RegExp(`/projects/${syntheticProject.id}\\?projectSettings=details$`));
    api.assertNoUnexpectedRequests();
  });

  test('the Brief stage shows topic coverage per line and drafts from there too', async ({ page }) => {
    const { api } = await openRegister(page);
    await page.getByRole('navigation', { name: 'Experience stages' }).getByRole('link', { name: /Brief/ }).click();
    await expect(page).toHaveURL(/\/experience\/brief$/);
    const lines = page.locator('.rq-brief__line');
    await expect(lines).toHaveCount(5);
    await expect(lines.nth(1)).toContainText('1 topic');
    await expect(lines.nth(2)).toContainText('No topics yet');
    await page.getByRole('button', { name: 'Draft questions from brief' }).click();
    await expect(page.getByText('Added 2 questions from the brief.')).toBeVisible();
    await expect(lines.nth(2)).toContainText('1 topic');
    await lines.nth(1).getByRole('link', { name: '1 topic' }).click();
    await expect(page).toHaveURL(/\/experience\/discuss\?line=brief(%3A|:)requirements(%3A|:)1$/);
    await expect(rows(page)).toHaveCount(1);
    api.assertNoUnexpectedRequests();
  });
});

test.describe('Requirements register: filters, search, topic cards, add topic', () => {
  test('filters apply directly, each card carries its summary, and a card opens its topic', async ({ page }) => {
    const { api } = await openRegister(page);
    const filters = page.getByRole('group', { name: 'Show topics' });

    await expect(rows(page).nth(0)).toContainText('Should clients see an estimated price');
    await filters.getByRole('radio', { name: 'Decided · 1' }).check();
    await expect(rows(page)).toHaveCount(1);
    await expect(register(page)).toContainText('Is booking the first task on the home screen?');
    await filters.getByRole('radio', { name: 'Open · 4' }).check();
    await expect(rows(page)).toHaveCount(4);
    await page.getByLabel('Filter topics').fill('technicians');
    await expect(rows(page)).toHaveCount(1);
    await page.getByLabel('Filter topics').fill('nothing matches this');
    await expect(page.getByText('No topics match this filter.')).toBeVisible();
    await page.getByLabel('Filter topics').fill('');
    await filters.getByRole('radio', { name: 'Needs a decision first' }).check();

    await expect(page.getByRole('complementary', { name: 'Topic preview' })).toHaveCount(0);
    const price = rows(page).filter({ hasText: 'Should clients see an estimated price before they pick a time?' });
    await expect(price.getByText('Odin summary')).toBeVisible();
    await expect(price).toContainText('Show a price range before tax on the home screen.');
    await expect(price.getByText('Clients should never be surprised by the final price.')).toBeVisible();

    const reminder = rows(page).filter({ hasText: 'Do clients want reminders by email, text, or both?' });
    await expect(reminder).toContainText('Odin needs input from two or more people');
    await reminder.getByRole('link', { name: 'Do clients want reminders by email, text, or both?' }).click();
    await expect(page).toHaveURL(/\/requirements\/topics\/topic-reminder$/);
    await expect(page.getByRole('heading', { name: 'Do clients want reminders by email, text, or both?' })).toBeFocused();
    api.assertNoUnexpectedRequests();
  });

  test('each card shows its owner and everyone else involved as badges', async ({ page }) => {
    const { api } = await openRegister(page, (scenario) => {
      const crowded = scenario.topics.find((topic) => topic.id === 'topic-reminder');
      crowded.owner = null;
      crowded.assignments = ['Ana', 'Ben', 'Cy', 'Di', 'Ed', 'Flo'].map((name, index) => ({ actorId: `stakeholder-${index}`, actorType: 'stakeholder', id: `a-${index}`, label: `${name} Stake`, role: 'collaborator' }));
    });
    const price = rows(page).filter({ hasText: 'Should clients see an estimated price before they pick a time?' });
    const people = price.getByRole('img', { name: 'Owner: Jamie Ortiz. Also involved: Ravi Shah, Alex Kim' });
    await expect(people).toBeVisible();
    await expect(people.locator('.rq-avatar--owner')).toHaveText('JO');
    await expect(people.locator('.rq-avatars .rq-avatar')).toHaveText(['RS', 'AK']);

    // No owner yet, and more people than fit: four badges and a count.
    const reminder = rows(page).filter({ hasText: 'Do clients want reminders by email, text, or both?' });
    const crowd = reminder.getByRole('img', { name: /^No owner\. Also involved: Ana Stake, Ben Stake/ });
    await expect(crowd.locator('.rq-avatar')).toHaveText(['AS', 'BS', 'CS', 'DS', '+2']);
    api.assertNoUnexpectedRequests();
  });

  test('on a phone the register stacks and each topic opens directly', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-mobile', 'Phone layout check.');
    const { api } = await openRegister(page);
    await register(page).getByRole('link', { name: 'Do technicians see client notes before the visit?' }).click();
    await expect(page).toHaveURL(/\/requirements\/topics\/topic-notes$/);
    const width = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    expect(width.scroll).toBeLessThanOrEqual(width.client + 1);
    api.assertNoUnexpectedRequests();
  });

  test('Add topic opens a dialog, saves, and returns focus', async ({ page }) => {
    const { api, requirements } = await openRegister(page);
    const opener = page.getByRole('button', { name: 'Add topic' });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Add a topic to Experience' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Question')).toBeFocused();
    await dialog.getByRole('button', { name: 'Add topic' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Write the question this topic should settle.');
    await dialog.getByLabel('Question').fill('Who approves price changes after booking?');
    await dialog.getByLabel('Brief line (optional)').selectOption('brief:requirements:1');
    await dialog.getByRole('button', { name: 'Add topic' }).click();
    await expect(dialog).toBeHidden();
    await expect(rows(page).filter({ hasText: 'Who approves price changes after booking?' })).toContainText('brief line 2');
    await expect(opener).toBeFocused();
    const create = requirements.calls.find((call) => call.method === 'POST' && call.path === '/tracks/experience/topics');
    expect(create.body).toMatchObject({ prompt: 'Who approves price changes after booking?', sourceRef: 'brief:requirements:1' });
    api.assertNoUnexpectedRequests();
  });

  test('viewers browse the register without add or draft controls', async ({ page }) => {
    const { api } = await openRegister(page, (scenario) => {
      scenario.canDecide = false;
      scenario.projectRole = 'viewer';
    });
    await expect(page.getByRole('button', { name: 'Add topic' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Draft questions from brief' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Record decision' })).toHaveCount(0);
    api.assertNoUnexpectedRequests();
  });

  test('a requirements event refreshes the register without reloading', async ({ page }) => {
    const { api, requirements } = await openRegister(page, (scenario) => { scenario.liveEvents = true; });
    await expect(rows(page)).toHaveCount(5);
    requirements.state.topics.push({
      ...structuredClone(requirements.state.topics.find((topic) => topic.id === 'topic-accessibility')),
      id: 'topic-live', prompt: 'Added by someone else while you watched?',
    });
    requirements.pushEvent({ data: { reason: 'topic-created', topicIds: ['topic-live'], track: 'experience' }, type: 'requirements.topics.invalidated' });
    await expect(rows(page).filter({ hasText: 'Added by someone else while you watched?' })).toBeVisible();
    api.assertNoUnexpectedRequests();
  });
});

test.describe('Requirements register: bulk actions', () => {
  const card = (page, prompt) => rows(page).filter({ hasText: prompt });
  const select = (page, prompt) => page.getByRole('checkbox', { name: `Select: ${prompt}` }).check();
  const PRICE = 'Should clients see an estimated price before they pick a time?';
  const REMINDER = 'Do clients want reminders by email, text, or both?';
  const ACCESSIBILITY = 'Which accessibility standard applies, and who signs off on it?';

  test('agree records each topic\'s own Odin answer and says which were left alone', async ({ page }) => {
    const { api, requirements } = await openRegister(page);
    const toolbar = page.getByRole('toolbar', { name: 'Selected topics' });
    await expect(toolbar.getByRole('button', { name: /Agree/ })).toHaveCount(0);
    await select(page, PRICE);
    await select(page, REMINDER);
    await expect(toolbar).toContainText('2 selected');
    await expect(card(page, PRICE)).toHaveClass(/rq-topic-card--selected/);

    await toolbar.getByRole('button', { name: /Agree/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Agree on 2 topics' });
    await expect(dialog).toContainText('Show a price range before tax on the home screen.');
    await expect(dialog).toContainText('1 of these will be left as they are');
    await dialog.getByRole('button', { name: 'Agree 2 topics' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('status').filter({ hasText: 'Agreed on 1 topic. 1 topic left as they were: no odin proposed answer to agree to yet.' })).toBeVisible();
    const call = requirements.calls.find((entry) => entry.method === 'POST' && entry.path === '/topics/bulk');
    expect(call.body).toEqual({ action: 'agree', topicIds: ['topic-price', 'topic-reminder'] });
    // The skipped topic stays selected; the agreed one leaves the selection.
    await expect(toolbar).toContainText('1 selected');
    await expect(page.getByRole('checkbox', { name: `Select: ${REMINDER}` })).toBeChecked();
    api.assertNoUnexpectedRequests();
  });

  test('assign sets one owner on several topics; dismiss and reopen go through the Dismissed filter', async ({ page }) => {
    const { api, requirements } = await openRegister(page);
    const toolbar = page.getByRole('toolbar', { name: 'Selected topics' });
    await select(page, REMINDER);
    await select(page, ACCESSIBILITY);
    await toolbar.getByRole('button', { name: /Assign/ }).click();
    const assign = page.getByRole('dialog', { name: 'Change people on 2 topics' });
    await assign.getByLabel('Owner').selectOption('stakeholder:stakeholder-noor');
    await assign.getByRole('button', { name: 'Save people 2 topics' }).click();
    await expect(assign).toBeHidden();
    await expect(page.getByRole('status').filter({ hasText: 'Changed people on 2 topics.' })).toBeVisible();
    expect(requirements.calls.find((entry) => entry.path === '/topics/bulk').body).toEqual({
      action: 'assign', assign: { add: [], owner: { actorId: 'stakeholder-noor', actorType: 'stakeholder' }, remove: [] }, topicIds: ['topic-reminder', 'topic-accessibility'],
    });
    await expect(card(page, REMINDER).getByRole('img', { name: /^Owner: Noor Haddad/ })).toBeVisible();

    await expect(toolbar).toContainText('Select all shown');
    await select(page, REMINDER);
    await toolbar.getByRole('button', { name: /Dismiss/ }).click();
    await page.getByRole('dialog', { name: 'Dismiss 1 topic' }).getByRole('button', { name: 'Dismiss 1 topic' }).click();
    await expect(card(page, REMINDER)).toHaveCount(0);
    const filters = page.getByRole('group', { name: 'Show topics' });
    await filters.getByRole('radio', { name: /^Dismissed/ }).check();
    await expect(card(page, REMINDER)).toHaveCount(1);
    await page.getByRole('checkbox', { name: 'Select all shown' }).check();
    await toolbar.getByRole('button', { name: /Reopen/ }).click();
    await page.getByRole('dialog', { name: /^Reopen/ }).getByRole('button', { name: /^Reopen/ }).click();
    await expect(page.getByRole('status').filter({ hasText: /^Reopened 1 topic/ })).toBeVisible();
    api.assertNoUnexpectedRequests();
  });

  test('a member gets only the actions their role allows', async ({ page }) => {
    const { api } = await openRegister(page, (scenario) => {
      scenario.canDecide = false;
      scenario.projectRole = 'member';
    });
    await select(page, PRICE);
    const toolbar = page.getByRole('toolbar', { name: 'Selected topics' });
    await expect(toolbar.getByRole('button')).toHaveText([/Assign/, /Delete/, 'Clear selection']);
    api.assertNoUnexpectedRequests();
  });
});
