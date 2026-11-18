import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import JSZip from 'jszip';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createLocalFileStorage } from '../src/lib/files/file-storage.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectChangeLog } from '../src/modules/changes/project-change-log.js';
import { createInMemoryComplianceRepository } from '../src/modules/compliance/compliance.repository.js';
import { createInMemoryMailRepository } from '../src/modules/mail/mail.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemoryReportingRepository } from '../src/modules/reporting/reporting.repository.js';
import { refreshTenantSearchIndex } from '../src/modules/reporting/reporting.service.js';
import { fuseResults } from '../src/modules/reporting/search-index.repository.js';
import { htmlToText, splitPassages } from '../src/modules/reporting/search-text.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';
import { createInMemoryUsersRepository } from '../src/modules/users/users.repository.js';
import { createInMemoryWorkspaceModulesRepository } from '../src/modules/workspace-modules/workspace-modules.repository.js';
import { topicProvider } from './helpers/topic-embedding-provider.js';

// Semantic search: work items, comments and the text of files,
// found by meaning, on in-memory repositories through Odin's routes. A fake embedding provider
// stands in for OpenAI: each vector counts the words of a few topics, so texts on one topic are
// close whatever their wording, and texts with no topic words are far from everything.
// semantic-search-mysql.integration.test.js runs the storage and query on MySQL.

const TENANT_ID = 'tenant-acme';
const PAYROLL = 'project-payroll';
const SECRET = 'project-secret';
const USERS = {
  lead: { id: 'user-lead', name: 'Lena Lead', role: 'user' },
  outsider: { id: 'user-outsider', name: 'Oz Outsider', role: 'user' },
};
const email = (key) => `${USERS[key].id}@acme.example`;

const PROJECTS = [
  {
    epics: [{
      description: 'Everything about running the monthly pay cycle.',
      id: 'epic-pay',
      name: 'Pay cycle',
      status: 'In Progress',
      stories: [{
        description: 'The team gathers in Lisbon in May.',
        id: 'story-offsite',
        name: 'Plan the offsite',
        status: 'Not Started',
        tasks: [
          { assigneeName: 'Lena Lead', description: '<p>Book <strong>flights</strong> and a hotel near the venue.</p>', id: 'task-book', name: 'Book the logistics', status: 'Not Started' },
        ],
      }, {
        id: 'story-run',
        name: 'Run the monthly cycle',
        status: 'In Progress',
        tasks: [{ description: 'Wages go out on the 25th of each month.', id: 'task-calendar', name: 'Configure the run calendar', status: 'In Progress' }],
      }],
    }],
    id: PAYROLL,
    name: 'Northwind ops',
    status: 'In Progress',
    tenantId: TENANT_ID,
  },
  {
    epics: [{ description: 'Rotate every password after the breach.', id: 'epic-hidden', name: 'Hidden rotation', status: 'In Progress', stories: [] }],
    id: SECRET,
    name: 'Secret project',
    status: 'In Progress',
    tenantId: TENANT_ID,
  },
];

