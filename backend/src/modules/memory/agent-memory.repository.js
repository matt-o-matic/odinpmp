import { randomUUID } from 'node:crypto';

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function iso(value = new Date()) { return new Date(value).toISOString(); }
function terms(query) { return [...new Set(String(query).toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 1))]; }
function score(item, queryTerms) {
  const title = item.title.toLowerCase(); const content = item.content.toLowerCase();
  return queryTerms.reduce((total, term) => total + (title.includes(term) ? 5 : 0) + (content.includes(term) ? 2 : 0), 0);
}
function cosine(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length === 0 || left.length !== right.length) return null;
  let dot = 0; let leftNorm = 0; let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) { dot += left[index] * right[index]; leftNorm += left[index] ** 2; rightNorm += right[index] ** 2; }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : null;
}

function canRead(item, { ownerUserId, projectIds }) {
  if (item.deletedAt) return false;
  if (!item.legalHold && item.expiresAt && Date.parse(item.expiresAt) <= Date.now()) return false;
  if (item.projectId) return projectIds.includes(item.projectId);
  return item.ownerUserId === ownerUserId;
}

function rank(items, input) {
  const queryTerms = terms(input.query);
  return items
    .filter((item) => canRead(item, input))
    .filter((item) => input.types.length === 0 || input.types.includes(item.memoryType))
    .map((item) => {
      const lexicalRelevance = score(item, queryTerms); const semanticRelevance = cosine(item.embedding?.vector, input.queryEmbedding?.vector);
      const relevance = semanticRelevance == null ? lexicalRelevance : Math.round((Math.max(-1, semanticRelevance) * 100 + Math.min(25, lexicalRelevance)) * 100) / 100;
      return { item, lexicalRelevance, relevance, semanticRelevance };
    })
    .filter(({ lexicalRelevance, semanticRelevance }) => lexicalRelevance > 0 || semanticRelevance >= 0.15)
    .sort((left, right) => right.relevance - left.relevance || right.item.sourceAt.localeCompare(left.item.sourceAt) || left.item.id.localeCompare(right.item.id))
    .slice(0, input.limit)
    .map(({ item, lexicalRelevance, relevance, semanticRelevance }) => ({
      ...clone(item),
      embedding: item.embedding ? { contentHash: item.embedding.contentHash, dimensions: item.embedding.dimensions, embeddedAt: item.embedding.embeddedAt, model: item.embedding.model } : null,
      isStale: Boolean(item.freshnessAt && Date.parse(item.freshnessAt) <= Date.now()),
      lexicalRelevance,
      relevance,
      retrievalMode: semanticRelevance == null ? 'lexical' : lexicalRelevance > 0 ? 'hybrid' : 'semantic',
      semanticRelevance: semanticRelevance == null ? null : Math.round(semanticRelevance * 10_000) / 10_000,
    }));
}

function embeddingSummary(embedding) { return embedding ? { contentHash: embedding.contentHash, dimensions: embedding.dimensions, embeddedAt: embedding.embeddedAt, model: embedding.model } : null; }
function withBrowseFields(item) { return { ...clone(item), embedding: embeddingSummary(item.embedding), isStale: Boolean(item.freshnessAt && Date.parse(item.freshnessAt) <= Date.now()) }; }
const BROWSE_SORTS = Object.freeze({
  confidence: (left, right) => right.confidence - left.confidence || right.sourceAt.localeCompare(left.sourceAt) || left.id.localeCompare(right.id),
  newest: (left, right) => right.sourceAt.localeCompare(left.sourceAt) || left.id.localeCompare(right.id),
  oldest: (left, right) => left.sourceAt.localeCompare(right.sourceAt) || left.id.localeCompare(right.id),
});

