import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createClamAvFileScanner, createNoopFileScanner } from '../src/lib/files/file-scanner.js';
import { createLocalFileStorage } from '../src/lib/files/file-storage.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectChangeLog } from '../src/modules/changes/project-change-log.js';
import { createInMemoryComplianceRepository } from '../src/modules/compliance/compliance.repository.js';
import { createInMemoryMailRepository } from '../src/modules/mail/mail.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';
import { createFileScanProcessor } from '../src/modules/vault/file-scan-worker.js';
import { parseByteRange } from '../src/modules/vault/large-files.routes.js';
import {
  abortExpiredUploads,
  completeUploadForUser,
  DEFAULT_FILE_UPLOAD_MAX_BYTES,
  downloadDisposition,
  partSizeFor,
  startUploadForUser,
} from '../src/modules/vault/large-files.service.js';
import { createMemoryLargeFileStorage, EICAR, freePort, startFakeClamd } from './helpers/large-file-fixtures.js';

// Large files (docs/engagements/plan.md, Files; AC-04, AC-05, AC-06): uploads in parts, the size
// limit, resuming, version conflicts, scanning, signed downloads and deleting old versions,
// through Odin's routes on in-memory repositories. large-files-memory.test.js measures memory;
// large-files-s3.integration.test.js runs the multipart calls against MinIO.

