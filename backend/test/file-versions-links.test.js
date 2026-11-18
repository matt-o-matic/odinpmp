import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import JSZip from 'jszip';
import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryComplianceRepository } from '../src/modules/compliance/compliance.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';
import { fileContentDisposition } from '../src/modules/vault/vault.service.js';

// Downloading a file, keeping its versions, and linking it to work items, through Odin's own
// routes on in-memory repositories. file-versions-mysql.integration.test.js runs the same flow on
// MySQL.

const TENANT_ID = 'tenant-acme';
const P = '/api/projects/project-1';
const USERS = {
  admin: { id: 'user-admin', role: 'admin' },
  member: { id: 'user-member', role: 'user' },
  viewer: { id: 'user-viewer', role: 'user' },
};

const base64 = (text) => Buffer.from(text).toString('base64');

async function fixture(t) {
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['acme.example'], id: TENANT_ID, name: 'Acme' }],
    users: Object.values(USERS).map((user) => ({ authMethod: 'basic', email: `${user.id}@acme.example`, id: user.id, memberships: [{ role: user.role, tenantId: TENANT_ID }], name: user.id, password: 'Fixture-password-123!', preferences: { twoFactorEnabled: false } })),
  });
  const epic = (id) => ({ id: `epic-${id}`, name: `Epic ${id}`, stories: [{ id: `story-${id}`, name: `Story ${id}`, tasks: [{ id: `task-${id}`, name: `Task ${id}` }] }] });
  const projectRepository = createInMemoryProjectsRepository({ authRepository, seed: {
    projectMemberships: {
      'project-1': [{ id: USERS.member.id, role: 'user' }, { id: USERS.viewer.id, role: 'viewer' }],
      'project-2': [{ id: USERS.member.id, role: 'user' }],
    },
    projects: [
      { epics: [epic('1')], id: 'project-1', name: 'One', status: 'In Progress', tenantId: TENANT_ID, tickets: [
        { externalReviewState: 'pending', id: 'ticket-hidden', name: 'From outside' },
        { externalReviewState: 'validated', id: 'ticket-shown', name: 'Checked' },
      ] },
      { epics: [epic('2')], id: 'project-2', name: 'Two', status: 'In Progress', tenantId: TENANT_ID },
    ],
  } });
  const sessionsRepository = createInMemorySessionsRepository();
  const tokenService = createTokenService({ issuer: 'file-versions-fixture', secret: 'disposable-file-versions-secret' });
  const app = createApp({
    accessReviewCampaignSweepIntervalMs: 0, agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0, domainEventSweepIntervalMs: 0,
    changeSettleMs: 0, frontendAppUrl: 'https://app.example/app', reportSubscriptionSweepIntervalMs: 0, reportingWarehouseSweepIntervalMs: 0, webhookSweepIntervalMs: 0, workflowAutomationSweepIntervalMs: 0,
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
  async function content(as, path) {
    const response = await fetch(`${origin}${path}`, { headers: { Authorization: `Bearer ${tokens[as]}` } });
    return { disposition: response.headers.get('content-disposition'), nosniff: response.headers.get('x-content-type-options'), status: response.status, text: await response.text(), type: response.headers.get('content-type') };
  }
  async function upload(as, { contents = 'one', fileName = 'spec.txt', fileType = 'text/plain', projectId = 'project-1', targetId = projectId, targetType = 'project' } = {}) {
    const response = await send(as, 'POST', `/api/projects/${projectId}/files`, { fileContentsBase64: base64(contents), fileName, fileType, targetId, targetType });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.file;
  }
  return { content, projectRepository, send, upload };
}

test('a file downloads under its own name, and types a browser would run never show inline', async (t) => {
  const { content, upload } = await fixture(t);
  const file = await upload('member', { contents: 'hello', fileName: 'Résumé "final".txt' });
  const shown = await content('viewer', `/api/files/${file.id}/content`);
  assert.equal(shown.status, 200);
  assert.equal(shown.text, 'hello');
  assert.match(shown.disposition, /^inline; /);
  assert.equal(shown.nosniff, 'nosniff');
  const saved = await content('viewer', `/api/files/${file.id}/content?download=1`);
  assert.match(saved.disposition, /^attachment; filename="R_sum_ _final_\.txt"; filename\*=UTF-8''R%C3%A9sum%C3%A9%20%22final%22\.txt$/);

  const page = await upload('member', { contents: '<script>alert(1)</script>', fileName: 'page.html', fileType: 'text/html' });
  assert.match((await content('viewer', `/api/files/${page.id}/content`)).disposition, /^attachment; /);
  const drawing = await upload('member', { contents: '<svg/>', fileName: 'x.svg', fileType: 'image/svg+xml' });
  assert.match((await content('viewer', `/api/files/${drawing.id}/content`)).disposition, /^attachment; /);
});

test('the disposition header cannot be split by a file name', () => {
  assert.equal(fileContentDisposition('a\r\nSet-Cookie: x=1.txt', { contentType: 'text/plain' }).includes('\r'), false);
});

test('real documents fit: a file and a new version go well past the general JSON limit', async (t) => {
  const { content, send, upload } = await fixture(t);
  const file = await upload('member', { contents: 'a'.repeat(3 * 1024 * 1024), fileName: 'big.txt' });
  assert.equal(file.fileSize, 3 * 1024 * 1024);
  const next = await send('member', 'POST', `${P}/files/${file.id}/versions`, { expectedVersion: 1, fileContentsBase64: base64('b'.repeat(14 * 1024 * 1024)) });
  assert.equal(next.status, 201);
  assert.equal((await content('viewer', `/api/files/${file.id}/content`)).text.length, 14 * 1024 * 1024);
  assert.equal((await send('member', 'POST', `${P}/items`, { padding: 'x'.repeat(2 * 1024 * 1024) })).status, 413, 'other routes keep the general limit');
});

test('a new version keeps the file, its id and every earlier version', async (t) => {
  const { content, send, upload } = await fixture(t);
  const file = await upload('member', { contents: 'first', fileName: 'spec.txt' });
  assert.equal(file.version, 1);

  const second = await send('member', 'POST', `${P}/files/${file.id}/versions`, { expectedVersion: 1, fileContentsBase64: base64('second!'), fileName: 'spec-v2.txt', note: 'Added scope' });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.deepEqual([second.body.file.id, second.body.file.version, second.body.file.fileName, second.body.file.versionNote], [file.id, 2, 'spec-v2.txt', 'Added scope']);

  assert.equal((await content('viewer', `/api/files/${file.id}/content`)).text, 'second!');
  const earlier = await content('viewer', `/api/files/${file.id}/content?version=1&download=1`);
  assert.equal(earlier.text, 'first');
  assert.match(earlier.disposition, /filename="spec\.txt"/, 'an earlier version keeps the name it had');
  assert.equal((await content('viewer', `/api/files/${file.id}/content?version=9`)).status, 404);

  const versions = await send('viewer', 'GET', `${P}/files/${file.id}/versions`);
  assert.deepEqual(versions.body.versions.map((entry) => [entry.version, entry.current, entry.fileName, entry.note]), [[2, true, 'spec-v2.txt', 'Added scope'], [1, false, 'spec.txt', '']]);

  const text = await send('viewer', 'GET', `${P}/files/${file.id}/text?version=1`);
  assert.deepEqual([text.body.text.content, text.body.file.version, text.body.file.fileName], ['first', 1, 'spec.txt']);
  assert.equal((await send('viewer', 'GET', `${P}/files/${file.id}/text`)).body.text.content, 'second!');
});

test('a new version is refused when someone got there first, and identical contents save nothing', async (t) => {
  const { send, upload } = await fixture(t);
  const file = await upload('member', { contents: 'first' });
  const version = (expectedVersion, contents, extra = {}) => send('member', 'POST', `${P}/files/${file.id}/versions`, { expectedVersion, fileContentsBase64: base64(contents), ...extra });

  const same = await version(1, 'first');
  assert.deepEqual([same.status, same.body.unchanged, same.body.file.version], [200, true, 1]);
  assert.equal((await version(1, 'second')).status, 201);
  const stale = await version(1, 'third');
  assert.deepEqual([stale.status, stale.body.error?.details?.code ?? stale.body.details?.code], [409, 'file_changed']);

  await upload('member', { contents: 'other', fileName: 'other.txt' });
  const taken = await version(2, 'third', { fileName: 'OTHER.txt' });
  assert.equal(taken.status, 409, 'a new name may not take another file\'s');
});

test('uploading under a name already there is the next version, never a lost file', async (t) => {
  const { content, send, upload } = await fixture(t);
  const file = await upload('member', { contents: 'first', fileName: 'spec.txt' });
  const again = await upload('member', { contents: 'second', fileName: 'spec.txt' });
  assert.deepEqual([again.id, again.version], [file.id, 2]);
  assert.equal((await content('viewer', `/api/files/${file.id}/content?version=1`)).text, 'first');
  const same = await upload('member', { contents: 'second', fileName: 'spec.txt' });
  assert.equal(same.version, 2, 'the same contents add no version');
  assert.equal((await send('viewer', 'GET', `${P}/files?targetId=project-1&targetType=project`)).body.files.length, 1);
});

test('restoring brings back an earlier version as a new one, so nothing is lost', async (t) => {
  const { content, send, upload } = await fixture(t);
  const file = await upload('member', { contents: 'first', fileName: 'spec.txt' });
  await send('member', 'POST', `${P}/files/${file.id}/versions`, { expectedVersion: 1, fileContentsBase64: base64('second'), fileName: 'renamed.txt' });

  assert.equal((await send('member', 'POST', `${P}/files/${file.id}/versions/1/restore`, { expectedVersion: 1 })).status, 409);
  assert.equal((await send('member', 'POST', `${P}/files/${file.id}/versions/7/restore`, { expectedVersion: 2 })).status, 404);
  const restored = await send('member', 'POST', `${P}/files/${file.id}/versions/1/restore`, { expectedVersion: 2 });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.deepEqual([restored.body.file.version, restored.body.file.fileName, restored.body.file.versionNote], [3, 'spec.txt', 'Restored from version 1']);
  assert.equal((await content('viewer', `/api/files/${file.id}/content`)).text, 'first');
  assert.equal((await content('viewer', `/api/files/${file.id}/content?version=2`)).text, 'second');
});

test('a file linked to an item shows on the item and in the vault, and unlinking leaves it', async (t) => {
  const { send, upload } = await fixture(t);
  const vaultFile = await upload('member', { contents: 'sow', fileName: 'sow.pdf', fileType: 'application/pdf' });
  const ownFile = await upload('member', { contents: 'mock', fileName: 'mock.txt', targetId: 'story-1', targetType: 'story' });

  const link = await send('member', 'POST', `${P}/files/${vaultFile.id}/links`, { targetId: 'story-1', targetType: 'story' });
  assert.equal(link.status, 201, JSON.stringify(link.body));
  assert.deepEqual(link.body.file.links.map(({ targetId, targetName, targetType }) => ({ targetId, targetName, targetType })), [{ targetId: 'story-1', targetName: 'Story 1', targetType: 'story' }]);

  const again = await send('member', 'POST', `${P}/files/${vaultFile.id}/links`, { targetId: 'story-1', targetType: 'story' });
  assert.deepEqual([again.status, again.body.linked, again.body.file.links.length], [200, false, 1]);
  const home = await send('member', 'POST', `${P}/files/${ownFile.id}/links`, { targetId: 'story-1', targetType: 'story' });
  assert.deepEqual([home.body.linked, home.body.file.links.length], [false, 0], 'a file is already on the item it was uploaded to');

  const onStory = await send('viewer', 'GET', `${P}/files?targetId=story-1&targetType=story`);
  assert.deepEqual(onStory.body.files.map((file) => file.fileName).sort(), ['mock.txt', 'sow.pdf']);
  assert.equal((await send('viewer', 'GET', `${P}/files?targetId=task-1&targetType=task`)).body.files.length, 0);

  const vault = await send('viewer', 'GET', `${P}/files?targetId=project-1&targetType=project`);
  assert.equal(vault.body.files.length, 2, 'the vault lists every file once');
  assert.equal(vault.body.files.find((file) => file.id === ownFile.id).targetName, 'Story 1');

  const linkId = link.body.file.links[0].id;
  assert.equal((await send('member', 'DELETE', `${P}/files/${ownFile.id}/links/${linkId}`)).status, 404, 'a link belongs to its file');
  const removed = await send('member', 'DELETE', `${P}/files/${vaultFile.id}/links/${linkId}`);
  assert.deepEqual([removed.status, removed.body.file.links], [200, []]);
  assert.equal((await send('viewer', 'GET', `${P}/files?targetId=story-1&targetType=story`)).body.files.length, 1);
  assert.equal((await send('viewer', 'GET', `${P}/files?targetId=project-1&targetType=project`)).body.files.length, 2);
});

test('links stay inside the project, on work items, and within file permissions', async (t) => {
  const { send, upload } = await fixture(t);
  const file = await upload('member', { contents: 'sow' });
  const other = await upload('member', { contents: 'theirs', projectId: 'project-2' });

  assert.equal((await send('member', 'POST', `${P}/files/${file.id}/links`, { targetId: 'story-2', targetType: 'story' })).status, 400, 'an item in another project');
  assert.equal((await send('member', 'POST', `${P}/files/${file.id}/links`, { targetId: 'epic-1', targetType: 'story' })).status, 400, 'the wrong kind of item');
  assert.equal((await send('member', 'POST', `${P}/files/${file.id}/links`, { targetId: 'project-1', targetType: 'project' })).status, 400, 'the project needs no link');
  assert.equal((await send('member', 'POST', `${P}/files/${other.id}/links`, { targetId: 'story-1', targetType: 'story' })).status, 404, 'a file from another project');
  // Viewers get what they get from any write to files: not found.
  assert.equal((await send('viewer', 'POST', `${P}/files/${file.id}/links`, { targetId: 'story-1', targetType: 'story' })).status, 404);
  assert.equal((await send('viewer', 'POST', `${P}/files/${file.id}/versions`, { expectedVersion: 1, fileContentsBase64: base64('x') })).status, 404);
  assert.equal((await send('viewer', 'POST', `${P}/files/${file.id}/versions/1/restore`, { expectedVersion: 1 })).status, 404);

  const list = (as) => send(as, 'GET', `${P}/files?targetId=project-1&targetType=project`);
  assert.deepEqual([(await list('viewer')).body.canWrite, (await list('member')).body.canWrite], [false, true]);
});

test('a legal hold stops new versions and restores, as it stops a save over the file', async (t) => {
  const { send, upload } = await fixture(t);
  const file = await upload('member', { contents: 'first' });
  await send('member', 'POST', `${P}/files/${file.id}/versions`, { expectedVersion: 1, fileContentsBase64: base64('second') });
  assert.equal((await send('admin', 'POST', '/api/compliance/legal-holds', { reason: 'Preserve this file as legal evidence.', resourceId: file.id, resourceType: 'file' })).status, 201);
  assert.equal((await send('member', 'POST', `${P}/files/${file.id}/versions`, { expectedVersion: 2, fileContentsBase64: base64('third') })).status, 423);
  assert.equal((await send('member', 'POST', `${P}/files/${file.id}/versions/1/restore`, { expectedVersion: 2 })).status, 423);
  assert.equal((await send('member', 'DELETE', `${P}/files/${file.id}`)).status, 423);
});

test('deleting a file takes every version and link with it', async (t) => {
  const { content, projectRepository, send, upload } = await fixture(t);
  const file = await upload('member', { contents: 'first' });
  await send('member', 'POST', `${P}/files/${file.id}/versions`, { expectedVersion: 1, fileContentsBase64: base64('second') });
  await send('member', 'POST', `${P}/files/${file.id}/links`, { targetId: 'story-1', targetType: 'story' });
  assert.equal((await send('member', 'DELETE', `${P}/files/${file.id}`)).status, 200);
  assert.equal((await content('viewer', `/api/files/${file.id}/content?version=1`)).status, 404);
  assert.equal((await send('viewer', 'GET', `${P}/files?targetId=story-1&targetType=story`)).body.files.length, 0);
  assert.equal(await projectRepository.getFileRecord({ fileId: file.id, tenantId: TENANT_ID }), null);
});

test('agents never reach a hidden ticket through a link, and links to one stay out of their lists', async (t) => {
  const { send, upload } = await fixture(t);
  const file = await upload('member', { contents: 'sow' });
  const fromOutside = await upload('member', { contents: 'reporter text', fileName: 'report.txt', targetId: 'ticket-hidden', targetType: 'ticket' });

  // A person can link either way; agents get the file only as far as they could already.
  assert.equal((await send('member', 'POST', `${P}/files/${file.id}/links`, { targetId: 'ticket-hidden', targetType: 'ticket' })).status, 201);
  assert.equal((await send('member', 'POST', `${P}/files/${fromOutside.id}/links`, { targetId: 'story-1', targetType: 'story' })).status, 201);

  const asAgent = (path) => send('member', 'GET', `${P}${path}${path.includes('?') ? '&' : '?'}agentView=1`);
  const vault = await asAgent('/files?targetId=project-1&targetType=project');
  assert.deepEqual(vault.body.files.map((entry) => [entry.id, entry.links]), [[file.id, []]]);
  assert.deepEqual((await asAgent('/files?targetId=story-1&targetType=story')).body.files, []);
  assert.deepEqual((await asAgent('/files?targetId=ticket-hidden&targetType=ticket')).body.files, []);
  assert.equal((await asAgent(`/files/${fromOutside.id}/versions`)).status, 404);
  assert.equal((await asAgent(`/files/${fromOutside.id}/download`)).status, 404);

  assert.equal((await send('member', 'POST', `${P}/files/${file.id}/links?agentView=1`, { targetId: 'ticket-hidden', targetType: 'ticket' })).status, 400);
  assert.equal((await send('member', 'POST', `${P}/files/${file.id}/links?agentView=1`, { targetId: 'ticket-shown', targetType: 'ticket' })).status, 201);
  assert.equal((await send('member', 'POST', `${P}/files/${fromOutside.id}/versions?agentView=1`, { expectedVersion: 1, fileContentsBase64: base64('x') })).status, 404);
  assert.equal((await send('member', 'GET', `${P}/files?targetId=ticket-hidden&targetType=ticket`)).body.files.length, 2, 'people still see it all');
});

test('every file an agent gets back leaves out links to hidden tickets', async (t) => {
  const { send, upload } = await fixture(t);
  const file = await upload('member', { contents: 'sow', fileName: 'notes.txt' });
  await send('member', 'POST', `${P}/files/${file.id}/links`, { targetId: 'ticket-hidden', targetType: 'ticket' });
  const hiddenLink = (await send('member', 'GET', `${P}/files?targetId=project-1&targetType=project`)).body.files[0].links[0];
  const clean = (body) => {
    assert.doesNotMatch(JSON.stringify(body), /ticket-hidden|From outside/);
    return body;
  };
  const agent = (method, path, body) => send('member', method, `${P}${path}?agentView=1`, body);

  clean((await agent('GET', `/files/${file.id}/versions`)).body);
  clean((await agent('GET', `/files/${file.id}/download`)).body);
  clean((await agent('GET', `/files/${file.id}/text`)).body);
  clean((await agent('POST', `/files/${file.id}/links`, { targetId: 'story-1', targetType: 'story' })).body);
  clean((await agent('POST', `/files/${file.id}/versions`, { expectedVersion: 1, fileContentsBase64: base64('v2') })).body);
  clean((await agent('POST', `/files/${file.id}/versions/1/restore`, { expectedVersion: 2 })).body);
  clean((await agent('POST', '/files', { fileContentsBase64: base64('v4'), fileName: 'notes.txt', fileType: 'text/plain', targetId: 'project-1', targetType: 'project' })).body);
  const story = (await agent('GET', '/files', undefined));
  assert.equal(story.status, 400, 'a list names its target');

  assert.equal((await agent('DELETE', `/files/${file.id}/links/${hiddenLink.id}`)).status, 404, 'an agent cannot reach a link it cannot see');
  const list = await send('member', 'GET', `${P}/files?targetId=project-1&targetType=project`);
  assert.deepEqual(list.body.files[0].links.map((link) => link.targetId).sort(), ['story-1', 'ticket-hidden']);
  const storyLink = list.body.files[0].links.find((link) => link.targetId === 'story-1');
  clean((await agent('DELETE', `/files/${file.id}/links/${storyLink.id}`)).body);
});

test('a crafted archive reaches nothing of another tenant, and cannot pick storage keys', async (t) => {
  const { content, projectRepository, send, upload } = await fixture(t);
  const victim = await upload('member', { contents: 'their contract', fileName: 'contract.txt', projectId: 'project-2' });
  const file = await upload('admin', { contents: 'first' });
  await send('admin', 'POST', `${P}/files/${file.id}/versions`, { expectedVersion: 1, fileContentsBase64: base64('second') });
  const archive = await projectRepository.exportProjectArchiveData({ projectId: 'project-1', tenantId: TENANT_ID });
  const vaultFiles = () => new Map([...archive.files, ...archive.fileVersions].map((entry) => [entry.id, Buffer.from(entry.contentsBase64, 'base64')]));
  const run = (data, files = vaultFiles()) => projectRepository.importProjectArchiveData({ archiveData: structuredClone(data), overwriteMode: 'project', tenantId: TENANT_ID, user: { id: USERS.admin.id, name: 'admin' }, userMappings: [], vaultFiles: files });

  // A current file with someone else's stored name gets a key made here too.
  const sameKey = structuredClone(archive);
  sameKey.files[0].storageKey = victim.id;
  await run(sameKey);
  assert.equal((await content('member', `/api/files/${victim.id}/content`)).text, 'their contract');

  // A version whose id is someone else's file writes under a key made here.
  const crafted = structuredClone(archive);
  crafted.fileVersions[0].id = victim.id;
  crafted.fileVersions[0].contentsBase64 = base64('overwritten');
  await run(crafted, new Map([[crafted.files[0].id, Buffer.from('second')], [victim.id, Buffer.from('overwritten')]]));
  assert.equal((await content('member', `/api/files/${victim.id}/content`)).text, 'their contract');
  await send('admin', 'DELETE', `${P}/files/${file.id}`);
  assert.equal((await content('member', `/api/files/${victim.id}/content`)).text, 'their contract', 'deleting the import leaves their bytes');

  const orphan = structuredClone(archive);
  orphan.fileVersions[0].fileId = victim.id;
  await assert.rejects(run(orphan), /without its file/);
  const stray = structuredClone(archive);
  stray.fileLinks = [{ createdBy: USERS.admin.id, fileId: victim.id, id: 'link-x', targetId: 'story-1', targetType: 'story' }];
  await assert.rejects(run(stray), /without its file/);

  const elsewhere = structuredClone(archive);
  elsewhere.fileLinks = [{ createdBy: USERS.admin.id, fileId: archive.files[0].id, id: 'link-y', targetId: 'story-2', targetType: 'story' }];
  await run(elsewhere);
  assert.deepEqual((await send('admin', 'GET', `${P}/files?targetId=project-1&targetType=project`)).body.files[0].links, [], 'a link leaves its project for nothing');
});

test('the download route gives a link to the file, and small files themselves', async (t) => {
  const { send, upload } = await fixture(t);
  const file = await upload('member', { contents: 'first' });
  await send('member', 'POST', `${P}/files/${file.id}/versions`, { expectedVersion: 1, fileContentsBase64: base64('second') });

  const link = await send('viewer', 'GET', `${P}/files/${file.id}/download`);
  assert.equal(link.body.url, `https://app.example/app/projects/project-1?projectSettings=files&file=${file.id}`);
  assert.equal(link.body.contentBase64, undefined);
  const inline = await send('viewer', 'GET', `${P}/files/${file.id}/download?inline=1&version=1`);
  assert.deepEqual([Buffer.from(inline.body.contentBase64, 'base64').toString(), inline.body.file.version], ['first', 1]);
});

test('project changes log files, versions and links under the item they concern', async (t) => {
  const { projectRepository, send, upload } = await fixture(t);
  const file = await upload('member', { contents: 'first', targetId: 'story-1', targetType: 'story' });
  await send('member', 'POST', `${P}/files/${file.id}/versions`, { expectedVersion: 1, fileContentsBase64: base64('second'), note: 'Scope' });
  await send('member', 'POST', `${P}/files/${file.id}/versions/1/restore`, { expectedVersion: 2 });
  const link = await send('member', 'POST', `${P}/files/${file.id}/links`, { targetId: 'task-1', targetType: 'task' });
  await send('member', 'DELETE', `${P}/files/${file.id}/links/${link.body.file.links[0].id}`);
  await send('member', 'DELETE', `${P}/files/${file.id}`);
  const log = (await projectRepository.listProjectChanges({ afterSeq: 0, limit: 50, projectId: 'project-1', tenantId: TENANT_ID })).entries ?? [];
  assert.deepEqual(log.filter((entry) => entry.entityType === 'file').map((entry) => [entry.action, entry.itemId, entry.detail.version]), [
    ['create', 'story-1', 1], ['version', 'story-1', 2], ['restore', 'story-1', 3], ['link', 'task-1', 3], ['unlink', 'task-1', 3], ['delete', 'story-1', 3],
  ]);
});

test('the change feed says what happened to a file, and nothing of a hidden ticket\'s file', async (t) => {
  const { send, upload } = await fixture(t);
  const baseline = await send('member', 'GET', `${P}/changes`);
  assert.equal(baseline.status, 200, JSON.stringify(baseline.body));

  const shown = await upload('member', { contents: 'first', fileName: 'spec.txt', targetId: 'story-1', targetType: 'story' });
  await send('member', 'POST', `${P}/files/${shown.id}/versions`, { expectedVersion: 1, fileContentsBase64: base64('second'), note: 'Scope moved' });
  const secret = await upload('member', { contents: 'reporter text', fileName: 'Wire the refund.txt', targetId: 'ticket-hidden', targetType: 'ticket' });
  await send('member', 'POST', `${P}/files/${secret.id}/versions`, { expectedVersion: 1, fileContentsBase64: base64('more'), note: 'Reporter secret' });
  await send('member', 'POST', `${P}/files/${secret.id}/links`, { targetId: 'story-1', targetType: 'story' });
  await new Promise((resolve) => { setTimeout(resolve, 5); });

  const feed = await send('member', 'GET', `${P}/changes?cursor=${encodeURIComponent(baseline.body.cursor)}`);
  assert.equal(feed.status, 200, JSON.stringify(feed.body));
  const files = feed.body.changes.filter((change) => change.entity === 'file');
  assert.deepEqual(files.map((change) => [change.action, change.itemId, change.file.fileName ?? null, change.file.version, change.file.versionNote ?? null]), [
    ['create', 'story-1', 'spec.txt', 1, null],
    ['version', 'story-1', 'spec.txt', 2, 'Scope moved'],
    ['link', 'story-1', null, 2, null],
  ]);
  assert.doesNotMatch(JSON.stringify(feed.body), /Wire the refund|Reporter secret/);

  const details = await send('member', 'GET', `${P}/item-details?ids=story-1`);
  assert.equal(details.status, 200, JSON.stringify(details.body));
  assert.doesNotMatch(JSON.stringify(details.body), /Wire the refund|Reporter secret/);
  assert.deepEqual(details.body.items[0].files.map((entry) => [entry.id, entry.fileName, entry.linked, entry.version]), [[shown.id, 'spec.txt', false, 2]]);
});

test('a project archive carries every version and link, and imports them back', async (t) => {
  const { content, projectRepository, send, upload } = await fixture(t);
  const file = await upload('member', { contents: 'first', fileName: 'spec.txt' });
  await send('member', 'POST', `${P}/files/${file.id}/versions`, { expectedVersion: 1, fileContentsBase64: base64('second'), fileName: 'spec-v2.txt' });
  await send('member', 'POST', `${P}/files/${file.id}/links`, { targetId: 'task-1', targetType: 'task' });

  const exported = await projectRepository.exportProjectArchiveData({ projectId: 'project-1', tenantId: TENANT_ID });
  assert.deepEqual([exported.files.length, exported.fileVersions.length, exported.fileLinks.length], [1, 1, 1]);
  assert.equal(Buffer.from(exported.files[0].contentsBase64, 'base64').toString(), 'second');
  assert.equal(Buffer.from(exported.fileVersions[0].contentsBase64, 'base64').toString(), 'first');

  const archive = await send('admin', 'GET', `${P}/export`);
  assert.equal(archive.status, 200, JSON.stringify(archive.body));
  const zip = await JSZip.loadAsync(archive.body.base64 ?? archive.body.base64OdinProject ?? archive.body.contentsBase64, { base64: true });
  const data = JSON.parse(await zip.file('project.json').async('string'));
  assert.equal(data.fileVersions[0].contentsBase64, undefined);
  assert.equal(await zip.file(`vault-versions/${data.fileVersions[0].id}`).async('string'), 'first');

  const imported = await send('admin', 'POST', '/api/projects/import', { base64OdinProject: archive.body.base64 ?? archive.body.base64OdinProject ?? archive.body.contentsBase64, overwriteMode: 'project', userMappings: [] });
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  assert.equal((await content('admin', `/api/files/${file.id}/content`)).text, 'second');
  assert.equal((await content('admin', `/api/files/${file.id}/content?version=1`)).text, 'first');
  const onTask = await send('admin', 'GET', `${P}/files?targetId=task-1&targetType=task`);
  assert.deepEqual(onTask.body.files.map((entry) => entry.fileName), ['spec-v2.txt']);
});