function canBrowse(item, input) {
  if (item.deletedAt) return false;
  if (!item.legalHold && item.expiresAt && Date.parse(item.expiresAt) <= Date.now()) return false;
  const inScope = item.projectId ? input.projectIds.includes(item.projectId) : input.includePersonal && item.ownerUserId === input.ownerUserId;
  if (!inScope) return false;
  if (item.sensitivity === 'restricted' && !input.includeRestricted && item.createdBy !== input.ownerUserId) return false;
  if (input.types.length > 0 && !input.types.includes(item.memoryType)) return false;
  if (input.sensitivities.length > 0 && !input.sensitivities.includes(item.sensitivity)) return false;
  const query = input.query.toLowerCase();
  return !query || item.title.toLowerCase().includes(query) || item.content.toLowerCase().includes(query);
}

function versionConflict(actualVersion, expectedVersion) {
  return Object.assign(new Error('Memory changed since it was loaded.'), { actualVersion, code: 'agent_memory_version_conflict', expectedVersion });
}

export function createInMemoryAgentMemoryRepository(seed = []) {
  const state = new Map(seed.map((item) => [item.id, clone(item)]));
  return {
    state,
    async browse(input) {
      const matches = [...state.values()].filter((item) => item.tenantId === input.tenantId && canBrowse(item, input)).sort(BROWSE_SORTS[input.sort] ?? BROWSE_SORTS.newest);
      return { memories: matches.slice(input.offset, input.offset + input.limit).map(withBrowseFields), total: matches.length };
    },
    async correct({ changes, correction, embedding, expectedVersion, id, tenantId }) {
      const item = state.get(id);
      if (!item || item.tenantId !== tenantId || item.deletedAt) return null;
      if (item.version !== expectedVersion) throw versionConflict(item.version, expectedVersion);
      Object.assign(item, clone(changes));
      if (embedding !== undefined) item.embedding = embedding ? clone(embedding) : null;
      item.provenance = { ...item.provenance, corrections: [...(item.provenance?.corrections ?? []), correction].slice(-20) };
      item.updatedAt = iso(); item.version += 1;
      return clone(item);
    },
    async create(input) {
      const now = iso();
      const item = { ...clone(input), createdAt: now, deletedAt: null, expiresAt: input.expiresAt ? iso(input.expiresAt) : null, freshnessAt: input.freshnessAt ? iso(input.freshnessAt) : null, id: randomUUID(), legalHold: Boolean(input.legalHold), retentionPolicyId: input.retentionPolicyId ?? null, sourceAt: iso(input.sourceAt), updatedAt: now, version: 1 };
      state.set(item.id, item);
      return clone(item);
    },
    async forget({ expectedVersion, id, tenantId }) {
      const item = state.get(id);
      if (!item || item.tenantId !== tenantId || item.deletedAt) return null;
      if (item.version !== expectedVersion) throw Object.assign(new Error('Memory changed since it was loaded.'), { actualVersion: item.version, code: 'agent_memory_version_conflict', expectedVersion });
      item.deletedAt = iso(); item.embedding = null; item.updatedAt = item.deletedAt; item.version += 1;
      return clone(item);
    },
    async get({ id, tenantId }) { const item = state.get(id); return clone(item?.tenantId === tenantId && !item.deletedAt ? item : null); },
    async purgeExpired({ cutoffAt = new Date(), tenantId }) {
      let purged = 0;
      for (const item of state.values()) {
        if (item.tenantId !== tenantId || item.deletedAt || item.legalHold || !item.expiresAt || Date.parse(item.expiresAt) > new Date(cutoffAt).getTime()) continue;
        item.deletedAt = iso(cutoffAt); item.embedding = null; item.updatedAt = item.deletedAt; item.version += 1; purged += 1;
      }
      return purged;
    },
    async search(input) { return rank([...state.values()].filter((item) => item.tenantId === input.tenantId), input); },
    async updateGovernance({ expectedVersion, expiresAt, id, legalHold, retentionPolicyId, tenantId }) {
      const item = state.get(id);
      if (!item || item.tenantId !== tenantId || item.deletedAt) return null;
      if (item.version !== expectedVersion) throw Object.assign(new Error('Memory changed since it was loaded.'), { actualVersion: item.version, code: 'agent_memory_version_conflict', expectedVersion });
      if (expiresAt !== undefined) item.expiresAt = expiresAt ? iso(expiresAt) : null;
      if (legalHold !== undefined) item.legalHold = legalHold;
      if (retentionPolicyId !== undefined) item.retentionPolicyId = retentionPolicyId || null;
      item.updatedAt = iso(); item.version += 1; return clone(item);
    },
  };
}

