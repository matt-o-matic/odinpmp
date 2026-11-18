import { expect, test } from '@playwright/test';

import { PORTAL_TOKENS, createReviewWorld, installPortalApi } from './fixtures/requirements-portal-api.js';
import { installSyntheticApi } from './fixtures/synthetic-api.js';

// Marks from an earlier version on a screen that changed are Outdated. Their author
// carries each one forward into this version, or closes it.
test('an outdated mark can be carried forward or closed, and shows its status', async ({ isMobile, page }) => {
  const world = createReviewWorld();
  const second = structuredClone(world.annotations.find((annotation) => annotation.status === 'outdated'));
  second.id = '0b6f2f5e-1d3c-4a58-9b6a-6c1d8b2f7a03';
  second.number = 3;
  world.annotations.push(second);
  world.comments.push({ annotationId: second.id, author: 'ravi', body: 'Move the price nearer the button.', createdAt: new Date().toISOString(), deletedAt: null, editedAt: null, id: 'ac-9', parentCommentId: null });
  world.reviewers.ravi.position = { screenId: 'booking-home', step: 'screens' };
  const api = await installSyntheticApi(page);
  await installPortalApi(page, world);
  await page.goto(`requirements/${PORTAL_TOKENS.ravi}/rounds/round-2`);
  await expect(page.getByRole('heading', { level: 2, name: 'Booking home' })).toBeVisible();

  // Outdated marks are drawn faded and listed under earlier versions.
  await expect(page.locator('.annotation-canvas__mark--faded')).toHaveCount(2);
  // Wide screens have a Marks tab; phones a Marks section under the screen.
  if (isMobile) await page.locator('summary', { hasText: /^Marks · / }).click();
  else await page.getByRole('tab', { name: /Marks/ }).click();
  const earlier = page.getByTestId('rq-outdated-marks');
  await expect(earlier.getByRole('heading')).toHaveText('From earlier versions · 2');
  await expect(earlier).toContainText('Round 1 · Outdated');
  await expect(earlier).toContainText('“The price card was missing on version 2.”');

  await earlier.getByRole('button', { name: 'Carry mark 2 forward' }).click();
  await expect.poll(() => world.annotations.find((annotation) => annotation.id === '0b6f2f5e-1d3c-4a58-9b6a-6c1d8b2f7a02')).toMatchObject({ roundId: 'round-2', status: 'carried' });
  await expect(earlier.getByRole('heading')).toHaveText('From earlier versions · 1');
  const carried = world.annotations.find((annotation) => annotation.id === '0b6f2f5e-1d3c-4a58-9b6a-6c1d8b2f7a02');
  await expect(page.getByRole('option', { name: `${carried.number}. Box · Ravi Shah · Carried forward` })).toBeVisible();

  // Closing from the mark's own thread.
  await earlier.getByRole('button', { name: /Move the price nearer the button/ }).click();
  const thread = page.getByTestId('rq-annotation-thread');
  await expect(thread).toContainText('From round 1. The screen changed since');
  await thread.getByRole('button', { name: 'Close', exact: true }).click();
  await expect.poll(() => world.annotations.find((annotation) => annotation.id === second.id).status).toBe('resolved');
  await expect(page.getByTestId('rq-outdated-marks')).toHaveCount(0);
  api.assertNoUnexpectedRequests();
});
