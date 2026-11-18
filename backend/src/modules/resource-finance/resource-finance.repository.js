import { randomUUID } from 'node:crypto';

import { HttpError } from '../../lib/errors/http-error.js';
import { timeEntryInvoicedError } from '../../lib/errors/time-entry-invoiced.js';

function clone(value) { return structuredClone(value); }
function nowIso() { return new Date().toISOString(); }
function dateOnly(value) { return value ? new Date(value).toISOString().slice(0, 10) : null; }
function parseJson(value, fallback = []) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function conflict(record, expectedVersion) {
  throw new HttpError(409, 'Resource or financial record changed since it was loaded.', {
    details: { actualVersion: record.version, code: 'resource_finance_version_conflict', expectedVersion },
  });
}

function immutable(record) {
  if (['posted', 'void'].includes(record?.status)) {
    throw new HttpError(409, 'Posted financial entries are immutable. Record a compensating entry instead.');
  }
}

function levelingValues(source, hours, targetResourceId) {
  const sourceHours = Number(source.hoursPerWeek);
  if (targetResourceId === source.resourceId) throw new HttpError(400, 'The target resource must differ from the assigned resource.');
  if (hours > sourceHours) throw new HttpError(400, 'Leveling hours cannot exceed the source allocation.');
  const movedPercent = sourceHours ? Math.round((Number(source.allocationPercent) * hours / sourceHours) * 100) / 100 : 0;
  return {
    fullMove: Math.abs(hours - sourceHours) < 0.0001,
    movedPercent,
    sourceHours,
    target: { ...source, allocationPercent: movedPercent, hoursPerWeek: hours, resourceId: targetResourceId },
  };
}
// Merging two profiles of one person moves their time to the profile that stays. That changes no
// billed hours, so it is the one change a claimed entry takes.
function resourceMergeOnly(input, resourceMerge) {
  return resourceMerge && Object.keys(input ?? {}).every((key) => ['expectedVersion', 'resourceId'].includes(key));
}
function calendarInput(input = {}) { return { ...input, timezone: input.timezone ?? 'UTC', weekdays: input.weekdays ?? [1, 2, 3, 4, 5] }; }

