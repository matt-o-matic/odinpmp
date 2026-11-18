import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createLocalFileStorage } from '../src/lib/files/file-storage.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectChangeLog } from '../src/modules/changes/project-change-log.js';
import { createInMemoryComplianceRepository } from '../src/modules/compliance/compliance.repository.js';
import { createInMemoryMailRepository } from '../src/modules/mail/mail.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';
import { createInMemoryUsersRepository } from '../src/modules/users/users.repository.js';
import { createInMemoryWorkspaceModulesRepository } from '../src/modules/workspace-modules/workspace-modules.repository.js';

// Workspace search over channels, posts and channel file names (docs/engagements/plan.md AC-15;
// qna.md E-11), on in-memory repositories through Odin's routes. The daily channel digest that
// was tested here is replaced by the rolled-up chat email (notifications.test.js).
// channel-search-mysql.integration.test.js runs the same queries on MySQL.

const TENANT_ID = 'tenant-acme';
const ROLLOUT = 'project-rollout';
const LEDGER = 'project-ledger';
const APP = 'https://app.example/app';
const USERS = {
  lead: { id: 'user-lead', name: 'Lena Lead', role: 'user' },
  member: { id: 'user-member', name: 'Mo Member', role: 'user' },
  other: { id: 'user-other', name: 'Olu Other', role: 'user' },
  seller: { id: 'user-seller', name: 'Sal Seller', role: 'user' },
  outsider: { id: 'user-outsider', name: 'Oz Outsider', role: 'user' },
  admin: { id: 'user-admin', name: 'Ada Admin', role: 'admin' },
};
const email = (key) => `${USERS[key].id}@acme.example`;
const membership = (key, role = 'user') => ({ email: email(key), id: USERS[key].id, name: USERS[key].name, role });

