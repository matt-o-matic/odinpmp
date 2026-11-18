import 'dotenv/config';

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { loadEnv } from '../config/env.js';
import { createMysqlPool } from '../lib/db/mysql.js';
import { buildJobLogContext, logBackendError, logBackendEvent } from '../lib/logging/backend-logger.js';
import { createMysqlAuthRepository } from '../modules/auth/auth.repository.js';
import { ensureDevelopmentDemoUser } from '../modules/auth/auth.service.js';
import { bootstrapMysqlSchema } from './bootstrap-schema.lib.js';
import { importMysqlSchemaWithCli, resetMysqlDatabase } from './db-reset.lib.js';

const JOB_NAME = 'db-reset';
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(currentDir, '../../db/base-schema.sql');

function parseCliFlags(argv = process.argv.slice(2)) {
  return {
    skipDemo: argv.includes('--skip-demo'),
    yes: argv.includes('--yes'),
  };
}

async function confirmReset(target) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('db-reset requires an interactive terminal unless --yes is passed.');
  }

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const prompt = [
      `Reset MySQL database ${target.databaseName} on ${target.host}:${target.port}.`,
      `Type ${target.databaseName} to continue: `,
    ].join('\n');
    const answer = await readline.question(prompt);
    return answer.trim() === target.databaseName;
  } finally {
    readline.close();
  }
}

async function main() {
  const env = loadEnv(process.env);
  if (!env.databaseUrl) {
    throw new Error('DATABASE_URL is required to reset the database.');
  }

  const options = parseCliFlags();
  const context = buildJobLogContext(JOB_NAME);

  const result = await resetMysqlDatabase({
    bootstrapMysqlSchema,
    confirmReset,
    createAuthRepository: ({ pool }) => createMysqlAuthRepository({ pool }),
    createMysqlPool,
    databaseUrl: env.databaseUrl,
    ensureDevelopmentDemoUser,
    importMysqlSchema: (args) => importMysqlSchemaWithCli({
      ...args,
      readSchemaFile: readFileSync,
      spawnSyncImpl: spawnSync,
    }),
    nodeEnv: env.nodeEnv,
    onStatus: ({ demoUserCreated, droppedTableCount, email, schemaPath: importedSchemaPath, target, type }) => {
      if (type === 'target') {
        console.log(`Target: ${target.host}:${target.port}/${target.databaseName}`);
        return;
      }

      if (type === 'dropped') {
        console.log(`Dropped ${droppedTableCount} tables from ${target?.databaseName ?? 'the target schema'}.`);
        return;
      }

      if (type === 'imported') {
        console.log(`Imported legacy schema from ${importedSchemaPath}.`);
        return;
      }

      if (type === 'bootstrapped') {
        console.log('Applied modern schema bootstrap.');
        return;
      }

      if (type === 'demo') {
        console.log(demoUserCreated
          ? `Recreated demo login for ${email ?? 'demo@odinpmp.local'}.`
          : 'Demo login already existed after reset.');
      }
    },
    schemaPath,
    skipDemo: options.skipDemo,
    yes: options.yes,
  });

  console.log(
    `Reset complete for ${result.databaseName}. Dropped ${result.droppedTableCount} tables.${result.demoUserCreated ? ' Demo login recreated.' : ''}`,
  );
  logBackendEvent({
    context,
    message: 'Database reset completed.',
  });
}

main().catch((error) => {
  logBackendError({
    context: buildJobLogContext(JOB_NAME),
    error,
    message: 'Database reset job failed.',
  });
  process.exitCode = 1;
});
