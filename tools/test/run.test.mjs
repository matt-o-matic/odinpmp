import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createHermeticEnvironment,
  parseArguments,
  selectAffectedTests,
  validateDatabaseUrlTemplate,
} from './run-lib.mjs';

test('parseArguments accepts profiles and explicit safety options', () => {
  assert.deepEqual(parseArguments(['--profile', 'pr', '--base', 'origin/main', '--dry-run']), {
    allowLiveModel: false,
    base: 'origin/main',
    databaseUrlTemplate: '',
    dryRun: true,
    liveModelBudgetUsd: 0,
    output: '',
    profile: 'pr',
  });
  assert.equal(parseArguments(['--allow-live-model', '--live-model-budget-usd', '1']).liveModelBudgetUsd, 1);
  assert.throws(() => parseArguments(['--profile']), /requires a value/);
  assert.throws(() => parseArguments(['--wat']), /Unknown argument/);
});

test('validateDatabaseUrlTemplate permits only isolated local MySQL schemas', () => {
  assert.match(
    validateDatabaseUrlTemplate('mysql://tester:secret@127.0.0.1/odinpmp_test_{runId}', 'run_123'),
    /odinpmp_test_run_123/,
  );
  assert.throws(() => validateDatabaseUrlTemplate('mysql://localhost/odinpmp_test_shared', 'run_123'), /contain \{runId\}/);
  assert.throws(() => validateDatabaseUrlTemplate('mysql://db.example.com/odinpmp_test_{runId}', 'run_123'), /must be local/);
  assert.throws(() => validateDatabaseUrlTemplate('mysql://localhost/production_{runId}', 'run_123'), /must start with odinpmp_test_/);
});

test('createHermeticEnvironment strips credentials and disables external writes', () => {
  const environment = createHermeticEnvironment({
    HOME: '/tmp/home',
    OPENAI_API_KEY: 'secret-openai-key',
    AWS_SECRET_ACCESS_KEY: 'secret-aws-key',
    RANDOM_ACCESS_TOKEN: 'secret-token',
    SMTP_PASS: 'secret-password',
  });
  assert.equal(environment.HOME, '/tmp/home');
  assert.equal(environment.NODE_ENV, 'test');
  assert.equal(environment.ODIN_TEST_EXTERNAL_WRITES, 'disabled');
  assert.equal(environment.OPENAI_API_KEY, '');
  assert.equal(environment.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(environment.RANDOM_ACCESS_TOKEN, undefined);
  assert.equal(environment.SMTP_PASS, '');
  assert.equal(environment.MAIL_FROM_ADDRESS, 'noreply@example.com');
});

test('createHermeticEnvironment preserves only the explicitly enabled live-model key', () => {
  const environment = createHermeticEnvironment({ OPENAI_API_KEY: 'live-key', OTHER_API_KEY: 'other-key' }, { allowLiveModel: true });
  assert.equal(environment.OPENAI_API_KEY, 'live-key');
  assert.equal(environment.OTHER_API_KEY, undefined);
});

test('selectAffectedTests follows transitive relative imports', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'odin-test-selector-'));
  context.after(() => fs.rm(root, { force: true, recursive: true }));
  await fs.mkdir(path.join(root, 'backend/src'), { recursive: true });
  await fs.mkdir(path.join(root, 'backend/test'), { recursive: true });
  await fs.writeFile(path.join(root, 'backend/src/leaf.js'), 'export const leaf = true;\n');
  await fs.writeFile(path.join(root, 'backend/src/feature.js'), "export { leaf } from './leaf.js';\n");
  await fs.writeFile(path.join(root, 'backend/test/feature.test.js'), "import '../src/feature.js';\n");
  await fs.writeFile(path.join(root, 'backend/test/unrelated.test.js'), 'void 0;\n');

  assert.deepEqual(await selectAffectedTests(root, ['backend/src/leaf.js']), ['backend/test/feature.test.js']);
});

test('coverage gate cannot reuse the integration database schema', async () => {
  const source = await fs.readFile(new URL('./run.mjs', import.meta.url), 'utf8');
  assert.match(source, /env: \{ \.\.\.environment, DATABASE_URL: '', ODIN_TEST_DATABASE_URL: ''/);
});

test('performance profiles include isolated multi-instance and large-tenant proof when MySQL is available', async () => {
  const source = await fs.readFile(new URL('./run.mjs', import.meta.url), 'utf8');
  assert.match(source, /multi-instance-large-tenant-smoke\.mjs/); assert.match(source, /databaseUrl \? \[\{ name: 'multi-instance-large-tenant'/);
});

test('resilience profiles include readiness-aware HTTP failover proof', async () => {
  const source = await fs.readFile(new URL('./run.mjs', import.meta.url), 'utf8');
  assert.match(source, /name: 'ha-operational-failover'/); assert.match(source, /ha-operational-smoke\.mjs/);
});

test('deterministic shards retain a bounded timeout that tolerates a loaded workstation', async () => {
  const source = await fs.readFile(new URL('./run.mjs', import.meta.url), 'utf8');
  assert.match(source, /'--test-timeout=30000'/);
});
