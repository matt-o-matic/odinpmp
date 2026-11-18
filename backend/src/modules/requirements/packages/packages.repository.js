import { createHash, randomUUID } from 'node:crypto';

// Review package storage. Package rows and screens live in the U1 tables from migration
// 0053 (review_packages, review_package_screens), so the My open items query sees drafts
// with no extra wiring. Migration 0057 below adds what 0053 lacks: a column for validation
// warnings, a per-package file index for the review origin, and single-use upload URLs.
// Migration 0064 lets an upload URL name the draft its package replaces.
//
// 0057 and 0064 are registered in src/jobs/bootstrap-schema.lib.js. The migration runner
// checksums their bodies: never edit one; add a new migration instead.

async function tableExists(executor, tableName) {
  const [rows] = await executor.execute(
    'SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1',
    [tableName],
  );
  return Number(rows[0]?.count ?? 0) > 0;
}

async function columnExists(executor, tableName, columnName) {
  const [rows] = await executor.execute(
    'SELECT COUNT(*) AS count FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1',
    [tableName, columnName],
  );
  return Number(rows[0]?.count ?? 0) > 0;
}

// 0057_review_package_storage
export async function ensureMysqlReviewPackageStorageSchema(executor) {
  if (!await columnExists(executor, 'review_packages', 'warnings_json')) {
    await executor.execute('ALTER TABLE review_packages ADD COLUMN warnings_json JSON NULL');
  }

  if (!await tableExists(executor, 'review_package_files')) {
    await executor.execute(`
      CREATE TABLE review_package_files (
        tenant_id VARCHAR(36) NOT NULL,
        project_id VARCHAR(36) NOT NULL,
        package_id VARCHAR(36) NOT NULL,
        path_hash CHAR(64) NOT NULL,
        path VARCHAR(512) NOT NULL,
        storage_key VARCHAR(160) NOT NULL,
        content_type VARCHAR(80) NOT NULL,
        size_bytes BIGINT NOT NULL,
        sha256 CHAR(64) NOT NULL,
        created_at DATETIME(3) NOT NULL,
        PRIMARY KEY (package_id, path_hash),
        KEY idx_review_package_files_project (tenant_id, project_id)
      )
    `);
  }

  if (!await tableExists(executor, 'review_package_uploads')) {
    await executor.execute(`
      CREATE TABLE review_package_uploads (
        id VARCHAR(36) NOT NULL PRIMARY KEY,
        tenant_id VARCHAR(36) NOT NULL,
        project_id VARCHAR(36) NOT NULL,
        track VARCHAR(16) NOT NULL,
        token_hash CHAR(64) NOT NULL,
        issued_to VARCHAR(80) NOT NULL,
        state VARCHAR(16) NOT NULL DEFAULT 'pending',
        package_id VARCHAR(36) NULL,
        result_json JSON NULL,
        expires_at DATETIME(3) NOT NULL,
        used_at DATETIME(3) NULL,
        completed_at DATETIME(3) NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY uq_review_package_uploads_token (token_hash),
        KEY idx_review_package_uploads_project (tenant_id, project_id)
      )
    `);
  }
}

// 0064_review_package_replacement
export async function ensureMysqlReviewPackageReplacementSchema(executor) {
  if (!await columnExists(executor, 'review_package_uploads', 'replaces_package_id')) {
    await executor.execute('ALTER TABLE review_package_uploads ADD COLUMN replaces_package_id VARCHAR(36) NULL');
  }
}

