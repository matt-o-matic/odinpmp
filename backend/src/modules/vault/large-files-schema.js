// 0097_large_files: files up to 1 GB, uploaded in parts and scanned after upload.
//
// - file_size becomes BIGINT on file_vault and file_versions.
// - Each file and version gets its SHA-256, a scan status (pending, clean, infected, failed) with
//   the time of the scan, and a preview object. Rows saved before this were scanned before they
//   were saved, so they are clean. New rows default to pending: a row written without a status is
//   not downloadable until the scan worker passes it.
// - file_versions gets deleted_at and deleted_by: a deleted old version keeps its row and number.
// - file_vault gets folder_id and the editing marker (editing_by, editing_since).
// - file_folders holds folders, by project and channel.
// - file_uploads holds multipart uploads in progress.
//
// Additive only, so the release before it keeps working while it runs. Applied migrations are
// checksummed: never edit this body, add a new migration instead.

async function columnExists(executor, tableName, columnName) {
  const [rows] = await executor.execute('SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [tableName, columnName]);
  return Number(rows[0]?.n ?? 0) > 0;
}

async function indexExists(executor, tableName, indexName) {
  const [rows] = await executor.execute('SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?', [tableName, indexName]);
  return Number(rows[0]?.n ?? 0) > 0;
}

export async function ensureMysqlLargeFilesSchema(executor) {
  await executor.execute('ALTER TABLE file_vault MODIFY COLUMN file_size BIGINT NULL');
  await executor.execute('ALTER TABLE file_versions MODIFY COLUMN file_size BIGINT NULL');

  for (const tableName of ['file_vault', 'file_versions']) {
    if (!await columnExists(executor, tableName, 'scan_status')) {
      // Existing rows were scanned before they were saved.
      await executor.execute(`ALTER TABLE ${tableName} ADD COLUMN scan_status VARCHAR(16) NOT NULL DEFAULT 'clean'`);
    }
    await executor.execute(`ALTER TABLE ${tableName} ALTER COLUMN scan_status SET DEFAULT 'pending'`);
    for (const [columnName, definition] of [
      ['sha256', 'CHAR(64) NULL'],
      ['scanned_at', 'DATETIME(3) NULL'],
      ['preview_storage_key', 'VARCHAR(64) NULL'],
    ]) {
      if (!await columnExists(executor, tableName, columnName)) {
        await executor.execute(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
      }
    }
  }
  for (const [columnName, definition] of [
    ['deleted_at', 'DATETIME(3) NULL'],
    ['deleted_by', 'VARCHAR(128) NULL'],
  ]) {
    if (!await columnExists(executor, 'file_versions', columnName)) {
      await executor.execute(`ALTER TABLE file_versions ADD COLUMN ${columnName} ${definition}`);
    }
  }
  for (const [columnName, definition] of [
    ['folder_id', 'VARCHAR(36) NULL'],
    ['editing_by', 'VARCHAR(36) NULL'],
    ['editing_since', 'DATETIME(3) NULL'],
  ]) {
    if (!await columnExists(executor, 'file_vault', columnName)) {
      await executor.execute(`ALTER TABLE file_vault ADD COLUMN ${columnName} ${definition}`);
    }
  }
  // The scan worker finds pending rows, and a storage key finds every row that holds it.
  for (const [tableName, indexName, columns] of [
    ['file_vault', 'idx_file_vault_scan_status', 'scan_status'],
    ['file_vault', 'idx_file_vault_storage_key', 'storage_key'],
    ['file_vault', 'idx_file_vault_folder', 'tenant_id, folder_id'],
    ['file_versions', 'idx_file_versions_scan_status', 'scan_status'],
    ['file_versions', 'idx_file_versions_storage_key', 'storage_key'],
  ]) {
    if (!await indexExists(executor, tableName, indexName)) {
      await executor.execute(`CREATE INDEX ${indexName} ON ${tableName} (${columns})`);
    }
  }

  // These tables join file_vault on ids, so they take its collation.
  const [collations] = await executor.execute("SELECT COLLATION_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'file_vault' AND COLUMN_NAME = 'id'");
  const collation = /^[a-z0-9_]+$/.test(String(collations[0]?.name ?? '')) ? collations[0].name : 'utf8mb4_0900_ai_ci';
  await executor.execute(`CREATE TABLE IF NOT EXISTS file_folders (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    project_id VARCHAR(128) NOT NULL,
    channel_id VARCHAR(36) NULL,
    parent_id VARCHAR(36) NULL,
    name VARCHAR(240) NOT NULL,
    created_by VARCHAR(128) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    KEY idx_file_folders_parent (tenant_id, project_id, channel_id, parent_id)
  ) DEFAULT CHARSET=utf8mb4 COLLATE=${collation}`);
  await executor.execute(`CREATE TABLE IF NOT EXISTS file_uploads (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    project_id VARCHAR(128) NOT NULL,
    target_type VARCHAR(30) NOT NULL,
    target_id VARCHAR(128) NOT NULL,
    folder_id VARCHAR(36) NULL,
    file_id VARCHAR(36) NULL,
    base_version INT NULL,
    name VARCHAR(1024) NOT NULL,
    size BIGINT NOT NULL,
    content_type VARCHAR(120) NOT NULL,
    storage_key VARCHAR(64) NOT NULL,
    s3_upload_id VARCHAR(1024) NOT NULL,
    part_size INT NOT NULL,
    status VARCHAR(16) NOT NULL,
    created_by VARCHAR(128) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    expires_at DATETIME(3) NOT NULL,
    KEY idx_file_uploads_project (tenant_id, project_id, status),
    KEY idx_file_uploads_expiry (status, expires_at)
  ) DEFAULT CHARSET=utf8mb4 COLLATE=${collation}`);
}
