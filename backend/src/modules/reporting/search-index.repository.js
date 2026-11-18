import { randomUUID } from 'node:crypto';

// The search index's storage (docs/semantic-search/plan.md). Spread into the reporting
// repositories after their own methods, so these replace the older whole-index sync for search.
//
// - applySearchChanges writes only rows that changed and deletes rows whose source is gone, then
//   bumps the workspace's index version (search_index_state) when anything changed.
// - search_file_texts caches each file's extracted text by version and sha256, so a file is read
//   again only when its contents change.
// - searchDocuments merges the best semantic matches (cosine over vectors held in memory per
//   workspace and index version) with the best keyword matches, by reciprocal rank fusion, and
//   collapses the passages of one source to their best match.

export const CANDIDATES = 200;
// Below this cosine similarity, a row is not a semantic match (text-embedding-3 models).
export const DEFAULT_SEMANTIC_FLOOR = 0.3;
const FUSION_K = 60;

export async function ensureMysqlSemanticSearchSchema(executor) {
  await executor.execute(`CREATE TABLE IF NOT EXISTS search_file_texts (
    tenant_id VARCHAR(36) NOT NULL,
    file_id VARCHAR(64) NOT NULL,
    version INT NOT NULL,
    sha256 CHAR(64) NULL,
    status VARCHAR(16) NOT NULL,
    reason VARCHAR(500) NOT NULL DEFAULT '',
    text MEDIUMTEXT NULL,
    extracted_at DATETIME(3) NOT NULL,
    PRIMARY KEY (tenant_id, file_id)
  )`);
  await executor.execute(`CREATE TABLE IF NOT EXISTS search_index_state (
    tenant_id VARCHAR(36) NOT NULL PRIMARY KEY,
    refreshed_at DATETIME(3) NOT NULL,
    index_version BIGINT UNSIGNED NOT NULL DEFAULT 0
  )`);
}

export function baseSourceId(sourceId) {
  return String(sourceId ?? '').split('#')[0];
}

function cosine(left, right) {
  if (!left || !right || left.length !== right.length || !left.length) return null;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : null;
}

function publicRecord(document) {
  const { embedding: _embedding, sourceHash: _sourceHash, ...record } = document;
  return record;
}

/**
 * Merges semantic and keyword candidates. `semantic` is [{ document, similarity }] and `lexical`
 * is [{ document, lexicalScore }], each best first. Passages of one source collapse to the best.
 */
