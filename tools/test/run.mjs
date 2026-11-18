#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

import {
  changedJavaScriptFiles,
  createHermeticEnvironment,
  listDeterministicTests,
  parseArguments,
  selectAffectedTests,
  validateDatabaseUrlTemplate,
  xmlEscape,
} from './run-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const profiles = JSON.parse(await fs.readFile(path.join(root, 'tools/test/profiles.json'), 'utf8'));

function usage() {
  return `Usage: npm run test:autonomous -- --profile changed|pr|integration|coverage|nightly|weekly|release|postdeploy [options]

Options:
  --base <git-ref>                 Diff base for the changed profile (default: HEAD)
  --output <directory>             Artifact directory (default: .test-results/<run-id>)
  --database-url-template <url>    Local MySQL URL containing {runId}; schema must start odinpmp_test_
  --allow-live-model               Preserve OPENAI_API_KEY and include *.live.test.js
  --live-model-budget-usd <n>      Required maximum spend when --allow-live-model is used
  --dry-run                        Select and report gates without executing them
`;
}

function runCommand(command, args, { cwd = root, env = process.env, quiet = false } = {}) {
  return new Promise((resolve) => {
    const npmOnWindows = command === 'npm' && process.platform === 'win32';
    const npmCli = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    const child = spawn(npmOnWindows ? process.execPath : command, npmOnWindows ? [npmCli, ...args] : args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; if (!quiet) process.stdout.write(chunk); });
    child.stderr.on('data', (chunk) => { stderr += chunk; if (!quiet) process.stderr.write(chunk); });
    child.on('error', (error) => resolve({ code: 1, stderr: `${stderr}${error.stack ?? error.message}`, stdout }));
    child.on('close', (code, signal) => resolve({ code: code ?? 1, signal, stderr, stdout }));
  });
}

