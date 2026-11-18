import { expect, test } from '@playwright/test';

import { authenticateSyntheticUser, installSyntheticApi } from './fixtures/synthetic-api.js';

test('enterprise connector administration visual baseline @visual', async ({ page }) => {
  const api = await installSyntheticApi(page, { admin: true });
  await authenticateSyntheticUser(page);
  await page.goto('admin/integrations');
  await page.getByRole('navigation', { name: 'Integration control sections' }).getByRole('button', { name: 'connectors', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Enterprise connectors' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('.integration-page')).toHaveScreenshot('enterprise-connectors.png', {
    animations: 'disabled',
    caret: 'hide',
    maxDiffPixelRatio: 0.002,
  });
  api.assertNoUnexpectedRequests();
});
