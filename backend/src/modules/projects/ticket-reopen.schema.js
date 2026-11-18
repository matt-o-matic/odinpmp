// How many times a ticket's reporter has reopened it, and when they last did.
// Odin has no Reopened state: a reopened ticket returns to New, and the count shows it came back.

async function columnExists(executor, tableName, columnName) {
  const [rows] = await executor.execute(
    `
      SELECT COUNT(*) AS count
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
      LIMIT 1
    `,
    [tableName, columnName],
  );

  return Number(rows[0]?.count ?? 0) > 0;
}

export async function ensureMysqlTicketReopenSchema(executor) {
  if (!await columnExists(executor, 'tasks', 'reopen_count')) {
    await executor.execute('ALTER TABLE tasks ADD COLUMN reopen_count INT NOT NULL DEFAULT 0');
  }

  if (!await columnExists(executor, 'tasks', 'last_reopened_at')) {
    await executor.execute('ALTER TABLE tasks ADD COLUMN last_reopened_at DATETIME(3) NULL');
  }
}
