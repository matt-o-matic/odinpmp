// Engagements are projects with kind = 'engagement' (docs/engagements/plan.md). These methods are
// spread into the projects repositories, as the deletion methods are, so they share the project
// records, memberships and change log.
import { randomUUID } from 'node:crypto';

import { HttpError } from '../../lib/errors/http-error.js';
import { PROJECT_KIND_DELIVERY, PROJECT_KIND_ENGAGEMENT } from '../../lib/projects/project-kind.js';
import { appendMysqlProjectChanges } from '../changes/project-change-log.js';
import { activeProjectSql } from '../projects/project-deletion.repository.js';

const OPEN_PROJECT_STATUS = 'Planned';
const LOST_PROJECT_STATUS = 'Archived';
const MODERATOR_ROLES = new Set(['admin', 'manager']);

function tenantRoleOf(user, tenantId) {
  return String(user?.memberships?.find((membership) => membership.tenantId === tenantId)?.role ?? '').toLowerCase();
}

function engagementStateError(message, code, details = {}) {
  return new HttpError(409, message, { details: { code, ...details } });
}

/** The change log entry for an engagement created, converted, closed (lost) or reopened. */
export function engagementChange({ action, actorId, detail = {}, projectId, tenantId }) {
  return { action, actorId, detail, entityId: projectId, entityType: 'engagement', itemId: null, projectId, tenantId };
}

// Checks the engagement can move from its current state for `action`, or throws a 409 naming why.
export function assertEngagementTransition(record, action) {
  if (!record) throw new HttpError(404, 'Project not found.');
  const isEngagement = record.kind === PROJECT_KIND_ENGAGEMENT;
  if (action === 'convert' || action === 'close') {
    if (!isEngagement) throw engagementStateError('Only an engagement can be converted or marked lost.', 'not_an_engagement');
    if (record.engagementStatus !== 'open') throw engagementStateError('Reopen the engagement first.', 'engagement_not_open', { engagementStatus: record.engagementStatus });
  }
  if (action === 'reopen') {
    if (!isEngagement || record.engagementStatus !== 'lost') throw engagementStateError('Only a lost engagement can be reopened.', 'engagement_not_lost', { engagementStatus: record.engagementStatus ?? null });
  }
}

function summarizeEngagement(project, { ownerName = null, role = null, lastActivityAt = null } = {}) {
  return {
    closedAt: project.closedAt ?? null,
    convertedAt: project.convertedAt ?? null,
    createdAt: project.createdAt,
    customer: project.engagementCustomer ?? '',
    id: project.id,
    kind: project.kind,
    lastActivityAt: lastActivityAt ?? project.updatedAt,
    name: project.name,
    ownerId: project.engagementOwnerId ?? null,
    ownerName,
    role,
    status: project.engagementStatus,
    updatedAt: project.updatedAt,
  };
}

function sortEngagements(rows) {
  return rows.sort((left, right) => String(right.lastActivityAt).localeCompare(String(left.lastActivityAt)) || left.name.localeCompare(right.name));
}

