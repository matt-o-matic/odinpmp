import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../src/app.js';
import { createChangeRecorder, undoChanges } from '../src/lib/agent/agent-changes.js';
import { toolNeedsConfirmation } from '../src/lib/agent/agent-tools.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createLiveEventBus } from '../src/lib/events/live-event-bus.js';
import { createLocalFileStorage } from '../src/lib/files/file-storage.js';
import { createOdinApiClient } from '../src/mcp/api-client.js';
import { createOdinToolCatalog } from '../src/mcp/catalog.js';
import { indexTree, pathSegments } from '../src/mcp/folder-tools.js';
import { requireMcpRouteAccess } from '../src/mcp/route-access.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectChangeLog } from '../src/modules/changes/project-change-log.js';
import { createGuestAgentApi } from '../src/modules/channels/odin-guest-api.js';
import { GUEST_TOOL_NAMES } from '../src/modules/channels/odin-channel.service.js';
import { createInMemoryComplianceRepository } from '../src/modules/compliance/compliance.repository.js';
import { createInMemoryMailRepository } from '../src/modules/mail/mail.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';
import { createInMemoryWorkspaceModulesRepository } from '../src/modules/workspace-modules/workspace-modules.repository.js';

// The project's files as one tree (docs/engagements/plan.md, Folders): the file-tree route,
// renaming and moving files, and the folder tools the assistant, Odin in channels and MCP clients
// share, with Undo. Through Odin's routes on in-memory repositories; the MySQL move is in
// file-tree-mysql.integration.test.js.

const TENANT_ID = 'tenant-acme';
const PROJECT = 'project-1';
const P = `/api/projects/${PROJECT}`;
const USERS = {
  lead: { id: 'user-lead', name: 'Lena Lead', projectRole: 'admin', role: 'user' },
  member: { id: 'user-member', name: 'Mo Member', projectRole: 'user', role: 'user' },
  viewer: { id: 'user-viewer', name: 'Vic Viewer', projectRole: 'viewer', role: 'user' },
};

