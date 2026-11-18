// 0106_post_reactions: emoji reactions on discussion posts (channel posts, replies, file comments
// and direct messages), Slack-style. One row per post, person and emoji. The emoji column is
// binary-collated: under a case- and accent-insensitive collation, different emoji can compare
// equal. The table takes discussion_posts' collation otherwise. Additive only. Applied migrations
// are checksummed: never edit this body, add a new migration.

export async function ensureMysqlPostReactionsSchema(executor) {
  const [collations] = await executor.execute("SELECT COLLATION_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'discussion_posts' AND COLUMN_NAME = 'id'");
  const collation = /^[a-z0-9_]+$/.test(String(collations[0]?.name ?? '')) ? collations[0].name : 'utf8mb4_0900_ai_ci';
  await executor.execute(`CREATE TABLE IF NOT EXISTS discussion_post_reactions (
    post_id VARCHAR(36) NOT NULL,
    tenant_id VARCHAR(36) NOT NULL,
    principal_type VARCHAR(16) NOT NULL,
    principal_id VARCHAR(64) NOT NULL,
    emoji VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    created_at DATETIME(3) NOT NULL,
    PRIMARY KEY (post_id, principal_type, principal_id, emoji),
    KEY idx_discussion_post_reactions_tenant_post (tenant_id, post_id)
  ) DEFAULT CHARSET=utf8mb4 COLLATE=${collation}`);
}
