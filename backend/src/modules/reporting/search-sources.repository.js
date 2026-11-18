// What the search index reads besides projects and channels (docs/semantic-search/plan.md):
// comments on projects and work items, and every project file. Spread into the projects
// repositories, as the channel search sources are (channels/channel-activity.repository.js).
//
// - listSearchComments: comments on projects, epics, stories and tasks, newest first. Ticket
//   comments stay out: tickets submitted from outside the team are hidden from agents until
//   validated, and the index does not carry that state.
// - listSearchFileSources: every file of a workspace except direct-message and ticket files, with
//   the project it belongs to and what identifies its current contents (version, sha256).

export const SEARCH_COMMENTS_LIMIT = 20_000;
export const SEARCH_FILE_SOURCES_LIMIT = 10_000;
export const SEARCH_COMMENT_TARGETS = Object.freeze(['project', 'epic', 'story', 'task']);
const ITEM_TARGETS = new Set(['epic', 'story', 'task']);
const EXCLUDED_FILE_TARGETS = ['dm', 'ticket'];

const iso = (value) => (value ? new Date(value).toISOString() : null);
const newestFirst = (left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)) || String(right.id).localeCompare(String(left.id));

export function createInMemorySearchSourceMethods({ authRepository = null, state }) {
  const userName = (userId) => (authRepository?.state?.users ?? []).find((user) => user.id === userId)?.name ?? null;
  const projectsOf = (tenantId) => new Set((state.projects ?? []).filter((project) => project.tenantId === tenantId && !project.deleted).map((project) => project.id));
  return {
    async listSearchComments({ tenantId }) {
      const projects = projectsOf(tenantId);
      return (state.comments ?? [])
        .filter((comment) => projects.has(comment.projectId) && SEARCH_COMMENT_TARGETS.includes(comment.targetType))
        .map((comment) => ({
          authorName: comment.authorName ?? userName(comment.userId),
          body: comment.comment ?? '',
          id: comment.id,
          projectId: comment.projectId,
          targetId: comment.targetId,
          targetType: comment.targetType,
          updatedAt: comment.updatedAt ?? comment.createdAt,
        }))
        .sort(newestFirst)
        .slice(0, SEARCH_COMMENTS_LIMIT);
    },
    async listSearchFileSources({ tenantId }) {
      const projects = projectsOf(tenantId);
      return (state.files ?? [])
        .filter((file) => file.tenantId === tenantId && !EXCLUDED_FILE_TARGETS.includes(file.targetType) && projects.has(file.projectId))
        .map((file) => ({
          contentType: file.contentType ?? '',
          fileName: file.fileName,
          fileSize: Number(file.fileSize ?? 0),
          folderId: file.folderId ?? null,
          id: file.id,
          projectId: file.projectId,
          scanStatus: file.scanStatus ?? null,
          sha256: file.sha256 ?? null,
          targetId: file.targetId,
          targetType: file.targetType,
          updatedAt: file.updatedAt ?? file.createdAt,
          version: Number(file.version ?? 1),
        }))
        .sort(newestFirst)
        .slice(0, SEARCH_FILE_SOURCES_LIMIT);
    },
  };
}

// Reads rows of `table` by id in batches. Tables are read by ids rather than joined: they don't
// all share a collation.
async function byIds(pool, sql, ids) {
  const rows = [];
  const unique = [...new Set(ids.filter(Boolean))];
  for (let offset = 0; offset < unique.length; offset += 500) {
    const batch = unique.slice(offset, offset + 500);
    const [found] = await pool.query(sql.replace('(?)', `(${batch.map(() => '?').join(',')})`), batch);
    rows.push(...found);
  }
  return rows;
}

export function createMysqlSearchSourceMethods({ pool }) {
  async function liveProjects(tenantId) {
    const [rows] = await pool.execute('SELECT id FROM projects WHERE tenant_id = ? AND (deleted IS NULL OR deleted = 0)', [tenantId]);
    return new Set(rows.map((row) => row.id));
  }

  return {
    async listSearchComments({ tenantId }) {
      const projects = await liveProjects(tenantId);
      const [comments] = await pool.query(
        `SELECT id, user_id, target_id, target_type, comment, date_added, date_updated FROM comments
         WHERE tenant_id = ? AND target_type IN (?, ?, ?, ?)
         ORDER BY date_updated DESC, id DESC LIMIT ${SEARCH_COMMENTS_LIMIT}`,
        [tenantId, ...SEARCH_COMMENT_TARGETS],
      );
      const items = new Map((await byIds(pool, 'SELECT id, project_id, deleted FROM tasks WHERE id IN (?)', comments.filter((row) => ITEM_TARGETS.has(row.target_type)).map((row) => row.target_id)))
        .filter((row) => !Number(row.deleted)).map((row) => [row.id, row.project_id]));
      const names = new Map((await byIds(pool, 'SELECT id, name FROM users WHERE id IN (?)', comments.map((row) => row.user_id))).map((row) => [row.id, row.name]));
      return comments.flatMap((row) => {
        const projectId = row.target_type === 'project' ? row.target_id : items.get(row.target_id);
        if (!projectId || !projects.has(projectId)) return [];
        return [{
          authorName: names.get(row.user_id) ?? null,
          body: row.comment ?? '',
          id: row.id,
          projectId,
          targetId: row.target_id,
          targetType: row.target_type,
          updatedAt: iso(row.date_updated ?? row.date_added),
        }];
      });
    },
    async listSearchFileSources({ tenantId }) {
      const projects = await liveProjects(tenantId);
      const [files] = await pool.query(
        `SELECT id, target_type, target_id, file_name, file_type, file_size, current_version, sha256, scan_status, folder_id, updated_at, created_at
         FROM file_vault WHERE tenant_id = ? AND target_type NOT IN ('dm', 'ticket')
         ORDER BY updated_at DESC, id DESC LIMIT ${SEARCH_FILE_SOURCES_LIMIT}`,
        [tenantId],
      );
      const idsOf = (predicate) => files.filter((row) => predicate(row.target_type)).map((row) => row.target_id);
      const owners = new Map([
        ...(await byIds(pool, 'SELECT id, project_id FROM project_channels WHERE id IN (?)', idsOf((type) => type === 'channel'))).map((row) => [`channel:${row.id}`, row.project_id]),
        ...(await byIds(pool, 'SELECT id, project_id FROM project_clarifications WHERE id IN (?)', idsOf((type) => type === 'clarification'))).map((row) => [`clarification:${row.id}`, row.project_id]),
        ...(await byIds(pool, 'SELECT id, project_id FROM tasks WHERE id IN (?) AND (deleted IS NULL OR deleted = 0)', idsOf((type) => !['project', 'channel', 'clarification'].includes(type)))).map((row) => [`item:${row.id}`, row.project_id]),
      ]);
      return files.flatMap((row) => {
        const key = row.target_type === 'channel' || row.target_type === 'clarification' ? `${row.target_type}:${row.target_id}` : `item:${row.target_id}`;
        const projectId = row.target_type === 'project' ? row.target_id : owners.get(key);
        if (!projectId || !projects.has(projectId)) return [];
        return [{
          contentType: row.file_type ?? '',
          fileName: row.file_name,
          fileSize: Number(row.file_size ?? 0),
          folderId: row.folder_id ?? null,
          id: row.id,
          projectId,
          scanStatus: row.scan_status ?? null,
          sha256: row.sha256 ?? null,
          targetId: row.target_id,
          targetType: row.target_type,
          updatedAt: iso(row.updated_at ?? row.created_at),
          version: Number(row.current_version ?? 1),
        }];
      });
    },
  };
}
