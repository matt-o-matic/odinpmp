#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();
if (!databaseUrl) throw new Error('Local deployment smoke requires ODIN_TEST_DATABASE_URL.');

const backendPort = 31_000 + (process.pid % 5_000);
const frontendPort = 41_000 + (process.pid % 5_000);
const backendOrigin = `http://127.0.0.1:${backendPort}`;
const frontendOrigin = `http://127.0.0.1:${frontendPort}`;
const children = [];

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root, env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output = `${output}${chunk}`.slice(-16_000); });
    child.stderr.on('data', (chunk) => { output = `${output}${chunk}`.slice(-16_000); });
    child.once('close', (code, signal) => resolve({ code: code ?? 1, output, signal }));
    child.once('error', (error) => resolve({ code: 1, output: `${output}${error.stack ?? error.message}`, signal: null }));
  });
}

function start(command, args, env) {
  const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { logs.push(String(chunk)); if (logs.length > 100) logs.shift(); });
  const value = { child, logs };
  children.push(value);
  return value;
}

async function waitFor(url, { timeoutMs = 30_000 } = {}) {
  const expiresAt = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < expiresAt) {
    try {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2_000) });
      if (response.ok) return response;
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message ?? 'unavailable'}`);
}

async function stopAll() {
  await Promise.all(children.map(async ({ child }) => {
    if (child.exitCode != null) return;
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('close', resolve)),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ]);
    if (child.exitCode == null) child.kill('SIGKILL');
  }));
}

try {
  const environment = {
    ...process.env,
    BACKEND_PUBLIC_URL: backendOrigin,
    CORS_ALLOWED_ORIGINS: frontendOrigin,
    DATABASE_URL: databaseUrl,
    FRONTEND_APP_URL: `${frontendOrigin}/app`,
    NODE_ENV: 'test',
    OPENAI_API_KEY: '',
    PORT: String(backendPort),
    VITE_API_BASE_URL: backendOrigin,
  };
  const { createConnection } = await import('../../backend/node_modules/mysql2/promise.js');
  const legacySchema = await fs.readFile(path.join(root, 'backend/db/base-schema.sql'), 'utf8');
  const parsedDatabaseUrl = new URL(databaseUrl);
  const importer = await createConnection({
    database: decodeURIComponent(parsedDatabaseUrl.pathname.slice(1)),
    host: parsedDatabaseUrl.hostname,
    multipleStatements: true,
    password: decodeURIComponent(parsedDatabaseUrl.password),
    port: Number(parsedDatabaseUrl.port || 3306),
    user: decodeURIComponent(parsedDatabaseUrl.username),
  });
  try {
    await importer.query(legacySchema);
  } finally {
    await importer.end();
  }
  const bootstrap = await run(process.execPath, ['backend/src/jobs/bootstrap-schema.js'], { env: environment });
  if (bootstrap.code !== 0) throw new Error(`Schema bootstrap failed.\n${bootstrap.output}`);

  const backend = start(process.execPath, ['backend/src/server.js'], environment);
  const frontend = start('npm', ['--prefix', 'frontend', 'run', 'preview', '--', '--host', '127.0.0.1', '--port', String(frontendPort)], environment);
  const [liveResponse, frontendResponse] = await Promise.all([
    waitFor(`${backendOrigin}/health/live`),
    waitFor(`${frontendOrigin}/app/`),
  ]);
  const live = await liveResponse.json();
  if (live.ok !== true || live.service !== 'odinpmp-backend') throw new Error('Backend liveness payload is invalid.');
  const readyResponse = await waitFor(`${backendOrigin}/health/ready`);
  const ready = await readyResponse.json();
  if (ready.ok !== true || ready.draining !== false) throw new Error(`Backend readiness failed: ${JSON.stringify(ready)}`);
  const api = await (await waitFor(`${backendOrigin}/api`)).json();
  if (api.ok !== true || api.status !== 'initialized') throw new Error('Backend API smoke payload is invalid.');

  const html = await frontendResponse.text();
  if (!html.includes('id="app"')) throw new Error('Frontend preview did not serve the application shell.');
  const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((match) => match[1]);
  if (assets.length < 2) throw new Error('Frontend application shell did not reference built JavaScript and CSS assets.');
  for (const asset of assets) {
    const response = await waitFor(new URL(asset, `${frontendOrigin}/app/`).toString());
    const contentType = String(response.headers.get('content-type') ?? '');
    if (!/(javascript|css)/.test(contentType)) throw new Error(`Built asset ${asset} has unexpected content type ${contentType}.`);
  }
  if (backend.child.exitCode != null) throw new Error(`Backend exited early.\n${backend.logs.join('').slice(-8_000)}`);
  if (frontend.child.exitCode != null) throw new Error(`Frontend exited early.\n${frontend.logs.join('').slice(-8_000)}`);
  console.log(JSON.stringify({ assets: assets.length, backend: 'ready', frontend: 'ready', gracefulShutdown: 'requested' }));
} finally {
  await stopAll();
}
