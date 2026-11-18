import { randomUUID } from 'node:crypto';

import { HttpError } from '../../lib/errors/http-error.js';

function clone(value) { return structuredClone(value); }
function iso(value = new Date()) { return new Date(value).toISOString(); }
function parseJson(value, fallback = {}) { if (value == null) return fallback; if (typeof value === 'object') return value; try { return JSON.parse(value); } catch { return fallback; } }
function conflict(actualVersion, expectedVersion) { return new HttpError(409, 'Portfolio record changed since it was loaded.', { details: { actualVersion, code: 'portfolio_version_conflict', expectedVersion } }); }

export function createInMemoryPortfolioRepository() {
  const nodes = new Map(); const objectives = new Map(); const alignments = new Map(); const plans = new Map(); const baselines = new Map();
  function create(map, input, tenantId) { const now = iso(); const record = { ...clone(input), createdAt: now, id: randomUUID(), tenantId, updatedAt: now, version: 1 }; map.set(record.id, record); return clone(record); }
  function update(map, id, patch, tenantId) { const record = map.get(id); if (!record || record.tenantId !== tenantId) return null; if (record.version !== patch.expectedVersion) throw conflict(record.version, patch.expectedVersion); const { expectedVersion: _version, ...changes } = patch; Object.assign(record, clone(changes), { updatedAt: iso(), version: record.version + 1 }); return clone(record); }
  function remove(map, id, expectedVersion, tenantId) { const record = map.get(id); if (!record || record.tenantId !== tenantId) return false; if (record.version !== expectedVersion) throw conflict(record.version, expectedVersion); map.delete(id); return true; }
  return {
    createAlignment: async ({ input, tenantId }) => create(alignments, input, tenantId),
    createBaseline: async ({ input, tenantId }) => create(baselines, input, tenantId),
    createNode: async ({ input, tenantId }) => create(nodes, input, tenantId),
    createObjective: async ({ input, tenantId }) => create(objectives, input, tenantId),
    createPlan: async ({ input, tenantId }) => create(plans, input, tenantId),
    async deleteAlignment({ alignmentId, expectedVersion, tenantId }) { return remove(alignments, alignmentId, expectedVersion, tenantId); },
    async deleteNode({ expectedVersion, nodeId, tenantId }) {
      if ([...nodes.values()].some((node) => node.tenantId === tenantId && node.parentId === nodeId) || [...alignments.values()].some((alignment) => alignment.tenantId === tenantId && alignment.portfolioNodeId === nodeId)) throw new HttpError(409, 'Remove child programs and project alignments before deleting this portfolio node.');
      return remove(nodes, nodeId, expectedVersion, tenantId);
    },
    async deleteObjective({ expectedVersion, objectiveId, tenantId }) {
      if ([...objectives.values()].some((objective) => objective.tenantId === tenantId && objective.parentId === objectiveId) || [...alignments.values()].some((alignment) => alignment.tenantId === tenantId && alignment.objectiveId === objectiveId)) throw new HttpError(409, 'Remove child key results and project alignments before deleting this objective.');
      return remove(objectives, objectiveId, expectedVersion, tenantId);
    },
    deletePlan: async ({ expectedVersion, planId, tenantId }) => {
      const plan = plans.get(planId); if (plan?.tenantId === tenantId && ['approved', 'rejected'].includes(plan.status)) throw new HttpError(409, 'Decided portfolio plans are immutable.');
      return remove(plans, planId, expectedVersion, tenantId);
    },
    async listSnapshot({ tenantId }) { return { alignments: [...alignments.values()].filter((item) => item.tenantId === tenantId).map(clone), baselines: [...baselines.values()].filter((item) => item.tenantId === tenantId).map(clone), nodes: [...nodes.values()].filter((item) => item.tenantId === tenantId).map(clone), objectives: [...objectives.values()].filter((item) => item.tenantId === tenantId).map(clone), plans: [...plans.values()].filter((item) => item.tenantId === tenantId).map(clone) }; },
    updateAlignment: async ({ alignmentId, input, tenantId }) => update(alignments, alignmentId, input, tenantId),
    updateNode: async ({ input, nodeId, tenantId }) => update(nodes, nodeId, input, tenantId),
    updateObjective: async ({ input, objectiveId, tenantId }) => update(objectives, objectiveId, input, tenantId),
    updatePlan: async ({ input, planId, tenantId }) => update(plans, planId, input, tenantId),
  };
}