const TENANT_ID = 'tenant-acme';
const PROJECT = 'project-1';
const P = `/api/projects/${PROJECT}`;
const MiB = 1024 * 1024;
const USERS = {
  admin: { id: 'user-admin', role: 'admin' },
  member: { id: 'user-member', role: 'user' },
  viewer: { id: 'user-viewer', role: 'user' },
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const vault = { targetId: PROJECT, targetType: 'project' };

async function fixture(t, { clock = null, fileStorage = null, fileUploadMaxBytes, signingRepository } = {}) {
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['acme.example'], id: TENANT_ID, name: 'Acme' }],
    users: Object.values(USERS).map((user) => ({ authMethod: 'basic', email: `${user.id}@acme.example`, id: user.id, memberships: [{ role: user.role, tenantId: TENANT_ID }], name: user.id, password: 'Fixture-password-123!', preferences: { twoFactorEnabled: false } })),
  });
  let storage = fileStorage;
  let root = null;
  if (!storage) {
    root = await mkdtemp(path.join(os.tmpdir(), 'odin-large-files-'));
    t.after(() => rm(root, { force: true, recursive: true }));
    storage = createLocalFileStorage({ rootDir: root });
  }
  const changeLog = createInMemoryProjectChangeLog();
  const mailRepository = createInMemoryMailRepository();
  const projectRepository = createInMemoryProjectsRepository({
    authRepository,
    changeLog,
    fileStorage: storage,
    mailRepository,
    seed: {
      projectMemberships: { [PROJECT]: [{ id: USERS.member.id, role: 'user' }, { id: USERS.viewer.id, role: 'viewer' }] },
      projects: [{ epics: [], id: PROJECT, name: 'One', status: 'In Progress', tenantId: TENANT_ID }],
    },
  });
  const complianceRepository = createInMemoryComplianceRepository();
  const sessionsRepository = createInMemorySessionsRepository();
  const tokenService = createTokenService({ issuer: 'large-files-fixture', secret: 'disposable-large-files-secret' });
  const app = createApp({
    accessReviewCampaignSweepIntervalMs: 0, agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0, domainEventSweepIntervalMs: 0,
    changeSettleMs: 0, frontendAppUrl: 'https://app.example/app', reportSubscriptionSweepIntervalMs: 0, reportingWarehouseSweepIntervalMs: 0, webhookSweepIntervalMs: 0, workflowAutomationSweepIntervalMs: 0,
    authRepository, complianceRepository, fileClock: clock ?? undefined, fileStorage: storage, fileUploadMaxBytes, mailRepository, projectRepository, sessionsRepository, tokenService,
    ...(signingRepository ? { signingRepository } : {}),
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
  // A request as a user; raw returns the response itself.
  const raw = (as, route, init = {}) => fetch(absolute(route), { ...init, headers: { ...(as ? { Authorization: `Bearer ${tokens[as]}` } : {}), ...(init.headers ?? {}) } });
  async function send(as, method, route, body) {
    const response = await raw(as, route, { body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, method });
    return { body: await response.json().catch(() => null), status: response.status };
  }
  // Signed URLs carry their own authorization: no session goes with them.
  const putPart = (url, bytes) => fetch(absolute(url), { body: bytes, headers: { 'Content-Type': 'application/octet-stream' }, method: 'PUT' });
  const fetchUrl = (url, init) => fetch(absolute(url), init);
  async function base64Upload(as, { contents = 'one', fileName = 'spec.txt' } = {}) {
    const response = await send(as, 'POST', `${P}/files`, { fileContentsBase64: Buffer.from(contents).toString('base64'), fileName, fileType: 'text/plain', ...vault });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.file;
  }
  async function startUpload(as, bytes, start = {}) {
    const started = await send(as, 'POST', `${P}/uploads`, { contentType: 'application/octet-stream', fileName: 'big.bin', fileSize: bytes.length, ...vault, ...start });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    return started.body.upload;
  }
  async function sendParts(as, upload, bytes) {
    const signed = await send(as, 'POST', `${P}/uploads/${upload.id}/parts`, { partNumbers: Array.from({ length: upload.partCount }, (_, index) => index + 1) });
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    for (const part of signed.body.parts) {
      const sent = await putPart(part.url, bytes.subarray((part.partNumber - 1) * upload.partSize, part.partNumber * upload.partSize));
      assert.equal(sent.status, 200, await sent.text());
    }
  }
  /** Starts, sends every part, and completes an upload. */
  async function upload(as, bytes, { complete = {}, start = {} } = {}) {
    const started = await startUpload(as, bytes, start);
    await sendParts(as, started, bytes);
    return { ...await send(as, 'POST', `${P}/uploads/${started.id}/complete`, complete), uploadId: started.id };
  }
  const scanProcessor = (scanner = createNoopFileScanner(), options = {}) => createFileScanProcessor({ clock: clock ?? undefined, frontendAppUrl: 'https://app.example/app', mailRepository, projectRepository, scanner, storage, ...options });
  return { base64Upload, changeLog, complianceRepository, fetchUrl, mailRepository, projectRepository, putPart, raw, root, scanProcessor, send, sendParts, startUpload, storage, upload };
}

const userOf = (key) => ({ id: USERS[key].id, memberships: [{ role: USERS[key].role, tenantId: TENANT_ID }], name: USERS[key].id });

test('the limit is 1 GB: exactly 1,073,741,824 bytes starts, one byte more is refused before any part is sent', async (t) => {
  const { send } = await fixture(t);
  assert.equal(DEFAULT_FILE_UPLOAD_MAX_BYTES, 1_073_741_824);
  const exact = await send('member', 'POST', `${P}/uploads`, { contentType: 'video/mp4', fileName: 'film.mp4', fileSize: 1_073_741_824, ...vault });
  assert.equal(exact.status, 201, JSON.stringify(exact.body));
  assert.deepEqual([exact.body.upload.partSize, exact.body.upload.partCount, exact.body.upload.maxBytes], [8 * MiB, 128, 1_073_741_824]);
  const over = await send('member', 'POST', `${P}/uploads`, { contentType: 'video/mp4', fileName: 'film.mp4', fileSize: 1_073_741_825, ...vault });
  assert.deepEqual([over.status, over.body.details.code], [413, 'file_too_large']);
  assert.equal((await send('member', 'DELETE', `${P}/uploads/${exact.body.upload.id}`)).body.cancelled, true);
  assert.equal((await send('viewer', 'POST', `${P}/uploads`, { fileName: 'x.bin', fileSize: 10, ...vault })).status, 404, 'viewers cannot upload: they get what a missing project gets');
  assert.equal((await send('member', 'POST', `${P}/uploads`, { fileName: 'x.bin', fileSize: 10, targetId: 'nowhere', targetType: 'story' })).status, 400, 'the target must be in the project');
  assert.equal(partSizeFor(1_073_741_824), 8 * MiB);
  assert.equal(partSizeFor(200 * 1024 * MiB), 32 * MiB, 'parts grow to stay within 10,000');
});

test('completion checks the real size: exactly 1 GB is saved; 1 GB and a byte is refused and dropped', async () => {
  const authRepository = await createInMemoryAuthRepository({ disableDemoUser: true, tenants: [{ domains: ['acme.example'], id: TENANT_ID, name: 'Acme' }], users: [{ authMethod: 'basic', email: 'user-admin@acme.example', id: USERS.admin.id, memberships: [{ role: 'admin', tenantId: TENANT_ID }], name: 'Ada', password: 'Fixture-password-123!' }] });
  // Storage that reports parts without holding bytes, as S3 does after a browser sent them.
  const deps = ({ joined = 1_073_741_824, lastPartExtra = 0 } = {}) => {
    const storage = createMemoryLargeFileStorage();
    storage.listParts = async () => Array.from({ length: 128 }, (_, index) => ({ etag: `"${index}"`, partNumber: index + 1, size: 8 * MiB + (index === 127 ? lastPartExtra : 0) }));
    storage.completeMultipartUpload = async () => ({ size: joined });
    const projectRepository = createInMemoryProjectsRepository({ authRepository, fileStorage: storage, seed: { projects: [{ epics: [], id: PROJECT, name: 'One', status: 'In Progress', tenantId: TENANT_ID }] } });
    return { fileStorage: storage, projectRepository };
  };
  const user = userOf('admin');
  const startOn = (setup) => startUploadForUser(setup, user, PROJECT, { contentType: 'video/mp4', fileName: 'film.mp4', fileSize: 1_073_741_824, ...vault });

  const fits = deps();
  const saved = await completeUploadForUser(fits, user, PROJECT, (await startOn(fits)).upload.id, {});
  assert.deepEqual([saved.file.fileSize, saved.file.scanStatus], [1_073_741_824, 'pending']);

  // The browser said 1 GB, then sent a last part one byte longer.
  const over = deps({ lastPartExtra: 1 });
  const overStart = await startOn(over);
  await assert.rejects(completeUploadForUser(over, user, PROJECT, overStart.upload.id, {}), (error) => error.statusCode === 413 && error.details.code === 'file_too_large' && error.details.size === 1_073_741_825);
  assert.ok(over.fileStorage.calls.some(([name]) => name === 'abort'), 'the multipart upload is aborted');
  assert.equal((await over.projectRepository.getFileUpload({ tenantId: TENANT_ID, uploadId: overStart.upload.id })).status, 'rejected');
  assert.equal((await over.projectRepository.listFiles({ projectId: PROJECT, ...vault, tenantId: TENANT_ID })).length, 0);

  // Storage reports more than the limit once the parts are joined.
  const joined = deps({ joined: 1_073_741_825 });
  const joinedStart = await startOn(joined);
  await assert.rejects(completeUploadForUser(joined, user, PROJECT, joinedStart.upload.id, {}), (error) => error.statusCode === 413);
  assert.ok(joined.fileStorage.calls.some(([name]) => name === 'delete'), 'the joined object is deleted');
  assert.equal((await joined.projectRepository.listFiles({ projectId: PROJECT, ...vault, tenantId: TENANT_ID })).length, 0);
});

test('an upload resumes from the parts storage has, and nothing downloads until the scan passes', async (t) => {
  const { fetchUrl, putPart, raw, scanProcessor, send } = await fixture(t);
  const bytes = randomBytes(20 * MiB);
  const started = await send('member', 'POST', `${P}/uploads`, { contentType: 'application/pdf', fileName: 'report.pdf', fileSize: bytes.length, ...vault });
  const { id, partCount, partSize } = started.body.upload;
  assert.deepEqual([partCount, partSize], [3, 8 * MiB]);
  const signed = (await send('member', 'POST', `${P}/uploads/${id}/parts`, { partNumbers: [1, 2, 3] })).body.parts;
  assert.deepEqual(signed.map((part) => part.size), [8 * MiB, 8 * MiB, 4 * MiB]);
  const slice = (partNumber) => bytes.subarray((partNumber - 1) * partSize, partNumber * partSize);
  assert.equal((await putPart(signed[0].url, slice(1))).status, 200);
  assert.equal((await putPart(signed[2].url, slice(3))).status, 200);

  // The connection dropped: the browser asks what arrived, and sends the rest.
  const state = await send('member', 'GET', `${P}/uploads/${id}`);
  assert.deepEqual(state.body.upload.parts, [{ partNumber: 1, size: 8 * MiB }, { partNumber: 3, size: 4 * MiB }]);
  assert.equal(state.body.upload.receivedBytes, 12 * MiB);
  assert.equal((await send('admin', 'GET', `${P}/uploads/${id}`)).status, 404, 'an upload is its uploader\'s alone');
  const early = await send('member', 'POST', `${P}/uploads/${id}/complete`, {});
  assert.deepEqual([early.status, early.body.details.code, early.body.details.missingParts], [409, 'upload_incomplete', [2]]);
  const resent = (await send('member', 'POST', `${P}/uploads/${id}/parts`, { partNumbers: [2] })).body.parts[0];
  assert.equal((await putPart(resent.url, slice(2))).status, 200);

  const done = await send('member', 'POST', `${P}/uploads/${id}/complete`, { fileDescription: 'Quarterly' });
  assert.equal(done.status, 201, JSON.stringify(done.body));
  const file = done.body.file;
  assert.deepEqual([file.fileName, file.fileSize, file.scanStatus, file.description, file.version], ['report.pdf', bytes.length, 'pending', 'Quarterly', 1]);

  // Pending: no route hands out the contents.
  const refused = await send('viewer', 'GET', `${P}/files/${file.id}/download-url`);
  assert.deepEqual([refused.status, refused.body.details.code], [409, 'file_scanning']);
  assert.equal((await raw('viewer', `/api/files/${file.id}/content`)).status, 409);
  assert.equal((await send('viewer', 'GET', `${P}/files/${file.id}/download?inline=1`)).status, 409);

  assert.deepEqual((await scanProcessor().processBatch()).map((entry) => entry.status), ['clean']);
  const listed = (await send('viewer', 'GET', `${P}/files?targetId=${PROJECT}&targetType=project`)).body.files[0];
  assert.deepEqual([listed.scanStatus, listed.sha256], ['clean', sha256(bytes)]);

  const link = await send('viewer', 'GET', `${P}/files/${file.id}/download-url`);
  assert.equal(link.status, 200, JSON.stringify(link.body));
  assert.ok(new Date(link.body.expiresAt) - Date.now() <= 5 * 60_000 + 1000, 'the link lasts 5 minutes');
  const downloaded = await fetchUrl(link.body.url);
  assert.equal(downloaded.status, 200);
  assert.match(downloaded.headers.get('content-disposition'), /^attachment; filename="report\.pdf"/);
  assert.equal(sha256(Buffer.from(await downloaded.arrayBuffer())), sha256(bytes), 'the file downloads intact');
  const ranged = await fetchUrl(link.body.url, { headers: { Range: 'bytes=100-199' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), `bytes 100-199/${bytes.length}`);
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), bytes.subarray(100, 200));
  assert.equal((await fetchUrl(link.body.url, { headers: { Range: `bytes=${bytes.length}-` } })).status, 416);
  assert.equal((await fetchUrl(`${link.body.url.slice(0, -2)}xx`)).status, 403, 'a tampered link is refused');

  // The content route streams it, as before.
  const content = await raw('viewer', `/api/files/${file.id}/content?download=1`);
  assert.equal(content.status, 200);
  assert.equal(content.headers.get('content-length'), String(bytes.length));
  assert.equal(sha256(Buffer.from(await content.arrayBuffer())), sha256(bytes));
});

