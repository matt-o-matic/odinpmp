#!/usr/bin/env node
// Real-stack local end-to-end exercise of the Requirements feature (plan.md journeys J1-J12).
//
// It runs against a stack that is already running on this machine (see tools/test/README.md,
// "Requirements real-stack exercise"): the backend with REQUIREMENTS_AI_PROVIDER=local-fixture,
// the review origin, the Vite frontend, and the local MySQL container. It seeds its own tenant,
// users, project, brief and stakeholders, drives the real UI in headless Chromium (desktop and
// Pixel 7), checks outcomes in the UI and through the API and the database, and writes step
// screenshots plus evidence.json to output/playwright/requirements-local/.
//
// Everything stays local. The script refuses non-loopback URLs and database hosts.
//
//   node tools/test/requirements-local-e2e.mjs [--only J1,J2] [--headed]
//
// It is not part of any test profile: it needs a running stack and writes to the dev database.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const requireFrontend = createRequire(path.join(root, 'frontend', 'package.json'));
const requireBackend = createRequire(path.join(root, 'backend', 'package.json'));
const { chromium, devices } = requireFrontend('@playwright/test');
const AxeBuilder = requireFrontend('@axe-core/playwright').default;
const mysql = requireBackend('mysql2/promise');
const bcrypt = requireBackend('bcryptjs');
const JSZip = requireBackend('jszip');

const args = process.argv.slice(2);
const argValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const ONLY = new Set(String(argValue('--only') ?? '').split(',').map((value) => value.trim()).filter(Boolean));
const HEADED = args.includes('--headed');
// --resume reruns journeys against the project and links of the previous run (state.json).
const RESUME = args.includes('--resume');

// The database comes from ODIN_E2E_DATABASE_URL, else from DATABASE_URL in backend/.env, the
// same local database the running backend uses.
async function localDatabaseUrl() {
  if (process.env.ODIN_E2E_DATABASE_URL) return process.env.ODIN_E2E_DATABASE_URL;
  const envFile = path.join(root, 'backend', '.env');
  const value = existsSync(envFile) ? parseEnv(await readFile(envFile, 'utf8')).DATABASE_URL : '';
  if (!value) throw new Error('Set ODIN_E2E_DATABASE_URL or DATABASE_URL in backend/.env.');
  return value;
}

const CONFIG = Object.freeze({
  apiUrl: process.env.ODIN_E2E_API_URL ?? 'http://127.0.0.1:3001',
  appUrl: process.env.ODIN_E2E_APP_URL ?? 'http://127.0.0.1:5401/app',
  databaseUrl: await localDatabaseUrl(),
  outputDir: path.resolve(root, process.env.ODIN_E2E_OUTPUT_DIR ?? 'output/playwright/requirements-local'),
  reviewUrl: process.env.ODIN_E2E_REVIEW_URL ?? 'http://127.0.0.1:3002',
});
const PASSWORD = 'Local-e2e-only-pass!';
const RUN_ID = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
const TRACK = 'experience';

for (const [name, value] of Object.entries(CONFIG)) {
  if (name === 'outputDir') continue;
  const host = new URL(value).hostname;
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    throw new Error(`${name} must point at this machine (got ${host}). This exercise stays local.`);
  }
}

// ---------------------------------------------------------------------------
// Evidence log
// ---------------------------------------------------------------------------

const evidence = {
  aiProvider: 'local-fixture (deterministic; not a live model)',
  config: { apiUrl: CONFIG.apiUrl, appUrl: CONFIG.appUrl, reviewUrl: CONFIG.reviewUrl, database: new URL(CONFIG.databaseUrl).pathname.slice(1) },
  finishedAt: null,
  journeys: [],
  runId: RUN_ID,
  seed: null,
  startedAt: new Date().toISOString(),
};
let shotCounter = 0;
let currentJourney = null;

