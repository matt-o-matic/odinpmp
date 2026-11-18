import { randomUUID } from 'node:crypto';

import { HttpError } from '../../lib/errors/http-error.js';

function clone(value) { return structuredClone(value); }
function nowIso() { return new Date().toISOString(); }
function parseJson(value, fallback) { if (value == null) return fallback; if (typeof value === 'object') return value; try { return JSON.parse(value); } catch { return typeof value === 'string' ? value : fallback; } }
function conflict(record, expectedVersion) {
  throw new HttpError(409, 'Workflow record changed since it was loaded.', { details: { actualVersion: record.version, code: 'workflow_version_conflict', expectedVersion } });
}

export function createInMemoryWorkflowRepository() {
  const state = { approvals: new Map(), baselines: new Map(), bindings: new Map(), customFields: new Map(), customValues: new Map(), histories: new Map(), templates: new Map(), workflows: new Map() };
  let historySequence = 0;
  function create(collection, input, tenantId, extra = {}) { const now = nowIso(); const record = { ...clone(input), ...extra, createdAt: now, id: randomUUID(), tenantId, updatedAt: now, version: 1 }; collection.set(record.id, record); return clone(record); }
  function update(collection, id, input, tenantId) { const record = collection.get(id); if (!record || record.tenantId !== tenantId) return null; if (record.version !== input.expectedVersion) conflict(record, input.expectedVersion); const { expectedVersion: _expectedVersion, ...changes } = input; Object.assign(record, clone(changes), { updatedAt: nowIso(), version: record.version + 1 }); return clone(record); }
  function remove(collection, id, expectedVersion, tenantId) { const record = collection.get(id); if (!record || record.tenantId !== tenantId) return false; if (record.version !== expectedVersion) conflict(record, expectedVersion); collection.delete(id); return true; }
  function list(collection, tenantId) { return clone([...collection.values()].filter((record) => record.tenantId === tenantId)); }
  return {
    createBaseline: async ({ createdBy, input, snapshot, tenantId }) => create(state.baselines, input, tenantId, { capturedAt: nowIso(), createdBy, snapshot }),
    createBinding: async ({ input, tenantId }) => {
      const existing = [...state.bindings.values()].find((record) => record.tenantId === tenantId && record.projectId === input.projectId && record.itemType === input.itemType);
      if (existing) throw new HttpError(409, 'This project item type already has a workflow binding.');
      return create(state.bindings, input, tenantId);
    },
    createCustomField: async ({ input, tenantId }) => create(state.customFields, input, tenantId),
    createTemplate: async ({ input, tenantId }) => create(state.templates, input, tenantId),
    createWorkflow: async ({ input, tenantId }) => create(state.workflows, input, tenantId),
    decideApproval: async ({ approvalId, decidedBy, input, tenantId }) => update(state.approvals, approvalId, { ...input, decidedAt: nowIso(), decidedBy }, tenantId),
    deleteBinding: async ({ bindingId, expectedVersion, tenantId }) => remove(state.bindings, bindingId, expectedVersion, tenantId),
    deleteCustomField: async ({ expectedVersion, fieldId, tenantId }) => {
      if ([...state.customValues.values()].some((record) => record.tenantId === tenantId && record.fieldId === fieldId)) throw new HttpError(409, 'Remove custom-field values before deleting this definition.');
      return remove(state.customFields, fieldId, expectedVersion, tenantId);
    },
    deleteCustomValue: async ({ expectedVersion, valueId, tenantId }) => remove(state.customValues, valueId, expectedVersion, tenantId),
    deleteTemplate: async ({ expectedVersion, templateId, tenantId }) => remove(state.templates, templateId, expectedVersion, tenantId),
    deleteWorkflow: async ({ expectedVersion, tenantId, workflowId }) => {
      if ([...state.bindings.values()].some((record) => record.tenantId === tenantId && record.workflowId === workflowId)) throw new HttpError(409, 'Remove project bindings before deleting this workflow.');
      return remove(state.workflows, workflowId, expectedVersion, tenantId);
    },
    // Home: the bindings and their workflows (for done states), pending approvals, and the
    // latest transition of each item when its SLA has passed, for the given projects only.
    async listProjectWorkflowState({ now = new Date(), projectIds = [], tenantId }) {
      const ids = new Set(projectIds);
      const scoped = (collection) => list(collection, tenantId).filter((record) => ids.has(record.projectId));
      const bindings = scoped(state.bindings);
      const workflowIds = new Set(bindings.map((binding) => binding.workflowId));
      const latest = new Map();
      for (const history of scoped(state.histories)) {
        const key = `${history.projectId}:${history.itemType}:${history.itemId}`;
        if (!latest.has(key) || history.sequenceId > latest.get(key).sequenceId) latest.set(key, history);
      }
      return {
        approvals: scoped(state.approvals).filter((approval) => approval.status === 'pending'),
        bindings,
        histories: [...latest.values()].filter((history) => history.slaDueAt && Date.parse(history.slaDueAt) <= now.getTime()),
        workflows: list(state.workflows, tenantId).filter((workflow) => workflowIds.has(workflow.id)),
      };
    },
    async listSnapshot({ tenantId }) { return { approvals: list(state.approvals, tenantId), baselines: list(state.baselines, tenantId), bindings: list(state.bindings, tenantId), customFields: list(state.customFields, tenantId), customValues: list(state.customValues, tenantId), histories: list(state.histories, tenantId), templates: list(state.templates, tenantId), workflows: list(state.workflows, tenantId) }; },
    recordTransition: async ({ approvalId = null, fromState, itemId, itemType, projectId, slaDueAt = null, tenantId, toState, transitionKey, userId }) => {
      if (approvalId) { const approval = state.approvals.get(approvalId); if (approval?.tenantId === tenantId) Object.assign(approval, { consumedAt: nowIso(), status: 'consumed', updatedAt: nowIso(), version: approval.version + 1 }); }
      return create(state.histories, { approvalId, fromState, itemId, itemType, projectId, slaDueAt, slaEventEnqueuedAt: null, toState, transitionEventEnqueuedAt: null, transitionKey, userId }, tenantId, { occurredAt: nowIso(), sequenceId: ++historySequence });
    },
    async listPendingAutomationEvents({ limit = 200, now = new Date() } = {}) {
      const histories = [...state.histories.values()];
      const latestByItem = new Map();
      for (const history of histories) {
        const key = `${history.tenantId}:${history.projectId}:${history.itemType}:${history.itemId}`;
        const current = latestByItem.get(key);
        if (!current || history.sequenceId > current.sequenceId) latestByItem.set(key, history);
      }
      const candidates = [];
      for (const history of histories) {
        if (!history.transitionEventEnqueuedAt) candidates.push({ eventType: 'workflow.transitioned', history: clone(history) });
        const key = `${history.tenantId}:${history.projectId}:${history.itemType}:${history.itemId}`;
        if (!history.slaEventEnqueuedAt && history.slaDueAt && Date.parse(history.slaDueAt) <= now.getTime() && latestByItem.get(key)?.id === history.id) {
          candidates.push({ eventType: 'workflow.sla.overdue', history: clone(history) });
        }
      }
      return candidates.sort((left, right) => left.history.sequenceId - right.history.sequenceId || left.eventType.localeCompare(right.eventType)).slice(0, limit);
    },
    async markAutomationEventEnqueued({ enqueuedAt = new Date(), eventType, historyId }) {
      const history = state.histories.get(historyId);
      if (!history) return false;
      const field = eventType === 'workflow.sla.overdue' ? 'slaEventEnqueuedAt' : 'transitionEventEnqueuedAt';
      history[field] = new Date(enqueuedAt).toISOString();
      history.updatedAt = new Date(enqueuedAt).toISOString();
      return true;
    },
    requestApproval: async ({ input, requestedBy, tenantId }) => create(state.approvals, input, tenantId, { decidedAt: null, decidedBy: null, decisionNote: '', requestedBy, status: 'pending' }),
    updateBinding: async ({ bindingId, input, tenantId }) => update(state.bindings, bindingId, input, tenantId),
    updateCustomField: async ({ fieldId, input, tenantId }) => update(state.customFields, fieldId, input, tenantId),
    updateTemplate: async ({ input, templateId, tenantId }) => update(state.templates, templateId, input, tenantId),
    updateWorkflow: async ({ input, tenantId, workflowId }) => update(state.workflows, workflowId, input, tenantId),
    upsertCustomValue: async ({ input, tenantId }) => {
      const existing = [...state.customValues.values()].find((record) => record.tenantId === tenantId && record.projectId === input.projectId && record.itemId === input.itemId && record.fieldId === input.fieldId);
      if (!existing) { if (input.expectedVersion != null) throw new HttpError(404, 'Custom-field value not found.'); const { expectedVersion: _expectedVersion, ...value } = input; return create(state.customValues, value, tenantId); }
      if (input.expectedVersion == null || existing.version !== input.expectedVersion) conflict(existing, input.expectedVersion);
      return update(state.customValues, existing.id, { expectedVersion: input.expectedVersion, value: input.value }, tenantId);
    },
  };
}