test('a part larger than its size is refused, and the part URL works only for its own upload part', async (t) => {
  const { putPart, send, startUpload } = await fixture(t);
  const bytes = randomBytes(1000);
  const upload = await startUpload('member', bytes);
  const [part] = (await send('member', 'POST', `${P}/uploads/${upload.id}/parts`, { partNumbers: [1] })).body.parts;
  assert.equal((await send('member', 'POST', `${P}/uploads/${upload.id}/parts`, { partNumbers: [2] })).status, 400, 'beyond the part count');
  const tooLong = await putPart(part.url, Buffer.concat([bytes, Buffer.from('x')])).catch((error) => ({ status: 'reset', error }));
  assert.ok(tooLong.status === 413 || tooLong.status === 'reset', `refused: ${tooLong.status}`);
  assert.equal((await putPart(part.url, bytes)).status, 200);
  assert.equal((await send('member', 'GET', `${P}/uploads/${upload.id}`)).body.upload.receivedBytes, 1000);
  assert.equal((await send('member', 'DELETE', `${P}/uploads/${upload.id}`)).body.cancelled, true);
  assert.equal((await putPart(part.url, bytes)).status, 409, 'a cancelled upload takes no parts');
});

test('a new version carries its base version: a stale one is refused, then kept as a new file or saved on top', async (t) => {
  const { base64Upload, putPart, scanProcessor, send, upload } = await fixture(t);
  const file = await base64Upload('member', { contents: 'first', fileName: 'plan.txt' });
  const staleStart = await send('member', 'POST', `${P}/uploads`, { contentType: 'text/plain', expectedVersion: 2, fileId: file.id, fileName: 'plan.txt', fileSize: 10 });
  assert.deepEqual([staleStart.status, staleStart.body.details.code, staleStart.body.details.currentVersion], [409, 'file_changed', 1]);
  assert.equal((await send('member', 'POST', `${P}/uploads`, { fileId: file.id, fileName: 'plan.txt', fileSize: 10 })).status, 400, 'a version needs its base');

  // Two people start from version 1. The base64 one lands first.
  const mine = Buffer.from('second, from the large path');
  const started = await send('member', 'POST', `${P}/uploads`, { contentType: 'text/plain', expectedVersion: 1, fileId: file.id, fileName: 'plan.txt', fileSize: mine.length });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const theirs = await send('admin', 'POST', `${P}/files/${file.id}/versions`, { expectedVersion: 1, fileContentsBase64: Buffer.from('second, theirs').toString('base64') });
  assert.equal(theirs.body.file.version, 2);
  const { id } = started.body.upload;
  const [part] = (await send('member', 'POST', `${P}/uploads/${id}/parts`, { partNumbers: [1] })).body.parts;
  assert.equal((await putPart(part.url, mine)).status, 200);
  const conflict = await send('member', 'POST', `${P}/uploads/${id}/complete`, { note: 'Mine' });
  assert.deepEqual([conflict.status, conflict.body.details.code, conflict.body.details.currentVersion, conflict.body.details.canKeepBoth, conflict.body.details.uploadId], [409, 'file_changed', 2, true, id]);

  // Keep both: the upload, already joined, becomes a new file beside the other.
  const kept = await send('member', 'POST', `${P}/uploads/${id}/complete`, { keepBoth: true });
  assert.equal(kept.status, 201, JSON.stringify(kept.body));
  assert.deepEqual([kept.body.file.fileName, kept.body.file.version], ['plan (2).txt', 1]);
  assert.notEqual(kept.body.file.id, file.id);
  assert.equal((await send('member', 'POST', `${P}/uploads/${id}/complete`, {})).body.details.code, 'upload_closed', 'a saved upload stays saved');

  // On top: after seeing version 2, the uploader saves over it.
  const onTop = await upload('member', Buffer.from('third, on top'), { complete: { note: 'On top' }, start: { contentType: 'text/plain', expectedVersion: 2, fileId: file.id, fileName: 'plan.txt' } });
  assert.equal(onTop.status, 201, JSON.stringify(onTop.body));
  assert.deepEqual([onTop.body.file.version, onTop.body.file.versionNote, onTop.body.file.scanStatus], [3, 'On top', 'pending']);
  assert.equal((await send('member', 'GET', `${P}/files/${file.id}/download-url?version=2`)).status, 200, 'earlier versions stay downloadable while the new one is scanned');
  await scanProcessor().processBatch();
  const versions = (await send('member', 'GET', `${P}/files/${file.id}/versions`)).body.versions;
  assert.deepEqual(versions.map((entry) => [entry.version, entry.scanStatus]), [[3, 'clean'], [2, 'clean'], [1, 'clean']]);

  // A same-name upload with no file named versions that file, as the base64 path does.
  const same = await upload('member', Buffer.from('fourth'), { start: { contentType: 'text/plain', fileName: 'PLAN.txt' } });
  assert.deepEqual([same.body.file.id, same.body.file.version, same.body.file.fileName], [file.id, 4, 'plan.txt']);
});

