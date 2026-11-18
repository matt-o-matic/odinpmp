import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryComplianceRepository } from '../src/modules/compliance/compliance.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';
import { FILE_TEXT_MAX_BYTES } from '../src/modules/vault/vault.service.js';

// The vault routes the file tools use: reading a file as text, deleting a file named by its
// project, and an upload that would overwrite a held file. Repositories are in memory.

const TENANT_ID = 'tenant-acme';
const USERS = {
  admin: { id: 'user-admin', role: 'admin' },
  member: { id: 'user-member', role: 'user' },
  viewer: { id: 'user-viewer', role: 'user' },
  outsider: { id: 'user-outsider', role: 'user' },
};

async function fixture(t) {
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['acme.example'], id: TENANT_ID, name: 'Acme' }],
    users: Object.values(USERS).map((user) => ({ authMethod: 'basic', email: `${user.id}@acme.example`, id: user.id, memberships: [{ role: user.role, tenantId: TENANT_ID }], name: user.id, password: 'Fixture-password-123!', preferences: { twoFactorEnabled: false } })),
  });
  const projectRepository = createInMemoryProjectsRepository({ authRepository, seed: {
    projectMemberships: {
      'project-1': [{ id: USERS.member.id, role: 'user' }, { id: USERS.viewer.id, role: 'viewer' }],
      'project-2': [{ id: USERS.member.id, role: 'user' }],
    },
    projects: ['project-1', 'project-2'].map((id) => ({ epics: [], id, name: id, status: 'In Progress', tenantId: TENANT_ID })),
  } });
  const sessionsRepository = createInMemorySessionsRepository();
  const tokenService = createTokenService({ issuer: 'mcp-file-api-fixture', secret: 'disposable-file-api-secret' });
  const app = createApp({
    accessReviewCampaignSweepIntervalMs: 0, agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0, domainEventSweepIntervalMs: 0,
    reportSubscriptionSweepIntervalMs: 0, reportingWarehouseSweepIntervalMs: 0, webhookSweepIntervalMs: 0, workflowAutomationSweepIntervalMs: 0,
    authRepository, complianceRepository: createInMemoryComplianceRepository(), projectRepository, sessionsRepository, tokenService,
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
  async function send(as, method, path, body) {
    const response = await fetch(`${origin}${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Authorization: `Bearer ${tokens[as]}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      method,
    });
    return { body: await response.json().catch(() => null), status: response.status };
  }
  async function upload(as, { contents, fileName, fileType = 'text/plain', projectId = 'project-1' }) {
    const response = await send(as, 'POST', `/api/projects/${projectId}/files`, {
      fileContentsBase64: Buffer.from(contents).toString('base64'), fileName, fileType, targetId: projectId, targetType: 'project',
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.file;
  }
  return { projectRepository, send, upload };
}

test('a text file reads back as text a window at a time, with line endings and BOM normalised', async (t) => {
  const { send, upload } = await fixture(t);
  const file = await upload('member', { contents: '\uFEFF# Notes\r\nLine two\r\nété \u{1F680} end', fileName: 'notes.md', fileType: 'text/markdown' });
  const whole = await send('viewer', 'GET', `/api/projects/project-1/files/${file.id}/text`);
  assert.equal(whole.status, 200, JSON.stringify(whole.body));
  assert.deepEqual(whole.body.text, { content: '# Notes\nLine two\nété \u{1F680} end', end: 27, nextOffset: null, offset: 0, totalChars: 27 });
  assert.equal(whole.body.file.fileName, 'notes.md');

  const first = await send('viewer', 'GET', `/api/projects/project-1/files/${file.id}/text?maxChars=7`);
  assert.deepEqual([first.body.text.content, first.body.text.nextOffset], ['# Notes', 7]);
  // A window never ends on half a surrogate pair.
  const split = await send('viewer', 'GET', `/api/projects/project-1/files/${file.id}/text?offset=17&maxChars=5`);
  assert.deepEqual([split.body.text.content, split.body.text.nextOffset], ['été ', 21]);
  const rest = await send('viewer', 'GET', `/api/projects/project-1/files/${file.id}/text?offset=21`);
  assert.deepEqual([rest.body.text.content, rest.body.text.nextOffset], ['\u{1F680} end', null]);
  assert.equal((await send('viewer', 'GET', `/api/projects/project-1/files/${file.id}/text?maxChars=50001`)).status, 400);
});

test('binary and oversized files are refused rather than returned garbled', async (t) => {
  const { projectRepository, send, upload } = await fixture(t);
  const image = await upload('member', { contents: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), fileName: 'diagram.png', fileType: 'image/png' });
  const disguised = await upload('member', { contents: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]), fileName: 'notes.txt' });
  for (const file of [image, disguised]) {
    const refused = await send('member', 'GET', `/api/projects/project-1/files/${file.id}/text`);
    assert.equal(refused.status, 415, file.fileName);
  }
  const big = await projectRepository.saveFile({
    fileContentsBase64: Buffer.alloc(FILE_TEXT_MAX_BYTES + 1, 'a').toString('base64'), fileDescription: '', fileName: 'big.log', fileType: 'text/plain',
    inlineImage: false, projectId: 'project-1', targetId: 'project-1', targetType: 'project', tenantId: TENANT_ID, user: { id: USERS.member.id, name: 'member' },
  });
  assert.equal((await send('member', 'GET', `/api/projects/project-1/files/${big.id}/text`)).status, 413);
});