export function createInMemoryEngagementMethods({ authRepository = null, changeLog, normalizeProject, state }) {
  const userName = (userId) => authRepository?.state?.users?.find((user) => user.id === userId)?.name ?? null;
  const findProject = (projectId, tenantId) => state.projects.find((project) => project.id === projectId && project.tenantId === tenantId) ?? null;
  const touch = (project) => {
    const next = Math.max(Date.now(), Date.parse(project.updatedAt ?? 0) + 1000);
    project.updatedAt = new Date(next).toISOString();
  };
  const visibleTo = (project, user, tenantId) => {
    if (MODERATOR_ROLES.has(tenantRoleOf(user, tenantId))) return true;
    const memberships = state.projectMemberships.get(project.id);
    return memberships ? memberships.some((entry) => entry.id === user?.id && entry.role) : Boolean(project.role);
  };
  const lastActivity = (project) => {
    const logged = changeLog.list({ limit: 1000, projectId: project.id, tenantId: project.tenantId }).entries.map((entry) => entry.at).filter(Boolean);
    return [project.updatedAt, ...logged].sort().at(-1);
  };

  return {
    async getProjectKind({ projectId }) {
      const project = state.projects.find((entry) => entry.id === projectId);
      return project ? { engagementOwnerId: project.engagementOwnerId ?? null, engagementStatus: project.engagementStatus ?? null, kind: project.kind ?? PROJECT_KIND_DELIVERY, name: project.name ?? '', tenantId: project.tenantId } : null;
    },
    // A project's name and kind without its plan, for lists of projects outside people are in.
    async getProjectHeader({ projectId, tenantId }) {
      const project = state.projects.find((entry) => entry.id === projectId && entry.tenantId === tenantId && !entry.deletedAt);
      return project ? { customer: project.engagementCustomer ?? '', engagementStatus: project.engagementStatus ?? null, id: project.id, kind: project.kind ?? PROJECT_KIND_DELIVERY, name: project.name ?? '', tenantId: project.tenantId } : null;
    },
    async createEngagement({ input, tenantId, user }) {
      const now = new Date().toISOString();
      const project = normalizeProject({
        createdAt: now,
        description: input.description ?? '',
        engagementCustomer: input.customer,
        engagementOwnerId: user.id,
        engagementStatus: 'open',
        epics: [],
        kind: PROJECT_KIND_ENGAGEMENT,
        name: input.name,
        role: 'admin',
        status: OPEN_PROJECT_STATUS,
        tenantId,
        updatedAt: now,
      });
      state.projects.push(project);
      // The creator is the engagement's project admin (E-03).
      state.projectMemberships.set(project.id, [{ email: user.email ?? '', id: user.id, name: user.name ?? '', role: 'admin' }]);
      changeLog.append([engagementChange({ action: 'create', actorId: user.id, detail: { customer: project.engagementCustomer, status: 'open' }, projectId: project.id, tenantId })]);
      return structuredClone(project);
    },
    async listEngagements({ tenantId, user }) {
      const role = tenantRoleOf(user, tenantId);
      return sortEngagements(state.projects
        .filter((project) => project.tenantId === tenantId && (project.kind === PROJECT_KIND_ENGAGEMENT || project.engagementStatus))
        .filter((project) => visibleTo(project, user, tenantId))
        .map((project) => summarizeEngagement(project, {
          lastActivityAt: lastActivity(project),
          ownerName: userName(project.engagementOwnerId),
          role: state.projectMemberships.get(project.id)?.find((entry) => entry.id === user?.id)?.role ?? role ?? null,
        })));
    },
    // For views that count work by project id, such as the leaderboard.
    async listEngagementProjectIds({ tenantId }) {
      return state.projects.filter((project) => project.tenantId === tenantId && project.kind === PROJECT_KIND_ENGAGEMENT).map((project) => project.id);
    },
    async countOpenEngagements({ tenantId }) {
      return state.projects.filter((project) => project.tenantId === tenantId && project.kind === PROJECT_KIND_ENGAGEMENT && project.engagementStatus === 'open').length;
    },
    // One step: the checks and every change happen together or not at all. `beforeCommit` runs
    // first, so a failure there leaves the engagement as it was.
    async convertEngagement({ beforeCommit = null, projectId, tenantId, user }) {
      const project = findProject(projectId, tenantId);
      assertEngagementTransition(project, 'convert');
      if (beforeCommit) await beforeCommit({ executor: null, projectId, tenantId });
      project.kind = PROJECT_KIND_DELIVERY;
      project.engagementStatus = 'won';
      project.status = OPEN_PROJECT_STATUS;
      project.convertedAt = new Date().toISOString();
      project.convertedBy = user.id;
      touch(project);
      changeLog.append([engagementChange({ action: 'convert', actorId: user.id, detail: { status: 'won' }, projectId, tenantId })]);
      return structuredClone(project);
    },
    // The customer and owner of an open engagement (E-09).
    async updateEngagementFields({ customer, ownerId, projectId, tenantId, user }) {
      const project = findProject(projectId, tenantId);
      if (!project || project.kind !== PROJECT_KIND_ENGAGEMENT) throw new HttpError(404, 'Project not found.');
      const detail = {};
      if (customer !== undefined && customer !== project.engagementCustomer) { project.engagementCustomer = customer; detail.customer = customer; }
      if (ownerId !== undefined && ownerId !== project.engagementOwnerId) { project.engagementOwnerId = ownerId; detail.ownerId = ownerId; }
      if (Object.keys(detail).length) {
        touch(project);
        changeLog.append([engagementChange({ action: 'update', actorId: user.id, detail, projectId, tenantId })]);
      }
      return structuredClone(project);
    },
    async closeEngagement({ projectId, tenantId, user }) {
      const project = findProject(projectId, tenantId);
      assertEngagementTransition(project, 'close');
      project.engagementStatus = 'lost';
      project.status = LOST_PROJECT_STATUS;
      project.closedAt = new Date().toISOString();
      touch(project);
      changeLog.append([engagementChange({ action: 'close', actorId: user.id, detail: { status: 'lost' }, projectId, tenantId })]);
      return structuredClone(project);
    },
    async reopenEngagement({ projectId, tenantId, user }) {
      const project = findProject(projectId, tenantId);
      assertEngagementTransition(project, 'reopen');
      project.engagementStatus = 'open';
      project.status = OPEN_PROJECT_STATUS;
      project.closedAt = null;
      touch(project);
      changeLog.append([engagementChange({ action: 'reopen', actorId: user.id, detail: { status: 'open' }, projectId, tenantId })]);
      return structuredClone(project);
    },
  };
}

