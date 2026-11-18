import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { settleForAxe } from './fixtures/axe-settle.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

// The outline pane's dark-mode rules once compiled to bare `html.dark { ... }`, restyling the
// whole page. These are the values those rules set.
const LEAKED_ROOT_STYLES = {
  backgroundColor: ['rgba(8, 17, 29, 0.96)', 'rgba(59, 130, 246, 0.18)', 'rgba(15, 23, 42, 0.86)'],
  borderBottomColor: ['rgba(148, 163, 184, 0.16)'],
  color: ['rgb(217, 231, 255)'],
};

test('the project outline keeps its dark-mode styles to itself', async ({ page }, testInfo) => {
  const api = await installSyntheticApi(page);
  await authenticateSyntheticUser(page);
  await page.goto(`projects/${syntheticProject.id}`);
  await expect(page.locator('button.outline-row--project')).toBeAttached();
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  const navigator = page.getByRole('button', { name: 'Open structure navigator' });
  if (await navigator.isVisible()) await navigator.click();
  await expect(page.locator('button.outline-row--project')).toBeVisible();

  const root = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return { backgroundColor: style.backgroundColor, borderBottomColor: style.borderBottomColor, color: style.color };
  });
  for (const [property, leaked] of Object.entries(LEAKED_ROOT_STYLES)) expect(leaked, property).not.toContain(root[property]);

  await page.screenshot({ path: testInfo.outputPath('project-outline-dark.png') });
  await settleForAxe(page);
  const results = await new AxeBuilder({ page }).include('.outline-card').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  await testInfo.attach('axe-project-outline-dark.json', { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' });
  expect(results.violations.filter(({ impact }) => ['critical', 'serious'].includes(impact))).toEqual([]);
  api.assertNoUnexpectedRequests();
});
