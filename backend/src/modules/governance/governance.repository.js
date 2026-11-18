import { randomUUID } from 'node:crypto';

import { HttpError } from '../../lib/errors/http-error.js';

function clone(value) { return structuredClone(value); }
function nowIso() { return new Date().toISOString(); }

function requireVersion(record, expectedVersion) {
  if (record.version !== expectedVersion) {
    throw new HttpError(409, 'Governance record changed since it was loaded.', {
      details: { actualVersion: record.version, code: 'governance_version_conflict', expectedVersion },
    });
  }
}

function scoped(records, tenantId, projectId) {
  return [...records.values()].filter((record) => record.tenantId === tenantId && record.projectId === projectId);
}

// One dependency per pair of items and type (the MySQL table's unique key). Said as a conflict:
// as a database error it was a 500, which clients read as a write that may or may not have happened.
function dependencyExists(dependencyId = null) {
  return new HttpError(409, 'That dependency already exists.', { details: { code: 'dependency_exists', ...(dependencyId ? { dependencyId } : {}) } });
}

export function createInMemoryGovernanceRepository() {
  const items = new Map();
  const dependencies = new Map();
  const milestones = new Map();
  const workingCalendars = new Map();
  const scheduleBaselines = new Map();
  function create(records, input, tenantId, projectId) {
    const now = nowIso();
    const record = { ...clone(input), createdAt: now, id: randomUUID(), projectId, tenantId, updatedAt: now, version: 1 };
    records.set(record.id, record);
    return clone(record);
  }
  function update(records, recordId, patch, tenantId, projectId) {
    const record = records.get(recordId);
    if (!record || record.tenantId !== tenantId || record.projectId !== projectId) return null;
    requireVersion(record, patch.expectedVersion);
    const { expectedVersion: _expectedVersion, ...changes } = patch;
    Object.assign(record, clone(changes), { updatedAt: nowIso(), version: record.version + 1 });
    return clone(record);
  }
  function remove(records, recordId, expectedVersion, tenantId, projectId) {
    const record = records.get(recordId);
    if (!record || record.tenantId !== tenantId || record.projectId !== projectId) return false;
    requireVersion(record, expectedVersion);
    records.delete(recordId);
    return true;
  }
  function requireNewLink(input, tenantId, projectId, exceptId = null) {
    const clash = scoped(dependencies, tenantId, projectId).find((record) => record.id !== exceptId && record.predecessorId === input.predecessorId && record.successorId === input.successorId && record.dependencyType === input.dependencyType);
    if (clash) throw dependencyExists(clash.id);
  }
  return {
    async createScheduleBaseline({ createdBy, input, projectId, snapshot, tenantId }) {
      const now = nowIso();
      const record = { capturedAt: now, createdBy, id: randomUUID(), name: input.name, note: input.note, projectId, snapshot: clone(snapshot), tenantId, version: 1 };
      scheduleBaselines.set(record.id, record);
      return clone(record);
    },
    createDependency: async ({ input, projectId, tenantId }) => {
      requireNewLink(input, tenantId, projectId);
      return create(dependencies, input, tenantId, projectId);
    },
    createItem: async ({ input, projectId, tenantId }) => create(items, input, tenantId, projectId),
    createMilestone: async ({ input, projectId, tenantId }) => create(milestones, input, tenantId, projectId),
    deleteDependency: async ({ dependencyId, expectedVersion, projectId, tenantId }) => remove(dependencies, dependencyId, expectedVersion, tenantId, projectId),
    deleteItem: async ({ expectedVersion, itemId, projectId, tenantId }) => remove(items, itemId, expectedVersion, tenantId, projectId),
    deleteMilestone: async ({ expectedVersion, milestoneId, projectId, tenantId }) => remove(milestones, milestoneId, expectedVersion, tenantId, projectId),
    // latestBaselineOnly: Home needs only the newest baseline, not every snapshot.
    // Schedule dependencies where any of the items is either end (odin_get_item_details).
    listDependenciesForItems: async ({ itemIds, projectId, tenantId }) => {
      const wanted = new Set(itemIds);
      return clone(scoped(dependencies, tenantId, projectId).filter((record) => wanted.has(record.predecessorId) || wanted.has(record.successorId)));
    },
    listSnapshot: async ({ latestBaselineOnly = false, projectId, tenantId }) => ({
      dependencies: clone(scoped(dependencies, tenantId, projectId)),
      items: clone(scoped(items, tenantId, projectId)),
      milestones: clone(scoped(milestones, tenantId, projectId)),
      scheduleBaselines: clone(scoped(scheduleBaselines, tenantId, projectId).sort((left, right) => right.capturedAt.localeCompare(left.capturedAt)).slice(0, latestBaselineOnly ? 1 : undefined)),
      workingCalendar: clone(workingCalendars.get(`${tenantId}:${projectId}`) ?? null),
    }),
    async putWorkingCalendar({ input, projectId, tenantId }) {
      const key = `${tenantId}:${projectId}`;
      const current = workingCalendars.get(key) ?? null;
      if (current) requireVersion(current, input.expectedVersion);
      else if (input.expectedVersion != null) throw new HttpError(409, 'Governance record changed since it was loaded.', { details: { actualVersion: null, code: 'governance_version_conflict', expectedVersion: input.expectedVersion } });
      const { expectedVersion: _expectedVersion, ...value } = input;
      const now = nowIso();
      const record = { ...clone(value), createdAt: current?.createdAt ?? now, id: current?.id ?? randomUUID(), projectId, tenantId, updatedAt: now, version: (current?.version ?? 0) + 1 };
      workingCalendars.set(key, record);
      return clone(record);
    },
    updateDependency: async ({ dependencyId, input, projectId, tenantId }) => {
      const record = dependencies.get(dependencyId);
      if (record?.tenantId === tenantId && record.projectId === projectId) requireNewLink({ ...record, ...input }, tenantId, projectId, dependencyId);
      return update(dependencies, dependencyId, input, tenantId, projectId);
    },
    updateItem: async ({ input, itemId, projectId, tenantId }) => update(items, itemId, input, tenantId, projectId),
    updateMilestone: async ({ input, milestoneId, projectId, tenantId }) => update(milestones, milestoneId, input, tenantId, projectId),
  };
}