// The engagement columns as project fields, from a row selected with engagementColumnsSql.
export function engagementFieldsFromRow(row) {
  const iso = (value) => (value ? new Date(value).toISOString() : null);
  return {
    closedAt: iso(row.closedAt),
    convertedAt: iso(row.convertedAt),
    convertedBy: row.convertedBy ?? null,
    engagementCustomer: row.engagementCustomer ?? null,
    engagementOwnerId: row.engagementOwnerId ?? null,
    engagementStatus: row.engagementStatus ?? null,
    kind: row.kind === PROJECT_KIND_ENGAGEMENT ? PROJECT_KIND_ENGAGEMENT : PROJECT_KIND_DELIVERY,
  };
}

export function engagementColumnsSql(alias = 'p') {
  const a = alias ? `${alias}.` : '';
  return `${a}kind AS kind, ${a}engagement_status AS engagementStatus, ${a}engagement_customer AS engagementCustomer,
    ${a}engagement_owner_id AS engagementOwnerId, ${a}converted_at AS convertedAt, ${a}converted_by AS convertedBy, ${a}closed_at AS closedAt`;
}

async function withTransaction(pool, handler) {
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

/**
 * `getProjectDetail(executor, { projectId, tenantId })` and `getProjectStatusId(executor, status)`
 * come from the MySQL projects repository.
 */
export function createMysqlEngagementMethods({ getProjectDetail, getProjectStatusId, pool }) {
  async function lockEngagement(connection, projectId, tenantId) {
    const [rows] = await connection.execute(
      `SELECT id, kind, engagement_status AS engagementStatus FROM projects WHERE id = ? AND tenant_id = ? AND ${activeProjectSql('')} LIMIT 1 FOR UPDATE`,
      [projectId, tenantId],
    );
    return rows[0] ?? null;
  }

  async function transition({ action, apply, projectId, tenantId, user }) {
    await withTransaction(pool, async (connection) => {
      assertEngagementTransition(await lockEngagement(connection, projectId, tenantId), action);
      await apply(connection);
      await appendMysqlProjectChanges(connection, [engagementChange({ action, actorId: user.id, detail: { status: { close: 'lost', convert: 'won', reopen: 'open' }[action] }, projectId, tenantId })]);
    });
    return getProjectDetail(pool, { projectId, tenantId });
  }

  const bumpUpdatedAt = 'updated_at = GREATEST(NOW(3), COALESCE(DATE_ADD(updated_at, INTERVAL 1 SECOND), NOW(3)))';

  return {
    async getProjectKind({ projectId }) {
      const [rows] = await pool.execute(
        `SELECT tenant_id AS tenantId, name, kind, engagement_status AS engagementStatus, engagement_owner_id AS engagementOwnerId FROM projects WHERE id = ? AND ${activeProjectSql('')} LIMIT 1`,
        [projectId],
      );
      return rows[0] ? { engagementOwnerId: rows[0].engagementOwnerId ?? null, engagementStatus: rows[0].engagementStatus ?? null, kind: rows[0].kind ?? PROJECT_KIND_DELIVERY, name: rows[0].name ?? '', tenantId: rows[0].tenantId } : null;
    },
    async getProjectHeader({ projectId, tenantId }) {
      const [rows] = await pool.execute(
        `SELECT id, tenant_id AS tenantId, name, kind, engagement_status AS engagementStatus, engagement_customer AS customer FROM projects WHERE id = ? AND tenant_id = ? AND ${activeProjectSql('')} LIMIT 1`,
        [projectId, tenantId],
      );
      const row = rows[0];
      return row ? { customer: row.customer ?? '', engagementStatus: row.engagementStatus ?? null, id: row.id, kind: row.kind ?? PROJECT_KIND_DELIVERY, name: row.name ?? '', tenantId: row.tenantId } : null;
    },
    async createEngagement({ input, tenantId, user }) {
      const projectId = randomUUID();
      await withTransaction(pool, async (connection) => {
        const statusId = await getProjectStatusId(connection, OPEN_PROJECT_STATUS);
        await connection.execute(
          `INSERT INTO projects (id, tenant_id, name, description, project_status, start_date, end_date, kind, engagement_status, engagement_customer, engagement_owner_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, 'open', ?, ?, NOW(), NOW())`,
          [projectId, tenantId, input.name, input.description ?? '', statusId, PROJECT_KIND_ENGAGEMENT, input.customer, user.id],
        );
        // The creator is the engagement's project admin (E-03).
        await connection.execute(
          "INSERT INTO user_project (id, user_id, project_id, role, created_at, updated_at) VALUES (?, ?, ?, 'admin', NOW(), NOW())",
          [randomUUID(), user.id, projectId],
        );
        await appendMysqlProjectChanges(connection, [engagementChange({ action: 'create', actorId: user.id, detail: { customer: input.customer, status: 'open' }, projectId, tenantId })]);
      });
      return { ...(await getProjectDetail(pool, { projectId, tenantId })), role: 'admin' };
    },
    async listEngagements({ tenantId, user }) {
      const seesAll = MODERATOR_ROLES.has(tenantRoleOf(user, tenantId));
      const [rows] = await pool.execute(
        `SELECT p.id, p.name, p.created_at AS createdAt, p.updated_at AS updatedAt, ${engagementColumnsSql('p')},
            owner.name AS ownerName, up.role AS projectRole
         FROM projects p
         LEFT JOIN users owner ON owner.id = p.engagement_owner_id
         LEFT JOIN user_project up ON up.project_id = p.id AND up.user_id = ? AND up.role IS NOT NULL
         WHERE p.tenant_id = ?
           AND ${activeProjectSql('p')}
           AND (p.kind = ? OR p.engagement_status IS NOT NULL)
           AND (? = 1 OR up.user_id IS NOT NULL)`,
        [user.id, tenantId, PROJECT_KIND_ENGAGEMENT, seesAll ? 1 : 0],
      );
      // The latest change logged on each, read by id: project_change_log may not share the
      // projects table's collation, so the two are never compared in SQL.
      const loggedAtById = new Map();
      if (rows.length) {
        const [logged] = await pool.query(
          'SELECT project_id AS projectId, MAX(created_at) AS loggedAt FROM project_change_log WHERE tenant_id = ? AND project_id IN (?) GROUP BY project_id',
          [tenantId, rows.map((row) => row.id)],
        );
        for (const row of logged) loggedAtById.set(row.projectId, new Date(row.loggedAt).toISOString());
      }
      const role = tenantRoleOf(user, tenantId) || null;
      return sortEngagements(rows.map((row) => {
        const updatedAt = new Date(row.updatedAt).toISOString();
        const loggedAt = loggedAtById.get(row.id) ?? null;
        return summarizeEngagement(
          { createdAt: new Date(row.createdAt).toISOString(), id: row.id, name: row.name, updatedAt, ...engagementFieldsFromRow(row) },
          { lastActivityAt: [updatedAt, loggedAt].filter(Boolean).sort().at(-1), ownerName: row.ownerName ?? null, role: row.projectRole ?? role },
        );
      }));
    },
    // For views that count work by project id, such as the leaderboard.
    async listEngagementProjectIds({ tenantId }) {
      const [rows] = await pool.execute('SELECT id FROM projects WHERE tenant_id = ? AND kind = ?', [tenantId, PROJECT_KIND_ENGAGEMENT]);
      return rows.map((row) => row.id);
    },
    async countOpenEngagements({ tenantId }) {
      const [rows] = await pool.execute(
        `SELECT COUNT(*) AS n FROM projects WHERE tenant_id = ? AND kind = ? AND engagement_status = 'open' AND ${activeProjectSql('')}`,
        [tenantId, PROJECT_KIND_ENGAGEMENT],
      );
      return Number(rows[0]?.n ?? 0);
    },
    // One transaction: the checks, `beforeCommit` (adding guests as stakeholders) and the change
    // to a delivery project commit together or not at all.
    convertEngagement({ beforeCommit = null, projectId, tenantId, user }) {
      return transition({
        action: 'convert',
        async apply(connection) {
          if (beforeCommit) await beforeCommit({ executor: connection, projectId, tenantId });
          await connection.execute(
            `UPDATE projects SET kind = ?, engagement_status = 'won', project_status = ?, converted_at = NOW(3), converted_by = ?, ${bumpUpdatedAt} WHERE id = ? AND tenant_id = ?`,
            [PROJECT_KIND_DELIVERY, await getProjectStatusId(connection, OPEN_PROJECT_STATUS), user.id, projectId, tenantId],
          );
        },
        projectId,
        tenantId,
        user,
      });
    },
    async updateEngagementFields({ customer, ownerId, projectId, tenantId, user }) {
      await withTransaction(pool, async (connection) => {
        const [rows] = await connection.execute(
          `SELECT kind, engagement_customer AS customer, engagement_owner_id AS ownerId FROM projects WHERE id = ? AND tenant_id = ? AND ${activeProjectSql('')} LIMIT 1 FOR UPDATE`,
          [projectId, tenantId],
        );
        if (!rows[0] || rows[0].kind !== PROJECT_KIND_ENGAGEMENT) throw new HttpError(404, 'Project not found.');
        const detail = {};
        if (customer !== undefined && customer !== rows[0].customer) detail.customer = customer;
        if (ownerId !== undefined && ownerId !== rows[0].ownerId) detail.ownerId = ownerId;
        if (!Object.keys(detail).length) return;
        await connection.execute(
          `UPDATE projects SET engagement_customer = ?, engagement_owner_id = ?, ${bumpUpdatedAt} WHERE id = ? AND tenant_id = ?`,
          [detail.customer ?? rows[0].customer, detail.ownerId ?? rows[0].ownerId, projectId, tenantId],
        );
        await appendMysqlProjectChanges(connection, [engagementChange({ action: 'update', actorId: user.id, detail, projectId, tenantId })]);
      });
      return getProjectDetail(pool, { projectId, tenantId });
    },
    closeEngagement({ projectId, tenantId, user }) {
      return transition({
        action: 'close',
        async apply(connection) {
          await connection.execute(
            `UPDATE projects SET engagement_status = 'lost', project_status = ?, closed_at = NOW(3), ${bumpUpdatedAt} WHERE id = ? AND tenant_id = ?`,
            [await getProjectStatusId(connection, LOST_PROJECT_STATUS), projectId, tenantId],
          );
        },
        projectId,
        tenantId,
        user,
      });
    },
    reopenEngagement({ projectId, tenantId, user }) {
      return transition({
        action: 'reopen',
        async apply(connection) {
          await connection.execute(
            `UPDATE projects SET engagement_status = 'open', project_status = ?, closed_at = NULL, ${bumpUpdatedAt} WHERE id = ? AND tenant_id = ?`,
            [await getProjectStatusId(connection, OPEN_PROJECT_STATUS), projectId, tenantId],
          );
        },
        projectId,
        tenantId,
        user,
      });
    },
  };
}
