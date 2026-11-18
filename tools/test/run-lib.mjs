import fs from 'node:fs/promises';
import path from 'node:path';

const TEST_FILE_PATTERN = /\.test\.(?:js|mjs)$/;
const LIVE_TEST_PATTERN = /\.live\.test\.(?:js|mjs)$/;
const RELATIVE_IMPORT_PATTERN = /(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
const LOCAL_DATABASE_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function parseArguments(argv) {
  const options = {
    allowLiveModel: false,
    base: 'HEAD',
    databaseUrlTemplate: process.env.ODIN_TEST_DATABASE_URL_TEMPLATE ?? '',
    dryRun: false,
    liveModelBudgetUsd: 0,
    output: '',
    profile: 'changed',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];

    if (argument === '--allow-live-model') options.allowLiveModel = true;
    else if (argument === '--dry-run') options.dryRun = true;
    else if (['--base', '--database-url-template', '--live-model-budget-usd', '--output', '--profile'].includes(argument)) {
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
      const key = {
        '--base': 'base',
        '--database-url-template': 'databaseUrlTemplate',
        '--live-model-budget-usd': 'liveModelBudgetUsd',
        '--output': 'output',
        '--profile': 'profile',
      }[argument];
      options[key] = key === 'liveModelBudgetUsd' ? Number(value) : value;
      index += 1;
    } else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }

  return options;
}

export function validateDatabaseUrlTemplate(template, runId) {
  if (!template) return '';
  if (!template.includes('{runId}')) {
    throw new Error('Test DATABASE_URL template must contain {runId} so each run uses an isolated schema.');
  }

  let parsed;
  try {
    parsed = new URL(template.replace('{runId}', runId));
  } catch {
    throw new Error('Test DATABASE_URL template is not a valid URL.');
  }

  if (parsed.protocol !== 'mysql:') throw new Error('Test DATABASE_URL must use the mysql protocol.');
  if (!LOCAL_DATABASE_HOSTS.has(parsed.hostname)) {
    throw new Error(`Test DATABASE_URL host must be local; received ${parsed.hostname || '<empty>'}.`);
  }
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  if (!/^odinpmp_test_[a-z0-9_]+$/i.test(databaseName)) {
    throw new Error('Test database name must start with odinpmp_test_ and contain only letters, numbers, and underscores.');
  }
  return parsed.toString();
}

export function createHermeticEnvironment(source, { allowLiveModel = false, databaseUrl = '' } = {}) {
  const environment = { ...source };
  const sensitiveName = /(_API_KEY|_ACCESS_KEY(?:_ID)?|_PASS|_PASSWORD|_SECRET|_TOKEN|DATABASE_URL)$/i;

  for (const name of Object.keys(environment)) {
    if (sensitiveName.test(name)) delete environment[name];
  }

  Object.assign(environment, {
    CLAMAV_ENABLED: 'false',
    DATABASE_URL: databaseUrl,
    FRONTEND_APP_URL: 'http://127.0.0.1:5173/app',
    GOOGLE_OAUTH_CLIENT_ID: '',
    GOOGLE_OAUTH_CLIENT_SECRET: '',
    GOOGLE_OAUTH_REDIRECT_URI: '',
    INBOUND_MAIL_WEBHOOK_SECRET: '',
    JWT_SECRET: 'odinpmp-hermetic-test-secret',
    MAIL_FROM_ADDRESS: 'noreply@example.com',
    NODE_ENV: 'test',
    ODIN_TEST_EXTERNAL_WRITES: 'disabled',
    SMTP_HOST: '',
    SMTP_PASS: '',
    SMTP_USER: '',
  });

  if (allowLiveModel && source.OPENAI_API_KEY) environment.OPENAI_API_KEY = source.OPENAI_API_KEY;
  else environment.OPENAI_API_KEY = '';
  return environment;
}

