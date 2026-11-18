// 0107_post_reply_to: a reply that answers another reply in the same thread remembers which one
// (discussion_posts.reply_to_id). Threads stay one level deep; the app shows a short quote of the
// answered reply above the new one. Additive only. Applied migrations are checksummed: never edit
// this body, add a new migration.

export async function ensureMysqlPostReplyToSchema(executor) {
  const [rows] = await executor.execute("SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'discussion_posts' AND COLUMN_NAME = 'reply_to_id'");
  if (Number(rows[0]?.n ?? 0) > 0) return;
  await executor.execute('ALTER TABLE discussion_posts ADD COLUMN reply_to_id VARCHAR(36) NULL');
}
