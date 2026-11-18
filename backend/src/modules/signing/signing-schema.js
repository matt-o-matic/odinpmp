// 0094_document_signing (docs/document-signing/plan.md): whether each file is internal or shared
// with stakeholders, and signature requests with their frozen documents, signers, sealed
// signatures and audit trail. Additive only, so the release before it keeps working while it runs.
// Applied migrations are checksummed: never edit this body, add a new migration instead.

async function columnExists(executor, tableName, columnName) {
  const [rows] = await executor.execute('SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [tableName, columnName]);
  return Number(rows[0]?.n ?? 0) > 0;
}

export async function ensureMysqlDocumentSigningSchema(executor) {
  if (!await columnExists(executor, 'file_vault', 'audience')) {
    await executor.execute("ALTER TABLE file_vault ADD COLUMN audience VARCHAR(16) NOT NULL DEFAULT 'internal'");
  }
  // file_id joins file_vault, so these tables take its collation.
  const [collations] = await executor.execute("SELECT COLLATION_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'file_vault' AND COLUMN_NAME = 'id'");
  const collation = /^[a-z0-9_]+$/.test(String(collations[0]?.name ?? '')) ? collations[0].name : 'utf8mb4_0900_ai_ci';
  await executor.execute(`CREATE TABLE IF NOT EXISTS signing_requests (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    project_id VARCHAR(128) NOT NULL,
    kind VARCHAR(20) NOT NULL,
    subject_type VARCHAR(20) NOT NULL,
    subject_id VARCHAR(128) NOT NULL,
    title VARCHAR(240) NOT NULL,
    statement TEXT NOT NULL,
    message TEXT NOT NULL,
    status VARCHAR(16) NOT NULL,
    package_json MEDIUMTEXT NOT NULL,
    package_hash CHAR(64) NOT NULL,
    manifest_json MEDIUMTEXT NULL,
    manifest_hash CHAR(64) NULL,
    seal VARCHAR(128) NULL,
    seal_key_id VARCHAR(64) NULL,
    created_by VARCHAR(128) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    ended_at DATETIME(3) NULL,
    ended_by VARCHAR(128) NULL,
    end_reason VARCHAR(1000) NULL,
    updated_at DATETIME(3) NOT NULL,
    KEY idx_signing_requests_project (tenant_id, project_id, created_at)
  ) DEFAULT CHARSET=utf8mb4 COLLATE=${collation}`);
  await executor.execute(`CREATE TABLE IF NOT EXISTS signing_request_documents (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    project_id VARCHAR(128) NOT NULL,
    request_id VARCHAR(36) NOT NULL,
    position INT NOT NULL,
    file_id VARCHAR(36) NOT NULL,
    version_number INT NOT NULL,
    storage_key VARCHAR(64) NOT NULL,
    file_name VARCHAR(1024) NOT NULL,
    content_type VARCHAR(120) NOT NULL,
    file_size INT NOT NULL,
    sha256 CHAR(64) NOT NULL,
    UNIQUE KEY uq_signing_request_documents_position (request_id, position),
    KEY idx_signing_request_documents_file (tenant_id, file_id)
  ) DEFAULT CHARSET=utf8mb4 COLLATE=${collation}`);
  await executor.execute(`CREATE TABLE IF NOT EXISTS signing_signers (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    project_id VARCHAR(128) NOT NULL,
    request_id VARCHAR(36) NOT NULL,
    position INT NOT NULL,
    stakeholder_id VARCHAR(36) NOT NULL,
    assigned_name VARCHAR(255) NOT NULL,
    assigned_email VARCHAR(255) NOT NULL,
    status VARCHAR(16) NOT NULL,
    code_hash CHAR(64) NULL,
    code_sent_at DATETIME(3) NULL,
    code_attempts INT NOT NULL DEFAULT 0,
    signed_at DATETIME(3) NULL,
    signed_name VARCHAR(255) NULL,
    signed_title VARCHAR(255) NULL,
    signed_organization VARCHAR(255) NULL,
    declined_at DATETIME(3) NULL,
    decline_reason VARCHAR(1000) NULL,
    removed_at DATETIME(3) NULL,
    removed_by VARCHAR(128) NULL,
    removal_reason VARCHAR(1000) NULL,
    reminded_at DATETIME(3) NULL,
    mail_status VARCHAR(16) NULL,
    mail_reason VARCHAR(64) NULL,
    UNIQUE KEY uq_signing_signers_stakeholder (request_id, stakeholder_id),
    KEY idx_signing_signers_stakeholder (tenant_id, project_id, stakeholder_id)
  ) DEFAULT CHARSET=utf8mb4 COLLATE=${collation}`);
  await executor.execute(`CREATE TABLE IF NOT EXISTS signing_signatures (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    project_id VARCHAR(128) NOT NULL,
    request_id VARCHAR(36) NOT NULL,
    signer_id VARCHAR(36) NOT NULL,
    evidence_json MEDIUMTEXT NOT NULL,
    evidence_hash CHAR(64) NOT NULL,
    seal VARCHAR(128) NOT NULL,
    seal_key_id VARCHAR(64) NOT NULL,
    signed_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_signing_signatures_signer (signer_id),
    KEY idx_signing_signatures_request (request_id)
  ) DEFAULT CHARSET=utf8mb4 COLLATE=${collation}`);
  await executor.execute(`CREATE TABLE IF NOT EXISTS signing_events (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    project_id VARCHAR(128) NOT NULL,
    request_id VARCHAR(36) NOT NULL,
    signer_id VARCHAR(36) NULL,
    actor VARCHAR(128) NOT NULL,
    action VARCHAR(40) NOT NULL,
    detail_json TEXT NULL,
    created_at DATETIME(3) NOT NULL,
    KEY idx_signing_events_request (request_id, created_at)
  ) DEFAULT CHARSET=utf8mb4 COLLATE=${collation}`);
}
