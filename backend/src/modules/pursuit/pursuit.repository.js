// Pursuit work and project settings (docs/engagements/plan.md, "Pursuit board"). These methods are
// spread into the projects repositories, as the engagement methods are, so they share the project
// records, revisions and change log.
import { randomUUID } from 'node:crypto';

import { HttpError } from '../../lib/errors/http-error.js';
import {
  HANDOVER_EPIC_NAME,
  HANDOVER_STORY_NAME,
  isPursuitItem,
  PURSUIT_EPIC_NAME,
  PURSUIT_STORY_NAME,
  pursuitParents,
} from '../../lib/projects/pursuit.js';

// What a project has before anyone changes its settings (Q-06). "Let Odin answer when tagged" is
// each channel's own setting now (0105_channel_odin): project_settings.odin_replies_enabled stays
// in the table, and nothing reads or writes it.
export const DEFAULT_PROJECT_SETTINGS = Object.freeze({ guestsSeeBoard: false });

function presentSettings(record) {
  return {
    guestsSeeBoard: record ? Boolean(record.guestsSeeBoard) : DEFAULT_PROJECT_SETTINGS.guestsSeeBoard,
    updatedAt: record?.updatedAt ?? null,
    updatedBy: record?.updatedBy ?? null,
    version: record ? Number(record.version) : 0,
  };
}

function settingsConflict(actualVersion) {
  return new HttpError(409, 'Someone else changed these settings. Reload and try again.', {
    details: { actualVersion, code: 'settings_version_conflict' },
  });
}

function storyNotFound() {
  return new HttpError(400, 'Choose a story on the project plan.', { details: { code: 'story_not_found' } });
}

function notPursuitTask(itemId) {
  return new HttpError(409, 'Only pursuit tasks can be moved to the project.', { details: { code: 'not_a_pursuit_task', itemId } });
}

function versionConflict(itemId, expectedVersion, actualVersion) {
  return new HttpError(409, 'A task changed since it was loaded. Refresh and retry.', {
    details: { actualVersion: Number(actualVersion), code: 'project_item_version_conflict', expectedVersion: Number(expectedVersion), itemId },
  });
}

/**
 * `helpers` are the projects repository's own: findProjectItemContext, projectItemSnapshot and
 * nextProjectTimestamp.
 */