export function createInMemoryResourceFinanceRepository() {
  const collections = {
    accountingPeriods: new Map(),
    allocations: new Map(),
    calendarEntries: new Map(),
    exchangeRates: new Map(),
    expenseReceipts: new Map(),
    expenses: new Map(),
    financialEntries: new Map(),
    financePolicies: new Map(),
    pools: new Map(),
    resources: new Map(),
    resourceRates: new Map(),
    timeEntries: new Map(),
    timesheetPeriods: new Map(),
  };

  function create(collection, input, tenantId) {
    const now = nowIso();
    const record = { ...clone(input), createdAt: now, id: randomUUID(), tenantId, updatedAt: now, version: 1 };
    collection.set(record.id, record);
    return clone(record);
  }

  function update(collection, id, input, tenantId, { immutableFinancial = false } = {}) {
    const record = collection.get(id);
    if (!record || record.tenantId !== tenantId) return null;
    if (immutableFinancial) immutable(record);
    if (record.version !== input.expectedVersion) conflict(record, input.expectedVersion);
    const { expectedVersion: _expectedVersion, ...changes } = input;
    Object.assign(record, clone(changes), { updatedAt: nowIso(), version: record.version + 1 });
    return clone(record);
  }

  function remove(collection, id, expectedVersion, tenantId, { immutableFinancial = false } = {}) {
    const record = collection.get(id);
    if (!record || record.tenantId !== tenantId) return false;
    if (immutableFinancial) immutable(record);
    if (record.version !== expectedVersion) conflict(record, expectedVersion);
    collection.delete(id);
    return true;
  }

  function list(collection, tenantId) {
    return clone([...collection.values()].filter((record) => record.tenantId === tenantId));
  }

  return {
    async applyLevelingRecommendation({ allocationId, expectedVersion, hours, targetResourceId, tenantId }) {
      const source = collections.allocations.get(allocationId);
      if (!source || source.tenantId !== tenantId) return null;
      if (source.version !== expectedVersion) conflict(source, expectedVersion);
      const targetResource = collections.resources.get(targetResourceId);
      if (!targetResource || targetResource.tenantId !== tenantId || targetResource.status !== 'active') throw new HttpError(404, 'Target resource not found.');
      const values = levelingValues(source, hours, targetResourceId);
      if (values.fullMove) {
        Object.assign(source, { resourceId: targetResourceId, updatedAt: nowIso(), version: source.version + 1 });
        return { movedHours: hours, sourceAllocation: null, targetAllocation: clone(source) };
      }
      const now = nowIso();
      Object.assign(source, {
        allocationPercent: Math.round((Number(source.allocationPercent) - values.movedPercent) * 100) / 100,
        hoursPerWeek: Math.round((values.sourceHours - hours) * 100) / 100,
        updatedAt: now,
        version: source.version + 1,
      });
      const target = { ...clone(values.target), createdAt: now, id: randomUUID(), tenantId, updatedAt: now, version: 1 };
      collections.allocations.set(target.id, target);
      return { movedHours: hours, sourceAllocation: clone(source), targetAllocation: clone(target) };
    },
    createAllocation: async ({ input, tenantId }) => create(collections.allocations, input, tenantId),
    createAccountingPeriod: async ({ input, tenantId }) => create(collections.accountingPeriods, input, tenantId),
    createCalendarEntry: async ({ input, tenantId }) => create(collections.calendarEntries, calendarInput(input), tenantId),
    createExchangeRate: async ({ input, tenantId }) => create(collections.exchangeRates, input, tenantId),
    createExpense: async ({ input, tenantId }) => create(collections.expenses, input, tenantId),
    createExpenseReceipt: async ({ input, tenantId }) => create(collections.expenseReceipts, input, tenantId),
    createFinancialEntry: async ({ input, tenantId }) => create(collections.financialEntries, input, tenantId),
    createFinancePolicy: async ({ input, tenantId }) => create(collections.financePolicies, input, tenantId),
    createPool: async ({ input, tenantId }) => create(collections.pools, input, tenantId),
    createResource: async ({ input, tenantId }) => create(collections.resources, input, tenantId),
    createResourceRate: async ({ input, tenantId }) => create(collections.resourceRates, input, tenantId),
    createTimeEntry: async ({ input, tenantId }) => create(collections.timeEntries, input, tenantId),
    createTimesheetPeriod: async ({ input, tenantId }) => create(collections.timesheetPeriods, input, tenantId),
    deleteAllocation: async ({ allocationId, expectedVersion, tenantId }) => remove(collections.allocations, allocationId, expectedVersion, tenantId),
    deleteAccountingPeriod: async ({ accountingPeriodId, expectedVersion, tenantId }) => remove(collections.accountingPeriods, accountingPeriodId, expectedVersion, tenantId),
    deleteCalendarEntry: async ({ calendarEntryId, expectedVersion, tenantId }) => remove(collections.calendarEntries, calendarEntryId, expectedVersion, tenantId),
    deleteExchangeRate: async ({ exchangeRateId, expectedVersion, tenantId }) => remove(collections.exchangeRates, exchangeRateId, expectedVersion, tenantId),
    deleteExpense: async ({ expenseId, expectedVersion, tenantId }) => {
      if ([...collections.expenseReceipts.values()].some((record) => record.tenantId === tenantId && record.expenseId === expenseId && record.status !== 'deleted')) throw new HttpError(409, 'Delete or detach active receipts before deleting the expense.');
      return remove(collections.expenses, expenseId, expectedVersion, tenantId);
    },
    deleteExpenseReceipt: async ({ expenseReceiptId, expectedVersion, tenantId }) => remove(collections.expenseReceipts, expenseReceiptId, expectedVersion, tenantId),
    deleteFinancialEntry: async ({ expectedVersion, financialEntryId, tenantId }) => remove(collections.financialEntries, financialEntryId, expectedVersion, tenantId, { immutableFinancial: true }),
    deleteFinancePolicy: async ({ expectedVersion, financePolicyId, tenantId }) => remove(collections.financePolicies, financePolicyId, expectedVersion, tenantId),
    deletePool: async ({ expectedVersion, poolId, tenantId }) => {
      if ([...collections.resources.values()].some((record) => record.tenantId === tenantId && record.poolId === poolId)) {
        throw new HttpError(409, 'Move resources out of this pool before deleting it.');
      }
      return remove(collections.pools, poolId, expectedVersion, tenantId);
    },
    deleteResource: async ({ expectedVersion, resourceId, tenantId }) => {
      const dependent = ['allocations', 'calendarEntries', 'expenses', 'resourceRates', 'timeEntries']
        .some((name) => [...collections[name].values()].some((record) => record.tenantId === tenantId && record.resourceId === resourceId));
      if (dependent) throw new HttpError(409, 'Resource records with allocations, calendar, time, or expense entries cannot be deleted.');
      return remove(collections.resources, resourceId, expectedVersion, tenantId);
    },
    deleteResourceRate: async ({ expectedVersion, resourceRateId, tenantId }) => remove(collections.resourceRates, resourceRateId, expectedVersion, tenantId),
    // ownSubmitted: a person deleting their own time, which must still be theirs, still submitted, and
    // in an open period (or none) when it goes.
    // An entry an invoice holds stays: see lib/errors/time-entry-invoiced.js.
    deleteTimeEntry: async ({ expectedVersion, ownSubmitted = null, tenantId, timeEntryId }) => {
      const entry = collections.timeEntries.get(timeEntryId);
      if (ownSubmitted && entry?.tenantId === tenantId && entry.resourceId !== ownSubmitted.resourceId) return false;
      if (entry?.tenantId === tenantId && entry.invoiceClaimId) throw timeEntryInvoicedError();
      if (ownSubmitted && entry?.tenantId === tenantId) {
        if (entry.status !== 'submitted') return false;
        const period = entry.periodId ? collections.timesheetPeriods.get(entry.periodId) : null;
        if (period && period.status !== 'open') throw new HttpError(423, `The ${period.name} timesheet period is ${period.status}.`);
      }
      return remove(collections.timeEntries, timeEntryId, expectedVersion, tenantId);
    },
    deleteTimesheetPeriod: async ({ expectedVersion, tenantId, timesheetPeriodId }) => {
      if ([...collections.timeEntries.values()].some((record) => record.tenantId === tenantId && record.periodId === timesheetPeriodId)) throw new HttpError(409, 'Timesheet periods with time entries cannot be deleted.');
      return remove(collections.timesheetPeriods, timesheetPeriodId, expectedVersion, tenantId);
    },
    listSnapshot: async ({ tenantId }) => Object.fromEntries(Object.entries(collections).map(([name, collection]) => [name, list(collection, tenantId)])),
    // The reads a task access link makes on every request, without the whole snapshot.
    listAllocationsForResources: async ({ resourceIds, tenantId }) => list(collections.allocations, tenantId).filter((record) => resourceIds.includes(record.resourceId)),
    listResourcesByEmail: async ({ email, tenantId }) => list(collections.resources, tenantId).filter((record) => record.email && record.email === String(email ?? '').trim().toLowerCase()),
    listTimeEntries: async ({ projectId, resourceId, tenantId, workItemId }) => list(collections.timeEntries, tenantId)
      .filter((record) => record.projectId === projectId && record.resourceId === resourceId && record.workItemId === workItemId),
    updateAllocation: async ({ allocationId, input, tenantId }) => update(collections.allocations, allocationId, input, tenantId),
    updateAccountingPeriod: async ({ accountingPeriodId, input, tenantId }) => update(collections.accountingPeriods, accountingPeriodId, input, tenantId),
    updateCalendarEntry: async ({ calendarEntryId, input, tenantId }) => update(collections.calendarEntries, calendarEntryId, calendarInput(input), tenantId),
    updateExchangeRate: async ({ exchangeRateId, input, tenantId }) => update(collections.exchangeRates, exchangeRateId, input, tenantId),
    updateExpense: async ({ expenseId, input, tenantId }) => update(collections.expenses, expenseId, input, tenantId),
    updateExpenseReceipt: async ({ expenseReceiptId, input, tenantId }) => update(collections.expenseReceipts, expenseReceiptId, input, tenantId),
    updateFinancialEntry: async ({ financialEntryId, input, tenantId }) => update(collections.financialEntries, financialEntryId, input, tenantId, { immutableFinancial: true }),
    updateFinancePolicy: async ({ financePolicyId, input, tenantId }) => update(collections.financePolicies, financePolicyId, input, tenantId),
    updatePool: async ({ input, poolId, tenantId }) => update(collections.pools, poolId, input, tenantId),
    updateResource: async ({ input, resourceId, tenantId }) => update(collections.resources, resourceId, input, tenantId),
    updateResourceRate: async ({ input, resourceRateId, tenantId }) => update(collections.resourceRates, resourceRateId, input, tenantId),
    updateTimeEntry: async ({ input, resourceMerge = false, tenantId, timeEntryId }) => {
      const entry = collections.timeEntries.get(timeEntryId);
      if (entry?.tenantId === tenantId && entry.invoiceClaimId && !resourceMergeOnly(input, resourceMerge)) throw timeEntryInvoicedError();
      return update(collections.timeEntries, timeEntryId, input, tenantId);
    },
    // The live time entry records, for the in-memory billing repository only: it claims and releases
    // entries in place, as the MySQL one updates project_time_entries in its own transaction.
    billingTimeEntryStore: () => collections.timeEntries,
    updateTimesheetPeriod: async ({ input, tenantId, timesheetPeriodId }) => update(collections.timesheetPeriods, timesheetPeriodId, input, tenantId),
  };
}