export function pathHash(path) {
  return createHash('sha256').update(String(path), 'utf8').digest('hex');
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function toSeconds(value) {
  const date = value instanceof Date ? value : new Date(value);
  return date.valueOf() / 1000;
}

function fromUnix(value) {
  if (value === null || value === undefined) return null;
  const date = new Date(Number(value) * 1000);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function summaryOf(record) {
  return {
    createdAt: record.createdAt,
    fileCount: Number(record.fileCount ?? 0),
    id: record.id,
    projectId: record.projectId,
    sizeBytes: Number(record.sizeBytes ?? 0),
    source: record.source,
    status: record.status,
    tenantId: record.tenantId,
    title: record.title,
    track: record.track,
    updatedAt: record.updatedAt,
    uploadedBy: record.uploadedBy,
    version: Number(record.version),
    warningCount: Array.isArray(record.warnings) ? record.warnings.length : 0,
  };
}

function uploadOf(record) {
  return record ? clone(record) : null;
}

// ---------------------------------------------------------------------------
// In-memory
// ---------------------------------------------------------------------------

export function createInMemoryPackagesRepository({ requirementsRepository = null } = {}) {
  // Package rows share the requirements repository's state when there is one, as the two
  // MySQL repositories share review_packages.
  const packages = requirementsRepository?.state?.packages ?? [];
  const screens = new Map();
  const files = new Map();
  const uploads = [];

  function find(packageId) {
    return packages.find((record) => record.id === packageId) ?? null;
  }

  function detail(record) {
    if (!record) return null;
    return {
      ...summaryOf(record),
      manifest: clone(record.manifest ?? null),
      screens: clone(screens.get(record.id) ?? []),
      warnings: clone(record.warnings ?? []),
    };
  }

  function insert({ files: fileRows = [], pkg, screens: screenRows = [] }) {
    const now = new Date().toISOString();
    const version = packages
      .filter((record) => record.tenantId === pkg.tenantId && record.projectId === pkg.projectId && record.track === pkg.track)
      .reduce((max, record) => Math.max(max, Number(record.version)), 0) + 1;
    const record = {
      createdAt: now,
      fileCount: Number(pkg.fileCount ?? fileRows.length),
      id: pkg.id ?? randomUUID(),
      manifest: clone(pkg.manifest),
      projectId: pkg.projectId,
      sizeBytes: Number(pkg.sizeBytes ?? 0),
      source: pkg.source ?? 'ui',
      status: 'draft',
      tenantId: pkg.tenantId,
      title: String(pkg.title ?? '').trim(),
      track: pkg.track,
      updatedAt: now,
      uploadedBy: pkg.uploadedBy,
      version,
      warnings: clone(pkg.warnings ?? []),
    };
    packages.push(record);
    screens.set(record.id, screenRows.map((screen) => ({
      contentHash: screen.contentHash,
      directionId: screen.directionId ?? null,
      kind: screen.kind,
      screenId: screen.screenId,
      src: screen.src,
    })));
    files.set(record.id, new Map(fileRows.map((file) => [file.path, {
      contentType: file.contentType,
      path: file.path,
      sha256: file.sha256,
      sizeBytes: file.size,
      storageKey: file.storageKey,
    }])));
    return detail(record);
  }

  return {
    async insertPackage(input) {
      return insert(input);
    },

    // The new draft is stored only while the replaced package is still a draft of the same
    // tenant, project and track; it becomes withdrawn in the same step. Null otherwise.
    async replaceDraftPackage({ files: fileRows = [], pkg, replacesPackageId, screens: screenRows = [] }) {
      const replaced = find(replacesPackageId);
      if (!replaced || replaced.tenantId !== pkg.tenantId || replaced.projectId !== pkg.projectId
        || replaced.track !== pkg.track || replaced.status !== 'draft') return null;
      const stored = insert({ files: fileRows, pkg, screens: screenRows });
      replaced.status = 'withdrawn';
      replaced.updatedAt = new Date().toISOString();
      return { package: stored, replaced: detail(replaced) };
    },

    async getPackage({ packageId, projectId, tenantId }) {
      const record = find(packageId);
      if (!record || record.projectId !== projectId || record.tenantId !== tenantId) return null;
      return detail(record);
    },

    async getPackageById(packageId) {
      return detail(find(packageId));
    },

    async listPackages({ projectId, status = '', tenantId, track = '' }) {
      return packages
        .filter((record) => record.projectId === projectId && record.tenantId === tenantId
          && (!track || record.track === track) && (!status || record.status === status))
        .map(summaryOf)
        .sort((left, right) => (left.track === right.track ? right.version - left.version : left.track.localeCompare(right.track)));
    },

    async findBaselinePackage({ beforeVersion, projectId, tenantId, track }) {
      const candidates = packages
        .filter((record) => record.projectId === projectId && record.tenantId === tenantId && record.track === track
          && record.status === 'published' && Number(record.version) < beforeVersion)
        .sort((left, right) => right.version - left.version);
      return detail(candidates[0] ?? null);
    },

    async setPackageStatus({ from, packageId, projectId, tenantId, to }) {
      const record = find(packageId);
      if (!record || record.projectId !== projectId || record.tenantId !== tenantId || record.status !== from) return null;
      record.status = to;
      record.updatedAt = new Date().toISOString();
      return detail(record);
    },

    async getPackageFile({ packageId, path }) {
      return clone(files.get(packageId)?.get(path) ?? null);
    },

    async listPackageFiles({ packageId }) {
      return clone([...(files.get(packageId)?.values() ?? [])]);
    },

    async deletePackageFiles({ packageId }) {
      files.delete(packageId);
    },

    async createUpload({ upload }) {
      const now = new Date().toISOString();
      const record = {
        completedAt: null,
        createdAt: now,
        expiresAt: toIso(upload.expiresAt),
        id: upload.id ?? randomUUID(),
        issuedTo: upload.issuedTo,
        packageId: null,
        projectId: upload.projectId,
        replacesPackageId: upload.replacesPackageId ?? null,
        result: null,
        state: 'pending',
        tenantId: upload.tenantId,
        tokenHash: upload.tokenHash,
        track: upload.track,
        updatedAt: now,
        usedAt: null,
      };
      uploads.push(record);
      return uploadOf(record);
    },

    async findUploadByTokenHash({ tokenHash }) {
      return uploadOf(uploads.find((record) => record.tokenHash === tokenHash) ?? null);
    },

    async claimUpload({ now, tokenHash }) {
      const record = uploads.find((item) => item.tokenHash === tokenHash) ?? null;
      if (!record || record.state !== 'pending' || Date.parse(record.expiresAt) <= new Date(now).valueOf()) return null;
      record.state = 'processing';
      record.usedAt = toIso(now);
      record.updatedAt = toIso(now);
      return uploadOf(record);
    },

    async completeUpload({ now, packageId = null, result, state, uploadId }) {
      const record = uploads.find((item) => item.id === uploadId) ?? null;
      if (!record) return null;
      record.state = state;
      record.packageId = packageId;
      record.result = clone(result ?? null);
      record.completedAt = toIso(now);
      record.updatedAt = toIso(now);
      return uploadOf(record);
    },

    async getUpload({ projectId, tenantId, uploadId }) {
      const record = uploads.find((item) => item.id === uploadId && item.projectId === projectId && item.tenantId === tenantId) ?? null;
      return uploadOf(record);
    },
  };
}

// ---------------------------------------------------------------------------
// MySQL
// ---------------------------------------------------------------------------

const PACKAGE_COLUMNS = `
  id, tenant_id AS tenantId, project_id AS projectId, track, version, title, status, source,
  size_bytes AS sizeBytes, file_count AS fileCount, uploaded_by AS uploadedBy,
  UNIX_TIMESTAMP(created_at) AS createdAt, UNIX_TIMESTAMP(updated_at) AS updatedAt
`;

const UPLOAD_COLUMNS = `
  id, tenant_id AS tenantId, project_id AS projectId, track, token_hash AS tokenHash, issued_to AS issuedTo,
  state, package_id AS packageId, replaces_package_id AS replacesPackageId, result_json AS resultJson,
  UNIX_TIMESTAMP(expires_at) AS expiresAt, UNIX_TIMESTAMP(used_at) AS usedAt,
  UNIX_TIMESTAMP(completed_at) AS completedAt, UNIX_TIMESTAMP(created_at) AS createdAt,
  UNIX_TIMESTAMP(updated_at) AS updatedAt
`;

function mapPackageRow(row) {
  return {
    createdAt: fromUnix(row.createdAt),
    fileCount: Number(row.fileCount),
    id: row.id,
    projectId: row.projectId,
    sizeBytes: Number(row.sizeBytes),
    source: row.source,
    status: row.status,
    tenantId: row.tenantId,
    title: row.title,
    track: row.track,
    updatedAt: fromUnix(row.updatedAt),
    uploadedBy: row.uploadedBy,
    version: Number(row.version),
  };
}

function mapUploadRow(row) {
  if (!row) return null;
  return {
    completedAt: fromUnix(row.completedAt),
    createdAt: fromUnix(row.createdAt),
    expiresAt: fromUnix(row.expiresAt),
    id: row.id,
    issuedTo: row.issuedTo,
    packageId: row.packageId ?? null,
    projectId: row.projectId,
    replacesPackageId: row.replacesPackageId ?? null,
    result: parseJson(row.resultJson, null),
    state: row.state,
    tenantId: row.tenantId,
    tokenHash: row.tokenHash,
    track: row.track,
    updatedAt: fromUnix(row.updatedAt),
    usedAt: fromUnix(row.usedAt),
  };
}

export function createMysqlPackagesRepository({ pool }) {
  async function loadDetail(executor, where, params) {
    const [rows] = await executor.execute(
      `SELECT ${PACKAGE_COLUMNS}, manifest_json AS manifestJson, warnings_json AS warningsJson FROM review_packages WHERE ${where} LIMIT 1`,
      params,
    );
    const row = rows[0];
    if (!row) return null;
    const [screenRows] = await executor.execute(
      `
        SELECT screen_id AS screenId, kind, src, content_hash AS contentHash, direction_id AS directionId
        FROM review_package_screens
        WHERE package_id = ?
      `,
      [row.id],
    );
    const manifest = parseJson(row.manifestJson, null);
    const order = new Map((manifest?.sections ?? []).find((section) => section.type === 'screens')?.items?.map((item, index) => [item.id, index]) ?? []);
    const warnings = parseJson(row.warningsJson, []);
    return {
      ...mapPackageRow(row),
      manifest,
      screens: screenRows
        .map((screen) => ({
          contentHash: screen.contentHash,
          directionId: screen.directionId ?? null,
          kind: screen.kind,
          screenId: screen.screenId,
          src: screen.src,
        }))
        .sort((left, right) => (order.get(left.screenId) ?? 0) - (order.get(right.screenId) ?? 0)),
      warningCount: warnings.length,
      warnings,
    };
  }

  // Returns `{ package, replaced }`, read inside the transaction so that nothing fallible runs
  // after a successful commit, and the caller's cleanup of written files on error stays
  // correct. Null, having written nothing, when `replacesPackageId` is no longer a draft.
  async function insertOnce({ files, pkg, replacesPackageId = null, screens }) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const nowSeconds = toSeconds(new Date());
      if (replacesPackageId) {
        // A row lock on the replaced draft: a concurrent replacement or publish of the same
        // draft waits here, then matches nothing once this transaction commits.
        const [replaced] = await connection.execute(
          `
            UPDATE review_packages
            SET status = 'withdrawn', updated_at = FROM_UNIXTIME(?)
            WHERE tenant_id = ? AND project_id = ? AND track = ? AND id = ? AND status = 'draft'
          `,
          [nowSeconds, pkg.tenantId, pkg.projectId, pkg.track, replacesPackageId],
        );
        if (Number(replaced.affectedRows ?? 0) !== 1) {
          await connection.rollback();
          return null;
        }
      }
      // Optimistic: the unique (tenant, project, track, version) key decides a race and the
      // loser retries with a fresh read. A locking read here takes gap locks that deadlock
      // concurrent uploads to the same track.
      const [versionRows] = await connection.execute(
        'SELECT COALESCE(MAX(version), 0) AS version FROM review_packages WHERE tenant_id = ? AND project_id = ? AND track = ?',
        [pkg.tenantId, pkg.projectId, pkg.track],
      );
      const version = Number(versionRows[0]?.version ?? 0) + 1;
      await connection.execute(
        `
          INSERT INTO review_packages (
            id, tenant_id, project_id, track, version, title, manifest_json, warnings_json, status, source,
            size_bytes, file_count, uploaded_by, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, FROM_UNIXTIME(?), FROM_UNIXTIME(?))
        `,
        [
          pkg.id, pkg.tenantId, pkg.projectId, pkg.track, version, String(pkg.title ?? '').trim().slice(0, 255),
          JSON.stringify(pkg.manifest ?? {}), JSON.stringify(pkg.warnings ?? []), pkg.source ?? 'ui',
          Number(pkg.sizeBytes ?? 0), Number(pkg.fileCount ?? files.length), pkg.uploadedBy, nowSeconds, nowSeconds,
        ],
      );
      for (const screen of screens) {
        await connection.execute(
          `
            INSERT INTO review_package_screens (
              tenant_id, project_id, package_id, screen_id, kind, src, content_hash, direction_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?))
          `,
          [pkg.tenantId, pkg.projectId, pkg.id, screen.screenId, screen.kind, screen.src, screen.contentHash, screen.directionId ?? null, nowSeconds],
        );
      }
      for (let offset = 0; offset < files.length; offset += 200) {
        const batch = files.slice(offset, offset + 200);
        await connection.query(
          `
            INSERT INTO review_package_files (
              tenant_id, project_id, package_id, path_hash, path, storage_key, content_type, size_bytes, sha256, created_at
            ) VALUES ?
          `,
          [batch.map((file) => [
            pkg.tenantId, pkg.projectId, pkg.id, pathHash(file.path), file.path, file.storageKey, file.contentType, file.size, file.sha256,
            new Date(nowSeconds * 1000),
          ])],
        );
      }
      const stored = await loadDetail(connection, 'id = ?', [pkg.id]);
      const replaced = replacesPackageId ? await loadDetail(connection, 'id = ?', [replacesPackageId]) : null;
      await connection.commit();
      return { package: stored, replaced };
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }

  async function insertWithRetry(input) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await insertOnce(input);
      } catch (error) {
        const retryable = error?.code === 'ER_DUP_ENTRY' || error?.code === 'ER_LOCK_DEADLOCK';
        if (!retryable || attempt >= 6) throw error;
        await new Promise((resolve) => { setTimeout(resolve, 10 * attempt + Math.floor(Math.random() * 20)); });
      }
    }
  }

  return {
    async insertPackage({ files = [], pkg, screens = [] }) {
      const record = { ...pkg, id: pkg.id ?? randomUUID() };
      return (await insertWithRetry({ files, pkg: record, screens })).package;
    },

    // The new draft is stored only while the replaced package is still a draft of the same
    // tenant, project and track; it becomes withdrawn in the same transaction. Null otherwise.
    async replaceDraftPackage({ files = [], pkg, replacesPackageId, screens = [] }) {
      const record = { ...pkg, id: pkg.id ?? randomUUID() };
      return insertWithRetry({ files, pkg: record, replacesPackageId, screens });
    },

    async getPackage({ packageId, projectId, tenantId }) {
      return loadDetail(pool, 'tenant_id = ? AND project_id = ? AND id = ?', [tenantId, projectId, packageId]);
    },

    async getPackageById(packageId) {
      return loadDetail(pool, 'id = ?', [packageId]);
    },

    async listPackages({ projectId, status = '', tenantId, track = '' }) {
      const predicates = ['tenant_id = ?', 'project_id = ?'];
      const params = [tenantId, projectId];
      if (track) { predicates.push('track = ?'); params.push(track); }
      if (status) { predicates.push('status = ?'); params.push(status); }
      const [rows] = await pool.execute(
        `
          SELECT ${PACKAGE_COLUMNS}, COALESCE(JSON_LENGTH(warnings_json), 0) AS warningCount
          FROM review_packages
          WHERE ${predicates.join(' AND ')}
          ORDER BY track ASC, version DESC
        `,
        params,
      );
      return rows.map((row) => ({ ...mapPackageRow(row), warningCount: Number(row.warningCount ?? 0) }));
    },

    async findBaselinePackage({ beforeVersion, projectId, tenantId, track }) {
      const [rows] = await pool.execute(
        `
          SELECT id FROM review_packages
          WHERE tenant_id = ? AND project_id = ? AND track = ? AND status = 'published' AND version < ?
          ORDER BY version DESC
          LIMIT 1
        `,
        [tenantId, projectId, track, beforeVersion],
      );
      return rows[0] ? loadDetail(pool, 'id = ?', [rows[0].id]) : null;
    },

    async setPackageStatus({ from, packageId, projectId, tenantId, to }) {
      const [result] = await pool.execute(
        `
          UPDATE review_packages
          SET status = ?, updated_at = FROM_UNIXTIME(?)
          WHERE tenant_id = ? AND project_id = ? AND id = ? AND status = ?
        `,
        [to, toSeconds(new Date()), tenantId, projectId, packageId, from],
      );
      if (Number(result.affectedRows ?? 0) !== 1) return null;
      return loadDetail(pool, 'id = ?', [packageId]);
    },

    async getPackageFile({ packageId, path }) {
      const [rows] = await pool.execute(
        `
          SELECT path, storage_key AS storageKey, content_type AS contentType, size_bytes AS sizeBytes, sha256
          FROM review_package_files
          WHERE package_id = ? AND path_hash = ?
          LIMIT 1
        `,
        [packageId, pathHash(path)],
      );
      const row = rows[0];
      if (!row || row.path !== path) return null;
      return { ...row, sizeBytes: Number(row.sizeBytes) };
    },

    async listPackageFiles({ packageId }) {
      const [rows] = await pool.execute(
        `
          SELECT path, storage_key AS storageKey, content_type AS contentType, size_bytes AS sizeBytes, sha256
          FROM review_package_files
          WHERE package_id = ?
          ORDER BY path ASC
        `,
        [packageId],
      );
      return rows.map((row) => ({ ...row, sizeBytes: Number(row.sizeBytes) }));
    },

    async deletePackageFiles({ packageId }) {
      await pool.execute('DELETE FROM review_package_files WHERE package_id = ?', [packageId]);
    },

    async createUpload({ upload }) {
      const id = upload.id ?? randomUUID();
      const nowSeconds = toSeconds(new Date());
      await pool.execute(
        `
          INSERT INTO review_package_uploads (
            id, tenant_id, project_id, track, token_hash, issued_to, state, replaces_package_id, expires_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, FROM_UNIXTIME(?), FROM_UNIXTIME(?), FROM_UNIXTIME(?))
        `,
        [
          id, upload.tenantId, upload.projectId, upload.track, upload.tokenHash, upload.issuedTo, upload.replacesPackageId ?? null,
          toSeconds(upload.expiresAt), nowSeconds, nowSeconds,
        ],
      );
      const [rows] = await pool.execute(`SELECT ${UPLOAD_COLUMNS} FROM review_package_uploads WHERE id = ? LIMIT 1`, [id]);
      return mapUploadRow(rows[0]);
    },

    async findUploadByTokenHash({ tokenHash }) {
      const [rows] = await pool.execute(`SELECT ${UPLOAD_COLUMNS} FROM review_package_uploads WHERE token_hash = ? LIMIT 1`, [tokenHash]);
      return mapUploadRow(rows[0]);
    },

    async claimUpload({ now, tokenHash }) {
      const nowSeconds = toSeconds(now);
      const [result] = await pool.execute(
        `
          UPDATE review_package_uploads
          SET state = 'processing', used_at = FROM_UNIXTIME(?), updated_at = FROM_UNIXTIME(?)
          WHERE token_hash = ? AND state = 'pending' AND expires_at > FROM_UNIXTIME(?)
        `,
        [nowSeconds, nowSeconds, tokenHash, nowSeconds],
      );
      if (Number(result.affectedRows ?? 0) !== 1) return null;
      return this.findUploadByTokenHash({ tokenHash });
    },

    async completeUpload({ now, packageId = null, result, state, uploadId }) {
      const nowSeconds = toSeconds(now);
      await pool.execute(
        `
          UPDATE review_package_uploads
          SET state = ?, package_id = ?, result_json = ?, completed_at = FROM_UNIXTIME(?), updated_at = FROM_UNIXTIME(?)
          WHERE id = ?
        `,
        [state, packageId, JSON.stringify(result ?? null), nowSeconds, nowSeconds, uploadId],
      );
      const [rows] = await pool.execute(`SELECT ${UPLOAD_COLUMNS} FROM review_package_uploads WHERE id = ? LIMIT 1`, [uploadId]);
      return mapUploadRow(rows[0]);
    },

    async getUpload({ projectId, tenantId, uploadId }) {
      const [rows] = await pool.execute(
        `SELECT ${UPLOAD_COLUMNS} FROM review_package_uploads WHERE tenant_id = ? AND project_id = ? AND id = ? LIMIT 1`,
        [tenantId, projectId, uploadId],
      );
      return mapUploadRow(rows[0]);
    },
  };
}
