// 0095_engagements (docs/engagements/plan.md, "Data"): the kind of each project, the fields an
// engagement carries before it becomes a delivery project, and which optional modules each
// workspace has switched on. Additive only, so the release before it keeps working while it runs.
// Applied migrations are checksummed: never edit this body, add a new migration instead.

async function columnExists(executor, tableName, columnName) {
  const [rows] = await executor.execute('SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [tableName, columnName]);
  return Number(rows[0]?.n ?? 0) > 0;
}

async function indexExists(executor, tableName, indexName) {
  const [rows] = await executor.execute('SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?', [tableName, indexName]);
  return Number(rows[0]?.n ?? 0) > 0;
}

export async function ensureMysqlEngagementsSchema(executor) {
  for (const [columnName, definition] of [
    // Every existing project is a delivery project.
    ['kind', "VARCHAR(16) NOT NULL DEFAULT 'delivery'"],
    ['engagement_status', 'VARCHAR(16) NULL'],
    ['engagement_customer', 'VARCHAR(255) NULL'],
    ['engagement_owner_id', 'VARCHAR(36) NULL'],
    ['converted_at', 'DATETIME(3) NULL'],
    ['converted_by', 'VARCHAR(36) NULL'],
    ['closed_at', 'DATETIME(3) NULL'],
  ]) {
    if (!await columnExists(executor, 'projects', columnName)) {
      await executor.execute(`ALTER TABLE projects ADD COLUMN ${columnName} ${definition}`);
    }
  }
  if (!await indexExists(executor, 'projects', 'idx_projects_tenant_kind')) {
    await executor.execute('ALTER TABLE projects ADD INDEX idx_projects_tenant_kind (tenant_id, kind)');
  }
  // tenant_id joins projects and tenants, so the table takes projects' collation.
  const [collations] = await executor.execute("SELECT COLLATION_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'projects' AND COLUMN_NAME = 'tenant_id'");
  const collation = /^[a-z0-9_]+$/.test(String(collations[0]?.name ?? '')) ? collations[0].name : 'utf8mb4_0900_ai_ci';
  await executor.execute(`CREATE TABLE IF NOT EXISTS tenant_modules (
    tenant_id VARCHAR(36) NOT NULL,
    module_key VARCHAR(64) NOT NULL,
    enabled TINYINT(1) NOT NULL DEFAULT 0,
    updated_by VARCHAR(36) NULL,
    updated_at DATETIME(3) NOT NULL,
    version INT NOT NULL DEFAULT 1,
    PRIMARY KEY (tenant_id, module_key)
  ) DEFAULT CHARSET=utf8mb4 COLLATE=${collation}`);
}