export async function ensureMysqlAgentMemorySemanticSchema(executor) {
  await ensureMysqlAgentMemoryGovernanceSchema(executor);
  if (!await memoryColumnExists(executor, 'embedding_model')) await executor.execute('ALTER TABLE agent_memory_items ADD COLUMN embedding_model VARCHAR(128) NULL AFTER provenance_json, ADD COLUMN embedding_dimensions SMALLINT UNSIGNED NULL AFTER embedding_model, ADD COLUMN embedding_vector_json JSON NULL AFTER embedding_dimensions, ADD COLUMN embedding_content_hash CHAR(64) NULL AFTER embedding_vector_json, ADD COLUMN embedded_at DATETIME(3) NULL AFTER embedding_content_hash');
  const [indexes] = await executor.execute(`SELECT COUNT(*) AS count FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_memory_items' AND INDEX_NAME = 'idx_agent_memory_embedding'`);
  if (Number(indexes[0]?.count ?? 0) === 0) await executor.execute('ALTER TABLE agent_memory_items ADD KEY idx_agent_memory_embedding (tenant_id, embedding_model, embedding_dimensions, deleted_at)');
}

export async function ensureMysqlAgentMemorySchema(executor) {
  await executor.execute(`CREATE TABLE IF NOT EXISTS agent_memory_items (id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, project_id VARCHAR(36) NULL, owner_user_id VARCHAR(36) NOT NULL, memory_type VARCHAR(32) NOT NULL, title VARCHAR(255) NOT NULL, content TEXT NOT NULL, provenance_json JSON NOT NULL, source_at DATETIME(3) NOT NULL, freshness_at DATETIME(3) NULL, confidence DECIMAL(5,4) NOT NULL, sensitivity VARCHAR(32) NOT NULL, created_by VARCHAR(36) NOT NULL, version INT NOT NULL DEFAULT 1, deleted_at DATETIME(3) NULL, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, KEY idx_agent_memory_project (tenant_id, project_id, deleted_at, source_at), KEY idx_agent_memory_owner (tenant_id, owner_user_id, deleted_at, source_at), KEY idx_agent_memory_type (tenant_id, memory_type, deleted_at))`);
}

async function memoryColumnExists(executor, columnName) {
  const [rows] = await executor.execute(`SELECT COUNT(*) AS count FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_memory_items' AND COLUMN_NAME = ?`, [columnName]);
  return Number(rows[0]?.count ?? 0) > 0;
}

export async function ensureMysqlAgentMemoryGovernanceSchema(executor) {
  await ensureMysqlAgentMemorySchema(executor);
  if (!await memoryColumnExists(executor, 'expires_at')) await executor.execute('ALTER TABLE agent_memory_items ADD COLUMN expires_at DATETIME(3) NULL AFTER freshness_at');
  if (!await memoryColumnExists(executor, 'legal_hold')) await executor.execute('ALTER TABLE agent_memory_items ADD COLUMN legal_hold TINYINT(1) NOT NULL DEFAULT 0 AFTER expires_at');
  if (!await memoryColumnExists(executor, 'retention_policy_id')) await executor.execute('ALTER TABLE agent_memory_items ADD COLUMN retention_policy_id VARCHAR(128) NULL AFTER legal_hold');
  const [indexes] = await executor.execute(`SELECT COUNT(*) AS count FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_memory_items' AND INDEX_NAME = 'idx_agent_memory_retention'`);
  if (Number(indexes[0]?.count ?? 0) === 0) await executor.execute('ALTER TABLE agent_memory_items ADD KEY idx_agent_memory_retention (tenant_id, legal_hold, expires_at, deleted_at)');
}

