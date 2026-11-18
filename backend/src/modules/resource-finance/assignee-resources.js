import { randomUUID } from 'node:crypto';

// Everyone who owns work on a project is a resource on it. Giving a user work makes sure they
// have a resource profile (linked to their login) and an allocation on that project, so the
// project's Resources tab, capacity and rates all see them. People without a login own work as
// `resource:<id>`; a resource linked to a user owns work as that user.

export const RESOURCE_ASSIGNEE_PREFIX = 'resource:';

export function resourceAssigneeId(resourceId) {
  return `${RESOURCE_ASSIGNEE_PREFIX}${resourceId}`;
}

/** The resource id inside a `resource:<id>` assignee, or null for a user id or nothing. */
export function resourceIdFromAssignee(assigneeId) {
  const value = String(assigneeId ?? '').trim();
  return value.startsWith(RESOURCE_ASSIGNEE_PREFIX) ? value.slice(RESOURCE_ASSIGNEE_PREFIX.length) || null : null;
}

function nameParts(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Whether a resource name and a user name are the same person: identical, or the same surname
 * with one first name a short form of the other ("Matt Bradford" and "Matthew Bradford").
 */
export function namesMatch(left, right) {
  const a = nameParts(left);
  const b = nameParts(right);
  if (!a.length || !b.length) return false;
  if (a.join(' ') === b.join(' ')) return true;
  if (a.length < 2 || b.length < 2 || a.at(-1) !== b.at(-1)) return false;
  const [first, second] = [a[0], b[0]];
  return Math.min(first.length, second.length) >= 3 && (first.startsWith(second) || second.startsWith(first));
}

/** The one unlinked, active resource whose name matches the user's, or null when none or several do. */
export function matchUnlinkedResource(resources, user) {
  const candidates = resources.filter((resource) => !resource.userId && resource.status !== 'inactive' && namesMatch(resource.name, user?.name));
  return candidates.length === 1 ? candidates[0] : null;
}

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** The project's dates when it has them; otherwise from today for a year. */
export function assignmentAllocationWindow(project, today) {
  const startDate = project?.startDate || today;
  const endDate = project?.endDate && project.endDate >= startDate ? project.endDate : addDays(startDate, 365);
  return { endDate, startDate };
}

export function assignmentResourceInput(user) {
  return {
    billRate: 0, capacityHoursPerWeek: 40, costRate: 0, currency: 'USD', location: '', minBillRate: null,
    name: String(user.name || user.email || 'Team member').slice(0, 240), poolId: null, roles: [], skills: [], status: 'active', userId: user.id,
  };
}

export function assignmentAllocationInput({ project, resourceId, today }) {
  return {
    allocationPercent: 0, billRate: null, hoursPerWeek: 0, origin: 'assignment', projectId: project.id, resourceId,
    role: '', scenario: 'baseline', status: 'active', ...assignmentAllocationWindow(project, today),
  };
}

/**
 * Gives each user in `assignments` ({ projectId, userId }) a resource profile and an allocation on
 * the project when they lack one. An unlinked resource with the user's name is linked rather than
 * duplicated. Resource ids, empty ids and people outside the tenant are skipped.
 *
 * `store` reads and writes one tenant: getProject, getUser, listResources, hasAllocation,
 * createResource, linkResource, createAllocation.
 */
export async function ensureAssigneeResources(store, { assignments, today = new Date().toISOString().slice(0, 10) }) {
  const result = { createdAllocations: [], createdResources: [], linkedResources: [] };
  const pairs = new Map();
  for (const { projectId, userId } of assignments ?? []) {
    const id = String(userId ?? '').trim();
    if (!projectId || !id || resourceIdFromAssignee(id)) continue;
    pairs.set(`${projectId}\u0000${id}`, { projectId, userId: id });
  }
  if (!pairs.size) return result;

  const resources = [...await store.listResources()];
  const projects = new Map();
  const users = new Map();
  for (const { projectId, userId } of pairs.values()) {
    if (!projects.has(projectId)) projects.set(projectId, await store.getProject(projectId));
    const project = projects.get(projectId);
    if (!project) continue;
    if (!users.has(userId)) users.set(userId, await store.getUser(userId));
    const user = users.get(userId);
    if (!user) continue;

    let resource = resources.find((entry) => entry.userId === userId);
    if (!resource) {
      const match = matchUnlinkedResource(resources, user);
      if (match) {
        resource = await store.linkResource(match, userId);
        resources.splice(resources.indexOf(match), 1, resource);
        result.linkedResources.push(resource);
      } else {
        resource = await store.createResource(assignmentResourceInput(user));
        resources.push(resource);
        result.createdResources.push(resource);
      }
    }
    if (await store.hasAllocation(resource.id, projectId)) continue;
    result.createdAllocations.push(await store.createAllocation(assignmentAllocationInput({ project, resourceId: resource.id, today })));
  }
  return result;
}

function dateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return new Date(value).toISOString().slice(0, 10);
}

