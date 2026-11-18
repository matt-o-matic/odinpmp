const TARGET_CHARSET = 'utf8mb4';
const TARGET_COLLATION = 'utf8mb4_0900_ai_ci';

export const schemaParityTableDefinitions = [
  {
    name: 'contributor_metrics',
    sql: `
      CREATE TABLE IF NOT EXISTS \`contributor_metrics\` (
        \`id\` char(36) NOT NULL DEFAULT (uuid()),
        \`tenant_id\` char(36) NOT NULL,
        \`user_id\` char(36) NOT NULL,
        \`metric_date\` date NOT NULL,
        \`tasks_completed\` int DEFAULT '0',
        \`points_completed\` int DEFAULT '0',
        \`hours_logged\` decimal(5,2) DEFAULT '0.00',
        \`created_at\` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uniq_metric\` (\`tenant_id\`,\`user_id\`,\`metric_date\`),
        KEY \`user_id\` (\`user_id\`),
        CONSTRAINT \`contributor_metrics_ibfk_1\` FOREIGN KEY (\`tenant_id\`) REFERENCES \`tenants\` (\`id\`),
        CONSTRAINT \`contributor_metrics_ibfk_2\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `,
  },
  {
    name: 'holiday_calendar',
    sql: `
      CREATE TABLE IF NOT EXISTS \`holiday_calendar\` (
        \`id\` char(36) NOT NULL,
        \`calendar_date\` date NOT NULL,
        \`summary\` varchar(255) DEFAULT NULL,
        \`created_at\` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uniq_holiday\` (\`calendar_date\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `,
  },
  {
    name: 'project_rank_votes',
    sql: `
      CREATE TABLE IF NOT EXISTS \`project_rank_votes\` (
        \`id\` char(36) NOT NULL,
        \`tenant_id\` char(36) NOT NULL,
        \`user_id\` char(36) NOT NULL,
        \`project_a\` char(36) NOT NULL,
        \`project_b\` char(36) NOT NULL,
        \`winner\` char(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
        \`created_at\` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`user_id\` (\`user_id\`,\`project_a\`,\`project_b\`),
        KEY \`tenant_id\` (\`tenant_id\`),
        KEY \`project_a\` (\`project_a\`),
        KEY \`project_b\` (\`project_b\`),
        KEY \`winner\` (\`winner\`),
        CONSTRAINT \`project_rank_votes_ibfk_1\` FOREIGN KEY (\`tenant_id\`) REFERENCES \`tenants\` (\`id\`),
        CONSTRAINT \`project_rank_votes_ibfk_2\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`),
        CONSTRAINT \`project_rank_votes_ibfk_3\` FOREIGN KEY (\`project_a\`) REFERENCES \`projects\` (\`id\`),
        CONSTRAINT \`project_rank_votes_ibfk_4\` FOREIGN KEY (\`project_b\`) REFERENCES \`projects\` (\`id\`),
        CONSTRAINT \`project_rank_votes_ibfk_5\` FOREIGN KEY (\`winner\`) REFERENCES \`projects\` (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `,
  },
  {
    name: 'user_invites',
    sql: `
      CREATE TABLE IF NOT EXISTS \`user_invites\` (
        \`id\` char(36) NOT NULL,
        \`tenant_id\` char(36) NOT NULL,
        \`email\` varchar(255) NOT NULL,
        \`role\` varchar(50) NOT NULL,
        \`invited_at\` datetime DEFAULT CURRENT_TIMESTAMP,
        \`accepted\` tinyint DEFAULT '0',
        \`accepted_at\` datetime DEFAULT NULL,
        \`invite_token\` varchar(255) NOT NULL,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`invite_token\` (\`invite_token\`),
        KEY \`idx_user_invites_tenant_id\` (\`tenant_id\`),
        KEY \`idx_user_invites_accepted\` (\`accepted\`),
        KEY \`idx_user_invites_invited_at\` (\`invited_at\`),
        CONSTRAINT \`user_invites_ibfk_1\` FOREIGN KEY (\`tenant_id\`) REFERENCES \`tenants\` (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `,
  },
];