async function fixture(t) {
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['acme.example'], id: TENANT_ID, name: 'Acme' }],
    users: Object.values(USERS).map((user) => ({ authMethod: 'basic', email: `${user.id}@acme.example`, id: user.id, memberships: [{ role: user.role, tenantId: TENANT_ID }], name: user.name, password: 'Fixture-password-123!', preferences: { twoFactorEnabled: false } })),
  });
  const root = await mkdtemp(path.join(os.tmpdir(), 'odin-digest-search-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const storage = createLocalFileStorage({ rootDir: root });
  const mailRepository = createInMemoryMailRepository();
  const projectRepository = createInMemoryProjectsRepository({
    authRepository,
    changeLog: createInMemoryProjectChangeLog(),
    fileStorage: storage,
    mailRepository,
    seed: {
      projectMemberships: {
        [LEDGER]: [membership('lead', 'admin'), membership('other')],
        [ROLLOUT]: [membership('lead', 'admin'), membership('member'), membership('other')],
      },
      projects: [
        { epics: [], id: ROLLOUT, name: 'Northwind rollout', status: 'In Progress', tenantId: TENANT_ID },
        { epics: [], id: LEDGER, name: 'Ledger cleanup', status: 'In Progress', tenantId: TENANT_ID },
      ],
    },
  });
  const sessionsRepository = createInMemorySessionsRepository();
  const tokenService = createTokenService({ issuer: 'digest-search-fixture', secret: 'disposable-digest-search-fixture-secret' });
  const workspaceModulesRepository = createInMemoryWorkspaceModulesRepository();
  const app = createApp({
    accessReviewCampaignSweepIntervalMs: 0, agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0, domainEventSweepIntervalMs: 0,
    changeSettleMs: 0, frontendAppUrl: APP, reportSubscriptionSweepIntervalMs: 0, reportingWarehouseSweepIntervalMs: 0, webhookSweepIntervalMs: 0, workflowAutomationSweepIntervalMs: 0,
    // Every search rebuilds the index, so each assertion sees the posts made just before it.
    searchIndexMaxAgeMs: 1,
    authRepository, complianceRepository: createInMemoryComplianceRepository(), fileStorage: storage, mailRepository, projectRepository, sessionsRepository, tokenService, usersRepository: createInMemoryUsersRepository({ authRepository }), workspaceModulesRepository,
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
  const absolute = (url) => (url.startsWith('http') ? url : `${origin}${url}`);
  async function send(as, method, route, body) {
    const response = await fetch(absolute(route), {
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
  const channelsOf = async (projectId, as = 'lead') => (await ok(as, 'GET', `/api/projects/${projectId}/channels`)).channels;
  const generalOf = async (projectId, as = 'lead') => (await channelsOf(projectId, as)).find((channel) => channel.isGeneral);
  const post = async (as, projectId, channelId, body, extra = {}) => (await ok(as, 'POST', `/api/projects/${projectId}/channels/${channelId}/posts`, { body, ...extra }, 201)).post;
  const read = (as, projectId, channelId) => ok(as, 'POST', `/api/projects/${projectId}/channels/${channelId}/read`);
  async function upload(as, projectId, contents, start) {
    const bytes = Buffer.from(contents);
    const started = await ok(as, 'POST', `/api/projects/${projectId}/uploads`, { contentType: 'text/plain', fileSize: bytes.length, ...start }, 201);
    const signed = await ok(as, 'POST', `/api/projects/${projectId}/uploads/${started.upload.id}/parts`, { partNumbers: [1] });
    const put = await fetch(absolute(signed.parts[0].url), { body: bytes, headers: { 'Content-Type': 'application/octet-stream' }, method: 'PUT' });
    assert.equal(put.status, 200, await put.text());
    return ok(as, 'POST', `/api/projects/${projectId}/uploads/${started.upload.id}/complete`, {}, 201);
  }
  let moduleVersion = 0;
  async function switchConsulting(enabled) {
    moduleVersion = (await workspaceModulesRepository.setModule({ enabled, expectedVersion: moduleVersion, moduleKey: 'consulting', tenantId: TENANT_ID, userId: USERS.admin.id })).version;
  }
  // An engagement the seller made (and so is project admin of), with the lead added.
  async function createEngagement() {
    await switchConsulting(true);
    const engagement = (await ok('seller', 'POST', '/api/engagements', { customer: 'Contoso', name: 'Contoso pilot' }, 201)).project;
    projectRepository.state.projectMemberships.get(engagement.id).push(membership('lead'));
    return engagement;
  }
  const search = (as, query, extra = '') => ok(as, 'GET', `/api/reporting/search?query=${encodeURIComponent(query)}${extra}`);
  return { authRepository, channelsOf, createEngagement, generalOf, ok, post, projectRepository, read, search, send, switchConsulting, upload };
}

// --- search ------------------------------------------------------------------------------------

test('search finds channel names, posts by text, author, channel and project, and channel file names', async (t) => {
  const { generalOf, ok, post, search, upload } = await fixture(t);
  const general = await generalOf(ROLLOUT);
  const design = (await ok('lead', 'POST', `/api/projects/${ROLLOUT}/channels`, { description: 'Wireframes and mockups', name: 'Design' }, 201)).channel;
  const root = await post('other', ROLLOUT, design.id, 'The hexagonal layout needs another pass');
  const reply = await post('member', ROLLOUT, design.id, 'Agreed on the zebra palette', { parentId: root.id });
  const folder = (await ok('lead', 'POST', `/api/projects/${ROLLOUT}/channels/${general.id}/folders`, { name: 'Proposals' }, 201)).folder;
  const uploaded = await upload('lead', ROLLOUT, 'v1', { fileName: 'quarterly-forecast.xlsx', folderId: folder.id, targetId: general.id, targetType: 'channel' });
  const fileId = uploaded.file.id;

  const channel = (await search('member', 'Design')).records.find((record) => record.documentType === 'channel');
  assert.equal(channel.title, '#Design');
  assert.equal(channel.url, `/projects/${ROLLOUT}/channels?channel=${design.id}`);

  const byText = (await search('member', 'hexagonal')).records;
  assert.deepEqual(byText.map((record) => [record.documentType, record.sourceId]), [['post', root.id]]);
  assert.equal(byText[0].title, 'Olu Other in #Design');
  assert.equal(byText[0].url, `/projects/${ROLLOUT}/channels?channel=${design.id}&post=${root.id}`);
  assert.equal(byText[0].facets.project, 'Northwind rollout');

  const byAuthor = (await search('member', 'Olu', '&types=post')).records;
  assert.deepEqual(byAuthor.map((record) => record.sourceId), [root.id]);
  const byProject = (await search('member', 'Northwind', '&types=post')).records.map((record) => record.sourceId).sort();
  assert.deepEqual(byProject, [root.id, reply.id].sort());
  const replyHit = (await search('member', 'zebra')).records[0];
  assert.equal(replyHit.url, `/projects/${ROLLOUT}/channels?channel=${design.id}&post=${root.id}`, 'a reply opens its thread');

  const file = (await search('member', 'quarterly forecast')).records.find((record) => record.documentType === 'file');
  assert.equal(file.title, 'quarterly-forecast.xlsx');
  assert.match(file.content, /Proposals/);
  assert.equal(file.url, `/projects/${ROLLOUT}/channels?channel=${general.id}&tab=files&file=${fileId}`);

  // A deleted post is no longer found.
  await ok('other', 'DELETE', `/api/projects/${ROLLOUT}/posts/${root.id}`);
  assert.equal((await search('member', 'hexagonal')).records.length, 0);
});

test('search shows nothing from projects or engagements a person is not in (AC-15), and hides engagements while the module is off', async (t) => {
  const { createEngagement, generalOf, post, search, send, switchConsulting } = await fixture(t);
  await post('lead', ROLLOUT, (await generalOf(ROLLOUT)).id, 'Rollout marmalade checklist');
  await post('lead', LEDGER, (await generalOf(LEDGER)).id, 'Ledger marmalade reconciliation');
  const engagement = await createEngagement();
  await post('seller', engagement.id, (await generalOf(engagement.id, 'seller')).id, 'Contoso marmalade pricing');

  const titles = async (as) => (await search(as, 'marmalade')).records.map((record) => record.content.split(' · ').at(-1)).sort();
  assert.deepEqual(await titles('member'), ['Northwind rollout'], 'member of the rollout only');
  assert.deepEqual(await titles('other'), ['Ledger cleanup', 'Northwind rollout']);
  assert.deepEqual(await titles('seller'), ['Contoso pilot'], 'only the engagement they are in');
  assert.deepEqual(await titles('lead'), ['Contoso pilot', 'Ledger cleanup', 'Northwind rollout']);
  assert.deepEqual(await titles('outsider'), [], 'in no project, sees nothing');
  assert.deepEqual(await titles('admin'), ['Contoso pilot', 'Ledger cleanup', 'Northwind rollout'], 'a workspace admin sees every project, as elsewhere');
  const engagementHit = (await search('seller', 'marmalade')).records[0];
  assert.match(engagementHit.url, new RegExp(`^/engagements/${engagement.id}/channels\\?channel=`));

  // Naming a project a person cannot open is refused, as before.
  assert.equal((await send('member', 'GET', `/api/reporting/search?query=marmalade&projectId=${LEDGER}`)).status, 404);
  assert.equal((await send('member', 'GET', `/api/reporting/search?query=marmalade&projectId=${engagement.id}`)).status, 404);

  await switchConsulting(false);
  assert.deepEqual(await titles('lead'), ['Ledger cleanup', 'Northwind rollout'], 'module off: engagements are hidden');
  assert.deepEqual(await titles('seller'), []);
  assert.deepEqual(await titles('admin'), ['Ledger cleanup', 'Northwind rollout']);
  assert.equal((await send('seller', 'GET', `/api/reporting/search?query=marmalade&projectId=${engagement.id}`)).status, 404, 'an engagement named while the module is off is not found');

  await switchConsulting(true);
  assert.deepEqual(await titles('seller'), ['Contoso pilot'], 'and they come back with the module');
});

test('the chat email digest setting saves with the profile, under the key the daily digest used', async (t) => {
  const { authRepository, ok } = await fixture(t);
  const saved = await ok('member', 'PUT', '/api/users/me', { email: email('member'), firstName: 'Mo', lastName: 'Member', preferences: { emailNotifChannelDigest: false, notificationPrefsVersion: 1 }, profileDisplayName: 'Mo Member' });
  assert.equal(saved.user.preferences.emailNotifChannelDigest, false);
  const [row] = await authRepository.listUserPreferences({ userIds: [USERS.member.id] });
  assert.equal(row.preferences.emailNotifChannelDigest, false);
});
