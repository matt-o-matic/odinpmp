// 0108_polls: a poll attached to a post, in a channel or a direct message, and one vote
// per person.
//
// - post_polls: one row per post that is a poll. kind, the question, the options as JSON
//   ([{ id, label }]), the settings as JSON ({ anonymous, showResults, maxChoices, scaleMax }), an
//   optional closing time, and who closed it early and when.
// - post_poll_votes: one row per voter and poll. The voter's type and id keep it to one vote each;
//   their name is kept for named polls. An anonymous poll never shows either.
//
// Both join discussion_posts on post_id, so they take that table's collation. Additive only.
// Applied migrations are checksummed: never edit this body, add a new migration instead.

export async function ensureMysqlPollsSchema(executor) {
  const [collations] = await executor.execute("SELECT COLLATION_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'discussion_posts' AND COLUMN_NAME = 'id'");
  const collation = /^[a-z0-9_]+$/.test(String(collations[0]?.name ?? '')) ? collations[0].name : 'utf8mb4_0900_ai_ci';
  await executor.execute(`CREATE TABLE IF NOT EXISTS post_polls (
    post_id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    kind VARCHAR(16) NOT NULL,
    question VARCHAR(300) NOT NULL,
    options_json JSON NOT NULL,
    settings_json JSON NOT NULL,
    closes_at DATETIME(3) NULL,
    closed_at DATETIME(3) NULL,
    closed_by VARCHAR(64) NULL,
    created_at DATETIME(3) NOT NULL,
    KEY idx_post_polls_tenant (tenant_id)
  ) DEFAULT CHARSET=utf8mb4 COLLATE=${collation}`);
  await executor.execute(`CREATE TABLE IF NOT EXISTS post_poll_votes (
    post_id VARCHAR(36) NOT NULL,
    tenant_id VARCHAR(36) NOT NULL,
    voter_type VARCHAR(16) NOT NULL,
    voter_id VARCHAR(64) NOT NULL,
    voter_name VARCHAR(255) NULL,
    answer_json JSON NOT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    PRIMARY KEY (post_id, voter_type, voter_id),
    KEY idx_post_poll_votes_tenant (tenant_id, post_id)
  ) DEFAULT CHARSET=utf8mb4 COLLATE=${collation}`);
}
