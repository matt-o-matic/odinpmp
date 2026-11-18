import 'dotenv/config';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnv } from '../config/env.js';
import { createMysqlPool } from '../lib/db/mysql.js';
import { createApplicationObjectStorage } from '../lib/files/file-storage.js';
import { prepareFilesForRollback } from './prepare-file-rollback.lib.js';

// Run from the current release, before rolling back past migration 0093
// (prepare-file-rollback.lib.js). `--dry-run` reports what it would move.

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const dryRun = process.argv.includes('--dry-run');
const env = loadEnv();
const pool = createMysqlPool(env.databaseUrl);
const storage = createApplicationObjectStorage(env, {
  localRoot: env.vaultStoragePath || path.resolve(currentDir, '../../.data/vault'),
  namespace: 'vault',
});

try {
  console.log(JSON.stringify({ dryRun, ...await prepareFilesForRollback({ dryRun, pool, storage }) }));
} finally {
  await pool.end();
}
