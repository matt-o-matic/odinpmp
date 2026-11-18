import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { NO_PREVIEW, previewFormatOf, previewStorageKeyFor } from '../src/lib/files/file-preview.js';
import { createSofficeConverter, findExecutable } from '../src/lib/files/soffice-converter.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectChangeLog } from '../src/modules/changes/project-change-log.js';
import { createInMemoryComplianceRepository } from '../src/modules/compliance/compliance.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';
import { createFilePreviewProcessor } from '../src/modules/vault/file-preview-worker.js';
import { inlineFramePolicy } from '../src/modules/vault/large-files.routes.js';
import { createMemoryLargeFileStorage } from './helpers/large-file-fixtures.js';

// File previews: what preview-url returns for each kind of file and who may ask, and the preview
// worker against a fake soffice (a Node script) that converts, fails, writes nothing, or hangs.
// file-previews-soffice.integration.test.js converts real files with LibreOffice.

const TENANT_ID = 'tenant-acme';
const PROJECT = 'project-1';
const OTHER_PROJECT = 'project-2';
const P = `/api/projects/${PROJECT}`;
const USERS = {
  admin: { id: 'user-admin', role: 'admin' },
  member: { id: 'user-member', role: 'user' },
  outsider: { id: 'user-outsider', role: 'user' },
  viewer: { id: 'user-viewer', role: 'user' },
};
const vault = { targetId: PROJECT, targetType: 'project' };
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

