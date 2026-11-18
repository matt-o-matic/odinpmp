// The tables of the retired project summary pipeline. Nothing reads or writes them any more;
// the schema stays because migration 0007_summaries (bootstrap-schema.lib.js) is recorded by
// the checksum of ensureMysqlSummarySchema, so it must not change.

function tableRowCountResult(rows = []) {
  return Number(rows?.[0]?.count ?? 0) > 0;
}

async function tableExists(executor, tableName) {
  const [rows] = await executor.execute(
    `
      SELECT COUNT(*) AS count
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
      LIMIT 1
    `,
    [tableName],
  );

  return tableRowCountResult(rows);
}

export async function ensureMysqlSummarySchema(executor) {
  if (!await tableExists(executor, 'summary_documents')) {
    await executor.execute(
      `
        CREATE TABLE summary_documents (
          id VARCHAR(36) NOT NULL PRIMARY KEY,
          tenant_id VARCHAR(36) NOT NULL,
          source_kind VARCHAR(32) NOT NULL,
          source_id VARCHAR(120) NOT NULL,
          entity_type VARCHAR(32) NOT NULL,
          entity_id VARCHAR(120) NOT NULL,
          parent_entity_type VARCHAR(32) NULL,
          parent_entity_id VARCHAR(120) NULL,
          title VARCHAR(255) NOT NULL,
          core_summary MEDIUMTEXT NULL,
          metadata_summary MEDIUMTEXT NULL,
          comment_summary MEDIUMTEXT NULL,
          content_fingerprint VARCHAR(128) NOT NULL,
          metadata_fingerprint VARCHAR(128) NULL,
          core_model VARCHAR(160) NULL,
          metadata_model VARCHAR(160) NULL,
          core_generated_at DATETIME NULL,
          metadata_generated_at DATETIME NULL,
          stale_core TINYINT(1) NOT NULL DEFAULT 1,
          stale_metadata TINYINT(1) NOT NULL DEFAULT 1,
          last_error TEXT NULL,
          last_error_at DATETIME NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uq_summary_documents_scope (tenant_id, source_kind, source_id, entity_type, entity_id),
          KEY idx_summary_documents_parent (tenant_id, source_kind, source_id, parent_entity_type, parent_entity_id),
          KEY idx_summary_documents_stale (tenant_id, source_kind, source_id, stale_core, stale_metadata)
        )
      `,
    );
  }

  if (!await tableExists(executor, 'summary_refresh_queue')) {
    await executor.execute(
      `
        CREATE TABLE summary_refresh_queue (
          id VARCHAR(36) NOT NULL PRIMARY KEY,
          tenant_id VARCHAR(36) NOT NULL,
          source_kind VARCHAR(32) NOT NULL,
          source_id VARCHAR(120) NOT NULL,
          entity_type VARCHAR(32) NOT NULL,
          entity_id VARCHAR(120) NOT NULL,
          refresh_kind VARCHAR(24) NOT NULL,
          priority INT NOT NULL DEFAULT 0,
          reason VARCHAR(120) NOT NULL,
          status VARCHAR(24) NOT NULL DEFAULT 'pending',
          attempt_count INT NOT NULL DEFAULT 0,
          available_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          locked_at DATETIME NULL,
          worker_id VARCHAR(120) NULL,
          last_error TEXT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uq_summary_refresh_queue_scope (tenant_id, source_kind, source_id, entity_type, entity_id, refresh_kind),
          KEY idx_summary_refresh_queue_pending (status, available_at, refresh_kind, priority),
          KEY idx_summary_refresh_queue_source (tenant_id, source_kind, source_id)
        )
      `,
    );
  }
}
