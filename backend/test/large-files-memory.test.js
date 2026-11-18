import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import http, { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createNoopFileScanner } from '../src/lib/files/file-scanner.js';
import { createLocalFileStorage } from '../src/lib/files/file-storage.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';
import { createFileScanProcessor } from '../src/modules/vault/file-scan-worker.js';

// AC-04's memory check on local storage: a large upload through the part route, its assembly,
// its scan and hash, and its download all stream, so the process heap does not grow with the
// file. ODIN_LARGE_FILE_MEMORY_MB sets the size (default 256 MB).

const TENANT_ID = 'tenant-acme';
const PROJECT = 'project-1';
const MiB = 1024 * 1024;
const SIZE = Number(process.env.ODIN_LARGE_FILE_MEMORY_MB || 256) * MiB;
// The heap may grow by this much at most. A file held in memory would add its whole size.
const HEAP_GROWTH_LIMIT = 48 * MiB;

// The same 1 MiB block, over and over, so making the file allocates nothing as it goes.
const block = randomBytes(MiB);
function syntheticStream(bytes) {
  let sent = 0;
  return new Readable({
    read() {
      if (sent >= bytes) {
        this.push(null);
        return;
      }
      const length = Math.min(MiB, bytes - sent);
      sent += length;
      this.push(length === MiB ? block : block.subarray(0, length));
    },
  });
}

function expectedHash(size) {
  const hash = createHash('sha256');
  for (let sent = 0; sent < size; sent += MiB) hash.update(block.subarray(0, Math.min(MiB, size - sent)));
  return hash.digest('hex');
}

function sampleMemory() {
  const samples = { heapUsed: 0, rss: 0 };
  const take = () => {
    const usage = process.memoryUsage();
    samples.heapUsed = Math.max(samples.heapUsed, usage.heapUsed);
    samples.rss = Math.max(samples.rss, usage.rss);
  };
  const timer = setInterval(take, 20);
  return { stop() { clearInterval(timer); take(); return samples; } };
}

function request(url, { body = null, headers = {}, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(url, { headers, method }, resolve);
    outgoing.on('error', reject);
    if (body) pipeline(body, outgoing).catch(reject);
    else outgoing.end();
  });
}

test(`a ${SIZE / MiB} MB upload, scan and download stream through local storage without growing the heap`, { timeout: 600_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'odin-large-memory-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const storage = createLocalFileStorage({ rootDir: root });
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['acme.example'], id: TENANT_ID, name: 'Acme' }],
    users: [{ authMethod: 'basic', email: 'ada@acme.example', id: 'user-ada', memberships: [{ role: 'admin', tenantId: TENANT_ID }], name: 'Ada', password: 'Fixture-password-123!', preferences: { twoFactorEnabled: false } }],
  });
  const projectRepository = createInMemoryProjectsRepository({ authRepository, fileStorage: storage, seed: { projects: [{ epics: [], id: PROJECT, name: 'One', status: 'In Progress', tenantId: TENANT_ID }] } });
  const sessionsRepository = createInMemorySessionsRepository();
  const tokenService = createTokenService({ issuer: 'large-memory-fixture', secret: 'disposable-large-memory-secret' });
  const app = createApp({
    accessReviewCampaignSweepIntervalMs: 0, agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0, domainEventSweepIntervalMs: 0,
    changeSettleMs: 0, reportSubscriptionSweepIntervalMs: 0, reportingWarehouseSweepIntervalMs: 0, webhookSweepIntervalMs: 0, workflowAutomationSweepIntervalMs: 0,
    authRepository, fileStorage: storage, projectRepository, sessionsRepository, tokenService,
  });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await app.locals.beginDrain({ timeoutMs: 1000 });
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const token = tokenService.signSessionToken({ email: 'ada@acme.example', id: 'user-ada', name: 'Ada', preferences: {}, role: 'admin', tenantId: TENANT_ID });
  await sessionsRepository.createSession({ expiryDate: new Date(Date.now() + 3600_000), ipAddr: '127.0.0.1', locationName: 'Loopback', token, userAgent: 'fixture', userId: 'user-ada' });
  const api = async (method, route, body) => {
    const response = await fetch(`${origin}${route}`, { body: body ? JSON.stringify(body) : undefined, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, method });
    return { body: await response.json(), status: response.status };
  };

  globalThis.gc?.();
  const baseline = process.memoryUsage();
  const sampler = sampleMemory();
  const started = await api('POST', `/api/projects/${PROJECT}/uploads`, { contentType: 'video/mp4', fileName: 'film.mp4', fileSize: SIZE, targetId: PROJECT, targetType: 'project' });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const { id, partCount, partSize } = started.body.upload;
  for (let first = 1; first <= partCount; first += 100) {
    const numbers = Array.from({ length: Math.min(100, partCount - first + 1) }, (_, index) => first + index);
    const { body } = await api('POST', `/api/projects/${PROJECT}/uploads/${id}/parts`, { partNumbers: numbers });
    for (const part of body.parts) {
      const length = Math.min(partSize, SIZE - (part.partNumber - 1) * partSize);
      const response = await request(`${origin}${part.url}`, { body: syntheticStream(length), headers: { 'Content-Length': String(length), 'Content-Type': 'application/octet-stream' }, method: 'PUT' });
      response.resume();
      assert.equal(response.statusCode, 200);
    }
  }
  const completed = await api('POST', `/api/projects/${PROJECT}/uploads/${id}/complete`, {});
  assert.equal(completed.status, 201, JSON.stringify(completed.body));

  const scanned = await createFileScanProcessor({ projectRepository, scanner: createNoopFileScanner(), storage }).processBatch();
  assert.deepEqual(scanned.map((entry) => entry.status), ['clean']);

  const link = await api('GET', `/api/projects/${PROJECT}/files/${completed.body.file.id}/download-url`);
  const download = await request(`${origin}${link.body.url}`);
  assert.equal(download.statusCode, 200);
  const hash = createHash('sha256');
  let received = 0;
  for await (const chunk of download) {
    hash.update(chunk);
    received += chunk.length;
  }
  const peak = sampler.stop();

  const heapGrowth = peak.heapUsed - baseline.heapUsed;
  const rssGrowth = peak.rss - baseline.rss;
  t.diagnostic(`file ${SIZE / MiB} MB; heap ${Math.round(baseline.heapUsed / MiB)} -> peak ${Math.round(peak.heapUsed / MiB)} MB (+${Math.round(heapGrowth / MiB)}); rss ${Math.round(baseline.rss / MiB)} -> peak ${Math.round(peak.rss / MiB)} MB (+${Math.round(rssGrowth / MiB)})`);
  assert.equal(received, SIZE);
  const sha256 = expectedHash(SIZE);
  assert.equal(hash.digest('hex'), sha256, 'the file downloads intact');
  assert.equal((await projectRepository.getFileRecord({ fileId: completed.body.file.id, tenantId: TENANT_ID })).sha256, sha256, 'the scan hashed it in the same pass');
  assert.ok(heapGrowth < HEAP_GROWTH_LIMIT, `heap grew ${Math.round(heapGrowth / MiB)} MB for a ${SIZE / MiB} MB file`);
  assert.ok(rssGrowth < SIZE / 2, `rss grew ${Math.round(rssGrowth / MiB)} MB for a ${SIZE / MiB} MB file`);
});
