// What workspace search and notification settings read from channels. These methods are spread
// into the projects repositories, as the other channel methods are.
//
// - listChannelSearchSources: every channel, channel post and channel file of a workspace, for
//   the search index. The index is built for the whole workspace; search filters it to the
//   searcher's projects (reporting.service.js).
// - listMemberChannels: the open channels of the active projects one member belongs to
//   (user_project), with each project and the member's role on it, for notification settings.
// - listChannelPostActivity: who posted in which channel of a project, and when, since a date,
//   for the engagement's Insights (pursuit.service.js `channelActivityReader`).

// Bounds a workspace's share of the search index (the index keeps at most 50,000 rows).
export const SEARCH_POSTS_LIMIT = 20_000;
export const SEARCH_FILES_LIMIT = 10_000;

const iso = (value) => (value ? new Date(value).toISOString() : null);
const newestFirst = (left, right) => String(right.createdAt).localeCompare(String(left.createdAt)) || String(right.id).localeCompare(String(left.id));

export function createInMemoryChannelActivityMethods({ authRepository = null, state }) {
  const users = () => authRepository?.state?.users ?? [];
  const userName = (userId) => users().find((user) => user.id === userId)?.name ?? null;
  const authorName = (post) => (post.authorType === 'user'
    ? userName(post.authorId)
    : (state.channelGuests ?? []).find((guest) => guest.stakeholderId === post.authorId)?.name ?? null);
  const channelPost = (post) => ({
    authorId: post.authorId,
    authorName: authorName(post),
    authorType: post.authorType,
    body: post.body ?? '',
    channelId: post.targetId,
    createdAt: post.createdAt,
    editedAt: post.editedAt ?? null,
    id: post.id,
    parentId: post.parentId ?? null,
    projectId: post.projectId,
  });
  const livePosts = (tenantId) => (state.discussionPosts ?? []).filter((post) => post.tenantId === tenantId && post.targetType === 'channel' && !post.deletedAt);

  return {
    async listChannelSearchSources({ tenantId }) {
      const channels = (state.channels ?? []).filter((channel) => channel.tenantId === tenantId);
      const channelIds = new Set(channels.map((channel) => channel.id));
      return {
        channels: channels.map((channel) => ({ archivedAt: channel.archivedAt ?? null, description: channel.description ?? '', id: channel.id, name: channel.name, projectId: channel.projectId, updatedAt: channel.updatedAt ?? channel.createdAt })),
        files: (state.files ?? [])
          .filter((file) => file.tenantId === tenantId && file.targetType === 'channel' && channelIds.has(file.targetId))
          .slice(0, SEARCH_FILES_LIMIT)
          .map((file) => ({ channelId: file.targetId, fileName: file.fileName, folderId: file.folderId ?? null, id: file.id, projectId: file.projectId, updatedAt: file.updatedAt ?? file.createdAt })),
        folders: (state.fileFolders ?? []).filter((folder) => folder.tenantId === tenantId).map((folder) => ({ ...folder })),
        posts: livePosts(tenantId).filter((post) => channelIds.has(post.targetId)).sort(newestFirst).slice(0, SEARCH_POSTS_LIMIT).map(channelPost),
      };
    },
    async listMemberChannels({ tenantId, userId }) {
      const rows = [];
      for (const project of state.projects.filter((entry) => entry.tenantId === tenantId && !entry.deleted)) {
        const membership = (state.projectMemberships.get(project.id) ?? []).find((entry) => entry.id === userId && entry.role);
        if (!membership) continue;
        for (const channel of (state.channels ?? []).filter((entry) => entry.projectId === project.id && entry.tenantId === tenantId && !entry.archivedAt)) {
          rows.push({
            channel: { id: channel.id, name: channel.name },
            project: { engagementOwnerId: project.engagementOwnerId ?? null, engagementStatus: project.engagementStatus ?? null, id: project.id, kind: project.kind ?? 'delivery', name: project.name },
            projectRole: membership.role,
          });
        }
      }
      return rows;
    },
    async listChannelPostActivity({ projectId, since, tenantId }) {
      const channels = new Map((state.channels ?? []).filter((channel) => channel.tenantId === tenantId && channel.projectId === projectId).map((channel) => [channel.id, channel.name]));
      const from = since ? new Date(since).toISOString() : null;
      return livePosts(tenantId)
        .filter((post) => post.projectId === projectId && channels.has(post.targetId) && (!from || iso(post.createdAt) >= from))
        .map((post) => ({ actorId: post.authorId, actorType: post.authorType, at: iso(post.createdAt), channelId: post.targetId, channelName: channels.get(post.targetId) }));
    },
  };
}