async function saveEvidence() {
  await writeFile(path.join(CONFIG.outputDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

async function shot(page, name, options = {}) {
  shotCounter += 1;
  const file = `${String(shotCounter).padStart(3, '0')}-${currentJourney?.id ?? 'setup'}-${name}.png`;
  await page.screenshot({ fullPage: options.fullPage ?? false, path: path.join(CONFIG.outputDir, file) }).catch(() => {});
  currentJourney?.screenshots.push(file);
  return file;
}

function check(condition, message, detail = undefined) {
  if (!condition) {
    const error = new Error(message);
    error.detail = detail;
    throw error;
  }
  currentJourney?.checks.push(detail === undefined ? message : { check: message, detail });
}

function note(entry) {
  currentJourney?.notes.push(entry);
}

async function journey(id, title, acs, run) {
  if (ONLY.size > 0 && !ONLY.has(id)) return;
  const entry = { acs, checks: [], error: null, id, notes: [], screenshots: [], startedAt: new Date().toISOString(), status: 'running', title };
  evidence.journeys = evidence.journeys.filter((existing) => existing.id !== id);
  evidence.journeys.push(entry);
  currentJourney = entry;
  log(`\n== ${id} ${title}`);
  try {
    await run(entry);
    entry.status = 'passed';
    log(`   ${id}: passed (${entry.checks.length} checks)`);
  } catch (error) {
    entry.status = 'failed';
    entry.error = { detail: error.detail ?? null, message: error.message, stack: String(error.stack ?? '').split('\n').slice(0, 6).join('\n') };
    log(`   ${id}: FAILED: ${error.message}`);
    for (const page of [...openPages]) {
      await shot(page, 'failure').catch(() => {});
      await closePage(page);
    }
  } finally {
    entry.finishedAt = new Date().toISOString();
    currentJourney = null;
    await saveEvidence();
    await saveState();
  }
}

async function waitUntil(read, { interval = 250, message = 'condition', timeout = 15_000 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`Timed out after ${timeout} ms waiting for ${message}.`);
}

// ---------------------------------------------------------------------------
// Database and API
// ---------------------------------------------------------------------------

let pool = null;

async function sql(statement, params = []) {
  const [rows] = await pool.query(statement, params);
  return rows;
}

async function http(method, url, { body, headers = {}, raw = false, token } = {}) {
  const response = await fetch(url, {
    body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)),
    headers: {
      ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    method,
    redirect: 'manual',
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { body: json, headers: response.headers, status: response.status, text };
}

const tokens = new Map();

async function login(user) {
  const result = await http('POST', `${CONFIG.apiUrl}/api/auth/login`, {
    body: { email: user.email, password: PASSWORD },
    headers: { 'X-Auth-Response': 'bearer' },
  });
  if (result.status !== 200 || !result.body?.session?.token) throw new Error(`Login failed for ${user.email}: ${result.status} ${result.text.slice(0, 200)}`);
  tokens.set(user.key, result.body.session.token);
  return result.body.session.token;
}

function api(user) {
  const base = `${CONFIG.apiUrl}/api`;
  const call = (method) => (pathName, body, options = {}) => http(method, `${base}${pathName}`, { body, token: tokens.get(user.key), ...options });
  return { del: call('DELETE'), get: call('GET'), patch: call('PATCH'), post: call('POST'), put: call('PUT') };
}

function reqPath(suffix = '') {
  return `/projects/${state.projectId}/requirements${suffix}`;
}

function portalApi(token) {
  const base = `${CONFIG.apiUrl}/api/public/requirements/${token}`;
  const call = (method) => (pathName, body) => http(method, `${base}${pathName}`, { body });
  return { del: call('DELETE'), get: call('GET'), patch: call('PATCH'), post: call('POST'), put: call('PUT') };
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

let browser = null;
const openPages = new Set();

async function newPage({ device = 'desktop', user = null } = {}) {
  const options = device === 'phone'
    ? { ...devices['Pixel 7'] }
    : { viewport: { height: 900, width: 1440 } };
  const context = await browser.newContext(options);
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (error) => page.errors.push(error.message));
  openPages.add(page);
  page.on('close', () => openPages.delete(page));
  if (user) await signIn(page, user);
  return page;
}

async function signIn(page, user) {
  await page.goto(`${CONFIG.appUrl}/login`);
  await page.getByLabel('Work email').fill(user.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 15_000 });
}

async function closePage(page) {
  openPages.delete(page);
  await page.context().close().catch(() => {});
}

function appUrl(suffix) {
  return `${CONFIG.appUrl}${suffix}`;
}

async function axe(page, label) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const serious = result.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact));
  return {
    label,
    serious: serious.map((violation) => ({ help: violation.help, id: violation.id, impact: violation.impact, nodes: violation.nodes.slice(0, 3).map((node) => node.target.join(' ')) })),
    url: page.url().replace(/requirements\/[A-Za-z0-9_-]{20,}/, 'requirements/<token>'),
    violations: result.violations.length,
  };
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

const TENANT_NAME = 'Requirements Local E2E';
const USERS = {
  tenantAdmin: { email: 'e2e.tenant-admin@odin.local', key: 'tenantAdmin', name: 'Tomas Tenant', projectRole: null, tenantRole: 'admin' },
  admin: { email: 'e2e.project-admin@odin.local', key: 'admin', name: 'Ada Admin', projectRole: 'admin', tenantRole: 'user' },
  manager: { email: 'e2e.manager@odin.local', key: 'manager', name: 'Mia Manager', projectRole: 'manager', tenantRole: 'user' },
  member: { email: 'e2e.developer@odin.local', key: 'member', name: 'Devon Developer', projectRole: 'user', tenantRole: 'user' },
  viewer: { email: 'e2e.viewer@odin.local', key: 'viewer', name: 'Vic Viewer', projectRole: 'viewer', tenantRole: 'user' },
};
const STAKEHOLDERS = {
  a: { email: 'sam.client@client.odin.local', key: 'a', name: 'Sam Client', roleTitle: 'Operations lead' },
  b: { email: 'bea.finance@client.odin.local', key: 'b', name: 'Bea Finance', roleTitle: 'Finance manager' },
  c: { email: 'cy.services@client.odin.local', key: 'c', name: 'Cy Services', roleTitle: 'Client services' },
};
const BRIEF = {
  constraints: [
    'Clients must see the price before they commit to a visit.',
    'Booking must work on a phone with one hand.',
  ],
  name: 'Fieldwork client booking',
  objective: 'Let clients book, move, and pay for field service visits without calling the office.',
  requirements: [
    'Clients can book a visit in under a minute.',
    'Clients can reschedule or cancel a visit themselves.',
    'Technicians see client notes before each visit.',
  ],
};

const state = {
  annotations: {},
  links: {},
  packages: {},
  projectId: null,
  rounds: {},
  stakeholders: {},
  tenantId: null,
  topics: {},
};

async function seed() {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  let [tenant] = await sql('SELECT id FROM tenants WHERE name = ? ORDER BY created_at LIMIT 1', [TENANT_NAME]);
  if (!tenant) {
    tenant = { id: randomUUID() };
    await sql('INSERT INTO tenants (id, name) VALUES (?, ?)', [tenant.id, TENANT_NAME]);
  }
  state.tenantId = tenant.id;

  for (const user of Object.values(USERS)) {
    let [row] = await sql('SELECT id FROM users WHERE email = ?', [user.email]);
    if (!row) {
      row = { id: randomUUID() };
      await sql('INSERT INTO users (id, name, email, password, authentication_method_id) VALUES (?, ?, ?, ?, 1)', [row.id, user.name, user.email, passwordHash]);
    } else {
      await sql('UPDATE users SET name = ?, password = ? WHERE id = ?', [user.name, passwordHash, row.id]);
    }
    user.id = row.id;
    const [membership] = await sql('SELECT id FROM user_tenant WHERE user_id = ? AND tenant_id = ?', [user.id, tenant.id]);
    if (!membership) await sql('INSERT INTO user_tenant (id, user_id, tenant_id, role) VALUES (?, ?, ?, ?)', [randomUUID(), user.id, tenant.id, user.tenantRole]);
    else await sql('UPDATE user_tenant SET role = ? WHERE id = ?', [user.tenantRole, membership.id]);
    await login(user);
  }

  const owner = api(USERS.tenantAdmin);
  const created = await owner.post('/projects', { description: 'Local requirements exercise project.', name: `Fieldwork booking ${RUN_ID}`, status: 'In Progress' });
  if (created.status !== 201 && created.status !== 200) throw new Error(`Project create failed: ${created.status} ${created.text.slice(0, 300)}`);
  state.projectId = created.body?.project?.id ?? created.body?.id;
  if (!state.projectId) throw new Error(`Project create returned no id: ${created.text.slice(0, 300)}`);

  const permissions = await owner.put(`/projects/${state.projectId}/permissions`, {
    validUsers: [USERS.tenantAdmin, USERS.admin, USERS.manager, USERS.member].map((user) => ({ id: user.id, role: user.projectRole ?? 'admin' })),
  });
  if (permissions.status !== 200) throw new Error(`Permissions failed: ${permissions.status} ${permissions.text.slice(0, 300)}`);
  // The permissions API offers admin, manager and user. A read-only viewer is a project role
  // the capability map supports but the API does not assign, so it is inserted directly.
  await sql('DELETE FROM user_project WHERE user_id = ? AND project_id = ?', [USERS.viewer.id, state.projectId]);
  await sql('INSERT INTO user_project (id, user_id, project_id, role) VALUES (?, ?, ?, ?)', [randomUUID(), USERS.viewer.id, state.projectId, 'viewer']);

  const brief = await owner.put(`/projects/${state.projectId}/assistant-brief`, BRIEF);
  if (brief.status !== 200) throw new Error(`Brief failed: ${brief.status} ${brief.text.slice(0, 300)}`);

  for (const stakeholder of Object.values(STAKEHOLDERS)) {
    // Adding clarification stakeholders is a tenant admin or manager action (existing rule).
    const result = await owner.post(`/assistant/projects/${state.projectId}/stakeholder-contacts`, { email: stakeholder.email, name: stakeholder.name, roleTitle: stakeholder.roleTitle });
    if (result.status !== 201) throw new Error(`Stakeholder ${stakeholder.name} failed: ${result.status} ${result.text.slice(0, 300)}`);
    const id = result.body?.stakeholder?.id ?? result.body?.contact?.id ?? result.body?.id;
    state.stakeholders[stakeholder.key] = { ...stakeholder, id };
  }
  const roles = await sql('SELECT u.name, up.role FROM user_project up JOIN users u ON u.id = up.user_id WHERE up.project_id = ? ORDER BY u.name', [state.projectId]);
  evidence.seed = {
    brief: { constraints: BRIEF.constraints.length, requirements: BRIEF.requirements.length },
    projectId: state.projectId,
    projectRoles: roles,
    stakeholders: Object.values(state.stakeholders).map(({ id, name, roleTitle }) => ({ id, name, roleTitle })),
    tenant: TENANT_NAME,
    tenantId: state.tenantId,
    users: Object.values(USERS).map(({ email, id, name, projectRole, tenantRole }) => ({ email, id, name, projectRole, tenantRole })),
  };
  await saveEvidence();
  log(`Seeded project ${state.projectId} in tenant ${TENANT_NAME}.`);
}

// ---------------------------------------------------------------------------
// Journeys
// ---------------------------------------------------------------------------

const AI_LABELS = /AI proposal|drafted by AI|AI-drafted|AI generated|AI-generated|not a decision/i;
const DUPLICATE_PROMPT = 'What should "Clients can reschedule or cancel a visit themselves." look like for the people who use it, and how will we know it works?';

async function listTopics(user = USERS.member) {
  const result = await api(user).get(reqPath(`/tracks/${TRACK}/topics`));
  if (result.status !== 200) throw new Error(`Topic list failed: ${result.status}`);
  return result.body.topics ?? result.body.items ?? [];
}

async function createPortalLink(page, stakeholder) {
  await page.goto(appUrl(`/projects/${state.projectId}/requirements/links`));
  await page.getByRole('button', { name: 'New link' }).click();
  const dialog = page.getByRole('dialog', { name: 'New stakeholder link' });
  await dialog.getByLabel('Stakeholder').selectOption(state.stakeholders[stakeholder].id);
  await dialog.getByRole('button', { name: 'Create link' }).click();
  const url = (await page.getByTestId('rq-new-link-url').textContent()).trim();
  await shot(page, `link-created-${stakeholder}`);
  await page.getByRole('dialog', { name: 'Link created' }).getByRole('button', { name: 'Done' }).click();
  const token = url.split('/requirements/')[1];
  state.links[stakeholder] = { token, url };
  return { token, url };
}

async function j1DraftQuestions() {
  // The manager gives Cy (client services) a project link before anything is drafted.
  const manager = await newPage({ user: USERS.manager });
  const link = await createPortalLink(manager, 'c');
  check(link.url.startsWith(`${CONFIG.appUrl}/requirements/`), 'New link URL points at the requirements portal', link.url.replace(link.token, '<token>'));
  const [linkRow] = await sql('SELECT id, stakeholder_id FROM requirements_access_links WHERE project_id = ? AND stakeholder_id = ?', [state.projectId, state.stakeholders.c.id]);
  check(Boolean(linkRow), 'requirements_access_links row exists for Cy');
  const [tokenRow] = await sql('SELECT token_hash FROM requirements_access_link_tokens WHERE link_id = ?', [linkRow.id]);
  check(tokenRow?.token_hash === createHash('sha256').update(link.token).digest('hex'), 'The link token is stored only as its SHA-256 hash');
  await closePage(manager);

  const portal = await newPage();
  await portal.goto(link.url);
  await portal.getByText('Nothing to review right now').waitFor();
  await portal.getByText('No open questions right now.').waitFor();
  check(true, 'Before drafting, Cy\'s portal lists no open questions ("Questions waiting for you · 0")');
  await shot(portal, 'portal-before-draft');

  // A member writes one question by hand first; drafting must skip its duplicate.
  const member = await newPage({ user: USERS.member });
  await member.goto(appUrl(`/projects/${state.projectId}/requirements/experience/discuss`));
  const table = member.getByRole('table', { name: 'Experience topics' });
  await table.waitFor();
  await member.getByRole('button', { name: 'Add topic' }).click();
  const addDialog = member.getByRole('dialog').filter({ has: member.getByLabel('Question') });
  await addDialog.getByLabel('Question').fill(DUPLICATE_PROMPT);
  await addDialog.getByRole('button', { name: /Add topic|Save/ }).click();
  await addDialog.waitFor({ state: 'hidden' });
  // The register shows open topics under "Open"; the default filter lists what needs a decision first.
  await table.locator('tbody > tr').filter({ hasText: 'reschedule or cancel' }).first().waitFor();
  check(true, 'Member added one topic by hand');

  await member.getByRole('button', { name: 'Draft questions from brief' }).click();
  const status = member.getByRole('status').filter({ hasText: /Added \d+ questions? from the brief/ });
  await status.waitFor({ timeout: 20_000 });
  const statusText = (await status.textContent()).trim();
  check(/Added 4 questions from the brief/.test(statusText), 'Drafting added four questions', statusText);
  await member.getByText('Skipped 1 that repeats an existing topic.').waitFor();
  check(true, 'Drafting skipped the hand-written duplicate ("Skipped 1 that repeats an existing topic.")');
  const rows = table.locator('tbody > tr');
  await waitUntil(async () => (await rows.count()) >= 5, { message: 'five register rows' });
  const rowTexts = await rows.allTextContents();
  const cited = rowTexts.filter((text) => /brief line \d/.test(text));
  check(cited.length === 4, 'Each drafted row cites its brief line', cited.map((text) => text.replace(/\s+/g, ' ').slice(0, 140)));
  const workspaceText = await member.locator('.rq-workspace').innerText();
  check(!AI_LABELS.test(workspaceText), 'No AI label anywhere in the register');
  await shot(member, 'register-after-draft', { fullPage: true });

  const topics = await listTopics();
  const drafted = topics.filter((topic) => topic.topicOrigin === 'brief-draft' || topic.origin === 'brief-draft');
  check(drafted.length === 4, 'API: four topics with origin brief-draft', drafted.map((topic) => ({ prompt: topic.prompt, sourceRef: topic.sourceRef, state: topic.state })));
  const rowsDb = await sql(`SELECT c.id, c.prompt, c.clarification_status AS status, c.track, c.topic_origin, c.created_by, c.source_ref,
      (SELECT COUNT(*) FROM project_clarification_assignments a WHERE a.clarification_id = c.id) AS assignments
    FROM project_clarifications c WHERE c.project_id = ? ORDER BY c.created_at`, [state.projectId]);
  const draftedRows = rowsDb.filter((row) => row.topic_origin === 'brief-draft');
  check(draftedRows.length === 4 && draftedRows.every((row) => row.status === 'open' && row.track === TRACK && /^brief:/.test(row.source_ref)), 'DB: drafted topics are open Experience topics with a brief source_ref', draftedRows.map((row) => ({ source: row.source_ref, status: row.status })));
  check(draftedRows.every((row) => row.created_by === `user:${USERS.member.id}`), 'DB: the member who ran the action is the creator of every drafted topic');
  check(draftedRows.every((row) => Number(row.assignments) === 0), 'DB: drafted topics start unassigned');
  for (const topic of topics) {
    const prompt = topic.prompt ?? '';
    if (prompt === DUPLICATE_PROMPT) state.topics.manual = topic.id;
    else if (/book a visit in under a minute/.test(prompt)) state.topics.speed = topic.id;
    else if (/Technicians see client notes/.test(prompt)) state.topics.notes = topic.id;
    else if (/see the price before they commit/.test(prompt)) state.topics.price = topic.id;
    else if (/phone with one hand/.test(prompt)) state.topics.phone = topic.id;
  }
  check(Object.keys(state.topics).length === 5, 'Topics mapped by brief line', state.topics);

  // Q-13a: Cy's open portal shows the new questions without a reload.
  const questions = portal.getByRole('region', { name: /Questions waiting for you/ });
  await questions.waitFor({ timeout: 10_000 });
  await waitUntil(async () => (await questions.getByRole('listitem').count()) === 5, { message: 'five questions in the portal', timeout: 10_000 });
  check(true, 'Cy\'s already-open portal lists all five open questions without reloading (Q-13a)');
  await shot(portal, 'portal-after-draft', { fullPage: true });
  await portal.getByRole('link', { name: /see the price before they commit/ }).click();
  await portal.getByRole('heading', { level: 1 }).waitFor();
  for (const name of [/Dismiss/, /Reopen/, /Record a decision/, /Assign/, /Delete topic/, /Resolve/]) {
    check(await portal.getByRole('button', { name }).count() === 0, `Portal question has no ${name.source} control`);
  }
  check(await portal.getByLabel('Add to the discussion').count() === 1, 'Portal question takes comments');
  check(!/\bAI\b|drafted by/.test(await portal.locator('main, body').first().innerText()), 'Portal question shows no AI label');
  await shot(portal, 'portal-question');
  await closePage(portal);

  // The pipeline row reflects the drafted topics.
  await member.goto(appUrl(`/projects/${state.projectId}/requirements/experience/brief`));
  const stages = member.getByRole('navigation', { name: 'Experience stages' });
  await stages.getByRole('link', { name: /Brief 4 of 6 lines covered/ }).waitFor();
  check(true, 'Brief stage shows 4 of 6 lines covered');
  await shot(member, 'brief-stage', { fullPage: true });
  await closePage(member);
}

// ---------------------------------------------------------------------------
// J2: discussion and the Odin summary
// ---------------------------------------------------------------------------

async function getTopic(topicId, user = USERS.member) {
  const result = await api(user).get(reqPath(`/topics/${topicId}`));
  if (result.status !== 200) throw new Error(`Topic read failed: ${result.status} ${result.text.slice(0, 200)}`);
  return result.body.topic;
}

function flattenComments(comments = []) {
  return comments.flatMap((comment) => [comment, ...flattenComments(comment.replies ?? comment.children ?? [])]);
}

function topicUrl(topicId) {
  return appUrl(`/projects/${state.projectId}/requirements/topics/${topicId}`);
}

function portalQuestionUrl(stakeholder, topicId) {
  return `${state.links[stakeholder].url}/questions/${topicId}`;
}

async function postPortalComment(page, text, { replyTo = null } = {}) {
  const discussion = page.getByRole('region', { name: 'Discussion' });
  if (replyTo) {
    await discussion.getByRole('button', { name: `Reply to ${replyTo}` }).click();
    await discussion.getByRole('textbox', { name: `Reply to ${replyTo}` }).fill(text);
    await discussion.getByRole('button', { name: 'Post reply' }).click();
  } else {
    await discussion.getByLabel('Add to the discussion').fill(text);
    await discussion.getByRole('button', { name: 'Post comment' }).click();
  }
  await discussion.getByText(text).first().waitFor();
}

async function refreshSummary(page) {
  const summary = page.getByRole('region', { name: 'Odin summary' });
  await summary.getByRole('button', { name: /^Refresh/ }).click();
  await summary.getByRole('button', { name: /^Refresh/ }).filter({ hasNotText: 'Refreshing' }).waitFor({ timeout: 20_000 });
  return summary;
}

async function j2Discussion() {
  const manager = await newPage({ user: USERS.manager });
  await createPortalLink(manager, 'a');
  await createPortalLink(manager, 'b');
  check(Boolean(state.links.a && state.links.b), 'Manager created portal links for Sam and Bea');

  // Second browser: Mia keeps the topic open the whole time and never reloads.
  await manager.goto(topicUrl(state.topics.price));
  const watcherSummary = manager.getByRole('region', { name: 'Odin summary' });
  await watcherSummary.waitFor();

  const member = await newPage({ user: USERS.member });
  await member.goto(topicUrl(state.topics.price));
  await member.getByRole('region', { name: 'Discussion' }).waitFor();

  const sam = await newPage();
  await sam.goto(portalQuestionUrl('a', state.topics.price));
  await postPortalComment(sam, 'Show an estimated price range on the home screen, before clients pick a time. Finance gets fewer disputes that way.');
  check(true, 'Sam (stakeholder, portal) commented on the price topic');

  // One contributor: the summary says there is not enough input yet.
  await member.reload();
  let summary = await refreshSummary(member);
  await summary.getByText('Not enough input yet').waitFor({ timeout: 15_000 });
  check(true, 'With one contributor the summary shows "Not enough input yet"');
  await shot(member, 'summary-not-enough-input');

  const bea = await newPage();
  await bea.goto(portalQuestionUrl('b', state.topics.price));
  await postPortalComment(bea, 'Agreed. Finance needs the range up front, before a time is picked.', { replyTo: 'C1' });
  check(true, 'Bea (stakeholder, portal) replied in agreement to C1');
  summary = await refreshSummary(member);
  await summary.getByRole('heading', { name: /^Aligned · \d/ }).waitFor({ timeout: 15_000 });
  await summary.getByRole('heading', { name: /^Under-explored · \d/ }).waitFor();
  check(true, 'With only stakeholders contributing, the summary shows Aligned and Under-explored (the delivery team\'s view)');
  await shot(member, 'summary-aligned-under-explored', { fullPage: true });

  // The member disagrees in the team UI and votes; Cy backs C1 from the portal.
  await member.getByLabel('Add to the discussion').fill('I disagree: the price depends on the job type, so show it after a time is picked, not on the home screen.');
  await member.getByRole('button', { name: 'Post comment' }).click();
  await member.getByRole('article', { name: /^C3, Devon Developer/ }).waitFor();
  const devonDown = member.getByRole('button', { name: /^Disagree with C1/ });
  await devonDown.click();
  await waitUntil(async () => (await devonDown.getAttribute('aria-pressed')) === 'true', { message: 'Devon disagree vote' });
  check(true, 'Devon (member, team UI) commented and voted against C1');
  const cy = await newPage();
  await cy.goto(portalQuestionUrl('c', state.topics.price));
  const cyAgree = cy.getByRole('region', { name: 'Discussion' }).getByRole('button', { name: /^Agree with C1/ });
  await cyAgree.click();
  await waitUntil(async () => (await cyAgree.getAttribute('aria-pressed')) === 'true', { message: 'Cy agree vote' });
  check(true, 'Cy (stakeholder, portal) voted for C1');

  // No refresh this time: the debounced run publishes requirements.summary.updated and the
  // manager's open page updates in place.
  const started = Date.now();
  await watcherSummary.getByRole('heading', { name: /^Diverging · \d/ }).waitFor({ timeout: 90_000 });
  const seconds = Math.round((Date.now() - started) / 1000);
  check(true, `Mia's already-open topic page showed the new summary without reloading after ${seconds} s (20 s debounce)`);
  await watcherSummary.getByRole('heading', { name: /^Outstanding · \d/ }).waitFor();
  await watcherSummary.getByRole('heading', { name: /^Aligned · \d/ }).waitFor();
  await shot(manager, 'summary-live-update-second-browser', { fullPage: true });

  const topic = await getTopic(state.topics.price);
  const comments = flattenComments(topic.comments);
  const commentIds = new Set(comments.map((comment) => comment.id));
  const output = topic.summary?.output ?? topic.summary ?? {};
  const refs = (entry) => [...(entry.sources ?? []), ...(entry.positions ?? []).flatMap((position) => position.sources ?? [])];
  const cited = [...(output.aligned ?? []), ...(output.divergent ?? [])].flatMap(refs);
  const citedIds = cited.map((ref) => String(ref.ref ?? ref.id ?? ref).replace(/^comment:/, ''));
  check((output.aligned ?? []).length >= 1 && (output.divergent ?? []).length >= 1 && (output.outstanding ?? []).length >= 1, 'API: summary has aligned, divergent and outstanding entries', {
    aligned: (output.aligned ?? []).map((entry) => entry.statement),
    divergent: (output.divergent ?? []).map((entry) => entry.issue),
    outstanding: (output.outstanding ?? []).map((entry) => entry.item),
  });
  check(citedIds.length > 0 && citedIds.every((id) => commentIds.has(id)), 'API: every aligned and divergent citation resolves to a real comment in the thread', citedIds);
  check(Boolean(output.proposedAnswer), 'API: the summary proposes an answer, so the topic is ready for a decision', output.proposedAnswer);
  const runs = await sql('SELECT status, model, created_at FROM requirements_summaries WHERE project_id = ? AND scope_type = ? AND scope_id = ? ORDER BY created_at', [state.projectId, 'topic', state.topics.price]);
  check(runs.length >= 3, 'DB: each run is a new requirements_summaries row (history kept)', runs.map((run) => ({ model: run.model, status: run.status })));
  check(runs.filter((run) => run.model).every((run) => run.model === 'local-fixture'), 'DB: model runs came from the local fixture provider, not a live model (the one-contributor run needs no model call)');
  note('AC-02 evidence here uses the deterministic local fixture. The live-model evaluation remains Environment-limited (no OpenAI key).');

  // Citations in the UI move focus to the cited comment.
  const sourceButton = watcherSummary.getByRole('button', { name: /^Source C\d+: go to comment/ }).first();
  const sourceName = await sourceButton.getAttribute('aria-label') ?? await sourceButton.textContent();
  await sourceButton.click();
  const focused = await manager.evaluate(() => document.activeElement?.id ?? '');
  check(focused.startsWith('rq-comment-'), 'Clicking a citation moves focus to the cited comment', { focused, sourceName });
  check(!AI_LABELS.test(await manager.locator('.rq-workspace').innerText()), 'Topic page shows "Odin summary" with no AI disclaimer');

  // A second topic gets enough support to be ready for a decision too (AC-19 setup).
  await member.goto(topicUrl(state.topics.speed));
  await member.getByLabel('Add to the discussion').fill('Under a minute means three taps from the home screen to a confirmed visit.');
  await member.getByRole('button', { name: 'Post comment' }).click();
  await member.getByRole('article', { name: /^C1, Devon Developer/ }).waitFor();
  await sam.goto(portalQuestionUrl('a', state.topics.speed));
  const samAgree = sam.getByRole('region', { name: 'Discussion' }).getByRole('button', { name: /^Agree with C1/ });
  await samAgree.click();
  await waitUntil(async () => (await samAgree.getAttribute('aria-pressed')) === 'true', { message: 'Sam agree vote' });
  // A vote alone is not a contribution: the summary needs two people who wrote something.
  await postPortalComment(sam, 'Agreed, three taps from home is the bar.', { replyTo: 'C1' });
  await member.reload();
  summary = await refreshSummary(member);
  await summary.getByRole('heading', { name: /^Aligned · \d/ }).waitFor({ timeout: 15_000 });
  const speed = await getTopic(state.topics.speed);
  check(Boolean(speed.summary?.output?.proposedAnswer ?? speed.summary?.proposedAnswer), 'Second topic (booking speed) is ready for a decision', speed.state);

  for (const page of [manager, member, sam, bea, cy]) await closePage(page);
}

// ---------------------------------------------------------------------------
// J3: decision rights
// ---------------------------------------------------------------------------

async function j3Decisions() {
  const topicId = state.topics.phone;
  const decisionBody = { outcome: 'decided', statement: 'Probe decision that must not be stored.', topicId };

  // Viewer: reads, no write controls, 404 on every write.
  const viewer = await newPage({ user: USERS.viewer });
  await viewer.goto(topicUrl(state.topics.price));
  await viewer.getByRole('region', { name: 'Discussion' }).waitFor();
  check(await viewer.getByRole('region', { name: 'Record a decision' }).count() === 0, 'Viewer: no decision form');
  for (const name of ['Assign', 'Edit', 'Delete', 'Dismiss', 'Post comment']) {
    check(await viewer.getByRole('button', { name, exact: true }).count() === 0, `Viewer: no ${name} button`);
  }
  check(await viewer.getByLabel('Add to the discussion').count() === 0, 'Viewer: no comment composer');
  check(await viewer.getByRole('button', { name: /^Reply to/ }).count() === 0, 'Viewer: no reply buttons');
  await shot(viewer, 'viewer-topic-read-only');
  const viewerApi = api(USERS.viewer);
  const viewerWrites = {
    comment: (await viewerApi.post(reqPath(`/topics/${topicId}/comments`), { body: 'Viewer comment' })).status,
    decision: (await viewerApi.post(reqPath('/decisions'), decisionBody)).status,
    draft: (await viewerApi.post(reqPath(`/tracks/${TRACK}/draft-questions`))).status,
    patch: (await viewerApi.patch(reqPath(`/topics/${topicId}`), { status: 'resolved' })).status,
    topic: (await viewerApi.post(reqPath(`/tracks/${TRACK}/topics`), { prompt: 'Viewer topic' })).status,
  };
  check(Object.values(viewerWrites).every((status) => status === 404), 'Viewer API: every write returns 404 (AC-15)', viewerWrites);
  check((await viewerApi.get(reqPath(`/topics/${topicId}`))).status === 200, 'Viewer API: topic read returns 200');
  await closePage(viewer);

  // Member: discusses and assigns, but cannot decide or close.
  const member = await newPage({ user: USERS.member });
  await member.goto(topicUrl(topicId));
  await member.getByRole('region', { name: 'Discussion' }).waitFor();
  check(await member.getByRole('region', { name: 'Record a decision' }).count() === 0, 'Member: no decision form (AC-11)');
  await member.getByRole('region', { name: 'Decision' }).getByText('No decision yet.', { exact: false }).waitFor();
  check(await member.getByRole('button', { name: 'Dismiss' }).count() === 0, 'Member: no Dismiss control');
  await shot(member, 'member-topic-no-decision');
  const memberApi = api(USERS.member);
  const memberWrites = {
    decision: (await memberApi.post(reqPath('/decisions'), decisionBody)).status,
    preference: (await memberApi.post(reqPath('/preferences/accept'), { dimension: 'type', stance: 'keep', statement: 'Probe', track: TRACK })).status,
    links: (await memberApi.post(reqPath('/links'), { stakeholderId: state.stakeholders.a.id })).status,
    resolve: (await memberApi.patch(reqPath(`/topics/${topicId}`), { status: 'resolved' })).status,
  };
  check(memberWrites.decision === 404 && memberWrites.preference === 404 && memberWrites.links === 404, 'Member API: decisions, preferences and links return 404 (AC-11)', memberWrites);
  check(memberWrites.resolve >= 400, 'Member API: cannot resolve a topic', memberWrites.resolve);

  // The member assigns the hand-written topic to the manager (she owns it for AC-19).
  await member.goto(topicUrl(state.topics.manual));
  await member.getByRole('button', { name: 'Assign' }).click();
  const assign = member.getByRole('dialog', { name: 'Assign people' });
  await assign.getByLabel('Owner').selectOption(`user:${USERS.manager.id}`);
  await assign.getByRole('button', { name: 'Save assignments' }).click();
  await assign.waitFor({ state: 'hidden' });
  await member.locator('.rq-topic-head').getByText('Mia Manager').waitFor();
  check(true, 'Member assigned the manual topic to Mia Manager as owner');
  await closePage(member);

  // Stakeholder link: no status or decision route exists.
  const portal = portalApi(state.links.c.token);
  const portalWrites = {
    decision: (await portal.post('/decisions', decisionBody)).status,
    patch: (await portal.patch(`/topics/${topicId}`, { status: 'resolved' })).status,
    status: (await portal.post(`/topics/${topicId}/status`, { status: 'resolved' })).status,
  };
  check(Object.values(portalWrites).every((status) => status === 404), 'Stakeholder link API: status and decision writes return 404 (AC-11)', portalWrites);
  const [legacy] = await sql('SELECT access_token FROM project_stakeholders WHERE id = ?', [state.stakeholders.c.id]);
  const legacyPortal = await http('GET', `${CONFIG.apiUrl}/api/public/clarifications/${legacy.access_token}`);
  const legacyText = legacyPortal.text;
  check(!Object.values(state.topics).some((id) => legacyText.includes(id)), 'The older clarification portal does not expose tracked topics', { status: legacyPortal.status });

  // Manager: records the decision; it shows her as owner, with no AI tag.
  const manager = await newPage({ user: USERS.manager });
  await manager.goto(topicUrl(topicId));
  const box = manager.getByRole('region', { name: 'Record a decision' });
  await box.waitFor();
  await box.getByLabel('Decision statement').fill('Booking works one-handed: the main actions sit in the bottom third of the screen.');
  await box.getByRole('radio', { name: 'Decided' }).check();
  await box.getByRole('button', { name: 'Record decision' }).click();
  const recorded = manager.getByRole('region', { name: 'Decision' });
  await recorded.getByText('Recorded by Mia Manager', { exact: false }).waitFor();
  check(true, 'Manager recorded the decision; it shows "Recorded by Mia Manager"');
  check(!AI_LABELS.test(await manager.locator('.rq-workspace').innerText()), 'The recorded decision carries no AI tag');
  await shot(manager, 'manager-decision-recorded');
  const [decisionRow] = await sql('SELECT id, outcome, decided_by, sources_json, kind FROM requirements_decisions WHERE project_id = ? AND topic_id = ?', [state.projectId, topicId]).catch(() => sql('SELECT * FROM requirements_decisions WHERE project_id = ? AND topic_id = ?', [state.projectId, topicId]));
  check(decisionRow?.outcome === 'decided' && decisionRow?.decided_by === `user:${USERS.manager.id}`, 'DB: the decision stores its outcome and decider', { decidedBy: decisionRow?.decided_by, kind: decisionRow?.kind, outcome: decisionRow?.outcome });
  state.decisions = { phone: decisionRow?.id };
  const [topicRow] = await sql('SELECT clarification_status FROM project_clarifications WHERE id = ?', [topicId]);
  note(`Topic status after the decision: ${topicRow.clarification_status}`);
  await closePage(manager);
}

// ---------------------------------------------------------------------------
// J4: packages, the review origin, and grants
// ---------------------------------------------------------------------------

const EXAMPLE_ZIP = path.join(root, 'output', 'review-packages', 'fieldwork-round-2.zip');
const PACKAGE_STORAGE_DIR = path.join(root, 'backend', '.data', 'review-packages');

async function runNode(scriptArgs) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, scriptArgs, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => resolve({ code, output }));
  });
}