test('scans: clean files become available; EICAR is marked infected, purged and its uploader told', async (t) => {
  const clamd = await startFakeClamd();
  t.after(() => clamd.close());
  const fileStorage = createMemoryLargeFileStorage();
  const { changeLog, mailRepository, projectRepository, scanProcessor, send, upload } = await fixture(t, { fileStorage });
  const scanner = createClamAvFileScanner({ host: '127.0.0.1', port: clamd.port, timeoutMs: 2000 });

  const clean = (await upload('member', Buffer.from('nothing to see'), { start: { contentType: 'text/plain', fileName: 'clean.txt' } })).body.file;
  const infected = (await upload('member', Buffer.from(`prefix ${EICAR} suffix`), { start: { contentType: 'text/plain', fileName: 'eicar.txt' } })).body.file;
  const infectedKey = [...fileStorage.objects.keys()].find((key) => fileStorage.objects.get(key).includes(Buffer.from('EICAR')));
  const results = await scanProcessor(scanner).processBatch();
  assert.deepEqual(results.map((entry) => entry.status).sort(), ['clean', 'infected']);

  const files = (await send('member', 'GET', `${P}/files?targetId=${PROJECT}&targetType=project`)).body.files;
  const byName = Object.fromEntries(files.map((file) => [file.fileName, file]));
  assert.equal(byName['clean.txt'].scanStatus, 'clean');
  assert.equal(byName['clean.txt'].sha256, sha256(Buffer.from('nothing to see')));
  assert.equal(byName['eicar.txt'].scanStatus, 'infected');
  assert.equal(fileStorage.objects.has(infectedKey), false, 'the infected object is gone');
  assert.ok(fileStorage.calls.some(([name, key]) => name === 'purge' && key === infectedKey), 'every stored version of it is purged');
  const refused = await send('member', 'GET', `${P}/files/${infected.id}/download-url`);
  assert.deepEqual([refused.status, refused.body.details.code], [409, 'file_infected']);
  assert.equal((await send('member', 'GET', `${P}/files/${clean.id}/download-url`)).status, 200);

  const mail = mailRepository.state.queue.filter((row) => row.templateId === 'file-infected-v1');
  assert.equal(mail.length, 1);
  assert.equal(mail[0].recipientEmail, 'user-member@acme.example');
  assert.match(mail[0].subject, /eicar\.txt/);
  const logged = changeLog.list({ projectId: PROJECT, tenantId: TENANT_ID }).entries.filter((entry) => entry.action === 'scanned');
  assert.deepEqual(logged.map((entry) => [entry.entityId, entry.detail.scanStatus]).sort(), [[clean.id, 'clean'], [infected.id, 'infected']].sort());
  assert.equal((await projectRepository.listPendingScanObjects()).length, 0);
});

