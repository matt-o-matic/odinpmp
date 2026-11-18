// 0093_file_versions_and_links: a file's earlier contents, and the work items that reference it.
//
// file_vault stays one row per file, holding the current version. Each new version is written to
// its own storage object (storage_key; null means the object named by the file's id, as for every
// file saved before this), and the row it replaces moves to file_versions, so saving never touches
// bytes already stored. file_links lets a file sit on work items other than the one it was
// uploaded to: file_vault.target_* stays its home.

async function columnExists(executor, tableName, columnName) {
  const [rows] = await executor.execute('SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [tableName, columnName]);
  return Number(rows[0]?.n ?? 0) > 0;
}

export async function ensureMysqlFileVersionsAndLinksSchema(executor) {
  for (const [columnName, definition] of [
    ['current_version', 'INT NOT NULL DEFAULT 1'],
    ['storage_key', 'VARCHAR(64) NULL'],
    ['version_note', 'VARCHAR(1000) NULL'],
  ]) {
    if (!await columnExists(executor, 'file_vault', columnName)) {
      await executor.execute(`ALTER TABLE file_vault ADD COLUMN ${columnName} ${definition}`);
    }
  }
  // file_links joins tasks and file_vault on ids, so these tables take file_vault's collation.
  const [collations] = await executor.execute("SELECT COLLATION_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'file_vault' AND COLUMN_NAME = 'id'");
  const collation = /^[a-z0-9_]+$/.test(String(collations[0]?.name ?? '')) ? collations[0].name : 'utf8mb4_0900_ai_ci';
  await executor.execute(`CREATE TABLE IF NOT EXISTS file_versions (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    file_id VARCHAR(36) NOT NULL,
    version_number INT NOT NULL,
    storage_key VARCHAR(64) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    file_name VARCHAR(1024) NULL,
    file_type VARCHAR(120) NULL,
    file_size INT NULL,
    signature CHAR(32) NULL,
    version_note VARCHAR(1000) NULL,
    uploaded_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_file_versions_number (file_id, version_number),
    KEY idx_file_versions_tenant_file (tenant_id, file_id)
  ) DEFAULT CHARSET=utf8mb4 COLLATE=${collation}`);
  await executor.execute(`CREATE TABLE IF NOT EXISTS file_links (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    project_id VARCHAR(36) NOT NULL,
    file_id VARCHAR(36) NOT NULL,
    target_type VARCHAR(30) NOT NULL,
    target_id VARCHAR(36) NOT NULL,
    created_by VARCHAR(36) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_file_links_target (file_id, target_id, target_type),
    KEY idx_file_links_target (tenant_id, target_id, target_type),
    KEY idx_file_links_project (tenant_id, project_id)
  ) DEFAULT CHARSET=utf8mb4 COLLATE=${collation}`);
}