export async function ensureMysqlResourceFinanceSchema(executor) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS resource_pools (
      id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, name VARCHAR(240) NOT NULL, description TEXT NOT NULL,
      manager_id VARCHAR(128) NULL, status VARCHAR(32) NOT NULL, version INT NOT NULL DEFAULT 1,
      created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
      UNIQUE KEY uq_resource_pool_name (tenant_id, name), KEY idx_resource_pool_status (tenant_id, status)
    )`,
    `CREATE TABLE IF NOT EXISTS enterprise_resources (
      id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, user_id VARCHAR(128) NULL, pool_id VARCHAR(36) NULL,
      name VARCHAR(240) NOT NULL, location VARCHAR(240) NOT NULL, roles_json JSON NOT NULL, skills_json JSON NOT NULL,
      capacity_hours_per_week DECIMAL(8,2) NOT NULL, cost_rate DECIMAL(18,4) NOT NULL, bill_rate DECIMAL(18,4) NOT NULL,
      currency CHAR(3) NOT NULL, status VARCHAR(32) NOT NULL, version INT NOT NULL DEFAULT 1,
      created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
      KEY idx_enterprise_resource_pool (tenant_id, pool_id, status), KEY idx_enterprise_resource_user (tenant_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS resource_calendar_entries (
      id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, resource_id VARCHAR(36) NOT NULL,
      entry_type VARCHAR(32) NOT NULL, start_date DATE NOT NULL, end_date DATE NOT NULL, hours_per_day DECIMAL(6,2) NOT NULL,
      status VARCHAR(32) NOT NULL, note TEXT NOT NULL, version INT NOT NULL DEFAULT 1,
      created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
      KEY idx_resource_calendar_range (tenant_id, resource_id, start_date, end_date, status)
    )`,
    `CREATE TABLE IF NOT EXISTS resource_allocations (
      id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, project_id VARCHAR(128) NOT NULL, resource_id VARCHAR(36) NOT NULL,
      start_date DATE NOT NULL, end_date DATE NOT NULL, allocation_percent DECIMAL(8,2) NOT NULL, hours_per_week DECIMAL(8,2) NOT NULL,
      role_name VARCHAR(120) NOT NULL, scenario VARCHAR(32) NOT NULL, status VARCHAR(32) NOT NULL, version INT NOT NULL DEFAULT 1,
      created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
      KEY idx_resource_allocation_project (tenant_id, project_id, scenario, status),
      KEY idx_resource_allocation_capacity (tenant_id, resource_id, start_date, end_date, scenario)
    )`,
    `CREATE TABLE IF NOT EXISTS project_financial_entries (
      id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, project_id VARCHAR(128) NOT NULL,
      entry_kind VARCHAR(32) NOT NULL, category VARCHAR(160) NOT NULL, amount DECIMAL(20,4) NOT NULL, currency CHAR(3) NOT NULL,
      effective_date DATE NOT NULL, source_type VARCHAR(120) NOT NULL, source_id VARCHAR(128) NULL, status VARCHAR(32) NOT NULL,
      note TEXT NOT NULL, version INT NOT NULL DEFAULT 1, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
      KEY idx_financial_project_date (tenant_id, project_id, effective_date, entry_kind, status),
      KEY idx_financial_source (tenant_id, source_type, source_id)
    )`,
    `CREATE TABLE IF NOT EXISTS project_time_entries (
      id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, project_id VARCHAR(128) NOT NULL,
      resource_id VARCHAR(36) NOT NULL, work_item_id VARCHAR(128) NULL, work_date DATE NOT NULL, hours DECIMAL(8,2) NOT NULL,
      billable BOOLEAN NOT NULL, status VARCHAR(32) NOT NULL, note TEXT NOT NULL, version INT NOT NULL DEFAULT 1,
      created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
      KEY idx_time_project_date (tenant_id, project_id, work_date, status), KEY idx_time_resource_date (tenant_id, resource_id, work_date)
    )`,
    `CREATE TABLE IF NOT EXISTS project_expense_entries (
      id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, project_id VARCHAR(128) NOT NULL, resource_id VARCHAR(36) NULL,
      expense_date DATE NOT NULL, category VARCHAR(160) NOT NULL, amount DECIMAL(20,4) NOT NULL, currency CHAR(3) NOT NULL,
      receipt_reference VARCHAR(500) NOT NULL, status VARCHAR(32) NOT NULL, note TEXT NOT NULL, version INT NOT NULL DEFAULT 1,
      created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
      KEY idx_expense_project_date (tenant_id, project_id, expense_date, status)
    )`,
  ];
  for (const statement of statements) await executor.execute(statement);
}

export async function ensureMysqlResourceFinanceAdvancedSchema(executor) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS resource_rate_history (
      id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, resource_id VARCHAR(36) NOT NULL,
      effective_start DATE NOT NULL, effective_end DATE NULL, cost_rate DECIMAL(18,4) NOT NULL,
      bill_rate DECIMAL(18,4) NOT NULL, currency CHAR(3) NOT NULL, status VARCHAR(32) NOT NULL,
      version INT NOT NULL DEFAULT 1, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
      KEY idx_resource_rate_effective (tenant_id, resource_id, effective_start, effective_end, status)
    )`,
    `CREATE TABLE IF NOT EXISTS timesheet_periods (
      id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, name VARCHAR(160) NOT NULL,
      start_date DATE NOT NULL, end_date DATE NOT NULL, approval_due_date DATE NULL, status VARCHAR(32) NOT NULL,
      version INT NOT NULL DEFAULT 1, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
      KEY idx_timesheet_period_range (tenant_id, start_date, end_date, status)
    )`,
    `CREATE TABLE IF NOT EXISTS expense_receipts (
      id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, expense_id VARCHAR(36) NOT NULL,
      storage_key VARCHAR(500) NOT NULL, file_name VARCHAR(240) NOT NULL, content_type VARCHAR(160) NOT NULL,
      size_bytes BIGINT UNSIGNED NOT NULL, sha256 CHAR(64) NOT NULL, status VARCHAR(32) NOT NULL,
      version INT NOT NULL DEFAULT 1, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
      KEY idx_expense_receipt_expense (tenant_id, expense_id, status), UNIQUE KEY uq_expense_receipt_storage (tenant_id, storage_key)
    )`,
    `CREATE TABLE IF NOT EXISTS currency_exchange_rates (
      id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, base_currency CHAR(3) NOT NULL,
      quote_currency CHAR(3) NOT NULL, rate DECIMAL(24,10) NOT NULL, effective_date DATE NOT NULL,
      source VARCHAR(160) NOT NULL, status VARCHAR(32) NOT NULL, version INT NOT NULL DEFAULT 1,
      created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
      UNIQUE KEY uq_currency_rate (tenant_id, base_currency, quote_currency, effective_date, source),
      KEY idx_currency_rate_effective (tenant_id, effective_date, status)
    )`,
  ];
  for (const statement of statements) await executor.execute(statement);
  const [columns] = await executor.execute("SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'project_time_entries' AND column_name = 'period_id'");
  if (!columns.length) await executor.execute('ALTER TABLE project_time_entries ADD COLUMN period_id VARCHAR(36) NULL AFTER resource_id, ADD KEY idx_time_period (tenant_id, period_id, status)');
}

// 0087_resource_links: resource profiles carry a minimum bill rate; project allocations carry the
// project's rate and whether Odin added them because the person was assigned work.
export async function ensureMysqlResourceLinkSchema(executor) {
  await ensureMysqlResourceFinanceSchema(executor);
  const [columns] = await executor.execute("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND ((table_name = 'enterprise_resources' AND column_name = 'min_bill_rate') OR (table_name = 'resource_allocations' AND column_name IN ('bill_rate', 'origin')))");
  const names = new Set(columns.map((row) => `${row.table_name ?? row.TABLE_NAME}.${row.column_name ?? row.COLUMN_NAME}`));
  if (!names.has('enterprise_resources.min_bill_rate')) await executor.execute('ALTER TABLE enterprise_resources ADD COLUMN min_bill_rate DECIMAL(18,4) NULL AFTER bill_rate');
  if (!names.has('resource_allocations.bill_rate')) await executor.execute('ALTER TABLE resource_allocations ADD COLUMN bill_rate DECIMAL(18,4) NULL AFTER hours_per_week');
  if (!names.has('resource_allocations.origin')) await executor.execute("ALTER TABLE resource_allocations ADD COLUMN origin VARCHAR(32) NOT NULL DEFAULT 'manual' AFTER status");
}

// 0080_resource_email: where a profile without a login gets its task access link, looked up by
// workspace and address.
export async function ensureMysqlResourceEmailSchema(executor) {
  const [columns] = await executor.execute("SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'enterprise_resources' AND column_name = 'email'");
  if (!columns.length) await executor.execute('ALTER TABLE enterprise_resources ADD COLUMN email VARCHAR(255) NULL AFTER user_id, ADD KEY idx_enterprise_resource_email (tenant_id, email)');
}

