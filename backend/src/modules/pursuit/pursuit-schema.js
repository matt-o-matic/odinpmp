// 0100_pursuit (docs/engagements/plan.md, "Data"): the pursuit marker on work items, and the
// project settings for the pursuit board and Odin. Odin's reply records are 0101_odin_replies
// (channels/odin-replies-schema.js); 0096 made discussion_posts.author_type a VARCHAR, which takes
// 'odin' with no change.

async function columnExists(executor, tableName, columnName) {
  const [rows] = await executor.execute(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1',
    [tableName, columnName],
  );
  return rows.length > 0;
}

async function indexExists(executor, tableName, indexName) {
  const [rows] = await executor.execute(
    'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1',
    [tableName, indexName],
  );
  return rows.length > 0;
}

export async function ensureMysqlPursuitSchema(executor) {
  // Every existing item is delivery work.
  if (!await columnExists(executor, 'tasks', 'pursuit')) {
    await executor.execute('ALTER TABLE tasks ADD COLUMN pursuit TINYINT(1) NOT NULL DEFAULT 0');
  }
  if (!await indexExists(executor, 'tasks', 'idx_tasks_project_pursuit')) {
    await executor.execute('ALTER TABLE tasks ADD INDEX idx_tasks_project_pursuit (project_id, pursuit)');
  }

  // New tables join projects on project_id, so they take its collation.
  const [collations] = await executor.execute("SELECT COLLATION_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'projects' AND COLUMN_NAME = 'id'");
  const collation = /^[a-z0-9_]+$/.test(String(collations[0]?.name ?? '')) ? collations[0].name : 'utf8mb4_0900_ai_ci';
  // A project with no row has the defaults: guests see only their own tasks, and Odin answers
  // when tagged (E-16).
  await executor.execute(`CREATE TABLE IF NOT EXISTS project_settings (
    project_id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    guests_see_board TINYINT(1) NOT NULL DEFAULT 0,
    odin_replies_enabled TINYINT(1) NOT NULL DEFAULT 1,
    updated_by VARCHAR(36) NULL,
    updated_at DATETIME(3) NOT NULL,
    version INT NOT NULL DEFAULT 1,
    INDEX idx_project_settings_tenant (tenant_id)
  ) DEFAULT CHARSET=utf8mb4 COLLATE=${collation}`);
}
