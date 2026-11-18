import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { PORTAL_TOKENS, createReviewWorld, dragScene, installPortalApi, tapScene } from './fixtures/requirements-portal-api.js';
import { installSyntheticApi } from './fixtures/synthetic-api.js';
import { settleForAxe } from './fixtures/axe-settle.js';

// The guided review on a phone (sh-mobile.png): a reduced tool set with no style or zoom
// controls, threads below the screen instead of a popover, the verdict in a bottom sheet,
// 44 px targets, and no sideways scrolling. Runs on the Pixel 7 project.
const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];

test.skip(({ isMobile }) => !isMobile, 'Phone layout only.');

async function expectTargets(locator, label) {
  const boxes = await locator.evaluateAll((elements) => elements.filter((element) => element.offsetParent !== null).map((element) => {
    const rect = element.getBoundingClientRect();
    return { height: Math.round(rect.height), name: element.getAttribute('aria-label') || element.textContent.trim(), width: Math.round(rect.width) };
  }));
  expect(boxes.length, label).toBeGreaterThan(0);
  for (const box of boxes) expect(Math.min(box.height, box.width), `${label}: ${box.name}`).toBeGreaterThanOrEqual(44);
}

test('a stakeholder reviews a screen on a phone', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const world = createReviewWorld();
  world.reviewers.ravi.position = { screenId: 'booking-home', step: 'screens' };
  const api = await installSyntheticApi(page);
  await installPortalApi(page, world);
  await page.goto(`requirements/${PORTAL_TOKENS.ravi}/rounds/round-2`);
  await expect(page.getByRole('heading', { level: 2, name: 'Booking home' })).toBeVisible();
  await expect(page.getByText('Screen 1 of 3')).toBeVisible();
  await expect.poll(() => page.locator('.annotation-canvas__image').evaluate((image) => image.naturalWidth)).toBe(1280);

  // The phone tool set.
  const tools = page.getByRole('toolbar', { name: 'Annotation tools' });
  for (const name of ['Select', 'Pin a comment', 'Box', 'Arrow', 'Pen']) await expect(tools.getByRole('button', { name, exact: true })).toBeVisible();
  for (const name of ['Highlight', 'Text label', 'Your layer color', 'Thin stroke', 'Delete selected mark']) await expect(tools.getByRole('button', { name, exact: true })).toHaveCount(0);
  const toolbarRows = await tools.evaluate((element) => new Set([...element.querySelectorAll('button')].map((button) => Math.round(button.getBoundingClientRect().top))).size);
  expect(toolbarRows, 'the phone toolbar fits on one row').toBe(1);
  await expect(page.getByRole('button', { name: 'Zoom in' })).toHaveCount(0);
  await expectTargets(tools.getByRole('button'), 'toolbar');

  // A pin opens its thread below the screen.
  await tools.getByRole('button', { name: 'Pin a comment' }).click();
  await tapScene(page, 0.75, 0.55);
  const thread = page.getByTestId('rq-annotation-thread');
  await expect(thread).toHaveClass(/rq-thread-card--panel/);
  await expect(page.locator('.annotation-canvas__popover')).toHaveCount(0);
  await thread.getByRole('textbox').fill('“$70–95” needs to say “before tax”.');
  await thread.getByRole('button', { name: 'Post comment' }).click();
  await expect.poll(() => world.comments.find((comment) => comment.author === 'ravi' && comment.id !== 'ac-2')?.body).toBe('“$70–95” needs to say “before tax”.');

  // With no Delete in the phone toolbar, the reviewer's own mark is removed from its thread.
  await tools.getByRole('button', { name: 'Box' }).click();
  await dragScene(page, [0.1, 0.1], [0.3, 0.3]);
  await expect.poll(() => world.annotations.filter((annotation) => annotation.author === 'ravi' && annotation.roundId === 'round-2' && !annotation.deletedAt).length).toBe(2);
  await page.getByTestId('rq-annotation-thread').getByRole('button', { name: 'Delete mark' }).click();
  await expect.poll(() => world.annotations.filter((annotation) => annotation.author === 'ravi' && annotation.roundId === 'round-2' && !annotation.deletedAt).length).toBe(1);

  // The verdict in the bottom sheet, with aspects and notes behind a toggle.
  const sheet = page.getByRole('region', { name: 'Your verdict on Booking home' });
  await sheet.getByRole('radio', { name: 'Keep, with changes' }).check();
  await expect.poll(() => world.verdicts.ravi['booking-home']?.overall).toBe('keep-with-changes');
  const toggle = sheet.getByRole('button', { name: /Aspects & notes/ });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await sheet.getByRole('radiogroup', { name: /^Hierarchy & navigation/ }).getByRole('radio', { name: 'Change' }).check();
  await expect.poll(() => world.verdicts.ravi['booking-home']?.dimensions?.hierarchy).toBe('change');
  await toggle.click();
  await expectTargets(sheet.locator('.rq-seg--verdict .rq-seg__option span'), 'verdict choices');
  await expectTargets(sheet.locator('.rq-sheet__nav button'), 'sheet navigation');
  await expectTargets(page.getByRole('navigation', { name: 'Review steps' }).getByRole('button'), 'steps');

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no sideways scrolling').toBeLessThanOrEqual(1);
  await settleForAxe(page);
  const results = await new AxeBuilder({ page }).include('.rq-portal').withTags(wcagTags).analyze();
  await testInfo.attach('axe-phone-screen.json', { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' });
  expect(results.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact)).map((violation) => violation.id)).toEqual([]);

  await sheet.getByRole('button', { name: /Next screen/ }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Booking home, schedule first' })).toBeFocused();
  await expect(page.getByText('Screen 2 of 3')).toBeVisible();
  api.assertNoUnexpectedRequests();
});

test('the other steps fit a phone with no sideways scrolling', async ({ page }, testInfo) => {
  const world = createReviewWorld();
  const api = await installSyntheticApi(page);
  await installPortalApi(page, world);
  await page.goto(`requirements/${PORTAL_TOKENS.ravi}/rounds/round-2`);
  const steps = page.getByRole('navigation', { name: 'Review steps' });
  for (const [step, heading] of [['Overview', 'Client booking — price and booking flow'], ['Directions', 'Compare the directions'], ['Questions', 'Questions from the team'], ['Submit', 'Here’s what you’re telling the team']]) {
    await steps.getByRole('button', { name: new RegExp(step) }).click();
    await expect(page.getByRole('heading', { level: 2, name: heading })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${step}: no sideways scrolling`).toBeLessThanOrEqual(1);
    await settleForAxe(page);
    const results = await new AxeBuilder({ page }).include('.rq-portal').withTags(wcagTags).analyze();
    await testInfo.attach(`axe-phone-${step.toLowerCase()}.json`, { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' });
    expect(results.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact)).map((violation) => violation.id), step).toEqual([]);
  }
  api.assertNoUnexpectedRequests();
});
