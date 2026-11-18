// Playwright config for the marketing screenshots. It runs with the frontend's installed
// @playwright/test (see README.md), starts the frontend dev server against a mocked API,
// and captures every screen in light and dark mode.
//
// It deliberately does not import @playwright/test: that package lives in
// frontend/node_modules, and a plain config object needs nothing from it.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const frontendRoot = path.join(repoRoot, 'frontend');

// The requirements fixtures read this to build the review origin's frame-ancestors header,
// so it must be set before they load. Workers inherit it.
process.env.ODIN_PLAYWRIGHT_PORT ||= '4199';
const port = Number(process.env.ODIN_PLAYWRIGHT_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('ODIN_PLAYWRIGHT_PORT must be an unprivileged TCP port.');

const outputRoot = path.join(repoRoot, 'output', 'playwright', 'marketing-screens');

export default {
  testDir: here,
  testMatch: '*.capture.js',
  fullyParallel: true,
  workers: process.env.ODIN_SCREENS_WORKERS ? Number(process.env.ODIN_SCREENS_WORKERS) : 4,
  forbidOnly: true,
  retries: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: path.join(outputRoot, 'test-results'),
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}/app/`,
    browserName: 'chromium',
    colorScheme: 'light',
    deviceScaleFactor: 2,
    // Nothing off this machine resolves, so hints such as <link rel="preconnect"> cannot open
    // connections either. Requests the routes answer never reach DNS.
    launchOptions: { args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'] },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    viewport: { height: 900, width: 1440 },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'marketing-desktop' }],
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: frontendRoot,
    env: { ...process.env, VITE_API_BASE_URL: 'http://localhost:3001' },
    reuseExistingServer: false,
    timeout: 90_000,
    url: `http://127.0.0.1:${port}/app/login`,
  },
};
