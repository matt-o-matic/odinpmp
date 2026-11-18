import { randomUUID } from 'node:crypto';

// Run before rolling back to a release older than migration 0093. Those releases know nothing of
// storage_key: they read a file's bytes from the object named by its id, and write there too. So
// each file's current contents go under its id, and any earlier version kept there first moves to
// an object of its own, or the old release's next upload would write over it. Versions, links and
// history all stay. It is safe to run again and to roll forward from.
//
// Each step runs under the file's row lock, so an upload arriving meanwhile waits and is never
// lost. One landing after a file is done gives that file a storage key again, so stop the backend,
// run this until it reports nothing to move, and only then switch releases.
//
// Storage writes don't roll back, so the order matters. Earlier versions leave the id in a commit
// of their own, and only then is anything written there: at any failure, every row still names
// bytes that are what it says, and running the job again finishes the work.

async function filesToPrepare(pool) {
  const [rows] = await pool.execute(`
    SELECT fv.id
    FROM file_vault fv
    WHERE fv.storage_key IS NOT NULL
      OR EXISTS (SELECT 1 FROM file_versions v WHERE v.file_id = fv.id AND v.storage_key = fv.id)
  `);
  return rows.map((row) => row.id);
}

async function inFileLock(connection, fileId, work) {
  await connection.beginTransaction();
  try {
    const [rows] = await connection.execute('SELECT storage_key AS storageKey FROM file_vault WHERE id = ? FOR UPDATE', [fileId]);
    const [held] = rows[0] ? await connection.execute('SELECT id FROM file_versions WHERE file_id = ? AND storage_key = ?', [fileId, fileId]) : [[]];
    const result = rows[0] ? await work({ held, storageKey: rows[0].storageKey }) : null;
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

// Step one: earlier contents under the id get an object of their own. The rows sharing it share
// the copy, which exists before any row points at it, and the id's object is left as it was.
async function moveHistoryOffId(connection, fileId, { storage, summary }) {
  await inFileLock(connection, fileId, async ({ held }) => {
    if (!held.length) return;
    const key = randomUUID();
    const { bytes } = await storage.read(fileId);
    await storage.write(key, bytes);
    await connection.execute('UPDATE file_versions SET storage_key = ? WHERE file_id = ? AND storage_key = ?', [key, fileId, fileId]);
    summary.versionsMoved += held.length;
  });
}

// Step two, in its own commit: nothing names the id's object now, so it can be written. An upload
// that slipped between the steps may have put history back there, which sends this round again.
async function moveCurrentToId(connection, fileId, { storage, summary }) {
  return inFileLock(connection, fileId, async ({ held, storageKey }) => {
    if (held.length) return { again: true };
    if (!storageKey) return { again: false };
    const moved = storageKey !== fileId;
    if (moved) {
      const { bytes } = await storage.read(storageKey);
      await storage.write(fileId, bytes);
      summary.currentMoved += 1;
    }
    await connection.execute('UPDATE file_vault SET storage_key = NULL WHERE id = ?', [fileId]);
    if (!moved) return { again: false };
    const [used] = await connection.execute('SELECT id FROM file_versions WHERE file_id = ? AND storage_key = ? LIMIT 1', [fileId, storageKey]);
    return { again: false, obsolete: used[0] ? null : storageKey };
  });
}

async function countFile(connection, fileId, summary) {
  const counted = await inFileLock(connection, fileId, async ({ held, storageKey }) => {
    if (!held.length && !storageKey) return false;
    summary.versionsMoved += held.length;
    summary.currentMoved += storageKey && storageKey !== fileId ? 1 : 0;
    return true;
  });
  if (counted) summary.files += 1;
}

export async function prepareFilesForRollback({ dryRun = false, pool, storage }) {
  const summary = { currentMoved: 0, files: 0, versionsMoved: 0 };
  const connection = await pool.getConnection();
  try {
    for (const fileId of await filesToPrepare(pool)) {
      if (dryRun) {
        await countFile(connection, fileId, summary);
        continue;
      }
      summary.files += 1;
      for (let round = 0; ; round += 1) {
        await moveHistoryOffId(connection, fileId, { storage, summary });
        const result = await moveCurrentToId(connection, fileId, { storage, summary });
        if (result?.obsolete) await storage.delete(result.obsolete);
        if (!result?.again) break;
        if (round === 5) throw new Error(`File ${fileId} kept changing. Stop the backend and run this again.`);
      }
    }
  } finally {
    connection.release();
  }
  return summary;
}