export function createInMemoryPursuitMethods({ helpers, normalizeTaskNode, pushRevision, state }) {
  const settingsByProject = () => {
    state.projectSettings ??= new Map();
    return state.projectSettings;
  };
  const findProject = (projectId, tenantId) => state.projects.find((project) => project.id === projectId && project.tenantId === tenantId) ?? null;
  const revise = ({ action, after, before, itemId, itemType, now, projectId, tenantId, user, versionAfter, versionBefore }) => pushRevision({
    action, actorName: user?.name ?? '', actorUserId: user?.id ?? '', after, before, createdAt: now,
    id: randomUUID(), itemId, itemType, projectId, tenantId, versionAfter, versionBefore,
  });

  return {
    // The projects where pursuit tasks are assigned to any of `assigneeIds` (outside people).
    async listPursuitAssignments({ assigneeIds, tenantId }) {
      const ids = new Set(assigneeIds);
      const found = [];
      for (const project of state.projects.filter((entry) => entry.tenantId === tenantId)) {
        const seen = new Set();
        for (const epic of (project.epics ?? []).filter(isPursuitItem)) {
          for (const story of epic.stories ?? []) {
            for (const task of story.tasks ?? []) {
              if (ids.has(task.assigneeId) && !seen.has(task.assigneeId)) {
                seen.add(task.assigneeId);
                found.push({ assigneeId: task.assigneeId, projectId: project.id });
              }
            }
          }
        }
      }
      return found;
    },
    // The hidden Pursuit epic and story, made the first time they are needed. Odin's own
    // scaffolding: no revision, and the project's version stays, so an open plan saves as before.
    async ensurePursuitStory({ projectId, tenantId }) {
      const project = findProject(projectId, tenantId);
      if (!project) return null;
      let { epic, story } = pursuitParents(project);
      if (!epic) {
        epic = normalizeTaskNode({ description: '', name: PURSUIT_EPIC_NAME, pursuit: true, status: 'Not Started', stories: [] }, 'epic');
        project.epics.push(epic);
      }
      if (!story) {
        story = normalizeTaskNode({ description: '', name: PURSUIT_STORY_NAME, pursuit: true, status: 'Not Started', tasks: [] }, 'story');
        epic.stories.push(story);
      }
      return { epicId: epic.id, storyId: story.id };
    },
    async getProjectSettings({ projectId, tenantId }) {
      if (!findProject(projectId, tenantId)) return null;
      return presentSettings(settingsByProject().get(projectId));
    },
    async saveProjectSettings({ expectedVersion, input, projectId, tenantId, user }) {
      if (!findProject(projectId, tenantId)) return null;
      const current = settingsByProject().get(projectId) ?? null;
      const actual = current ? current.version : 0;
      if (Number(expectedVersion) !== actual) throw settingsConflict(actual);
      const next = {
        ...presentSettings(current),
        ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
        updatedAt: new Date().toISOString(),
        updatedBy: user.id,
        version: actual + 1,
      };
      settingsByProject().set(projectId, next);
      return presentSettings(next);
    },
    // A visible epic and story on the plan for the open pursuit tasks a conversion moves.
    async createHandoverStory({ projectId, tenantId, user }) {
      const project = findProject(projectId, tenantId);
      if (!project) return null;
      const now = helpers.nextProjectTimestamp(project.updatedAt);
      const story = normalizeTaskNode({ description: '', name: HANDOVER_STORY_NAME, status: 'Not Started', tasks: [], updatedAt: now, version: 1 }, 'story');
      const epic = normalizeTaskNode({ description: '', name: HANDOVER_EPIC_NAME, status: 'Not Started', stories: [], updatedAt: now, version: 1 }, 'epic');
      epic.stories.push(story);
      project.epics.splice(project.epics.filter((entry) => !isPursuitItem(entry)).length, 0, epic);
      project.updatedAt = now;
      for (const [node, itemType] of [[epic, 'epic'], [story, 'story']]) {
        const context = helpers.findProjectItemContext(project, node.id);
        revise({ action: 'create', after: helpers.projectItemSnapshot(context), before: null, itemId: node.id, itemType, now, projectId, tenantId, user, versionAfter: 1, versionBefore: null });
      }
      return { epicId: epic.id, storyId: story.id };
    },
    /**
     * Moves pursuit tasks under a story on the plan, all or none. Each keeps its fields, leaves
     * pursuit work and gets a revision, as a parent change does in the app. `expectedVersions`
     * (by task id) is optional; a task whose version differs stops the move.
     */
    async movePursuitTasks({ expectedVersions = {}, projectId, storyId, taskIds, tenantId, user }) {
      const project = findProject(projectId, tenantId);
      if (!project) return null;
      const target = helpers.findProjectItemContext(project, storyId);
      if (!target || target.itemType !== 'story' || isPursuitItem(target.node)) throw storyNotFound();
      const contexts = taskIds.map((taskId) => {
        const context = helpers.findProjectItemContext(project, taskId);
        if (!context || context.itemType !== 'task' || !isPursuitItem(context.node)) throw notPursuitTask(taskId);
        const expected = expectedVersions[taskId];
        if (expected !== undefined && Number(expected) !== Number(context.node.version)) throw versionConflict(taskId, expected, context.node.version);
        return context;
      });
      const now = helpers.nextProjectTimestamp(project.updatedAt);
      const moved = [];
      for (const context of contexts) {
        const current = helpers.findProjectItemContext(project, context.node.id);
        const before = helpers.projectItemSnapshot(current);
        current.collection.splice(current.index, 1);
        const node = { ...current.node, updatedAt: now, version: Number(current.node.version) + 1 };
        delete node.pursuit;
        target.node.tasks.push(node);
        const after = helpers.projectItemSnapshot(helpers.findProjectItemContext(project, node.id));
        revise({ action: 'update', after, before, itemId: node.id, itemType: 'task', now, projectId, tenantId, user, versionAfter: node.version, versionBefore: Number(current.node.version) });
        moved.push({ id: node.id, version: node.version });
      }
      project.updatedAt = now;
      return { moved, storyId };
    },
  };
}