async function fixture(t, { provider = topicProvider() } = {}) {
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['acme.example'], id: TENANT_ID, name: 'Acme' }],
    users: Object.values(USERS).map((user) => ({ authMethod: 'basic', email: `${user.id}@acme.example`, id: user.id, memberships: [{ role: user.role, tenantId: TENANT_ID }], name: user.name, password: 'Fixture-password-123!', preferences: { twoFactorEnabled: false } })),
  });
  const root = await mkdtemp(path.join(os.tmpdir(), 'odin-semantic-search-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const storage = createLocalFileStorage({ rootDir: root });
  const lead = { email: email('lead'), id: USERS.lead.id, name: USERS.lead.name, role: 'admin' };
  const outsider = { email: email('outsider'), id: USERS.outsider.id, name: USERS.outsider.name, role: 'user' };
  const projectRepository = createInMemoryProjectsRepository({
    authRepository,
    changeLog: createInMemoryProjectChangeLog(),
    fileStorage: storage,
    mailRepository: createInMemoryMailRepository(),
    seed: { projectMemberships: { [PAYROLL]: [lead, outsider], [SECRET]: [lead] }, projects: structuredClone(PROJECTS) },
  });
  const reportingRepository = createInMemoryReportingRepository();
  const sessionsRepository = createInMemorySessionsRepository();
  const tokenService = createTokenService({ issuer: 'semantic-search-fixture', secret: 'disposable-semantic-search-fixture-secret' });
  const app = createApp({
    accessReviewCampaignSweepIntervalMs: 0, agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0, domainEventSweepIntervalMs: 0,
    changeSettleMs: 0, reportSubscriptionSweepIntervalMs: 0, reportingWarehouseSweepIntervalMs: 0, webhookSweepIntervalMs: 0, workflowAutomationSweepIntervalMs: 0,
    searchIndexMaxAgeMs: 1,
    ...(provider ? { searchEmbeddingProvider: provider } : {}),
    authRepository, complianceRepository: createInMemoryComplianceRepository(), fileStorage: storage, projectRepository, reportingRepository, sessionsRepository, tokenService,
    usersRepository: createInMemoryUsersRepository({ authRepository }), workspaceModulesRepository: createInMemoryWorkspaceModulesRepository(),
  });
  const http = createServer(app);
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${http.address().port}`;
  t.after(async () => {
    await app.locals.beginDrain({ timeoutMs: 1000 });
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  });
  const tokens = {};
  for (const [key, user] of Object.entries(USERS)) {
    const token = tokenService.signSessionToken({ email: email(key), id: user.id, name: user.name, preferences: {}, role: user.role, tenantId: TENANT_ID });
    await sessionsRepository.createSession({ expiryDate: new Date(Date.now() + 3600_000), ipAddr: '127.0.0.1', locationName: 'Loopback', token, userAgent: 'fixture', userId: user.id });
    tokens[key] = token;
  }
  async function ok(as, method, route, body, status = 200) {
    const response = await fetch(`${origin}${route}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Authorization: `Bearer ${tokens[as]}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      method,
    });
    const payload = await response.json().catch(() => null);
    assert.equal(response.status, status, `${method} ${route}: ${JSON.stringify(payload)}`);
    return payload;
  }
  const search = (as, query, extra = '') => ok(as, 'GET', `/api/reporting/search?query=${encodeURIComponent(query)}${extra}`);
  const comment = async (as, projectId, targetType, targetId, text) => (await ok(as, 'POST', `/api/projects/${projectId}/comments`, { comment: text, targetId, targetType }, 201)).comment;
  const userOf = (key) => ({ email: email(key), id: USERS[key].id, name: USERS[key].name });
  const saveFile = (projectId, { bytes, fileName, fileType = 'text/plain', targetId = projectId, targetType = 'project' }) => projectRepository.saveFile({
    fileContentsBase64: Buffer.from(bytes).toString('base64'), fileDescription: '', fileName, fileType, projectId, targetId, targetType, tenantId: TENANT_ID, user: userOf('lead'),
  });
  return { app, comment, ok, projectRepository, provider, reportingRepository, saveFile, search };
}

// --- text helpers -----------------------------------------------------------------------------

test('rich text reads as plain words, and long text splits into overlapping passages at breaks', () => {
  assert.equal(htmlToText('<p>Book <strong>flights</strong> &amp; a hotel</p><ul><li>One</li><li>Two&#39;s</li></ul>@[Lena Lead](user:u-1) agrees'), 'Book flights & a hotel\nOne\nTwo\'s\n@Lena Lead agrees');
  assert.deepEqual(splitPassages('short'), ['short']);
  assert.deepEqual(splitPassages(''), []);
  const words = Array.from({ length: 2000 }, (_, index) => `word${index}`).join(' ');
  const passages = splitPassages(words, { overlap: 100, size: 1000 });
  assert.ok(passages.length > 10);
  assert.ok(passages.every((passage) => passage.length <= 1000));
  assert.ok(passages.every((passage) => /^word\d+/.test(passage) && /word\d+$/.test(passage)), 'passages end at a space, never mid-word');
  assert.ok(passages[1].startsWith(passages[0].split(' ').at(-8)) || passages[0].includes(passages[1].split(' ')[0]), 'each passage overlaps the one before');
});

test('fusion ranks rows found both ways first, and collapses the passages of one source', () => {
  const row = (sourceId, documentType = 'file') => ({ content: sourceId, documentType, id: `id-${sourceId}`, sourceId, title: sourceId, updatedAt: '2026-11-01T00:00:00.000Z' });
  const result = fuseResults({
    lexical: [{ document: row('file-a#3'), lexicalScore: 4 }, { document: row('task-b', 'task'), lexicalScore: 2 }],
    limit: 10,
    offset: 0,
    semantic: [{ document: row('file-a'), similarity: 0.71 }, { document: row('file-a#2'), similarity: 0.5 }, { document: row('task-c', 'task'), similarity: 0.42 }],
  });
  assert.deepEqual(result.records.map((record) => [record.sourceId, record.retrievalMode]), [['file-a', 'hybrid'], ['task-b', 'lexical'], ['task-c', 'semantic']]);
  assert.equal(result.total, 3);
  assert.equal(result.records[0].semanticScore, 0.71);
  assert.equal(result.records[0].lexicalScore, 4);

  // A long file's many weak passages count once: they don't outrank one strong match.
  const crowded = fuseResults({
    limit: 10,
    offset: 0,
    semantic: [{ document: row('task-strong', 'task'), similarity: 0.99 }, ...[1, 2, 3, 4].map((n) => ({ document: row(`file-long#${n + 1}`), similarity: 0.31 }))],
  });
  assert.deepEqual(crowded.records.map((record) => record.sourceId), ['task-strong', 'file-long#2']);
});


