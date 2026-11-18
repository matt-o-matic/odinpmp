import { randomUUID } from 'node:crypto';

import { HttpError } from '../../../lib/errors/http-error.js';
import { isActiveDecision } from './plan-content.js';

// Track plan storage. Plan versions live in the requirements_plans table from migration
// 0056, so the requirements overview reads them with no extra wiring. Migration 0062 below
// adds what 0056 lacks: the plan's structure, an internal audit record, the approver's
// name, the version an edit started from, and the proposed-work table that links a plan to
// the AI Workspace session holding its proposals.
//
// The audit record (provider, model, dropped citations) is internal. Nothing that presents
// a plan returns it.
//
// 0062 is registered in src/jobs/bootstrap-schema.lib.js. The migration runner checksums its
// body: never edit it; add a new migration instead.

async function tableExists(executor, tableName) {
  const [rows] = await executor.execute(
    'SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1',
    [tableName],
  );
  return Number(rows[0]?.count ?? 0) > 0;
}

async function columnExists(executor, tableName, columnName) {
  const [rows] = await executor.execute(
    'SELECT COUNT(*) AS count FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1',
    [tableName, columnName],
  );
  return Number(rows[0]?.count ?? 0) > 0;
}

// 0062_requirements_plan_details
export async function ensureMysqlRequirementsPlanDetailsSchema(executor) {
  const planColumns = [
    ['content_json', 'JSON NULL'],
    ['audit_json', 'JSON NULL'],
    ['approved_by_name', 'VARCHAR(255) NULL'],
    ['based_on_id', 'VARCHAR(36) NULL'],
    ['updated_by', 'VARCHAR(80) NULL'],
    ['superseded_at', 'DATETIME(3) NULL'],
  ];
  for (const [columnName, definition] of planColumns) {
    if (!await columnExists(executor, 'requirements_plans', columnName)) {
      await executor.execute(`ALTER TABLE requirements_plans ADD COLUMN ${columnName} ${definition}`);
    }
  }

  if (!await tableExists(executor, 'requirements_plan_proposals')) {
    await executor.execute(`
      CREATE TABLE requirements_plan_proposals (
        id VARCHAR(36) NOT NULL PRIMARY KEY,
        tenant_id VARCHAR(36) NOT NULL,
        project_id VARCHAR(36) NOT NULL,
        plan_id VARCHAR(36) NOT NULL,
        track VARCHAR(16) NOT NULL,
        proposed_by VARCHAR(80) NOT NULL,
        proposed_by_name VARCHAR(255) NOT NULL DEFAULT '',
        session_id VARCHAR(36) NOT NULL,
        items_json JSON NOT NULL,
        audit_json JSON NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY uq_requirements_plan_proposals_owner (tenant_id, plan_id, proposed_by),
        KEY idx_requirements_plan_proposals_project (tenant_id, project_id, plan_id)
      )
    `);
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeString(value) {
  return String(value ?? '').trim();
}

function nullableString(value) {
  return normalizeString(value) || null;
}

function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

export function planConflict(code, message, details = {}) {
  return new HttpError(409, code, { details: { code, message, ...details } });
}

function emptyContent() {
  return { nonGoals: [], objective: '', scope: [] };
}

function normalizePlanRecord(record) {
  const content = record.content && typeof record.content === 'object' ? record.content : emptyContent();
  return {
    approvedAt: toIso(record.approvedAt),
    approvedBy: nullableString(record.approvedBy),
    approvedByName: normalizeString(record.approvedByName),
    audit: record.audit && typeof record.audit === 'object' ? clone(record.audit) : {},
    basedOnId: nullableString(record.basedOnId),
    body: String(record.body ?? ''),
    content: {
      nonGoals: Array.isArray(content.nonGoals) ? clone(content.nonGoals) : [],
      objective: normalizeString(content.objective),
      scope: Array.isArray(content.scope) ? clone(content.scope) : [],
    },
    createdAt: toIso(record.createdAt),
    createdBy: normalizeString(record.createdBy),
    criteria: Array.isArray(record.criteria) ? clone(record.criteria) : [],
    id: record.id,
    projectId: record.projectId,
    revision: Number(record.revision ?? 1),
    status: record.status ?? 'draft',
    supersededAt: toIso(record.supersededAt),
    tenantId: record.tenantId,
    track: record.track,
    updatedAt: toIso(record.updatedAt),
    updatedBy: nullableString(record.updatedBy),
    version: Number(record.version ?? 1),
  };
}

function normalizeProposalRecord(record) {
  return {
    audit: record.audit && typeof record.audit === 'object' ? clone(record.audit) : {},
    createdAt: toIso(record.createdAt),
    id: record.id,
    items: Array.isArray(record.items) ? clone(record.items) : [],
    planId: record.planId,
    projectId: record.projectId,
    proposedBy: normalizeString(record.proposedBy),
    proposedByName: normalizeString(record.proposedByName),
    sessionId: normalizeString(record.sessionId),
    tenantId: record.tenantId,
    track: record.track,
    updatedAt: toIso(record.updatedAt),
  };
}

function byVersionDesc(left, right) {
  return right.version - left.version;
}

export function revisionConflict(current) {
  return planConflict('plan_revision_conflict', 'This plan changed since you loaded it. Reload and try again.', {
    currentRevision: current.revision,
  });
}

export function staleCitationsConflict(staleDecisionIds) {
  return planConflict('plan_cites_superseded_decisions', 'The plan cites decisions that were superseded. Update those citations before approving.', {
    staleDecisionIds,
  });
}

/** The cited ids that do not name an active decision among `decisions`. */
export function staleCitations(citedDecisionIds, decisions) {
  const byId = new Map(decisions.map((decision) => [decision.id, decision]));
  return citedDecisionIds.filter((id) => !isActiveDecision(byId.get(id)));
}

function notLatestConflict(latest) {
  return planConflict('plan_not_latest', 'A newer version of this plan exists. Open the latest version instead.', {
    latestPlanId: latest?.id ?? null,
    latestVersion: latest?.version ?? null,
  });
}

function notDraftConflict(current) {
  return current.status === 'approved'
    ? planConflict('plan_already_approved', 'This plan version is already approved.')
    : planConflict('plan_superseded', 'This plan version was superseded by a newer approved version.');
}

// ---------------------------------------------------------------------------
// In-memory implementation (tests and local tooling). Plan rows share the requirements
// repository's state when there is one, so the overview sees them.
// ---------------------------------------------------------------------------

export function createInMemoryPlansRepository({ requirementsRepository = null } = {}) {
  const plans = requirementsRepository?.state?.plans ?? [];
  const proposals = [];

  function scoped(list, { projectId, tenantId }) {
    return list.filter((item) => item.projectId === projectId && item.tenantId === tenantId);
  }

  function find({ planId, projectId, tenantId }) {
    return scoped(plans, { projectId, tenantId }).find((plan) => plan.id === planId) ?? null;
  }

  function latestOf({ projectId, tenantId, track }) {
    return scoped(plans, { projectId, tenantId }).filter((plan) => plan.track === track).sort(byVersionDesc)[0] ?? null;
  }

  return {
    async listTrackPlans({ projectId, tenantId, track = '' }) {
      return scoped(plans, { projectId, tenantId })
        .filter((plan) => !track || plan.track === track)
        .map(normalizePlanRecord)
        .sort(byVersionDesc);
    },

    async getPlan({ planId, projectId, tenantId }) {
      const record = find({ planId, projectId, tenantId });
      return record ? normalizePlanRecord(record) : null;
    },

    async insertPlanVersion({ expectedLatestVersion = undefined, plan, projectId, tenantId }) {
      const latest = latestOf({ projectId, tenantId, track: plan.track });
      if (expectedLatestVersion !== undefined && (latest?.version ?? 0) !== expectedLatestVersion) {
        throw notLatestConflict(latest);
      }
      const now = toIso(plan.createdAt) ?? new Date().toISOString();
      const record = {
        approvedAt: null,
        approvedBy: null,
        approvedByName: '',
        audit: clone(plan.audit ?? {}),
        basedOnId: nullableString(plan.basedOnId),
        body: String(plan.body ?? ''),
        content: clone(plan.content ?? emptyContent()),
        createdAt: now,
        createdBy: plan.createdBy,
        criteria: clone(plan.criteria ?? []),
        id: plan.id ?? randomUUID(),
        projectId,
        revision: 1,
        status: 'draft',
        supersededAt: null,
        tenantId,
        track: plan.track,
        updatedAt: now,
        updatedBy: nullableString(plan.createdBy),
        version: (latest?.version ?? 0) + 1,
      };
      plans.push(record);
      return normalizePlanRecord(record);
    },

    async updateDraft({ expectedRevision, now, patch, planId, projectId, tenantId, updatedBy }) {
      const record = find({ planId, projectId, tenantId });
      if (!record) return null;
      if (record.status !== 'draft') throw notDraftConflict(record);
      if (Number(record.revision) !== Number(expectedRevision)) throw revisionConflict(record);
      const latest = latestOf({ projectId, tenantId, track: record.track });
      if (latest && latest.id !== record.id) throw notLatestConflict(latest);
      record.body = String(patch.body ?? record.body);
      record.content = clone(patch.content ?? record.content);
      record.criteria = clone(patch.criteria ?? record.criteria);
      record.revision = Number(record.revision) + 1;
      record.updatedBy = updatedBy;
      record.updatedAt = toIso(now) ?? new Date().toISOString();
      return normalizePlanRecord(record);
    },

    async approvePlan({ approvedBy, approvedByName, citedDecisionIds = [], expectedRevision, now, planId, projectId, tenantId }) {
      const record = find({ planId, projectId, tenantId });
      if (!record) return null;
      if (record.status !== 'draft') throw notDraftConflict(record);
      if (Number(record.revision) !== Number(expectedRevision)) throw revisionConflict(record);
      const latest = latestOf({ projectId, tenantId, track: record.track });
      if (latest && latest.id !== record.id) throw notLatestConflict(latest);
      const stale = staleCitations(citedDecisionIds, scoped(requirementsRepository?.state?.decisions ?? [], { projectId, tenantId }));
      if (stale.length > 0) throw staleCitationsConflict(stale);
      const at = toIso(now) ?? new Date().toISOString();
      const superseded = [];
      for (const other of scoped(plans, { projectId, tenantId })) {
        if (other.id === record.id || other.track !== record.track) continue;
        if (other.status === 'approved' || (other.status === 'draft' && other.version < record.version)) {
          other.status = 'superseded';
          other.supersededAt = at;
          other.revision = Number(other.revision) + 1;
          other.updatedAt = at;
          superseded.push(other.id);
        }
      }
      record.status = 'approved';
      record.approvedAt = at;
      record.approvedBy = approvedBy;
      record.approvedByName = normalizeString(approvedByName);
      record.revision = Number(record.revision) + 1;
      record.updatedAt = at;
      record.updatedBy = approvedBy;
      return { plan: normalizePlanRecord(record), superseded };
    },

    async listProposals({ planId = '', projectId, tenantId }) {
      return scoped(proposals, { projectId, tenantId })
        .filter((proposal) => !planId || proposal.planId === planId)
        .map(normalizeProposalRecord)
        .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
    },

    async getProposal({ planId, projectId, proposedBy, tenantId }) {
      const record = scoped(proposals, { projectId, tenantId }).find((proposal) => proposal.planId === planId && proposal.proposedBy === proposedBy);
      return record ? normalizeProposalRecord(record) : null;
    },

    async saveProposal({ now, projectId, proposal, tenantId }) {
      const at = toIso(now) ?? new Date().toISOString();
      const existing = scoped(proposals, { projectId, tenantId })
        .find((entry) => entry.planId === proposal.planId && entry.proposedBy === proposal.proposedBy);
      if (existing) {
        Object.assign(existing, {
          audit: clone(proposal.audit ?? {}),
          items: clone(proposal.items ?? []),
          proposedByName: normalizeString(proposal.proposedByName),
          sessionId: proposal.sessionId,
          updatedAt: at,
        });
        return normalizeProposalRecord(existing);
      }
      const record = {
        audit: clone(proposal.audit ?? {}),
        createdAt: at,
        id: randomUUID(),
        items: clone(proposal.items ?? []),
        planId: proposal.planId,
        projectId,
        proposedBy: proposal.proposedBy,
        proposedByName: normalizeString(proposal.proposedByName),
        sessionId: proposal.sessionId,
        tenantId,
        track: proposal.track,
        updatedAt: at,
      };
      proposals.push(record);
      return normalizeProposalRecord(record);
    },
  };
}

// ---------------------------------------------------------------------------
// MySQL implementation
// ---------------------------------------------------------------------------

// Timestamps are written with FROM_UNIXTIME and read with UNIX_TIMESTAMP, as the
// requirements repository does, so they share the session time zone.
function unixSeconds(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = value instanceof Date ? value.valueOf() : Date.parse(value);
  return Number.isNaN(ms) ? null : ms / 1000;
}

function fromUnix(value) {
  if (value === null || value === undefined || value === '') return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? new Date(Math.round(seconds * 1000)).toISOString() : null;
}

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

const PLAN_COLUMNS = `
  id,
  tenant_id AS tenantId,
  project_id AS projectId,
  track,
  version,
  body_markdown AS body,
  criteria_json AS criteriaJson,
  content_json AS contentJson,
  audit_json AS auditJson,
  status,
  created_by AS createdBy,
  updated_by AS updatedBy,
  approved_by AS approvedBy,
  approved_by_name AS approvedByName,
  UNIX_TIMESTAMP(approved_at) AS approvedAt,
  UNIX_TIMESTAMP(superseded_at) AS supersededAt,
  based_on_id AS basedOnId,
  row_version AS revision,
  UNIX_TIMESTAMP(created_at) AS createdAt,
  UNIX_TIMESTAMP(updated_at) AS updatedAt
`;

function mapPlanRow(row) {
  return normalizePlanRecord({
    ...row,
    approvedAt: fromUnix(row.approvedAt),
    audit: parseJson(row.auditJson, {}),
    content: parseJson(row.contentJson, null),
    createdAt: fromUnix(row.createdAt),
    criteria: parseJson(row.criteriaJson, []),
    supersededAt: fromUnix(row.supersededAt),
    updatedAt: fromUnix(row.updatedAt),
  });
}

const PROPOSAL_COLUMNS = `
  id,
  tenant_id AS tenantId,
  project_id AS projectId,
  plan_id AS planId,
  track,
  proposed_by AS proposedBy,
  proposed_by_name AS proposedByName,
  session_id AS sessionId,
  items_json AS itemsJson,
  audit_json AS auditJson,
  UNIX_TIMESTAMP(created_at) AS createdAt,
  UNIX_TIMESTAMP(updated_at) AS updatedAt
`;

function mapProposalRow(row) {
  return normalizeProposalRecord({
    ...row,
    audit: parseJson(row.auditJson, {}),
    createdAt: fromUnix(row.createdAt),
    items: parseJson(row.itemsJson, []),
    updatedAt: fromUnix(row.updatedAt),
  });
}

async function withTransaction(pool, handler) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await handler(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

export function createMysqlPlansRepository({ pool }) {
  async function selectPlan(executor, { forUpdate = false, planId, projectId, tenantId }) {
    const [rows] = await executor.execute(
      `SELECT ${PLAN_COLUMNS} FROM requirements_plans WHERE id = ? AND tenant_id = ? AND project_id = ? LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
      [planId, tenantId, projectId],
    );
    return rows[0] ? mapPlanRow(rows[0]) : null;
  }

  async function selectLatest(executor, { projectId, tenantId, track }) {
    const [rows] = await executor.execute(
      'SELECT id, version FROM requirements_plans WHERE tenant_id = ? AND project_id = ? AND track = ? ORDER BY version DESC LIMIT 1',
      [tenantId, projectId, track],
    );
    return rows[0] ? { id: rows[0].id, version: Number(rows[0].version) } : null;
  }

  async function insertOnce({ expectedLatestVersion, id, plan, projectId, tenantId }) {
    return withTransaction(pool, async (connection) => {
      // Optimistic: the unique (tenant, project, track, version) key decides a race and the
      // loser retries with a fresh read, as package uploads do.
      const latest = await selectLatest(connection, { projectId, tenantId, track: plan.track });
      if (expectedLatestVersion !== undefined && (latest?.version ?? 0) !== expectedLatestVersion) {
        throw notLatestConflict(latest);
      }
      const nowSeconds = unixSeconds(plan.createdAt ?? new Date());
      await connection.execute(
        `
          INSERT INTO requirements_plans (
            id, tenant_id, project_id, track, version, body_markdown, criteria_json, content_json, audit_json,
            status, created_by, updated_by, based_on_id, row_version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, 1, FROM_UNIXTIME(?), FROM_UNIXTIME(?))
        `,
        [
          id, tenantId, projectId, plan.track, (latest?.version ?? 0) + 1, String(plan.body ?? ''),
          JSON.stringify(plan.criteria ?? []), JSON.stringify(plan.content ?? emptyContent()), JSON.stringify(plan.audit ?? {}),
          plan.createdBy, nullableString(plan.createdBy), nullableString(plan.basedOnId), nowSeconds, nowSeconds,
        ],
      );
    });
  }

  return {
    async listTrackPlans({ projectId, tenantId, track = '' }) {
      const [rows] = await pool.execute(
        `SELECT ${PLAN_COLUMNS} FROM requirements_plans WHERE tenant_id = ? AND project_id = ?${track ? ' AND track = ?' : ''} ORDER BY version DESC`,
        track ? [tenantId, projectId, track] : [tenantId, projectId],
      );
      return rows.map(mapPlanRow);
    },

    async getPlan({ planId, projectId, tenantId }) {
      return selectPlan(pool, { planId, projectId, tenantId });
    },

    async insertPlanVersion({ expectedLatestVersion = undefined, plan, projectId, tenantId }) {
      const id = plan.id ?? randomUUID();
      for (let attempt = 1; ; attempt += 1) {
        try {
          await insertOnce({ expectedLatestVersion, id, plan, projectId, tenantId });
          break;
        } catch (error) {
          if (error?.code !== 'ER_DUP_ENTRY' || attempt >= 4) throw error;
          if (expectedLatestVersion !== undefined) {
            throw notLatestConflict(await selectLatest(pool, { projectId, tenantId, track: plan.track }));
          }
        }
      }
      return selectPlan(pool, { planId: id, projectId, tenantId });
    },

    async updateDraft({ expectedRevision, now, patch, planId, projectId, tenantId, updatedBy }) {
      const found = await withTransaction(pool, async (connection) => {
        const current = await selectPlan(connection, { forUpdate: true, planId, projectId, tenantId });
        if (!current) return false;
        if (current.status !== 'draft') throw notDraftConflict(current);
        if (current.revision !== Number(expectedRevision)) throw revisionConflict(current);
        const latest = await selectLatest(connection, { projectId, tenantId, track: current.track });
        if (latest && latest.id !== current.id) throw notLatestConflict(latest);
        const [result] = await connection.execute(
          `
            UPDATE requirements_plans
            SET body_markdown = ?, content_json = ?, criteria_json = ?, updated_by = ?, row_version = row_version + 1,
                updated_at = FROM_UNIXTIME(?)
            WHERE id = ? AND row_version = ?
          `,
          [
            String(patch.body ?? current.body), JSON.stringify(patch.content ?? current.content), JSON.stringify(patch.criteria ?? current.criteria),
            updatedBy, unixSeconds(now ?? new Date()), planId, current.revision,
          ],
        );
        if (Number(result.affectedRows) !== 1) throw revisionConflict(current);
        return true;
      });
      return found ? selectPlan(pool, { planId, projectId, tenantId }) : null;
    },

    /**
     * Approves the draft at `expectedRevision`, the revision the caller validated. The cited
     * decisions are read under a shared lock, so a decision superseded after the caller's
     * check cannot slip into an approved plan.
     */
    async approvePlan({ approvedBy, approvedByName, citedDecisionIds = [], expectedRevision, now, planId, projectId, tenantId }) {
      const nowSeconds = unixSeconds(now ?? new Date());
      const outcome = await withTransaction(pool, async (connection) => {
        const current = await selectPlan(connection, { forUpdate: true, planId, projectId, tenantId });
        if (!current) return null;
        if (current.status !== 'draft') throw notDraftConflict(current);
        if (current.revision !== Number(expectedRevision)) throw revisionConflict(current);
        const latest = await selectLatest(connection, { projectId, tenantId, track: current.track });
        if (latest && latest.id !== current.id) throw notLatestConflict(latest);
        if (citedDecisionIds.length > 0) {
          const [decisions] = await connection.query(
            `
              SELECT id, outcome, superseded_by_id AS supersededById FROM requirements_decisions
              WHERE tenant_id = ? AND project_id = ? AND id IN (?)
              FOR SHARE
            `,
            [tenantId, projectId, citedDecisionIds],
          );
          const stale = staleCitations(citedDecisionIds, decisions);
          if (stale.length > 0) throw staleCitationsConflict(stale);
        }

        const [others] = await connection.execute(
          `
            SELECT id FROM requirements_plans
            WHERE tenant_id = ? AND project_id = ? AND track = ? AND id <> ?
              AND (status = 'approved' OR (status = 'draft' AND version < ?))
            FOR UPDATE
          `,
          [tenantId, projectId, current.track, planId, current.version],
        );
        const superseded = others.map((row) => row.id);
        if (superseded.length > 0) {
          await connection.query(
            `
              UPDATE requirements_plans
              SET status = 'superseded', superseded_at = FROM_UNIXTIME(?), row_version = row_version + 1, updated_at = FROM_UNIXTIME(?)
              WHERE id IN (?)
            `,
            [nowSeconds, nowSeconds, superseded],
          );
        }
        await connection.execute(
          `
            UPDATE requirements_plans
            SET status = 'approved', approved_by = ?, approved_by_name = ?, approved_at = FROM_UNIXTIME(?),
                updated_by = ?, row_version = row_version + 1, updated_at = FROM_UNIXTIME(?)
            WHERE id = ?
          `,
          [approvedBy, normalizeString(approvedByName), nowSeconds, approvedBy, nowSeconds, planId],
        );
        return { superseded };
      });
      if (!outcome) return null;
      return { plan: await selectPlan(pool, { planId, projectId, tenantId }), superseded: outcome.superseded };
    },

    async listProposals({ planId = '', projectId, tenantId }) {
      const [rows] = await pool.execute(
        `SELECT ${PROPOSAL_COLUMNS} FROM requirements_plan_proposals WHERE tenant_id = ? AND project_id = ?${planId ? ' AND plan_id = ?' : ''} ORDER BY updated_at DESC, id ASC`,
        planId ? [tenantId, projectId, planId] : [tenantId, projectId],
      );
      return rows.map(mapProposalRow);
    },

    async getProposal({ planId, projectId, proposedBy, tenantId }) {
      const [rows] = await pool.execute(
        `SELECT ${PROPOSAL_COLUMNS} FROM requirements_plan_proposals WHERE tenant_id = ? AND project_id = ? AND plan_id = ? AND proposed_by = ? LIMIT 1`,
        [tenantId, projectId, planId, proposedBy],
      );
      return rows[0] ? mapProposalRow(rows[0]) : null;
    },

    async saveProposal({ now, projectId, proposal, tenantId }) {
      const nowSeconds = unixSeconds(now ?? new Date());
      await pool.execute(
        `
          INSERT INTO requirements_plan_proposals (
            id, tenant_id, project_id, plan_id, track, proposed_by, proposed_by_name, session_id, items_json, audit_json,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?), FROM_UNIXTIME(?))
          ON DUPLICATE KEY UPDATE
            proposed_by_name = VALUES(proposed_by_name),
            session_id = VALUES(session_id),
            items_json = VALUES(items_json),
            audit_json = VALUES(audit_json),
            updated_at = VALUES(updated_at)
        `,
        [
          randomUUID(), tenantId, projectId, proposal.planId, proposal.track, proposal.proposedBy, normalizeString(proposal.proposedByName),
          proposal.sessionId, JSON.stringify(proposal.items ?? []), JSON.stringify(proposal.audit ?? {}), nowSeconds, nowSeconds,
        ],
      );
      return this.getProposal({ planId: proposal.planId, projectId, proposedBy: proposal.proposedBy, tenantId });
    },
  };
}