async function fixture(t, { filePreviews = null, previewMaxBytes } = {}) {
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['acme.example'], id: TENANT_ID, name: 'Acme' }],
    users: Object.values(USERS).map((user) => ({ authMethod: 'basic', email: `${user.id}@acme.example`, id: user.id, memberships: [{ role: user.role, tenantId: TENANT_ID }], name: user.id, password: 'Fixture-password-123!', preferences: { twoFactorEnabled: false } })),
  });
  const storage = createMemoryLargeFileStorage();
  const projectRepository = createInMemoryProjectsRepository({
    authRepository,
    changeLog: createInMemoryProjectChangeLog(),
    fileStorage: storage,
    seed: {
      projectMemberships: {
        [OTHER_PROJECT]: [{ id: USERS.outsider.id, role: 'user' }],
        [PROJECT]: [{ id: USERS.member.id, role: 'user' }, { id: USERS.viewer.id, role: 'viewer' }],
      },
      projects: [
        { epics: [], id: PROJECT, name: 'One', status: 'In Progress', tenantId: TENANT_ID },
        { epics: [], id: OTHER_PROJECT, name: 'Two', status: 'In Progress', tenantId: TENANT_ID },
      ],
    },
  });
  const sessionsRepository = createInMemorySessionsRepository();
  const tokenService = createTokenService({ issuer: 'file-previews-fixture', secret: 'disposable-file-previews-secret' });
  const published = [];
  const liveEventBus = { publish: (channel, event) => published.push({ channel, event }), subscribe: () => () => {} };
  const app = createApp({
    accessReviewCampaignSweepIntervalMs: 0, agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0, domainEventSweepIntervalMs: 0,
    changeSettleMs: 0, frontendAppUrl: 'https://app.example/app', reportSubscriptionSweepIntervalMs: 0, reportingWarehouseSweepIntervalMs: 0, webhookSweepIntervalMs: 0, workflowAutomationSweepIntervalMs: 0,
    authRepository, complianceRepository: createInMemoryComplianceRepository(), fileStorage: storage, projectRepository, sessionsRepository, tokenService,
    ...(filePreviews ? { filePreviews } : {}),
    ...(previewMaxBytes ? { previewMaxBytes } : {}),
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
    const token = tokenService.signSessionToken({ email: `${user.id}@acme.example`, id: user.id, name: user.id, preferences: {}, role: user.role, tenantId: TENANT_ID });
    await sessionsRepository.createSession({ expiryDate: new Date(Date.now() + 3600_000), ipAddr: '127.0.0.1', locationName: 'Loopback', token, userAgent: 'fixture', userId: user.id });
    tokens[key] = token;
  }
  const absolute = (url) => (url.startsWith('http') ? url : `${origin}${url}`);
  async function send(as, method, route, body) {
    const response = await fetch(absolute(route), { body: body === undefined ? undefined : JSON.stringify(body), headers: { Authorization: `Bearer ${tokens[as]}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, method });
    return { body: await response.json().catch(() => null), status: response.status };
  }
  async function upload(fileName, fileType, contents) {
    const response = await send('member', 'POST', `${P}/files`, { fileContentsBase64: Buffer.from(contents).toString('base64'), fileName, fileType, ...vault });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.file;
  }
  async function newVersion(file, contents) {
    const response = await send('member', 'POST', `${P}/files/${file.id}/versions`, { expectedVersion: file.version, fileContentsBase64: Buffer.from(contents).toString('base64'), fileName: file.fileName, fileType: file.contentType });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.file;
  }
  const preview = (as, fileId, version = null) => send(as, 'GET', `${P}/files/${fileId}/preview-url${version ? `?version=${version}` : ''}`);
  const fetchUrl = (url, init) => fetch(absolute(url), init);
  return { fetchUrl, liveEventBus, newVersion, preview, projectRepository, published, send, storage, upload };
}

// A stand-in for soffice: it does what the file it is given says. Each run is logged with its
// arguments, environment and pid.
const FAKE_SOFFICE = `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify('__LOG__')}, JSON.stringify({ args, env: process.env, pid: process.pid }) + '\\n');
const input = args.at(-1);
const outdir = args[args.indexOf('--outdir') + 1];
const contents = readFileSync(input, 'utf8');
if (contents.startsWith('HANG')) setInterval(() => {}, 1000);
else if (contents.startsWith('FAIL')) { process.stderr.write('Error: source file could not be loaded'); process.exit(1); }
else if (contents.startsWith('SILENT')) process.exit(0);
else writeFileSync(path.join(outdir, path.parse(input).name + '.pdf'), '%PDF-1.4 converted ' + contents);
`;

async function fakeSoffice(t, { timeoutMs = 5000 } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'odin-fake-soffice-'));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const log = path.join(dir, 'calls.log');
  const script = path.join(dir, 'soffice.mjs');
  await writeFile(script, FAKE_SOFFICE.replace('__LOG__', log.replaceAll('\\', '\\\\')));
  await chmod(script, 0o755);
  // The script is the program the converter finds; Node runs it.
  const converter = createSofficeConverter({ sofficePath: script, spawnImpl: (command, args, options) => spawn(process.execPath, [command, ...args], options), timeoutMs });
  const calls = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { calls, converter, dir };
}

test('preview kinds follow the type, and the name when the type says nothing; HTML and SVG never preview', () => {
  const kind = (contentType, fileName) => previewFormatOf({ contentType, fileName }).kind;
  assert.equal(kind(DOCX, 'a.docx'), 'office');
  assert.equal(kind('application/octet-stream', 'deck.PPTX'), 'office');
  for (const extension of ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf']) assert.equal(kind('', `f.${extension}`), 'office', extension);
  assert.equal(kind('application/pdf', 'a.pdf'), 'pdf');
  assert.equal(kind('image/png', 'a.png'), 'image');
  assert.equal(kind('application/octet-stream', 'a.webp'), 'image');
  assert.equal(kind('video/mp4', 'a.mp4'), 'video');
  assert.equal(kind('video/webm', 'a.webm'), 'video');
  assert.equal(kind('video/quicktime', 'a.mov'), 'none');
  assert.equal(kind('text/plain', 'a.txt'), 'text');
  assert.equal(kind('text/csv', 'a.csv'), 'text');
  assert.equal(kind('text/markdown', 'a.md'), 'markdown');
  assert.equal(kind('text/plain', 'a.md'), 'markdown');
  assert.equal(kind('application/octet-stream', 'README.markdown'), 'markdown');
  assert.equal(kind('text/html', 'a.html'), 'none');
  assert.equal(kind('text/html', 'a.txt'), 'none', 'an HTML file named .txt');
  assert.equal(kind('image/svg+xml', 'a.svg'), 'none');
  assert.equal(kind('image/svg+xml', 'a.png'), 'none', 'an SVG file named .png');
  assert.equal(kind('application/octet-stream', 'a.svg'), 'none');
  assert.equal(kind('application/xhtml+xml', 'a.xhtml'), 'none');
  assert.equal(previewFormatOf({ contentType: 'text/markdown', fileName: 'a.md' }).contentType, 'text/plain; charset=utf-8', 'Markdown is served as plain text');
  assert.equal(previewStorageKeyFor('0b6b8c0e-1111-4c4c-8888-123456789abc'), '0b6b8c0e-1111-4c4c-8888-123456789abc.preview.pdf');
  assert.equal(inlineFramePolicy(['https://app.example', 'https://app.example/app', 'not a url']), "default-src 'none'; frame-ancestors https://app.example; base-uri 'none'");
  assert.equal(inlineFramePolicy([]), "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
});

test('preview-url gives each kind a 5-minute inline URL, refuses before the scan, and has the rights of a download', async (t) => {
  const { fetchUrl, preview, projectRepository, send, upload } = await fixture(t, { previewMaxBytes: 4096 });
  const files = {
    big: await upload('huge.docx', DOCX, 'x'.repeat(5000)),
    bin: await upload('data.bin', 'application/octet-stream', 'binary'),
    docx: await upload('report.docx', DOCX, 'a document'),
    html: await upload('page.html', 'text/html', '<script>alert(1)</script>'),
    htmlAsText: await upload('page.txt', 'text/html', '<script>alert(1)</script>'),
    image: await upload('photo.png', 'image/png', 'png bytes'),
    longText: await upload('long.txt', 'text/plain', 'y'.repeat(2 * 1024 * 1024 + 1)),
    markdown: await upload('notes.md', 'text/markdown', '# Notes'),
    markdownUntyped: await upload('readme.md', 'application/octet-stream', '# Readme'),
    pdf: await upload('spec.pdf', 'application/pdf', '%PDF-1.4'),
    svg: await upload('logo.svg', 'image/svg+xml', '<svg onload="alert(1)"/>'),
    text: await upload('log.txt', 'text/plain', 'hello'),
    video: await upload('clip.mp4', 'video/mp4', 'mp4 bytes'),
  };
  const expected = {
    big: ['none', 'too_large', null],
    bin: ['none', 'unsupported', null],
    docx: ['preparing', null, null],
    html: ['none', 'unsupported', null],
    htmlAsText: ['none', 'unsupported', null],
    image: ['image', null, 'image/png'],
    longText: ['none', 'too_large', null],
    markdown: ['markdown', null, 'text/plain; charset=utf-8'],
    markdownUntyped: ['markdown', null, 'text/plain; charset=utf-8'],
    pdf: ['pdf', null, 'application/pdf'],
    svg: ['none', 'unsupported', null],
    text: ['text', null, 'text/plain; charset=utf-8'],
    video: ['video', null, 'video/mp4'],
  };
  for (const [name, [kind, reason, contentType]] of Object.entries(expected)) {
    const result = await preview('viewer', files[name].id);
    assert.equal(result.status, 200, `${name}: ${JSON.stringify(result.body)}`);
    assert.deepEqual([result.body.kind, result.body.reason], [kind, reason], name);
    if (!contentType) {
      assert.equal(result.body.url, null, `${name} has no URL`);
      continue;
    }
    assert.ok(new Date(result.body.expiresAt) - Date.now() <= 5 * 60_000 + 1000, `${name}: the link lasts 5 minutes`);
    const served = await fetchUrl(result.body.url);
    assert.equal(served.status, 200, name);
    assert.equal(served.headers.get('content-type'), contentType, name);
    assert.match(served.headers.get('content-disposition'), /^inline; /, name);
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff', name);
    // The app may frame it (a PDF in the viewer); nothing else may.
    assert.equal(served.headers.get('x-frame-options'), null, name);
    assert.match(served.headers.get('content-security-policy'), /frame-ancestors https:\/\/app\.example;/, name);
  }
  // A download link to the same file still lets nothing frame it.
  const download = await send('viewer', 'GET', `${P}/files/${files.pdf.id}/download-url`);
  const downloaded = await fetchUrl(download.body.url);
  assert.match(downloaded.headers.get('content-disposition'), /^attachment; /);
  assert.equal(downloaded.headers.get('x-frame-options'), 'DENY');
  // An image's bytes are the file's.
  assert.equal(await (await fetchUrl((await preview('viewer', files.image.id)).body.url)).text(), 'png bytes');

  // Same rights as download-url: a member of another project, and an unknown file, are refused alike.
  for (const [as, fileId] of [['outsider', files.image.id], ['viewer', 'no-such-file']]) {
    const refused = await preview(as, fileId);
    const downloadRefused = await send(as, 'GET', `${P}/files/${fileId}/download-url`);
    assert.ok(refused.status >= 400 && refused.status < 500, `${as}: ${refused.status}`);
    assert.equal(refused.status, downloadRefused.status, `${as} is refused as a download is`);
    assert.equal(refused.body.url, undefined);
  }
  assert.equal((await preview('viewer', files.image.id, 9)).status, 404, 'no such version');

  // A file waiting for its scan, or failed, has no preview of any kind.
  for (const scanStatus of ['pending', 'infected', 'failed']) {
    const file = projectRepository.state.files.find((entry) => entry.id === files.image.id);
    file.scanStatus = scanStatus;
    const refused = await preview('viewer', files.image.id);
    assert.equal(refused.status, 409, scanStatus);
    assert.equal(refused.body.details.code, { failed: 'file_scan_failed', infected: 'file_infected', pending: 'file_scanning' }[scanStatus]);
    file.scanStatus = 'clean';
  }
  const docxRow = projectRepository.state.files.find((entry) => entry.id === files.docx.id);
  docxRow.scanStatus = 'pending';
  assert.equal((await preview('viewer', files.docx.id)).status, 409, 'an Office file waiting for its scan is not "preparing"');
  docxRow.scanStatus = 'clean';

  // Only Office files that passed their scan and fit the limit wait for the worker.
  const pending = await projectRepository.listPendingPreviewObjects({ maxBytes: 4096 });
  assert.deepEqual(pending.map((entry) => entry.fileName), ['report.docx']);
  // The preview key never reaches a reader.
  const listed = await send('viewer', 'GET', `${P}/files?targetId=${PROJECT}&targetType=project`);
  assert.ok(listed.body.files.every((file) => !('previewStorageKey' in file) && !('storageKey' in file)));
});

test('the worker converts Office files with soffice, records failures and timeouts as no preview, and does not try them again', async (t) => {
  process.env.ODIN_PREVIEW_TEST_SECRET = 'must-not-reach-soffice';
  t.after(() => { delete process.env.ODIN_PREVIEW_TEST_SECRET; });
  const { calls, converter } = await fakeSoffice(t, { timeoutMs: 1500 });
  const { fetchUrl, liveEventBus, newVersion, preview, projectRepository, published, send, storage, upload } = await fixture(t, { filePreviews: { available: () => converter.available() } });
  const logged = [];
  const processor = createFilePreviewProcessor({ converter, liveEventBus, log: (message) => logged.push(message), projectRepository, storage });

  const report = await upload('report.docx', DOCX, 'quarterly numbers');
  const broken = await upload('broken.xlsx', XLSX, 'FAIL this sheet');
  const silent = await upload('silent.pptx', PPTX, 'SILENT deck');
  const slow = await upload('slow.odt', 'application/vnd.oasis.opendocument.text', 'HANG forever');
  for (const file of [report, broken, silent, slow]) assert.equal((await preview('viewer', file.id)).body.kind, 'preparing');

  const results = await processor.processBatch({ limit: 10 });
  const keyOf = (file) => { const row = projectRepository.state.files.find((entry) => entry.id === file.id); return row.storageKey ?? row.id; };
  const byKey = Object.fromEntries(results.map((entry) => [entry.storageKey, entry.status]));
  assert.deepEqual([byKey[keyOf(report)], byKey[keyOf(broken)], byKey[keyOf(silent)], byKey[keyOf(slow)]], ['ready', 'failed', 'failed', 'timeout']);

  // The PDF is stored beside the file, and preview-url hands it out inline.
  const ready = await preview('viewer', report.id);
  assert.deepEqual([ready.body.kind, ready.body.reason], ['pdf', null]);
  const pdf = await fetchUrl(ready.body.url);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.match(pdf.headers.get('content-disposition'), /^inline; filename="report\.pdf"/);
  assert.equal(await pdf.text(), '%PDF-1.4 converted quarterly numbers');
  assert.ok(storage.objects.has(previewStorageKeyFor(keyOf(report))));
  for (const file of [broken, silent, slow]) {
    assert.deepEqual([(await preview('viewer', file.id)).body.kind, (await preview('viewer', file.id)).body.reason], ['none', 'failed'], file.fileName);
    assert.equal(projectRepository.state.files.find((entry) => entry.id === file.id).previewStorageKey, NO_PREVIEW);
  }
  // The file itself still downloads.
  assert.equal((await send('viewer', 'GET', `${P}/files/${broken.id}/download-url`)).status, 200);

  // Each result told the project's screens.
  assert.equal(published.filter(({ event }) => event.reason === 'file preview' && event.projectId === PROJECT).length, 4);

  // soffice ran headless, with its own profile, its proxies closed and none of the server's secrets.
  const runs = await calls();
  assert.equal(runs.length, 4);
  for (const run of runs) {
    assert.ok(run.args.includes('--headless') && run.args.includes('--norestore'));
    assert.deepEqual(run.args.slice(run.args.indexOf('--convert-to'), run.args.indexOf('--convert-to') + 2), ['--convert-to', 'pdf']);
    assert.match(run.args.find((arg) => arg.startsWith('-env:UserInstallation=')), /^-env:UserInstallation=file:\/\//);
    assert.equal(run.env.ODIN_PREVIEW_TEST_SECRET, undefined);
    // Windows keeps one of http_proxy and HTTP_PROXY.
    assert.equal(run.env.http_proxy ?? run.env.HTTP_PROXY, 'http://127.0.0.1:9');
  }
  // The timed-out conversion was killed.
  const hung = runs.find((run) => run.args.at(-1).endsWith('.odt'));
  assert.throws(() => process.kill(hung.pid, 0), { code: 'ESRCH' });
  // Profiles differ, and the temporary copies are gone.
  assert.equal(new Set(runs.map((run) => run.args.find((arg) => arg.startsWith('-env:')))).size, 4);

  // Nothing is tried again.
  assert.deepEqual(await processor.processBatch({ limit: 10 }), []);
  assert.equal((await calls()).length, 4);

  // A new version of the broken file gets a new try, and the old version keeps "no preview".
  const fixed = await newVersion(broken, 'now it converts');
  assert.equal((await preview('viewer', broken.id)).body.kind, 'preparing');
  assert.deepEqual((await processor.processBatch()).map((entry) => entry.status), ['ready']);
  assert.equal((await preview('viewer', broken.id)).body.kind, 'pdf');
  assert.deepEqual([(await preview('viewer', broken.id, 1)).body.kind, (await preview('viewer', broken.id, 1)).body.reason], ['none', 'failed']);
  assert.equal(fixed.version, 2);

  // Restoring a version brings its preview back without converting again.
  const report2 = await newVersion(report, 'second draft');
  await processor.processBatch();
  const v2Key = keyOf(report);
  const restored = await send('member', 'POST', `${P}/files/${report.id}/versions/1/restore`, { expectedVersion: report2.version });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(await (await fetchUrl((await preview('viewer', report.id)).body.url)).text(), '%PDF-1.4 converted quarterly numbers');
  assert.deepEqual(await projectRepository.listPendingPreviewObjects(), []);
  const before = (await calls()).length;

  // Deleting a version deletes its preview; deleting the file deletes them all.
  assert.ok(storage.objects.has(previewStorageKeyFor(v2Key)));
  assert.equal((await send('admin', 'DELETE', `${P}/files/${report.id}/versions/2`)).status, 200);
  assert.equal(storage.objects.has(v2Key), false);
  assert.equal(storage.objects.has(previewStorageKeyFor(v2Key)), false, 'the deleted version\'s PDF went with it');
  const v1Key = keyOf(report);
  assert.ok(storage.objects.has(previewStorageKeyFor(v1Key)));
  assert.equal((await send('member', 'DELETE', `/api/files/${report.id}`)).status, 200);
  assert.equal(storage.objects.has(previewStorageKeyFor(v1Key)), false);
  assert.equal((await calls()).length, before);
  assert.deepEqual(logged, []);
});

test('a missing source records no preview; a storage failure is tried again, then gives up', async (t) => {
  const { converter } = await fakeSoffice(t);
  const { preview, projectRepository, storage, upload } = await fixture(t);
  const gone = await upload('gone.docx', DOCX, 'deleted underneath');
  const flaky = await upload('flaky.docx', DOCX, 'storage will refuse it');
  const keyOf = (file) => { const row = projectRepository.state.files.find((entry) => entry.id === file.id); return row.storageKey ?? row.id; };
  const goneKey = keyOf(gone);
  const flakyKey = keyOf(flaky);
  storage.objects.delete(goneKey);
  let now = new Date('2026-11-14T10:00:00Z');
  const failing = { ...storage, async writeStream(key) { throw Object.assign(new Error(`storage refused ${key}`), { code: 'EIO' }); } };
  const processor = createFilePreviewProcessor({ clock: () => now, converter, log: () => {}, maxAttempts: 2, projectRepository, storage: failing });

  const first = Object.fromEntries((await processor.processBatch({ limit: 10 })).map((entry) => [entry.storageKey, entry.status]));
  assert.deepEqual([first[goneKey], first[flakyKey]], ['failed', 'retry']);
  assert.deepEqual([(await preview('viewer', gone.id)).body.kind, (await preview('viewer', flaky.id)).body.kind], ['none', 'preparing']);
  assert.deepEqual(await processor.processBatch({ limit: 10 }), [], 'it waits before trying again');
  now = new Date(now.getTime() + 60 * 60_000);
  assert.deepEqual((await processor.processBatch({ limit: 10 })).map((entry) => entry.status), ['failed']);
  assert.equal((await preview('viewer', flaky.id)).body.reason, 'failed');
});

test('without soffice nothing converts, it is logged once, and preview-url says previews are unavailable', async (t) => {
  const missing = path.join(os.tmpdir(), 'odin-no-such-dir', 'soffice');
  const converter = createSofficeConverter({ sofficePath: missing });
  assert.equal(await converter.available(), false);
  assert.equal(await findExecutable('odin-no-such-program-anywhere'), null);
  assert.ok(await findExecutable(process.execPath), 'an absolute path to a program is found');
  const { preview, projectRepository, storage, upload } = await fixture(t, { filePreviews: { available: () => converter.available() } });
  const logged = [];
  const processor = createFilePreviewProcessor({ converter, log: (message) => logged.push(message), projectRepository, storage });
  const file = await upload('report.docx', DOCX, 'no LibreOffice here');
  assert.deepEqual(await processor.processBatch(), []);
  assert.deepEqual(await processor.processBatch(), []);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /LibreOffice \(PREVIEW_SOFFICE_PATH\) is not installed/);
  assert.deepEqual([(await preview('viewer', file.id)).body.kind, (await preview('viewer', file.id)).body.reason], ['none', 'unavailable']);
  // Left as it was, so it converts once LibreOffice is installed.
  assert.equal(projectRepository.state.files.find((entry) => entry.id === file.id).previewStorageKey ?? null, null);
  assert.equal((await projectRepository.listPendingPreviewObjects()).length, 1);
  // A program that disappears after it was found is reported missing from then on.
  const vanished = () => {
    const child = new EventEmitter();
    process.nextTick(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
    return child;
  };
  const vanishing = createSofficeConverter({ platform: 'win32', sofficePath: process.execPath, spawnImpl: vanished });
  assert.equal(await vanishing.available(), true);
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'odin-vanished-'));
  t.after(() => rm(workDir, { force: true, recursive: true }));
  await assert.rejects(vanishing.convert({ inputPath: path.join(workDir, 'source.docx'), workDir }), { code: 'soffice_missing' });
  assert.equal(await vanishing.available(), false);
});
