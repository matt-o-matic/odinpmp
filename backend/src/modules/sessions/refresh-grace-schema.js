// 0104_refresh_grace: each session remembers the refresh token it replaced and when, so a refresh
// that raced another one, or whose answer never reached the browser, still gets the current
// session for a short time instead of signing the person out (sessions.repository.js,
// REFRESH_GRACE_SECONDS). Additive only, so the release before it keeps working while it runs.
// Applied migrations are checksummed: never edit this body, add a new migration.

async function columnExists(executor, tableName, columnName) {
  const [rows] = await executor.execute('SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [tableName, columnName]);
  return Number(rows[0]?.n ?? 0) > 0;
}

export async function ensureMysqlRefreshGraceSchema(executor) {
  for (const [columnName, definition] of [
    ['previous_token', 'TEXT NULL'],
    ['rotated_at', 'DATETIME(3) NULL'],
  ]) {
    if (!await columnExists(executor, 'tokens', columnName)) {
      await executor.execute(`ALTER TABLE tokens ADD COLUMN ${columnName} ${definition}`);
    }
  }
}
