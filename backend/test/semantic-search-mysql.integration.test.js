import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import mysql from 'mysql2/promise';

import { bootstrapMysqlSchema } from '../src/jobs/bootstrap-schema.lib.js';
import { createMysqlProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createMysqlReportingRepository } from '../src/modules/reporting/reporting.repository.js';
import { refreshEverySearchIndex, refreshTenantSearchIndex } from '../src/modules/reporting/reporting.service.js';
import { topicProvider } from './helpers/topic-embedding-provider.js';

// Semantic search on MySQL (docs/semantic-search/plan.md AC-06, AC-07): migration 0109, the
// comment and file sources, the file text cache, the incremental writes, the vector cache, the
// refresh lock, and query time on 5,000 rows. semantic-search.test.js covers behavior in memory.

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();

function memoryStorage() {
  const objects = new Map();
  return {
    async delete(id) { objects.delete(id); },
    async read(id) {
      if (!objects.has(id)) throw new Error(`No object ${id}`);
      return { bytes: objects.get(id), size: objects.get(id).length };
    },
    async write(id, bytes) { objects.set(id, Buffer.from(bytes)); },
  };
}

test('semantic search stores, refreshes and answers on MySQL', { skip: !databaseUrl, timeout: 560_000 }, async () => {
  const parsed = new URL(databaseUrl);
  const database = `${decodeURIComponent(parsed.pathname.slice(1)).slice(0, 38)}_sem_${process.pid}`;
  const connectionOptions = { host: parsed.hostname, password: decodeURIComponent(parsed.password), port: Number(parsed.port || 3306), user: decodeURIComponent(parsed.username) };
  const admin = await mysql.createConnection(connectionOptions);
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  const isolatedUrl = new URL(databaseUrl);
  isolatedUrl.pathname = `/${database}`;
  const pool = mysql.createPool(isolatedUrl.toString());
  try {
    const importer = await mysql.createConnection({ ...connectionOptions, database, multipleStatements: true });
    try { await importer.query(await readFile(new URL('../db/base-schema.sql', import.meta.url), 'utf8')); } finally { await importer.end(); }
    await bootstrapMysqlSchema({ executor: pool });

    // AC-06: the migration made both tables.
    const [tables] = await pool.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('search_file_texts', 'search_index_state') ORDER BY TABLE_NAME");
    assert.deepEqual(tables.map((row) => row.TABLE_NAME), ['search_file_texts', 'search_index_state']);

    const tenantId = randomUUID();
    const user = { id: randomUUID(), name: 'Lena Lead' };
    await pool.execute('INSERT INTO tenants (id, name) VALUES (?, ?)', [tenantId, 'Acme']);
    await pool.execute('INSERT INTO users (id, name, email, authentication_method_id) VALUES (?, ?, ?, 1)', [user.id, user.name, `${user.id}@acme.test`]);
    const [statuses] = await pool.execute('SELECT id FROM project_statuses ORDER BY id LIMIT 1');
    const projectId = randomUUID();
    await pool.execute('INSERT INTO projects (id, tenant_id, name, description, project_status, deleted) VALUES (?, ?, ?, ?, ?, 0)', [projectId, tenantId, 'Northwind ops', '', statuses[0].id]);
    await pool.execute('INSERT INTO user_project (id, user_id, project_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, NOW(), NOW())', [randomUUID(), user.id, projectId, 'admin']);

    const projectRepository = createMysqlProjectsRepository({ fileStorage: memoryStorage(), pool });
    const repository = createMysqlReportingRepository({ pool });
    const scope = { projectId, tenantId, user };
    const create = async (itemType, parentId, name, description) => (await projectRepository.createProjectItem({ ...scope, input: { item: { description, name }, itemType, parentId } })).item;
    const epic = await create('epic', null, 'Pay cycle', 'The monthly cycle.');
    const story = await create('story', epic.id, 'Plan the offsite', 'The team gathers in Lisbon.');
    const task = await create('task', story.id, 'Book the logistics', 'Book flights and a hotel near the venue.');
    const commentId = randomUUID();
    await pool.execute('INSERT INTO comments (id, tenant_id, user_id, target_id, target_type, parent_id, comment, upvotes, downvotes, date_added, date_updated) VALUES (?, ?, ?, ?, ?, NULL, ?, 0, 0, NOW(), NOW())', [commentId, tenantId, user.id, story.id, 'story', '<p>Can we take the earlier flight?</p>']);
    const saveFile = (fileName, text, extra = {}) => projectRepository.saveFile({ ...scope, fileContentsBase64: Buffer.from(text).toString('base64'), fileDescription: '', fileName, fileType: 'text/plain', targetId: projectId, targetType: 'project', ...extra });
    const handbook = await saveFile('handbook.txt', `${'Office matters are covered here. '.repeat(400)}\nThe zeppelin hangar opens at dawn.\n${'More office matters. '.repeat(200)}`);
    const dm = await saveFile('private.txt', 'A salary negotiation between two people.');
    await pool.execute("UPDATE file_vault SET target_type = 'dm' WHERE id = ?", [dm.id]);

    // The sources: the story's comment and the project file, not the direct-message file.
    const comments = await projectRepository.listSearchComments({ tenantId });
    assert.deepEqual(comments.map((comment) => [comment.id, comment.projectId, comment.authorName]), [[commentId, projectId, 'Lena Lead']]);
    const files = await projectRepository.listSearchFileSources({ tenantId });
    assert.deepEqual(files.map((file) => [file.id, file.projectId, file.targetType]), [[handbook.id, projectId, 'project']]);

    // A refresh embeds everything once, caches the file's text, and writes nothing the second time.
    const provider = topicProvider();
    const refresh = () => refreshTenantSearchIndex({ dependencies: { projectRepository, searchEmbeddingProvider: provider }, repository, tenantId });
    const first = await refresh();
    assert.ok(first.indexed >= 6, JSON.stringify(first));
    assert.equal(first.semanticIndexed, first.indexed);
    const [texts] = await pool.execute('SELECT file_id, status, version FROM search_file_texts WHERE tenant_id = ?', [tenantId]);
    assert.deepEqual(texts.map((row) => [row.file_id, row.status, Number(row.version)]), [[handbook.id, 'ok', 1]]);
    const second = await refresh();
    assert.deepEqual([second.changed, second.deleted, second.semanticIndexed], [0, 0, 0]);
    const [[state]] = await pool.execute('SELECT index_version FROM search_index_state WHERE tenant_id = ?', [tenantId]);
    assert.equal(Number(state.index_version), 1, 'an unchanged refresh keeps the index version');

    // Searching: by meaning, and by a word deep in the file (FULLTEXT), the passage collapsed to one result.
    let vectorLoads = 0;
    const query = pool.query.bind(pool);
    pool.query = (sql, ...rest) => {
      if (String(sql).includes('embedding_vector_json FROM search_documents')) vectorLoads += 1;
      return query(sql, ...rest);
    };
    const search = async (text, types = []) => repository.searchDocuments({ limit: 10, offset: 0, projectIds: [projectId], query: text, queryEmbedding: await provider.embed({ content: text, tenantId, title: 'Search' }), tenantId, types });
    const travel = await search('journey');
    assert.deepEqual(travel.records.map((record) => record.sourceId).sort(), [commentId, story.id, task.id].sort());
    assert.ok(travel.records.every((record) => record.retrievalMode === 'semantic'));
    const deep = await search('zeppelin');
    assert.deepEqual(deep.records.map((record) => [record.title, record.retrievalMode]), [['handbook.txt', 'lexical']]);
    assert.match(deep.records[0].content, /zeppelin hangar/);
    assert.equal(vectorLoads, 1, 'the vectors load once while the index is unchanged');

    // A change bumps the version, and the next search loads the vectors again.
    await pool.execute("UPDATE comments SET comment = '<p>Can we take the later flight?</p>', date_updated = NOW() WHERE id = ?", [commentId]);
    const edited = await refresh();
    assert.deepEqual([edited.changed, edited.semanticIndexed], [1, 1]);
    await search('journey');
    assert.equal(vectorLoads, 2);

    // A deleted file leaves the index with its passages, and its cached text goes.
    await pool.execute('DELETE FROM file_vault WHERE id = ?', [handbook.id]);
    const removed = await refresh();
    assert.ok(removed.deleted >= 2, JSON.stringify(removed));
    const [left] = await pool.execute('SELECT COUNT(*) AS n FROM search_documents WHERE tenant_id = ? AND source_id LIKE ?', [tenantId, `${handbook.id}%`]);
    assert.equal(Number(left[0].n), 0);
    const [leftTexts] = await pool.execute('SELECT COUNT(*) AS n FROM search_file_texts WHERE tenant_id = ?', [tenantId]);
    assert.equal(Number(leftTexts[0].n), 0);

    // One refresh of a workspace at a time, whoever starts it: while another connection holds the
    // workspace's lock, a scheduled or search-triggered refresh does nothing.
    const holder = await pool.getConnection();
    const lockName = "CONCAT('odin_search:', SHA1(CONCAT(DATABASE(), ':', ?)))";
    try {
      await holder.query(`SELECT GET_LOCK(${lockName}, 0)`, [tenantId]);
      const scheduled = await refreshEverySearchIndex({ dependencies: { projectRepository, searchEmbeddingProvider: provider }, repository });
      assert.deepEqual(scheduled.find((result) => result.tenantId === tenantId), { ok: true, skipped: 'busy', tenantId });
      assert.deepEqual(await refresh(), { ok: true, skipped: 'busy' });
      await holder.query(`SELECT RELEASE_LOCK(${lockName})`, [tenantId]);
    } finally {
      holder.release();
    }
    const everyone = await refreshEverySearchIndex({ dependencies: { projectRepository, searchEmbeddingProvider: provider }, repository });
    assert.ok(everyone.some((result) => result.tenantId === tenantId && result.ok));

    // AC-07: 5,000 rows of 1,024 dimensions answer in under 300 ms once the vectors are loaded.
    const bigTenant = randomUUID();
    const random = () => Array.from({ length: 1024 }, () => Math.random() - 0.5);
    const rows = Array.from({ length: 5000 }, (_, index) => ({
      content: `Synthetic passage ${index}`, documentType: 'file', embedding: { contentHash: 'h', dimensions: 1024, embeddedAt: new Date().toISOString(), model: 'big', vector: random() },
      facets: {}, projectId: 'project-big', sourceHash: `hash-${index}`, sourceId: `file-${index}`, title: `File ${index}`, updatedAt: new Date().toISOString(), url: '/projects/project-big',
    }));
    await repository.applySearchChanges({ tenantId: bigTenant, upserts: rows });
    const queryEmbedding = { dimensions: 1024, model: 'big', vector: rows[42].embedding.vector };
    const bigSearch = () => repository.searchDocuments({ limit: 20, offset: 0, projectIds: ['project-big'], query: 'nothing matches this', queryEmbedding, semanticFloor: 0.5, tenantId: bigTenant, types: [] });
    await bigSearch();
    const started = performance.now();
    const answer = await bigSearch();
    const elapsed = performance.now() - started;
    assert.equal(answer.records[0].sourceId, 'file-42');
    assert.ok(elapsed < 300, `took ${Math.round(elapsed)} ms`);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});