test('the text read and the project delete hold a file to the project the path names', async (t) => {
  const { send, upload } = await fixture(t);
  const file = await upload('member', { contents: 'Minutes', fileName: 'minutes.txt' });
  assert.equal((await send('member', 'GET', `/api/projects/project-2/files/${file.id}/text`)).status, 404);
  assert.equal((await send('member', 'DELETE', `/api/projects/project-2/files/${file.id}`)).status, 404);
  assert.equal((await send('outsider', 'GET', `/api/projects/project-1/files/${file.id}/text`)).status, 404);
  assert.equal((await send('member', 'GET', '/api/projects/project-1/files/missing/text')).status, 404);
  assert.notEqual((await send('viewer', 'DELETE', `/api/projects/project-1/files/${file.id}`)).status, 200);
  assert.equal((await send('member', 'GET', `/api/projects/project-1/files/${file.id}/text`)).status, 200, 'still there');

  const deleted = await send('member', 'DELETE', `/api/projects/project-1/files/${file.id}`);
  assert.deepEqual([deleted.status, deleted.body.deletedFileId], [200, file.id]);
  assert.equal((await send('member', 'GET', `/api/projects/project-1/files/${file.id}/text`)).status, 404);
});

test('a legal hold blocks the project delete and an upload that would overwrite the held file', async (t) => {
  const { send, upload } = await fixture(t);
  const held = await upload('admin', { contents: 'Evidence v1', fileName: 'evidence.txt' });
  const hold = await send('admin', 'POST', '/api/compliance/legal-holds', { reason: 'Preserve this file as legal evidence.', resourceId: held.id, resourceType: 'file' });
  assert.equal(hold.status, 201, JSON.stringify(hold.body));

  assert.equal((await send('admin', 'DELETE', `/api/projects/project-1/files/${held.id}`)).status, 423);
  const overwrite = await send('admin', 'POST', '/api/projects/project-1/files', {
    fileContentsBase64: Buffer.from('Evidence v2').toString('base64'), fileName: 'EVIDENCE.txt', fileType: 'text/plain', targetId: 'project-1', targetType: 'project',
  });
  assert.equal(overwrite.status, 423);
  await upload('admin', { contents: 'Other notes', fileName: 'other.txt' });
  const read = await send('admin', 'GET', `/api/projects/project-1/files/${held.id}/text`);
  assert.equal(read.body.text.content, 'Evidence v1');
});