async function fixture(t) {
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['acme.example'], id: TENANT_ID, name: 'Acme' }],
    users: Object.values(USERS).map((user) => ({ authMethod: 'basic', email: `${user.id}@acme.example`, id: user.id, memberships: [{ role: user.role, tenantId: TENANT_ID }], name: user.name, password: 'Fixture-password-123!', preferences: { twoFactorEnabled: false } })),
  });
  const root = await mkdtemp(path.join(os.tmpdir(), 'odin-file-tree-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const storage = createLocalFileStorage({ rootDir: root });
  const changeLog = createInMemoryProjectChangeLog();
  const projectRepository = createInMemoryProjectsRepository({
    authRepository,
    changeLog,
    fileStorage: storage,
    mailRepository: createInMemoryMailRepository(),
    seed: {
      projectMemberships: { [PROJECT]: Object.values(USERS).map((user) => ({ email: `${user.id}@acme.example`, id: user.id, name: user.name, role: user.projectRole })) },
      projects: [{ epics: [{ id: 'epic-1', name: 'Launch', stories: [] }], id: PROJECT, name: 'Northwind rollout', status: 'In Progress', tenantId: TENANT_ID }],
    },
  });
  const liveEventBus = createLiveEventBus();
  const events = [];
  liveEventBus.subscribe(`project:${PROJECT}`, (event) => events.push(event));
  const sessionsRepository = createInMemorySessionsRepository();
  const tokenService = createTokenService({ issuer: 'file-tree-fixture', secret: 'disposable-file-tree-fixture-secret' });
  const app = createApp({
    accessReviewCampaignSweepIntervalMs: 0, agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0, domainEventSweepIntervalMs: 0,
    changeSettleMs: 0, frontendAppUrl: 'https://app.example/app', reportSubscriptionSweepIntervalMs: 0, reportingWarehouseSweepIntervalMs: 0, webhookSweepIntervalMs: 0, workflowAutomationSweepIntervalMs: 0,
    authRepository, complianceRepository: createInMemoryComplianceRepository(), fileStorage: storage, liveEventBus, mailRepository: createInMemoryMailRepository(), projectRepository, sessionsRepository, tokenService,
    workspaceModulesRepository: createInMemoryWorkspaceModulesRepository(),
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
    const token = tokenService.signSessionToken({ email: `${user.id}@acme.example`, id: user.id, name: user.name, preferences: {}, role: user.role, tenantId: TENANT_ID });
    await sessionsRepository.createSession({ expiryDate: new Date(Date.now() + 3600_000), ipAddr: '127.0.0.1', locationName: 'Loopback', token, userAgent: 'fixture', userId: user.id });
    tokens[key] = token;
  }
  async function send(as, method, route, body) {
    const response = await fetch(`${origin}${route}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Authorization: `Bearer ${tokens[as]}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      method,
    });
    return { body: await response.json().catch(() => null), status: response.status };
  }
  async function ok(as, method, route, body, status = 200) {
    const response = await send(as, method, route, body);
    assert.equal(response.status, status, `${method} ${route}: ${JSON.stringify(response.body)}`);
    return response.body;
  }
  const uploadTo = (as, fileName, target) => ok(as, 'POST', `${P}/files`, { fileContentsBase64: Buffer.from(fileName).toString('base64'), fileDescription: '', fileName, fileType: 'text/plain', ...target }, 201).then((result) => result.file);
  const general = async () => (await ok('member', 'GET', `${P}/channels`)).channels.find((channel) => channel.isGeneral);
  const guestIn = (channel) => projectRepository.addChannelGuest({ channel: { ...channel, projectId: PROJECT, tenantId: TENANT_ID }, invitedBy: USERS.lead.id, stakeholder: { email: 'otto@client.example', id: 'stakeholder-otto', name: 'Otto Outside' } });
  // The tools as the assistant calls them: the shared catalog over Odin's routes, as the person.
  function tools(as = 'member', { recorder = null } = {}) {
    const base = createOdinApiClient({ baseUrl: origin, token: tokens[as] });
    const recorded = recorder ? createChangeRecorder({ api: base }) : null;
    const catalog = new Map(createOdinToolCatalog({ api: recorded?.api ?? base, extended: true }).map((entry) => [entry.name, entry]));
    const run = async (name, args) => {
      const entry = catalog.get(name);
      return entry.handler(entry.schema.parse(args));
    };
    return { api: base, recorded, run };
  }
  const channelEvents = () => events.filter((event) => event.type === 'channel.updated');
  return { changeLog, channelEvents, general, guestIn, ok, origin, projectRepository, send, tools, tokens, uploadTo };
}

test('the file tree: the project on top with its own files, each channel a folder, people\'s folders inside', async (t) => {
  const { general, guestIn, ok, uploadTo } = await fixture(t);
  const gen = await general();
  const design = (await ok('member', 'POST', `${P}/channels`, { name: 'Design' }, 201)).channel;
  const contracts = (await ok('member', 'POST', `${P}/channels/${gen.id}/folders`, { name: 'Contracts' }, 201)).folder;
  const signed = (await ok('member', 'POST', `${P}/channels/${gen.id}/folders`, { name: 'Signed', parentId: contracts.id }, 201)).folder;
  await uploadTo('member', 'brief.txt', { targetId: PROJECT, targetType: 'project' });
  await uploadTo('member', 'task-notes.txt', { targetId: 'epic-1', targetType: 'epic' });
  await uploadTo('member', 'hello.txt', { targetId: gen.id, targetType: 'channel' });
  await uploadTo('member', 'sow.txt', { folderId: signed.id, targetId: gen.id, targetType: 'channel' });
  await uploadTo('member', 'draft.txt', { folderId: contracts.id, targetId: gen.id, targetType: 'channel' });
  await guestIn(design);

  const tree = await ok('viewer', 'GET', `${P}/file-tree`);
  assert.deepEqual(tree.project, { id: PROJECT, name: 'Northwind rollout' });
  assert.equal(tree.canManage, false, 'a viewer reads the tree');
  assert.equal(tree.rootFileCount, 1, 'files on work items are not in the tree');
  assert.deepEqual(tree.channels.map((channel) => [channel.name, channel.isGeneral, channel.fileCount, channel.totalFileCount, channel.guestCount, channel.archived]), [
    ['General', true, 1, 3, 0, false],
    ['Design', false, 0, 0, 1, false],
  ]);
  assert.deepEqual(tree.channels[0].folders.map((folder) => [folder.name, folder.parentId, folder.fileCount, folder.totalFileCount]), [
    ['Contracts', null, 1, 2],
    ['Signed', contracts.id, 1, 1],
  ]);
  assert.equal((await ok('member', 'GET', `${P}/file-tree`)).canManage, true);

  // The tools read it as paths, matched without regard to case.
  const index = indexTree(tree);
  assert.equal(index.find('/general/contracts/SIGNED').folder.id, signed.id);
  assert.equal(index.find('#General').kind, 'channel');
  assert.equal(index.find('/').kind, 'root');
  assert.equal(index.find('/General/Nope'), null);
  assert.deepEqual(pathSegments(' /#General// Contracts /'), ['General', 'Contracts']);
});

test('renaming and moving a file: between folders, channels and the project, keeping its id, versions and posts', async (t) => {
  const { changeLog, channelEvents, general, ok, send, uploadTo } = await fixture(t);
  const gen = await general();
  const design = (await ok('member', 'POST', `${P}/channels`, { name: 'Design' }, 201)).channel;
  const contracts = (await ok('member', 'POST', `${P}/channels/${gen.id}/folders`, { name: 'Contracts' }, 201)).folder;
  const file = await uploadTo('member', 'sow.txt', { targetId: gen.id, targetType: 'channel' });
  await ok('member', 'POST', `${P}/channels/${gen.id}/posts`, { body: 'The SOW', fileIds: [file.id] }, 201);
  const F = `${P}/files/${file.id}`;

  const renamed = await ok('member', 'PATCH', F, { fileName: 'SOW signed.txt' });
  assert.deepEqual([renamed.changed, renamed.file.id, renamed.file.fileName, renamed.file.channelId, renamed.file.folderId], [true, file.id, 'SOW signed.txt', gen.id, null]);

  const intoFolder = await ok('member', 'PATCH', F, { destination: { channelId: gen.id, folderId: contracts.id, kind: 'channel' } });
  assert.deepEqual([intoFolder.file.folderId, intoFolder.file.folderPath], [contracts.id, 'Contracts']);
  const unchanged = await ok('member', 'PATCH', F, { destination: { channelId: gen.id, folderId: contracts.id, kind: 'channel' } });
  assert.equal(unchanged.changed, false);

  const before = channelEvents().length;
  const toDesign = await ok('member', 'PATCH', F, { destination: { channelId: design.id, kind: 'channel' } });
  assert.deepEqual([toDesign.file.channelId, toDesign.file.folderId, toDesign.fromChannelId], [design.id, null, gen.id]);
  const refreshed = channelEvents().slice(before).map((event) => event.channelId);
  assert.ok(refreshed.includes(gen.id) && refreshed.includes(design.id), 'both libraries refresh');

  const toProject = await ok('member', 'PATCH', F, { destination: { kind: 'project' } });
  assert.deepEqual([toProject.file.targetType, toProject.file.targetId, toProject.file.channelId], ['project', PROJECT, null]);
  // Each change is in the project's change log, with where the file was.
  const logged = changeLog.list({ projectId: PROJECT, tenantId: TENANT_ID }).entries.filter((entry) => entry.entityId === file.id).map((entry) => [entry.action, entry.detail.from?.targetType ?? null]);
  assert.deepEqual(logged.slice(-4), [['rename', 'channel'], ['move', 'channel'], ['move', 'channel'], ['move', 'channel']]);
  // The post still carries it, wherever it went.
  assert.equal((await ok('member', 'GET', `${P}/channels/${gen.id}/posts`)).posts.at(-1).attachments[0].id, file.id);
  assert.equal((await ok('member', 'GET', `${P}/files/${file.id}/versions`)).file.fileName, 'SOW signed.txt');

  // Names are taken within the destination folder.
  await uploadTo('member', 'other.txt', { targetId: gen.id, targetType: 'channel' });
  assert.equal((await send('member', 'PATCH', F, { destination: { channelId: gen.id, kind: 'channel' }, fileName: 'OTHER.txt' })).body.details.code, 'file_exists');
  assert.equal((await send('member', 'PATCH', F, { destination: { channelId: design.id, folderId: contracts.id, kind: 'channel' } })).body.details.code, 'invalid_folder');
  assert.equal((await send('member', 'PATCH', F, { fileName: 'a/b.txt' })).body.details.code, 'file_name_invalid');
  assert.equal((await send('member', 'PATCH', F, {})).status, 400, 'a name or a destination');
  assert.equal((await send('viewer', 'PATCH', F, { fileName: 'viewer.txt' })).status, 403);

  // Files on work items stay with them.
  const onEpic = await uploadTo('member', 'epic.txt', { targetId: 'epic-1', targetType: 'epic' });
  assert.equal((await send('member', 'PATCH', `${P}/files/${onEpic.id}`, { destination: { kind: 'project' } })).body.details.code, 'file_not_in_tree');

  // An archived channel takes nothing in and lets nothing out.
  await ok('lead', 'DELETE', `${P}/channels/${design.id}`);
  assert.equal((await send('member', 'PATCH', F, { destination: { channelId: design.id, kind: 'channel' } })).body.details.code, 'channel_archived');
});

test('moving a file into a channel with guests asks first; within that channel it does not', async (t) => {
  const { general, guestIn, ok, send, uploadTo } = await fixture(t);
  const gen = await general();
  const client = (await ok('member', 'POST', `${P}/channels`, { name: 'Client' }, 201)).channel;
  await guestIn(client);
  const file = await uploadTo('member', 'pricing.txt', { targetId: gen.id, targetType: 'channel' });
  const F = `${P}/files/${file.id}`;

  const asked = await send('member', 'PATCH', F, { destination: { channelId: client.id, kind: 'channel' } });
  assert.equal(asked.status, 409);
  assert.deepEqual([asked.body.details.code, asked.body.details.guestCount], ['guests_will_see', 1]);
  assert.match(asked.body.error ?? asked.body.message ?? '', /guest/);
  assert.equal((await ok('member', 'GET', F.replace(`/files/${file.id}`, `/files?targetId=${client.id}&targetType=channel`))).files.length, 0, 'nothing moved');

  await ok('member', 'PATCH', F, { confirmGuests: true, destination: { channelId: client.id, kind: 'channel' } });
  const folder = (await ok('member', 'POST', `${P}/channels/${client.id}/folders`, { name: 'Shared' }, 201)).folder;
  await ok('member', 'PATCH', F, { destination: { channelId: client.id, folderId: folder.id, kind: 'channel' } });
});

test('a guest sees the tree of their channels only, without the project\'s own files', async (t) => {
  const { general, guestIn, ok, projectRepository, uploadTo } = await fixture(t);
  const gen = await general();
  const client = (await ok('member', 'POST', `${P}/channels`, { name: 'Client' }, 201)).channel;
  await guestIn(client);
  await ok('member', 'POST', `${P}/channels/${client.id}/folders`, { name: 'Shared' }, 201);
  await uploadTo('member', 'brief.txt', { targetId: PROJECT, targetType: 'project' });
  await uploadTo('member', 'internal.txt', { targetId: gen.id, targetType: 'channel' });
  await uploadTo('member', 'agenda.txt', { targetId: client.id, targetType: 'channel' });

  const api = createGuestAgentApi({ projectId: PROJECT, projectRepository, screenPost: async () => true, stakeholderId: 'stakeholder-otto', tenantId: TENANT_ID });
  const tree = await api.request('GET', `${P}/file-tree`);
  assert.deepEqual([tree.canManage, tree.rootFileCount, tree.channels.map((channel) => [channel.name, channel.fileCount, channel.folders.map((folder) => folder.name)])], [false, 0, [['Client', 1, ['Shared']]]]);
  assert.ok(GUEST_TOOL_NAMES.includes('odin_list_file_folders'));
  await assert.rejects(api.request('PATCH', `${P}/files/x`, {}), (error) => error.code === 'guest_scope');
});

test('the folder tools: list paths, create a path, rename, move within a channel, move and rename files', async (t) => {
  const { general, guestIn, ok, tools, uploadTo } = await fixture(t);
  const gen = await general();
  const client = (await ok('member', 'POST', `${P}/channels`, { name: 'Client' }, 201)).channel;
  await guestIn(client);
  const { run } = tools('member');

  // mkdir -p: the channel must exist; missing folders along the path are made.
  const made = await run('odin_create_folder', { path: '/General/Contracts/Signed', projectId: PROJECT });
  assert.deepEqual(made.created.map((entry) => entry.path), ['/General/Contracts', '/General/Contracts/Signed']);
  const again = await run('odin_create_folder', { path: '/general/contracts/Signed', projectId: PROJECT });
  assert.deepEqual([again.existed, again.folder.id], [true, made.folder.id]);
  const deeper = await run('odin_create_folder', { path: '/General/Contracts/Drafts', projectId: PROJECT });
  assert.deepEqual(deeper.created.map((entry) => entry.path), ['/General/Contracts/Drafts']);
  await assert.rejects(run('odin_create_folder', { path: '/Finance/Invoices', projectId: PROJECT }), (error) => error.code === 'channel_not_found' && /\/General/.test(error.message));
  await assert.rejects(run('odin_create_folder', { path: '/General', projectId: PROJECT }), (error) => error.code === 'path_is_channel');
  const dry = await run('odin_create_folder', { dryRun: true, path: '/General/Invoices/2026', projectId: PROJECT });
  assert.equal(dry.wouldCreate.length, 2);

  const listed = await run('odin_list_file_folders', { projectId: PROJECT });
  assert.deepEqual(listed.folders.map((entry) => entry.path), ['/', '/General', '/General/Contracts', '/General/Contracts/Drafts', '/General/Contracts/Signed', '/Client']);
  assert.equal(listed.folders.find((entry) => entry.path === '/Client').guests, 1);

  await run('odin_rename_folder', { name: 'Old drafts', path: '/General/Contracts/Drafts', projectId: PROJECT });
  await assert.rejects(run('odin_rename_folder', { name: 'X', path: '/General', projectId: PROJECT }), (error) => error.code === 'not_a_folder');
  const moved = await run('odin_move_folder', { path: '/General/Contracts/Old drafts', projectId: PROJECT, toPath: '/General' });
  assert.equal(moved.folder.path, '/General/Old drafts');
  await assert.rejects(run('odin_move_folder', { path: '/General/Old drafts', projectId: PROJECT, toPath: '/Client' }), (error) => error.code === 'other_channel');

  // Files: listed with their path, filtered by one, moved and renamed.
  const sow = await uploadTo('member', 'sow.txt', { targetId: gen.id, targetType: 'channel' });
  const brief = await uploadTo('member', 'brief.txt', { targetId: PROJECT, targetType: 'project' });
  const files = (await run('odin_list_project_files', { projectId: PROJECT })).items;
  assert.deepEqual(files.map((file) => [file.fileName, file.path]).sort(), [['brief.txt', '/'], ['sow.txt', '/General']]);
  const into = await run('odin_move_file', { fileId: sow.id, projectId: PROJECT, toPath: '/General/Contracts/Signed' });
  assert.equal(into.file.path, '/General/Contracts/Signed');
  assert.deepEqual((await run('odin_list_project_files', { path: '/General/Contracts/Signed', projectId: PROJECT })).items.map((file) => file.id), [sow.id]);
  assert.deepEqual((await run('odin_list_project_files', { includeSubfolders: true, path: '/General', projectId: PROJECT })).items.map((file) => file.id), [sow.id]);
  assert.deepEqual((await run('odin_list_project_files', { path: '/General', projectId: PROJECT })).items, []);
  assert.deepEqual((await run('odin_list_project_files', { path: '/', projectId: PROJECT })).items.map((file) => file.id), [brief.id]);
  await run('odin_rename_file', { fileId: sow.id, fileName: 'SOW (signed).txt', projectId: PROJECT });

  // A move that shows the file to guests is refused, then asks the user when they agreed.
  await assert.rejects(run('odin_move_file', { fileId: brief.id, projectId: PROJECT, toPath: '/Client' }), (error) => error.code === 'guests_will_see');
  assert.equal(toolNeedsConfirmation('odin_move_file', { fileId: brief.id, projectId: PROJECT, toPath: '/Client' }), false);
  assert.equal(toolNeedsConfirmation('odin_move_file', { fileId: brief.id, projectId: PROJECT, shareWithGuests: true, toPath: '/Client' }), true);
  assert.equal((await run('odin_move_file', { fileId: brief.id, projectId: PROJECT, shareWithGuests: true, toPath: '/Client' })).file.path, '/Client');

  // Uploading into a folder by path.
  const notes = await run('odin_upload_project_file', { fileName: 'minutes.md', path: '/General/Contracts', projectId: PROJECT, text: '# Minutes' });
  assert.deepEqual([notes.file.path, notes.file.channelId], ['/General/Contracts', gen.id]);
  await assert.rejects(run('odin_upload_project_file', { fileName: 'minutes.md', path: '/General/Contracts', projectId: PROJECT, text: 'again' }), (error) => error.code === 'file_exists');

  // Deleting a folder is only for empty ones, and always asks.
  assert.equal(toolNeedsConfirmation('odin_delete_folder', { path: '/General/Old drafts', projectId: PROJECT }), true);
  await assert.rejects(run('odin_delete_folder', { path: '/General/Contracts', projectId: PROJECT }), (error) => error.code === 'folder_not_empty');
  assert.equal((await run('odin_delete_folder', { path: '/General/Old drafts', projectId: PROJECT })).deleted.path, '/General/Old drafts');

  // A viewer reads the tree but changes nothing.
  const viewer = tools('viewer');
  assert.equal((await viewer.run('odin_list_file_folders', { projectId: PROJECT })).canChange, false);
  await assert.rejects(viewer.run('odin_create_folder', { path: '/General/Mine', projectId: PROJECT }), (error) => error.status === 403);
});

test('undo puts folders and files back as they were, and leaves what changed since', async (t) => {
  const { general, ok, send, tools, uploadTo } = await fixture(t);
  const gen = await general();
  const contracts = (await ok('member', 'POST', `${P}/channels/${gen.id}/folders`, { name: 'Contracts' }, 201)).folder;
  const doomed = (await ok('member', 'POST', `${P}/channels/${gen.id}/folders`, { name: 'Doomed', parentId: contracts.id }, 201)).folder;
  const sow = await uploadTo('member', 'sow.txt', { targetId: gen.id, targetType: 'channel' });
  const tree = async () => indexTree(await ok('member', 'GET', `${P}/file-tree`));

  const { recorded, run } = tools('member', { recorder: true });
  await run('odin_create_folder', { path: '/General/Invoices/2026', projectId: PROJECT });
  await run('odin_rename_folder', { name: 'Agreements', path: '/General/Contracts', projectId: PROJECT });
  await run('odin_move_file', { fileId: sow.id, fileName: 'sow-final.txt', projectId: PROJECT, toPath: '/General/Agreements' });
  await run('odin_delete_folder', { path: '/General/Agreements/Doomed', projectId: PROJECT });
  const records = recorded.records();
  assert.deepEqual(records.map((record) => [record.label, record.undoable]), [
    ['Created folder "Invoices"', true],
    ['Created folder "2026"', true],
    ['Renamed folder "Contracts" to "Agreements"', true],
    ['Moved file "sow.txt" and renamed it "sow-final.txt"', true],
    ['Deleted folder "Doomed"', true],
  ]);

  const undone = await undoChanges({ api: tools('member').api, changes: { records, versions: {} } });
  assert.deepEqual(undone.records.map((record) => record.status), ['undone', 'undone', 'undone', 'undone', 'undone'], JSON.stringify(undone.records));
  const after = await tree();
  assert.equal(after.find('/General/Invoices'), null);
  assert.ok(after.find('/General/Contracts/Doomed'), 'the deleted folder is back where it was');
  assert.equal(after.find('/General/Agreements'), null);
  const file = (await ok('member', 'GET', `${P}/files?targetId=${gen.id}&targetType=channel`)).files.find((entry) => entry.id === sow.id);
  assert.deepEqual([file.fileName, file.folderId], ['sow.txt', null]);
  assert.notEqual(after.find('/General/Contracts/Doomed').folder.id, doomed.id, 'a new folder in its place');

  // Changed since: a folder someone put a file in stays, and a file someone moved on stays.
  const second = tools('member', { recorder: true });
  await second.run('odin_create_folder', { path: '/General/Keep', projectId: PROJECT });
  await second.run('odin_move_file', { fileId: sow.id, projectId: PROJECT, toPath: '/General/Keep' });
  const keep = (await tree()).find('/General/Keep').folder;
  await ok('member', 'PATCH', `${P}/files/${sow.id}`, { destination: { channelId: gen.id, kind: 'channel' } });
  await uploadTo('member', 'theirs.txt', { folderId: keep.id, targetId: gen.id, targetType: 'channel' });
  const kept = await undoChanges({ api: tools('member').api, changes: { records: second.recorded.records(), versions: {} } });
  assert.deepEqual(kept.records.map((record) => record.status), ['kept', 'kept']);
  assert.ok((await tree()).find('/General/Keep'));
  assert.equal((await send('member', 'GET', `${P}/file-tree`)).status, 200);
});

test('MCP credentials reach the tree, folders and moves with their known fields only', () => {
  const grant = { projectIds: [], scopes: ['projects.read', 'projects.write'] };
  const readOnly = { projectIds: [], scopes: ['projects.read'] };
  const check = (method, originalUrl, body, scope = grant) => {
    try {
      requireMcpRouteAccess({ body, method, originalUrl }, scope);
      return 'allowed';
    } catch (error) {
      return String(error.statusCode);
    }
  };
  assert.equal(check('GET', `${P}/file-tree`, undefined, readOnly), 'allowed');
  assert.equal(check('POST', `${P}/channels/c1/folders`, { name: 'Contracts', parentId: null }), 'allowed');
  assert.equal(check('POST', `${P}/channels/c1/folders`, { name: 'Contracts' }, readOnly), '403');
  assert.equal(check('PATCH', `${P}/folders/f1`, { name: 'Agreements' }), 'allowed');
  assert.equal(check('DELETE', `${P}/folders/f1`), 'allowed');
  assert.equal(check('PATCH', `${P}/files/file-1`, { destination: { kind: 'project' }, fileName: 'a.txt' }), 'allowed');
  assert.equal(check('PATCH', `${P}/files/file-1`, { confirmGuests: true, destination: { channelId: 'c1', folderId: null, kind: 'channel' } }), 'allowed');
  assert.notEqual(check('PATCH', `${P}/files/file-1`, { destination: { kind: 'task' } }), 'allowed');
  assert.notEqual(check('PATCH', `${P}/files/file-1`, { audience: 'external' }), 'allowed');
  assert.equal(check('POST', `${P}/files`, { fileContentsBase64: 'aGk=', fileDescription: '', fileName: 'n.md', fileType: 'text/markdown', folderId: 'f1', targetId: 'c1', targetType: 'channel' }), 'allowed');
  assert.notEqual(check('POST', `${P}/files`, { fileContentsBase64: 'aGk=', fileName: 'n.md', fileType: 'text/markdown', folderId: 'f1', targetId: PROJECT, targetType: 'project' }), 'allowed');
});
