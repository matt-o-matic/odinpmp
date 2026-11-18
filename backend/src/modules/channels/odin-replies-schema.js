// 0101_odin_replies: one record per post that tags @odin, so each tag is answered once
// and its thread can show "Odin is replying".
//
// - odin_replies: the post that tagged Odin (unique: one reply each), who asked (a member's user
//   id or a guest's stakeholder id), the assistant chat that ran the turn (members only), the
//   latest post Odin wrote in the thread, the status, and a short error for a failed turn.
//
// Odin's own posts are discussion_posts rows with author_type 'odin' and author_id the record's
// id. author_type is VARCHAR(16), so 'odin' needs no column change.
//
// This is the one definition of odin_replies. The "Let Odin answer when tagged" setting is
// project_settings.odin_replies_enabled, from 0100_pursuit.
//
// The table joins discussion_posts on ids, so it takes that table's collation. Additive only.
// Applied migrations are checksummed: never edit this body, add a new migration instead.

export async function ensureMysqlOdinRepliesSchema(executor) {
  const [collations] = await executor.execute("SELECT COLLATION_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'discussion_posts' AND COLUMN_NAME = 'id'");
  const collation = /^[a-z0-9_]+$/.test(String(collations[0]?.name ?? '')) ? collations[0].name : 'utf8mb4_0900_ai_ci';
  await executor.execute(`CREATE TABLE IF NOT EXISTS odin_replies (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    project_id VARCHAR(128) NOT NULL,
    channel_id VARCHAR(36) NOT NULL,
    post_id VARCHAR(36) NOT NULL,
    thread_id VARCHAR(36) NOT NULL,
    requester_type VARCHAR(16) NOT NULL,
    requester_id VARCHAR(64) NOT NULL,
    chat_id VARCHAR(64) NULL,
    reply_post_id VARCHAR(36) NULL,
    status VARCHAR(32) NOT NULL,
    error VARCHAR(500) NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_odin_replies_post (post_id),
    KEY idx_odin_replies_thread (tenant_id, thread_id),
    KEY idx_odin_replies_status (status, updated_at)
  ) DEFAULT CHARSET=utf8mb4 COLLATE=${collation}`);
}
