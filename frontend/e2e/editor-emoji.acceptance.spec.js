import { expect, test } from '@playwright/test';

import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

// The Emoji button in the full toolbar (work item comments): pressing it moves focus off the
// text, so the emoji goes where the cursor was, not at the end. The comment box's version is in
// channel-reactions.acceptance.spec.js.

test('the Emoji button on a work item comment puts the emoji where the cursor was', async ({ page }) => {
  const api = await installSyntheticApi(page);
  await authenticateSyntheticUser(page);
  await page.goto(`projects/${syntheticProject.id}?item=story-synthetic`);
  const discussion = page.locator('.workbench-card').filter({ has: page.getByRole('heading', { name: 'Discussion' }) });
  const box = discussion.locator('.ProseMirror');
  await box.click();
  await page.keyboard.type('Great work team');
  await page.keyboard.press('Home');

  await discussion.getByRole('button', { name: 'Emoji' }).click();
  const picker = page.getByRole('dialog', { name: 'Insert an emoji' });
  await picker.getByRole('group', { name: 'Frequently used' }).getByRole('button').first().click();
  await expect(picker).toHaveCount(0);
  await expect(box).toBeFocused();
  await expect(box).toHaveText('👍Great work team');
  api.assertNoUnexpectedRequests();
});