export async function ensureMysqlGovernanceSchema(executor) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS project_governance_items (id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, project_id VARCHAR(36) NOT NULL, item_kind VARCHAR(32) NOT NULL, title VARCHAR(240) NOT NULL, description TEXT NOT NULL, status VARCHAR(32) NOT NULL, owner_id VARCHAR(36) NULL, due_date DATE NULL, probability VARCHAR(16) NULL, impact VARCHAR(16) NOT NULL, response_plan TEXT NOT NULL, version INT NOT NULL DEFAULT 1, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, KEY idx_governance_items_project (tenant_id, project_id, item_kind, status))`,
    `CREATE TABLE IF NOT EXISTS project_dependencies (id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, project_id VARCHAR(36) NOT NULL, predecessor_id VARCHAR(128) NOT NULL, successor_id VARCHAR(128) NOT NULL, dependency_type CHAR(2) NOT NULL, lag_days INT NOT NULL DEFAULT 0, version INT NOT NULL DEFAULT 1, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, UNIQUE KEY uq_project_dependency (project_id, predecessor_id, successor_id, dependency_type), KEY idx_project_dependencies_successor (project_id, successor_id))`,
    `CREATE TABLE IF NOT EXISTS project_milestones (id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, project_id VARCHAR(36) NOT NULL, title VARCHAR(240) NOT NULL, target_date DATE NOT NULL, status VARCHAR(32) NOT NULL, work_item_id VARCHAR(128) NULL, version INT NOT NULL DEFAULT 1, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, KEY idx_project_milestones_date (tenant_id, project_id, target_date))`,
  ];
  for (const statement of statements) await executor.execute(statement);
}

export async function ensureMysqlScheduleControlSchema(executor) {
  await executor.execute(`CREATE TABLE IF NOT EXISTS project_working_calendars (
    id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, project_id VARCHAR(36) NOT NULL,
    timezone VARCHAR(80) NOT NULL, working_days_json JSON NOT NULL, hours_per_day DECIMAL(5,2) NOT NULL,
    holidays_json JSON NOT NULL, version INT NOT NULL DEFAULT 1, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_project_working_calendar (tenant_id, project_id)
  )`);
  await executor.execute(`CREATE TABLE IF NOT EXISTS project_schedule_baselines (
    id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, project_id VARCHAR(36) NOT NULL,
    baseline_name VARCHAR(160) NOT NULL, note TEXT NOT NULL, snapshot_json JSON NOT NULL,
    created_by VARCHAR(36) NOT NULL, version INT NOT NULL DEFAULT 1, captured_at DATETIME(3) NOT NULL,
    KEY idx_schedule_baselines_project (tenant_id, project_id, captured_at)
  )`);
}

function dateOnly(value) { return value ? new Date(value).toISOString().slice(0, 10) : null; }
function mapItem(row) {
  return { createdAt: new Date(row.created_at).toISOString(), description: row.description, dueDate: dateOnly(row.due_date), id: row.id, impact: row.impact, kind: row.item_kind, ownerId: row.owner_id, probability: row.probability, projectId: row.project_id, responsePlan: row.response_plan, status: row.status, tenantId: row.tenant_id, title: row.title, updatedAt: new Date(row.updated_at).toISOString(), version: Number(row.version) };
}
function mapDependency(row) {
  return { createdAt: new Date(row.created_at).toISOString(), dependencyType: row.dependency_type, id: row.id, lagDays: Number(row.lag_days), predecessorId: row.predecessor_id, projectId: row.project_id, successorId: row.successor_id, tenantId: row.tenant_id, updatedAt: new Date(row.updated_at).toISOString(), version: Number(row.version) };
}
function mapMilestone(row) {
  return { createdAt: new Date(row.created_at).toISOString(), id: row.id, projectId: row.project_id, status: row.status, targetDate: dateOnly(row.target_date), tenantId: row.tenant_id, title: row.title, updatedAt: new Date(row.updated_at).toISOString(), version: Number(row.version), workItemId: row.work_item_id };
}
function duplicateLink(error) {
  throw error?.code === 'ER_DUP_ENTRY' ? dependencyExists() : error;
}
function jsonValue(value, fallback) { if (value == null) return fallback; if (typeof value === 'object') return value; try { return JSON.parse(value); } catch { return fallback; } }
function mapWorkingCalendar(row) {
  return row ? { createdAt: new Date(row.created_at).toISOString(), holidays: jsonValue(row.holidays_json, []), hoursPerDay: Number(row.hours_per_day), id: row.id, projectId: row.project_id, tenantId: row.tenant_id, timezone: row.timezone, updatedAt: new Date(row.updated_at).toISOString(), version: Number(row.version), workingDays: jsonValue(row.working_days_json, []) } : null;
}
function mapScheduleBaseline(row) {
  return { capturedAt: new Date(row.captured_at).toISOString(), createdBy: row.created_by, id: row.id, name: row.baseline_name, note: row.note, projectId: row.project_id, snapshot: jsonValue(row.snapshot_json, {}), tenantId: row.tenant_id, version: Number(row.version) };
}

export function createMysqlGovernanceRepository({ pool }) {
  function buildRepository(executor, { transactions = true } = {}) {
  async function create(table, columns, values, mapper) {
    const id = randomUUID(); const now = new Date();
    await executor.execute(`INSERT INTO ${table} (id, ${columns.join(', ')}, version, created_at, updated_at) VALUES (?, ${columns.map(() => '?').join(', ')}, 1, ?, ?)`, [id, ...values, now, now]);
    const [rows] = await executor.execute(`SELECT * FROM ${table} WHERE id = ?`, [id]);
    return mapper(rows[0]);
  }
  async function remove(table, id, expectedVersion, tenantId, projectId) {
    const [result] = await executor.execute(`DELETE FROM ${table} WHERE id = ? AND tenant_id = ? AND project_id = ? AND version = ?`, [id, tenantId, projectId, expectedVersion]);
    if (Number(result.affectedRows) === 1) return true;
    const [rows] = await executor.execute(`SELECT version FROM ${table} WHERE id = ? AND tenant_id = ? AND project_id = ?`, [id, tenantId, projectId]);
    if (!rows[0]) return false;
    throw new HttpError(409, 'Governance record changed since it was loaded.', { details: { actualVersion: Number(rows[0].version), code: 'governance_version_conflict', expectedVersion } });
  }
  async function current(table, id, tenantId, projectId, mapper) {
    const [rows] = await executor.execute(`SELECT * FROM ${table} WHERE id = ? AND tenant_id = ? AND project_id = ? LIMIT 1`, [id, tenantId, projectId]);
    return mapper(rows[0]);
  }
  async function throwUpdateConflict(table, id, expectedVersion, tenantId, projectId) {
    const [rows] = await executor.execute(`SELECT version FROM ${table} WHERE id = ? AND tenant_id = ? AND project_id = ?`, [id, tenantId, projectId]);
    if (!rows[0]) return null;
    throw new HttpError(409, 'Governance record changed since it was loaded.', { details: { actualVersion: Number(rows[0].version), code: 'governance_version_conflict', expectedVersion } });
  }
  async function updateItem({ input, itemId, projectId, tenantId }) {
    const existing = await current('project_governance_items', itemId, tenantId, projectId, mapItem);
    if (!existing) return null;
    const next = { ...existing, ...input };
    const [result] = await executor.execute(`UPDATE project_governance_items SET item_kind = ?, title = ?, description = ?, status = ?, owner_id = ?, due_date = ?, probability = ?, impact = ?, response_plan = ?, version = version + 1, updated_at = NOW(3) WHERE id = ? AND tenant_id = ? AND project_id = ? AND version = ?`, [next.kind, next.title, next.description, next.status, next.ownerId, next.dueDate, next.probability, next.impact, next.responsePlan, itemId, tenantId, projectId, input.expectedVersion]);
    if (Number(result.affectedRows) !== 1) return throwUpdateConflict('project_governance_items', itemId, input.expectedVersion, tenantId, projectId);
    return current('project_governance_items', itemId, tenantId, projectId, mapItem);
  }
  async function updateDependency({ dependencyId, input, projectId, tenantId }) {
    const existing = await current('project_dependencies', dependencyId, tenantId, projectId, mapDependency);
    if (!existing) return null;
    const next = { ...existing, ...input };
    const [result] = await executor.execute(`UPDATE project_dependencies SET predecessor_id = ?, successor_id = ?, dependency_type = ?, lag_days = ?, version = version + 1, updated_at = NOW(3) WHERE id = ? AND tenant_id = ? AND project_id = ? AND version = ?`, [next.predecessorId, next.successorId, next.dependencyType, next.lagDays, dependencyId, tenantId, projectId, input.expectedVersion]).catch(duplicateLink);
    if (Number(result.affectedRows) !== 1) return throwUpdateConflict('project_dependencies', dependencyId, input.expectedVersion, tenantId, projectId);
    return current('project_dependencies', dependencyId, tenantId, projectId, mapDependency);
  }
  async function updateMilestone({ input, milestoneId, projectId, tenantId }) {
    const existing = await current('project_milestones', milestoneId, tenantId, projectId, mapMilestone);
    if (!existing) return null;
    const next = { ...existing, ...input };
    const [result] = await executor.execute(`UPDATE project_milestones SET title = ?, target_date = ?, status = ?, work_item_id = ?, version = version + 1, updated_at = NOW(3) WHERE id = ? AND tenant_id = ? AND project_id = ? AND version = ?`, [next.title, next.targetDate, next.status, next.workItemId, milestoneId, tenantId, projectId, input.expectedVersion]);
    if (Number(result.affectedRows) !== 1) return throwUpdateConflict('project_milestones', milestoneId, input.expectedVersion, tenantId, projectId);
    return current('project_milestones', milestoneId, tenantId, projectId, mapMilestone);
  }
  return {
    async createScheduleBaseline({ createdBy, input, projectId, snapshot, tenantId }) {
      const id = randomUUID();
      await executor.execute('INSERT INTO project_schedule_baselines (id, tenant_id, project_id, baseline_name, note, snapshot_json, created_by, version, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, NOW(3))', [id, tenantId, projectId, input.name, input.note, JSON.stringify(snapshot), createdBy]);
      const [rows] = await executor.execute('SELECT * FROM project_schedule_baselines WHERE id = ?', [id]);
      return mapScheduleBaseline(rows[0]);
    },
    createDependency: ({ input, projectId, tenantId }) => create('project_dependencies', ['tenant_id', 'project_id', 'predecessor_id', 'successor_id', 'dependency_type', 'lag_days'], [tenantId, projectId, input.predecessorId, input.successorId, input.dependencyType, input.lagDays], mapDependency).catch(duplicateLink),
    createItem: ({ input, projectId, tenantId }) => create('project_governance_items', ['tenant_id', 'project_id', 'item_kind', 'title', 'description', 'status', 'owner_id', 'due_date', 'probability', 'impact', 'response_plan'], [tenantId, projectId, input.kind, input.title, input.description, input.status, input.ownerId, input.dueDate, input.probability, input.impact, input.responsePlan], mapItem),
    createMilestone: ({ input, projectId, tenantId }) => create('project_milestones', ['tenant_id', 'project_id', 'title', 'target_date', 'status', 'work_item_id'], [tenantId, projectId, input.title, input.targetDate, input.status, input.workItemId], mapMilestone),
    deleteDependency: ({ dependencyId, expectedVersion, projectId, tenantId }) => remove('project_dependencies', dependencyId, expectedVersion, tenantId, projectId),
    deleteItem: ({ expectedVersion, itemId, projectId, tenantId }) => remove('project_governance_items', itemId, expectedVersion, tenantId, projectId),
    deleteMilestone: ({ expectedVersion, milestoneId, projectId, tenantId }) => remove('project_milestones', milestoneId, expectedVersion, tenantId, projectId),
    // Schedule dependencies where any of the items is either end (odin_get_item_details).
    async listDependenciesForItems({ itemIds, projectId, tenantId }) {
      if (!itemIds.length) return [];
      const [rows] = await executor.query('SELECT * FROM project_dependencies WHERE tenant_id = ? AND project_id = ? AND (predecessor_id IN (?) OR successor_id IN (?)) ORDER BY created_at, id', [tenantId, projectId, itemIds, itemIds]);
      return rows.map(mapDependency);
    },
    async listSnapshot({ latestBaselineOnly = false, projectId, tenantId }) {
      const [itemRows] = await executor.execute('SELECT * FROM project_governance_items WHERE tenant_id = ? AND project_id = ? ORDER BY created_at, id', [tenantId, projectId]);
      const [dependencyRows] = await executor.execute('SELECT * FROM project_dependencies WHERE tenant_id = ? AND project_id = ? ORDER BY created_at, id', [tenantId, projectId]);
      const [milestoneRows] = await executor.execute('SELECT * FROM project_milestones WHERE tenant_id = ? AND project_id = ? ORDER BY target_date, id', [tenantId, projectId]);
      const [calendarRows] = await executor.execute('SELECT * FROM project_working_calendars WHERE tenant_id = ? AND project_id = ? LIMIT 1', [tenantId, projectId]);
      const [baselineRows] = await executor.execute(`SELECT * FROM project_schedule_baselines WHERE tenant_id = ? AND project_id = ? ORDER BY captured_at DESC, id DESC${latestBaselineOnly ? ' LIMIT 1' : ''}`, [tenantId, projectId]);
      return { dependencies: dependencyRows.map(mapDependency), items: itemRows.map(mapItem), milestones: milestoneRows.map(mapMilestone), scheduleBaselines: baselineRows.map(mapScheduleBaseline), workingCalendar: mapWorkingCalendar(calendarRows[0]) };
    },
    async putWorkingCalendar({ input, projectId, tenantId }) {
      const [rows] = await executor.execute('SELECT * FROM project_working_calendars WHERE tenant_id = ? AND project_id = ? LIMIT 1', [tenantId, projectId]);
      if (!rows[0]) {
        if (input.expectedVersion != null) throw new HttpError(409, 'Governance record changed since it was loaded.', { details: { actualVersion: null, code: 'governance_version_conflict', expectedVersion: input.expectedVersion } });
        const id = randomUUID();
        await executor.execute('INSERT INTO project_working_calendars (id, tenant_id, project_id, timezone, working_days_json, hours_per_day, holidays_json, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, NOW(3), NOW(3))', [id, tenantId, projectId, input.timezone, JSON.stringify(input.workingDays), input.hoursPerDay, JSON.stringify(input.holidays)]);
        const [created] = await executor.execute('SELECT * FROM project_working_calendars WHERE id = ?', [id]);
        return mapWorkingCalendar(created[0]);
      }
      const current = mapWorkingCalendar(rows[0]); requireVersion(current, input.expectedVersion);
      const [result] = await executor.execute('UPDATE project_working_calendars SET timezone = ?, working_days_json = ?, hours_per_day = ?, holidays_json = ?, version = version + 1, updated_at = NOW(3) WHERE id = ? AND version = ?', [input.timezone, JSON.stringify(input.workingDays), input.hoursPerDay, JSON.stringify(input.holidays), current.id, input.expectedVersion]);
      if (Number(result.affectedRows) !== 1) return throwUpdateConflict('project_working_calendars', current.id, input.expectedVersion, tenantId, projectId);
      const [updated] = await executor.execute('SELECT * FROM project_working_calendars WHERE id = ?', [current.id]);
      return mapWorkingCalendar(updated[0]);
    },
    async transaction(run) {
      if (!transactions) return run(this, executor);
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const value = await run(buildRepository(connection, { transactions: false }), connection);
        await connection.commit();
        return value;
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },
    updateDependency,
    updateItem,
    updateMilestone,
  };
  }
  return buildRepository(pool);
}
