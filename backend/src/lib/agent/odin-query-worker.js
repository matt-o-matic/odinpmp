// Runs one odin_query in a worker thread: builds an in-memory SQLite database (sql.js, WebAssembly,
// with no file or network access) from the rows it is given, runs the query, and posts back the
// columns and rows. The parent ends the worker if it takes too long.
import { parentPort, workerData } from 'node:worker_threads';
import initSqlJs from 'sql.js';

const { maxCellChars, maxRows, maxScanRows, sql, tables } = workerData;
const toValue = (value) => (value === undefined ? null : typeof value === 'boolean' ? Number(value) : value);
const clip = (value) => (typeof value === 'string' && value.length > maxCellChars ? `${value.slice(0, maxCellChars - 1)}…` : value);

try {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  for (const [name, table] of Object.entries(tables)) {
    db.run(`CREATE TABLE ${name} (${table.columns.map(([column, type]) => `${column} ${type}`).join(', ')})`);
    const insert = db.prepare(`INSERT INTO ${name} VALUES (${table.columns.map(() => '?').join(', ')})`);
    db.run('BEGIN');
    for (const row of table.rows) insert.run(row.map(toValue));
    db.run('COMMIT');
    insert.free();
  }
  const statement = db.prepare(sql);
  const columns = statement.getColumnNames();
  const rows = [];
  let rowCount = 0;
  while (rowCount < maxScanRows && statement.step()) {
    rowCount += 1;
    if (rows.length < maxRows) rows.push(statement.get().map(clip));
  }
  const more = rowCount >= maxScanRows && statement.step();
  statement.free();
  db.close();
  parentPort.postMessage({ columns, more, ok: true, rowCount, rows });
} catch (error) {
  parentPort.postMessage({ error: String(error?.message ?? error), ok: false });
}