function normalize(relativePath) {
  return relativePath.split(path.sep).join('/').replace(/^\.\//, '');
}

async function isFile(filePath) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function resolveRelativeImport(sourceFile, specifier, root) {
  const target = path.resolve(path.dirname(sourceFile), specifier);
  const candidates = path.extname(target)
    ? [target]
    : [target, `${target}.js`, `${target}.mjs`, `${target}.vue`, path.join(target, 'index.js')];
  for (const candidate of candidates) {
    if (candidate.startsWith(`${root}${path.sep}`) && await isFile(candidate)) return candidate;
  }
  return null;
}

async function dependenciesFor(filePath, root, cache) {
  if (cache.has(filePath)) return cache.get(filePath);
  const dependencies = new Set();
  cache.set(filePath, dependencies);

  let source;
  try {
    source = await fs.readFile(filePath, 'utf8');
  } catch {
    return dependencies;
  }
  for (const match of source.matchAll(RELATIVE_IMPORT_PATTERN)) {
    const dependency = await resolveRelativeImport(filePath, match[1] ?? match[2], root);
    if (dependency) dependencies.add(dependency);
  }
  return dependencies;
}

async function transitivelyDependsOn(testFile, changedAbsolutePaths, root, cache) {
  const pending = [testFile];
  const visited = new Set();
  while (pending.length) {
    const current = pending.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    if (changedAbsolutePaths.has(current)) return true;
    pending.push(...await dependenciesFor(current, root, cache));
  }
  return false;
}

async function walk(directory) {
  const files = [];
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(absolutePath));
    else files.push(absolutePath);
  }
  return files;
}

export async function listDeterministicTests(root, { includeTools = false, allowLiveModel = false } = {}) {
  const scopes = [path.join(root, 'backend', 'test'), path.join(root, 'frontend', 'test'), path.join(root, 'tools', 'test')];
  if (includeTools) scopes.push(path.join(root, 'tools', 'clarification-inbound-lambda', 'test'));
  const files = (await Promise.all(scopes.map(walk))).flat();
  return files
    .map((file) => normalize(path.relative(root, file)))
    .filter((file) => TEST_FILE_PATTERN.test(file))
    .filter((file) => allowLiveModel || !LIVE_TEST_PATTERN.test(file))
    .sort();
}

export async function selectAffectedTests(root, changedFiles, { allowLiveModel = false } = {}) {
  const normalizedChanges = changedFiles.map(normalize);
  const relevantProjects = new Set(normalizedChanges.map((file) => file.split('/')[0]));
  if (normalizedChanges.some((file) => ['package.json', 'package-lock.json'].includes(file))) {
    relevantProjects.add('backend');
    relevantProjects.add('frontend');
    relevantProjects.add('tools');
  }

  const allTests = await listDeterministicTests(root, { includeTools: true, allowLiveModel });
  const candidates = allTests.filter((file) => relevantProjects.has(file.split('/')[0]));
  const changedAbsolutePaths = new Set(normalizedChanges.map((file) => path.resolve(root, file)));
  const cache = new Map();
  const selected = [];

  for (const testFile of candidates) {
    const absoluteTest = path.resolve(root, testFile);
    const testChanged = changedAbsolutePaths.has(absoluteTest);
    const packageWide = normalizedChanges.some((file) => {
      const project = testFile.split('/')[0];
      return file === `${project}/package.json` || file === `${project}/package-lock.json` || file === 'package.json' || file === 'package-lock.json';
    });
    if (testChanged || packageWide || await transitivelyDependsOn(absoluteTest, changedAbsolutePaths, root, cache)) selected.push(testFile);
  }

  if (normalizedChanges.some((file) => file.startsWith('tools/test/'))) {
    for (const testFile of allTests.filter((file) => file.startsWith('tools/test/'))) {
      if (!selected.includes(testFile)) selected.push(testFile);
    }
  }
  return selected.sort();
}

export function changedJavaScriptFiles(changedFiles) {
  return changedFiles.filter((file) => /^(backend\/src|tools)\/.*\.(?:js|mjs)$/.test(normalize(file)));
}

export function xmlEscape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
