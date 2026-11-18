// 0098_guest_sessions: how channel guests sign in.
//
// - access_sign_in_codes: the one code a guest's access link (access_links, one per workspace
//   and email) has outstanding. A new code replaces the old one. The code is stored only as a
//   SHA-256 hash, with when it was sent, how many wrong tries it has had, and when it was used.
// - access_sessions: a guest's sessions. The token is stored only as a SHA-256 hash. Each request
//   sets expires_at to 30 days after last_seen_at; revoked_at ends a session at once.
//
// The tables join nothing in SQL, so they take the database's default collation, as
// access_links does. Additive only. Applied migrations are checksummed: never edit this body,
// add a new migration instead.

export async function ensureMysqlGuestSessionsSchema(executor) {
  await executor.execute(`CREATE TABLE IF NOT EXISTS access_sign_in_codes (
    access_link_id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    code_hash CHAR(64) NOT NULL,
    sent_at DATETIME(3) NOT NULL,
    attempts INT NOT NULL DEFAULT 0,
    used_at DATETIME(3) NULL
  ) DEFAULT CHARSET=utf8mb4`);
  await executor.execute(`CREATE TABLE IF NOT EXISTS access_sessions (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    access_link_id VARCHAR(36) NOT NULL,
    token_hash CHAR(64) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    last_seen_at DATETIME(3) NOT NULL,
    expires_at DATETIME(3) NOT NULL,
    revoked_at DATETIME(3) NULL,
    ip VARCHAR(100) NOT NULL DEFAULT '',
    user_agent VARCHAR(512) NOT NULL DEFAULT '',
    UNIQUE KEY uq_access_sessions_token (token_hash),
    KEY idx_access_sessions_link (access_link_id, revoked_at)
  ) DEFAULT CHARSET=utf8mb4`);
}
