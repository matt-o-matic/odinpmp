import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import mysql from 'mysql2/promise';

import { bootstrapMysqlSchema } from '../src/jobs/bootstrap-schema.lib.js';
import { createMysqlProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createMysqlReportingRepository } from '../src/modules/reporting/reporting.repository.js';
import { searchForUser } from '../src/modules/reporting/reporting.service.js';
import { createMysqlWorkspaceModulesRepository } from '../src/modules/workspace-modules/workspace-modules.repository.js';
import { createMemoryLargeFileStorage } from './helpers/large-file-fixtures.js';

// The MySQL side of channel-activity.repository.js: a member's channels for notification settings
// (their projects from user_project, with their role and the engagement's owner, open channels
// only), and search rows for channels, posts and channel files filtered to each person's
// projects. The in-memory version of search is channel-search.test.js.

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();
const base64 = (text) => Buffer.from(text).toString('base64');

test('MySQL: member channels and channel search', { skip: !databaseUrl, timeout: 560_000 }, async () => {
  const parsed = new URL(databaseUrl);
  const database = `${decodeURIComponent(parsed.pathname.slice(1)).slice(0, 36)}_chsearch_${process.pid}`;
  const connectionOptions = { host: parsed.hostname, password: decodeURIComponent(parsed.password), port: Number(parsed.port || 3306), user: decodeURIComponent(parsed.username) };
  const admin = await mysql.createConnection(connectionOptions);
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  const isolatedUrl = new URL(databaseUrl); isolatedUrl.pathname = `/${database}`;
  const pool = mysql.createPool(isolatedUrl.toString());
  try {
    const importer = await mysql.createConnection({ ...connectionOptions, database, multipleStatements: true });
    try { await importer.query(await readFile(new URL('../db/base-schema.sql', import.meta.url), 'utf8')); }
    finally { await importer.end(); }
    await bootstrapMysqlSchema({ executor: pool });

    const tenantId = randomUUID();
    const people = { lead: { id: randomUUID(), name: 'Lena Lead' }, member: { id: randomUUID(), name: 'Mo Member' }, outsider: { id: randomUUID(), name: 'Oz Outsider' } };
    const emailOf = (person) => `${person.id}@acme.test`;
    await pool.execute('INSERT INTO tenants (id, name) VALUES (?, ?)', [tenantId, 'Search Tenant']);
    for (const person of Object.values(people)) await pool.execute('INSERT INTO users (id, name, email, authentication_method_id, timezone) VALUES (?, ?, ?, 1, ?)', [person.id, person.name, emailOf(person), 'America/New_York']);
    for (const person of [people.lead, people.member, people.outsider]) await pool.execute('INSERT INTO user_tenant (id, user_id, tenant_id, role) VALUES (?, ?, ?, ?)', [randomUUID(), person.id, tenantId, 'user']);
    const [statuses] = await pool.execute('SELECT id FROM project_statuses ORDER BY id LIMIT 1');
    const rollout = randomUUID();
    const pilot = randomUUID();
    await pool.execute('INSERT INTO projects (id, tenant_id, name, description, project_status, deleted) VALUES (?, ?, ?, ?, ?, 0)', [rollout, tenantId, 'Northwind rollout', '', statuses[0].id]);
    await pool.execute("INSERT INTO projects (id, tenant_id, name, description, project_status, deleted, kind, engagement_status) VALUES (?, ?, ?, '', ?, 0, 'engagement', 'open')", [pilot, tenantId, 'Contoso pilot', statuses[0].id]);
    for (const [person, projectId, role] of [[people.lead, rollout, 'admin'], [people.member, rollout, 'user'], [people.lead, pilot, 'admin'], [people.member, pilot, 'user']]) {
      await pool.execute('INSERT INTO user_project (id, user_id, project_id, role) VALUES (?, ?, ?, ?)', [randomUUID(), person.id, projectId, role]);
    }

    const projectRepository = createMysqlProjectsRepository({ fileStorage: createMemoryLargeFileStorage(), pool });
    const workspaceModulesRepository = createMysqlWorkspaceModulesRepository({ pool });
    const general = await projectRepository.ensureGeneralChannel({ projectId: rollout, tenantId, userId: people.lead.id });
    const pilotGeneral = await projectRepository.ensureGeneralChannel({ projectId: pilot, tenantId, userId: people.lead.id });
    const post = (channel, projectId, body, author = people.lead, extra = {}) => projectRepository.createPost({ post: { authorId: author.id, authorType: 'user', body, projectId, targetId: channel.id, targetType: 'channel', tenantId, ...extra } });
    const root = await post(general, rollout, 'The hexagonal layout needs another pass');
    for (const body of ['Two', 'Three', 'Four']) await post(general, rollout, body);
    await post(general, rollout, 'Member wrote this', people.member);
    await post(pilotGeneral, pilot, 'Contoso pricing draft');
    const deleted = await post(general, rollout, 'Gone soon');
    await projectRepository.deletePost({ postId: deleted.id, tenantId, user: people.lead });
    const file = await projectRepository.saveFile({ fileContentsBase64: base64('v1'), fileDescription: '', fileName: 'quarterly-forecast.xlsx', fileType: 'text/plain', projectId: rollout, targetId: general.id, targetType: 'channel', tenantId, user: people.lead });

    // A member's channels: their projects, their role, the engagement's owner; no archived channels.
    await pool.execute('UPDATE projects SET engagement_owner_id = ? WHERE id = ?', [people.lead.id, pilot]);
    const side = await projectRepository.createChannel({ name: 'Old', projectId: rollout, tenantId, user: people.lead });
    await projectRepository.setChannelArchived({ archived: true, channelId: side.id, projectId: rollout, tenantId, user: people.lead });
    const channels = await projectRepository.listMemberChannels({ tenantId, userId: people.member.id });
    assert.deepEqual(channels.map((row) => [row.project.name, row.channel.name, row.projectRole]).sort(), [['Contoso pilot', 'General', 'user'], ['Northwind rollout', 'General', 'user']]);
    assert.deepEqual(channels.find((row) => row.project.id === pilot).project, { engagementOwnerId: people.lead.id, engagementStatus: 'open', id: pilot, kind: 'engagement', name: 'Contoso pilot' });
    assert.deepEqual((await projectRepository.listMemberChannels({ tenantId, userId: people.lead.id })).map((row) => row.projectRole), ['admin', 'admin']);
    assert.deepEqual(await projectRepository.listMemberChannels({ tenantId, userId: people.outsider.id }), [], 'in no project, no channels');

    await workspaceModulesRepository.setModule({ enabled: true, expectedVersion: 0, moduleKey: 'consulting', tenantId, userId: people.lead.id });
    // Search: built for the workspace, filtered to each person's projects.
    const reportingRepository = createMysqlReportingRepository({ pool });
    const searchDeps = { projectRepository, searchIndexMaxAgeMs: 1, workspaceModulesRepository };
    const userFor = (person, role = 'user') => ({ id: person.id, memberships: [{ role, tenantId }], name: person.name });
    const search = async (person, query) => (await searchForUser({ dependencies: searchDeps, input: { facets: '', limit: 25, offset: 0, query, types: '' }, repository: reportingRepository, user: userFor(person) })).records;
    const hexagonal = await search(people.member, 'hexagonal');
    assert.deepEqual(hexagonal.map((record) => [record.documentType, record.sourceId, record.title]), [['post', root.id, 'Lena Lead in #General']]);
    assert.equal(hexagonal[0].url, `/projects/${rollout}/channels?channel=${general.id}&post=${root.id}`);
    const forecast = (await search(people.member, 'quarterly forecast')).find((record) => record.documentType === 'file');
    assert.equal(forecast?.sourceId, file.id);
    assert.deepEqual((await search(people.member, 'Contoso pricing')).map((record) => record.documentType).sort(), ['channel', 'post'], 'the engagement they are in: its General channel and the post');
    assert.deepEqual(await search(people.outsider, 'hexagonal'), [], 'in no project, nothing (AC-15)');
    assert.deepEqual(await search(people.outsider, 'Contoso pricing'), []);
    assert.deepEqual(await search(people.member, 'Gone soon'), [], 'a deleted post is not indexed');
    await workspaceModulesRepository.setModule({ enabled: false, expectedVersion: 1, moduleKey: 'consulting', tenantId, userId: people.lead.id });
    assert.deepEqual(await search(people.member, 'Contoso pricing'), [], 'module off: engagements hidden');
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end();
  }
});