async function zipFromFiles(files) {
  const zip = new JSZip();
  for (const [name, bytes] of Object.entries(files)) zip.file(name, bytes, { date: new Date('2026-10-07T00:00:00Z') });
  return zip.generateAsync({ compression: 'DEFLATE', type: 'nodebuffer' });
}

async function readZip(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const files = {};
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!entry.dir) files[name] = await entry.async('nodebuffer');
  }
  return files;
}

/** The example names topics that exist only in test fixtures; point them at this project's topics. */
function adaptManifest(files, { basedOnRoundId = null } = {}) {
  const manifest = JSON.parse(files['manifest.json'].toString('utf8'));
  delete manifest.basedOnRoundId;
  if (basedOnRoundId) manifest.basedOnRoundId = basedOnRoundId;
  const questions = manifest.sections.find((section) => section.type === 'questions');
  for (const question of questions.items) {
    if (question.topicId === 'topic-exp-01') question.topicId = state.topics.price;
    if (question.topicId === 'topic-exp-03') question.topicId = state.topics.manual;
  }
  return { ...files, 'manifest.json': Buffer.from(JSON.stringify(manifest, null, 2)) };
}

async function storageFileCount() {
  if (!existsSync(PACKAGE_STORAGE_DIR)) return 0;
  const { readdir } = await import('node:fs/promises');
  return (await readdir(PACKAGE_STORAGE_DIR, { recursive: true })).length;
}

