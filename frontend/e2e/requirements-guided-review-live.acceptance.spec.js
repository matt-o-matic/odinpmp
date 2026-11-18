import { expect, test } from '@playwright/test';

import { PORTAL_TOKENS, closeThread, createReviewWorld, drawMark, installPortalApi } from './fixtures/requirements-portal-api.js';
import { installSyntheticApi } from './fixtures/synthetic-api.js';

// Two reviewers on the same screen, in two browser contexts. A mark one of them
// saves appears for the other within five seconds, through the portal's event stream, with
// no reload. Both contexts share one synthetic world (e2e/fixtures/requirements-portal-api.js).
test('a mark saved by one reviewer appears for another within five seconds', async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const world = createReviewWorld();
  world.reviewers.ravi.position = { screenId: 'booking-home', step: 'screens' };
  world.reviewers.jamie.position = { screenId: 'booking-home', step: 'screens' };
  const options = testInfo.project.use;
  const contexts = await Promise.all([browser.newContext(options), browser.newContext(options)]);
  try {
    const [ravi, jamie] = await Promise.all(contexts.map((context) => context.newPage()));
    await installSyntheticApi(ravi);
    await installPortalApi(ravi, world, { actor: 'ravi', token: PORTAL_TOKENS.ravi });
    await installSyntheticApi(jamie);
    await installPortalApi(jamie, world, { actor: 'jamie', token: PORTAL_TOKENS.jamie });

    await ravi.goto(`requirements/${PORTAL_TOKENS.ravi}/rounds/round-2`);
    await jamie.goto(`requirements/${PORTAL_TOKENS.jamie}/rounds/round-2`);
    for (const page of [ravi, jamie]) {
      await expect(page.getByRole('heading', { level: 2, name: 'Booking home' })).toBeVisible();
      await expect.poll(() => page.locator('.annotation-canvas__image').evaluate((image) => image.naturalWidth)).toBe(1280);
    }
    await expect(jamie.getByRole('button', { name: /Pin · Ravi Shah/ })).toHaveCount(0);
    // Let both streams connect before the mark is made.
    await expect.poll(() => world.channels.size).toBe(2);

    await drawMark(ravi, 'pin', [0.7, 0.2]);
    await closeThread(ravi);
    await expect.poll(() => world.annotations.filter((annotation) => annotation.author === 'ravi' && annotation.roundId === 'round-2').length).toBe(1);
    const savedAt = Date.now();
    const number = world.annotations.find((annotation) => annotation.author === 'ravi' && annotation.roundId === 'round-2').number;

    const pin = jamie.getByRole('button', { name: `${number}. Pin · Ravi Shah` });
    await expect(pin).toBeVisible({ timeout: 5_000 });
    const elapsed = Date.now() - savedAt;
    await testInfo.attach('live-update.json', { body: JSON.stringify({ elapsedMs: elapsed }), contentType: 'application/json' });
    expect(elapsed).toBeLessThan(5_000);

    // The thread follows too: Ravi comments, Jamie reads it without reloading.
    await ravi.getByRole('button', { name: `${number}. Pin · Ravi Shah` }).click();
    await ravi.getByTestId('rq-annotation-thread').getByRole('textbox').fill('Can this sit under the price?');
    await ravi.getByTestId('rq-annotation-thread').getByRole('button', { name: 'Post comment' }).click();
    await pin.click();
    await expect(jamie.getByTestId('rq-annotation-thread')).toContainText('Can this sit under the price?', { timeout: 5_000 });
    // Jamie can reply but cannot move or edit Ravi's mark.
    await expect(jamie.getByTestId('rq-annotation-thread').getByRole('combobox', { name: 'Category' })).toHaveCount(0);
    await expect(jamie.getByTestId('rq-annotation-thread').getByRole('button', { name: 'Reply to Ravi Shah' })).toBeVisible();
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
