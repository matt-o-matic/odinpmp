// 0103_direct_messages (docs/odin-chat/plan.md, Data): direct messages between workspace members,
// one to one or in groups of up to 8 people. Their posts are discussion_posts rows with
// target_type 'dm', and their files are file_vault rows with target_type 'dm'; both name the
// conversation as their target.
//
// - direct_conversations: one row per conversation. member_key is the SHA-256 of the sorted
//   member ids, unique per workspace, so the same people always open the same conversation and
//   two people starting it at once get one row. Members are fixed when it is made.
// - direct_conversation_members: who is in each conversation, and when each last read it, for
//   unread counts.
//
// The tables join discussion_posts on ids, so they take its collation. Additive only. Applied
// migrations are checksummed: never edit this body, add a new migration instead.

export async function ensureMysqlDirectMessagesSchema(executor) {
  const [collations] = await executor.execute("SELECT COLLATION_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'discussion_posts' AND COLUMN_NAME = 'id'");
  const collation = /^[a-z0-9_]+$/.test(String(collations[0]?.name ?? '')) ? collations[0].name : 'utf8mb4_0900_ai_ci';
  await executor.execute(`CREATE TABLE IF NOT EXISTS direct_conversations (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    member_key CHAR(64) NOT NULL,
    created_by VARCHAR(36) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_direct_conversations_members (tenant_id, member_key)
  ) DEFAULT CHARSET=utf8mb4 COLLATE=${collation}`);
  await executor.execute(`CREATE TABLE IF NOT EXISTS direct_conversation_members (
    conversation_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    tenant_id VARCHAR(36) NOT NULL,
    joined_at DATETIME(3) NOT NULL,
    last_read_at DATETIME(3) NULL,
    PRIMARY KEY (conversation_id, user_id),
    KEY idx_direct_conversation_members_user (tenant_id, user_id)
  ) DEFAULT CHARSET=utf8mb4 COLLATE=${collation}`);
}