export async function ensureMysqlResourceCalendarRecurrenceSchema(executor) {
  await ensureMysqlResourceFinanceSchema(executor);
  const [columns] = await executor.execute("SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'resource_calendar_entries' AND column_name IN ('weekdays_json', 'timezone')");
  const names = new Set(columns.map((row) => row.column_name ?? row.COLUMN_NAME));
  const addedWeekdays = !names.has('weekdays_json');
  if (addedWeekdays) await executor.execute("ALTER TABLE resource_calendar_entries ADD COLUMN weekdays_json JSON NULL AFTER note");
  if (!names.has('timezone')) await executor.execute("ALTER TABLE resource_calendar_entries ADD COLUMN timezone VARCHAR(80) NOT NULL DEFAULT 'UTC' AFTER weekdays_json");
  if (addedWeekdays) {
    await executor.execute("UPDATE resource_calendar_entries SET weekdays_json = JSON_ARRAY(1,2,3,4,5) WHERE weekdays_json IS NULL");
    await executor.execute('ALTER TABLE resource_calendar_entries MODIFY COLUMN weekdays_json JSON NOT NULL');
  }
}

export async function ensureMysqlResourceFinanceControlsSchema(executor) {
  await ensureMysqlResourceFinanceSchema(executor);
  await executor.execute(`CREATE TABLE IF NOT EXISTS accounting_periods (
    id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, name VARCHAR(160) NOT NULL,
    fiscal_year INT NOT NULL, period_number INT NOT NULL, start_date DATE NOT NULL, end_date DATE NOT NULL,
    status VARCHAR(32) NOT NULL, version INT NOT NULL DEFAULT 1, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_accounting_period_number (tenant_id, fiscal_year, period_number),
    KEY idx_accounting_period_range (tenant_id, start_date, end_date, status)
  )`);
  await executor.execute(`CREATE TABLE IF NOT EXISTS finance_control_policies (
    id VARCHAR(36) PRIMARY KEY, tenant_id VARCHAR(36) NOT NULL, project_id VARCHAR(128) NULL, name VARCHAR(160) NOT NULL,
    actual_cost_variance_percent DECIMAL(8,2) NOT NULL, forecast_variance_percent DECIMAL(8,2) NOT NULL,
    minimum_margin_percent DECIMAL(8,2) NOT NULL, expense_approval_amount DECIMAL(20,4) NOT NULL,
    status VARCHAR(32) NOT NULL, version INT NOT NULL DEFAULT 1, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
    KEY idx_finance_policy_scope (tenant_id, project_id, status)
  )`);
}

const maps = {
  accountingPeriods: (row) => row && ({ createdAt: new Date(row.created_at).toISOString(), endDate: dateOnly(row.end_date), fiscalYear: Number(row.fiscal_year), id: row.id, name: row.name, periodNumber: Number(row.period_number), startDate: dateOnly(row.start_date), status: row.status, tenantId: row.tenant_id, updatedAt: new Date(row.updated_at).toISOString(), version: Number(row.version) }),
  allocations: (row) => row && ({ allocationPercent: Number(row.allocation_percent), billRate: row.bill_rate == null ? null : Number(row.bill_rate), createdAt: new Date(row.created_at).toISOString(), endDate: dateOnly(row.end_date), hoursPerWeek: Number(row.hours_per_week), id: row.id, origin: row.origin ?? 'manual', projectId: row.project_id, resourceId: row.resource_id, role: row.role_name, scenario: row.scenario, startDate: dateOnly(row.start_date), status: row.status, tenantId: row.tenant_id, updatedAt: new Date(row.updated_at).toISOString(), version: Number(row.version) }),
  calendarEntries: (row) => row && ({ createdAt: new Date(row.created_at).toISOString(), endDate: dateOnly(row.end_date), entryType: row.entry_type, hoursPerDay: Number(row.hours_per_day), id: row.id, note: row.note, resourceId: row.resource_id, startDate: dateOnly(row.start_date), status: row.status, tenantId: row.tenant_id, timezone: row.timezone ?? 'UTC', updatedAt: new Date(row.updated_at).toISOString(), version: Number(row.version), weekdays: parseJson(row.weekdays_json, [1, 2, 3, 4, 5]) }),
  exchangeRates: (row) => row && ({ baseCurrency: row.base_currency, createdAt: new Date(row.created_at).toISOString(), effectiveDate: dateOnly(row.effective_date), id: row.id, quoteCurrency: row.quote_currency, rate: Number(row.rate), source: row.source, status: row.status, tenantId: row.tenant_id, updatedAt: new Date(row.updated_at).toISOString(), version: Number(row.version) }),
  expenseReceipts: (row) => row && ({ contentType: row.content_type, createdAt: new Date(row.created_at).toISOString(), expenseId: row.expense_id, fileName: row.file_name, id: row.id, sha256: row.sha256, sizeBytes: Number(row.size_bytes), status: row.status, storageKey: row.storage_key, tenantId: row.tenant_id, updatedAt: new Date(row.updated_at).toISOString(), version: Number(row.version) }),
  expenses: (row) => row && ({ amount: Number(row.amount), category: row.category, createdAt: new Date(row.created_at).toISOString(), currency: row.currency, expenseDate: dateOnly(row.expense_date), id: row.id, note: row.note, projectId: row.project_id, receiptReference: row.receipt_reference, resourceId: row.resource_id, status: row.status, tenantId: row.tenant_id, updatedAt: new Date(row.updated_at).toISOString(), version: Number(row.version) }),
  financialEntries: (row) => row && ({ amount: Number(row.amount), category: row.category, createdAt: new Date(row.created_at).toISOString(), currency: row.currency, effectiveDate: dateOnly(row.effective_date), entryKind: row.entry_kind, id: row.id, note: row.note, projectId: row.project_id, sourceId: row.source_id, sourceType: row.source_type, status: row.status, tenantId: row.tenant_id, updatedAt: new Date(row.updated_at).toISOString(), version: Number(row.version) }),
  financePolicies: (row) => row && ({ actualCostVariancePercent: Number(row.actual_cost_variance_percent), createdAt: new Date(row.created_at).toISOString(), expenseApprovalAmount: Number(row.expense_approval_amount), forecastVariancePercent: Number(row.forecast_variance_percent), id: row.id, minimumMarginPercent: Number(row.minimum_margin_percent), name: row.name, projectId: row.project_id, status: row.status, tenantId: row.tenant_id, updatedAt: new Date(row.updated_at).toISOString(), version: Number(row.version) }),
  pools: (row) => row && ({ createdAt: new Date(row.created_at).toISOString(), description: row.description, id: row.id, managerId: row.manager_id, name: row.name, status: row.status, tenantId: row.tenant_id, updatedAt: new Date(row.updated_at).toISOString(), version: Number(row.version) }),
  resources: (row) => row && ({ billRate: Number(row.bill_rate), capacityHoursPerWeek: Number(row.capacity_hours_per_week), costRate: Number(row.cost_rate), createdAt: new Date(row.created_at).toISOString(), currency: row.currency, email: row.email ?? null, id: row.id, location: row.location, minBillRate: row.min_bill_rate == null ? null : Number(row.min_bill_rate), name: row.name, poolId: row.pool_id, roles: parseJson(row.roles_json), skills: parseJson(row.skills_json), status: row.status, tenantId: row.tenant_id, updatedAt: new Date(row.updated_at).toISOString(), userId: row.user_id, version: Number(row.version) }),
  resourceRates: (row) => row && ({ billRate: Number(row.bill_rate), costRate: Number(row.cost_rate), createdAt: new Date(row.created_at).toISOString(), currency: row.currency, effectiveEnd: dateOnly(row.effective_end), effectiveStart: dateOnly(row.effective_start), id: row.id, resourceId: row.resource_id, status: row.status, tenantId: row.tenant_id, updatedAt: new Date(row.updated_at).toISOString(), version: Number(row.version) }),
  // invoice: the invoice that claimed the entry, when the row was read with TIME_ENTRY_SELECT.
  timeEntries: (row) => row && ({ billable: Boolean(row.billable), createdAt: new Date(row.created_at).toISOString(), hours: Number(row.hours), id: row.id, invoice: claimedInvoice(row), invoiceClaimId: row.invoice_claim_id ?? null, note: row.note, periodId: row.period_id, projectId: row.project_id, resourceId: row.resource_id, status: row.status, tenantId: row.tenant_id, updatedAt: new Date(row.updated_at).toISOString(), version: Number(row.version), workDate: dateOnly(row.work_date), workItemId: row.work_item_id }),
  timesheetPeriods: (row) => row && ({ approvalDueDate: dateOnly(row.approval_due_date), createdAt: new Date(row.created_at).toISOString(), endDate: dateOnly(row.end_date), id: row.id, name: row.name, startDate: dateOnly(row.start_date), status: row.status, tenantId: row.tenant_id, updatedAt: new Date(row.updated_at).toISOString(), version: Number(row.version) }),
};

