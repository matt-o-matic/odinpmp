import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, devices } from '@playwright/test';

const frontendRoot = path.dirname(fileURLToPath(import.meta.url));
const previewPort = Number(process.env.ODIN_PLAYWRIGHT_PORT || 4173);
if (!Number.isInteger(previewPort) || previewPort < 1024 || previewPort > 65535) throw new Error('ODIN_PLAYWRIGHT_PORT must be an unprivileged TCP port.');
const workers = process.env.ODIN_PLAYWRIGHT_WORKERS ? Number(process.env.ODIN_PLAYWRIGHT_WORKERS) : undefined;
if (workers !== undefined && (!Number.isInteger(workers) || workers < 1 || workers > 32)) throw new Error('ODIN_PLAYWRIGHT_WORKERS must be an integer from 1 through 32.');
const outputRoot = process.env.ODIN_PLAYWRIGHT_OUTPUT_DIR
  ? path.resolve(process.env.ODIN_PLAYWRIGHT_OUTPUT_DIR)
  : path.resolve(frontendRoot, '..', 'output', 'playwright', 'local');

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  workers,
  forbidOnly: true,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  outputDir: path.join(outputRoot, 'test-results'),
  reporter: [
    ['line'],
    ['html', { open: 'never', outputFolder: path.join(outputRoot, 'html') }],
    ['junit', { outputFile: path.join(outputRoot, 'junit.xml') }],
  ],
  use: {
    baseURL: `http://127.0.0.1:${previewPort}/app/`,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium-mobile',
      use: { ...devices['Pixel 7'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${previewPort}`,
    cwd: frontendRoot,
    env: {
      ...process.env,
      VITE_API_BASE_URL: 'http://localhost:3001',
    },
    reuseExistingServer: false,
    timeout: 60_000,
    url: `http://127.0.0.1:${previewPort}/app/login`,
  },
});
