// Soft delete for projects. The legacy `projects.deleted` flag is the source of truth;
// `deleted_at` and `deleted_by` record who deleted the project and when. Legacy rows can
// hold NULL in `deleted`, so every read filters with COALESCE.

export function activeProjectSql(alias = 'p') {
  return `COALESCE(${alias ? `${alias}.` : ''}deleted, 0) = 0`;
}

function deletedProjectSql(alias = 'p') {
  return `COALESCE(${alias ? `${alias}.` : ''}deleted, 0) <> 0`;
}

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

async function indexExists(executor, tableName, indexName) {
  const [rows] = await executor.execute(
    `
      SELECT COUNT(*) AS count
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND INDEX_NAME = ?
      LIMIT 1
    `,
    [tableName, indexName],
  );

  return Number(rows[0]?.count ?? 0) > 0;
}

async function ensureMysqlProjectSoftDeleteColumns(executor) {
  if (!await columnExists(executor, 'projects', 'deleted')) {
    await executor.execute('ALTER TABLE projects ADD COLUMN deleted INT NULL DEFAULT 0');
  }

  if (!await columnExists(executor, 'projects', 'deleted_at')) {
    await executor.execute('ALTER TABLE projects ADD COLUMN deleted_at DATETIME(3) NULL');
  }

  if (!await columnExists(executor, 'projects', 'deleted_by')) {
    await executor.execute('ALTER TABLE projects ADD COLUMN deleted_by VARCHAR(100) NULL');
  }

  if (!await indexExists(executor, 'projects', 'idx_projects_deleted')) {
    await executor.execute('CREATE INDEX idx_projects_deleted ON projects (deleted)');
  }
}

export async function ensureMysqlProjectSoftDeleteSchema(executor) {
  await ensureMysqlProjectSoftDeleteColumns(executor);
  // New rows default to live; NULL rows from older inserts become an explicit 0.
  await executor.execute('ALTER TABLE projects ALTER COLUMN deleted SET DEFAULT 0');
  await executor.execute('UPDATE projects SET deleted = 0 WHERE deleted IS NULL');
  await executor.execute('UPDATE projects SET deleted = 1 WHERE deleted NOT IN (0, 1)');
}

