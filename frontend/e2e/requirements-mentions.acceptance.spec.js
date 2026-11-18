import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { defaultRequirementsScenario, installRequirementsApi } from './fixtures/requirements-api.js';
import { createReviewWorld, drawMark, installPortalApi, PORTAL_TOKENS } from './fixtures/requirements-portal-api.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';
import { settleForAxe } from './fixtures/axe-settle.js';

// Rich text comments and tags in Requirements: the comment editor's tools (shown while
// typing), Markdown storage, and the @ list, in the topic composer, the portal question
// composer, and an annotation thread. Synthetic data only.
const base = `projects/${syntheticProject.id}/requirements`;
const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];

test('a team member formats a comment, links it, and tags a stakeholder; it is stored as Markdown', async ({ page }, testInfo) => {
  const api = await installSyntheticApi(page);
  const requirements = await installRequirementsApi(page, defaultRequirementsScenario());
  await authenticateSyntheticUser(page);
  await page.goto(`${base}/topics/topic-reminder`);

  const composer = page.getByRole('textbox', { name: 'Add to the discussion' });
  const tools = page.getByRole('group', { name: 'Text formatting' });
  await expect(composer).toBeVisible();
  await expect(tools).toBeHidden();
  await composer.click();
  await expect(tools).toBeVisible();

  await page.keyboard.type('Can @ja');
  const list = page.getByRole('listbox', { name: 'People to tag' });
  await expect(list.getByRole('option')).toHaveText([/Jamie Ortiz/]);
  await expect(composer).toHaveAttribute('aria-activedescendant', /people-0$/);

  await settleForAxe(page);
  const results = await new AxeBuilder({ page }).include('.rich-editor').include('.mention-dropdown').withTags(wcagTags).analyze();
  await testInfo.attach('axe-comment-editor.json', { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' });
  expect(results.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact)).map((violation) => violation.id)).toEqual([]);

  await page.keyboard.press('Enter');
  await expect(list).toHaveCount(0);
  await expect(composer.locator('.mention')).toHaveText('@Jamie Ortiz');

  await page.keyboard.type('confirm ');
  await tools.getByRole('button', { name: 'Bold' }).click();
  await expect(tools.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.type('reminders');
  await tools.getByRole('button', { name: 'Bold' }).click();
  await page.keyboard.type(' by text? ');

  // Links are added in a field under the tools, not a browser prompt.
  await tools.getByRole('button', { name: 'Link' }).click();
  const linkField = page.getByRole('textbox', { name: 'Link' });
  await expect(linkField).toBeFocused();
  await linkField.fill('odin.test/pricing');
  await page.keyboard.press('Enter');
  await expect(composer.getByRole('link', { name: 'https://odin.test/pricing' })).toBeVisible();
  // Typing after the link is plain text.
  await page.keyboard.type(' ok');
  await expect(composer.getByRole('link')).toHaveText('https://odin.test/pricing');

  await page.keyboard.press('Enter');
  await tools.getByRole('button', { name: 'Bulleted list' }).click();
  await page.keyboard.type('first');

  // Escape on an open @ list closes the list only.
  await page.keyboard.press('Enter');
  await page.keyboard.type('@');
  await expect(list).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(composer).toBeFocused();
  // The @, then the empty bullet.
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');

  await page.getByRole('button', { name: 'Post comment' }).click();
  await expect.poll(() => requirements.calls.find((call) => call.method === 'POST' && call.path === '/topics/topic-reminder/comments')?.body?.body)
    .toBe('Can @[Jamie Ortiz](stakeholder:stakeholder-jamie) confirm **reminders** by text? [https://odin.test/pricing](https://odin.test/pricing) ok\n\n- first');
  const posted = page.locator('.rq-comment').filter({ hasText: 'confirm' });
  await expect(posted.locator('.mention')).toHaveText('@Jamie Ortiz');
  await expect(posted.locator('.rq-comment-md strong')).toHaveText('reminders');
  await expect(posted.getByRole('listitem')).toHaveText('first');
  await expect(posted).not.toContainText('stakeholder:');
  await expect(composer).toHaveText('');
  api.assertNoUnexpectedRequests();
});

test('a comment gets a table: typed as a header row, edited with the table tools, or pasted as Markdown', async ({ page }, testInfo) => {
  const api = await installSyntheticApi(page);
  const requirements = await installRequirementsApi(page, defaultRequirementsScenario());
  await authenticateSyntheticUser(page);
  await page.goto(`${base}/topics/topic-reminder`);
  const posts = () => requirements.calls.filter((call) => call.method === 'POST' && call.path === '/topics/topic-reminder/comments').map((call) => call.body?.body);

  const composer = page.getByRole('textbox', { name: 'Add to the discussion' });
  await composer.click();
  // Enter after a header row makes the table, with the cursor in the row below it.
  await page.keyboard.type('| Option | Owner |');
  await page.keyboard.press('Enter');
  await expect(composer.locator('table th')).toHaveText(['Option', 'Owner']);
  await page.keyboard.type('Picker');
  // In a cell, Enter moves to the next one.
  await page.keyboard.press('Enter');
  await page.keyboard.type('Finance');
  const tableTools = page.getByRole('group', { name: 'Table' });
  await tableTools.getByRole('button', { name: 'Add row' }).click();
  await expect(composer.locator('table tr')).toHaveCount(3);
  // From the last cell of a row, Enter goes to the new row, which is then deleted.
  await page.keyboard.press('Enter');
  await tableTools.getByRole('button', { name: 'Delete row' }).click();
  await expect(composer.locator('table tr')).toHaveCount(2);
  await testInfo.attach('comment-table-editor.png', { body: await page.locator('.rich-editor').first().screenshot(), contentType: 'image/png' });

  await page.getByRole('button', { name: 'Post comment' }).click();
  await expect.poll(() => posts().at(-1)).toBe('| Option | Owner |\n| --- | --- |\n| Picker | Finance |');
  const posted = page.locator('.rq-comment').filter({ hasText: 'Picker' });
  await expect(posted.locator('.rq-comment-md table th')).toHaveText(['Option', 'Owner']);
  await expect(posted.locator('.rq-comment-md table td')).toHaveText(['Picker', 'Finance']);
  await testInfo.attach('comment-table-posted.png', { body: await posted.screenshot(), contentType: 'image/png' });

  // Markdown pasted as plain text, as from a chat or a code editor, arrives formatted.
  await composer.click();
  await composer.evaluate((element, text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, 'Costs:\n\n|Plan|Price|\n|:--|--:|\n|**Basic**|$10|');
  await expect(composer.locator('table td strong')).toHaveText('Basic');
  await expect(tableTools).toBeHidden();
  await page.getByRole('button', { name: 'Post comment' }).click();
  await expect.poll(() => posts().at(-1)).toBe('Costs:\n\n| Plan | Price |\n| --- | --- |\n| **Basic** | $10 |');
  api.assertNoUnexpectedRequests();
});

test('a stakeholder tags someone on the question from the portal; Mod+Enter posts', async ({ page }, testInfo) => {
  const world = createReviewWorld();
  await installSyntheticApi(page);
  await installPortalApi(page, world, { actor: 'jamie', token: PORTAL_TOKENS.jamie });
  await page.goto(`requirements/${PORTAL_TOKENS.jamie}/questions/topic-price-calc`);

  const composer = page.getByRole('textbox', { name: 'Add to the discussion' });
  await composer.click();
  await page.keyboard.type('@ra');
  const list = page.getByRole('listbox', { name: 'People to tag' });
  await expect(list.getByRole('option')).toHaveText([/Ravi Shah/]);
  await page.keyboard.press('Tab');
  await page.keyboard.type('can Finance own it?');
  // Android Chrome replays Enter without modifier keys, so phones post with the button.
  if (testInfo.project.name === 'chromium-mobile') await page.getByRole('button', { name: 'Post comment' }).click();
  else await page.keyboard.press('ControlOrMeta+Enter');

  await expect.poll(() => world.calls.find((call) => call.method === 'POST' && call.path === '/topics/topic-price-calc/comments')?.body?.body)
    .toBe('@[Ravi Shah](person:ravi) can Finance own it?');
  await expect(page.locator('.rq-comment').filter({ hasText: 'can Finance own it?' }).locator('.mention')).toHaveText('@Ravi Shah');
});

test('a reviewer tags someone in an annotation thread, and Enter posts once the list is closed', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'chromium-mobile', 'Drawing a mark uses the desktop canvas toolbar.');
  const world = createReviewWorld();
  world.reviewers.ravi.position = { screenId: 'booking-home', step: 'screens' };
  await installSyntheticApi(page);
  await installPortalApi(page, world, { actor: 'ravi', token: PORTAL_TOKENS.ravi });
  await page.goto(`requirements/${PORTAL_TOKENS.ravi}/rounds/round-2`);
  await expect(page.getByRole('heading', { level: 2, name: 'Booking home' })).toBeVisible();
  await expect.poll(() => page.locator('.annotation-canvas__image').evaluate((image) => image.naturalWidth)).toBe(1280);

  await drawMark(page, 'pin', [0.6, 0.3]);
  const thread = page.getByTestId('rq-annotation-thread');
  const composer = thread.getByRole('textbox', { name: 'Comment on this mark' });
  await expect(composer).toBeFocused();
  await page.keyboard.type('@jam');
  await expect(page.getByRole('listbox', { name: 'People to tag' }).getByRole('option')).toHaveText([/Jamie Ortiz/]);
  await page.keyboard.press('Enter');
  await expect(composer.locator('.mention')).toHaveText('@Jamie Ortiz');
  await page.keyboard.type('is this the price?');
  await page.keyboard.press('Enter');

  await expect.poll(() => world.comments.at(-1)?.body).toBe('@[Jamie Ortiz](person:jamie) is this the price?');
  await expect(thread.locator('.rq-thread-comment .mention')).toHaveText('@Jamie Ortiz');
});