export const schemaParityIndexDefinitions = [
  { table: 'audit_log', name: 'idx_audit_log_dt_stamp', columns: ['dt_stamp'] },
  { table: 'backup_codes', name: 'idx_backup_codes_created_at', columns: ['created_at'] },
  { table: 'backup_codes', name: 'idx_backup_codes_used', columns: ['used'] },
  { table: 'comment_votes', name: 'idx_comment_votes_comment_id', columns: ['comment_id'] },
  { table: 'comment_votes', name: 'idx_comment_votes_created_at', columns: ['created_at'] },
  { table: 'comments', name: 'idx_comments_date_added', columns: ['date_added'] },
  { table: 'comments', name: 'idx_comments_date_updated', columns: ['date_updated'] },
  { table: 'comments', name: 'idx_comments_parent_id', columns: ['parent_id'] },
  { table: 'comments', name: 'idx_comments_target_id_type', columns: ['target_id', 'target_type'] },
  { table: 'email_bounces', name: 'idx_email_bounces_created_at', columns: ['created_at'] },
  { table: 'email_bounces', name: 'idx_email_bounces_email', columns: ['email'] },
  { table: 'email_opt_out', name: 'idx_email_opt_out_created_at', columns: ['created_at'] },
  { table: 'email_opt_out', name: 'idx_email_opt_out_opted_out', columns: ['opted_out'] },
  { table: 'file_vault', name: 'idx_file_vault_created_at', columns: ['created_at'] },
  { table: 'file_vault', name: 'idx_file_vault_file_modified', columns: ['file_modified'] },
  { table: 'file_vault', name: 'idx_file_vault_target_id_type', columns: ['target_id', 'target_type'] },
  { table: 'mail_queue', name: 'idx_mail_queue_created_at', columns: ['created_at'] },
  { table: 'mail_queue', name: 'idx_mail_queue_status', columns: ['status'] },
  { table: 'preferences', name: 'idx_preferences_key', columns: ['key'] },
  { table: 'projects', name: 'idx_projects_created_at', columns: ['created_at'] },
  { table: 'projects', name: 'idx_projects_deleted', columns: ['deleted'] },
  { table: 'projects', name: 'idx_projects_start_end_date', columns: ['start_date', 'end_date'] },
  { table: 'task_log', name: 'idx_task_log_log_date', columns: ['log_date'] },
  { table: 'task_statuses', name: 'idx_task_statuses_deleted', columns: ['deleted'] },
  { table: 'task_statuses', name: 'idx_task_statuses_sort_order', columns: ['sort_order'] },
  { table: 'task_types', name: 'idx_task_types_deleted', columns: ['deleted'] },
  { table: 'task_types', name: 'idx_task_types_sort_order', columns: ['sort_order'] },
  { table: 'tasks', name: 'idx_tasks_created_at', columns: ['created_at'] },
  { table: 'tasks', name: 'idx_tasks_deleted', columns: ['deleted'] },
  { table: 'tasks', name: 'idx_tasks_sort_order', columns: ['sort_order'] },
  { table: 'tasks', name: 'idx_tasks_start_end_dates', columns: ['target_start_date', 'target_end_date'] },
  { table: 'tenants', name: 'idx_tenants_created_at', columns: ['created_at'] },
  { table: 'tenants', name: 'idx_tenants_name', columns: ['name'] },
  { table: 'tokens', name: 'idx_tokens_expiry_date', columns: ['expiry_date'] },
  { table: 'user_project', name: 'idx_user_project_created_at', columns: ['created_at'] },
  { table: 'user_requests', name: 'idx_user_requests_requested_at', columns: ['requested_at'] },
  { table: 'user_tenant', name: 'idx_user_tenant_created_at', columns: ['created_at'] },
  { table: 'users', name: 'idx_users_created_at', columns: ['created_at'] },
  { table: 'votes', name: 'idx_votes_priority', columns: ['priority'] },
  { table: 'votes', name: 'idx_votes_voted_at', columns: ['voted_at'] },
  { table: 'waiting_list', name: 'idx_waiting_list_signup_date', columns: ['signup_date'] },
];

export const schemaParityCollationTables = [
  'assistant_other_intent_logs',
  'project_clarification_assignments',
  'project_clarification_comment_reactions',
  'project_clarification_comments',
  'project_clarification_email_messages',
  'project_clarification_invitations',
  'project_clarifications',
  'project_sprint_staffing',
  'project_sprints',
  'project_stakeholders',
  'summary_documents',
  'summary_refresh_queue',
];

function quoteIdentifier(identifier) {
  return `\`${String(identifier).replaceAll('`', '``')}\``;
}

async function getCurrentDatabase(executor) {
  const [rows] = await executor.execute('SELECT DATABASE() AS databaseName');
  const databaseName = rows[0]?.databaseName;

  if (!databaseName) {
    throw new Error('Unable to determine the current MySQL database.');
  }

  return databaseName;
}

async function tableExists(executor, databaseName, tableName) {
  const [rows] = await executor.execute(
    `
      SELECT 1
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
        AND TABLE_TYPE = 'BASE TABLE'
      LIMIT 1
    `,
    [databaseName, tableName],
  );

  return Boolean(rows[0]);
}

async function tableCollation(executor, databaseName, tableName) {
  const [rows] = await executor.execute(
    `
      SELECT TABLE_COLLATION AS tableCollation
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
        AND TABLE_TYPE = 'BASE TABLE'
      LIMIT 1
    `,
    [databaseName, tableName],
  );

  return rows[0]?.tableCollation ?? null;
}