// Time entries with the invoice that claimed each one (0099_billing).
const TIME_ENTRY_SELECT = `SELECT t.*, c.external_invoice_id AS claim_external_invoice_id, COALESCE(i.number, c.invoice_number) AS claim_invoice_number,
  i.status AS claim_invoice_status, i.url AS claim_invoice_url
  FROM project_time_entries t
  LEFT JOIN time_entry_invoice_claims c ON c.id = t.invoice_claim_id AND c.tenant_id = t.tenant_id
  LEFT JOIN project_external_invoices i ON i.tenant_id = c.tenant_id AND i.provider = c.provider AND i.external_id = c.external_invoice_id`;

function claimedInvoice(row) {
  if (!row?.invoice_claim_id) return null;
  return {
    externalInvoiceId: row.claim_external_invoice_id ?? null,
    number: row.claim_invoice_number || null,
    status: row.claim_invoice_status ?? null,
    url: row.claim_invoice_url || null,
  };
}

export function createMysqlResourceFinanceRepository({ pool }) {
  async function select(table, id, tenantId, mapper) {
    const [rows] = await pool.execute(`SELECT * FROM ${table} WHERE id = ? AND tenant_id = ? LIMIT 1`, [id, tenantId]);
    return mapper(rows[0]);
  }
  async function insert(table, columns, values, tenantId, mapper) {
    const id = randomUUID(); const now = new Date();
    await pool.execute(`INSERT INTO ${table} (id, tenant_id, ${columns.join(', ')}, version, created_at, updated_at) VALUES (?, ?, ${columns.map(() => '?').join(', ')}, 1, ?, ?)`, [id, tenantId, ...values, now, now]);
    return select(table, id, tenantId, mapper);
  }
  async function currentVersion(table, id, tenantId) {
    const [rows] = await pool.execute(`SELECT version, status FROM ${table} WHERE id = ? AND tenant_id = ? LIMIT 1`, [id, tenantId]);
    return rows[0] ? { status: rows[0].status, version: Number(rows[0].version) } : null;
  }
  async function timeEntryClaimed(id, tenantId) {
    const [rows] = await pool.execute('SELECT invoice_claim_id FROM project_time_entries WHERE id = ? AND tenant_id = ? LIMIT 1', [id, tenantId]);
    return Boolean(rows[0]?.invoice_claim_id);
  }
  async function update(table, id, tenantId, expectedVersion, assignments, values, mapper, { immutableFinancial = false, onlyUnclaimed = false } = {}) {
    const current = await currentVersion(table, id, tenantId);
    if (!current) return null;
    if (immutableFinancial) immutable(current);
    // Read back before the commit, while the update holds the row: a read after it could return
    // someone's edit made since as this write.
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [result] = await connection.execute(`UPDATE ${table} SET ${assignments}, version = version + 1, updated_at = NOW(3) WHERE id = ? AND tenant_id = ? AND version = ?${onlyUnclaimed ? ' AND invoice_claim_id IS NULL' : ''}`, [...values, id, tenantId, expectedVersion]);
      if (Number(result.affectedRows) !== 1) conflict(current, expectedVersion);
      const [rows] = await connection.execute(`SELECT * FROM ${table} WHERE id = ? AND tenant_id = ? LIMIT 1`, [id, tenantId]);
      await connection.commit();
      return mapper(rows[0]);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
  async function remove(table, id, expectedVersion, tenantId, { immutableFinancial = false } = {}) {
    const current = await currentVersion(table, id, tenantId);
    if (!current) return false;
    if (immutableFinancial) immutable(current);
    const [result] = await pool.execute(`DELETE FROM ${table} WHERE id = ? AND tenant_id = ? AND version = ?`, [id, tenantId, expectedVersion]);
    if (Number(result.affectedRows) !== 1) conflict(current, expectedVersion);
    return true;
  }
  async function existing(table, id, tenantId, mapper) {
    return select(table, id, tenantId, mapper);
  }

  return {
    async applyLevelingRecommendation({ allocationId, expectedVersion, hours, targetResourceId, tenantId }) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [sourceRows] = await connection.execute('SELECT * FROM resource_allocations WHERE id = ? AND tenant_id = ? FOR UPDATE', [allocationId, tenantId]);
        const source = maps.allocations(sourceRows[0]);
        if (!source) { await connection.rollback(); return null; }
        if (source.version !== expectedVersion) conflict(source, expectedVersion);
        const [targetRows] = await connection.execute("SELECT id FROM enterprise_resources WHERE id = ? AND tenant_id = ? AND status = 'active' LIMIT 1", [targetResourceId, tenantId]);
        if (!targetRows.length) throw new HttpError(404, 'Target resource not found.');
        const values = levelingValues(source, hours, targetResourceId);
        if (values.fullMove) {
          await connection.execute('UPDATE resource_allocations SET resource_id = ?, version = version + 1, updated_at = NOW(3) WHERE id = ? AND tenant_id = ? AND version = ?', [targetResourceId, allocationId, tenantId, expectedVersion]);
          const [rows] = await connection.execute('SELECT * FROM resource_allocations WHERE id = ? AND tenant_id = ?', [allocationId, tenantId]);
          await connection.commit();
          return { movedHours: hours, sourceAllocation: null, targetAllocation: maps.allocations(rows[0]) };
        }
        const sourcePercent = Math.round((Number(source.allocationPercent) - values.movedPercent) * 100) / 100;
        const sourceHours = Math.round((values.sourceHours - hours) * 100) / 100;
        await connection.execute('UPDATE resource_allocations SET allocation_percent = ?, hours_per_week = ?, version = version + 1, updated_at = NOW(3) WHERE id = ? AND tenant_id = ? AND version = ?', [sourcePercent, sourceHours, allocationId, tenantId, expectedVersion]);
        const targetId = randomUUID();
        await connection.execute('INSERT INTO resource_allocations (id, tenant_id, project_id, resource_id, start_date, end_date, allocation_percent, hours_per_week, role_name, scenario, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW(3), NOW(3))', [targetId, tenantId, source.projectId, targetResourceId, source.startDate, source.endDate, values.movedPercent, hours, source.role, source.scenario, source.status]);
        const [sourceResult] = await connection.execute('SELECT * FROM resource_allocations WHERE id = ? AND tenant_id = ?', [allocationId, tenantId]);
        const [targetResult] = await connection.execute('SELECT * FROM resource_allocations WHERE id = ? AND tenant_id = ?', [targetId, tenantId]);
        await connection.commit();
        return { movedHours: hours, sourceAllocation: maps.allocations(sourceResult[0]), targetAllocation: maps.allocations(targetResult[0]) };
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },
    async createAccountingPeriod({ input, tenantId }) { return insert('accounting_periods', ['name', 'fiscal_year', 'period_number', 'start_date', 'end_date', 'status'], [input.name, input.fiscalYear, input.periodNumber, input.startDate, input.endDate, input.status], tenantId, maps.accountingPeriods); },
    async createAllocation({ input, tenantId }) { return insert('resource_allocations', ['project_id', 'resource_id', 'start_date', 'end_date', 'allocation_percent', 'hours_per_week', 'role_name', 'scenario', 'status', 'bill_rate', 'origin'], [input.projectId, input.resourceId, input.startDate, input.endDate, input.allocationPercent, input.hoursPerWeek, input.role, input.scenario, input.status, input.billRate ?? null, input.origin ?? 'manual'], tenantId, maps.allocations); },
    async createCalendarEntry({ input: rawInput, tenantId }) { const input = calendarInput(rawInput); return insert('resource_calendar_entries', ['resource_id', 'entry_type', 'start_date', 'end_date', 'hours_per_day', 'status', 'note', 'weekdays_json', 'timezone'], [input.resourceId, input.entryType, input.startDate, input.endDate, input.hoursPerDay, input.status, input.note, JSON.stringify(input.weekdays), input.timezone], tenantId, maps.calendarEntries); },
    async createExchangeRate({ input, tenantId }) { return insert('currency_exchange_rates', ['base_currency', 'quote_currency', 'rate', 'effective_date', 'source', 'status'], [input.baseCurrency, input.quoteCurrency, input.rate, input.effectiveDate, input.source, input.status], tenantId, maps.exchangeRates); },
    createExpense: ({ input, tenantId }) => insert('project_expense_entries', ['project_id', 'resource_id', 'expense_date', 'category', 'amount', 'currency', 'receipt_reference', 'status', 'note'], [input.projectId, input.resourceId, input.expenseDate, input.category, input.amount, input.currency, input.receiptReference, input.status, input.note], tenantId, maps.expenses),
    async createExpenseReceipt({ input, tenantId }) { return insert('expense_receipts', ['expense_id', 'storage_key', 'file_name', 'content_type', 'size_bytes', 'sha256', 'status'], [input.expenseId, input.storageKey, input.fileName, input.contentType, input.sizeBytes, input.sha256, input.status], tenantId, maps.expenseReceipts); },
    createFinancialEntry: ({ input, tenantId }) => insert('project_financial_entries', ['project_id', 'entry_kind', 'category', 'amount', 'currency', 'effective_date', 'source_type', 'source_id', 'status', 'note'], [input.projectId, input.entryKind, input.category, input.amount, input.currency, input.effectiveDate, input.sourceType, input.sourceId, input.status, input.note], tenantId, maps.financialEntries),
    async createFinancePolicy({ input, tenantId }) { return insert('finance_control_policies', ['project_id', 'name', 'actual_cost_variance_percent', 'forecast_variance_percent', 'minimum_margin_percent', 'expense_approval_amount', 'status'], [input.projectId, input.name, input.actualCostVariancePercent, input.forecastVariancePercent, input.minimumMarginPercent, input.expenseApprovalAmount, input.status], tenantId, maps.financePolicies); },
    createPool: ({ input, tenantId }) => insert('resource_pools', ['name', 'description', 'manager_id', 'status'], [input.name, input.description, input.managerId, input.status], tenantId, maps.pools),
    async createResource({ input, tenantId }) {
      return insert('enterprise_resources', ['user_id', 'email', 'pool_id', 'name', 'location', 'roles_json', 'skills_json', 'capacity_hours_per_week', 'cost_rate', 'bill_rate', 'min_bill_rate', 'currency', 'status'], [input.userId, input.email ?? null, input.poolId, input.name, input.location, JSON.stringify(input.roles), JSON.stringify(input.skills), input.capacityHoursPerWeek, input.costRate, input.billRate, input.minBillRate ?? null, input.currency, input.status], tenantId, maps.resources);
    },
    async createResourceRate({ input, tenantId }) { return insert('resource_rate_history', ['resource_id', 'effective_start', 'effective_end', 'cost_rate', 'bill_rate', 'currency', 'status'], [input.resourceId, input.effectiveStart, input.effectiveEnd, input.costRate, input.billRate, input.currency, input.status], tenantId, maps.resourceRates); },
    async createTimeEntry({ input, tenantId }) { return insert('project_time_entries', ['project_id', 'resource_id', 'period_id', 'work_item_id', 'work_date', 'hours', 'billable', 'status', 'note'], [input.projectId, input.resourceId, input.periodId, input.workItemId, input.workDate, input.hours, input.billable, input.status, input.note], tenantId, maps.timeEntries); },
    async createTimesheetPeriod({ input, tenantId }) { return insert('timesheet_periods', ['name', 'start_date', 'end_date', 'approval_due_date', 'status'], [input.name, input.startDate, input.endDate, input.approvalDueDate, input.status], tenantId, maps.timesheetPeriods); },
    deleteAccountingPeriod: ({ accountingPeriodId, expectedVersion, tenantId }) => remove('accounting_periods', accountingPeriodId, expectedVersion, tenantId),
    deleteAllocation: ({ allocationId, expectedVersion, tenantId }) => remove('resource_allocations', allocationId, expectedVersion, tenantId),
    deleteCalendarEntry: ({ calendarEntryId, expectedVersion, tenantId }) => remove('resource_calendar_entries', calendarEntryId, expectedVersion, tenantId),
    deleteExchangeRate: ({ exchangeRateId, expectedVersion, tenantId }) => remove('currency_exchange_rates', exchangeRateId, expectedVersion, tenantId),
    async deleteExpense({ expenseId, expectedVersion, tenantId }) {
      const [rows] = await pool.execute("SELECT COUNT(*) AS count FROM expense_receipts WHERE tenant_id = ? AND expense_id = ? AND status <> 'deleted'", [tenantId, expenseId]);
      if (Number(rows[0]?.count)) throw new HttpError(409, 'Delete or detach active receipts before deleting the expense.');
      return remove('project_expense_entries', expenseId, expectedVersion, tenantId);
    },
    deleteExpenseReceipt: ({ expenseReceiptId, expectedVersion, tenantId }) => remove('expense_receipts', expenseReceiptId, expectedVersion, tenantId),
    deleteFinancialEntry: ({ expectedVersion, financialEntryId, tenantId }) => remove('project_financial_entries', financialEntryId, expectedVersion, tenantId, { immutableFinancial: true }),
    deleteFinancePolicy: ({ expectedVersion, financePolicyId, tenantId }) => remove('finance_control_policies', financePolicyId, expectedVersion, tenantId),
    async deletePool({ expectedVersion, poolId, tenantId }) {
      const [rows] = await pool.execute('SELECT COUNT(*) AS count FROM enterprise_resources WHERE tenant_id = ? AND pool_id = ?', [tenantId, poolId]);
      if (Number(rows[0]?.count)) throw new HttpError(409, 'Move resources out of this pool before deleting it.');
      return remove('resource_pools', poolId, expectedVersion, tenantId);
    },
    async deleteResource({ expectedVersion, resourceId, tenantId }) {
      const tables = ['resource_allocations', 'resource_calendar_entries', 'project_time_entries', 'project_expense_entries', 'resource_rate_history'];
      for (const table of tables) {
        const [rows] = await pool.execute(`SELECT COUNT(*) AS count FROM ${table} WHERE tenant_id = ? AND resource_id = ?`, [tenantId, resourceId]);
        if (Number(rows[0]?.count)) throw new HttpError(409, 'Resource records with allocations, calendar, time, or expense entries cannot be deleted.');
      }
      return remove('enterprise_resources', resourceId, expectedVersion, tenantId);
    },
    deleteResourceRate: ({ expectedVersion, resourceRateId, tenantId }) => remove('resource_rate_history', resourceRateId, expectedVersion, tenantId),
    // ownSubmitted: a person deleting their own time. The entry and its period are read under lock in
    // the delete's transaction, so a period locked meanwhile wins rather than losing its time.
    // An entry an invoice holds stays: the delete matches only an unclaimed row, and says why
    // when a claimed one is left.
    async deleteTimeEntry({ expectedVersion, ownSubmitted = null, tenantId, timeEntryId }) {
      if (!ownSubmitted) {
        const current = await currentVersion('project_time_entries', timeEntryId, tenantId);
        if (!current) return false;
        const [result] = await pool.execute('DELETE FROM project_time_entries WHERE id = ? AND tenant_id = ? AND version = ? AND invoice_claim_id IS NULL', [timeEntryId, tenantId, expectedVersion]);
        if (Number(result.affectedRows) === 1) return true;
        if (await timeEntryClaimed(timeEntryId, tenantId)) throw timeEntryInvoicedError();
        return conflict(current, expectedVersion);
      }
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [entries] = await connection.execute('SELECT id, version, resource_id, status, period_id, invoice_claim_id FROM project_time_entries WHERE id = ? AND tenant_id = ? FOR UPDATE', [timeEntryId, tenantId]);
        const entry = entries[0];
        if (entry && entry.resource_id === ownSubmitted.resourceId && entry.invoice_claim_id) throw timeEntryInvoicedError();
        if (!entry || entry.resource_id !== ownSubmitted.resourceId || entry.status !== 'submitted') {
          await connection.rollback();
          return false;
        }
        if (entry.period_id) {
          const [periods] = await connection.execute('SELECT name, status FROM timesheet_periods WHERE id = ? AND tenant_id = ? FOR UPDATE', [entry.period_id, tenantId]);
          if (periods[0] && periods[0].status !== 'open') throw new HttpError(423, `The ${periods[0].name} timesheet period is ${periods[0].status}.`);
        }
        if (Number(entry.version) !== expectedVersion) conflict({ version: Number(entry.version) }, expectedVersion);
        await connection.execute('DELETE FROM project_time_entries WHERE id = ? AND tenant_id = ?', [timeEntryId, tenantId]);
        await connection.commit();
        return true;
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },
    async deleteTimesheetPeriod({ expectedVersion, tenantId, timesheetPeriodId }) {
      const [rows] = await pool.execute('SELECT COUNT(*) AS count FROM project_time_entries WHERE tenant_id = ? AND period_id = ?', [tenantId, timesheetPeriodId]);
      if (Number(rows[0]?.count)) throw new HttpError(409, 'Timesheet periods with time entries cannot be deleted.');
      return remove('timesheet_periods', timesheetPeriodId, expectedVersion, tenantId);
    },
    async listSnapshot({ tenantId }) {
      const specs = [
        ['accountingPeriods', 'accounting_periods', maps.accountingPeriods],
        ['pools', 'resource_pools', maps.pools], ['resources', 'enterprise_resources', maps.resources],
        ['calendarEntries', 'resource_calendar_entries', maps.calendarEntries], ['allocations', 'resource_allocations', maps.allocations],
        ['financialEntries', 'project_financial_entries', maps.financialEntries], ['timeEntries', 'project_time_entries', maps.timeEntries],
        ['expenses', 'project_expense_entries', maps.expenses], ['resourceRates', 'resource_rate_history', maps.resourceRates],
        ['timesheetPeriods', 'timesheet_periods', maps.timesheetPeriods], ['expenseReceipts', 'expense_receipts', maps.expenseReceipts],
        ['exchangeRates', 'currency_exchange_rates', maps.exchangeRates],
        ['financePolicies', 'finance_control_policies', maps.financePolicies],
      ];
      const result = {};
      for (const [name, table, mapper] of specs) {
        const [rows] = name === 'timeEntries'
          ? await pool.execute(`${TIME_ENTRY_SELECT} WHERE t.tenant_id = ? ORDER BY t.created_at, t.id`, [tenantId])
          : await pool.execute(`SELECT * FROM ${table} WHERE tenant_id = ? ORDER BY created_at, id`, [tenantId]);
        result[name] = rows.map(mapper);
      }
      return result;
    },
    // The reads a task access link makes on every request, without the whole snapshot.
    async listAllocationsForResources({ resourceIds, tenantId }) {
      if (!resourceIds.length) return [];
      const [rows] = await pool.execute(`SELECT * FROM resource_allocations WHERE tenant_id = ? AND resource_id IN (${resourceIds.map(() => '?').join(', ')}) ORDER BY created_at, id`, [tenantId, ...resourceIds]);
      return rows.map(maps.allocations);
    },
    async listResourcesByEmail({ email, tenantId }) {
      const address = String(email ?? '').trim().toLowerCase();
      if (!address) return [];
      const [rows] = await pool.execute('SELECT * FROM enterprise_resources WHERE tenant_id = ? AND email = ? ORDER BY created_at, id', [tenantId, address]);
      return rows.map(maps.resources);
    },
    async listTimeEntries({ projectId, resourceId, tenantId, workItemId }) {
      const [rows] = await pool.execute(
        `${TIME_ENTRY_SELECT} WHERE t.tenant_id = ? AND t.project_id = ? AND t.resource_id = ? AND t.work_item_id = ? ORDER BY t.created_at, t.id`,
        [tenantId, projectId, resourceId, workItemId],
      );
      return rows.map(maps.timeEntries);
    },
    async updateAccountingPeriod({ accountingPeriodId, input, tenantId }) { const old = await existing('accounting_periods', accountingPeriodId, tenantId, maps.accountingPeriods); if (!old) return null; const next = { ...old, ...input }; return update('accounting_periods', accountingPeriodId, tenantId, input.expectedVersion, 'name = ?, fiscal_year = ?, period_number = ?, start_date = ?, end_date = ?, status = ?', [next.name, next.fiscalYear, next.periodNumber, next.startDate, next.endDate, next.status], maps.accountingPeriods); },
    async updateAllocation({ allocationId, input, tenantId }) {
      const old = await existing('resource_allocations', allocationId, tenantId, maps.allocations); if (!old) return null; const next = { ...old, ...input };
      return update('resource_allocations', allocationId, tenantId, input.expectedVersion, 'project_id = ?, resource_id = ?, start_date = ?, end_date = ?, allocation_percent = ?, hours_per_week = ?, role_name = ?, scenario = ?, status = ?, bill_rate = ?, origin = ?', [next.projectId, next.resourceId, next.startDate, next.endDate, next.allocationPercent, next.hoursPerWeek, next.role, next.scenario, next.status, next.billRate ?? null, next.origin ?? 'manual'], maps.allocations);
    },
    async updateCalendarEntry({ calendarEntryId, input, tenantId }) {
      const old = await existing('resource_calendar_entries', calendarEntryId, tenantId, maps.calendarEntries); if (!old) return null; const next = { ...old, ...input };
      return update('resource_calendar_entries', calendarEntryId, tenantId, input.expectedVersion, 'resource_id = ?, entry_type = ?, start_date = ?, end_date = ?, hours_per_day = ?, status = ?, note = ?, weekdays_json = ?, timezone = ?', [next.resourceId, next.entryType, next.startDate, next.endDate, next.hoursPerDay, next.status, next.note, JSON.stringify(next.weekdays ?? [1, 2, 3, 4, 5]), next.timezone ?? 'UTC'], maps.calendarEntries);
    },
    async updateExchangeRate({ exchangeRateId, input, tenantId }) {
      const old = await existing('currency_exchange_rates', exchangeRateId, tenantId, maps.exchangeRates); if (!old) return null; const next = { ...old, ...input };
      return update('currency_exchange_rates', exchangeRateId, tenantId, input.expectedVersion, 'base_currency = ?, quote_currency = ?, rate = ?, effective_date = ?, source = ?, status = ?', [next.baseCurrency, next.quoteCurrency, next.rate, next.effectiveDate, next.source, next.status], maps.exchangeRates);
    },
    async updateExpense({ expenseId, input, tenantId }) {
      const old = await existing('project_expense_entries', expenseId, tenantId, maps.expenses); if (!old) return null; const next = { ...old, ...input };
      return update('project_expense_entries', expenseId, tenantId, input.expectedVersion, 'project_id = ?, resource_id = ?, expense_date = ?, category = ?, amount = ?, currency = ?, receipt_reference = ?, status = ?, note = ?', [next.projectId, next.resourceId, next.expenseDate, next.category, next.amount, next.currency, next.receiptReference, next.status, next.note], maps.expenses);
    },
    async updateExpenseReceipt({ expenseReceiptId, input, tenantId }) {
      const old = await existing('expense_receipts', expenseReceiptId, tenantId, maps.expenseReceipts); if (!old) return null; const next = { ...old, ...input };
      return update('expense_receipts', expenseReceiptId, tenantId, input.expectedVersion, 'expense_id = ?, storage_key = ?, file_name = ?, content_type = ?, size_bytes = ?, sha256 = ?, status = ?', [next.expenseId, next.storageKey, next.fileName, next.contentType, next.sizeBytes, next.sha256, next.status], maps.expenseReceipts);
    },
    async updateFinancialEntry({ financialEntryId, input, tenantId }) {
      const old = await existing('project_financial_entries', financialEntryId, tenantId, maps.financialEntries); if (!old) return null; const next = { ...old, ...input };
      return update('project_financial_entries', financialEntryId, tenantId, input.expectedVersion, 'project_id = ?, entry_kind = ?, category = ?, amount = ?, currency = ?, effective_date = ?, source_type = ?, source_id = ?, status = ?, note = ?', [next.projectId, next.entryKind, next.category, next.amount, next.currency, next.effectiveDate, next.sourceType, next.sourceId, next.status, next.note], maps.financialEntries, { immutableFinancial: true });
    },
    async updateFinancePolicy({ financePolicyId, input, tenantId }) { const old = await existing('finance_control_policies', financePolicyId, tenantId, maps.financePolicies); if (!old) return null; const next = { ...old, ...input }; return update('finance_control_policies', financePolicyId, tenantId, input.expectedVersion, 'project_id = ?, name = ?, actual_cost_variance_percent = ?, forecast_variance_percent = ?, minimum_margin_percent = ?, expense_approval_amount = ?, status = ?', [next.projectId, next.name, next.actualCostVariancePercent, next.forecastVariancePercent, next.minimumMarginPercent, next.expenseApprovalAmount, next.status], maps.financePolicies); },
    async updatePool({ input, poolId, tenantId }) {
      const old = await existing('resource_pools', poolId, tenantId, maps.pools); if (!old) return null; const next = { ...old, ...input };
      return update('resource_pools', poolId, tenantId, input.expectedVersion, 'name = ?, description = ?, manager_id = ?, status = ?', [next.name, next.description, next.managerId, next.status], maps.pools);
    },
    async updateResource({ input, resourceId, tenantId }) {
      const old = await existing('enterprise_resources', resourceId, tenantId, maps.resources); if (!old) return null; const next = { ...old, ...input };
      return update('enterprise_resources', resourceId, tenantId, input.expectedVersion, 'user_id = ?, email = ?, pool_id = ?, name = ?, location = ?, roles_json = ?, skills_json = ?, capacity_hours_per_week = ?, cost_rate = ?, bill_rate = ?, min_bill_rate = ?, currency = ?, status = ?', [next.userId, next.email ?? null, next.poolId, next.name, next.location, JSON.stringify(next.roles), JSON.stringify(next.skills), next.capacityHoursPerWeek, next.costRate, next.billRate, next.minBillRate ?? null, next.currency, next.status], maps.resources);
    },
    async updateResourceRate({ input, resourceRateId, tenantId }) {
      const old = await existing('resource_rate_history', resourceRateId, tenantId, maps.resourceRates); if (!old) return null; const next = { ...old, ...input };
      return update('resource_rate_history', resourceRateId, tenantId, input.expectedVersion, 'resource_id = ?, effective_start = ?, effective_end = ?, cost_rate = ?, bill_rate = ?, currency = ?, status = ?', [next.resourceId, next.effectiveStart, next.effectiveEnd, next.costRate, next.billRate, next.currency, next.status], maps.resourceRates);
    },
    // An entry an invoice holds stays: the update matches only an unclaimed row, so a claim
    // made after the read still wins.
    async updateTimeEntry({ input, resourceMerge = false, tenantId, timeEntryId }) {
      const old = await existing('project_time_entries', timeEntryId, tenantId, maps.timeEntries); if (!old) return null; const next = { ...old, ...input };
      const merge = resourceMergeOnly(input, resourceMerge);
      if (old.invoiceClaimId && !merge) throw timeEntryInvoicedError();
      try {
        return await update('project_time_entries', timeEntryId, tenantId, input.expectedVersion, 'project_id = ?, resource_id = ?, period_id = ?, work_item_id = ?, work_date = ?, hours = ?, billable = ?, status = ?, note = ?', [next.projectId, next.resourceId, next.periodId, next.workItemId, next.workDate, next.hours, next.billable, next.status, next.note], maps.timeEntries, { onlyUnclaimed: !merge });
      } catch (error) {
        if (error?.details?.code === 'resource_finance_version_conflict' && await timeEntryClaimed(timeEntryId, tenantId)) throw timeEntryInvoicedError();
        throw error;
      }
    },
    async updateTimesheetPeriod({ input, tenantId, timesheetPeriodId }) {
      const old = await existing('timesheet_periods', timesheetPeriodId, tenantId, maps.timesheetPeriods); if (!old) return null; const next = { ...old, ...input };
      return update('timesheet_periods', timesheetPeriodId, tenantId, input.expectedVersion, 'name = ?, start_date = ?, end_date = ?, approval_due_date = ?, status = ?', [next.name, next.startDate, next.endDate, next.approvalDueDate, next.status], maps.timesheetPeriods);
    },
  };
}