test('with ClamAV down a file stays Scanning, the scanner turns degraded after an hour, and the file scans once ClamAV is back', async (t) => {
  let now = new Date('2026-11-14T10:00:00Z');
  const clock = () => now;
  const fileStorage = createMemoryLargeFileStorage();
  const { scanProcessor, send, upload } = await fixture(t, { clock, fileStorage });
  const port = await freePort();
  const processor = scanProcessor(createClamAvFileScanner({ host: '127.0.0.1', port, timeoutMs: 1000 }));
  const file = (await upload('member', Buffer.from('waiting'), { start: { contentType: 'text/plain', fileName: 'wait.txt' } })).body.file;

  assert.deepEqual((await processor.processBatch()).map((entry) => entry.status), ['pending']);
  assert.equal((await send('member', 'GET', `${P}/files/${file.id}/download-url`)).body.details.code, 'file_scanning');
  assert.deepEqual(await processor.processBatch(), [], 'backs off before trying again');
  now = new Date(now.getTime() + 61 * 60_000);
  assert.deepEqual((await processor.processBatch()).map((entry) => entry.status), ['pending']);
  assert.equal(processor.isDegraded(), true, 'an hour of failures is reported');
  assert.equal((await send('member', 'GET', `${P}/files?targetId=${PROJECT}&targetType=project`)).body.files[0].scanStatus, 'pending', 'never failed for ClamAV being down');

  const clamd = await startFakeClamd({ port });
  t.after(() => clamd.close());
  now = new Date(now.getTime() + 10 * 60_000);
  assert.deepEqual((await processor.processBatch()).map((entry) => entry.status), ['clean']);
  assert.equal(processor.isDegraded(), false);
  assert.equal((await send('member', 'GET', `${P}/files/${file.id}/download-url`)).status, 200);
});

