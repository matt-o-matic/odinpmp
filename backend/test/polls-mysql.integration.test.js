import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import mysql from 'mysql2/promise';

import { bootstrapMysqlSchema } from '../src/jobs/bootstrap-schema.lib.js';
import { normalizePollInput, tallyPoll } from '../src/modules/channels/polls.js';
import { createMysqlProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createMemoryLargeFileStorage } from './helpers/large-file-fixtures.js';

// The MySQL side of polls (0108_polls; polls.repository.js): a poll on a post, one vote per
// person that a second vote replaces, and closing. polls.test.js covers the rules and routes in
// memory.

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();

test('MySQL: 0108 stores a poll on a post, keeps one vote per person, and closes it once', { skip: !databaseUrl, timeout: 560_000 }, async () => {
  const parsed = new URL(databaseUrl);
  const database = `${decodeURIComponent(parsed.pathname.slice(1)).slice(0, 36)}_polls_${process.pid}`;
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
    // Running the migrations again changes nothing.
    await bootstrapMysqlSchema({ executor: pool });
    const tenantId = randomUUID();
    const projectId = randomUUID();
    const ada = { id: randomUUID(), name: 'Ada Admin' };
    await pool.execute('INSERT INTO tenants (id, name) VALUES (?, ?)', [tenantId, 'Polls Tenant']);
    await pool.execute('INSERT INTO users (id, name, email, authentication_method_id) VALUES (?, ?, ?, 1)', [ada.id, ada.name, `${ada.id}@acme.test`]);
    const [statuses] = await pool.execute('SELECT id FROM project_statuses ORDER BY id LIMIT 1');
    await pool.execute('INSERT INTO projects (id, tenant_id, name, description, project_status, deleted) VALUES (?, ?, ?, ?, ?, 0)', [projectId, tenantId, 'Polls', '', statuses[0].id]);

    const repository = createMysqlProjectsRepository({ fileStorage: createMemoryLargeFileStorage(), pool });
    const general = await repository.ensureGeneralChannel({ projectId, tenantId, userId: ada.id });
    const post = await repository.createPost({ post: { authorId: ada.id, authorType: 'user', body: 'Order these', projectId, targetId: general.id, targetType: 'channel', tenantId } });
    const input = normalizePollInput({ closesAt: new Date(Date.now() + 86_400_000).toISOString(), kind: 'ranking', options: ['Mon', 'Tue', 'Wed'], question: 'Order these', settings: { anonymous: true } });
    const stored = await repository.createPoll({ poll: { ...input, postId: post.id, tenantId } });
    assert.deepEqual([stored.kind, stored.question, stored.options.map((option) => option.label), stored.settings.anonymous, stored.closedAt], ['ranking', 'Order these', ['Mon', 'Tue', 'Wed'], true, null]);
    assert.equal(stored.closesAt, input.closesAt);

    await repository.setPollVote({ answer: { order: ['o1', 'o2', 'o3'] }, postId: post.id, tenantId, voterId: ada.id, voterName: ada.name, voterType: 'user' });
    await repository.setPollVote({ answer: { order: ['o3', 'o1', 'o2'] }, postId: post.id, tenantId, voterId: ada.id, voterName: ada.name, voterType: 'user' });
    await repository.setPollVote({ answer: { order: ['o3', 'o2', 'o1'] }, postId: post.id, tenantId, voterId: 'stakeholder-1', voterName: 'Gina Guest', voterType: 'stakeholder' });
    const votes = await repository.listPollVotes({ postIds: [post.id], tenantId });
    assert.equal(votes.length, 2, 'a second vote replaces the first');
    assert.deepEqual(votes.find((vote) => vote.voterId === ada.id).answer, { order: ['o3', 'o1', 'o2'] });
    assert.deepEqual(tallyPoll(stored, votes).options.map((option) => [option.label, option.points]), [['Wed', 4], ['Mon', 1], ['Tue', 1]]);
    assert.deepEqual(await repository.listPollVotes({ postIds: [post.id], tenantId: randomUUID() }), [], 'other tenants see nothing');

    const closed = await repository.closePoll({ closedBy: `user:${ada.id}`, postId: post.id, tenantId });
    assert.ok(closed.closedAt);
    const again = await repository.closePoll({ closedBy: 'user:someone-else', postId: post.id, tenantId });
    assert.deepEqual([again.closedAt, again.closedBy], [closed.closedAt, `user:${ada.id}`], 'closing twice keeps the first');
    assert.deepEqual((await repository.listPolls({ postIds: [post.id, randomUUID()], tenantId })).map((poll) => poll.postId), [post.id]);
    assert.equal(await repository.closePoll({ closedBy: 'x', postId: randomUUID(), tenantId }), null);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end();
  }
});
