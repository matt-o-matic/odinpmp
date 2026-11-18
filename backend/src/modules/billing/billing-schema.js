// 0099_billing: the invoice-gen link on a project, the invoice summaries invoice-gen sends, the
// claims that lock time entries to an invoice, and the SOW milestone each story bills to.
// Additive only, so the release before it keeps working while it runs. Applied migrations are
// checksummed: never edit this body, add a new migration.

async function columnExists(executor, tableName, columnName) {
  const [rows] = await executor.execute('SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [tableName, columnName]);
  return Number(rows[0]?.n ?? 0) > 0;
}

async function indexExists(executor, tableName, indexName) {
  const [rows] = await executor.execute('SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?', [tableName, indexName]);
  return Number(rows[0]?.n ?? 0) > 0;
}

export async function ensureMysqlBillingSchema(executor) {
  // The new tables join project_time_entries on its ids, so they take its collation.
  const [collations] = await executor.execute("SELECT COLLATION_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_time_entries' AND COLUMN_NAME = 'tenant_id'");
  const collation = /^[a-z0-9_]+$/.test(String(collations[0]?.name ?? '')) ? collations[0].name : 'utf8mb4_0900_ai_ci';
  const table = `DEFAULT CHARSET=utf8mb4 COLLATE=${collation}`;

  // One link per project and provider. agreement_json is null for a link at client and
  // line-of-business level. received_at is the last send, kept even when an older one is ignored.
  await executor.execute(`CREATE TABLE IF NOT EXISTS project_billing_links (
    tenant_id VARCHAR(36) NOT NULL,
    project_id VARCHAR(128) NOT NULL,
    provider VARCHAR(32) NOT NULL,
    external_customer_id VARCHAR(64) NOT NULL,
    customer_name VARCHAR(255) NOT NULL DEFAULT '',
    external_line_of_business_id VARCHAR(64) NULL,
    line_of_business_name VARCHAR(255) NOT NULL DEFAULT '',
    external_agreement_id VARCHAR(64) NULL,
    agreement_json JSON NULL,
    source_updated_at DATETIME(3) NOT NULL,
    received_at DATETIME(3) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    PRIMARY KEY (tenant_id, project_id, provider)
  ) ${table}`);

  await executor.execute(`CREATE TABLE IF NOT EXISTS project_external_invoices (
    tenant_id VARCHAR(36) NOT NULL,
    project_id VARCHAR(128) NOT NULL,
    provider VARCHAR(32) NOT NULL,
    external_id VARCHAR(64) NOT NULL,
    number VARCHAR(120) NOT NULL DEFAULT '',
    status VARCHAR(16) NOT NULL,
    issue_date DATE NULL,
    submitted_date DATE NULL,
    due_date DATE NULL,
    paid_date DATE NULL,
    overdue TINYINT(1) NOT NULL DEFAULT 0,
    hours DECIMAL(10,2) NOT NULL DEFAULT 0,
    total_cents BIGINT NOT NULL DEFAULT 0,
    currency CHAR(3) NOT NULL DEFAULT 'USD',
    url VARCHAR(2000) NOT NULL DEFAULT '',
    source_updated_at DATETIME(3) NOT NULL,
    received_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    PRIMARY KEY (tenant_id, provider, external_id),
    KEY idx_external_invoices_project (tenant_id, project_id)
  ) ${table}`);

  // One active claim per invoice: active_marker is 1 while the claim holds entries and NULL once
  // released, so the unique key allows any number of released claims beside the active one.
  await executor.execute(`CREATE TABLE IF NOT EXISTS time_entry_invoice_claims (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    project_id VARCHAR(128) NOT NULL,
    provider VARCHAR(32) NOT NULL,
    external_invoice_id VARCHAR(64) NOT NULL,
    invoice_number VARCHAR(120) NULL,
    idempotency_key VARCHAR(200) NULL,
    claimed_by_app VARCHAR(36) NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    released_at DATETIME(3) NULL,
    active_marker TINYINT GENERATED ALWAYS AS (CASE WHEN released_at IS NULL THEN 1 ELSE NULL END) STORED,
    UNIQUE KEY uq_invoice_claims_active (tenant_id, provider, external_invoice_id, active_marker),
    KEY idx_invoice_claims_project (tenant_id, project_id)
  ) ${table}`);

  await executor.execute(`CREATE TABLE IF NOT EXISTS story_billing_milestones (
    tenant_id VARCHAR(36) NOT NULL,
    project_id VARCHAR(128) NOT NULL,
    story_id VARCHAR(128) NOT NULL,
    external_milestone_id BIGINT NOT NULL,
    updated_by VARCHAR(128) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    PRIMARY KEY (story_id),
    KEY idx_story_milestones_project (tenant_id, project_id)
  ) ${table}`);

  for (const [columnName, definition] of [
    ['invoice_claim_id', 'VARCHAR(36) NULL'],
    ['invoice_claimed_at', 'DATETIME(3) NULL'],
  ]) {
    if (!await columnExists(executor, 'project_time_entries', columnName)) {
      await executor.execute(`ALTER TABLE project_time_entries ADD COLUMN ${columnName} ${definition}`);
    }
  }
  if (!await indexExists(executor, 'project_time_entries', 'idx_time_project_claim')) {
    await executor.execute('ALTER TABLE project_time_entries ADD INDEX idx_time_project_claim (tenant_id, project_id, invoice_claim_id)');
  }
}