test('a search by meaning finds a work item that shares none of its words, and links to the item', async (t) => {
  const { search } = await fixture(t);
  // The offsite story and its booking task are both about travel; nothing else is.
  const found = await search('lead', 'journey');
  assert.deepEqual(found.records.map((record) => record.sourceId).sort(), ['story-offsite', 'task-book']);
  const task = found.records.find((record) => record.sourceId === 'task-book');
  assert.equal(task.retrievalMode, 'semantic');
  assert.equal(task.url, `/projects/${PAYROLL}?item=task-book`);
  assert.match(task.content, /Task in Northwind ops, under Pay cycle › Plan the offsite\nBook flights and a hotel near the venue\.\nStatus: Not Started · Assignee: Lena Lead/);
  // The weather topic matches nothing.
  assert.deepEqual((await search('lead', 'snow')).records, []);
});

test('without an embedding provider the same search falls back to words', async (t) => {
  const { search } = await fixture(t, { provider: null });
  assert.deepEqual((await search('lead', 'journey')).records, []);
  const byWord = await search('lead', 'hotel');
  assert.deepEqual(byWord.records.map((record) => [record.sourceId, record.retrievalMode]), [['task-book', 'lexical']]);
});


test('a comment is found by its text, names its author and item, and links to the item; others\' projects stay hidden', async (t) => {
  const { comment, search } = await fixture(t);
  const posted = await comment('lead', PAYROLL, 'story', 'story-offsite', '<p>Can we fly out on <em>Sunday</em>? The <strong>flight</strong> on Monday is full.</p>');
  await comment('lead', SECRET, 'epic', 'epic-hidden', 'The login credentials leaked again.');
  await comment('lead', PAYROLL, 'project', PAYROLL, 'Payday moves to Friday this quarter.');

  const lead = await search('lead', 'trip', '&types=comment');
  assert.deepEqual(lead.records.map((record) => record.sourceId), [posted.id]);
  assert.equal(lead.records[0].title, 'Lena Lead on Plan the offsite');
  assert.equal(lead.records[0].url, `/projects/${PAYROLL}?item=story-offsite`);
  assert.match(lead.records[0].content, /^Can we fly out on Sunday\? The flight on Monday is full\.\nComment on the story Plan the offsite in Northwind ops$/);
  assert.equal(lead.records[0].facets.author, 'Lena Lead');

  const onProject = await search('lead', 'salary', '&types=comment');
  assert.deepEqual(onProject.records.map((record) => [record.title, record.url]), [['Lena Lead on Northwind ops', `/projects/${PAYROLL}`]]);

  // The outsider is not on the secret project: neither its comment nor its epic shows.
  assert.equal((await search('lead', 'password')).records.length, 2);
  assert.deepEqual((await search('outsider', 'password')).records, []);
});