function toIsoString(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function deletedProjectFromRow(row) {
  return {
    deletedAt: toIsoString(row.deletedAt),
    deletedBy: row.deletedBy ?? null,
    deletedByName: row.deletedByName ?? null,
    id: row.id,
    name: row.name,
    status: row.status ?? null,
    updatedAt: toIsoString(row.updatedAt),
  };
}

// In memory, a deleted project leaves `state.projects`, so every lookup that reads that
// list (including other in-memory repositories) stops seeing it.
export function createInMemoryProjectDeletionMethods({ authRepository = null, state }) {
  state.deletedProjects ??= [];

  function userName(userId) {
    return authRepository?.state?.users?.find((user) => user.id === userId)?.name ?? null;
  }

  function summarize(entry) {
    return {
      deletedAt: entry.deletedAt,
      deletedBy: entry.deletedBy,
      deletedByName: userName(entry.deletedBy),
      id: entry.project.id,
      name: entry.project.name,
      status: entry.project.status ?? null,
      updatedAt: entry.project.updatedAt ?? null,
    };
  }

  return {
    async getProjectDeletionState({ projectId, tenantId }) {
      const matches = (project) => project.id === projectId && project.tenantId === tenantId;
      if (state.projects.some(matches)) return 'active';
      return state.deletedProjects.some((entry) => matches(entry.project)) ? 'deleted' : 'missing';
    },
    async softDeleteProject({ projectId, tenantId, user }) {
      const index = state.projects.findIndex((project) => project.id === projectId && project.tenantId === tenantId);
      if (index === -1) return null;
      const [project] = state.projects.splice(index, 1);
      const entry = { deletedAt: new Date().toISOString(), deletedBy: user?.id ?? null, project };
      state.deletedProjects.push(entry);
      return summarize(entry);
    },
    async restoreDeletedProject({ projectId, tenantId }) {
      const index = state.deletedProjects.findIndex((entry) => entry.project.id === projectId && entry.project.tenantId === tenantId);
      if (index === -1) return null;
      const [entry] = state.deletedProjects.splice(index, 1);
      state.projects.push(entry.project);
      return { id: entry.project.id, name: entry.project.name, status: entry.project.status ?? null };
    },
    async listDeletedProjects({ tenantId }) {
      return state.deletedProjects
        .filter((entry) => entry.project.tenantId === tenantId)
        .map(summarize)
        .sort((left, right) => String(right.deletedAt ?? '').localeCompare(String(left.deletedAt ?? '')) || left.name.localeCompare(right.name));
    },
  };
}

export function createMysqlProjectDeletionMethods({ pool }) {
  return {
    async getProjectDeletionState({ projectId, tenantId }) {
      const [rows] = await pool.execute(
        'SELECT COALESCE(deleted, 0) AS deleted FROM projects WHERE id = ? AND tenant_id = ? LIMIT 1',
        [projectId, tenantId],
      );
      if (!rows[0]) return 'missing';
      return Number(rows[0].deleted) === 0 ? 'active' : 'deleted';
    },
    async softDeleteProject({ projectId, tenantId, user }) {
      // updated_at is the project's edit version; deleting is not an edit.
      const [result] = await pool.execute(
        `
          UPDATE projects
          SET deleted = 1, deleted_at = NOW(3), deleted_by = ?, updated_at = updated_at
          WHERE id = ? AND tenant_id = ? AND ${activeProjectSql('')}
        `,
        [user?.id ?? null, projectId, tenantId],
      );
      if (!result?.affectedRows) return null;
      const [rows] = await pool.execute(
        `
          SELECT p.id, p.name, ps.project_status_name AS status, p.deleted_at AS deletedAt,
            p.deleted_by AS deletedBy, u.name AS deletedByName, p.updated_at AS updatedAt
          FROM projects p
          LEFT JOIN project_statuses ps ON ps.id = p.project_status
          LEFT JOIN users u ON u.id = p.deleted_by
          WHERE p.id = ? AND p.tenant_id = ?
          LIMIT 1
        `,
        [projectId, tenantId],
      );
      return rows[0] ? deletedProjectFromRow(rows[0]) : null;
    },
    async restoreDeletedProject({ projectId, tenantId }) {
      const [result] = await pool.execute(
        `
          UPDATE projects
          SET deleted = 0, deleted_at = NULL, deleted_by = NULL, updated_at = updated_at
          WHERE id = ? AND tenant_id = ? AND ${deletedProjectSql('')}
        `,
        [projectId, tenantId],
      );
      if (!result?.affectedRows) return null;
      const [rows] = await pool.execute(
        `
          SELECT p.id, p.name, ps.project_status_name AS status
          FROM projects p
          LEFT JOIN project_statuses ps ON ps.id = p.project_status
          WHERE p.id = ? AND p.tenant_id = ?
          LIMIT 1
        `,
        [projectId, tenantId],
      );
      return rows[0] ? { id: rows[0].id, name: rows[0].name, status: rows[0].status ?? null } : null;
    },
    async listDeletedProjects({ tenantId }) {
      const [rows] = await pool.execute(
        `
          SELECT p.id, p.name, ps.project_status_name AS status, p.deleted_at AS deletedAt,
            p.deleted_by AS deletedBy, u.name AS deletedByName, p.updated_at AS updatedAt
          FROM projects p
          LEFT JOIN project_statuses ps ON ps.id = p.project_status
          LEFT JOIN users u ON u.id = p.deleted_by
          WHERE p.tenant_id = ? AND ${deletedProjectSql('p')}
          ORDER BY p.deleted_at IS NULL, p.deleted_at DESC, p.name
        `,
        [tenantId],
      );
      return rows.map(deletedProjectFromRow);
    },
  };
}