export async function ensureMysqlPortfolioPlanningSchema(executor) {
  await executor.execute(`CREATE TABLE IF NOT EXISTS portfolio_scenario_plans (
    id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, portfolio_node_id VARCHAR(36) NOT NULL,
    name VARCHAR(255) NOT NULL, scenario VARCHAR(24) NOT NULL, funding_limit DECIMAL(20,4) NOT NULL,
    funding_currency CHAR(3) NOT NULL, resource_hours_limit DECIMAL(20,4) NOT NULL, status VARCHAR(24) NOT NULL,
    decision_note TEXT NOT NULL, decided_by VARCHAR(128) NULL, decided_at DATETIME(3) NULL, version INT NOT NULL DEFAULT 1,
    created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
    KEY idx_portfolio_plan_node (tenant_id, portfolio_node_id, scenario, status)
  )`);
  await executor.execute(`CREATE TABLE IF NOT EXISTS portfolio_baselines (
    id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, portfolio_node_id VARCHAR(36) NOT NULL,
    name VARCHAR(255) NOT NULL, scenario VARCHAR(24) NOT NULL, snapshot_json JSON NOT NULL,
    captured_by VARCHAR(128) NOT NULL, captured_at DATETIME(3) NOT NULL, version INT NOT NULL DEFAULT 1,
    created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
    KEY idx_portfolio_baseline_node (tenant_id, portfolio_node_id, scenario, captured_at)
  )`);
  const [columns] = await executor.execute("SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'portfolio_project_alignments' AND column_name = 'requested_funding'");
  if (!columns.length) await executor.execute("ALTER TABLE portfolio_project_alignments ADD COLUMN requested_funding DECIMAL(20,4) NOT NULL DEFAULT 0 AFTER benefit_unit, ADD COLUMN funding_currency CHAR(3) NOT NULL DEFAULT 'USD' AFTER requested_funding, ADD COLUMN requested_hours DECIMAL(20,4) NOT NULL DEFAULT 0 AFTER funding_currency");
}

export async function ensureMysqlPortfolioSchema(executor) {
  await executor.execute(`CREATE TABLE IF NOT EXISTS portfolio_nodes (
    id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, parent_id VARCHAR(36) NULL, node_kind VARCHAR(24) NOT NULL,
    name VARCHAR(255) NOT NULL, description TEXT NOT NULL, status VARCHAR(24) NOT NULL, governance_stage VARCHAR(80) NOT NULL,
    owner_id VARCHAR(36) NULL, sponsor_id VARCHAR(36) NULL, scoring_json JSON NOT NULL, version INT NOT NULL DEFAULT 1,
    created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
    KEY idx_portfolio_nodes_tenant (tenant_id, parent_id, node_kind, status), KEY idx_portfolio_nodes_name (tenant_id, name)
  )`);
  await executor.execute(`CREATE TABLE IF NOT EXISTS strategy_objectives (
    id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, parent_id VARCHAR(36) NULL, objective_kind VARCHAR(24) NOT NULL,
    title VARCHAR(255) NOT NULL, description TEXT NOT NULL, status VARCHAR(24) NOT NULL, target_value DECIMAL(18,4) NOT NULL,
    current_value DECIMAL(18,4) NOT NULL, unit VARCHAR(64) NOT NULL, weight DECIMAL(8,4) NOT NULL, version INT NOT NULL DEFAULT 1,
    created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
    KEY idx_strategy_objectives_tenant (tenant_id, parent_id, objective_kind, status)
  )`);
  await executor.execute(`CREATE TABLE IF NOT EXISTS portfolio_project_alignments (
    id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, portfolio_node_id VARCHAR(36) NOT NULL, project_id VARCHAR(36) NOT NULL,
    objective_id VARCHAR(36) NULL, demand_status VARCHAR(24) NOT NULL, scenario VARCHAR(24) NOT NULL,
    benefit_value DECIMAL(18,4) NOT NULL, benefit_unit VARCHAR(64) NOT NULL, strategic_score DECIMAL(8,4) NOT NULL,
    risk_score DECIMAL(8,4) NOT NULL, cost_score DECIMAL(8,4) NOT NULL, version INT NOT NULL DEFAULT 1,
    created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_portfolio_project (tenant_id, portfolio_node_id, project_id),
    KEY idx_portfolio_alignment_objective (tenant_id, objective_id), KEY idx_portfolio_alignment_demand (tenant_id, demand_status, scenario)
  )`);
}

