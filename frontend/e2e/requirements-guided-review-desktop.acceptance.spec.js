import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { PORTAL_TOKENS, closeThread, createReviewWorld, drawMark, installPortalApi } from './fixtures/requirements-portal-api.js';
import { installSyntheticApi } from './fixtures/synthetic-api.js';
import { settleForAxe } from './fixtures/axe-settle.js';

// The guided review as an external stakeholder: directions, each
// annotation tool saved with server numbers, a thread reply, a verdict with aspects, a save
// failure kept locally with Retry, questions of every kind, resume after reload, the submit
// summary with "Not reviewed" screens, commenting after submit, and a closed round.
// Synthetic API: e2e/fixtures/requirements-portal-api.js; screens from the stand-in origin.
const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];
const REVIEW = `requirements/${PORTAL_TOKENS.ravi}/rounds/round-2`;

async function expectNoSeriousIssues(page, testInfo, name) {
  await settleForAxe(page);
  const results = await new AxeBuilder({ page }).include('.rq-portal').withTags(wcagTags).analyze();
  await testInfo.attach(`axe-${name}.json`, { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' });
  const serious = results.violations
    .filter((violation) => ['serious', 'critical'].includes(violation.impact))
    .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`);
  expect(serious, name).toEqual([]);
}

async function open(page, world = createReviewWorld()) {
  const api = await installSyntheticApi(page);
  await installPortalApi(page, world);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { api, errors, world };
}

const mine = (world) => world.annotations.filter((annotation) => annotation.author === 'ravi' && annotation.roundId === 'round-2' && !annotation.deletedAt);

test.describe('Guided review on a desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'The phone layout has its own spec.');

  test('a stakeholder completes the review: directions, every mark, a reply, verdicts, answers, resume, and submit', async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ height: 900, width: 1440 });
    const { api, errors, world } = await open(page);

    await page.goto(`requirements/${PORTAL_TOKENS.ravi}`);
    await page.getByRole('link', { name: /Start review/ }).click();
    await expect(page).toHaveURL(new RegExp(`${REVIEW}$`));
    await expect(page.getByRole('heading', { level: 2, name: 'Client booking — price and booking flow' })).toBeVisible();
    await expect(page.locator('.app-frame > .navbar')).toHaveCount(0);
    const steps = page.getByRole('navigation', { name: 'Review steps' });
    await expect(steps.getByRole('button')).toHaveText(['1Overview', '2Directions', '3Screens', '4Questions', '5Submit']);
    await expect(steps.getByRole('button', { name: /Overview/ })).toHaveAttribute('aria-current', 'step');
    await expectNoSeriousIssues(page, testInfo, 'review-overview');

    // Directions: a stance saves at once; a remix note waits for its stance, then saves with it.
    await page.getByRole('button', { name: /Start review/ }).click();
    await expect(page.getByRole('heading', { name: 'Compare the directions' })).toBeFocused();
    await page.getByRole('group', { name: 'Your view of Action first' }).getByRole('radio', { name: 'Preferred' }).check();
    await expect.poll(() => world.stances.ravi['action-first']?.stance).toBe('preferred');
    const remix = page.getByLabel(/Anything to keep from this direction/).nth(1);
    await remix.fill('The week calendar');
    await remix.blur();
    await expect(page.getByText('Choose preferred, acceptable, or rejected to save this note.')).toBeVisible();
    await page.getByRole('group', { name: 'Your view of Schedule first' }).getByRole('radio', { name: 'Acceptable' }).check();
    await expect.poll(() => world.stances.ravi['schedule-first']).toMatchObject({ remix: 'The week calendar', stance: 'acceptable' });
    await expect(page.getByTestId('rq-save-status')).toContainText(/Saved \d/);
    await expectNoSeriousIssues(page, testInfo, 'review-directions');

    // Screens: one mark of each tool, each saved with the server's number.
    await page.getByRole('button', { name: 'Screens', exact: true }).last().click();
    await expect(page.getByRole('heading', { level: 2, name: 'Booking home' })).toBeFocused();
    await expect(steps.getByRole('button', { name: /Screens · 1 of 3/ })).toBeVisible();
    await expect.poll(() => page.locator('.annotation-canvas__image').evaluate((image) => image.naturalWidth)).toBe(1280);
    const marks = [
      ['pin', [0.08, 0.12]],
      ['box', [0.05, 0.86], [0.2, 0.95]],
      ['arrow', [0.3, 0.92], [0.4, 0.86]],
      ['pen', [0.45, 0.86], [0.55, 0.95]],
      ['highlight', [0.6, 0.86], [0.75, 0.92]],
      ['text', [0.8, 0.86]],
    ];
    for (const [tool, from, to] of marks) {
      await drawMark(page, tool, from, to);
      await expect(page.getByTestId('rq-annotation-thread')).toBeVisible();
      await closeThread(page);
    }
    await expect.poll(() => mine(world).map((annotation) => annotation.shapes[0].type).sort()).toEqual(['arrow', 'box', 'highlight', 'pen', 'pin', 'text']);
    await expect.poll(() => mine(world).map((annotation) => annotation.number).sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7]);
    const pin = mine(world).find((annotation) => annotation.shapes[0].type === 'pin');
    await expect(page.getByRole('button', { name: `${pin.number}. Pin · Ravi Shah` })).toBeVisible();
    expect(mine(world).find((annotation) => annotation.shapes[0].type === 'text').shapes[0].text).toBe('before tax?');

    // Keyboard edits: nudges coalesce into one save; Delete, then Undo restores the mark.
    const box = mine(world).find((annotation) => annotation.shapes[0].type === 'box');
    const boxX = box.shapes[0].x;
    await page.getByRole('tab', { name: /Marks/ }).click();
    await page.getByRole('option', { name: `${box.number}. Box · Ravi Shah` }).click();
    const workspace = page.getByRole('group', { name: 'Booking home, screen to annotate' });
    await workspace.focus();
    const putsBefore = world.callsTo('PUT', new RegExp(`/annotations/${box.id}$`)).length;
    for (let step = 0; step < 4; step += 1) await page.keyboard.press('ArrowRight');
    await expect.poll(() => box.shapes[0].x).toBe(boxX + 20);
    expect(world.callsTo('PUT', new RegExp(`/annotations/${box.id}$`)).length - putsBefore).toBe(1);
    await page.keyboard.press('Delete');
    await expect.poll(() => Boolean(box.deletedAt)).toBe(true);
    await page.keyboard.press('Control+z');
    await expect.poll(() => box.deletedAt).toBeNull();
    expect(world.callsTo('PUT', new RegExp(`/annotations/${box.id}$`)).at(-1).body.restored).toBe(true);

    // A reply on another reviewer's mark.
    await page.getByRole('button', { name: '1. Pin · Jamie Ortiz' }).click();
    const thread = page.getByTestId('rq-annotation-thread');
    await expect(thread).toContainText('The Book a visit button should be bigger.');
    await thread.getByRole('button', { name: 'Reply to Jamie Ortiz' }).click();
    await thread.getByRole('textbox', { name: 'Reply' }).fill('Agreed, and it should stay first.');
    await thread.getByRole('button', { name: 'Send reply' }).click();
    await expect(thread.getByText('Agreed, and it should stay first.')).toBeVisible();
    expect(world.comments.find((comment) => comment.author === 'ravi' && comment.parentCommentId === 'ac-1')?.body).toBe('Agreed, and it should stay first.');
    await expectNoSeriousIssues(page, testInfo, 'review-screen-thread');
    await closeThread(page);

    // The verdict, with aspects (each Not reviewed until rated) and notes.
    await page.getByRole('tab', { name: 'Your feedback' }).click();
    const aspects = page.getByRole('group', { name: /By aspect/ });
    await expect(aspects.locator('.rq-dim__state')).toHaveCount(6);
    await page.getByRole('group', { name: 'Overall, this screen' }).getByRole('radio', { name: 'Keep with changes' }).check();
    await page.getByRole('radiogroup', { name: /^Type & size/ }).getByRole('radio', { name: 'Keep' }).check();
    await page.getByRole('radiogroup', { name: /^Hierarchy & navigation/ }).getByRole('radio', { name: 'Change' }).check();
    await page.getByLabel('What should change?').fill('Price range needs “before tax”.');
    await page.getByLabel('What should change?').blur();
    await expect.poll(() => world.verdicts.ravi['booking-home']).toMatchObject({ change: 'Price range needs “before tax”.', dimensions: { hierarchy: 'change', type: 'keep' }, overall: 'keep-with-changes' });
    await expect(aspects.locator('.rq-dim__state')).toHaveCount(4);
    await expectNoSeriousIssues(page, testInfo, 'review-screen-verdict');

    // A save that fails keeps the choice on screen and offers Retry.
    world.failNext('PUT', /\/screens\/booking-home\/verdict$/);
    await page.getByRole('group', { name: 'Overall, this screen' }).getByRole('radio', { name: 'Change', exact: true }).check();
    await expect(page.getByTestId('rq-save-status')).toContainText('Couldn’t save');
    await expect(page.getByRole('group', { name: 'Overall, this screen' }).getByRole('radio', { name: 'Change', exact: true })).toBeChecked();
    expect(world.verdicts.ravi['booking-home'].overall).toBe('keep-with-changes');
    await page.getByTestId('rq-save-status').getByRole('button', { name: 'Retry' }).click();
    await expect.poll(() => world.verdicts.ravi['booking-home'].overall).toBe('change');
    await expect(page.getByTestId('rq-save-status')).toContainText(/Saved \d/);

    // A mark that fails to save stays on screen until Retry stores it.
    world.failNext('PUT', /\/annotations\/[^/]+$/);
    await drawMark(page, 'pin', [0.92, 0.12]);
    await closeThread(page);
    await expect(page.getByTestId('rq-save-status')).toContainText('Couldn’t save');
    const countBefore = mine(world).length;
    await expect(page.locator('.annotation-canvas__pin')).toHaveCount(3);
    await page.getByTestId('rq-save-status').getByRole('button', { name: 'Retry' }).click();
    await expect.poll(() => mine(world).length).toBe(countBefore + 1);

    // Questions of each kind. The earlier version's answer shows but does not count.
    await steps.getByRole('button', { name: /Questions/ }).click();
    await expect(page.getByRole('heading', { name: 'Questions from the team' })).toBeFocused();
    await expect(page.getByText('0 of 5 answered')).toBeVisible();
    await expect(page.getByText('You answered “Yes” on version 2. It doesn’t count for this version until you answer again.')).toBeVisible();
    await page.getByRole('group', { name: /Where should the price first appear/ }).getByRole('radio', { name: 'A range on the home screen, exact before payment' }).check();
    await page.getByRole('group', { name: /Which reminder channels/ }).getByRole('checkbox', { name: 'Email' }).check();
    await page.getByRole('group', { name: /Which reminder channels/ }).getByRole('checkbox', { name: 'Text message' }).check();
    const notice = page.getByRole('textbox', { name: 'How much notice do clients need to reschedule for free?' });
    await notice.fill('24 hours');
    await notice.blur();
    await page.getByRole('group', { name: /How quick did booking feel/ }).getByRole('radio', { name: '4', exact: true }).check();
    await expect.poll(() => Object.fromEntries(Object.entries(world.answers.ravi).map(([key, answer]) => [key, answer.value]))).toEqual({
      'booking-speed': 4,
      'free-reschedule-notice': '24 hours',
      'price-placement': 'range-on-home',
      'reminder-channels': ['sms', 'email'],
    });
    await expect(page.getByText('4 of 5 answered')).toBeVisible();
    await expectNoSeriousIssues(page, testInfo, 'review-questions');

    // Reloading resumes where the reviewer was, with everything given so far.
    await expect.poll(() => world.reviewers.ravi.position?.step).toBe('questions');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Questions from the team' })).toBeVisible();
    await expect(page.getByRole('radio', { name: 'A range on the home screen, exact before payment' })).toBeChecked();
    await expect(page.getByRole('textbox', { name: 'How much notice do clients need to reschedule for free?' })).toHaveValue('24 hours');

    // Submit: what the team will see, with untouched screens Not reviewed.
    await page.getByRole('button', { name: 'Review and submit' }).click();
    await expect(page.getByRole('heading', { name: 'Here’s what you’re telling the team' })).toBeFocused();
    await expect(page.getByText('Direction: You prefer A · Action first; B · Schedule first is acceptable.')).toBeVisible();
    await expect(page.getByText('From B · Schedule first, keep: “The week calendar”')).toBeVisible();
    const rows = page.locator('.rq-submit__screen');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('Booking home');
    await expect(rows.nth(0)).toContainText('Change');
    await expect(rows.nth(0)).toContainText('7 marks · hierarchy & navigation: change');
    await expect(rows.nth(1)).toContainText('Booking home, schedule first');
    await expect(rows.nth(1)).toContainText('Not reviewed');
    await expect(rows.nth(1).getByRole('button', { name: 'Review now Booking home, schedule first' })).toBeVisible();
    await expect(rows.nth(2)).toContainText('Not reviewed');
    await expect(page.getByText('Questions · 4 of 5 answered')).toBeVisible();
    await expect(page.getByText('Should the price range say "before tax"? · not answered')).toBeVisible();
    await expectNoSeriousIssues(page, testInfo, 'review-submit');
    await page.getByRole('button', { name: 'Submit review' }).click();
    await expect(page.getByTestId('rq-submitted')).toBeFocused();
    await expect(page.getByTestId('rq-submitted')).toContainText('You can keep commenting');
    await expect.poll(() => world.reviewers.ravi.submittedAt).not.toBeNull();
    await expectNoSeriousIssues(page, testInfo, 'review-submitted');

    // After submitting, the reviewer can still comment until the round closes.
    await rows.nth(0).getByRole('button', { name: /Edit Booking home/ }).click();
    await page.getByRole('button', { name: `${pin.number}. Pin · Ravi Shah` }).click();
    await page.getByTestId('rq-annotation-thread').getByRole('textbox').fill('Still true after submitting.');
    await page.getByTestId('rq-annotation-thread').getByRole('button', { name: 'Post comment' }).click();
    await expect.poll(() => world.comments.find((comment) => comment.annotationId === pin.id)?.body).toBe('Still true after submitting.');
    expect(errors).toEqual([]);
    api.assertNoUnexpectedRequests();
  });

  test('a mark’s thread always opens inside the canvas, clear of its bars', async ({ page }, testInfo) => {
    await page.setViewportSize({ height: 900, width: 1440 });
    const { api, errors } = await open(page);
    await page.goto(REVIEW);
    await page.getByRole('navigation', { name: 'Review steps' }).getByRole('button', { name: /Screens/ }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Booking home' })).toBeVisible();

    const canvas = page.locator('.annotation-canvas');
    const popover = page.locator('.annotation-canvas__popover');
    const bars = page.locator('.annotation-canvas__bar');
    // A full-height box on each side, a short box at the very top, and one at the very bottom.
    const marks = [
      [[0.03, 0.04], [0.2, 0.97]],
      [[0.8, 0.04], [0.97, 0.97]],
      [[0.4, 0.02], [0.6, 0.08]],
      [[0.4, 0.92], [0.6, 0.98]],
    ];
    for (const [from, to] of marks) {
      await drawMark(page, 'box', from, to);
      await expect(page.getByTestId('rq-annotation-thread').getByRole('textbox')).toBeFocused();
      const area = await canvas.boundingBox();
      const card = await popover.boundingBox();
      expect(card.width).toBeGreaterThanOrEqual(400);
      await testInfo.attach(`thread-${from.join('-')}.png`, { body: await popover.screenshot(), contentType: 'image/png' });
      expect(card.y,`top of the thread for ${from}`).toBeGreaterThanOrEqual(area.y);
      expect(card.y + card.height, `bottom of the thread for ${from}`).toBeLessThanOrEqual(area.y + area.height);
      expect(card.x).toBeGreaterThanOrEqual(area.x);
      expect(card.x + card.width).toBeLessThanOrEqual(area.x + area.width);
      for (const bar of await bars.all()) {
        const strip = await bar.boundingBox();
        const overlaps = card.y < strip.y + strip.height && strip.y < card.y + card.height;
        expect(overlaps, `the thread for ${from} overlaps a canvas bar`).toBe(false);
      }
      await page.getByTestId('rq-annotation-thread').getByRole('button', { name: 'Cancel' }).click();
      await expect(popover).toHaveCount(0);
    }
    expect(errors).toEqual([]);
    api.assertNoUnexpectedRequests();
  });

  test('a closed round is read-only', async ({ page }, testInfo) => {
    const { api, world } = await open(page, createReviewWorld({ roundStatus: 'closed' }));
    await page.goto(REVIEW);
    await expect(page.getByRole('note')).toContainText(/This round closed on \w{3} \d+\. Its feedback is read-only\./);
    await page.getByRole('navigation', { name: 'Review steps' }).getByRole('button', { name: /Directions/ }).click();
    await expect(page.getByRole('radio', { name: 'Preferred' }).first()).toBeDisabled();
    await page.getByRole('navigation', { name: 'Review steps' }).getByRole('button', { name: /Screens/ }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Booking home' })).toBeVisible();
    await expect(page.getByRole('toolbar', { name: 'Annotation tools' })).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Overall, this screen' }).getByRole('radio', { name: 'Keep', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '1. Pin · Jamie Ortiz' }).click();
    await expect(page.getByTestId('rq-annotation-thread').getByRole('textbox')).toHaveCount(0);
    await expectNoSeriousIssues(page, testInfo, 'review-closed');
    await page.getByRole('navigation', { name: 'Review steps' }).getByRole('button', { name: /Submit/ }).click();
    await expect(page.getByRole('button', { name: 'Submit review' })).toHaveCount(0);
    await expect(page.getByText('This round is closed, so it can’t be submitted.')).toBeVisible();
    expect(world.calls.filter((call) => call.method !== 'GET')).toEqual([]);
    api.assertNoUnexpectedRequests();
  });

  test('the review works from the keyboard alone, and focus follows each step', async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ height: 900, width: 1440 });
    const { api, world } = await open(page);
    await page.goto(REVIEW);
    await expect(page.getByRole('heading', { level: 2, name: 'Client booking — price and booking flow' })).toBeVisible();

    const steps = page.getByRole('navigation', { name: 'Review steps' });
    await steps.getByRole('button', { name: /Directions/ }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Compare the directions' })).toBeFocused();
    await page.getByRole('group', { name: 'Your view of Action first' }).getByRole('radio', { name: 'Preferred' }).focus();
    await page.keyboard.press('Space');
    await expect.poll(() => world.stances.ravi['action-first']?.stance).toBe('preferred');
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => world.stances.ravi['action-first']?.stance).toBe('acceptable');

    await steps.getByRole('button', { name: /Screens/ }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 2, name: 'Booking home' })).toBeFocused();

    // Place a pin from the keyboard: C picks the pin tool, Enter places it in the middle.
    const workspace = page.getByRole('group', { name: 'Booking home, screen to annotate' });
    await workspace.focus();
    await page.keyboard.press('c');
    await page.keyboard.press('Enter');
    const composer = page.getByTestId('rq-annotation-thread').getByRole('textbox', { name: 'Comment on this mark' });
    await expect(composer).toBeFocused();
    await page.keyboard.type('Placed from the keyboard.');
    await page.keyboard.press('Enter');
    await expect.poll(() => world.comments.find((comment) => comment.author === 'ravi' && comment.id !== 'ac-2')?.body).toBe('Placed from the keyboard.');
    await page.keyboard.press('Escape');
    await expect(workspace).toBeFocused();

    // The marks list is a keyboard listbox.
    await page.getByRole('tab', { name: 'Your feedback' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: /Marks/ })).toBeFocused();
    await expect(page.getByRole('tab', { name: /Marks/ })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('listbox', { name: 'Marks on this screen' }).getByRole('option').first().focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('listbox', { name: 'Marks on this screen' }).getByRole('option').nth(1)).toBeFocused();

    // The verdict from the keyboard.
    await page.getByRole('tab', { name: 'Your feedback' }).click();
    await page.getByRole('group', { name: 'Overall, this screen' }).getByRole('radio', { name: 'Keep', exact: true }).focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => world.verdicts.ravi['booking-home']?.overall).toBe('keep-with-changes');

    await steps.getByRole('button', { name: /Questions/ }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Questions from the team' })).toBeFocused();
    await page.getByRole('radio', { name: 'Not sure' }).focus();
    await page.keyboard.press('Space');
    await expect.poll(() => world.answers.ravi['price-placement']?.value).toBe('unsure');

    await steps.getByRole('button', { name: /Submit/ }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Here’s what you’re telling the team' })).toBeFocused();
    await page.getByRole('button', { name: 'Submit review' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('rq-submitted')).toBeFocused();
    await expectNoSeriousIssues(page, testInfo, 'review-keyboard-submitted');
    api.assertNoUnexpectedRequests();
  });
});