async function workbook(rows) {
  const zip = new JSZip();
  zip.file('xl/workbook.xml', '<workbook xmlns:r="r"><sheets><sheet name="Plan" sheetId="1" r:id="rId1"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>');
  zip.file('xl/worksheets/sheet1.xml', `<worksheet><sheetData>${rows.map((cells) => `<row>${cells.map((cell) => `<c t="inlineStr"><is><t>${cell}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('the text of files is found by meaning or words, a long file shows the passage that matched, and a damaged one is still found by name', async (t) => {
  const { projectRepository, reportingRepository, saveFile, search } = await fixture(t);
  const filler = (count) => Array.from({ length: count }, (_, index) => `Line ${index} of the general handbook covers office matters.`).join('\n');
  const handbook = await saveFile(PAYROLL, { bytes: `${filler(150)}\nThe zeppelin hangar opens at dawn.\n${filler(150)}`, fileName: 'handbook.txt' });
  const sheet = await saveFile(PAYROLL, { bytes: await workbook([['Item', 'Owner'], ['Salaries review', 'Finance']]), fileName: 'budget.xlsx', fileType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', targetId: 'task-calendar', targetType: 'task' });
  const damaged = await saveFile(PAYROLL, { bytes: 'not really a document', fileName: 'contract-draft.docx', fileType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

  // Words deep inside a long file: one result, its passage, linked to the project.
  const deep = await search('lead', 'zeppelin');
  assert.deepEqual(deep.records.map((record) => [record.title, record.retrievalMode]), [['handbook.txt', 'lexical']]);
  assert.match(deep.records[0].content, /The zeppelin hangar opens at dawn\./);
  assert.ok(deep.records[0].sourceId.startsWith(`${handbook.id}#`), 'the passage, not the start of the file');
  assert.equal(deep.records[0].url, `/projects/${PAYROLL}`);
  assert.equal(deep.records[0].facets.fileId, handbook.id);

  // A spreadsheet's cells, by meaning: it is on a task, so it opens the task.
  const byMeaning = await search('lead', 'paycheck', '&types=file');
  assert.deepEqual(byMeaning.records.map((record) => [record.title, record.retrievalMode, record.url]), [['budget.xlsx', 'semantic', `/projects/${PAYROLL}?item=task-calendar`]]);
  assert.match(byMeaning.records[0].content, /Task Configure the run calendar · Northwind ops\n\n--- Sheet: Plan ---\nItem \| Owner\nSalaries review \| Finance/);

  // A damaged file: its name still finds it, and its cached text says why there is none.
  assert.deepEqual((await search('lead', 'contract')).records.map((record) => record.sourceId), [damaged.id]);
  const texts = await reportingRepository.listSearchFileTexts({ tenantId: TENANT_ID });
  assert.deepEqual(texts.find((entry) => entry.fileId === damaged.id), { ...texts.find((entry) => entry.fileId === damaged.id), reason: 'corrupt', status: 'failed' });
  assert.equal(texts.find((entry) => entry.fileId === sheet.id).status, 'ok');

  // Direct-message and ticket files are never sources.
  projectRepository.state.files.push({ ...projectRepository.state.files.at(-1), id: 'file-dm', targetType: 'dm' }, { ...projectRepository.state.files.at(-1), id: 'file-ticket', targetType: 'ticket' });
  const sources = await projectRepository.listSearchFileSources({ tenantId: TENANT_ID });
  assert.deepEqual(sources.map((file) => file.id).filter((id) => ['file-dm', 'file-ticket'].includes(id)), []);
});


async function indexFixture(provider) {
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['acme.example'], id: TENANT_ID, name: 'Acme' }],
    users: [{ authMethod: 'basic', email: email('lead'), id: USERS.lead.id, memberships: [{ role: 'admin', tenantId: TENANT_ID }], name: USERS.lead.name, password: 'Fixture-password-123!', preferences: { twoFactorEnabled: false } }],
  });
  const projectRepository = createInMemoryProjectsRepository({ authRepository, seed: { projectMemberships: {}, projects: structuredClone(PROJECTS) } });
  const repository = createInMemoryReportingRepository();
  const writes = [];
  const apply = repository.applySearchChanges;
  repository.applySearchChanges = async (input) => {
    writes.push({ deletes: input.deletes.map((key) => key.sourceId), upserts: input.upserts.map((document) => document.sourceId) });
    return apply(input);
  };
  const refresh = (withProvider = provider) => refreshTenantSearchIndex({ dependencies: { projectRepository, searchEmbeddingProvider: withProvider }, repository, tenantId: TENANT_ID });
  return { projectRepository, refresh, repository, writes };
}