function date(row, name) { return iso(row[name]); }
function mapNode(row) { return row ? { createdAt: date(row, 'created_at'), description: row.description, governanceStage: row.governance_stage, id: row.id, kind: row.node_kind, name: row.name, ownerId: row.owner_id, parentId: row.parent_id, scoring: parseJson(row.scoring_json), sponsorId: row.sponsor_id, status: row.status, tenantId: row.tenant_id, updatedAt: date(row, 'updated_at'), version: Number(row.version) } : null; }
function mapObjective(row) { return row ? { createdAt: date(row, 'created_at'), currentValue: Number(row.current_value), description: row.description, id: row.id, kind: row.objective_kind, parentId: row.parent_id, status: row.status, targetValue: Number(row.target_value), tenantId: row.tenant_id, title: row.title, unit: row.unit, updatedAt: date(row, 'updated_at'), version: Number(row.version), weight: Number(row.weight) } : null; }
function mapAlignment(row) { return row ? { benefitUnit: row.benefit_unit, benefitValue: Number(row.benefit_value), costScore: Number(row.cost_score), createdAt: date(row, 'created_at'), demandStatus: row.demand_status, fundingCurrency: row.funding_currency ?? 'USD', id: row.id, objectiveId: row.objective_id, portfolioNodeId: row.portfolio_node_id, projectId: row.project_id, requestedFunding: Number(row.requested_funding ?? 0), requestedHours: Number(row.requested_hours ?? 0), riskScore: Number(row.risk_score), scenario: row.scenario, strategicScore: Number(row.strategic_score), tenantId: row.tenant_id, updatedAt: date(row, 'updated_at'), version: Number(row.version) } : null; }
function mapPlan(row) { return row ? { createdAt: date(row, 'created_at'), decidedAt: row.decided_at ? date(row, 'decided_at') : null, decidedBy: row.decided_by, decisionNote: row.decision_note, fundingCurrency: row.funding_currency, fundingLimit: Number(row.funding_limit), id: row.id, name: row.name, portfolioNodeId: row.portfolio_node_id, resourceHoursLimit: Number(row.resource_hours_limit), scenario: row.scenario, status: row.status, tenantId: row.tenant_id, updatedAt: date(row, 'updated_at'), version: Number(row.version) } : null; }
function mapBaseline(row) { return row ? { capturedAt: date(row, 'captured_at'), capturedBy: row.captured_by, createdAt: date(row, 'created_at'), id: row.id, name: row.name, portfolioNodeId: row.portfolio_node_id, scenario: row.scenario, snapshot: parseJson(row.snapshot_json), tenantId: row.tenant_id, updatedAt: date(row, 'updated_at'), version: Number(row.version) } : null; }

