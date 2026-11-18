import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function escapeMysqlIdentifier(identifier) {
  return String(identifier).replaceAll('`', '``');
}

function assertFunction(name, value) {
  if (typeof value !== 'function') {
    throw new Error(`${name} is required.`);
  }
}

export function describeMysqlDatabaseTarget(databaseUrl) {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to reset the database.');
  }

  const parsed = new URL(databaseUrl);

  if (parsed.protocol !== 'mysql:') {
    throw new Error('DATABASE_URL must use the mysql protocol.');
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, '').trim());

  if (!databaseName) {
    throw new Error('DATABASE_URL must include a database name.');
  }

  return {
    databaseName,
    host: parsed.hostname || '127.0.0.1',
    password: decodeURIComponent(parsed.password || ''),
    port: parsed.port || '3306',
    username: decodeURIComponent(parsed.username || ''),
  };
}

export async function dropAllTablesInSchema({ databaseName, pool }) {
  const [rows] = await pool.query(
    `
      SELECT TABLE_NAME AS tableName
      FROM information_schema.tables
      WHERE table_schema = ?
        AND table_type = 'BASE TABLE'
      ORDER BY TABLE_NAME
    `,
    [databaseName],
  );
  const tableNames = (rows ?? []).map((row) => row.tableName).filter(Boolean);

  await pool.execute('SET FOREIGN_KEY_CHECKS = 0');

  try {
    for (const tableName of tableNames) {
      await pool.execute(`DROP TABLE IF EXISTS \`${escapeMysqlIdentifier(tableName)}\``);
    }
  } finally {
    await pool.execute('SET FOREIGN_KEY_CHECKS = 1');
  }

  return tableNames.length;
}

export async function importMysqlSchemaWithCli({
  mysqlCommand = 'mysql',
  readSchemaFile = readFileSync,
  schemaPath,
  spawnSyncImpl = spawnSync,
  target,
}) {
  const args = [
    `--host=${target.host}`,
    `--port=${target.port}`,
  ];

  if (target.username) {
    args.push(`--user=${target.username}`);
  }

  args.push('--protocol=TCP');

  args.push(target.databaseName);

  const result = spawnSyncImpl(mysqlCommand, args, {
    env: target.password
      ? {
          ...process.env,
          MYSQL_PWD: target.password,
        }
      : process.env,
    input: readSchemaFile(schemaPath),
    stdio: ['pipe', 'inherit', 'inherit'],
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`mysql schema import failed with exit code ${result.status ?? 1}.`);
  }
}

export async function resetMysqlDatabase({
  bootstrapMysqlSchema,
  confirmReset,
  createAuthRepository,
  createMysqlPool,
  databaseUrl,
  dropAllTables = dropAllTablesInSchema,
  ensureDevelopmentDemoUser,
  importMysqlSchema,
  nodeEnv = 'development',
  onStatus = null,
  schemaPath,
  skipDemo = false,
  yes = false,
}) {
  const target = describeMysqlDatabaseTarget(databaseUrl);

  if (nodeEnv === 'production') {
    throw new Error('db-reset refuses to run when NODE_ENV=production.');
  }

  if (/prod/i.test(target.databaseName)) {
    throw new Error('db-reset refuses to reset production-like databases.');
  }

  await onStatus?.({ target, type: 'target' });

  if (!yes) {
    assertFunction('confirmReset', confirmReset);
    const confirmed = await confirmReset(target);

    if (!confirmed) {
      throw new Error('Database reset cancelled.');
    }
  }

  assertFunction('createMysqlPool', createMysqlPool);
  assertFunction('dropAllTables', dropAllTables);
  assertFunction('importMysqlSchema', importMysqlSchema);
  assertFunction('bootstrapMysqlSchema', bootstrapMysqlSchema);

  if (!skipDemo) {
    assertFunction('createAuthRepository', createAuthRepository);
    assertFunction('ensureDevelopmentDemoUser', ensureDevelopmentDemoUser);
  }

  const pool = createMysqlPool(databaseUrl);

  try {
    const droppedTableCount = await dropAllTables({
      databaseName: target.databaseName,
      pool,
    });
    await onStatus?.({ droppedTableCount, type: 'dropped' });

    await importMysqlSchema({
      schemaPath,
      target,
    });
    await onStatus?.({ schemaPath, type: 'imported' });

    await bootstrapMysqlSchema({ executor: pool });
    await onStatus?.({ type: 'bootstrapped' });

    let demoBootstrap = { created: false, user: null };

    if (!skipDemo) {
      demoBootstrap = await ensureDevelopmentDemoUser(createAuthRepository({ pool }));
      await onStatus?.({
        demoUserCreated: Boolean(demoBootstrap?.created),
        email: demoBootstrap?.user?.email ?? null,
        type: 'demo',
      });
    }

    return {
      databaseName: target.databaseName,
      demoUserCreated: Boolean(demoBootstrap?.created),
      droppedTableCount,
      target,
    };
  } finally {
    await pool.end?.();
  }
}
