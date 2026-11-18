#!/usr/bin/env node
// The hero's ring also shows Bug Reporter and FaultLine, which live outside this repo. Their
// textures come from this site's own hand-built demos, in their finished state.
// Start the site first (npm --prefix marketing run dev), then:
//   node marketing/scripts/screens/hero-demos.mjs http://127.0.0.1:2281/

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const { chromium } = await import(pathToFileURL(path.join(repoRoot, 'frontend', 'node_modules', 'playwright', 'index.mjs')).href);
const site = process.argv[2] || 'http://127.0.0.1:2281/';
const thumbDir = path.join(repoRoot, 'marketing', 'public', 'screens', 'thumb');
const demos = { 'bug-reporter': '#step-report .demo__viewport', faultline: '#step-fix .demo__viewport' };

const browser = await chromium.launch();
try {
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1.5, colorScheme: theme, reducedMotion: 'reduce' });
    await page.addInitScript((value) => localStorage.setItem('odin-theme', value), theme);
    await page.goto(site, { waitUntil: 'networkidle' });
    for (const [name, selector] of Object.entries(demos)) {
      const demo = page.locator(selector);
      await demo.scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      const png = await demo.screenshot();
      await sharp(png).resize({ width: 1024, height: 640, fit: 'cover', position: 'top' }).webp({ quality: 80 }).toFile(path.join(thumbDir, `${name}-${theme}.webp`));
      console.log(`thumb/${name}-${theme}.webp`);
    }
    await page.close();
  }
} finally {
  await browser.close();
}
