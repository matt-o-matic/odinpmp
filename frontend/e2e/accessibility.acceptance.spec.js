import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { authenticateSyntheticUser, installSyntheticApi } from './fixtures/synthetic-api.js';

const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];

test.describe('objective accessibility evidence', () => {
  test('authenticated reporting supports skip navigation and WCAG 2.2 AA rules', async ({ page }, testInfo) => {
    const api = await installSyntheticApi(page);
    await authenticateSyntheticUser(page);
    await page.goto('reports');
    await expect(page.getByRole('heading', { name: 'Search & reporting' })).toBeVisible();

    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Tab');
    const skipLink = page.getByRole('link', { name: 'Skip to main content' });
    await expect(skipLink).toBeFocused();
    await expect(skipLink).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main-content')).toBeFocused();

    const results = await new AxeBuilder({ page }).include('#main-content').withTags(wcagTags).analyze();
    await testInfo.attach('axe-wcag22-reporting.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
    expect(results.violations).toEqual([]);
    api.assertNoUnexpectedRequests();
  });

  test('authenticated reporting reflows at the 400% zoom equivalent and 200% text size', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await authenticateSyntheticUser(page);
    await page.setViewportSize({ height: 720, width: 320 });
    await page.goto('reports');
    await expect(page.getByRole('heading', { name: 'Search & reporting' })).toBeVisible();
    const viewport = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
    expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth + 1);
    await page.locator('html').evaluate((element) => { element.style.fontSize = '200%'; });
    const enlarged = await page.evaluate(() => {
      const clientWidth = document.documentElement.clientWidth;
      const offenders = [...document.body.querySelectorAll('*')].map((element) => {
        const box = element.getBoundingClientRect();
        return { className: String(element.className ?? '').slice(0, 120), left: Math.round(box.left), right: Math.round(box.right), tag: element.tagName };
      }).filter((element) => element.right > clientWidth + 1 || element.left < -1).slice(0, 12);
      return { clientWidth, offenders, scrollWidth: document.documentElement.scrollWidth };
    });
    expect(enlarged.scrollWidth, JSON.stringify(enlarged.offenders)).toBeLessThanOrEqual(enlarged.clientWidth + 1);
    api.assertNoUnexpectedRequests();
  });

  test('forced-colors mode preserves content, controls, and visible keyboard focus', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'webkit', 'Forced-colors emulation is validated in the repository Chromium profiles.');
    const api = await installSyntheticApi(page);
    await page.emulateMedia({ forcedColors: 'active' });
    await authenticateSyntheticUser(page);
    await page.goto('reports');
    await expect(page.getByRole('heading', { name: 'Search & reporting' })).toBeVisible();
    expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);

    const primaryAction = page.getByRole('button', { name: 'New report' });
    await primaryAction.focus();
    await expect(primaryAction).toBeFocused();
    const focusIndicator = await primaryAction.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        borderStyle: style.borderStyle,
        borderWidth: Number.parseFloat(style.borderWidth),
        outlineStyle: style.outlineStyle,
        outlineWidth: Number.parseFloat(style.outlineWidth),
      };
    });
    expect(
      (focusIndicator.outlineStyle !== 'none' && focusIndicator.outlineWidth >= 2)
        || (focusIndicator.borderStyle !== 'none' && focusIndicator.borderWidth >= 2),
      JSON.stringify(focusIndicator),
    ).toBe(true);

    const results = await new AxeBuilder({ page }).include('#main-content').withTags(wcagTags).analyze();
    await testInfo.attach('axe-forced-colors-reporting.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
    expect(results.violations).toEqual([]);
    api.assertNoUnexpectedRequests();
  });

  test('reduced-motion preference bounds every active animation and transition', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await authenticateSyntheticUser(page);
    await page.goto('reports');
    await expect(page.getByRole('heading', { name: 'Search & reporting' })).toBeVisible();
    const longestMotionMs = await page.locator('body').evaluate((body) => {
      const milliseconds = (value) => value.split(',').map((item) => item.trim()).map((item) => item.endsWith('ms') ? Number.parseFloat(item) : Number.parseFloat(item) * 1000).filter(Number.isFinite);
      return Math.max(0, ...[body, ...body.querySelectorAll('*')].flatMap((element) => {
        const style = getComputedStyle(element);
        return [...milliseconds(style.animationDuration), ...milliseconds(style.transitionDuration)];
      }));
    });
    expect(longestMotionMs).toBeLessThanOrEqual(0.01);
    api.assertNoUnexpectedRequests();
  });

  test('portrait mobile navigation exposes minimum 44 CSS-pixel primary touch targets', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-mobile', 'Touch-target proof uses the repository Pixel 7 profile.');
    const api = await installSyntheticApi(page);
    await authenticateSyntheticUser(page);
    await page.goto('reports');
    const navigationToggle = page.getByRole('button', { name: 'Toggle navigation' });
    const toggleBox = await navigationToggle.boundingBox();
    expect(toggleBox.width).toBeGreaterThanOrEqual(44); expect(toggleBox.height).toBeGreaterThanOrEqual(44);
    await navigationToggle.click();
    await expect(page.locator('#navbarSupportedContent.show:not(.collapsing)')).toBeVisible();
    const themeToggle = page.getByRole('button', { name: /Switch to (dark|light) mode/ });
    const themeBox = await themeToggle.boundingBox();
    expect(themeBox.width).toBeGreaterThanOrEqual(44); expect(themeBox.height).toBeGreaterThanOrEqual(44);
    api.assertNoUnexpectedRequests();
  });
});
