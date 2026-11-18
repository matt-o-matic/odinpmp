import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { settleForAxe } from './fixtures/axe-settle.js';
import { authenticateSyntheticUser, installSyntheticApi, openPhoneMenu, syntheticProject, syntheticUser } from './fixtures/synthetic-api.js';

const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];

async function expectAccessible(page, testInfo, name) {
  await settleForAxe(page);
  const results = await new AxeBuilder({ page }).include('#main-content').withTags(wcagTags).analyze();
  await testInfo.attach(`axe-${name}.json`, { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' });
  expect(results.violations, `${name}: ${results.violations.map((violation) => violation.id).join(', ')}`).toEqual([]);
}

async function expectAccessibleDialog(page, testInfo, name) {
  await settleForAxe(page);
  const results = await new AxeBuilder({ page }).include('dialog[open]').withTags(wcagTags).analyze();
  await testInfo.attach(`axe-${name}.json`, { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' });
  expect(results.violations, `${name}: ${results.violations.map((violation) => violation.id).join(', ')}`).toEqual([]);
}

async function expectNoHorizontalOverflow(page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

async function openAccountMenuLink(page, name) {
  if (!await page.getByRole('button', { name: 'Account menu' }).isVisible()) await openPhoneMenu(page);
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('link', { name, exact: true }).click();
}

function seedMemories() {
  const base = { confidence: 1, createdAt: '2026-10-01T12:00:00.000Z', createdBy: syntheticUser.id, deletedAt: null, expiresAt: null, freshnessAt: null, legalHold: false, retentionPolicyId: null, sensitivity: 'internal', sourceAt: '2026-10-01T12:00:00.000Z', version: 1 };
  const memories = [
    { ...base, confidence: 0.9, content: 'We chose Northwind as the launch vendor because of its EU data centre.', createdAt: '2026-10-08T12:00:00.000Z', id: 'memory-vendor', memoryType: 'decision', projectId: syntheticProject.id, provenance: { sourceId: 'D-07', sourceType: 'decision_register', sourceUrl: 'https://example.com/decisions/D-07' }, sourceAt: '2026-10-08T12:00:00.000Z', title: 'Launch vendor decision' },
    { ...base, content: 'Approved and applied assistant changes:\n- work_item_delete: Stale task', createdAt: '2026-10-07T12:00:00.000Z', freshnessAt: '2026-10-07T12:00:00.000Z', id: 'memory-outcome', memoryType: 'outcome', projectId: syntheticProject.id, provenance: { sourceId: 'session-42', sourceType: 'approved_assistant_run' }, sourceAt: '2026-10-07T12:00:00.000Z', title: 'Approved assistant changes' },
    { ...base, content: 'The signed contract is evidence in the supplier dispute.', createdAt: '2026-10-06T12:00:00.000Z', createdBy: 'someone-else', id: 'memory-held', legalHold: true, memoryType: 'fact', projectId: syntheticProject.id, provenance: { sourceId: 'case-9', sourceType: 'legal_case' }, retentionPolicyId: 'case-9', sensitivity: 'confidential', sourceAt: '2026-10-06T12:00:00.000Z', title: 'Supplier contract evidence', version: 4 },
    { ...base, content: 'Keep status summaries to five bullet points.', createdAt: '2026-10-05T12:00:00.000Z', id: 'memory-personal', memoryType: 'preference', projectId: null, provenance: { sourceType: 'person' }, sourceAt: '2026-10-05T12:00:00.000Z', title: 'Prefers short summaries' },
  ];
  for (let index = 1; index <= 26; index += 1) {
    const day = String(index).padStart(2, '0');
    memories.push({ ...base, content: `Retro note ${index}.`, createdAt: `2026-09-${day}T12:00:00.000Z`, id: `memory-note-${index}`, memoryType: 'episode', projectId: syntheticProject.id, provenance: { sourceType: 'retrospective' }, sourceAt: `2026-09-${day}T12:00:00.000Z`, title: `Retro note ${index}` });
  }
  return memories;
}

async function installMemoryApi(page, { admin = false } = {}) {
  const memories = seedMemories();
  const calls = [];
  const browseQueries = [];
  const decorate = (memory) => ({ ...memory, canCorrect: !memory.legalHold, canForget: !memory.legalHold, projectName: memory.projectId ? syntheticProject.name : '' });
  const json = (route, body, status = 200) => route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status });
  await page.route('http://localhost:3001/api/agent-memory**', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const body = request.postDataJSON?.() ?? null;
    if (method !== 'GET') calls.push({ body, method, path: url.pathname });
    if (method === 'GET' && url.pathname === '/api/agent-memory/browse') {
      const params = Object.fromEntries(url.searchParams);
      browseQueries.push(params);
      const types = params.types ? params.types.split(',') : [];
      const sensitivities = params.sensitivities ? params.sensitivities.split(',') : [];
      const query = (params.query ?? '').toLowerCase();
      const matches = memories
        .filter((memory) => !memory.deletedAt)
        .filter((memory) => !params.project || (params.project === 'personal' ? !memory.projectId : memory.projectId === params.project))
        .filter((memory) => !types.length || types.includes(memory.memoryType))
        .filter((memory) => !sensitivities.length || sensitivities.includes(memory.sensitivity))
        .filter((memory) => !query || `${memory.title} ${memory.content}`.toLowerCase().includes(query))
        .sort((left, right) => right.sourceAt.localeCompare(left.sourceAt));
      const limit = Number(params.limit ?? 25); const offset = Number(params.offset ?? 0);
      return json(route, { limit, memories: matches.slice(offset, offset + limit).map(decorate), offset, ok: true, permissions: { canGovern: admin, editableProjectIds: [syntheticProject.id] }, total: matches.length });
    }
    if (method === 'POST' && url.pathname === '/api/agent-memory') {
      const memory = { ...body, createdAt: '2026-10-09T12:00:00.000Z', createdBy: syntheticUser.id, deletedAt: null, expiresAt: null, freshnessAt: null, id: 'memory-new', legalHold: false, retentionPolicyId: null, version: 1 };
      memories.push(memory);
      return json(route, { embeddingStatus: 'disabled', memory, ok: true }, 201);
    }
    if (method === 'POST' && url.pathname === '/api/agent-memory/purge-expired') return json(route, { ok: true, purgedCount: 2 });
    const id = url.pathname.split('/')[3];
    const memory = memories.find((item) => item.id === id);
    if (!memory) return json(route, { error: 'Memory not found.' }, 404);
    if (method === 'PATCH' && url.pathname.endsWith('/governance')) {
      Object.assign(memory, { expiresAt: body.expiresAt, legalHold: body.legalHold, retentionPolicyId: body.retentionPolicyId, version: memory.version + 1 });
      return json(route, { memory, ok: true });
    }
    if (method === 'PATCH') {
      const { expectedVersion, ...changes } = body;
      Object.assign(memory, changes, { provenance: { ...memory.provenance, corrections: [{ at: '2026-10-09T12:00:00.000Z', by: syntheticUser.id, fields: Object.keys(changes) }] }, version: expectedVersion + 1 });
      return json(route, { embeddingStatus: 'disabled', memory, ok: true });
    }
    if (method === 'DELETE') {
      memory.deletedAt = '2026-10-09T12:00:00.000Z';
      return json(route, { forgottenMemoryId: id, ok: true, version: memory.version + 1 });
    }
    return json(route, { error: 'Unexpected memory request.' }, 501);
  });
  return { browseQueries, calls };
}

test('a project editor browses, filters, teaches, corrects, and forgets AI memory', async ({ page }, testInfo) => {
  // One journey with five axe scans; a single worker on a busy machine needs more than the default 30s.
  test.setTimeout(90_000);
  const api = await installSyntheticApi(page);
  const memory = await installMemoryApi(page);
  await authenticateSyntheticUser(page);
  await page.goto('projects');
  await openAccountMenuLink(page, 'What the AI remembers');
  await expect(page).toHaveURL(/\/ai-memory$/);
  await expect(page.getByRole('heading', { name: 'What the AI remembers', level: 1 })).toBeVisible();
  await expect(page.getByText('Showing 1–25 of 30')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Purge expired' })).toHaveCount(0);

  const vendor = page.getByRole('listitem').filter({ has: page.getByRole('button', { name: 'Launch vendor decision' }) });
  await expect(vendor).toContainText('Decision');
  await expect(vendor).toContainText(syntheticProject.name);
  await expect(vendor).toContainText('Decision register');
  await expect(vendor).toContainText('Confidence 90%');
  await expectAccessible(page, testInfo, 'memory-list');
  await expectNoHorizontalOverflow(page);

  // Expanding shows the content and where it came from.
  const vendorToggle = page.getByRole('button', { name: 'Launch vendor decision' });
  await vendorToggle.click();
  await expect(vendorToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(vendor).toContainText('EU data centre');
  await expect(vendor.getByRole('link', { name: 'Open source (opens in a new tab)' })).toHaveAttribute('href', 'https://example.com/decisions/D-07');
  await page.getByRole('button', { name: 'Approved assistant changes' }).click();
  const conversation = page.getByRole('link', { name: 'Open the AI Workspace conversation' });
  await expect(conversation).toHaveAttribute('href', new RegExp(`/projects/${syntheticProject.id}\\?assistant=1&assistantSessionId=session-42`));

  // A held memory explains why it can't be changed.
  await page.getByRole('button', { name: 'Supplier contract evidence' }).click();
  const held = page.getByRole('listitem').filter({ has: page.getByRole('button', { name: 'Supplier contract evidence' }) });
  await expect(held.getByText('Legal hold', { exact: true })).toBeVisible();
  await expect(held.getByRole('button', { name: 'Forget' })).toBeDisabled();
  await expect(held.getByRole('button', { name: 'Correct' })).toBeDisabled();
  await expect(held.getByRole('button', { name: 'Forget' })).toHaveAccessibleDescription(/legal hold/);
  await expect(held.getByRole('button', { name: 'Retention' })).toHaveCount(0);
  await expectAccessible(page, testInfo, 'memory-expanded');
  await page.screenshot({ fullPage: true, path: testInfo.outputPath('memory-list-light.png') });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await expectAccessible(page, testInfo, 'memory-expanded-dark');
  await page.screenshot({ fullPage: true, path: testInfo.outputPath('memory-list-dark.png') });
  await page.evaluate(() => document.documentElement.classList.remove('dark'));

  // Pagination and filters.
  const filters = page.getByRole('search', { name: 'Filter memories' });
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('Showing 26–30 of 30')).toBeVisible();
  await expect(page).toHaveURL(/page=2/);
  expect(memory.browseQueries.at(-1)).toMatchObject({ limit: '25', offset: '25' });
  await filters.getByLabel('Type').selectOption('preference');
  await filters.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('Showing 1–1 of 1')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Prefers short summaries' })).toBeVisible();
  expect(memory.browseQueries.at(-1)).toMatchObject({ offset: '0', types: 'preference' });
  await filters.getByLabel('Search').fill('nothing like this');
  await filters.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('No memories match these filters.')).toBeVisible();
  await filters.getByRole('button', { name: 'Clear' }).click();
  await expect(page.getByText('Showing 1–25 of 30')).toBeVisible();

  // Teach the AI something new.
  await page.getByRole('button', { name: 'Add memory' }).click();
  const addDialog = page.getByRole('dialog', { name: 'Add memory' });
  await expect(addDialog.getByLabel('Title')).toBeFocused();
  await addDialog.getByRole('button', { name: 'Add memory' }).click();
  await expect(addDialog.getByText('Give the memory a short title.')).toBeVisible();
  await addDialog.getByLabel('Title').fill('Release day');
  await expect(addDialog.getByText('Give the memory a short title.')).toBeHidden();
  await addDialog.getByLabel('What the AI should remember').fill('We release on Tuesdays after the change board.');
  await addDialog.getByLabel('Type').selectOption('decision');
  await addDialog.getByLabel('Applies to').selectOption(syntheticProject.id);
  await expectAccessibleDialog(page, testInfo, 'memory-add-dialog');
  await page.screenshot({ path: testInfo.outputPath('memory-add-dialog.png') });
  await addDialog.getByRole('button', { name: 'Add memory' }).click();
  await expect(addDialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'Memory added.' })).toBeVisible();
  const created = memory.calls.find((call) => call.method === 'POST' && call.path === '/api/agent-memory').body;
  expect(created).toMatchObject({ confidence: 1, content: 'We release on Tuesdays after the change board.', memoryType: 'decision', projectId: syntheticProject.id, provenance: { sourceType: 'person' }, sensitivity: 'internal', title: 'Release day' });

  // Correct sends only the changed fields with the loaded version.
  const releaseToggle = page.getByRole('button', { name: 'Release day' });
  await expect(releaseToggle).toHaveAttribute('aria-expanded', 'true');
  const release = page.getByRole('listitem').filter({ has: releaseToggle });
  await release.getByRole('button', { name: 'Correct' }).click();
  const correctDialog = page.getByRole('dialog', { name: 'Correct memory' });
  await correctDialog.getByLabel('What the AI should remember').fill('We release on Wednesdays after the change board.');
  const confidence = correctDialog.getByLabel('Confidence (%)');
  await expect(confidence).toHaveValue('100');
  await expect(confidence).toHaveAccessibleDescription(/100 means certain/);
  await confidence.fill('150');
  await correctDialog.getByRole('button', { name: 'Save correction' }).click();
  await expect(correctDialog.getByText('Enter a whole number from 0 to 100.')).toBeVisible();
  await expect(confidence).toHaveAttribute('aria-invalid', 'true');
  await confidence.fill('75');
  await expectAccessibleDialog(page, testInfo, 'memory-correct-dialog');
  await page.screenshot({ path: testInfo.outputPath('memory-correct-dialog.png') });
  await correctDialog.getByRole('button', { name: 'Save correction' }).click();
  await expect(correctDialog).toBeHidden();
  expect(memory.calls.find((call) => call.method === 'PATCH').body).toEqual({ confidence: 0.75, content: 'We release on Wednesdays after the change board.', expectedVersion: 1 });
  await expect(release).toContainText('Corrected once, last by you');
  await expect(release).toContainText('Confidence 75%');

  // Forget asks first, in an app dialog.
  await release.getByRole('button', { name: 'Forget' }).click();
  const forgetDialog = page.getByRole('dialog', { name: 'Forget this memory?' });
  await expect(forgetDialog).toContainText('The AI will stop using “Release day”');
  await forgetDialog.getByRole('button', { name: 'Forget' }).click();
  await expect(forgetDialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'Forgot “Release day”.' })).toBeVisible();
  expect(memory.calls.find((call) => call.method === 'DELETE')).toEqual({ body: { expectedVersion: 2 }, method: 'DELETE', path: '/api/agent-memory/memory-new' });
  await expect(page.getByRole('button', { name: 'Release day' })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  api.assertNoUnexpectedRequests();
});