function parseJson(value, fallback = {}) { if (value == null) return fallback; if (typeof value === 'object') return value; try { return JSON.parse(value); } catch { return fallback; } }
function mapRow(row) { return row ? { confidence: Number(row.confidence), content: row.content, createdAt: iso(row.created_at), createdBy: row.created_by, deletedAt: row.deleted_at ? iso(row.deleted_at) : null, embedding: row.embedding_vector_json ? { contentHash: row.embedding_content_hash, dimensions: Number(row.embedding_dimensions), embeddedAt: iso(row.embedded_at), model: row.embedding_model, vector: parseJson(row.embedding_vector_json, []) } : null, expiresAt: row.expires_at ? iso(row.expires_at) : null, freshnessAt: row.freshness_at ? iso(row.freshness_at) : null, id: row.id, legalHold: Boolean(row.legal_hold), memoryType: row.memory_type, ownerUserId: row.owner_user_id, projectId: row.project_id, provenance: parseJson(row.provenance_json), retentionPolicyId: row.retention_policy_id ?? null, sensitivity: row.sensitivity, sourceAt: iso(row.source_at), tenantId: row.tenant_id, title: row.title, updatedAt: iso(row.updated_at), version: Number(row.version) } : null; }

// Browsing never needs the vectors, so they stay in the database.
const BROWSE_COLUMNS = 'id, tenant_id, project_id, owner_user_id, memory_type, title, content, provenance_json, embedding_model, embedding_dimensions, embedding_content_hash, embedded_at, source_at, freshness_at, expires_at, legal_hold, retention_policy_id, confidence, sensitivity, created_by, version, deleted_at, created_at, updated_at';
const BROWSE_ORDER = Object.freeze({ confidence: 'confidence DESC, source_at DESC, id', newest: 'source_at DESC, id', oldest: 'source_at ASC, id' });
const CORRECTABLE_COLUMNS = Object.freeze([['title', 'title'], ['content', 'content'], ['memoryType', 'memory_type'], ['confidence', 'confidence'], ['sensitivity', 'sensitivity']]);
function escapeLike(value) { return String(value).replace(/[\\%_]/g, (character) => `\\${character}`); }
function mapBrowseRow(row) {
  const item = mapRow(row);
  item.embedding = row.embedding_model ? { contentHash: row.embedding_content_hash, dimensions: Number(row.embedding_dimensions), embeddedAt: row.embedded_at ? iso(row.embedded_at) : null, model: row.embedding_model } : null;
  item.isStale = Boolean(item.freshnessAt && Date.parse(item.freshnessAt) <= Date.now());
  return item;
}