export async function ensureMysqlWorkflowSchema(executor) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS workflow_definitions (id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, name VARCHAR(240) NOT NULL, description TEXT NOT NULL, item_types_json JSON NOT NULL, states_json JSON NOT NULL, transitions_json JSON NOT NULL, status VARCHAR(32) NOT NULL, version INT NOT NULL DEFAULT 1, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, UNIQUE KEY uq_workflow_name (tenant_id, name), KEY idx_workflow_status (tenant_id, status))`,
    `CREATE TABLE IF NOT EXISTS project_workflow_bindings (id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, project_id VARCHAR(128) NOT NULL, item_type VARCHAR(32) NOT NULL, workflow_id VARCHAR(36) NOT NULL, version INT NOT NULL DEFAULT 1, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, UNIQUE KEY uq_project_workflow_binding (tenant_id, project_id, item_type), KEY idx_workflow_binding_workflow (tenant_id, workflow_id))`,
    `CREATE TABLE IF NOT EXISTS workflow_transition_approvals (id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, project_id VARCHAR(128) NOT NULL, item_type VARCHAR(32) NOT NULL, item_id VARCHAR(128) NOT NULL, transition_key VARCHAR(120) NOT NULL, from_state VARCHAR(80) NOT NULL, to_state VARCHAR(80) NOT NULL, status VARCHAR(32) NOT NULL, note TEXT NOT NULL, decision_note TEXT NOT NULL, requested_by VARCHAR(128) NOT NULL, decided_by VARCHAR(128) NULL, expires_at DATETIME(3) NULL, decided_at DATETIME(3) NULL, consumed_at DATETIME(3) NULL, version INT NOT NULL DEFAULT 1, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, KEY idx_workflow_approval_lookup (tenant_id, project_id, item_id, transition_key, status))`,
    `CREATE TABLE IF NOT EXISTS workflow_transition_history (id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, project_id VARCHAR(128) NOT NULL, item_type VARCHAR(32) NOT NULL, item_id VARCHAR(128) NOT NULL, transition_key VARCHAR(120) NOT NULL, from_state VARCHAR(80) NOT NULL, to_state VARCHAR(80) NOT NULL, user_id VARCHAR(128) NOT NULL, approval_id VARCHAR(36) NULL, occurred_at DATETIME(3) NOT NULL, sla_due_at DATETIME(3) NULL, transition_event_enqueued_at DATETIME(3) NULL, sla_event_enqueued_at DATETIME(3) NULL, version INT NOT NULL DEFAULT 1, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, KEY idx_workflow_history_item (tenant_id, project_id, item_id, occurred_at), KEY idx_workflow_history_sla (tenant_id, sla_due_at), KEY idx_workflow_history_transition_event (transition_event_enqueued_at, occurred_at), KEY idx_workflow_history_sla_event (sla_event_enqueued_at, sla_due_at))`,
    `CREATE TABLE IF NOT EXISTS project_baselines (id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, project_id VARCHAR(128) NOT NULL, name VARCHAR(240) NOT NULL, note TEXT NOT NULL, snapshot_json JSON NOT NULL, created_by VARCHAR(128) NOT NULL, captured_at DATETIME(3) NOT NULL, version INT NOT NULL DEFAULT 1, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, KEY idx_project_baseline (tenant_id, project_id, captured_at))`,
    `CREATE TABLE IF NOT EXISTS project_templates (id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, name VARCHAR(240) NOT NULL, description TEXT NOT NULL, template_kind VARCHAR(32) NOT NULL, payload_json JSON NOT NULL, status VARCHAR(32) NOT NULL, version INT NOT NULL DEFAULT 1, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, KEY idx_project_template (tenant_id, template_kind, status))`,
    `CREATE TABLE IF NOT EXISTS custom_field_definitions (id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, name VARCHAR(160) NOT NULL, description TEXT NOT NULL, scope VARCHAR(32) NOT NULL, field_type VARCHAR(32) NOT NULL, options_json JSON NOT NULL, required BOOLEAN NOT NULL, status VARCHAR(32) NOT NULL, version INT NOT NULL DEFAULT 1, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, UNIQUE KEY uq_custom_field_name (tenant_id, scope, name), KEY idx_custom_field_scope (tenant_id, scope, status))`,
    `CREATE TABLE IF NOT EXISTS custom_field_values (id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, project_id VARCHAR(128) NOT NULL, item_type VARCHAR(32) NOT NULL, item_id VARCHAR(128) NOT NULL, field_id VARCHAR(36) NOT NULL, value_json JSON NOT NULL, version INT NOT NULL DEFAULT 1, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, UNIQUE KEY uq_custom_field_value (tenant_id, project_id, item_id, field_id), KEY idx_custom_field_value_project (tenant_id, project_id, item_type, item_id))`,
  ];
  for (const statement of statements) await executor.execute(statement);
}

export async function ensureMysqlWorkflowAutomationSchema(executor) {
  await ensureMysqlWorkflowSchema(executor);
  const [columns] = await executor.execute(`SELECT column_name FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'workflow_transition_history'
      AND column_name IN ('transition_event_enqueued_at', 'sla_event_enqueued_at')`);
  const existingColumns = new Set(columns.map((row) => String(row.column_name ?? row.COLUMN_NAME ?? '')));
  if (!existingColumns.has('transition_event_enqueued_at')) {
    await executor.execute('ALTER TABLE workflow_transition_history ADD COLUMN transition_event_enqueued_at DATETIME(3) NULL AFTER sla_due_at');
  }
  if (!existingColumns.has('sla_event_enqueued_at')) {
    await executor.execute('ALTER TABLE workflow_transition_history ADD COLUMN sla_event_enqueued_at DATETIME(3) NULL AFTER transition_event_enqueued_at');
  }
  const [indexes] = await executor.execute(`SELECT index_name FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'workflow_transition_history'
      AND index_name IN ('idx_workflow_history_transition_event', 'idx_workflow_history_sla_event')`);
  const existingIndexes = new Set(indexes.map((row) => String(row.index_name ?? row.INDEX_NAME ?? '')));
  if (!existingIndexes.has('idx_workflow_history_transition_event')) {
    await executor.execute('ALTER TABLE workflow_transition_history ADD INDEX idx_workflow_history_transition_event (transition_event_enqueued_at, occurred_at)');
  }
  if (!existingIndexes.has('idx_workflow_history_sla_event')) {
    await executor.execute('ALTER TABLE workflow_transition_history ADD INDEX idx_workflow_history_sla_event (sla_event_enqueued_at, sla_due_at)');
  }
}

export async function ensureMysqlWorkflowHistorySequenceSchema(executor) {
  await ensureMysqlWorkflowAutomationSchema(executor);
  const [columns] = await executor.execute(`SELECT column_name FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'workflow_transition_history' AND column_name = 'sequence_id'`);
  if (!columns.length) {
    await executor.execute('ALTER TABLE workflow_transition_history ADD COLUMN sequence_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE AFTER id');
  }
}

const maps = {
  workflows: (row) => row && ({ createdAt: new Date(row.created_at).toISOString(), description: row.description, id: row.id, itemTypes: parseJson(row.item_types_json, []), name: row.name, states: parseJson(row.states_json, []), status: row.status, tenantId: row.tenant_id, transitions: parseJson(row.transitions_json, []), updatedAt: new Date(row.updated_at).toISOString(), version: Number(row.version) }),
  bindings: (row) => row && ({ createdAt: new Date(row.created_at).toISOString(), id: row.id, itemType: row.item_type, projectId: row.project_id, tenantId: row.tenant_id, updatedAt: new Date(row.updated_at).toISOString(), version: Number(row.version), workflowId: row.workflow_id }),
  approvals: (row) => row && ({ consumedAt: row.consumed_at ? new Date(row.consumed_at).toISOString() : null, createdAt: new Date(row.created_at).toISOString(), decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null, decidedBy: row.decided_by, decisionNote: row.decision_note, expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null, fromState: row.from_state, id: row.id, itemId: row.item_id, itemType: row.item_type, note: row.note, projectId: row.project_id, requestedBy: row.requested_by, status: row.status, tenantId: row.tenant_id, toState: row.to_state, transitionKey: row.transition_key, updatedAt: new Date(row.updated_at).toISOString(), version: Number(row.version) }),
  histories: (row) => row && ({ approvalId: row.approval_id, createdAt: new Date(row.created_at).toISOString(), fromState: row.from_state, id: row.id, itemId: row.item_id, itemType: row.item_type, occurredAt: new Date(row.occurred_at).toISOString(), projectId: row.project_id, sequenceId: Number(row.sequence_id ?? 0), slaDueAt: row.sla_due_at ? new Date(row.sla_due_at).toISOString() : null, slaEventEnqueuedAt: row.sla_event_enqueued_at ? new Date(row.sla_event_enqueued_at).toISOString() : null, tenantId: row.tenant_id, toState: row.to_state, transitionEventEnqueuedAt: row.transition_event_enqueued_at ? new Date(row.transition_event_enqueued_at).toISOString() : null, transitionKey: row.transition_key, updatedAt: new Date(row.updated_at).toISOString(), userId: row.user_id, version: Number(row.version) }),
  baselines: (row) => row && ({ capturedAt: new Date(row.captured_at).toISOString(), createdAt: new Date(row.created_at).toISOString(), createdBy: row.created_by, id: row.id, name: row.name, note: row.note, projectId: row.project_id, snapshot: parseJson(row.snapshot_json, {}), tenantId: row.tenant_id, updatedAt: new Date(row.updated_at).toISOString(), version: Number(row.version) }),
  templates: (row) => row && ({ createdAt: new Date(row.created_at).toISOString(), description: row.description, id: row.id, kind: row.template_kind, name: row.name, payload: parseJson(row.payload_json, {}), status: row.status, tenantId: row.tenant_id, updatedAt: new Date(row.updated_at).toISOString(), version: Number(row.version) }),
  customFields: (row) => row && ({ createdAt: new Date(row.created_at).toISOString(), description: row.description, fieldType: row.field_type, id: row.id, name: row.name, options: parseJson(row.options_json, []), required: Boolean(row.required), scope: row.scope, status: row.status, tenantId: row.tenant_id, updatedAt: new Date(row.updated_at).toISOString(), version: Number(row.version) }),
  customValues: (row) => row && ({ createdAt: new Date(row.created_at).toISOString(), fieldId: row.field_id, id: row.id, itemId: row.item_id, itemType: row.item_type, projectId: row.project_id, tenantId: row.tenant_id, updatedAt: new Date(row.updated_at).toISOString(), value: parseJson(row.value_json, null), version: Number(row.version) }),
};

export function createMysqlWorkflowRepository({ pool }) {
  async function select(table, id, tenantId, mapper) { const [rows] = await pool.execute(`SELECT * FROM ${table} WHERE id = ? AND tenant_id = ? LIMIT 1`, [id, tenantId]); return mapper(rows[0]); }
  async function insert(table, columns, values, tenantId, mapper) { const id = randomUUID(); const now = new Date(); await pool.execute(`INSERT INTO ${table} (id, tenant_id, ${columns.join(', ')}, version, created_at, updated_at) VALUES (?, ?, ${columns.map(() => '?').join(', ')}, 1, ?, ?)`, [id, tenantId, ...values, now, now]); return select(table, id, tenantId, mapper); }
  async function current(table, id, tenantId) { const [rows] = await pool.execute(`SELECT version FROM ${table} WHERE id = ? AND tenant_id = ? LIMIT 1`, [id, tenantId]); return rows[0] ? { version: Number(rows[0].version) } : null; }
  // Read back before the commit, while the update holds the row: a read after it could return
  // someone's edit made since as this write.
  async function update(table, id, tenantId, expectedVersion, assignments, values, mapper) { const record = await current(table, id, tenantId); if (!record) return null; const connection = await pool.getConnection(); try { await connection.beginTransaction(); const [result] = await connection.execute(`UPDATE ${table} SET ${assignments}, version = version + 1, updated_at = NOW(3) WHERE id = ? AND tenant_id = ? AND version = ?`, [...values, id, tenantId, expectedVersion]); if (Number(result.affectedRows) !== 1) conflict(record, expectedVersion); const [rows] = await connection.execute(`SELECT * FROM ${table} WHERE id = ? AND tenant_id = ? LIMIT 1`, [id, tenantId]); await connection.commit(); return mapper(rows[0]); } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); } }
  async function remove(table, id, expectedVersion, tenantId) { const record = await current(table, id, tenantId); if (!record) return false; const [result] = await pool.execute(`DELETE FROM ${table} WHERE id = ? AND tenant_id = ? AND version = ?`, [id, tenantId, expectedVersion]); if (Number(result.affectedRows) !== 1) conflict(record, expectedVersion); return true; }
  async function existing(table, id, tenantId, mapper) { return select(table, id, tenantId, mapper); }
  return {
    createBaseline: ({ createdBy, input, snapshot, tenantId }) => insert('project_baselines', ['project_id', 'name', 'note', 'snapshot_json', 'created_by', 'captured_at'], [input.projectId, input.name, input.note, JSON.stringify(snapshot), createdBy, new Date()], tenantId, maps.baselines),
    createBinding: async ({ input, tenantId }) => insert('project_workflow_bindings', ['project_id', 'item_type', 'workflow_id'], [input.projectId, input.itemType, input.workflowId], tenantId, maps.bindings),
    createCustomField: ({ input, tenantId }) => insert('custom_field_definitions', ['name', 'description', 'scope', 'field_type', 'options_json', 'required', 'status'], [input.name, input.description, input.scope, input.fieldType, JSON.stringify(input.options), input.required, input.status], tenantId, maps.customFields),
    createTemplate: ({ input, tenantId }) => insert('project_templates', ['name', 'description', 'template_kind', 'payload_json', 'status'], [input.name, input.description, input.kind, JSON.stringify(input.payload), input.status], tenantId, maps.templates),
    createWorkflow: ({ input, tenantId }) => insert('workflow_definitions', ['name', 'description', 'item_types_json', 'states_json', 'transitions_json', 'status'], [input.name, input.description, JSON.stringify(input.itemTypes), JSON.stringify(input.states), JSON.stringify(input.transitions), input.status], tenantId, maps.workflows),
    decideApproval: async ({ approvalId, decidedBy, input, tenantId }) => update('workflow_transition_approvals', approvalId, tenantId, input.expectedVersion, 'status = ?, decision_note = ?, decided_by = ?, decided_at = NOW(3)', [input.status, input.decisionNote, decidedBy], maps.approvals),
    deleteBinding: ({ bindingId, expectedVersion, tenantId }) => remove('project_workflow_bindings', bindingId, expectedVersion, tenantId),
    deleteCustomField: async ({ expectedVersion, fieldId, tenantId }) => { const [rows] = await pool.execute('SELECT COUNT(*) AS count FROM custom_field_values WHERE tenant_id = ? AND field_id = ?', [tenantId, fieldId]); if (Number(rows[0]?.count)) throw new HttpError(409, 'Remove custom-field values before deleting this definition.'); return remove('custom_field_definitions', fieldId, expectedVersion, tenantId); },
    deleteCustomValue: ({ expectedVersion, tenantId, valueId }) => remove('custom_field_values', valueId, expectedVersion, tenantId),
    deleteTemplate: ({ expectedVersion, templateId, tenantId }) => remove('project_templates', templateId, expectedVersion, tenantId),
    deleteWorkflow: async ({ expectedVersion, tenantId, workflowId }) => { const [rows] = await pool.execute('SELECT COUNT(*) AS count FROM project_workflow_bindings WHERE tenant_id = ? AND workflow_id = ?', [tenantId, workflowId]); if (Number(rows[0]?.count)) throw new HttpError(409, 'Remove project bindings before deleting this workflow.'); return remove('workflow_definitions', workflowId, expectedVersion, tenantId); },
    // Home: what listSnapshot holds for the given projects only. Histories are each item's
    // latest transition, and only when its SLA has passed (the overdue rule in
    // listPendingAutomationEvents). Custom fields, templates and baselines are not read.
    async listProjectWorkflowState({ now = new Date(), projectIds = [], tenantId }) {
      if (projectIds.length === 0) return { approvals: [], bindings: [], histories: [], workflows: [] };
      const marks = projectIds.map(() => '?').join(', ');
      const [bindingRows] = await pool.execute(`SELECT * FROM project_workflow_bindings WHERE tenant_id = ? AND project_id IN (${marks})`, [tenantId, ...projectIds]);
      const workflowIds = [...new Set(bindingRows.map((row) => row.workflow_id))];
      const [workflowRows] = workflowIds.length > 0 ? await pool.execute(`SELECT * FROM workflow_definitions WHERE tenant_id = ? AND id IN (${workflowIds.map(() => '?').join(', ')})`, [tenantId, ...workflowIds]) : [[]];
      const [approvalRows] = await pool.execute(`SELECT * FROM workflow_transition_approvals WHERE tenant_id = ? AND status = 'pending' AND project_id IN (${marks}) ORDER BY created_at, id`, [tenantId, ...projectIds]);
      const [historyRows] = await pool.execute(`SELECT history.* FROM workflow_transition_history history
        WHERE history.tenant_id = ? AND history.project_id IN (${marks})
          AND history.sla_due_at IS NOT NULL AND history.sla_due_at <= ?
          AND NOT EXISTS (SELECT 1 FROM workflow_transition_history newer
            WHERE newer.tenant_id = history.tenant_id AND newer.project_id = history.project_id
              AND newer.item_type = history.item_type AND newer.item_id = history.item_id
              AND newer.sequence_id > history.sequence_id)
        ORDER BY history.sequence_id LIMIT 1000`, [tenantId, ...projectIds, now]);
      return { approvals: approvalRows.map(maps.approvals), bindings: bindingRows.map(maps.bindings), histories: historyRows.map(maps.histories), workflows: workflowRows.map(maps.workflows) };
    },
    async listSnapshot({ tenantId }) { const specs = [['workflows', 'workflow_definitions'], ['bindings', 'project_workflow_bindings'], ['approvals', 'workflow_transition_approvals'], ['histories', 'workflow_transition_history'], ['baselines', 'project_baselines'], ['templates', 'project_templates'], ['customFields', 'custom_field_definitions'], ['customValues', 'custom_field_values']]; const result = {}; for (const [name, table] of specs) { const [rows] = await pool.execute(`SELECT * FROM ${table} WHERE tenant_id = ? ORDER BY created_at, id`, [tenantId]); result[name] = rows.map(maps[name]); } return result; },
    async listPendingAutomationEvents({ limit = 200, now = new Date() } = {}) {
      const boundedLimit = Math.max(1, Math.min(1000, Number.parseInt(limit, 10) || 200));
      const [transitionRows] = await pool.execute(`SELECT * FROM workflow_transition_history WHERE transition_event_enqueued_at IS NULL ORDER BY sequence_id LIMIT ${boundedLimit}`);
      const [slaRows] = await pool.execute(`SELECT history.* FROM workflow_transition_history history
        WHERE history.sla_event_enqueued_at IS NULL AND history.sla_due_at IS NOT NULL AND history.sla_due_at <= ?
          AND NOT EXISTS (SELECT 1 FROM workflow_transition_history newer
            WHERE newer.tenant_id = history.tenant_id AND newer.project_id = history.project_id
              AND newer.item_type = history.item_type AND newer.item_id = history.item_id
              AND newer.sequence_id > history.sequence_id)
        ORDER BY history.sequence_id LIMIT ${boundedLimit}`, [now]);
      return [
        ...transitionRows.map((row) => ({ eventType: 'workflow.transitioned', history: maps.histories(row) })),
        ...slaRows.map((row) => ({ eventType: 'workflow.sla.overdue', history: maps.histories(row) })),
      ].sort((left, right) => left.history.sequenceId - right.history.sequenceId || left.eventType.localeCompare(right.eventType)).slice(0, boundedLimit);
    },
    async markAutomationEventEnqueued({ enqueuedAt = new Date(), eventType, historyId }) {
      const column = eventType === 'workflow.sla.overdue' ? 'sla_event_enqueued_at' : 'transition_event_enqueued_at';
      const [result] = await pool.execute(`UPDATE workflow_transition_history SET ${column} = COALESCE(${column}, ?), updated_at = ? WHERE id = ?`, [enqueuedAt, enqueuedAt, historyId]);
      return Number(result.affectedRows) === 1;
    },
    async recordTransition({ approvalId = null, fromState, itemId, itemType, projectId, slaDueAt = null, tenantId, toState, transitionKey, userId }) { if (approvalId) await pool.execute(`UPDATE workflow_transition_approvals SET status = 'consumed', consumed_at = NOW(3), version = version + 1, updated_at = NOW(3) WHERE id = ? AND tenant_id = ? AND status = 'approved'`, [approvalId, tenantId]); return insert('workflow_transition_history', ['project_id', 'item_type', 'item_id', 'transition_key', 'from_state', 'to_state', 'user_id', 'approval_id', 'occurred_at', 'sla_due_at'], [projectId, itemType, itemId, transitionKey, fromState, toState, userId, approvalId, new Date(), slaDueAt ? new Date(slaDueAt) : null], tenantId, maps.histories); },
    requestApproval: ({ input, requestedBy, tenantId }) => insert('workflow_transition_approvals', ['project_id', 'item_type', 'item_id', 'transition_key', 'from_state', 'to_state', 'status', 'note', 'decision_note', 'requested_by', 'decided_by', 'expires_at', 'decided_at', 'consumed_at'], [input.projectId, input.itemType, input.itemId, input.transitionKey, input.fromState, input.toState, 'pending', input.note, '', requestedBy, null, input.expiresAt ? new Date(input.expiresAt) : null, null, null], tenantId, maps.approvals),
    async updateBinding({ bindingId, input, tenantId }) { const old = await existing('project_workflow_bindings', bindingId, tenantId, maps.bindings); if (!old) return null; const next = { ...old, ...input }; return update('project_workflow_bindings', bindingId, tenantId, input.expectedVersion, 'project_id = ?, item_type = ?, workflow_id = ?', [next.projectId, next.itemType, next.workflowId], maps.bindings); },
    async updateCustomField({ fieldId, input, tenantId }) { const old = await existing('custom_field_definitions', fieldId, tenantId, maps.customFields); if (!old) return null; const next = { ...old, ...input }; return update('custom_field_definitions', fieldId, tenantId, input.expectedVersion, 'name = ?, description = ?, options_json = ?, required = ?, status = ?', [next.name, next.description, JSON.stringify(next.options), next.required, next.status], maps.customFields); },
    async updateTemplate({ input, templateId, tenantId }) { const old = await existing('project_templates', templateId, tenantId, maps.templates); if (!old) return null; const next = { ...old, ...input }; return update('project_templates', templateId, tenantId, input.expectedVersion, 'name = ?, description = ?, template_kind = ?, payload_json = ?, status = ?', [next.name, next.description, next.kind, JSON.stringify(next.payload), next.status], maps.templates); },
    async updateWorkflow({ input, tenantId, workflowId }) { const old = await existing('workflow_definitions', workflowId, tenantId, maps.workflows); if (!old) return null; const next = { ...old, ...input }; return update('workflow_definitions', workflowId, tenantId, input.expectedVersion, 'name = ?, description = ?, item_types_json = ?, states_json = ?, transitions_json = ?, status = ?', [next.name, next.description, JSON.stringify(next.itemTypes), JSON.stringify(next.states), JSON.stringify(next.transitions), next.status], maps.workflows); },
    async upsertCustomValue({ input, tenantId }) { const [rows] = await pool.execute('SELECT * FROM custom_field_values WHERE tenant_id = ? AND project_id = ? AND item_id = ? AND field_id = ? LIMIT 1', [tenantId, input.projectId, input.itemId, input.fieldId]); const old = maps.customValues(rows[0]); if (!old) { if (input.expectedVersion != null) return null; return insert('custom_field_values', ['project_id', 'item_type', 'item_id', 'field_id', 'value_json'], [input.projectId, input.itemType, input.itemId, input.fieldId, JSON.stringify(input.value)], tenantId, maps.customValues); } if (input.expectedVersion == null) conflict(old, null); return update('custom_field_values', old.id, tenantId, input.expectedVersion, 'value_json = ?', [JSON.stringify(input.value)], maps.customValues); },
  };
}