test('an admin sets retention and purges expired memory; a project link pre-filters the list', async ({ page }, testInfo) => {
  const api = await installSyntheticApi(page, { admin: true });
  const memory = await installMemoryApi(page, { admin: true });
  await authenticateSyntheticUser(page);
  await page.goto(`ai-memory?project=${syntheticProject.id}`);
  await expect(page.getByRole('search', { name: 'Filter memories' }).getByLabel('Project')).toHaveValue(syntheticProject.id);
  await expect(page.getByText('Showing 1–25 of 29')).toBeVisible();
  expect(memory.browseQueries[0]).toMatchObject({ project: syntheticProject.id });

  await page.getByRole('button', { name: 'Launch vendor decision' }).click();
  const vendor = page.getByRole('listitem').filter({ has: page.getByRole('button', { name: 'Launch vendor decision' }) });
  await vendor.getByRole('button', { name: 'Retention' }).click();
  const retention = page.getByRole('dialog', { name: 'Retention' });
  await retention.getByLabel('Legal hold').check();
  await retention.getByLabel('Expires on').fill('2027-03-31');
  await retention.getByLabel('Retention policy reference').fill('case-12');
  await expectAccessibleDialog(page, testInfo, 'memory-retention-dialog');
  await retention.getByRole('button', { name: 'Save retention' }).click();
  await expect(retention).toBeHidden();
  expect(memory.calls.find((call) => call.path.endsWith('/governance')).body).toEqual({ expectedVersion: 1, expiresAt: '2027-03-31T23:59:59.999Z', legalHold: true, retentionPolicyId: 'case-12' });
  await expect(vendor.getByText('Legal hold', { exact: true })).toBeVisible();
  await expect(vendor.getByRole('button', { name: 'Forget' })).toBeDisabled();

  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.getByRole('button', { name: 'Purge expired' }).click();
  const purge = page.getByRole('dialog', { name: 'Purge expired memories?' });
  await expect(purge).toContainText('Memories on legal hold are kept.');
  await expectAccessibleDialog(page, testInfo, 'memory-purge-dialog-dark');
  await page.screenshot({ path: testInfo.outputPath('memory-purge-dark.png') });
  await purge.getByRole('button', { name: 'Purge expired' }).click();
  await expect(purge).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'Purged 2 expired memories.' })).toBeVisible();
  await expectAccessible(page, testInfo, 'memory-admin-dark');
  await expectNoHorizontalOverflow(page);
  api.assertNoUnexpectedRequests();
});
