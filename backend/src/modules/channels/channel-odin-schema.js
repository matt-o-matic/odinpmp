// 0105_channel_odin: "Let Odin answer when tagged" moves from the project to each channel.
// project_channels.odin_enabled is on by default. When the column is added, every channel of a
// project that had switched Odin off (project_settings.odin_replies_enabled = 0, from
// 0100_pursuit) starts off, so nothing that was off turns on. The project column stays and nothing
// reads it after this. Additive only, so the release before it keeps working while it runs.
// Applied migrations are checksummed: never edit this body, add a new migration.

async function columnExists(executor, tableName, columnName) {
  const [rows] = await executor.execute('SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [tableName, columnName]);
  return Number(rows[0]?.n ?? 0) > 0;
}

export async function ensureMysqlChannelOdinSchema(executor) {
  if (await columnExists(executor, 'project_channels', 'odin_enabled')) return;
  await executor.execute('ALTER TABLE project_channels ADD COLUMN odin_enabled TINYINT(1) NOT NULL DEFAULT 1');
  // The ids are read first and passed back, so the two tables never compare across collations.
  const [rows] = await executor.execute('SELECT project_id AS projectId FROM project_settings WHERE odin_replies_enabled = 0');
  const projectIds = rows.map((row) => String(row.projectId));
  for (let start = 0; start < projectIds.length; start += 500) {
    await executor.query('UPDATE project_channels SET odin_enabled = 0 WHERE project_id IN (?)', [projectIds.slice(start, start + 500)]);
  }
}
