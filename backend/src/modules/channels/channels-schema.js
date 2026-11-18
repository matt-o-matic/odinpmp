// 0096_channels (docs/engagements/plan.md, Data): channels on every project, the guests invited
// to each, the posts in them and the comments on files, the files a post carries, and when each
// person last read each channel.
//
// - project_channels: one General channel per project at most, held by a unique key on a
//   generated column that is the project id for General and NULL for every other channel.
//   Channel names are unique within their project.
// - project_channel_guests: stakeholders invited to a channel (workstream 6 fills it).
// - discussion_posts: channel posts (target_type 'channel') and file comments (target_type
//   'file', with the version the comment was made on), one level of replies by parent_id.
// - discussion_post_files: the library files a post carries.
// - channel_reads: the last time each person read each channel, for unread counts.
//
// The tables join file_vault on ids (a channel is a file target, a post carries files), so they
// take its collation. Additive only. Applied migrations are checksummed: never edit this body,
// add a new migration instead.

export async function ensureMysqlChannelsSchema(executor) {
  const [collations] = await executor.execute("SELECT COLLATION_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'file_vault' AND COLUMN_NAME = 'id'");
  const collation = /^[a-z0-9_]+$/.test(String(collations[0]?.name ?? '')) ? collations[0].name : 'utf8mb4_0900_ai_ci';
  await executor.execute(`CREATE TABLE IF NOT EXISTS project_channels (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    project_id VARCHAR(128) NOT NULL,
    name VARCHAR(80) NOT NULL,
    description VARCHAR(1000) NOT NULL DEFAULT '',
    is_general TINYINT(1) NOT NULL DEFAULT 0,
    general_project_id VARCHAR(128) GENERATED ALWAYS AS (IF(is_general = 1, project_id, NULL)) STORED,
    archived_at DATETIME(3) NULL,
    archived_by VARCHAR(36) NULL,
    created_by VARCHAR(36) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_project_channels_general (general_project_id),
    UNIQUE KEY uq_project_channels_name (tenant_id, project_id, name),
    KEY idx_project_channels_project (tenant_id, project_id, archived_at)
  ) DEFAULT CHARSET=utf8mb4 COLLATE=${collation}`);
  await executor.execute(`CREATE TABLE IF NOT EXISTS project_channel_guests (
    channel_id VARCHAR(36) NOT NULL,
    stakeholder_id VARCHAR(36) NOT NULL,
    tenant_id VARCHAR(36) NOT NULL,
    invited_by VARCHAR(36) NOT NULL,
    invited_at DATETIME(3) NOT NULL,
    removed_at DATETIME(3) NULL,
    removed_by VARCHAR(36) NULL,
    PRIMARY KEY (channel_id, stakeholder_id),
    KEY idx_project_channel_guests_stakeholder (tenant_id, stakeholder_id, removed_at)
  ) DEFAULT CHARSET=utf8mb4 COLLATE=${collation}`);
  await executor.execute(`CREATE TABLE IF NOT EXISTS discussion_posts (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    project_id VARCHAR(128) NOT NULL,
    target_type VARCHAR(16) NOT NULL,
    target_id VARCHAR(36) NOT NULL,
    parent_id VARCHAR(36) NULL,
    file_version INT NULL,
    author_type VARCHAR(16) NOT NULL,
    author_id VARCHAR(64) NOT NULL,
    body_markdown MEDIUMTEXT NOT NULL,
    edited_at DATETIME(3) NULL,
    deleted_at DATETIME(3) NULL,
    deleted_by VARCHAR(64) NULL,
    created_at DATETIME(3) NOT NULL,
    KEY idx_discussion_posts_target (tenant_id, target_type, target_id, parent_id, created_at),
    KEY idx_discussion_posts_parent (parent_id),
    KEY idx_discussion_posts_project (tenant_id, project_id, created_at)
  ) DEFAULT CHARSET=utf8mb4 COLLATE=${collation}`);
  await executor.execute(`CREATE TABLE IF NOT EXISTS discussion_post_files (
    post_id VARCHAR(36) NOT NULL,
    file_id VARCHAR(36) NOT NULL,
    PRIMARY KEY (post_id, file_id),
    KEY idx_discussion_post_files_file (file_id)
  ) DEFAULT CHARSET=utf8mb4 COLLATE=${collation}`);
  await executor.execute(`CREATE TABLE IF NOT EXISTS channel_reads (
    channel_id VARCHAR(36) NOT NULL,
    principal_type VARCHAR(16) NOT NULL,
    principal_id VARCHAR(64) NOT NULL,
    last_read_at DATETIME(3) NOT NULL,
    PRIMARY KEY (channel_id, principal_type, principal_id)
  ) DEFAULT CHARSET=utf8mb4 COLLATE=${collation}`);
}
