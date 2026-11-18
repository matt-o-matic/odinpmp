// 0102_notifications (docs/odin-chat/plan.md, Data): who hears what, and how.
//
// - channel_notification_levels: a person's stored level for one channel (all, mentions or
//   off). Without a row the level is the default (notification-levels.js).
// - notifications: one row per person per event, for the bell, push and the email digest.
//   Posts in one watched channel collapse into one row while it is unread: open_collapse_key is
//   the collapse key until the row is read and NULL after, so the unique key allows one unread
//   row per person and key and any number of read ones. digest_state says where the row is in
//   the rolled-up email: pending, read (read in Odin first), sent, released (never to be sent,
//   with digest_error saying why) or failed. A row joins its person's digest at digest_after.
// - chat_digest_deliveries: at most one digest delivery per workspace and person, claimed with
//   a token and a lease, as requirements_mention_digests are.
// - push_subscriptions: one row per browser or phone that turned on push, keyed by a hash of
//   its endpoint. expired_at is set when the push service says the subscription is gone.
// - notification_focus: which tabs have Odin focused now, so push is skipped for them.
//
// The tables join project_channels on channel ids, so they take its collation. Additive only.
// Applied migrations are checksummed: never edit this body, add a new migration instead.

export async function ensureMysqlNotificationsSchema(executor) {
  const [collations] = await executor.execute("SELECT COLLATION_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_channels' AND COLUMN_NAME = 'id'");
  const collation = /^[a-z0-9_]+$/.test(String(collations[0]?.name ?? '')) ? collations[0].name : 'utf8mb4_0900_ai_ci';
  await executor.execute(`CREATE TABLE IF NOT EXISTS channel_notification_levels (
    channel_id VARCHAR(36) NOT NULL,
    principal_type VARCHAR(16) NOT NULL,
    principal_id VARCHAR(64) NOT NULL,
    tenant_id VARCHAR(36) NOT NULL,
    level VARCHAR(16) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    PRIMARY KEY (channel_id, principal_type, principal_id),
    KEY idx_channel_notification_levels_principal (tenant_id, principal_type, principal_id)
  ) DEFAULT CHARSET=utf8mb4 COLLATE=${collation}`);
  await executor.execute(`CREATE TABLE IF NOT EXISTS notifications (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    principal_type VARCHAR(16) NOT NULL,
    principal_id VARCHAR(64) NOT NULL,
    kind VARCHAR(24) NOT NULL,
    project_id VARCHAR(128) NULL,
    channel_id VARCHAR(36) NULL,
    conversation_id VARCHAR(36) NULL,
    post_id VARCHAR(36) NULL,
    thread_id VARCHAR(36) NULL,
    file_id VARCHAR(36) NULL,
    item_id VARCHAR(64) NULL,
    actor_type VARCHAR(16) NOT NULL,
    actor_id VARCHAR(64) NOT NULL,
    summary_json TEXT NOT NULL,
    collapse_key VARCHAR(120) NULL,
    collapse_count INT NOT NULL DEFAULT 1,
    read_at DATETIME(3) NULL,
    open_collapse_key VARCHAR(120) GENERATED ALWAYS AS (IF(read_at IS NULL, collapse_key, NULL)) STORED,
    digest_state VARCHAR(16) NOT NULL DEFAULT 'pending',
    digest_after DATETIME(3) NULL,
    digest_delivery_id VARCHAR(36) NULL,
    digest_sent_at DATETIME(3) NULL,
    digest_error TEXT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_notifications_open_collapse (tenant_id, principal_type, principal_id, open_collapse_key),
    KEY idx_notifications_principal (tenant_id, principal_type, principal_id, updated_at),
    KEY idx_notifications_unread (tenant_id, principal_type, principal_id, read_at),
    KEY idx_notifications_digest (digest_state, digest_after),
    KEY idx_notifications_channel (channel_id, principal_type, principal_id),
    KEY idx_notifications_updated (updated_at)
  ) DEFAULT CHARSET=utf8mb4 COLLATE=${collation}`);
  await executor.execute(`CREATE TABLE IF NOT EXISTS chat_digest_deliveries (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    principal_type VARCHAR(16) NOT NULL,
    principal_id VARCHAR(64) NOT NULL,
    claim_token VARCHAR(36) NULL,
    claimed_until DATETIME(3) NULL,
    send_started_at DATETIME(3) NULL,
    attempts INT NOT NULL DEFAULT 0,
    next_attempt_at DATETIME(3) NULL,
    last_error TEXT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_chat_digest_deliveries_principal (tenant_id, principal_type, principal_id)
  ) DEFAULT CHARSET=utf8mb4 COLLATE=${collation}`);
  await executor.execute(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    principal_type VARCHAR(16) NOT NULL,
    principal_id VARCHAR(64) NOT NULL,
    endpoint_hash CHAR(64) NOT NULL,
    endpoint TEXT NOT NULL,
    keys_json TEXT NOT NULL,
    user_agent VARCHAR(255) NOT NULL DEFAULT '',
    created_at DATETIME(3) NOT NULL,
    last_used_at DATETIME(3) NULL,
    expired_at DATETIME(3) NULL,
    UNIQUE KEY uq_push_subscriptions_endpoint (endpoint_hash),
    KEY idx_push_subscriptions_principal (principal_type, principal_id, expired_at)
  ) DEFAULT CHARSET=utf8mb4 COLLATE=${collation}`);
  await executor.execute(`CREATE TABLE IF NOT EXISTS notification_focus (
    principal_type VARCHAR(16) NOT NULL,
    principal_id VARCHAR(64) NOT NULL,
    client_id VARCHAR(120) NOT NULL,
    focused_until DATETIME(3) NOT NULL,
    PRIMARY KEY (principal_type, principal_id, client_id),
    KEY idx_notification_focus_until (focused_until)
  ) DEFAULT CHARSET=utf8mb4 COLLATE=${collation}`);
}