export function createMysqlChannelActivityMethods({ pool }) {
  // Names are read by id rather than joined: users and project_stakeholders may not share the
  // channel tables' collation (channels.repository.js does the same).
  async function authorNames(rows) {
    const names = new Map();
    const userIds = [...new Set(rows.filter((row) => row.author_type === 'user').map((row) => row.author_id))];
    const stakeholderIds = [...new Set(rows.filter((row) => row.author_type === 'stakeholder').map((row) => row.author_id))];
    if (userIds.length) for (const user of (await pool.query('SELECT id, name FROM users WHERE id IN (?)', [userIds]))[0]) names.set(`user:${user.id}`, user.name);
    if (stakeholderIds.length) for (const person of (await pool.query('SELECT id, name FROM project_stakeholders WHERE id IN (?)', [stakeholderIds]))[0]) names.set(`stakeholder:${person.id}`, person.name);
    return names;
  }
  async function channelPosts(rows) {
    const names = await authorNames(rows);
    return rows.map((row) => ({
      authorId: row.author_id,
      authorName: names.get(`${row.author_type}:${row.author_id}`) ?? null,
      authorType: row.author_type,
      body: row.body_markdown ?? '',
      channelId: row.target_id,
      createdAt: iso(row.created_at),
      editedAt: iso(row.edited_at),
      id: row.id,
      parentId: row.parent_id ?? null,
      projectId: row.project_id,
    }));
  }

  return {
    async listChannelSearchSources({ tenantId }) {
      const [channels] = await pool.execute('SELECT id, project_id, name, description, archived_at, created_at, updated_at FROM project_channels WHERE tenant_id = ?', [tenantId]);
      const [posts] = await pool.execute(
        `SELECT id, project_id, target_id, parent_id, author_type, author_id, body_markdown, edited_at, created_at
         FROM discussion_posts WHERE tenant_id = ? AND target_type = 'channel' AND deleted_at IS NULL
         ORDER BY created_at DESC, id DESC LIMIT ${SEARCH_POSTS_LIMIT}`,
        [tenantId],
      );
      // file_vault and project_channels share a collation (0096 takes file_vault's).
      const [files] = await pool.execute(
        `SELECT fv.id, fv.file_name, fv.folder_id, fv.target_id, fv.updated_at, fv.created_at, ch.project_id
         FROM file_vault fv INNER JOIN project_channels ch ON ch.id = fv.target_id
         WHERE fv.tenant_id = ? AND fv.target_type = 'channel' AND ch.tenant_id = ?
         ORDER BY fv.updated_at DESC LIMIT ${SEARCH_FILES_LIMIT}`,
        [tenantId, tenantId],
      );
      const [folders] = await pool.execute('SELECT id, project_id, channel_id, parent_id, name FROM file_folders WHERE tenant_id = ?', [tenantId]);
      return {
        channels: channels.map((row) => ({ archivedAt: iso(row.archived_at), description: row.description ?? '', id: row.id, name: row.name, projectId: row.project_id, updatedAt: iso(row.updated_at ?? row.created_at) })),
        files: files.map((row) => ({ channelId: row.target_id, fileName: row.file_name, folderId: row.folder_id ?? null, id: row.id, projectId: row.project_id, updatedAt: iso(row.updated_at ?? row.created_at) })),
        folders: folders.map((row) => ({ channelId: row.channel_id, id: row.id, name: row.name, parentId: row.parent_id ?? null, projectId: row.project_id })),
        posts: await channelPosts(posts),
      };
    },
    async listMemberChannels({ tenantId, userId }) {
      // Each table is read by ids, not joined across: projects and user_project may not share the
      // channel tables' collation.
      const [memberRows] = await pool.execute('SELECT project_id, role FROM user_project WHERE user_id = ? AND role IS NOT NULL', [userId]);
      if (!memberRows.length) return [];
      const [projectRows] = await pool.query(
        'SELECT id, name, kind, engagement_status, engagement_owner_id FROM projects WHERE tenant_id = ? AND COALESCE(deleted, 0) = 0 AND id IN (?)',
        [tenantId, memberRows.map((row) => row.project_id)],
      );
      if (!projectRows.length) return [];
      const [channelRows] = await pool.query('SELECT id, project_id, name FROM project_channels WHERE tenant_id = ? AND archived_at IS NULL AND project_id IN (?)', [tenantId, projectRows.map((row) => row.id)]);
      const projects = new Map(projectRows.map((row) => [row.id, { engagementOwnerId: row.engagement_owner_id ?? null, engagementStatus: row.engagement_status ?? null, id: row.id, kind: row.kind ?? 'delivery', name: row.name }]));
      const roles = new Map(memberRows.map((row) => [row.project_id, row.role]));
      return channelRows.map((row) => ({ channel: { id: row.id, name: row.name }, project: projects.get(row.project_id), projectRole: roles.get(row.project_id) ?? null }));
    },
    async listChannelPostActivity({ projectId, since, tenantId }) {
      // discussion_posts and project_channels are both 0096 tables and share a collation.
      const [rows] = await pool.execute(
        `SELECT p.author_type, p.author_id, p.created_at, p.target_id, ch.name AS channel_name
         FROM discussion_posts p INNER JOIN project_channels ch ON ch.id = p.target_id AND ch.tenant_id = p.tenant_id
         WHERE p.tenant_id = ? AND p.project_id = ? AND p.target_type = 'channel' AND p.deleted_at IS NULL AND p.created_at >= ?
         ORDER BY p.created_at`,
        [tenantId, projectId, since ? new Date(since) : new Date(0)],
      );
      return rows.map((row) => ({ actorId: row.author_id, actorType: row.author_type, at: iso(row.created_at), channelId: row.target_id, channelName: row.channel_name }));
    },
  };
}
