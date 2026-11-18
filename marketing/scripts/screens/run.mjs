#!/usr/bin/env node
// Regenerates marketing/public/screens: captures every screen in light and dark mode with the
// frontend's Playwright into output/marketing-screens, then publishes a 1600px WebP of each, plus
// a 1024px copy in public/screens/thumb for the hero's 3D ring.
//
//   node marketing/scripts/screens/run.mjs              capture everything, then WebP
//   node marketing/scripts/screens/run.mjs --webp-only  only rebuild the WebP files
//
// Set ODIN_SCREENS=home,kanban to capture a subset, and ODIN_PLAYWRIGHT_PORT to move the dev
// server off 4199. Any other arguments go to `playwright test`.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolves from marketing/node_modules, where Astro already installs it.
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const captureDir = path.join(repoRoot, 'output', 'marketing-screens');
const outputDir = path.join(repoRoot, 'marketing', 'public', 'screens');
const thumbDir = path.join(outputDir, 'thumb');
const playwrightCli = path.join(repoRoot, 'frontend', 'node_modules', '@playwright', 'test', 'cli.js');
const config = path.join(here, 'playwright.config.js');

const WEBP_WIDTH = 1600;
const WEBP_QUALITY = 82;
const THUMB_WIDTH = 1024;

const args = process.argv.slice(2);
const webpOnly = args.includes('--webp-only');
const playwrightArgs = args.filter((arg) => arg !== '--webp-only');

if (!webpOnly) {
  const env = { ...process.env, ODIN_PLAYWRIGHT_PORT: process.env.ODIN_PLAYWRIGHT_PORT || '4199' };
  const result = spawnSync(process.execPath, [playwrightCli, 'test', '-c', config, ...playwrightArgs], { cwd: repoRoot, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`Screenshot capture failed (exit ${result.status}). WebP files were not rebuilt.`);
    process.exit(result.status ?? 1);
  }
}

mkdirSync(thumbDir, { recursive: true });
const pngs = readdirSync(captureDir).filter((name) => name.endsWith('.png')).sort();
for (const name of pngs) {
  const source = path.join(captureDir, name);
  const webp = name.replace(/\.png$/, '.webp');
  await sharp(source).resize({ width: WEBP_WIDTH }).webp({ quality: WEBP_QUALITY }).toFile(path.join(outputDir, webp));
  await sharp(source).resize({ width: THUMB_WIDTH }).webp({ quality: 80 }).toFile(path.join(thumbDir, webp));
}
console.log(`Wrote ${pngs.length} WebP files to ${path.relative(repoRoot, outputDir)} and its thumb folder.`);