/** A store over the MySQL tables, usable inside a transaction (it runs no DDL). */
export function createMysqlAssigneeResourceStore(executor, tenantId) {
  return {
    async createAllocation(input) {
      const id = randomUUID();
      const now = new Date();
      await executor.execute(
        `INSERT INTO resource_allocations (id, tenant_id, project_id, resource_id, start_date, end_date, allocation_percent, hours_per_week, bill_rate, role_name, scenario, status, origin, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [id, tenantId, input.projectId, input.resourceId, input.startDate, input.endDate, input.allocationPercent, input.hoursPerWeek, input.billRate, input.role, input.scenario, input.status, input.origin, now, now],
      );
      return { ...input, id };
    },
    async createResource(input) {
      const id = randomUUID();
      const now = new Date();
      await executor.execute(
        `INSERT INTO enterprise_resources (id, tenant_id, user_id, pool_id, name, location, roles_json, skills_json, capacity_hours_per_week, cost_rate, bill_rate, min_bill_rate, currency, status, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [id, tenantId, input.userId, input.poolId, input.name, input.location, JSON.stringify(input.roles), JSON.stringify(input.skills), input.capacityHoursPerWeek, input.costRate, input.billRate, input.minBillRate, input.currency, input.status, now, now],
      );
      return { id, name: input.name, status: input.status, userId: input.userId };
    },
    async getProject(projectId) {
      const [rows] = await executor.execute('SELECT id, start_date, end_date FROM projects WHERE id = ? AND tenant_id = ? LIMIT 1', [projectId, tenantId]);
      return rows[0] ? { endDate: dateOnly(rows[0].end_date), id: rows[0].id, startDate: dateOnly(rows[0].start_date) } : null;
    },
    async getUser(userId) {
      const [rows] = await executor.execute(
        'SELECT u.id, u.name, u.email FROM users u JOIN user_tenant ut ON ut.user_id = u.id AND ut.tenant_id = ? WHERE u.id = ? LIMIT 1',
        [tenantId, userId],
      );
      return rows[0] ? { email: rows[0].email, id: rows[0].id, name: rows[0].name } : null;
    },
    async hasAllocation(resourceId, projectId) {
      const [rows] = await executor.execute(
        "SELECT id FROM resource_allocations WHERE tenant_id = ? AND resource_id = ? AND project_id = ? AND status <> 'completed' LIMIT 1",
        [tenantId, resourceId, projectId],
      );
      return rows.length > 0;
    },
    async linkResource(resource, userId) {
      await executor.execute(
        'UPDATE enterprise_resources SET user_id = ?, version = version + 1, updated_at = NOW(3) WHERE id = ? AND tenant_id = ? AND user_id IS NULL',
        [userId, resource.id, tenantId],
      );
      return { ...resource, userId };
    },
    async listResources() {
      const [rows] = await executor.execute('SELECT id, user_id, name, status FROM enterprise_resources WHERE tenant_id = ? ORDER BY created_at, id', [tenantId]);
      return rows.map((row) => ({ id: row.id, name: row.name, status: row.status, userId: row.user_id ?? null }));
    },
  };
}

const MISSING_SCHEMA = new Set(['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR']);

/**
 * The hook project saves call: the users who own work in `projectId` get a resource profile and
 * an allocation there. Never fails the save; a database without the resource tables yet is a no-op.
 */
export async function ensureMysqlAssigneeResources(executor, { projectId, tenantId = null, userIds, logger = console }) {
  const ids = [...new Set((userIds ?? []).map((id) => String(id ?? '').trim()).filter((id) => id && !resourceIdFromAssignee(id)))];
  if (!projectId || !ids.length) return null;
  try {
    let tenant = tenantId;
    if (!tenant) {
      const [rows] = await executor.execute('SELECT tenant_id FROM projects WHERE id = ? LIMIT 1', [projectId]);
      tenant = rows[0]?.tenant_id ?? null;
    }
    if (!tenant) return null;
    return await ensureAssigneeResources(createMysqlAssigneeResourceStore(executor, tenant), {
      assignments: ids.map((userId) => ({ projectId, userId })),
    });
  } catch (error) {
    if (!MISSING_SCHEMA.has(error?.code)) logger?.warn?.('[resources] Could not add resource allocations for assignees', { error: error?.message, projectId });
    return null;
  }
}

/** Every assignee id in a project tree (epics → stories → tasks). */
export function treeAssigneeIds(epics) {
  const ids = new Set();
  const walk = (nodes) => {
    for (const node of nodes ?? []) {
      if (node?.assigneeId) ids.add(String(node.assigneeId));
      walk(node?.stories);
      walk(node?.tasks);
    }
  };
  walk(epics);
  return [...ids];
}