export function fuseResults({ lexical = [], limit, offset, semantic = [] }) {
  const merged = new Map();
  const add = (document, rank, fields) => {
    const key = `${document.documentType}:${baseSourceId(document.sourceId)}`;
    const entry = merged.get(key) ?? { best: null, bestScore: -1, lexicalScore: 0, score: 0, semanticScore: null };
    const contribution = 1 / (FUSION_K + rank);
    entry.score += contribution;
    if (fields.lexicalScore != null) entry.lexicalScore = Math.max(entry.lexicalScore, fields.lexicalScore);
    if (fields.similarity != null) entry.semanticScore = Math.max(entry.semanticScore ?? -1, fields.similarity);
    // The passage shown is the one that matched best by either measure.
    if (contribution > entry.bestScore) {
      entry.best = document;
      entry.bestScore = contribution;
    }
    merged.set(key, entry);
  };
  // Each list counts a source once, by its best passage, so a long file's many passages don't add
  // up to outrank a better match elsewhere. Lists come best first.
  const bestPerSource = (list) => {
    const seen = new Set();
    return list.filter(({ document }) => {
      const key = `${document.documentType}:${baseSourceId(document.sourceId)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  bestPerSource(semantic).forEach(({ document, similarity }, index) => add(document, index + 1, { similarity }));
  bestPerSource(lexical).forEach(({ document, lexicalScore }, index) => add(document, index + 1, { lexicalScore }));
  const ranked = [...merged.values()].sort((left, right) => right.score - left.score
    || String(right.best.updatedAt).localeCompare(String(left.best.updatedAt))
    || String(left.best.id).localeCompare(String(right.best.id)));
  return {
    records: ranked.slice(offset, offset + limit).map((entry) => ({
      ...publicRecord(entry.best),
      lexicalScore: Math.round(entry.lexicalScore * 100) / 100,
      retrievalMode: entry.semanticScore == null ? 'lexical' : entry.lexicalScore > 0 ? 'hybrid' : 'semantic',
      score: Math.round(entry.score * 100_000) / 100,
      semanticScore: entry.semanticScore == null ? null : Math.round(entry.semanticScore * 10_000) / 10_000,
    })),
    total: ranked.length,
  };
}

function lexicalScore(document, terms) {
  const title = String(document.title ?? '').toLowerCase();
  const content = String(document.content ?? '').toLowerCase();
  return terms.reduce((sum, term) => sum + (title.includes(term) ? 5 : 0) + (content.includes(term) ? 1 : 0), 0);
}

const queryTerms = (query) => String(query ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((term) => term.length > 1);

function inScope(document, { includeWorkspace, projectIds, types }) {
  return (document.projectId ? projectIds.has(document.projectId) : includeWorkspace) && (!types.size || types.has(document.documentType));
}

function semanticCandidates(entries, queryEmbedding, floor) {
  const vector = queryEmbedding?.vector;
  if (!vector) return [];
  return entries
    .map((entry) => ({ entry, similarity: cosine(entry.vector, vector) }))
    .filter((item) => item.similarity != null && item.similarity >= floor)
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, CANDIDATES);
}

export function createInMemorySearchIndexMethods({ state }) {
  state.documents ??= new Map();
  state.searchFileTexts ??= new Map();
  state.searchIndexState ??= new Map();
  const tenantDocuments = (tenantId) => [...state.documents.values()].filter((document) => document.tenantId === tenantId);
  const keyOf = (document) => `${document.documentType}:${document.sourceId}`;
  const refreshing = new Set();
  return {
    async withSearchIndexLock(tenantId, run) {
      if (refreshing.has(tenantId)) return { ok: true, skipped: 'busy' };
      refreshing.add(tenantId);
      try {
        return await run();
      } finally {
        refreshing.delete(tenantId);
      }
    },
    async listSearchTenantIds() {
      return [...new Set([...state.documents.values()].map((document) => document.tenantId).concat([...state.searchIndexState.keys()]))];
    },
    async listDocumentManifests({ tenantId }) {
      return tenantDocuments(tenantId).map((document) => ({
        embeddingDimensions: document.embedding?.dimensions ?? null,
        embeddingModel: document.embedding?.model ?? null,
        sourceHash: document.sourceHash,
        sourceId: document.sourceId,
        type: document.documentType,
      }));
    },
    async applySearchChanges({ deletes = [], tenantId, upserts = [] }) {
      const now = new Date().toISOString();
      const byKey = new Map(tenantDocuments(tenantId).map((document) => [keyOf(document), document]));
      for (const document of upserts) {
        const current = byKey.get(keyOf(document));
        const record = { ...structuredClone(document), id: current?.id ?? randomUUID(), indexedAt: now, tenantId };
        state.documents.set(record.id, record);
      }
      for (const key of deletes) {
        const current = byKey.get(`${key.type}:${key.sourceId}`);
        if (current) state.documents.delete(current.id);
      }
      const previous = state.searchIndexState.get(tenantId);
      const changed = upserts.length + deletes.length > 0;
      state.searchIndexState.set(tenantId, { indexVersion: (previous?.indexVersion ?? 0) + (changed ? 1 : 0), refreshedAt: now });
      return { deleted: deletes.length, written: upserts.length };
    },
    async getSearchIndexFreshness({ tenantId }) {
      return state.searchIndexState.get(tenantId)?.refreshedAt ?? tenantDocuments(tenantId).map((document) => document.indexedAt).sort().at(-1) ?? null;
    },
    async listSearchFileTexts({ tenantId }) {
      return [...state.searchFileTexts.values()].filter((entry) => entry.tenantId === tenantId).map((entry) => ({ ...entry }));
    },
    async saveSearchFileText(entry) {
      state.searchFileTexts.set(`${entry.tenantId}:${entry.fileId}`, { ...entry, extractedAt: new Date().toISOString() });
    },
    async deleteSearchFileTexts({ fileIds, tenantId }) {
      for (const fileId of fileIds) state.searchFileTexts.delete(`${tenantId}:${fileId}`);
    },
    async searchDocuments({ includeWorkspace = true, limit, offset, projectIds, query, queryEmbedding = null, semanticFloor = DEFAULT_SEMANTIC_FLOOR, tenantId, types }) {
      const scope = { includeWorkspace, projectIds: new Set(projectIds), types: new Set(types) };
      const documents = tenantDocuments(tenantId).filter((document) => inScope(document, scope));
      const terms = queryTerms(query);
      const lexical = documents.map((document) => ({ document, lexicalScore: lexicalScore(document, terms) }))
        .filter((item) => item.lexicalScore > 0)
        .sort((left, right) => right.lexicalScore - left.lexicalScore || String(right.document.updatedAt).localeCompare(String(left.document.updatedAt)))
        .slice(0, CANDIDATES);
      const sameSpace = documents.filter((document) => document.embedding?.vector && document.embedding.model === queryEmbedding?.model && document.embedding.dimensions === queryEmbedding?.dimensions);
      const semantic = semanticCandidates(sameSpace.map((document) => ({ document, vector: document.embedding.vector })), queryEmbedding, semanticFloor)
        .map(({ entry, similarity }) => ({ document: entry.document, similarity }));
      return fuseResults({ lexical, limit, offset, semantic });
    },
  };
}

const iso = (value) => (value ? new Date(value).toISOString() : null);
const parseJson = (value, fallback) => {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
};
// Every column but the vector, which only the in-memory cache reads.
const RECORD_COLUMNS = 'id, tenant_id, project_id, document_type, source_id, title, content, url, facets_json, source_updated_at, indexed_at, embedding_model, embedding_dimensions';

function mapRecord(row) {
  return {
    content: row.content,
    documentType: row.document_type,
    facets: parseJson(row.facets_json, {}),
    id: row.id,
    indexedAt: iso(row.indexed_at),
    projectId: row.project_id,
    sourceId: row.source_id,
    tenantId: row.tenant_id,
    title: row.title,
    updatedAt: iso(row.source_updated_at),
    url: row.url,
  };
}

export function createMysqlSearchIndexMethods({ pool }) {
  // Vectors per workspace, kept until the index version or the embedding space changes.
  const vectorCache = new Map();

  async function indexVersion(tenantId) {
    const [rows] = await pool.execute('SELECT index_version FROM search_index_state WHERE tenant_id = ?', [tenantId]);
    return rows.length ? Number(rows[0].index_version) : null;
  }

  async function vectorsFor(tenantId, model, dimensions) {
    const version = await indexVersion(tenantId);
    const cached = vectorCache.get(tenantId);
    if (cached && version != null && cached.version === version && cached.model === model && cached.dimensions === dimensions) return cached.entries;
    const [rows] = await pool.query(
      'SELECT id, project_id, document_type, embedding_vector_json FROM search_documents WHERE tenant_id = ? AND embedding_model = ? AND embedding_dimensions = ?',
      [tenantId, model, dimensions],
    );
    const entries = [];
    for (const row of rows) {
      const values = parseJson(row.embedding_vector_json, null);
      if (Array.isArray(values) && values.length === dimensions) entries.push({ documentType: row.document_type, id: row.id, projectId: row.project_id, vector: Float32Array.from(values) });
    }
    // Only a versioned index is cached: one with no state row yet is read each time.
    if (version != null) vectorCache.set(tenantId, { dimensions, entries, model, version });
    return entries;
  }

  async function recordsById(tenantId, ids) {
    if (!ids.length) return new Map();
    const [rows] = await pool.query(`SELECT ${RECORD_COLUMNS} FROM search_documents WHERE tenant_id = ? AND id IN (${ids.map(() => '?').join(',')})`, [tenantId, ...ids]);
    return new Map(rows.map((row) => [row.id, mapRecord(row)]));
  }

  return {
    async listSearchTenantIds() {
      const [rows] = await pool.query('SELECT id FROM tenants');
      return rows.map((row) => row.id);
    },
    // One refresh of a workspace at a time, whoever starts it (the schedule, a search that finds
    // the index stale, the refresh button), across processes and connections. A run that can't
    // take the lock does nothing and says so. MySQL's named locks are server-wide and at most 64
    // characters, so the name is a hash of the database and the workspace.
    async withSearchIndexLock(tenantId, run) {
      const connection = await pool.getConnection();
      const name = "CONCAT('odin_search:', SHA1(CONCAT(DATABASE(), ':', ?)))";
      try {
        const [rows] = await connection.query(`SELECT GET_LOCK(${name}, 0) AS got`, [tenantId]);
        if (Number(rows[0]?.got) !== 1) return { ok: true, skipped: 'busy' };
        try {
          return await run();
        } finally {
          await connection.query(`SELECT RELEASE_LOCK(${name})`, [tenantId]).catch(() => {});
        }
      } finally {
        connection.release();
      }
    },
    async listDocumentManifests({ tenantId }) {
      const [rows] = await pool.execute('SELECT document_type, source_id, source_hash, embedding_model, embedding_dimensions FROM search_documents WHERE tenant_id = ?', [tenantId]);
      return rows.map((row) => ({
        embeddingDimensions: row.embedding_dimensions == null ? null : Number(row.embedding_dimensions),
        embeddingModel: row.embedding_model ?? null,
        sourceHash: row.source_hash,
        sourceId: row.source_id,
        type: row.document_type,
      }));
    },
    async applySearchChanges({ deletes = [], tenantId, upserts = [] }) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const now = new Date();
        for (const document of upserts) {
          const embedding = document.embedding ?? null;
          await connection.execute(
            `INSERT INTO search_documents (id, tenant_id, project_id, document_type, source_id, title, content, url, facets_json, source_updated_at, indexed_at, source_hash, index_generation, embedding_model, embedding_dimensions, embedding_vector_json, embedding_content_hash, embedded_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE project_id = VALUES(project_id), title = VALUES(title), content = VALUES(content), url = VALUES(url), facets_json = VALUES(facets_json),
               source_updated_at = VALUES(source_updated_at), indexed_at = VALUES(indexed_at), source_hash = VALUES(source_hash), index_generation = NULL,
               embedding_model = VALUES(embedding_model), embedding_dimensions = VALUES(embedding_dimensions), embedding_vector_json = VALUES(embedding_vector_json),
               embedding_content_hash = VALUES(embedding_content_hash), embedded_at = VALUES(embedded_at)`,
            [randomUUID(), tenantId, document.projectId, document.documentType, document.sourceId, document.title, document.content, document.url, JSON.stringify(document.facets ?? {}),
              new Date(document.updatedAt), now, document.sourceHash, embedding?.model ?? null, embedding?.dimensions ?? null, embedding ? JSON.stringify(embedding.vector) : null,
              embedding?.contentHash ?? null, embedding?.embeddedAt ? new Date(embedding.embeddedAt) : null],
          );
        }
        for (let offset = 0; offset < deletes.length; offset += 200) {
          const batch = deletes.slice(offset, offset + 200);
          await connection.query(
            `DELETE FROM search_documents WHERE tenant_id = ? AND (${batch.map(() => '(document_type = ? AND source_id = ?)').join(' OR ')})`,
            [tenantId, ...batch.flatMap((key) => [key.type, key.sourceId])],
          );
        }
        const changed = upserts.length + deletes.length > 0 ? 1 : 0;
        await connection.execute(
          `INSERT INTO search_index_state (tenant_id, refreshed_at, index_version) VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE refreshed_at = VALUES(refreshed_at), index_version = index_version + ?`,
          [tenantId, now, changed, changed],
        );
        await connection.commit();
        return { deleted: deletes.length, written: upserts.length };
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },
    async getSearchIndexFreshness({ tenantId }) {
      const [state] = await pool.execute('SELECT refreshed_at FROM search_index_state WHERE tenant_id = ?', [tenantId]);
      if (state.length) return iso(state[0].refreshed_at);
      const [rows] = await pool.execute('SELECT MAX(indexed_at) AS indexed_at FROM search_documents WHERE tenant_id = ?', [tenantId]);
      return iso(rows[0]?.indexed_at);
    },
    async listSearchFileTexts({ tenantId }) {
      const [rows] = await pool.execute('SELECT file_id, version, sha256, status, reason, text FROM search_file_texts WHERE tenant_id = ?', [tenantId]);
      return rows.map((row) => ({ fileId: row.file_id, reason: row.reason ?? '', sha256: row.sha256 ?? null, status: row.status, tenantId, text: row.text ?? '', version: Number(row.version) }));
    },
    async saveSearchFileText({ fileId, reason = '', sha256 = null, status, tenantId, text = '', version }) {
      await pool.execute(
        `INSERT INTO search_file_texts (tenant_id, file_id, version, sha256, status, reason, text, extracted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE version = VALUES(version), sha256 = VALUES(sha256), status = VALUES(status), reason = VALUES(reason), text = VALUES(text), extracted_at = VALUES(extracted_at)`,
        [tenantId, fileId, version, sha256, status, String(reason).slice(0, 500), text, new Date()],
      );
    },
    async deleteSearchFileTexts({ fileIds, tenantId }) {
      for (let offset = 0; offset < fileIds.length; offset += 500) {
        const batch = fileIds.slice(offset, offset + 500);
        await pool.query(`DELETE FROM search_file_texts WHERE tenant_id = ? AND file_id IN (${batch.map(() => '?').join(',')})`, [tenantId, ...batch]);
      }
    },
    async searchDocuments({ includeWorkspace = true, limit, offset, projectIds, query, queryEmbedding = null, semanticFloor = DEFAULT_SEMANTIC_FLOOR, tenantId, types }) {
      const scope = { includeWorkspace, projectIds: new Set(projectIds), types: new Set(types) };
      const conditions = ['tenant_id = ?', includeWorkspace ? '(project_id IS NULL' : '(FALSE'];
      const params = [tenantId];
      if (projectIds.length) {
        conditions[1] += ` OR project_id IN (${projectIds.map(() => '?').join(',')})`;
        params.push(...projectIds);
      }
      conditions[1] += ')';
      if (types.length) {
        conditions.push(`document_type IN (${types.map(() => '?').join(',')})`);
        params.push(...types);
      }
      let lexical = [];
      if (String(query ?? '').trim()) {
        const [rows] = await pool.query(
          `SELECT ${RECORD_COLUMNS}, MATCH(title, content) AGAINST (? IN NATURAL LANGUAGE MODE) AS score FROM search_documents
           WHERE ${conditions.join(' AND ')} AND MATCH(title, content) AGAINST (? IN NATURAL LANGUAGE MODE)
           ORDER BY score DESC, source_updated_at DESC LIMIT ${CANDIDATES}`,
          [query, ...params, query],
        );
        lexical = rows.map((row) => ({ document: mapRecord(row), lexicalScore: Number(row.score ?? 0) }));
      }
      let semantic = [];
      if (queryEmbedding?.vector) {
        const entries = (await vectorsFor(tenantId, queryEmbedding.model, queryEmbedding.dimensions)).filter((entry) => inScope(entry, scope));
        const best = semanticCandidates(entries, queryEmbedding, semanticFloor);
        const records = await recordsById(tenantId, best.map((item) => item.entry.id));
        semantic = best.filter((item) => records.has(item.entry.id)).map((item) => ({ document: records.get(item.entry.id), similarity: item.similarity }));
      }
      return fuseResults({ lexical, limit, offset, semantic });
    },
  };
}