export function createMysqlPortfolioRepository({ pool }) {
  async function select(table, id, tenantId, mapper) { const [rows] = await pool.execute(`SELECT * FROM ${table} WHERE id = ? AND tenant_id = ? LIMIT 1`, [id, tenantId]); return mapper(rows[0]); }
  async function throwConflictOrMissing(table, id, expectedVersion, tenantId) { const [rows] = await pool.execute(`SELECT version FROM ${table} WHERE id = ? AND tenant_id = ? LIMIT 1`, [id, tenantId]); if (!rows[0]) return null; throw conflict(Number(rows[0].version), expectedVersion); }
  async function remove(table, id, expectedVersion, tenantId) { const [result] = await pool.execute(`DELETE FROM ${table} WHERE id = ? AND tenant_id = ? AND version = ?`, [id, tenantId, expectedVersion]); if (Number(result.affectedRows) === 1) return true; return throwConflictOrMissing(table, id, expectedVersion, tenantId); }
  return {
    async createNode({ input, tenantId }) { const id = randomUUID(); const now = new Date(); await pool.execute(`INSERT INTO portfolio_nodes (id, tenant_id, parent_id, node_kind, name, description, status, governance_stage, owner_id, sponsor_id, scoring_json, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`, [id, tenantId, input.parentId, input.kind, input.name, input.description, input.status, input.governanceStage, input.ownerId, input.sponsorId, JSON.stringify(input.scoring), now, now]); return select('portfolio_nodes', id, tenantId, mapNode); },
    async createObjective({ input, tenantId }) { const id = randomUUID(); const now = new Date(); await pool.execute(`INSERT INTO strategy_objectives (id, tenant_id, parent_id, objective_kind, title, description, status, target_value, current_value, unit, weight, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`, [id, tenantId, input.parentId, input.kind, input.title, input.description, input.status, input.targetValue, input.currentValue, input.unit, input.weight, now, now]); return select('strategy_objectives', id, tenantId, mapObjective); },
    async createAlignment({ input, tenantId }) { const id = randomUUID(); const now = new Date(); await pool.execute(`INSERT INTO portfolio_project_alignments (id, tenant_id, portfolio_node_id, project_id, objective_id, demand_status, scenario, benefit_value, benefit_unit, requested_funding, funding_currency, requested_hours, strategic_score, risk_score, cost_score, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`, [id, tenantId, input.portfolioNodeId, input.projectId, input.objectiveId, input.demandStatus, input.scenario, input.benefitValue, input.benefitUnit, input.requestedFunding ?? 0, input.fundingCurrency ?? 'USD', input.requestedHours ?? 0, input.strategicScore, input.riskScore, input.costScore, now, now]); return select('portfolio_project_alignments', id, tenantId, mapAlignment); },
    async createBaseline({ input, tenantId }) { const id = randomUUID(); const now = new Date(); await pool.execute('INSERT INTO portfolio_baselines (id, tenant_id, portfolio_node_id, name, scenario, snapshot_json, captured_by, captured_at, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)', [id, tenantId, input.portfolioNodeId, input.name, input.scenario, JSON.stringify(input.snapshot), input.capturedBy, new Date(input.capturedAt), now, now]); return select('portfolio_baselines', id, tenantId, mapBaseline); },
    async createPlan({ input, tenantId }) { const id = randomUUID(); const now = new Date(); await pool.execute('INSERT INTO portfolio_scenario_plans (id, tenant_id, portfolio_node_id, name, scenario, funding_limit, funding_currency, resource_hours_limit, status, decision_note, decided_by, decided_at, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)', [id, tenantId, input.portfolioNodeId, input.name, input.scenario, input.fundingLimit, input.fundingCurrency, input.resourceHoursLimit, input.status, input.decisionNote, input.decidedBy, input.decidedAt ? new Date(input.decidedAt) : null, now, now]); return select('portfolio_scenario_plans', id, tenantId, mapPlan); },
    deleteAlignment: ({ alignmentId, expectedVersion, tenantId }) => remove('portfolio_project_alignments', alignmentId, expectedVersion, tenantId),
    async deleteNode({ expectedVersion, nodeId, tenantId }) { const [[children], [members]] = await Promise.all([pool.execute('SELECT COUNT(*) AS count FROM portfolio_nodes WHERE tenant_id = ? AND parent_id = ?', [tenantId, nodeId]), pool.execute('SELECT COUNT(*) AS count FROM portfolio_project_alignments WHERE tenant_id = ? AND portfolio_node_id = ?', [tenantId, nodeId])]); if (Number(children[0]?.count) || Number(members[0]?.count)) throw new HttpError(409, 'Remove child programs and project alignments before deleting this portfolio node.'); return remove('portfolio_nodes', nodeId, expectedVersion, tenantId); },
    async deleteObjective({ expectedVersion, objectiveId, tenantId }) { const [[children], [members]] = await Promise.all([pool.execute('SELECT COUNT(*) AS count FROM strategy_objectives WHERE tenant_id = ? AND parent_id = ?', [tenantId, objectiveId]), pool.execute('SELECT COUNT(*) AS count FROM portfolio_project_alignments WHERE tenant_id = ? AND objective_id = ?', [tenantId, objectiveId])]); if (Number(children[0]?.count) || Number(members[0]?.count)) throw new HttpError(409, 'Remove child key results and project alignments before deleting this objective.'); return remove('strategy_objectives', objectiveId, expectedVersion, tenantId); },
    async deletePlan({ expectedVersion, planId, tenantId }) { const plan = await select('portfolio_scenario_plans', planId, tenantId, mapPlan); if (plan && ['approved', 'rejected'].includes(plan.status)) throw new HttpError(409, 'Decided portfolio plans are immutable.'); return remove('portfolio_scenario_plans', planId, expectedVersion, tenantId); },
    async listSnapshot({ tenantId }) { const [nodes] = await pool.execute('SELECT * FROM portfolio_nodes WHERE tenant_id = ? ORDER BY name, id', [tenantId]); const [objectives] = await pool.execute('SELECT * FROM strategy_objectives WHERE tenant_id = ? ORDER BY title, id', [tenantId]); const [alignments] = await pool.execute('SELECT * FROM portfolio_project_alignments WHERE tenant_id = ? ORDER BY created_at, id', [tenantId]); const [plans] = await pool.execute('SELECT * FROM portfolio_scenario_plans WHERE tenant_id = ? ORDER BY created_at, id', [tenantId]); const [baselines] = await pool.execute('SELECT * FROM portfolio_baselines WHERE tenant_id = ? ORDER BY captured_at, id', [tenantId]); return { alignments: alignments.map(mapAlignment), baselines: baselines.map(mapBaseline), nodes: nodes.map(mapNode), objectives: objectives.map(mapObjective), plans: plans.map(mapPlan) }; },
    async updateNode({ input, nodeId, tenantId }) { const current = await select('portfolio_nodes', nodeId, tenantId, mapNode); if (!current) return null; const next = { ...current, ...input }; const [result] = await pool.execute(`UPDATE portfolio_nodes SET parent_id = ?, node_kind = ?, name = ?, description = ?, status = ?, governance_stage = ?, owner_id = ?, sponsor_id = ?, scoring_json = ?, version = version + 1, updated_at = NOW(3) WHERE id = ? AND tenant_id = ? AND version = ?`, [next.parentId, next.kind, next.name, next.description, next.status, next.governanceStage, next.ownerId, next.sponsorId, JSON.stringify(next.scoring), nodeId, tenantId, input.expectedVersion]); if (Number(result.affectedRows) !== 1) return throwConflictOrMissing('portfolio_nodes', nodeId, input.expectedVersion, tenantId); return select('portfolio_nodes', nodeId, tenantId, mapNode); },
    async updateObjective({ input, objectiveId, tenantId }) { const current = await select('strategy_objectives', objectiveId, tenantId, mapObjective); if (!current) return null; const next = { ...current, ...input }; const [result] = await pool.execute(`UPDATE strategy_objectives SET parent_id = ?, objective_kind = ?, title = ?, description = ?, status = ?, target_value = ?, current_value = ?, unit = ?, weight = ?, version = version + 1, updated_at = NOW(3) WHERE id = ? AND tenant_id = ? AND version = ?`, [next.parentId, next.kind, next.title, next.description, next.status, next.targetValue, next.currentValue, next.unit, next.weight, objectiveId, tenantId, input.expectedVersion]); if (Number(result.affectedRows) !== 1) return throwConflictOrMissing('strategy_objectives', objectiveId, input.expectedVersion, tenantId); return select('strategy_objectives', objectiveId, tenantId, mapObjective); },
    async updateAlignment({ alignmentId, input, tenantId }) { const current = await select('portfolio_project_alignments', alignmentId, tenantId, mapAlignment); if (!current) return null; const next = { ...current, ...input }; const [result] = await pool.execute(`UPDATE portfolio_project_alignments SET portfolio_node_id = ?, project_id = ?, objective_id = ?, demand_status = ?, scenario = ?, benefit_value = ?, benefit_unit = ?, requested_funding = ?, funding_currency = ?, requested_hours = ?, strategic_score = ?, risk_score = ?, cost_score = ?, version = version + 1, updated_at = NOW(3) WHERE id = ? AND tenant_id = ? AND version = ?`, [next.portfolioNodeId, next.projectId, next.objectiveId, next.demandStatus, next.scenario, next.benefitValue, next.benefitUnit, next.requestedFunding, next.fundingCurrency, next.requestedHours, next.strategicScore, next.riskScore, next.costScore, alignmentId, tenantId, input.expectedVersion]); if (Number(result.affectedRows) !== 1) return throwConflictOrMissing('portfolio_project_alignments', alignmentId, input.expectedVersion, tenantId); return select('portfolio_project_alignments', alignmentId, tenantId, mapAlignment); },
    async updatePlan({ input, planId, tenantId }) { const current = await select('portfolio_scenario_plans', planId, tenantId, mapPlan); if (!current) return null; const next = { ...current, ...input }; const [result] = await pool.execute('UPDATE portfolio_scenario_plans SET portfolio_node_id = ?, name = ?, scenario = ?, funding_limit = ?, funding_currency = ?, resource_hours_limit = ?, status = ?, decision_note = ?, decided_by = ?, decided_at = ?, version = version + 1, updated_at = NOW(3) WHERE id = ? AND tenant_id = ? AND version = ?', [next.portfolioNodeId, next.name, next.scenario, next.fundingLimit, next.fundingCurrency, next.resourceHoursLimit, next.status, next.decisionNote, next.decidedBy, next.decidedAt ? new Date(next.decidedAt) : null, planId, tenantId, input.expectedVersion]); if (Number(result.affectedRows) !== 1) return throwConflictOrMissing('portfolio_scenario_plans', planId, input.expectedVersion, tenantId); return select('portfolio_scenario_plans', planId, tenantId, mapPlan); },
  };
}