test('a refresh with nothing changed writes nothing; an edit embeds one row; a deletion removes its row', async () => {
  const provider = topicProvider();
  const { projectRepository, refresh, repository, writes } = await indexFixture(provider);
  const first = await refresh();
  assert.equal(first.changed, first.indexed);
  assert.equal(provider.calls.batches.flat().length, first.indexed);

  const again = await refresh();
  assert.deepEqual([again.changed, again.deleted, again.semanticIndexed], [0, 0, 0]);
  assert.deepEqual(writes.at(-1), { deletes: [], upserts: [] });

  projectRepository.state.projects[0].epics[0].stories[1].tasks[0].description = 'Wages now go out on the 20th.';
  const edited = await refresh();
  assert.deepEqual([edited.changed, edited.semanticIndexed], [1, 1]);
  assert.deepEqual(writes.at(-1).upserts, ['task-calendar']);
  assert.deepEqual(provider.calls.batches.at(-1), ['Configure the run calendar']);

  projectRepository.state.projects[0].epics[0].stories[0].tasks.splice(0, 1);
  await refresh();
  assert.deepEqual(writes.at(-1), { deletes: ['task-book'], upserts: [] });
  assert.equal((await repository.listDocumentManifests({ tenantId: TENANT_ID })).some((row) => row.sourceId === 'task-book'), false);
});

test('a new embedding model embeds every row again; until then a row matches by words only', async () => {
  const small = topicProvider({ model: 'fake-small' });
  const { refresh, repository } = await indexFixture(small);
  const first = await refresh();

  // The new model is down: nothing is rewritten, so every row keeps its old embedding, and a
  // query in the new model's space finds rows by words only.
  const down = topicProvider({ failing: true, model: 'fake-large' });
  const failed = await refresh(down);
  assert.deepEqual([failed.changed, failed.semanticStatus], [0, 'unavailable']);
  assert.ok((await repository.listDocumentManifests({ tenantId: TENANT_ID })).every((row) => row.embeddingModel === 'fake-small'));
  const large = topicProvider({ model: 'fake-large' });
  const queryEmbedding = await large.embed({ content: 'hotel', tenantId: TENANT_ID, title: 'Search' });
  const before = await repository.searchDocuments({ limit: 10, offset: 0, projectIds: [PAYROLL], query: 'hotel', queryEmbedding, tenantId: TENANT_ID, types: [] });
  assert.deepEqual(before.records.map((record) => [record.sourceId, record.retrievalMode]), [['task-book', 'lexical']]);

  // Once the new model answers, every row is embedded again in it.
  const moved = await refresh(large);
  assert.equal(moved.semanticIndexed, first.indexed);
  assert.ok((await repository.listDocumentManifests({ tenantId: TENANT_ID })).every((row) => row.embeddingModel === 'fake-large'));
  const after = await repository.searchDocuments({ limit: 10, offset: 0, projectIds: [PAYROLL], query: 'hotel', queryEmbedding, tenantId: TENANT_ID, types: [] });
  assert.equal(after.records[0].retrievalMode, 'hybrid');
});