async function packageCounts() {
  const [row] = await sql(`SELECT (SELECT COUNT(*) FROM review_packages WHERE project_id = ?) AS packages,
      (SELECT COUNT(*) FROM review_package_files f JOIN review_packages p ON p.id = f.package_id WHERE p.project_id = ?) AS files`, [state.projectId, state.projectId]);
  return { files: Number(row.files), packages: Number(row.packages), storage: await storageFileCount() };
}

async function j4Packages() {
  const built = await runNode(['tools/review-package/build-examples.mjs']);
  check(built.code === 0 && existsSync(EXAMPLE_ZIP), 'node tools/review-package/build-examples.mjs built the example zips', built.output.trim().split('\n'));
  const pristine = await readFile(EXAMPLE_ZIP);
  const validated = await runNode(['tools/review-package/validate.mjs', EXAMPLE_ZIP, '--track', TRACK]);
  check(validated.code === 0, 'validate.mjs accepts the built example locally', validated.output.trim().split('\n').slice(0, 4));

  // As built, the example names topic-exp-01 and topic-exp-03, which exist only in test
  // fixtures. On a real project Odin rejects it until those ids point at real topics.
  const asBuilt = await http('POST', `${CONFIG.apiUrl}/api${reqPath(`/packages/upload?track=${TRACK}`)}`, { body: pristine, headers: { 'Content-Type': 'application/zip' }, raw: true, token: tokens.get('member') });
  const asBuiltCodes = (asBuilt.body?.errors ?? []).map((error) => `${error.code} ${error.path}`);
  check(asBuilt.status === 422 && asBuiltCodes.every((code) => code.startsWith('reference_invalid')), 'The example as built is rejected on a real project only for its fixture topic ids (reference_invalid)', asBuiltCodes);
  note('The example manifest names topicId topic-exp-01 and topic-exp-03. The harness rewrites those two ids to this project\'s price and reschedule topics (as an agent would from odin_get_requirements_context) and drops basedOnRoundId; nothing else in the zip changes.');
  const exampleFiles = await readZip(pristine);
  const projectZip = await zipFromFiles(adaptManifest(exampleFiles));
  await writeFile(path.join(CONFIG.outputDir, 'fieldwork-round-2.project.zip'), projectZip);

  // A deliberately broken zip: a missing screen file, a disallowed extension, a path that
  // escapes the package, and a prototype that loads a script from the internet.
  const brokenFiles = adaptManifest(exampleFiles);
  delete brokenFiles['screens/booking-home.png'];
  brokenFiles['tools/setup.exe'] = Buffer.from('MZ not really');
  brokenFiles['../escape.txt'] = Buffer.from('outside');
  brokenFiles['prototypes/booking/index.html'] = Buffer.from(exampleFiles['prototypes/booking/index.html'].toString('utf8').replace('</head>', '<script src="https://cdn.example.com/tracker.js"></script></head>'));
  const brokenZip = await zipFromFiles(brokenFiles);

  const member = await newPage({ user: USERS.member });
  await member.goto(appUrl(`/projects/${state.projectId}/requirements/experience/review`));
  const packagesRegion = member.getByRole('region', { name: 'Review packages' });
  await packagesRegion.waitFor();
  const before = await packageCounts();
  await member.getByLabel('Upload package').setInputFiles({ buffer: brokenZip, mimeType: 'application/zip', name: 'fieldwork-broken.zip' });
  const rejection = member.getByTestId('rq-package-rejection');
  await rejection.waitFor({ timeout: 30_000 });
  const rejectionText = await rejection.innerText();
  check(/fieldwork-broken\.zip was not uploaded\. Odin found \d+ problems?, and nothing was stored\./.test(rejectionText), 'Broken zip: the UI says it was not uploaded and nothing was stored', rejectionText.split('\n')[0]);
  const problemItems = await rejection.getByRole('list').first().getByRole('listitem').allInnerTexts();
  const codes = problemItems.map((text) => (/code ([a-z_]+)/.exec(text) ?? [])[1]).filter(Boolean);
  check(['missing_file', 'type_not_allowed', 'path_invalid'].every((code) => codes.includes(code)) || codes.length >= 3, 'Broken zip: per-file problems are listed with their codes', problemItems.map((text) => text.replace(/\s+/g, ' ').slice(0, 160)));
  await shot(member, 'upload-rejected', { fullPage: true });
  const after = await packageCounts();
  check(after.packages === before.packages && after.files === before.files && after.storage === before.storage, 'Broken zip: no package row, no file index row, and no stored object', { after, before });

  // The valid package through the UI.
  await member.goto(appUrl(`/projects/${state.projectId}/requirements/experience/review`));
  await packagesRegion.waitFor();
  await member.getByLabel('Upload package').setInputFiles({ buffer: projectZip, mimeType: 'application/zip', name: 'fieldwork-round-2.zip' });
  await member.getByRole('heading', { name: /^Version 1 · Client booking/ }).waitFor({ timeout: 60_000 });
  await member.getByRole('status').filter({ hasText: 'Version 1 uploaded as a draft.' }).waitFor();
  const packageId = /packages\/([^/?#]+)/.exec(member.url())[1];
  state.packages.v1 = packageId;
  check(true, 'Valid zip uploaded through the UI as draft version 1', { packageId });
  const [pkgRow] = await sql('SELECT version, status, source, file_count, track FROM review_packages WHERE id = ?', [packageId]);
  check(pkgRow.version === 1 && pkgRow.status === 'draft' && pkgRow.source === 'ui' && pkgRow.track === TRACK, 'DB: review_packages row is draft v1 from the UI', pkgRow);
  const screens = await sql('SELECT screen_id, kind, content_hash FROM review_package_screens WHERE package_id = ? ORDER BY screen_id', [packageId]);
  check(screens.length === 3 && screens.every((screen) => /^[0-9a-f]{64}$/.test(screen.content_hash)), 'DB: three screens with content hashes', screens.map((screen) => `${screen.screen_id}:${screen.kind}`));
  state.screenHashes = Object.fromEntries(screens.map((screen) => [screen.screen_id, screen.content_hash]));

  // Every manifest section renders.
  const sections = {
    boundaries: member.getByRole('region', { name: /does not cover|What this round/ }),
    context: member.getByRole('region', { name: 'What we heard in round 1' }),
    directions: member.getByRole('region', { name: /^Directions/ }),
    flows: member.getByRole('region', { name: /^Flows/ }),
    questions: member.getByRole('region', { name: /^Questions/ }),
    references: member.getByRole('region', { name: /References/ }),
    screens: member.getByRole('region', { name: /^Screens/ }),
  };
  for (const [name, region] of Object.entries(sections)) {
    await region.first().waitFor();
  }
  check(true, 'Preview shows context, references, directions, screens, flows, questions and boundaries');
  check(await sections.directions.getByRole('article').count() === 2, 'Preview: two directions');
  check(await sections.screens.getByRole('list', { name: 'Screens in this package' }).getByRole('button').count() === 3, 'Preview: three screens');
  // Flows draw when they scroll near the viewport.
  await sections.flows.scrollIntoViewIfNeeded();
  await sections.flows.getByRole('img', { name: /Book a visit, diagram/ }).waitFor({ timeout: 30_000 });
  check(true, 'Preview: the Mermaid flow renders once scrolled into view');
  check((await packageCounts()).storage > 0, 'Storage: the accepted package\'s files are on disk under backend/.data/review-packages (the broken upload left none)');
  await shot(member, 'package-preview', { fullPage: true });

  // The prototype through the real review origin.
  await member.goto(appUrl(`/projects/${state.projectId}/requirements/experience/review/packages/${packageId}?screen=booking-flow`));
  const frameElement = sections.screens.locator('iframe');
  await frameElement.waitFor({ timeout: 20_000 });
  const frameSrc = await frameElement.getAttribute('src');
  check(await frameElement.getAttribute('sandbox') === 'allow-scripts allow-forms', 'Prototype iframe is sandboxed with allow-scripts allow-forms only');
  check(frameSrc.startsWith(`${CONFIG.reviewUrl}/p/${packageId}/`) && frameSrc.includes('?odin-parent='), 'Prototype loads from the review origin with a grant and odin-parent', frameSrc.replace(/\/p\/[^/]+\/[^/]+\//, '/p/<package>/<grant>/'));
  const protoStatus = sections.screens.getByTestId('rq-proto-status');
  await member.waitForFunction(() => /Showing Choose service/.test(document.querySelector('[data-testid="rq-proto-status"]')?.textContent ?? ''), null, { timeout: 30_000 });
  await sections.screens.getByRole('group', { name: 'States' }).getByRole('button', { name: 'Pick a time' }).click();
  await member.waitForFunction(() => /Showing Pick a time/.test(document.querySelector('[data-testid="rq-proto-status"]')?.textContent ?? ''), null, { timeout: 15_000 });
  check(true, 'Bridge: ready, then goto-state moved the prototype to "Pick a time"', await protoStatus.textContent());
  await sections.screens.getByRole('button', { name: 'Check snapshot' }).click();
  await member.waitForFunction(() => /Snapshot taken, 1280 × 800\./.test(document.querySelector('[data-testid="rq-snapshot-status"]')?.textContent ?? ''), null, { timeout: 45_000 });
  check(true, 'Bridge: snapshot captured at 1280 × 800 inside the sandbox');
  const snapshot = sections.screens.getByRole('img', { name: 'Snapshot of Booking flow' });
  const frame = member.frameLocator('.rq-proto__frame');
  const frameBox = await frameElement.boundingBox();
  const target = await frame.locator('[data-odin-id="continue"]').boundingBox();
  const shotBox = await snapshot.boundingBox();
  await snapshot.click({ position: { x: ((target.x + target.width / 2 - frameBox.x) / frameBox.width) * shotBox.width, y: ((target.y + target.height / 2 - frameBox.y) / frameBox.height) * shotBox.height } });
  const hint = sections.screens.getByTestId('rq-hint-result');
  await hint.getByText('data-odin-id continue', { exact: false }).waitFor({ timeout: 15_000 });
  check(true, 'Bridge: an element hint names data-odin-id "continue"', (await hint.innerText()).replace(/\s+/g, ' '));
  await shot(member, 'prototype-preview', { fullPage: true });

  // AC-05 by HTTP: headers, no cookies, app origin 404s, forged and expired grants 404.
  const fileUrl = frameSrc.split('?')[0];
  const html = await http('GET', fileUrl, { headers: { Cookie: 'odin_session=should-not-be-read' } });
  const csp = html.headers.get('content-security-policy') ?? '';
  check(html.status === 200 && html.text.includes('<script src="/__odin/bridge.js"></script>'), 'Review origin serves the prototype with the bridge injected');
  check(csp.startsWith('sandbox allow-scripts allow-forms allow-popups;') && csp.includes("connect-src 'self'") && csp.includes(`frame-ancestors ${new URL(CONFIG.appUrl).origin}`) && csp.includes("form-action 'none'"), 'Review origin CSP: sandbox, connect-src self, frame-ancestors app origin, form-action none', csp);
  const headerChecks = {
    'access-control-allow-origin': html.headers.get('access-control-allow-origin'),
    'cross-origin-resource-policy': html.headers.get('cross-origin-resource-policy'),
    'referrer-policy': html.headers.get('referrer-policy'),
    'set-cookie': html.headers.get('set-cookie'),
    'x-content-type-options': html.headers.get('x-content-type-options'),
  };
  check(headerChecks['x-content-type-options'] === 'nosniff' && headerChecks['referrer-policy'] === 'no-referrer' && headerChecks['cross-origin-resource-policy'] === 'cross-origin' && headerChecks['access-control-allow-origin'] === '*' && !headerChecks['set-cookie'], 'Review origin headers: nosniff, no-referrer, CORP cross-origin, ACAO *, no Set-Cookie', headerChecks);
  const bridge = await http('GET', `${CONFIG.reviewUrl}/__odin/bridge.js`);
  check(bridge.status === 200 && (bridge.headers.get('content-security-policy') ?? '').startsWith('sandbox'), 'Bridge script is served with the same CSP');
  const relative = new URL(fileUrl).pathname;
  const appOrigin = new URL(CONFIG.appUrl).origin;
  const appProbe = {
    api: (await http('GET', `${CONFIG.apiUrl}${relative}`)).status,
    apiBridge: (await http('GET', `${CONFIG.apiUrl}/__odin/bridge.js`)).status,
    frontend: (await http('GET', `${appOrigin}${relative}`)).status,
  };
  check(appProbe.api === 404 && appProbe.apiBridge === 404 && appProbe.frontend === 404, 'App origins (API and frontend) return 404 for package paths', appProbe);
  const [, , , grant] = relative.split('/');
  const grants = await import(pathToFileURL(path.join(root, 'backend/src/modules/requirements/packages/package-grants.js')).href);
  const viewerRef = JSON.parse(Buffer.from(grant.split('.')[0], 'base64url').toString('utf8')).v;
  const signed = (options) => grants.createPackageGrant({ secret: grants.DEVELOPMENT_GRANT_SECRET, viewerRef, ...options });
  const probe = async (packagePath, grantValue) => (await http('GET', `${CONFIG.reviewUrl}/p/${packagePath}/${grantValue}/prototypes/booking/index.html`)).status;
  const grantProbe = {
    expired: await probe(packageId, signed({ expiresAt: new Date(Date.now() - 60_000), packageId })),
    foreignPackage: await probe(packageId, signed({ expiresAt: new Date(Date.now() + 600_000), packageId: randomUUID() })),
    missing: (await http('GET', `${CONFIG.reviewUrl}/p/${packageId}/prototypes/booking/index.html`)).status,
    tampered: await probe(packageId, `${grant.slice(0, -2)}${grant.endsWith('AA') ? 'BB' : 'AA'}`),
    validControl: await probe(packageId, grant),
    wrongPackagePath: await probe(randomUUID(), grant),
  };
  check(grantProbe.validControl === 200 && ['expired', 'foreignPackage', 'missing', 'tampered', 'wrongPackagePath'].every((key) => grantProbe[key] === 404), 'Expired, foreign, tampered, missing and mismatched grants return 404', grantProbe);
  note('The expired and foreign grants were signed with the development grant secret, which this local stack uses because REVIEW_GRANT_SECRET is unset.');
  await closePage(member);
}

// ---------------------------------------------------------------------------
// J5: publish a round
// ---------------------------------------------------------------------------

function localInput(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T17:00`;
}

async function publishRound(page, { closeOutcome = null, note: noteText, packageId, reviewers }) {
  await page.goto(appUrl(`/projects/${state.projectId}/requirements/experience/review/packages/${packageId}`));
  await page.getByRole('link', { name: 'Publish as a round' }).click();
  await page.waitForURL(/\/publish$/);
  const picker = page.getByRole('region', { name: 'Reviewers' });
  await picker.waitFor();
  for (const { name, required } of reviewers) {
    await picker.getByRole('checkbox', { name: new RegExp(`^${name} ·`) }).check();
    if (required) await picker.getByRole('checkbox', { name: `${name} is required` }).check();
  }
  const ask = page.getByRole('region', { name: 'Ask' });
  const due = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await ask.getByLabel('Due').fill(localInput(due));
  await ask.getByLabel('Note to reviewers').fill(noteText);
  if (closeOutcome) await closeOutcome(page);
  const summaryText = (await page.locator('#rq-publish-summary').innerText()).trim();
  await shot(page, 'publish-form', { fullPage: true });
  await page.getByRole('button', { name: /^(Close round \d+ and )?[Pp]ublish round \d+$/ }).click();
  const done = page.getByRole('region', { name: /^Round \d+ published$/ });
  await done.waitFor({ timeout: 30_000 });
  return { done, due, summaryText };
}

async function j5Publish() {
  const member = await newPage({ user: USERS.member });
  const mailBefore = Number((await sql('SELECT COALESCE(MAX(id), 0) AS id FROM mail_queue'))[0].id);
  const { done, summaryText } = await publishRound(member, {
    note: 'Please focus on the price range on the home screen and whether booking still feels quick.',
    packageId: state.packages.v1,
    reviewers: [
      { name: 'Sam Client', required: true },
      { name: 'Bea Finance', required: false },
      { name: 'Mia Manager', required: true },
    ],
  });
  check(/emails 2 external reviewers and notifies 1 member/.test(summaryText), 'Publish form summary: emails 2 external reviewers and notifies 1 member', summaryText);
  const doneText = await done.innerText();
  check(/Invited 2 external reviewers and 1 member/.test(doneText), 'Published: "Invited 2 external reviewers and 1 member"', doneText.split('\n').slice(0, 6));
  await shot(member, 'round-published', { fullPage: true });
  const roundLink = done.getByRole('link', { name: /^Open round 1$/ });
  const href = await roundLink.getAttribute('href');
  state.rounds.r1 = /rounds\/([^/?#]+)/.exec(href)[1];

  const [round] = await sql('SELECT id, number, status, due_at, published_by, note FROM review_rounds WHERE id = ?', [state.rounds.r1]);
  check(round.status === 'open' && round.number === 1 && round.published_by === `user:${USERS.member.id}` && Boolean(round.due_at), 'DB: round 1 is open, has a due date, and was published by the member (Q-05)', { due: round.due_at, number: round.number, status: round.status });
  const reviewerRows = await sql('SELECT actor_type, actor_id, required FROM review_round_reviewers WHERE round_id = ? ORDER BY actor_type, actor_id', [state.rounds.r1]);
  const required = Object.fromEntries(reviewerRows.map((row) => [row.actor_id, Boolean(row.required)]));
  check(reviewerRows.length === 3 && required[state.stakeholders.a.id] === true && required[state.stakeholders.b.id] === false && required[USERS.manager.id] === true, 'DB: three reviewers with the chosen required flags', reviewerRows.map((row) => `${row.actor_type}:${row.required ? 'required' : 'optional'}`));

  const mails = await sql('SELECT id, recipient_email, subject, body, status, mail_template_id FROM mail_queue WHERE id > ? ORDER BY id', [mailBefore]);
  const byRecipient = new Map();
  for (const mail of mails) byRecipient.set(mail.recipient_email, [...(byRecipient.get(mail.recipient_email) ?? []), mail]);
  check([STAKEHOLDERS.a.email, STAKEHOLDERS.b.email, USERS.manager.email].every((email) => byRecipient.get(email)?.length === 1), 'mail_queue holds exactly one invitation per reviewer', mails.map((mail) => ({ status: mail.status, subject: mail.subject, template: mail.mail_template_id, to: mail.recipient_email })));
  const portalUrl = /(http:\/\/[^\s"'<>]+\/requirements\/([A-Za-z0-9_-]{30,})\/rounds\/([0-9a-f-]{36}))/;
  for (const key of ['a', 'b']) {
    const mail = byRecipient.get(STAKEHOLDERS[key].email)[0];
    const match = portalUrl.exec(mail.body);
    check(Boolean(match) && match[3] === state.rounds.r1, `${STAKEHOLDERS[key].name}'s email links to the requirements portal for round 1`, match ? match[1].replace(match[2], '<token>') : mail.body.slice(0, 200));
    const hash = createHash('sha256').update(match[2]).digest('hex');
    const [tokenRow] = await sql('SELECT t.purpose, t.revoked_at, l.stakeholder_id FROM requirements_access_link_tokens t JOIN requirements_access_links l ON l.id = t.link_id WHERE t.token_hash = ?', [hash]);
    check(tokenRow?.stakeholder_id === state.stakeholders[key].id && !tokenRow.revoked_at && match[2] !== state.links[key].token, `${STAKEHOLDERS[key].name}'s emailed token is fresh (not the manual link), hashed in the DB, and bound to that stakeholder`, { purpose: tokenRow?.purpose });
    state.links[`${key}Email`] = { roundUrl: match[1], token: match[2], url: match[1].replace(/\/rounds\/.*$/, '') };
  }
  const managerMail = byRecipient.get(USERS.manager.email)[0];
  check(managerMail.body.includes(`/projects/${state.projectId}/requirements/experience/review`) && !/\/requirements\/[A-Za-z0-9_-]{30,}\//.test(managerMail.body), 'The member reviewer\'s email links into the app, with no portal token');
  state.memberReviewLink = (/(http:\/\/[^\s"'<>]+\/requirements\/experience\/review\?round=[0-9a-f-]{36})/.exec(managerMail.body) ?? [])[1] ?? null;

  // Package questions without a topic became topics; the package is now published.
  const [pkg] = await sql('SELECT status FROM review_packages WHERE id = ?', [state.packages.v1]);
  check(pkg.status === 'published', 'DB: the package is now published');
  const questionTopics = await sql("SELECT prompt FROM project_clarifications WHERE project_id = ? AND topic_origin = 'package-question'", [state.projectId]);
  check(questionTopics.length === 2, 'Publishing created topics for the two questions with no topicId', questionTopics.map((row) => row.prompt));

  // The portal says who asked (publishedBy fix).
  const portal = await newPage();
  await portal.goto(state.links.aEmail.url);
  const ask = portal.getByTestId('rq-round-ask');
  await ask.waitFor();
  const headline = (await ask.getByRole('heading', { level: 2 }).innerText()).trim();
  check(headline.startsWith('Devon Developer asked you to review Client booking'), 'Portal inbox: "Devon Developer asked you to review …" (publishedBy)', headline);
  const listed = await portalApi(state.links.aEmail.token).get('/rounds');
  check(listed.body?.rounds?.[0]?.publishedBy?.name === 'Devon Developer' && !JSON.stringify(listed.body).includes(USERS.member.id), 'Portal round list API carries publishedBy by name only');
  await shot(portal, 'portal-inbox-round');
  await closePage(portal);
  await closePage(member);
}

// ---------------------------------------------------------------------------
// Guided review helpers (portal and team)
// ---------------------------------------------------------------------------

function reviewSteps(page) {
  return page.getByRole('navigation', { name: 'Review steps' });
}

async function waitSaved(page) {
  // An unchanged choice saves nothing, so an idle status (no Saving, no error) also counts.
  await page.waitForTimeout(300);
  await page.waitForFunction(() => {
    const status = document.querySelector('[data-testid="rq-save-status"]')?.textContent ?? '';
    return !/Saving|Couldn/.test(status);
  }, null, { timeout: 20_000 });
}

async function goStep(page, name) {
  await reviewSteps(page).getByRole('button', { name: new RegExp(name) }).click();
}

async function setStances(page, stances) {
  await goStep(page, 'Directions');
  await page.getByRole('heading', { name: 'Compare the directions' }).waitFor();
  for (const [direction, stance, remix] of stances) {
    await page.getByRole('group', { name: `Your view of ${direction}` }).getByRole('radio', { name: stance }).check();
    if (remix) {
      const index = stances.findIndex((entry) => entry[0] === direction);
      const field = page.getByLabel(/Anything to keep from this direction/).nth(index);
      await field.fill(remix);
      await field.blur();
    }
    await waitSaved(page);
  }
}

async function openScreen(page, title) {
  await goStep(page, 'Screens');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const heading = page.getByRole('heading', { level: 2, name: title, exact: true });
    if (await heading.count()) return;
    const next = page.getByRole('button', { name: 'Next screen' });
    if (!(await next.count())) break;
    await next.first().click();
    await page.waitForTimeout(300);
  }
  await page.getByRole('heading', { level: 2, name: title, exact: true }).waitFor({ timeout: 5_000 });
}

async function giveVerdict(page, overall, { change = '', dims = {}, stay = '' } = {}) {
  const feedbackTab = page.getByRole('tab', { name: 'Your feedback' });
  if (await feedbackTab.count()) await feedbackTab.click();
  // Prototypes are judged as a flow: 'Overall, this flow'.
  await page.getByRole('group', { name: /^Overall, this (screen|flow)$/ }).getByRole('radio', { exact: true, name: overall }).check();
  await waitSaved(page);
  for (const [label, value] of Object.entries(dims)) {
    await page.getByRole('radiogroup', { name: new RegExp(`^${label.replace(/[&]/g, '\\$&')}`) }).getByRole('radio', { exact: true, name: value }).check();
    await waitSaved(page);
  }
  for (const [label, text] of [['What should stay?', stay], ['What should change?', change]]) {
    if (!text) continue;
    await page.getByLabel(label).fill(text);
    await page.getByLabel(label).blur();
    await waitSaved(page);
  }
}

async function answerQuestions(page, { notice, placement, speed, tax }) {
  await goStep(page, 'Questions');
  await page.getByRole('heading', { name: 'Questions from the team' }).waitFor();
  if (placement) await page.getByRole('group', { name: /Where should the price first appear/ }).getByRole('radio', { name: placement }).check();
  if (tax) await page.getByRole('group', { name: /Should the price range say/ }).getByRole('radio', { exact: true, name: tax }).check();
  if (notice) {
    const box = page.getByRole('textbox', { name: 'How much notice do clients need to reschedule for free?' });
    await box.fill(notice);
    await box.blur();
  }
  if (speed) await page.getByRole('group', { name: /How quick did booking feel/ }).getByRole('radio', { exact: true, name: String(speed) }).check();
  await waitSaved(page);
}

async function submitReview(page) {
  await goStep(page, 'Submit');
  await page.getByRole('heading', { name: 'Here’s what you’re telling the team' }).waitFor();
  const summary = await page.locator('main, body').first().innerText();
  await page.getByRole('button', { name: 'Submit review' }).click();
  await page.getByTestId('rq-submitted').waitFor();
  return summary;
}

// ---------------------------------------------------------------------------
// J12 (part run after publishing): My open items, and a member reviewer before/after submit
// ---------------------------------------------------------------------------

async function myItems(page) {
  await page.goto(appUrl(`/projects/${state.projectId}/requirements`));
  await page.getByRole('navigation', { name: 'Requirements views' }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.rq-item').length > 0 || /Nothing is waiting on you/.test(document.body.innerText), null, { timeout: 15_000 });
  const groups = {};
  for (const name of ['Needs your answer', 'Needs your review', 'Needs your decision', 'Your drafts']) {
    const region = page.getByRole('region', { name });
    groups[name] = (await region.count()) ? (await region.getByRole('listitem').allInnerTexts()).map((text) => text.replace(/\s+/g, ' ').trim().slice(0, 120)) : null;
  }
  const tracks = await page.locator('.rq-item .rq-track-chip').allInnerTexts();
  return { groups, items: await page.locator('.rq-item').count(), tracks };
}

async function j12MyOpenItems() {
  const manager = await newPage({ user: USERS.manager });
  const before = await myItems(manager);
  const views = manager.getByRole('navigation', { name: 'Requirements views' });
  check(await views.getByRole('link', { name: /My open items/ }).getAttribute('aria-current') === 'page', 'Requirements opens on My open items');
  check(before.items === 4
    && before.groups['Needs your answer']?.length === 1
    && before.groups['Needs your review']?.length === 1
    && before.groups['Needs your decision']?.length === 2, 'Manager: exactly four items (1 answer, 1 review, 2 decisions)', before.groups);
  check(before.tracks.length === 4 && before.tracks.every((track) => /Experience|Architecture/.test(track)), 'Manager: every item shows its track', before.tracks);
  const tabBadge = await manager.getByRole('navigation', { name: 'Project workspace tabs' }).getByRole('link', { name: /Requirements/ }).innerText();
  check(/4/.test(tabBadge), 'The Requirements tab badge shows 4', tabBadge.replace(/\s+/g, ' '));
  await shot(manager, 'my-items-manager', { fullPage: true });

  const viewer = await newPage({ user: USERS.viewer });
  const viewerItems = await myItems(viewer);
  check(viewerItems.groups['Needs your decision'] === null && await viewer.getByRole('link', { name: /^Decide: / }).count() === 0, 'Viewer: no decision group and no Decide links', viewerItems.groups);
  check(await viewer.getByRole('link', { name: 'Stakeholder links' }).count() === 0, 'Viewer: no Stakeholder links action');
  await shot(viewer, 'my-items-viewer', { fullPage: true });
  await closePage(viewer);

  const member = await newPage({ user: USERS.member });
  const memberItems = await myItems(member);
  check(memberItems.groups['Needs your decision'] === null, 'Member: no decision group', memberItems.groups);
  if (memberItems.items === 0) check(await member.getByText('Nothing is waiting on you.').count() === 1, 'Member: the empty state says nothing is waiting');
  await shot(member, 'my-items-member', { fullPage: true });
  await closePage(member);

  // Mia reviews as an invited member: from the email link to the team guided review.
  await manager.goto(state.memberReviewLink);
  await manager.getByRole('heading', { name: /^Round 1 results/ }).waitFor();
  await manager.locator(`a[href*="/rounds/${state.rounds.r1}/review"]`).click();
  await reviewSteps(manager).waitFor();
  await setStances(manager, [['Action first', 'Preferred'], ['Schedule first', 'Rejected']]);
  await openScreen(manager, 'Booking home');
  await giveVerdict(manager, 'Keep', { dims: { 'Type & size': 'Keep' } });
  await openScreen(manager, 'Booking home, schedule first');
  await giveVerdict(manager, 'Change', { change: 'A calendar first hides the price.' });
  await openScreen(manager, 'Booking flow');
  await giveVerdict(manager, 'Keep with changes', { change: 'Show the exact price on the time step too.' });
  await answerQuestions(manager, { notice: '48 hours', placement: 'Only after a time is picked', speed: 3, tax: 'Yes' });
  await submitReview(manager);
  check(true, 'Mia completed and submitted her review in the team guided review');
  await shot(manager, 'team-review-submitted');
  const after = await myItems(manager);
  check(after.groups['Needs your review'] === null && after.items === 3, 'After submitting, the round leaves Mia\'s "Needs your review" (3 items left)', after.groups);
  await shot(manager, 'my-items-manager-after-submit', { fullPage: true });
  const [reviewer] = await sql('SELECT submitted_at FROM review_round_reviewers WHERE round_id = ? AND actor_type = ? AND actor_id = ?', [state.rounds.r1, 'user', USERS.manager.id]);
  check(Boolean(reviewer.submitted_at), 'DB: review_round_reviewers.submitted_at is set for Mia');
  await closePage(manager);
}

const STATE_FILE = () => path.join(CONFIG.outputDir, 'state.json');

// Local link tokens live here so --resume can reopen the portal; output/ is gitignored.
async function saveState() {
  const users = Object.fromEntries(Object.values(USERS).map((user) => [user.key, user.id]));
  await writeFile(STATE_FILE(), `${JSON.stringify({ state, users }, null, 2)}
`);
}

async function resumeState() {
  const saved = JSON.parse(await readFile(STATE_FILE(), 'utf8'));
  Object.assign(state, saved.state);
  for (const user of Object.values(USERS)) {
    user.id = saved.users[user.key];
    await login(user);
  }
  const previous = JSON.parse(await readFile(path.join(CONFIG.outputDir, 'evidence.json'), 'utf8'));
  Object.assign(evidence, { journeys: previous.journeys, runId: previous.runId, seed: previous.seed });
  shotCounter = Math.max(0, ...previous.journeys.flatMap((entry) => entry.screenshots).map((file) => Number.parseInt(file, 10) || 0));
  log(`Resuming project ${state.projectId}.`);
}

async function main() {
  if (!RESUME) await rm(CONFIG.outputDir, { force: true, recursive: true });
  await mkdir(CONFIG.outputDir, { recursive: true });
  pool = mysql.createPool({ connectionLimit: 4, uri: CONFIG.databaseUrl });
  const dbHost = new URL(CONFIG.databaseUrl).hostname;
  if (!['127.0.0.1', 'localhost', '::1'].includes(dbHost)) throw new Error('The database must be local.');
  browser = await chromium.launch({ headless: !HEADED });
  try {
    if (RESUME) await resumeState();
    else {
      await seed();
      await saveState();
    }
    await runJourneys();
  } finally {
    evidence.finishedAt = new Date().toISOString();
    await saveEvidence();
    await browser.close().catch(() => {});
    await pool.end().catch(() => {});
  }
  const failed = evidence.journeys.filter((entry) => entry.status !== 'passed');
  log(`\n${evidence.journeys.length - failed.length}/${evidence.journeys.length} journeys passed. Evidence: ${path.relative(root, path.join(CONFIG.outputDir, 'evidence.json'))}`);
  process.exitCode = failed.length > 0 ? 1 : 0;
}

async function runJourneys() {
  await journey('J1', 'Brief: Draft questions from brief', ['AC-01'], j1DraftQuestions);
  await journey('J2', 'Discussion and the Odin summary (local fixture)', ['AC-02'], j2Discussion);
  await journey('J3', 'Decision rights: viewer, member, stakeholder, manager', ['AC-11', 'AC-15'], j3Decisions);
  await journey('J4', 'Packages: upload, rejection, preview, review origin', ['AC-03', 'AC-04', 'AC-05'], j4Packages);
  await journey('J5', 'Publish a round to two stakeholders and one member', ['AC-06'], j5Publish);
  await journey('J12', 'My open items for manager, member, viewer, and a reviewer before and after submit', ['AC-19'], j12MyOpenItems);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