test('a file ClamAV cannot scan is retried, then marked failed, and never downloads', async (t) => {
  let now = new Date('2026-11-14T10:00:00Z');
  const fileStorage = createMemoryLargeFileStorage();
  const { scanProcessor, send, upload } = await fixture(t, { clock: () => now, fileStorage });
  const failing = { enabled: true, async scanStream(stream) { for await (const chunk of stream) void chunk; throw Object.assign(new Error('INSTREAM size limit exceeded. ERROR'), { code: 'scan_error' }); } };
  const processor = scanProcessor(failing, { maxAttempts: 3 });
  const file = (await upload('member', Buffer.from('odd'), { start: { fileName: 'odd.bin' } })).body.file;
  const statuses = [];
  for (let round = 0; round < 3; round += 1) {
    statuses.push(...(await processor.processBatch()).map((entry) => entry.status));
    now = new Date(now.getTime() + 30 * 60_000);
  }
  assert.deepEqual(statuses, ['retry', 'retry', 'failed']);
  const refused = await send('member', 'GET', `${P}/files/${file.id}/download-url`);
  assert.deepEqual([refused.status, refused.body.details.code], [409, 'file_scan_failed']);
});

test('decision rights delete old versions, never the current one or one a signature request or legal hold keeps', async (t) => {
  const pinned = new Set();
  const signingRepository = {
    async isStorageKeyPinned() { return false; },
    async listFileVersionPins() { return [...pinned].map((version) => ({ storageKey: 'kept', version })); },
    async listProtectedFileIds() { return []; },
  };
  const fileStorage = createMemoryLargeFileStorage();
  const { base64Upload, changeLog, scanProcessor, send, upload } = await fixture(t, { fileStorage, signingRepository });
  const file = await base64Upload('member', { contents: 'v1 contents', fileName: 'sow.txt' });
  await send('member', 'POST', `${P}/files/${file.id}/versions`, { expectedVersion: 1, fileContentsBase64: Buffer.from('v2 contents, longer').toString('base64') });
  await upload('member', Buffer.from('v3 from the large path'), { start: { contentType: 'text/plain', expectedVersion: 2, fileId: file.id, fileName: 'sow.txt' } });
  await scanProcessor().processBatch();
  const before = (await send('member', 'GET', `${P}/file-storage`)).body;
  assert.equal(before.canDeleteVersions, false, 'members without decision rights do not delete versions');
  assert.equal(before.storage.bytes, 'v1 contents'.length + 'v2 contents, longer'.length + 'v3 from the large path'.length);
  assert.deepEqual([before.storage.files, before.storage.versions], [1, 3]);
  assert.equal((await send('admin', 'GET', `${P}/file-storage`)).body.canDeleteVersions, true);

  assert.equal((await send('member', 'DELETE', `${P}/files/${file.id}/versions/1`)).status, 404, 'a member gets what a missing project gets');
  const current = await send('admin', 'DELETE', `${P}/files/${file.id}/versions/3`);
  assert.deepEqual([current.status, current.body.details.code], [409, 'current_version']);
  pinned.add(2);
  const signed = await send('admin', 'DELETE', `${P}/files/${file.id}/versions/2`);
  assert.deepEqual([signed.status, signed.body.details.code], [409, 'version_under_signature']);

  const keysBefore = fileStorage.objects.size;
  const deleted = await send('admin', 'DELETE', `${P}/files/${file.id}/versions/1`);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(deleted.body.storage.bytes, before.storage.bytes - 'v1 contents'.length, 'storage used drops');
  assert.equal(fileStorage.objects.size, keysBefore - 1, 'its object is deleted');
  assert.equal((await send('admin', 'DELETE', `${P}/files/${file.id}/versions/1`)).status, 404, 'once');
  const versions = (await send('member', 'GET', `${P}/files/${file.id}/versions`)).body.versions;
  assert.ok(versions.find((entry) => entry.version === 1).deletedAt, 'the row stays, marked deleted');
  assert.equal((await send('member', 'GET', `${P}/files/${file.id}/download-url?version=1`)).status, 404);
  assert.equal((await send('member', 'POST', `${P}/files/${file.id}/versions/1/restore`, { expectedVersion: 3 })).body.details.code, 'version_unavailable');
  assert.equal((await send('member', 'GET', `${P}/files/${file.id}/download-url?version=2`)).status, 200, 'other versions download unchanged');
  assert.ok(changeLog.list({ projectId: PROJECT, tenantId: TENANT_ID }).entries.some((entry) => entry.action === 'version_delete' && entry.detail.deletedVersion === 1));

  pinned.clear();
  assert.equal((await send('admin', 'POST', '/api/compliance/legal-holds', { reason: 'Preserve this file as legal evidence.', resourceId: file.id, resourceType: 'file' })).status, 201);
  assert.equal((await send('admin', 'DELETE', `${P}/files/${file.id}/versions/2`)).status, 423, 'a legal hold keeps it');
});