/**
 * `getMysqlProjectItemRow`, `getTaskTypeIds`, `insertRevision` (a revision and its change log
 * entry), `insertTaskLog` and `mysqlProjectItemSnapshot` come from the MySQL projects repository.
 */
export function createMysqlPursuitMethods({ getMysqlProjectItemRow, getTaskTypeIds, insertRevision, insertTaskLog, mysqlProjectItemSnapshot, pool }) {
  async function withTransaction(handler) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await handler(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
  // Runs inside the caller's transaction when it gives one (a conversion), else in its own.
  const inTransaction = (executor, handler) => (executor ? handler(executor) : withTransaction(handler));
  const bumpProject = (executor, projectId, tenantId) => executor.execute(
    'UPDATE projects SET updated_at = GREATEST(NOW(3), COALESCE(DATE_ADD(updated_at, INTERVAL 1 SECOND), NOW(3))) WHERE id = ? AND tenant_id = ?',
    [projectId, tenantId],
  );

  async function lockProject(executor, projectId, tenantId) {
    const [rows] = await executor.execute('SELECT id FROM projects WHERE id = ? AND tenant_id = ? LIMIT 1 FOR UPDATE', [projectId, tenantId]);
    return Boolean(rows[0]);
  }

  async function nextPosition(executor, { parentId, projectId, taskTypeId }) {
    const [rows] = parentId
      ? await executor.execute('SELECT COALESCE(MAX(sort_order), -1) + 1 AS position FROM tasks WHERE project_id = ? AND task_type = ? AND parent_task_id = ? AND deleted = 0', [projectId, taskTypeId, parentId])
      : await executor.execute('SELECT COALESCE(MAX(sort_order), -1) + 1 AS position FROM tasks WHERE project_id = ? AND task_type = ? AND parent_task_id IS NULL AND deleted = 0', [projectId, taskTypeId]);
    return Number(rows[0]?.position ?? 0);
  }

  async function insertItem(executor, { name, parentId, projectId, pursuit, taskTypeId }) {
    const id = randomUUID();
    const position = await nextPosition(executor, { parentId, projectId, taskTypeId });
    await executor.execute(
      `INSERT INTO tasks (id, project_id, task_type, parent_task_id, name, description, priority, sort_order, created_at, updated_at, version, deleted, pursuit)
       VALUES (?, ?, ?, ?, ?, '', 4, ?, NOW(3), NOW(3), 1, 0, ?)`,
      [id, projectId, taskTypeId, parentId, name, position, pursuit ? 1 : 0],
    );
    await insertTaskLog(executor, id, 'assign', { assigned_to: null });
    await insertTaskLog(executor, id, 'status_change', { status: 'Not Started' });
    return id;
  }

  async function findPursuitParents(executor, { projectId, taskTypeIds }) {
    const [epics] = await executor.execute(
      'SELECT id FROM tasks WHERE project_id = ? AND task_type = ? AND parent_task_id IS NULL AND pursuit = 1 AND deleted = 0 ORDER BY sort_order, id LIMIT 1',
      [projectId, taskTypeIds.Epic],
    );
    const epicId = epics[0]?.id ?? null;
    if (!epicId) return { epicId: null, storyId: null };
    const [stories] = await executor.execute(
      'SELECT id FROM tasks WHERE project_id = ? AND task_type = ? AND parent_task_id = ? AND pursuit = 1 AND deleted = 0 ORDER BY sort_order, id LIMIT 1',
      [projectId, taskTypeIds.Story, epicId],
    );
    return { epicId, storyId: stories[0]?.id ?? null };
  }

  return {
    // The projects where pursuit tasks are assigned to any of `assigneeIds` (outside people). A
    // task's assignee is its latest assign log entry, as everywhere in Odin.
    async listPursuitAssignments({ assigneeIds, tenantId }) {
      if (!assigneeIds.length) return [];
      const [rows] = await pool.query(
        `SELECT DISTINCT assigned.projectId, assigned.assigneeId FROM (
           SELECT t.project_id AS projectId,
             (SELECT JSON_UNQUOTE(JSON_EXTRACT(l.log_data, '$.assigned_to')) FROM task_log l
              WHERE l.task_id = t.id AND l.log_action = 'assign' ORDER BY l.log_date DESC, l.id DESC LIMIT 1) AS assigneeId
           FROM tasks t
           INNER JOIN projects p ON p.id = t.project_id
           WHERE p.tenant_id = ? AND t.pursuit = 1 AND t.deleted = 0
         ) assigned
         WHERE assigned.assigneeId IN (?)`,
        [tenantId, assigneeIds],
      );
      return rows.map((row) => ({ assigneeId: row.assigneeId, projectId: row.projectId }));
    },
    // The hidden Pursuit epic and story, made the first time they are needed. Odin's own
    // scaffolding: no revision, and the project's version stays, so an open plan saves as before.
    async ensurePursuitStory({ executor = null, projectId, tenantId }) {
      return inTransaction(executor, async (connection) => {
        if (!await lockProject(connection, projectId, tenantId)) return null;
        const taskTypeIds = await getTaskTypeIds(connection, tenantId, projectId);
        if (!taskTypeIds.Epic || !taskTypeIds.Story) throw new HttpError(409, 'Epic and story types are not configured for this project.');
        let { epicId, storyId } = await findPursuitParents(connection, { projectId, taskTypeIds });
        epicId ??= await insertItem(connection, { name: PURSUIT_EPIC_NAME, parentId: null, projectId, pursuit: true, taskTypeId: taskTypeIds.Epic });
        storyId ??= await insertItem(connection, { name: PURSUIT_STORY_NAME, parentId: epicId, projectId, pursuit: true, taskTypeId: taskTypeIds.Story });
        return { epicId, storyId };
      });
    },
    async getProjectSettings({ projectId, tenantId }) {
      const [projects] = await pool.execute('SELECT id FROM projects WHERE id = ? AND tenant_id = ? LIMIT 1', [projectId, tenantId]);
      if (!projects[0]) return null;
      const [rows] = await pool.execute(
        `SELECT guests_see_board AS guestsSeeBoard, updated_by AS updatedBy, updated_at AS updatedAt, version
         FROM project_settings WHERE project_id = ? AND tenant_id = ? LIMIT 1`,
        [projectId, tenantId],
      );
      const row = rows[0];
      return presentSettings(row ? { ...row, updatedAt: new Date(row.updatedAt).toISOString() } : null);
    },
    async saveProjectSettings({ expectedVersion, input, projectId, tenantId, user }) {
      const saved = await withTransaction(async (connection) => {
        if (!await lockProject(connection, projectId, tenantId)) return false;
        const [rows] = await connection.execute(
          'SELECT guests_see_board AS guestsSeeBoard, version FROM project_settings WHERE project_id = ? AND tenant_id = ? LIMIT 1 FOR UPDATE',
          [projectId, tenantId],
        );
        const current = rows[0] ?? null;
        const actual = current ? Number(current.version) : 0;
        if (Number(expectedVersion) !== actual) throw settingsConflict(actual);
        const next = { ...presentSettings(current), ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) };
        if (current) {
          await connection.execute(
            'UPDATE project_settings SET guests_see_board = ?, updated_by = ?, updated_at = NOW(3), version = version + 1 WHERE project_id = ? AND tenant_id = ?',
            [next.guestsSeeBoard ? 1 : 0, user.id, projectId, tenantId],
          );
        } else {
          await connection.execute(
            'INSERT INTO project_settings (project_id, tenant_id, guests_see_board, updated_by, updated_at, version) VALUES (?, ?, ?, ?, NOW(3), 1)',
            [projectId, tenantId, next.guestsSeeBoard ? 1 : 0, user.id],
          );
        }
        return true;
      });
      return saved ? this.getProjectSettings({ projectId, tenantId }) : null;
    },
    // A visible epic and story on the plan for the open pursuit tasks a conversion moves.
    async createHandoverStory({ executor = null, projectId, tenantId, user }) {
      return inTransaction(executor, async (connection) => {
        const taskTypeIds = await getTaskTypeIds(connection, tenantId, projectId);
        const epicId = await insertItem(connection, { name: HANDOVER_EPIC_NAME, parentId: null, projectId, pursuit: false, taskTypeId: taskTypeIds.Epic });
        const storyId = await insertItem(connection, { name: HANDOVER_STORY_NAME, parentId: epicId, projectId, pursuit: false, taskTypeId: taskTypeIds.Story });
        for (const [itemId, itemType] of [[epicId, 'epic'], [storyId, 'story']]) {
          const after = await mysqlProjectItemSnapshot(connection, await getMysqlProjectItemRow(connection, { itemId, projectId, tenantId }));
          await insertRevision(connection, { action: 'create', actorUserId: user?.id ?? '', after, before: null, id: randomUUID(), itemId, itemType, projectId, tenantId, versionAfter: 1, versionBefore: null });
        }
        await bumpProject(connection, projectId, tenantId);
        return { epicId, storyId };
      });
    },
    /**
     * Moves pursuit tasks under a story on the plan, all or none. Each keeps its fields, leaves
     * pursuit work and gets a revision, as a parent change does in the app. `expectedVersions`
     * (by task id) is optional; a task whose version differs stops the move.
     */
    async movePursuitTasks({ executor = null, expectedVersions = {}, projectId, storyId, taskIds, tenantId, user }) {
      return inTransaction(executor, async (connection) => {
        if (!await lockProject(connection, projectId, tenantId)) return null;
        const story = await getMysqlProjectItemRow(connection, { forUpdate: true, itemId: storyId, projectId, tenantId });
        if (!story || story.deleted || String(story.item_type).toLowerCase() !== 'story' || Number(story.pursuit) === 1) throw storyNotFound();
        const rows = [];
        for (const taskId of taskIds) {
          const row = await getMysqlProjectItemRow(connection, { forUpdate: true, itemId: taskId, projectId, tenantId });
          if (!row || row.deleted || String(row.item_type).toLowerCase() !== 'task' || Number(row.pursuit) !== 1) throw notPursuitTask(taskId);
          const expected = expectedVersions[taskId];
          if (expected !== undefined && Number(expected) !== Number(row.version)) throw versionConflict(taskId, expected, row.version);
          rows.push(row);
        }
        const moved = [];
        for (const row of rows) {
          const before = await mysqlProjectItemSnapshot(connection, row);
          const position = await nextPosition(connection, { parentId: storyId, projectId, taskTypeId: row.task_type });
          await connection.execute(
            'UPDATE tasks SET parent_task_id = ?, sort_order = ?, pursuit = 0, version = version + 1, updated_at = NOW(3) WHERE id = ? AND project_id = ?',
            [storyId, position, row.id, projectId],
          );
          const after = await mysqlProjectItemSnapshot(connection, await getMysqlProjectItemRow(connection, { itemId: row.id, projectId, tenantId }));
          await insertRevision(connection, {
            action: 'update', actorUserId: user?.id ?? '', after, before, id: randomUUID(), itemId: row.id, itemType: 'task', projectId, tenantId,
            versionAfter: Number(row.version) + 1, versionBefore: Number(row.version),
          });
          moved.push({ id: row.id, version: Number(row.version) + 1 });
        }
        await bumpProject(connection, projectId, tenantId);
        return { moved, storyId };
      });
    },
  };
}
