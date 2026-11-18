import { expect, test } from '@playwright/test';

import { defaultRequirementsScenario, installRequirementsApi } from './fixtures/requirements-api.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

// Synthetic data only: see e2e/fixtures/requirements-api.js.
const topicPath = (id) => `projects/${syntheticProject.id}/requirements/topics/${id}`;
const AI_LABELS = /AI proposal|drafted by AI|AI-drafted|AI generated|AI-generated|not a decision/i;

async function openTopic(page, topicId, adjust = () => {}, query = '') {
  const scenario = defaultRequirementsScenario();
  adjust(scenario);
  const api = await installSyntheticApi(page);
  const requirements = await installRequirementsApi(page, scenario);
  await authenticateSyntheticUser(page);
  await page.goto(`${topicPath(topicId)}${query}`);
  await expect(page.locator('#rq-topic-title')).not.toHaveText('Loading topic…');
  return { api, requirements };
}

test.describe('Requirements topic: discussion and Odin summary', () => {
  test('numbers sources, renders every summary section, and links citations to comments', async ({ page }) => {
    const { api } = await openTopic(page, 'topic-price');

    await expect(page.getByRole('heading', { name: 'Should clients see an estimated price before they pick a time?' })).toBeVisible();
    const discussion = page.getByRole('region', { name: 'Discussion' });
    await expect(discussion.locator('.rq-comment__label')).toHaveText(['C1', 'C2', 'C3', 'C4']);
    await expect(discussion.getByText('Email reply')).toBeVisible();
    await expect(discussion.locator('#rq-comment-comment-price-odin .rq-comment__label')).toHaveCount(0);

    const summary = page.getByRole('region', { name: 'Odin summary' });
    await expect(summary.getByRole('heading', { name: 'Odin summary' })).toBeVisible();
    await expect(summary.getByRole('heading', { name: 'Aligned · 2' })).toBeVisible();
    await expect(summary.getByRole('heading', { name: 'Diverging · 1' })).toBeVisible();
    await expect(summary.getByRole('heading', { name: 'Under-explored · 1' })).toBeVisible();
    await expect(summary.getByRole('heading', { name: 'Outstanding · 2' })).toBeVisible();
    await expect(summary.getByText('blocking', { exact: true })).toBeVisible();
    await expect(summary.getByRole('img', { name: 'Ravi Shah' }).first()).toBeVisible();

    await summary.getByRole('button', { name: 'Source C2: go to comment' }).first().click();
    await expect(page.locator('#rq-comment-comment-price-2')).toBeFocused();

    await summary.getByRole('button', { name: /^Ask the group:/ }).click();
    const composer = page.getByLabel('Add to the discussion');
    await expect(composer).toBeFocused();
    await expect(composer).toHaveText('How should we calculate a price range before we know the job type?');

    await expect(page.locator('.rq-workspace')).not.toContainText(AI_LABELS);
    api.assertNoUnexpectedRequests();
  });

  test('shows "Not enough input yet" when the summary says so', async ({ page }) => {
    const { api } = await openTopic(page, 'topic-reminder');
    const summary = page.getByRole('region', { name: 'Odin summary' });
    await expect(summary.getByText('Not enough input yet')).toBeVisible();
    await expect(summary.getByRole('heading', { name: /Aligned/ })).toHaveCount(0);
    api.assertNoUnexpectedRequests();
  });

  test('a topic without a summary shows a quiet empty state', async ({ page }) => {
    const { api } = await openTopic(page, 'topic-notes');
    await expect(page.getByRole('region', { name: 'Odin summary' }).getByText('No summary yet.')).toBeVisible();
    api.assertNoUnexpectedRequests();
  });

  test('comment, reply, vote, edit, and remove update the thread in place', async ({ page }) => {
    const { api, requirements } = await openTopic(page, 'topic-price', () => {}, '?focus=reply');
    const composer = page.getByLabel('Add to the discussion');
    await expect(composer).toBeFocused();
    await composer.fill('Finance can confirm the refund wording by Friday.');
    await page.getByRole('button', { name: 'Post comment' }).click();
    const posted = page.getByRole('article', { name: 'C5, Synthetic Demo' });
    await expect(posted).toContainText('Finance can confirm the refund wording by Friday.');
    await expect(composer).toHaveText('');

    // By keyboard: when a press takes focus out of the editor, WebKit can scroll the page between
    // press and release, and the click lands on another element. This test is about the thread.
    await page.getByRole('button', { name: 'Reply to C1' }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('textbox', { name: 'Reply to C1' }).fill('Agreed, but only after the range is labeled.');
    await page.getByRole('button', { name: 'Post reply' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#rq-comment-comment-price-1').locator('xpath=..').locator('.rq-thread')).toContainText('Agreed, but only after the range is labeled.');

    const agree = page.getByRole('button', { name: /^Agree with C4/ });
    await agree.click();
    await expect(agree).toHaveAttribute('aria-pressed', 'true');
    expect(requirements.calls.some((call) => call.method === 'POST' && call.path.endsWith('/comments/comment-price-4/vote'))).toBe(true);

    await posted.getByRole('button', { name: 'Edit C5' }).click();
    await page.getByRole('textbox', { name: 'Edit C5' }).fill('Finance confirms the refund wording on Friday.');
    await page.getByRole('button', { name: 'Save edit' }).click();
    await expect(posted).toContainText('Finance confirms the refund wording on Friday.');
    await expect(posted).toContainText('Edited');

    await posted.getByRole('button', { name: 'Remove C5' }).click();
    const confirm = page.getByRole('dialog', { name: 'Remove this comment?' });
    await confirm.getByRole('button', { name: 'Remove comment' }).click();
    await expect(confirm).toBeHidden();
    await expect(posted).toContainText('Comment removed.');
    api.assertNoUnexpectedRequests();
  });
});

test.describe('Requirements topic: decisions and permissions', () => {
  test('a manager records a decision prefilled from the summary; it shows their name and no AI tag', async ({ page }) => {
    const { api, requirements } = await openTopic(page, 'topic-price');
    const decision = page.getByRole('region', { name: 'Record a decision' });
    await expect(decision).toBeVisible();
    const statement = decision.getByLabel('Decision statement', { exact: true });
    await expect(statement).toHaveText('Show a price range before tax on the home screen. Confirm the exact price, with tax, before payment.');
    await expect(decision.getByText('Prefilled from the summary.', { exact: false })).toBeVisible();
    await expect(decision.getByText('Sources C1, C2, C3, C4 are attached.', { exact: false })).toBeVisible();
    await expect(decision.getByText('1 blocking item still open')).toBeVisible();
    await expect(decision.getByRole('radio', { name: 'Agreed' })).toBeChecked();

    await decision.getByRole('radio', { name: 'Decided' }).check();
    // The larger editor edits the same statement.
    await decision.getByRole('button', { name: 'Open larger editor' }).click();
    const large = page.getByRole('dialog', { name: 'Edit decision statement' });
    await large.getByLabel('Decision statement', { exact: true }).fill('Show a price range before tax on home; confirm the exact price with tax before payment.');
    await large.getByRole('button', { name: 'Done' }).click();
    await expect(large).toBeHidden();
    await expect(statement).toHaveText('Show a price range before tax on home; confirm the exact price with tax before payment.');
    await decision.getByRole('button', { name: 'Record decision' }).click();

    const recorded = page.getByRole('region', { name: 'Decision' });
    await expect(recorded.getByText('Recorded by Synthetic Demo', { exact: false })).toBeVisible();
    await expect(recorded.getByText('Show a price range before tax on home; confirm the exact price with tax before payment.')).toBeVisible();
    await expect(recorded.getByText('Decided', { exact: true })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Decision recorded.' })).toBeVisible();
    await expect(page.locator('.rq-workspace')).not.toContainText(AI_LABELS);

    const call = requirements.calls.find((entry) => entry.method === 'POST' && entry.path === '/decisions');
    expect(call.body).toMatchObject({
      outcome: 'decided',
      statement: 'Show a price range before tax on home; confirm the exact price with tax before payment.',
      sourceSummaryId: 'summary-price',
      sources: ['comment:comment-price-2', 'comment:comment-price-3', 'comment:comment-price-4', 'comment:comment-price-1'],
      topicId: 'topic-price',
    });
    api.assertNoUnexpectedRequests();
  });

  test('a 409 from a decision recorded elsewhere explains and shows the current decision', async ({ page }) => {
    const { api, requirements } = await openTopic(page, 'topic-price');
    const decision = page.getByRole('region', { name: 'Record a decision' });
    await expect(decision).toBeVisible();
    requirements.state.decisions.push({
      chain: [], decidedAt: new Date().toISOString(), decidedBy: { id: 'user-morgan', name: 'Morgan Lee', ref: 'user:user-morgan', type: 'user' },
      id: 'decision-elsewhere', kind: 'topic', outcome: 'agreed', preference: null, sources: [], statement: 'Range on home, exact price on confirm.',
      status: 'active', supersededById: null, supersedesId: null, topic: { id: 'topic-price', prompt: 'x' }, topicId: 'topic-price', track: 'experience', version: 1,
    });
    await decision.getByRole('button', { name: 'Record decision' }).click();
    await expect(page.getByRole('region', { name: 'Decision' }).getByRole('alert')).toContainText('This topic already has a decision.');
    await expect(page.locator('#rq-decision-heading')).toBeFocused();
    await expect(page.getByRole('region', { name: 'Decision' }).getByText('Recorded by Morgan Lee', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Replace this decision' })).toBeVisible();
    api.assertNoUnexpectedRequests();
  });

  test('a member without decision rights sees no decision form or status controls', async ({ page }) => {
    const { api } = await openTopic(page, 'topic-price', (scenario) => {
      scenario.canDecide = false;
      scenario.projectRole = 'member';
    });
    await expect(page.getByRole('region', { name: 'Record a decision' })).toHaveCount(0);
    await expect(page.getByLabel('Decision statement', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Decision' }).getByText('No decision yet.', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Dismiss' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Assign' })).toBeVisible();
    await expect(page.getByLabel('Add to the discussion')).toBeVisible();
    api.assertNoUnexpectedRequests();
  });

  test('a viewer reads the topic with no write controls', async ({ page }) => {
    const { api } = await openTopic(page, 'topic-price', (scenario) => {
      scenario.canDecide = false;
      scenario.projectRole = 'viewer';
    });
    await expect(page.getByRole('region', { name: 'Record a decision' })).toHaveCount(0);
    for (const name of ['Assign', 'Edit', 'Delete', 'Dismiss', 'Post comment']) {
      await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
    }
    await expect(page.getByRole('button', { name: /^Reply to/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Agree with C2/ })).toBeDisabled();
    await expect(page.getByRole('button', { name: /^Ask the group/ })).toHaveCount(0);
    api.assertNoUnexpectedRequests();
  });

  test('a decided topic shows the recorded decision with its owner and sources', async ({ page }) => {
    const { api } = await openTopic(page, 'topic-home');
    const recorded = page.getByRole('region', { name: 'Decision' });
    await expect(recorded.getByText('Booking is the first task on the home screen.')).toBeVisible();
    await expect(recorded.getByText('Recorded by Morgan Lee', { exact: false })).toBeVisible();
    await expect(recorded.getByText('Agreed', { exact: true })).toBeVisible();
    api.assertNoUnexpectedRequests();
  });
});

test.describe('Requirements topic: delete and assign', () => {
  test('deleting a topic with activity shows the 409 explanation and keeps the topic', async ({ page }) => {
    const { api } = await openTopic(page, 'topic-price');
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete this topic?' });
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Delete topic' }).click();
    await expect(dialog.getByRole('alert')).toHaveText(/already has comments, decisions, stakeholders, or files, so it can’t be deleted/);
    await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeFocused();
    await expect(page).toHaveURL(/\/topics\/topic-price$/);
    api.assertNoUnexpectedRequests();
  });

  test('deleting an untouched drafted topic returns to the register', async ({ page }) => {
    const { api } = await openTopic(page, 'topic-accessibility');
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('dialog', { name: 'Delete this topic?' }).getByRole('button', { name: 'Delete topic' }).click();
    await expect(page).toHaveURL(/\/requirements\/experience\/discuss$/);
    await expect(page.getByRole('status').filter({ hasText: 'Topic deleted.' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Experience topics' })).not.toContainText('Which accessibility standard applies');
    api.assertNoUnexpectedRequests();
  });

  test('assigning an owner and a stakeholder saves both', async ({ page }) => {
    const { api, requirements } = await openTopic(page, 'topic-accessibility');
    await page.getByRole('button', { name: 'Assign' }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit topic' });
    await dialog.getByLabel('Owner').selectOption('user:user-synthetic');
    await dialog.getByRole('checkbox', { name: /Noor Haddad/ }).check();
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.rq-topic-head')).toContainText('Synthetic Demo');
    const call = requirements.calls.find((entry) => entry.method === 'PATCH' && entry.path === '/topics/topic-accessibility');
    expect(call.body.assignments).toEqual([
      { actorId: 'user-synthetic', actorType: 'user', label: 'Synthetic Demo', role: 'primary' },
      { actorId: 'stakeholder-noor', actorType: 'stakeholder', label: 'Noor Haddad', role: 'collaborator' },
    ]);
    api.assertNoUnexpectedRequests();
  });
});

test.describe('Requirements topic: one Edit dialog for wording and people', () => {
  test('Details and People save together, and unchanged people are not sent again', async ({ page }) => {
    const { api, requirements } = await openTopic(page, 'topic-accessibility');
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit topic' });
    await expect(dialog.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true');
    await dialog.getByLabel('Question').fill('Which accessibility standard applies to booking?');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog).toBeHidden();
    let call = requirements.calls.filter((entry) => entry.method === 'PATCH' && entry.path === '/topics/topic-accessibility').at(-1);
    expect(call.body.prompt).toBe('Which accessibility standard applies to booking?');
    expect(call.body.assignments).toBeUndefined();

    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await dialog.getByRole('tab', { name: 'Details' }).press('ArrowRight');
    await expect(dialog.getByRole('tab', { name: /People/ })).toBeFocused();
    await dialog.getByLabel('Owner').selectOption('stakeholder:stakeholder-noor');
    await dialog.getByRole('tab', { name: 'Details' }).click();
    await dialog.getByLabel('What it settles').fill('booking flow');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog).toBeHidden();
    call = requirements.calls.filter((entry) => entry.method === 'PATCH' && entry.path === '/topics/topic-accessibility').at(-1);
    expect(call.body.settles).toBe('booking flow');
    expect(call.body.assignments).toEqual([{ actorId: 'stakeholder-noor', actorType: 'stakeholder', label: 'Noor Haddad', role: 'primary' }]);
    await expect(page.getByRole('status').filter({ hasText: 'Topic updated.' })).toBeVisible();
    api.assertNoUnexpectedRequests();
  });

  test('a topic is added with its owner in one step', async ({ page }) => {
    const { api, requirements } = await openTopic(page, 'topic-accessibility');
    await page.goto(page.url().replace(/\/topics\/.*$/, '/experience/discuss'));
    await page.getByRole('button', { name: 'Add topic' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add a topic to Experience' });
    await dialog.getByLabel('Question').fill('Do clients need receipts by email?');
    await dialog.getByRole('tab', { name: /People/ }).click();
    await dialog.getByLabel('Owner').selectOption('user:user-synthetic');
    await dialog.getByRole('button', { name: 'Add topic' }).click();
    await expect(dialog).toBeHidden();
    const call = requirements.calls.find((entry) => entry.method === 'POST' && entry.path === '/tracks/experience/topics');
    expect(call.body.prompt).toBe('Do clients need receipts by email?');
    expect(call.body.assignments).toEqual([{ actorId: 'user-synthetic', actorType: 'user', label: 'Synthetic Demo', role: 'primary' }]);
    api.assertNoUnexpectedRequests();
  });
});

test.describe('Requirements topic on a phone', () => {
  test('sticky jump links move focus to Discussion, Summary, and Decision', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-mobile', 'AC-20 uses the Pixel 7 project.');
    const { api } = await openTopic(page, 'topic-price');
    const jumpbar = page.getByRole('navigation', { name: 'Jump to section' });
    await expect(jumpbar).toBeVisible();

    for (const link of await jumpbar.getByRole('link').all()) {
      const box = await link.boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
    }
    await expect(jumpbar.getByRole('link', { name: /Decision/ })).toContainText('1 blocking item open');

    for (const [name, heading] of [['Summary', '#rq-summary-heading'], [/Decision/, '#rq-decision-heading'], ['Discussion', '#rq-discussion-heading']]) {
      await jumpbar.getByRole('link', { name }).click();
      await expect(page.locator(heading)).toBeFocused();
      await expect(page.locator(heading)).toBeInViewport();
      await expect(jumpbar).toBeInViewport();
      await expect(jumpbar.getByRole('link', { name })).toHaveAttribute('aria-current', 'true');
    }

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(jumpbar).toBeInViewport();
    const top = await jumpbar.evaluate((element) => element.getBoundingClientRect().top);
    expect(top).toBeLessThan(120);
    const width = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    expect(width.scroll).toBeLessThanOrEqual(width.client + 1);
    api.assertNoUnexpectedRequests();
  });

  test('desktop has no jump bar', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop', 'Desktop layout check.');
    const { api } = await openTopic(page, 'topic-price');
    await expect(page.getByRole('navigation', { name: 'Jump to section' })).toBeHidden();
    api.assertNoUnexpectedRequests();
  });
});

test.describe('Requirements decisions as rich text', () => {
  test('a decision written as plain text keeps its line breaks, and Markdown renders', async ({ page }) => {
    const statement = 'Booking is the first task on the home screen.\nVisit history comes second.\n\n**Exception:** returning clients see their next visit first.';
    const { api } = await openTopic(page, 'topic-home', (scenario) => {
      const topic = scenario.topics.find((entry) => entry.id === 'topic-home');
      topic.decision = { ...topic.decision, statement };
      scenario.decisions.find((entry) => entry.id === 'decision-home-2').statement = statement;
    });
    const recorded = page.getByRole('region', { name: 'Decision' }).locator('.rq-decision-statement');
    await expect(recorded.locator('br')).toHaveCount(1);
    await expect(recorded.locator('p')).toHaveCount(2);
    await expect(recorded.locator('strong')).toHaveText('Exception:');
    await expect(recorded).toContainText('Visit history comes second.');
    api.assertNoUnexpectedRequests();
  });
});