test('a restored version shares its object, so deleting the older row leaves the object in place', async (t) => {
  const fileStorage = createMemoryLargeFileStorage();
  const { base64Upload, send } = await fixture(t, { fileStorage });
  const file = await base64Upload('member', { contents: 'original', fileName: 'brief.txt' });
  await send('member', 'POST', `${P}/files/${file.id}/versions`, { expectedVersion: 1, fileContentsBase64: Buffer.from('changed').toString('base64') });
  await send('member', 'POST', `${P}/files/${file.id}/versions/1/restore`, { expectedVersion: 2 });
  await send('member', 'POST', `${P}/files/${file.id}/versions`, { expectedVersion: 3, fileContentsBase64: Buffer.from('newest').toString('base64') });
  const objects = fileStorage.objects.size;
  assert.equal((await send('admin', 'DELETE', `${P}/files/${file.id}/versions/1`)).status, 200);
  assert.equal(fileStorage.objects.size, objects, 'version 3 still holds the bytes of version 1');
  const restored = await send('member', 'GET', `${P}/files/${file.id}/download-url?version=3`);
  assert.equal(restored.status, 200);
});

test('signing uses the stored SHA-256 without reading the file, and refuses a file whose scan has not passed', async (t) => {
  const fileStorage = createMemoryLargeFileStorage();
  const { projectRepository, scanProcessor, upload } = await fixture(t, { fileStorage });
  const bytes = randomBytes(64 * 1024);
  const file = (await upload('member', bytes, { start: { contentType: 'application/pdf', fileName: 'contract.pdf' } })).body.file;
  await assert.rejects(projectRepository.getFileVersionSource({ fileId: file.id, includeBytes: false, tenantId: TENANT_ID }), (error) => error.statusCode === 409 && error.details.code === 'file_scanning');
  await scanProcessor().processBatch();
  const reads = fileStorage.calls.length;
  const source = await projectRepository.getFileVersionSource({ fileId: file.id, includeBytes: false, tenantId: TENANT_ID });
  assert.equal(source.sha256, sha256(bytes));
  assert.equal(source.bytes, undefined);
  assert.equal(source.fileSize, bytes.length);
  assert.equal(fileStorage.calls.length, reads, 'nothing was read from storage');
});

