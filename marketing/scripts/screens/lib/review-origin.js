// Harbor & Pine screens for Odin's review screens. The shared fixtures serve the Fieldwork
// example package from a stand-in review origin; this renders the prototype/*.html pages to
// PNG once per worker and serves them in place of the Fieldwork images.

import { REVIEW_ORIGIN } from '../../../../frontend/e2e/fixtures/requirements-api.js';

import { readScreensFile } from './harness.js';

const SCREEN_FILES = ['booking-home', 'booking-home-schedule'];
let rendered = null;

async function renderScreens(browser) {
  const css = readScreensFile('prototype', 'harbor-pine.css');
  const context = await browser.newContext({ deviceScaleFactor: 1, viewport: { height: 800, width: 1280 } });
  try {
    const page = await context.newPage();
    const files = {};
    for (const name of SCREEN_FILES) {
      await page.setContent(readScreensFile('prototype', `${name}.html`).replace('/*__CSS__*/', css));
      await page.evaluate(() => document.fonts.ready);
      files[`screens/${name}.png`] = await page.screenshot({ type: 'png' });
    }
    return files;
  } finally {
    await context.close();
  }
}

/** Serves the Harbor & Pine screen images. Register after the requirements fixtures. */
export async function installHarborPineScreens(page, browser) {
  rendered ??= renderScreens(browser);
  const files = await rendered;
  await page.route(`${REVIEW_ORIGIN}/**`, (route) => {
    const { pathname } = new URL(route.request().url());
    const match = pathname.match(/^\/p\/[^/]+\/[^/]+\/(.+)$/);
    const body = match ? files[decodeURIComponent(match[1])] : null;
    if (!body) return route.fallback();
    return route.fulfill({
      body,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        'Content-Type': 'image/png',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      },
      status: 200,
    });
  });
}