async function matchingIndexExists(executor, databaseName, indexDefinition) {
  const [rows] = await executor.execute(
    `
      SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
      ORDER BY INDEX_NAME, SEQ_IN_INDEX
    `,
    [databaseName, indexDefinition.table],
  );
  const desiredColumns = indexDefinition.columns.join('\u0000');
  const desiredUnique = indexDefinition.unique ? 0 : 1;
  const indexes = new Map();

  for (const row of rows) {
    if (!indexes.has(row.INDEX_NAME)) {
      indexes.set(row.INDEX_NAME, {
        columns: [],
        nonUnique: row.NON_UNIQUE,
      });
    }
    indexes.get(row.INDEX_NAME).columns.push(row.COLUMN_NAME);
  }

  for (const [name, index] of indexes.entries()) {
    if (name === indexDefinition.name) {
      return true;
    }

    if (index.nonUnique === desiredUnique && index.columns.join('\u0000') === desiredColumns) {
      return true;
    }
  }

  return false;
}

function createIndexSql(indexDefinition) {
  const uniqueness = indexDefinition.unique ? 'UNIQUE INDEX' : 'INDEX';
  return [
    'ALTER TABLE',
    quoteIdentifier(indexDefinition.table),
    'ADD',
    uniqueness,
    quoteIdentifier(indexDefinition.name),
    `(${indexDefinition.columns.map(quoteIdentifier).join(', ')})`,
  ].join(' ');
}

function createConvertCollationSql(tableName) {
  return [
    'ALTER TABLE',
    quoteIdentifier(tableName),
    'CONVERT TO CHARACTER SET',
    TARGET_CHARSET,
    'COLLATE',
    TARGET_COLLATION,
  ].join(' ');
}

function describeOperation(operation) {
  if (operation.type === 'table') {
    return `create missing table ${operation.table}`;
  }

  if (operation.type === 'index') {
    return `add missing index ${operation.index} on ${operation.table}`;
  }

  return `convert ${operation.table} to ${TARGET_COLLATION}`;
}

async function applyOrReport({
  apply,
  executor,
  onStatus,
  operation,
  results,
}) {
  const message = describeOperation(operation);
  onStatus?.({ message, operation, type: apply ? 'apply' : 'pending' });

  if (apply) {
    await executor.execute(operation.sql);
    results.applied.push(operation);
    return;
  }

  results.pending.push(operation);
}

export function isProductionLikeDatabaseName(databaseName) {
  return /\bprod(uction)?\b|_prod\b|prod_/i.test(String(databaseName ?? ''));
}

export async function runSchemaParityMigration({
  apply = false,
  allowProduction = false,
  collationTables = schemaParityCollationTables,
  executor,
  indexDefinitions = schemaParityIndexDefinitions,
  onStatus = () => {},
  tableDefinitions = schemaParityTableDefinitions,
} = {}) {
  if (!executor?.execute) {
    throw new Error('A MySQL executor is required.');
  }

  const databaseName = await getCurrentDatabase(executor);
  if (apply && isProductionLikeDatabaseName(databaseName) && !allowProduction) {
    throw new Error('Refusing to apply schema parity changes to a production-like database without --allow-production.');
  }

  const results = {
    applied: [],
    databaseName,
    pending: [],
    skipped: [],
  };

  for (const definition of tableDefinitions) {
    if (await tableExists(executor, databaseName, definition.name)) {
      results.skipped.push({ table: definition.name, type: 'table' });
      continue;
    }

    await applyOrReport({
      apply,
      executor,
      onStatus,
      operation: {
        sql: definition.sql,
        table: definition.name,
        type: 'table',
      },
      results,
    });
  }

  for (const definition of indexDefinitions) {
    if (!await tableExists(executor, databaseName, definition.table)) {
      results.skipped.push({ index: definition.name, reason: 'table_missing', table: definition.table, type: 'index' });
      continue;
    }

    if (await matchingIndexExists(executor, databaseName, definition)) {
      results.skipped.push({ index: definition.name, table: definition.table, type: 'index' });
      continue;
    }

    await applyOrReport({
      apply,
      executor,
      onStatus,
      operation: {
        index: definition.name,
        sql: createIndexSql(definition),
        table: definition.table,
        type: 'index',
      },
      results,
    });
  }

  for (const table of collationTables) {
    const currentCollation = await tableCollation(executor, databaseName, table);
    if (!currentCollation) {
      results.skipped.push({ reason: 'table_missing', table, type: 'collation' });
      continue;
    }

    if (currentCollation === TARGET_COLLATION) {
      results.skipped.push({ table, type: 'collation' });
      continue;
    }

    await applyOrReport({
      apply,
      executor,
      onStatus,
      operation: {
        currentCollation,
        sql: createConvertCollationSql(table),
        table,
        targetCollation: TARGET_COLLATION,
        type: 'collation',
      },
      results,
    });
  }

  return results;
}