test('uploads left open for 24 hours are aborted by the job', async (t) => {
  let now = new Date('2026-11-14T10:00:00Z');
  const { projectRepository, putPart, root, send, startUpload, storage } = await fixture(t, { clock: () => now });
  const bytes = randomBytes(2048);
  const open = await startUpload('member', bytes);
  const [part] = (await send('member', 'POST', `${P}/uploads/${open.id}/parts`, { partNumbers: [1] })).body.parts;
  assert.equal((await putPart(part.url, bytes)).status, 200);
  const deps = { clock: () => now, fileStorage: storage, projectRepository };
  assert.equal(await abortExpiredUploads(deps), 0, 'not yet');
  now = new Date(now.getTime() + 24 * 60 * 60 * 1000 + 1000);
  assert.equal(await abortExpiredUploads(deps), 1);
  assert.equal((await send('member', 'GET', `${P}/uploads/${open.id}`)).body.upload.status, 'expired');
  assert.deepEqual(await readdir(path.join(root, '.uploads')), [], 'its parts are gone');
  assert.equal((await send('member', 'POST', `${P}/uploads/${open.id}/complete`, {})).body.details.code, 'upload_closed');
  assert.equal(await abortExpiredUploads(deps), 0, 'once');
});

test('signed downloads go inline only for safe types and video; ranges parse as HTTP has them', () => {
  assert.match(downloadDisposition('a.mp4', { contentType: 'video/mp4', inline: true }), /^inline; /);
  assert.match(downloadDisposition('a.webm', { contentType: 'video/webm', inline: true }), /^inline; /);
  assert.match(downloadDisposition('a.pdf', { contentType: 'application/pdf', inline: true }), /^inline; /);
  assert.match(downloadDisposition('a.html', { contentType: 'text/html', inline: true }), /^attachment; /);
  assert.match(downloadDisposition('a.svg', { contentType: 'image/svg+xml', inline: true }), /^attachment; /);
  assert.match(downloadDisposition('a.pdf', { contentType: 'application/pdf' }), /^attachment; /);
  assert.equal(downloadDisposition('a\r\nb.txt').includes('\r'), false);
  assert.deepEqual(parseByteRange('bytes=0-9', 100), { end: 9, start: 0 });
  assert.deepEqual(parseByteRange('bytes=90-', 100), { end: 99, start: 90 });
  assert.deepEqual(parseByteRange('bytes=-10', 100), { end: 99, start: 90 });
  assert.deepEqual(parseByteRange('bytes=95-500', 100), { end: 99, start: 95 });
  assert.equal(parseByteRange('bytes=100-', 100), 'invalid');
  assert.equal(parseByteRange(undefined, 100), null);
  assert.equal(parseByteRange('bytes=0-1,5-6', 100), null, 'several ranges get the whole file');
});