async function gitLines(args) {
  const result = await runCommand('git', args, { quiet: true });
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed.`);
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function changedFiles(base) {
  const [tracked, untracked] = await Promise.all([
    gitLines(['diff', '--name-only', '--diff-filter=ACMR', base, '--']),
    gitLines(['ls-files', '--others', '--exclude-standard']),
  ]);
  return [...new Set([...tracked, ...untracked])].sort();
}

function commandGroups(testFiles, { discoverBackend = false } = {}) {
  const groups = new Map();
  for (const file of testFiles) {
    const project = file.split('/')[0];
    const cwd = file.startsWith('tools/clarification-inbound-lambda/')
      ? path.join(root, 'tools/clarification-inbound-lambda')
      : ['backend', 'frontend'].includes(project)
        ? path.join(root, project)
        : root;
    const relativeFile = path.relative(cwd, path.join(root, file));
    const key = cwd;
    const group = groups.get(key) ?? [];
    group.push(relativeFile);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([cwd, files]) => ({
    command: process.execPath,
    args: [
      '--test', '--test-concurrency=1', '--test-timeout=30000', '--test-force-exit',
      ...(discoverBackend && cwd === path.join(root, 'backend') ? [] : files),
    ],
    cwd,
  }));
}

function createJUnit(results) {
  const failures = results.filter((result) => result.status === 'failed').length;
  const duration = results.reduce((total, result) => total + result.durationMs, 0) / 1000;
  const cases = results.map((result) => {
    const failure = result.status === 'failed'
      ? `<failure message="exit code ${result.exitCode}">${xmlEscape(String(result.stderr ?? '').slice(-8000))}</failure>`
      : result.status === 'skipped' ? '<skipped />' : '';
    return `<testcase classname="autonomous.${xmlEscape(result.kind)}" name="${xmlEscape(result.name)}" time="${result.durationMs / 1000}">${failure}</testcase>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><testsuite name="odin-autonomous" tests="${results.length}" failures="${failures}" time="${duration}">${cases}</testsuite>\n`;
}

function createHtml(manifest) {
  const rows = manifest.results.map((result) => `<tr><td>${xmlEscape(result.name)}</td><td>${xmlEscape(result.status)}</td><td>${result.durationMs}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Odin autonomous test ${xmlEscape(manifest.runId)}</title><style>body{font:14px system-ui;margin:2rem}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:.5rem;text-align:left}</style></head><body><h1>Odin autonomous test</h1><p>Profile: ${xmlEscape(manifest.profile)} · Status: ${xmlEscape(manifest.status)} · Seed: ${manifest.seed}</p><table><thead><tr><th>Gate</th><th>Status</th><th>Duration (ms)</th></tr></thead><tbody>${rows}</tbody></table></body></html>\n`;
}

async function provisionTestDatabase(databaseUrl) {
  if (!databaseUrl) return null;
  const parsed = new URL(databaseUrl);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  const serverUrl = new URL(parsed);
  serverUrl.pathname = '/';
  const { createConnection } = await import('../../backend/node_modules/mysql2/promise.js');
  const connection = await createConnection(serverUrl.toString());
  try {
    await connection.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } finally {
    await connection.end();
  }
  return async () => {
    const cleanupConnection = await createConnection(serverUrl.toString());
    try { await cleanupConnection.query(`DROP DATABASE IF EXISTS \`${database}\``); }
    finally { await cleanupConnection.end(); }
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) { console.log(usage()); return; }
  const profile = profiles[options.profile];
  if (!profile) throw new Error(`Unknown profile: ${options.profile}. Expected one of ${Object.keys(profiles).join(', ')}.`);
  if (options.allowLiveModel && !['nightly', 'weekly', 'release'].includes(options.profile)) {
    throw new Error('Live-model tests are allowed only in nightly, weekly, or release profiles.');
  }
  if (options.allowLiveModel && !(options.liveModelBudgetUsd > 0)) {
    throw new Error('--allow-live-model requires a positive --live-model-budget-usd ceiling.');
  }
  if (profile.requiresDatabase && !options.databaseUrlTemplate) {
    throw new Error('The integration profile requires --database-url-template with an isolated local odinpmp_test_{runId} schema.');
  }

  const startedAt = new Date();
  const runId = `${startedAt.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${process.pid}`;
  const seed = Number(process.env.ODIN_TEST_SEED) || Math.floor(Math.random() * 2 ** 31);
  const outputDirectory = path.resolve(root, options.output || path.join('.test-results', runId));
  const databaseUrl = validateDatabaseUrlTemplate(options.databaseUrlTemplate, runId.toLowerCase());
  const sourceEnvironment = { ...process.env };
  if (options.allowLiveModel && !sourceEnvironment.OPENAI_API_KEY) {
    try {
      const backendEnvironment = parseEnv(await fs.readFile(path.join(root, 'backend/.env'), 'utf8'));
      if (backendEnvironment.OPENAI_API_KEY) sourceEnvironment.OPENAI_API_KEY = backendEnvironment.OPENAI_API_KEY;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  const environment = createHermeticEnvironment(sourceEnvironment, { allowLiveModel: options.allowLiveModel, databaseUrl: '' });
  Object.assign(environment, { ODIN_TEST_DATABASE_URL: databaseUrl, ODIN_TEST_RUN_ID: runId, ODIN_TEST_SEED: String(seed), TMPDIR: path.join(outputDirectory, 'tmp') });
  environment.ODIN_PLAYWRIGHT_OUTPUT_DIR = path.join(root, 'output', 'playwright', runId);
  await fs.mkdir(environment.TMPDIR, { recursive: true });
  await fs.mkdir(path.join(outputDirectory, 'coverage', 'v8'), { recursive: true });
  const cleanupDatabase = options.dryRun ? null : await provisionTestDatabase(databaseUrl);

  const changes = options.profile === 'changed' ? await changedFiles(options.base) : [];
  const tests = profile.fullDeterministic
    ? await listDeterministicTests(root, { includeTools: profile.includeToolPackages, allowLiveModel: options.allowLiveModel })
    : await selectAffectedTests(root, changes, { allowLiveModel: options.allowLiveModel });
  const selectedBackendTests = new Set(tests.filter((file) => file.startsWith('backend/test/')));
  const discoverBackend = profile.fullDeterministic || (
    options.profile === 'changed'
    && selectedBackendTests.size > 0
    && (await listDeterministicTests(root, { allowLiveModel: options.allowLiveModel }))
      .filter((file) => file.startsWith('backend/test/'))
      .every((file) => selectedBackendTests.has(file))
  );
  const syntaxCandidates = options.profile === 'changed'
    ? changedJavaScriptFiles(changes)
    : (await gitLines(['ls-files', 'backend/src/**/*.js', 'backend/src/*.js', 'tools/**/*.mjs', 'tools/**/*.js'])).filter((file) => !file.includes('/node_modules/'));
  const syntaxFiles = (await Promise.all(syntaxCandidates.map(async (file) => {
    try {
      await fs.access(path.join(root, file));
      return file;
    } catch {
      return null;
    }
  }))).filter(Boolean);

  const gates = [
    { name: 'git-diff-check', kind: 'static', command: 'git', args: ['diff', '--check', options.profile === 'changed' ? options.base : 'HEAD', '--'], cwd: root },
    ...syntaxFiles.map((file) => ({ name: `syntax:${file}`, kind: 'static', command: process.execPath, args: ['--check', file], cwd: root })),
    ...commandGroups(tests, { discoverBackend }).map((group, index) => ({ name: `offline-tests:${index + 1}`, kind: 'test', ...group })),
    ...(profile.includeBuild ? [
      { name: 'backend-build', kind: 'build', command: 'npm', args: ['--prefix', 'backend', 'run', 'build'], cwd: root },
      { name: 'frontend-build', kind: 'build', command: 'npm', args: ['--prefix', 'frontend', 'run', 'build'], cwd: root },
    ] : []),
    ...(profile.includeSecurity ? [{
      name: 'security-abuse', kind: 'security', command: process.execPath,
      args: ['--test', '--test-timeout=10000', 'backend/test/app-security.test.js', 'backend/test/auth-api.test.js', 'backend/test/project-capabilities.test.js', 'backend/test/assistant-research-sources.test.js', 'backend/test/assistant-untrusted-content.test.js'], cwd: root,
    }] : []),
    ...(profile.includeResilience ? [{
      name: 'worker-chaos-recovery', kind: 'resilience', command: process.execPath,
      args: ['--test', '--test-timeout=10000', 'backend/test/assistant-durable-worker.test.js', 'backend/test/agent-execution-repository.test.js', 'backend/test/assistant-turn-queue-durable.test.js'], cwd: root,
    }, {
      name: 'ha-operational-failover', kind: 'resilience', command: process.execPath,
      args: ['tools/test/ha-operational-smoke.mjs'], cwd: root,
    }] : []),
    ...(profile.includePerformance ? [{
      name: 'performance-smoke', kind: 'performance', command: process.execPath,
      args: ['tools/test/performance-smoke.mjs'], cwd: root,
    }, ...(databaseUrl ? [{ name: 'multi-instance-large-tenant', kind: 'performance', command: process.execPath, args: ['tools/test/multi-instance-large-tenant-smoke.mjs'], cwd: root }] : [])] : []),
    ...(profile.includeBackupRestore ? [{
      name: 'backup-restore-drill', kind: 'resilience', command: process.execPath,
      args: ['tools/test/backup-restore-smoke.mjs'], cwd: root,
    }] : []),
    ...(profile.includePitr ? [{
      name: 'point-in-time-recovery-drill', kind: 'resilience', command: process.execPath,
      args: ['tools/test/pitr-smoke.mjs'], cwd: root,
    }] : []),
    ...(profile.includeCoverage ? [{
      name: 'backend-coverage', kind: 'coverage', command: process.execPath,
      args: ['--test', '--test-concurrency=1', '--test-timeout=30000', '--test-force-exit', '--experimental-test-coverage', '--test-coverage-include=src/**/*.js', '--test-coverage-lines=75', '--test-coverage-branches=64', '--test-coverage-functions=81'], cwd: path.join(root, 'backend'),
      env: { ...environment, DATABASE_URL: '', ODIN_TEST_DATABASE_URL: '', NODE_V8_COVERAGE: path.join(outputDirectory, 'coverage', 'v8') },
    }] : []),
    ...(profile.includeEval ? [{
      name: 'agent-eval-offline', kind: 'eval', command: process.execPath,
      args: ['tools/test/eval.mjs', '--suite', 'offline', '--output', path.join(outputDirectory, 'eval-offline')], cwd: root,
    }] : []),
    ...(profile.includeEval && options.allowLiveModel ? [{
      name: 'agent-eval-live', kind: 'eval', command: process.execPath,
      args: ['tools/test/eval.mjs', '--suite', 'live', '--budget-usd', String(options.liveModelBudgetUsd), '--output', path.join(outputDirectory, 'eval-live')], cwd: root,
    }] : []),
    ...(profile.includeBrowser ? [{
      name: 'browser-acceptance',
      kind: 'browser',
      command: 'npm',
      args: ['--prefix', 'frontend', 'run', 'test:e2e', '--', '--grep-invert', '@visual'],
      cwd: root,
    }] : []),
    ...(profile.includeVisual ? [{
      name: 'visual-regression', kind: 'visual', command: 'npm',
      args: ['--prefix', 'frontend', 'run', 'test:e2e', '--', '--grep', '@visual'], cwd: root,
    }] : []),
    ...(profile.includePostDeploy ? [{
      name: 'local-postdeploy-smoke', kind: 'postdeploy', command: process.execPath,
      args: ['tools/test/local-deployment-smoke.mjs'], cwd: root,
    }] : []),
  ];

  console.log(`[autonomous] profile=${options.profile} changed=${changes.length} tests=${tests.length} gates=${gates.length} seed=${seed}`);

  const results = [];
  let stopped = false;
  for (const gate of gates) {
    if (stopped || options.dryRun) {
      results.push({ durationMs: 0, exitCode: null, kind: gate.kind, name: gate.name, status: options.dryRun ? 'planned' : 'skipped' });
      continue;
    }
    const gateStartedAt = Date.now();
    console.log(`\n[autonomous] ${gate.name}`);
    const result = await runCommand(gate.command, gate.args, { cwd: gate.cwd, env: gate.env ?? environment });
    const status = result.code === 0 ? 'passed' : 'failed';
    const logName = `${String(results.length + 1).padStart(3, '0')}-${gate.name.replace(/[^a-z0-9.-]+/gi, '_')}.log`;
    await fs.writeFile(path.join(outputDirectory, logName), `${result.stdout}${result.stderr}`);
    results.push({
      durationMs: Date.now() - gateStartedAt,
      exitCode: result.code,
      kind: gate.kind,
      log: logName,
      name: gate.name,
      status,
      stderr: result.stderr,
    });
    if (status === 'failed') stopped = true;
  }

  if (gates.length === 1) results.push({ durationMs: 0, exitCode: 0, kind: 'selection', name: 'no-affected-tests', status: 'passed' });
  const status = results.some((result) => result.status === 'failed') ? 'failed' : options.dryRun ? 'planned' : 'passed';
  const manifestResults = results.map(({ stderr: _stderr, ...result }) => result);
  const manifest = {
    schemaVersion: 1,
    runId,
    seed,
    profile: options.profile,
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    environment: { architecture: process.arch, database: databaseUrl ? 'isolated-local-schema' : 'disabled', liveModel: options.allowLiveModel, node: process.version, platform: `${os.platform()} ${os.release()}` },
    selection: { base: options.base, changedFiles: changes, testFiles: tests },
    results: manifestResults,
  };
  await Promise.all([
    fs.writeFile(path.join(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`),
    fs.writeFile(path.join(outputDirectory, 'junit.xml'), createJUnit(results)),
    fs.writeFile(path.join(outputDirectory, 'report.html'), createHtml(manifest)),
  ]);
  let cleanupStatus = 'not-required';
  if (cleanupDatabase) {
    await cleanupDatabase();
    cleanupStatus = 'passed';
  }
  await fs.writeFile(path.join(outputDirectory, 'cleanup.json'), `${JSON.stringify({ database: cleanupStatus }, null, 2)}\n`);
  console.log(`\n[autonomous] ${status}; artifacts: ${path.relative(root, outputDirectory)}`);
  if (status === 'failed') process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[autonomous] ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