export function createMysqlAgentMemoryRepository({ pool }) {
  return {
    async browse(input) {
      const clauses = ['tenant_id = ?', 'deleted_at IS NULL', '(legal_hold = 1 OR expires_at IS NULL OR expires_at > NOW(3))']; const params = [input.tenantId]; const scope = [];
      if (input.projectIds.length > 0) { scope.push(`project_id IN (${input.projectIds.map(() => '?').join(',')})`); params.push(...input.projectIds); }
      if (input.includePersonal) { scope.push('(project_id IS NULL AND owner_user_id = ?)'); params.push(input.ownerUserId); }
      if (scope.length === 0) return { memories: [], total: 0 };
      clauses.push(`(${scope.join(' OR ')})`);
      if (!input.includeRestricted) { clauses.push("(sensitivity <> 'restricted' OR created_by = ?)"); params.push(input.ownerUserId); }
      if (input.types.length > 0) { clauses.push(`memory_type IN (${input.types.map(() => '?').join(',')})`); params.push(...input.types); }
      if (input.sensitivities.length > 0) { clauses.push(`sensitivity IN (${input.sensitivities.map(() => '?').join(',')})`); params.push(...input.sensitivities); }
      if (input.query) { const pattern = `%${escapeLike(input.query)}%`; clauses.push('(title LIKE ? OR content LIKE ?)'); params.push(pattern, pattern); }
      const where = clauses.join(' AND ');
      const limit = Math.max(1, Math.min(100, Number.parseInt(input.limit, 10) || 25)); const offset = Math.max(0, Math.min(10_000, Number.parseInt(input.offset, 10) || 0));
      const [countRows] = await pool.execute(`SELECT COUNT(*) AS count FROM agent_memory_items WHERE ${where}`, params);
      const [rows] = await pool.execute(`SELECT ${BROWSE_COLUMNS} FROM agent_memory_items WHERE ${where} ORDER BY ${BROWSE_ORDER[input.sort] ?? BROWSE_ORDER.newest} LIMIT ${limit} OFFSET ${offset}`, params);
      return { memories: rows.map(mapBrowseRow), total: Number(countRows[0]?.count ?? 0) };
    },
    async correct({ changes, correction, embedding, expectedVersion, id, tenantId }) {
      const [currentRows] = await pool.execute('SELECT provenance_json, version FROM agent_memory_items WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL LIMIT 1', [id, tenantId]);
      if (!currentRows[0]) return null;
      if (Number(currentRows[0].version) !== expectedVersion) throw versionConflict(Number(currentRows[0].version), expectedVersion);
      const provenance = parseJson(currentRows[0].provenance_json);
      provenance.corrections = [...(Array.isArray(provenance.corrections) ? provenance.corrections : []), correction].slice(-20);
      const fields = []; const params = [];
      for (const [key, column] of CORRECTABLE_COLUMNS) if (changes[key] !== undefined) { fields.push(`${column} = ?`); params.push(changes[key]); }
      fields.push('provenance_json = ?'); params.push(JSON.stringify(provenance));
      if (embedding !== undefined) { fields.push('embedding_model = ?', 'embedding_dimensions = ?', 'embedding_vector_json = ?', 'embedding_content_hash = ?', 'embedded_at = ?'); params.push(embedding?.model ?? null, embedding?.dimensions ?? null, embedding ? JSON.stringify(embedding.vector) : null, embedding?.contentHash ?? null, embedding?.embeddedAt ? new Date(embedding.embeddedAt) : null); }
      const [result] = await pool.execute(`UPDATE agent_memory_items SET ${fields.join(', ')}, updated_at = NOW(3), version = version + 1 WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND version = ?`, [...params, id, tenantId, expectedVersion]);
      if (Number(result.affectedRows) !== 1) { const [rows] = await pool.execute('SELECT version FROM agent_memory_items WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL LIMIT 1', [id, tenantId]); if (!rows[0]) return null; throw versionConflict(Number(rows[0].version), expectedVersion); }
      const [rows] = await pool.execute('SELECT * FROM agent_memory_items WHERE id = ? LIMIT 1', [id]); return mapRow(rows[0]);
    },
    async create(input) {
      const id = randomUUID(); const now = new Date();
      await pool.execute(`INSERT INTO agent_memory_items (id, tenant_id, project_id, owner_user_id, memory_type, title, content, provenance_json, embedding_model, embedding_dimensions, embedding_vector_json, embedding_content_hash, embedded_at, source_at, freshness_at, confidence, sensitivity, created_by, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`, [id, input.tenantId, input.projectId, input.ownerUserId, input.memoryType, input.title, input.content, JSON.stringify(input.provenance), input.embedding?.model ?? null, input.embedding?.dimensions ?? null, input.embedding ? JSON.stringify(input.embedding.vector) : null, input.embedding?.contentHash ?? null, input.embedding?.embeddedAt ? new Date(input.embedding.embeddedAt) : null, new Date(input.sourceAt), input.freshnessAt ? new Date(input.freshnessAt) : null, input.confidence, input.sensitivity, input.createdBy, now, now]);
      const [rows] = await pool.execute('SELECT * FROM agent_memory_items WHERE id = ? LIMIT 1', [id]); return mapRow(rows[0]);
    },
    async forget({ expectedVersion, id, tenantId }) {
      const [result] = await pool.execute('UPDATE agent_memory_items SET deleted_at = NOW(3), embedding_vector_json = NULL, embedding_model = NULL, embedding_dimensions = NULL, embedding_content_hash = NULL, embedded_at = NULL, updated_at = NOW(3), version = version + 1 WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND version = ?', [id, tenantId, expectedVersion]);
      if (Number(result.affectedRows) !== 1) { const [rows] = await pool.execute('SELECT version FROM agent_memory_items WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL LIMIT 1', [id, tenantId]); if (rows.length === 0) return null; throw Object.assign(new Error('Memory changed since it was loaded.'), { actualVersion: Number(rows[0].version), code: 'agent_memory_version_conflict', expectedVersion }); }
      const [rows] = await pool.execute('SELECT * FROM agent_memory_items WHERE id = ? LIMIT 1', [id]); return mapRow(rows[0]);
    },
    async get({ id, tenantId }) { const [rows] = await pool.execute('SELECT * FROM agent_memory_items WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL LIMIT 1', [id, tenantId]); return mapRow(rows[0]); },
    async purgeExpired({ cutoffAt = new Date(), tenantId }) { const [result] = await pool.execute('UPDATE agent_memory_items SET deleted_at = ?, embedding_vector_json = NULL, embedding_model = NULL, embedding_dimensions = NULL, embedding_content_hash = NULL, embedded_at = NULL, updated_at = ?, version = version + 1 WHERE tenant_id = ? AND deleted_at IS NULL AND legal_hold = 0 AND expires_at IS NOT NULL AND expires_at <= ?', [cutoffAt, cutoffAt, tenantId, cutoffAt]); return Number(result.affectedRows); },
    async search(input) {
      const projectIds = input.projectIds.slice(0, 100); const clauses = ['tenant_id = ?', 'deleted_at IS NULL', '(legal_hold = 1 OR expires_at IS NULL OR expires_at > NOW(3))']; const params = [input.tenantId];
      if (projectIds.length > 0) { clauses.push(`(project_id IN (${projectIds.map(() => '?').join(',')}) OR (project_id IS NULL AND owner_user_id = ?))`); params.push(...projectIds, input.ownerUserId); }
      else { clauses.push('project_id IS NULL AND owner_user_id = ?'); params.push(input.ownerUserId); }
      const [rows] = await pool.execute(`SELECT * FROM agent_memory_items WHERE ${clauses.join(' AND ')} ORDER BY source_at DESC LIMIT 500`, params);
      return rank(rows.map(mapRow), input);
    },
    async updateGovernance({ expectedVersion, expiresAt, id, legalHold, retentionPolicyId, tenantId }) {
      const fields = []; const params = [];
      if (expiresAt !== undefined) { fields.push('expires_at = ?'); params.push(expiresAt ? new Date(expiresAt) : null); }
      if (legalHold !== undefined) { fields.push('legal_hold = ?'); params.push(legalHold ? 1 : 0); }
      if (retentionPolicyId !== undefined) { fields.push('retention_policy_id = ?'); params.push(retentionPolicyId || null); }
      if (fields.length === 0) { const [rows] = await pool.execute('SELECT * FROM agent_memory_items WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL LIMIT 1', [id, tenantId]); return mapRow(rows[0]); }
      const [result] = await pool.execute(`UPDATE agent_memory_items SET ${fields.join(', ')}, updated_at = NOW(3), version = version + 1 WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND version = ?`, [...params, id, tenantId, expectedVersion]);
      if (Number(result.affectedRows) !== 1) { const [rows] = await pool.execute('SELECT version FROM agent_memory_items WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL LIMIT 1', [id, tenantId]); if (!rows[0]) return null; throw Object.assign(new Error('Memory changed since it was loaded.'), { actualVersion: Number(rows[0].version), code: 'agent_memory_version_conflict', expectedVersion }); }
      const [rows] = await pool.execute('SELECT * FROM agent_memory_items WHERE id = ? LIMIT 1', [id]); return mapRow(rows[0]);
    },
  };
}
