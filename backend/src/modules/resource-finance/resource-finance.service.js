import { createHash, randomUUID } from 'node:crypto';

import { PROJECT_CAPABILITIES, requireProjectCapability } from '../../lib/auth/project-capabilities.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { describeAccessLink, issueAccessLink, revokeAccessLink } from '../access/access.service.js';
import { assertRecordsNotHeld } from '../compliance/legal-hold.js';
import { analyzeResourceFinance, weeklyAvailableHours } from './resource-finance-analysis.js';
import { assignmentAllocationWindow, assignmentResourceInput, matchUnlinkedResource, namesMatch, resourceAssigneeId } from './assignee-resources.js';

function tenantIdFor(user) {
  const tenantId = user?.memberships?.[0]?.tenantId;
  if (!tenantId) throw new HttpError(403, 'This account is not assigned to a tenant.');
  return tenantId;
}
function tenantRole(user, tenantId) { return String(user?.memberships?.find((item) => item.tenantId === tenantId)?.role ?? '').toLowerCase(); }
function canManageResources(user, tenantId) { return ['admin', 'manager'].includes(tenantRole(user, tenantId)); }
function canManageFinance(user, tenantId) { return ['admin', 'manager'].includes(tenantRole(user, tenantId)); }
function requireResourceManager(user, tenantId) { if (!canManageResources(user, tenantId)) throw new HttpError(404, 'Resource record not found.'); }
function requireFinanceManager(user, tenantId) { if (!canManageFinance(user, tenantId)) throw new HttpError(404, 'Financial record not found.'); }
function requireFinancePoster(user, tenantId, input) {
  if (['posted', 'void'].includes(input?.status) && tenantRole(user, tenantId) !== 'admin') {
    throw new HttpError(403, 'Only tenant administrators may post or void financial ledger entries.');
  }
}
function groupSum(records, key, value = 'amount') {
  return records.reduce((result, record) => {
    const group = record[key] ?? 'unknown';
    result[group] = Math.round(((result[group] ?? 0) + Number(record[value] ?? 0)) * 10_000) / 10_000;
    return result;
  }, {});
}
function overlapsToday(record, today) { return record.startDate <= today && record.endDate >= today; }

/**
 * The invoice that holds a time entry, or null. Everyone who sees the entry sees its number, or
 * that it is on a draft; only finance-visible people get the link to the invoice.
 */
export function timeEntryInvoice(entry, financeVisible) {
  if (!entry?.invoiceClaimId) return null;
  const invoice = entry.invoice ?? {};
  const draft = !invoice.status || invoice.status === 'draft';
  return { draft, number: invoice.number || null, status: invoice.status ?? 'draft', ...(financeVisible ? { url: invoice.url || null } : {}) };
}

function presentTimeEntries(entries, financeVisible) {
  return entries.map(({ invoice: _invoice, invoiceClaimId, ...entry }) => ({ ...entry, invoice: timeEntryInvoice({ invoice: _invoice, invoiceClaimId }, financeVisible), invoiced: Boolean(invoiceClaimId) }));
}

/** Workspace members (id, name, email) for linking resources to logins; resource managers only. */
async function tenantPeople({ authRepository, tenantId, tenantsRepository }) {
  const rows = tenantsRepository?.listExistingUsers
    ? await tenantsRepository.listExistingUsers({ tenantId })
    : (authRepository?.state?.users ?? []).filter((account) => belongsToTenant(account, tenantId));
  return rows.map(({ email, id, name }) => ({ email: email ?? '', id, name: name ?? '' }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function getResourceFinanceWorkspaceForUser({ authRepository = null, input, projectRepository, repository, tenantsRepository = null, user }) {
  const tenantId = tenantIdFor(user);
  if (input.projectId) {
    await requireProjectCapability({ capability: PROJECT_CAPABILITIES.READ, projectId: input.projectId, repository: projectRepository, tenantId, user });
  }
  const [snapshot, projects] = await Promise.all([
    repository.listSnapshot({ tenantId }),
    projectRepository.listProjectsForTenant({ tenantId, user }),
  ]);
  const visibleProjectIds = new Set(projects.map((project) => project.id));
  const matchesProject = (record) => visibleProjectIds.has(record.projectId) && (!input.projectId || record.projectId === input.projectId);
  const query = input.query.toLowerCase();
  let resources = snapshot.resources.filter((resource) => (!input.status || resource.status === input.status)
    && (!query || `${resource.name} ${resource.location} ${resource.roles.join(' ')} ${resource.skills.map((skill) => skill.name).join(' ')}`.toLowerCase().includes(query)));
  const total = resources.length;
  resources = resources.sort((left, right) => left.name.localeCompare(right.name)).slice(input.offset, input.offset + input.limit);
  const resourceIds = new Set(resources.map((resource) => resource.id));
  const allocations = snapshot.allocations.filter((record) => resourceIds.has(record.resourceId) && matchesProject(record)
    && (!input.scenario || record.scenario === input.scenario));
  const allCalendarEntries = snapshot.calendarEntries.filter((record) => resourceIds.has(record.resourceId));
  const managedResources = canManageResources(user, tenantId);
  const ownedResourceIds = new Set(resources.filter((resource) => resource.userId === user.id).map((resource) => resource.id));
  const calendarEntries = allCalendarEntries.filter((record) => managedResources || ownedResourceIds.has(record.resourceId));
  const timeEntries = snapshot.timeEntries.filter((record) => matchesProject(record) && (managedResources || ownedResourceIds.has(record.resourceId)));
  const financeVisible = canManageFinance(user, tenantId);
  const financialEntries = financeVisible ? snapshot.financialEntries.filter(matchesProject) : [];
  const expenses = financeVisible ? snapshot.expenses.filter(matchesProject) : [];
  const expenseIds = new Set(expenses.map((expense) => expense.id));
  const today = new Date().toISOString().slice(0, 10);
  const capacity = resources.map((resource) => {
    const activeAllocations = allocations.filter((record) => record.resourceId === resource.id && overlapsToday(record, today) && ['approved', 'active'].includes(record.status));
    const availableHours = weeklyAvailableHours(resource, allCalendarEntries, today);
    const allocatedHours = activeAllocations.reduce((sum, record) => sum + record.hoursPerWeek, 0);
    return {
      allocatedHours,
      availableHours,
      overallocated: allocatedHours > availableHours,
      resourceId: resource.id,
      utilizationPercent: availableHours ? Math.round(allocatedHours / availableHours * 10_000) / 100 : allocatedHours ? 100 : 0,
    };
  });
  // Emails on profiles without a login are where their access links go: resource managers only.
  const sanitizedResources = resources.map((resource) => {
    const visible = managedResources ? resource : { ...resource, email: null };
    return financeVisible ? visible : { ...visible, billRate: null, costRate: null };
  });
  const analysis = analyzeResourceFinance({
    projects: input.projectId ? projects.filter((project) => project.id === input.projectId) : projects,
    reportingCurrency: input.reportingCurrency,
    snapshot,
    visibleProjectIds: input.projectId ? [input.projectId] : [...visibleProjectIds],
  });
  const visibleAnalysis = financeVisible ? analysis : {
    ...analysis,
    financialPerformance: [],
    scenarios: analysis.scenarios.map(({ allocatedHoursPerWeek, scenario }) => ({ allocatedHoursPerWeek, scenario })),
  };
  return {
    analysis: visibleAnalysis,
    allocations,
    accountingPeriods: financeVisible ? (snapshot.accountingPeriods ?? []) : [],
    calendarEntries,
    canManageFinance: financeVisible,
    canManageResources: canManageResources(user, tenantId),
    capacity,
    expenses,
    financialEntries,
    financePolicies: financeVisible ? (snapshot.financePolicies ?? []).filter((policy) => !policy.projectId || visibleProjectIds.has(policy.projectId)) : [],
    financialRollup: {
      byCurrency: groupSum([...financialEntries, ...expenses], 'currency'),
      byKind: groupSum(financialEntries, 'entryKind'),
      expenseByCurrency: groupSum(expenses, 'currency'),
    },
    limit: input.limit,
    offset: input.offset,
    pools: snapshot.pools,
    projects,
    resources: sanitizedResources,
    resourceRates: financeVisible ? (snapshot.resourceRates ?? []) : [],
    exchangeRates: financeVisible ? (snapshot.exchangeRates ?? []) : [],
    expenseReceipts: financeVisible ? (snapshot.expenseReceipts ?? []).filter((receipt) => expenseIds.has(receipt.expenseId)) : [],
    timeEntries: presentTimeEntries(timeEntries, financeVisible),
    timesheetPeriods: snapshot.timesheetPeriods ?? [],
    users: canManageResources(user, tenantId) ? await tenantPeople({ authRepository, tenantId, tenantsRepository }) : [],
    timeRollup: { approvedHours: timeEntries.filter((entry) => entry.status === 'approved').reduce((sum, entry) => sum + entry.hours, 0), submittedHours: timeEntries.filter((entry) => entry.status === 'submitted').reduce((sum, entry) => sum + entry.hours, 0) },
    total,
  };
}

export async function levelResourceAllocationForUser({ allocationId, input, projectRepository, repository, user }) {
  const tenantId = tenantIdFor(user);
  requireResourceManager(user, tenantId);
  const snapshot = await repository.listSnapshot({ tenantId });
  const allocation = snapshot.allocations.find((record) => record.id === allocationId);
  if (!allocation) throw new HttpError(404, 'Resource record not found.');
  const target = snapshot.resources.find((record) => record.id === input.targetResourceId && record.status === 'active');
  if (!target) throw new HttpError(404, 'Target resource not found.');
  await requireProject({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, input: allocation, projectRepository, tenantId, user });
  const value = await repository.applyLevelingRecommendation({ allocationId, tenantId, ...input });
  if (!value) throw new HttpError(404, 'Resource record not found.');
  return { ok: true, value };
}

export async function uploadExpenseReceiptForUser({ expenseId, fileScanner, fileStorage, input, projectRepository, repository, user }) {
  const tenantId = tenantIdFor(user); requireFinanceManager(user, tenantId);
  if (!fileStorage?.write || !fileStorage?.delete || !fileScanner?.scanBytes) throw new HttpError(503, 'Receipt object storage or scanning is unavailable.');
  const snapshot = await repository.listSnapshot({ tenantId });
  const expense = snapshot.expenses.find((record) => record.id === expenseId);
  if (!expense) throw new HttpError(404, 'Expense record not found.');
  await requireProject({ capability: PROJECT_CAPABILITIES.READ, input: expense, projectRepository, tenantId, user });
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input.contentBase64)) throw new HttpError(400, 'Receipt content must be valid base64.');
  const bytes = Buffer.from(input.contentBase64, 'base64');
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new HttpError(413, 'Receipt files must be between 1 byte and 10 MB.');
  if (bytes.toString('base64').replace(/=+$/, '') !== input.contentBase64.replace(/=+$/, '')) throw new HttpError(400, 'Receipt content must be valid base64.');
  const scan = await fileScanner.scanBytes(bytes);
  if (!scan?.clean) throw new HttpError(422, 'Receipt upload was rejected by malware scanning.');
  const storageKey = `expense-receipt-${randomUUID()}`;
  await fileStorage.write(storageKey, bytes);
  try {
    const value = await repository.createExpenseReceipt({ input: {
      contentType: input.contentType, expenseId, fileName: input.fileName,
      sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length, status: 'active', storageKey,
    }, tenantId });
    return { ok: true, value };
  } catch (error) {
    await fileStorage.delete(storageKey).catch(() => {});
    throw error;
  }
}

export async function readExpenseReceiptForUser({ expenseReceiptId, fileStorage, projectRepository, repository, user }) {
  const tenantId = tenantIdFor(user); requireFinanceManager(user, tenantId);
  if (!fileStorage?.read) throw new HttpError(503, 'Receipt object storage is unavailable.');
  const snapshot = await repository.listSnapshot({ tenantId });
  const receipt = snapshot.expenseReceipts.find((record) => record.id === expenseReceiptId && record.status === 'active');
  const expense = receipt ? snapshot.expenses.find((record) => record.id === receipt.expenseId) : null;
  if (!receipt || !expense) throw new HttpError(404, 'Expense receipt not found.');
  await requireProject({ capability: PROJECT_CAPABILITIES.READ, input: expense, projectRepository, tenantId, user });
  const asset = await fileStorage.read(receipt.storageKey).catch(() => null);
  if (!asset) throw new HttpError(404, 'Expense receipt content not found.');
  return { asset, receipt };
}

async function requireProject({ capability, input, projectRepository, tenantId, user }) {
  if (!input?.projectId) return;
  await requireProjectCapability({ capability, projectId: input.projectId, repository: projectRepository, tenantId, user });
}
function requireResource(snapshot, resourceId) { if (resourceId && !snapshot.resources.some((record) => record.id === resourceId)) throw new HttpError(404, 'Resource record not found.'); }
function requirePool(snapshot, poolId) { if (poolId && !snapshot.pools.some((record) => record.id === poolId)) throw new HttpError(404, 'Resource pool not found.'); }
function requireTimesheetPeriod(snapshot, periodId) { if (periodId && !(snapshot.timesheetPeriods ?? []).some((record) => record.id === periodId)) throw new HttpError(404, 'Timesheet period not found.'); }

function uniqueStrings(...lists) {
  const seen = new Map();
  for (const value of lists.flat()) {
    const text = String(value ?? '').trim();
    if (text && !seen.has(text.toLowerCase())) seen.set(text.toLowerCase(), text);
  }
  return [...seen.values()];
}

/** Skills from both profiles, keeping the higher level when both list one. */
function mergedSkills(...lists) {
  const byName = new Map();
  for (const skill of lists.flat()) {
    const name = String(skill?.name ?? '').trim();
    if (!name) continue;
    const existing = byName.get(name.toLowerCase());
    if (!existing || Number(skill.level) > Number(existing.level)) byName.set(name.toLowerCase(), { level: Number(skill.level) || 3, name });
  }
  return [...byName.values()];
}

function belongsToTenant(account, tenantId) {
  return Boolean(account) && ((account.memberships ?? []).some((membership) => membership.tenantId === tenantId) || account.tenantId === tenantId);
}

/**
 * Folds one resource profile into another when a person turns out to have two: allocations,
 * calendar, time, expenses and rate history move across, then the duplicate is deleted. Where
 * both are allocated to the same project, the allocation with more hours stays.
 */
async function mergeResourceInto({ repository, snapshot, source, target, tenantId }) {
  for (const allocation of snapshot.allocations.filter((record) => record.resourceId === source.id)) {
    const twin = snapshot.allocations.find((record) => record.resourceId === target.id && record.projectId === allocation.projectId
      && record.scenario === allocation.scenario && record.status !== 'completed');
    if (twin && allocation.status !== 'completed') {
      if (Number(allocation.hoursPerWeek) > Number(twin.hoursPerWeek)) {
        await repository.deleteAllocation({ allocationId: twin.id, expectedVersion: twin.version, tenantId });
        await repository.updateAllocation({ allocationId: allocation.id, input: { expectedVersion: allocation.version, resourceId: target.id }, tenantId });
      } else {
        await repository.deleteAllocation({ allocationId: allocation.id, expectedVersion: allocation.version, tenantId });
      }
      continue;
    }
    await repository.updateAllocation({ allocationId: allocation.id, input: { expectedVersion: allocation.version, resourceId: target.id }, tenantId });
  }
  const moves = [
    ['calendarEntries', 'updateCalendarEntry', 'calendarEntryId'],
    ['timeEntries', 'updateTimeEntry', 'timeEntryId'],
    ['expenses', 'updateExpense', 'expenseId'],
    ['resourceRates', 'updateResourceRate', 'resourceRateId'],
  ];
  for (const [collection, method, idKey] of moves) {
    for (const record of (snapshot[collection] ?? []).filter((entry) => entry.resourceId === source.id)) {
      // resourceMerge: time an invoice holds moves too; its hours stay as billed.
      await repository[method]({ [idKey]: record.id, input: { expectedVersion: record.version, resourceId: target.id }, ...(collection === 'timeEntries' ? { resourceMerge: true } : {}), tenantId });
    }
  }
  await repository.deleteResource({ expectedVersion: source.version, resourceId: source.id, tenantId });
}

/**
 * Linking a resource to a login: the user must be in the workspace, and a person has one profile.
 * Linking a resource to someone who already has one merges the two (it is how a profile made
 * before the person had a login, or one Odin made when they were given work, joins up).
 */
async function prepareResourceLink({ authRepository, current, input, repository, snapshot, tenantId }) {
  const userId = input.userId;
  if (!userId || userId === current?.userId) return input;
  const account = await authRepository?.findUserById?.(userId);
  if (!belongsToTenant(account, tenantId)) throw new HttpError(404, 'That user is not in this workspace.');
  const other = snapshot.resources.find((record) => record.userId === userId && record.id !== current?.id);
  if (!other) return input;
  if (!current) throw new HttpError(409, `${account.name || 'That user'} already has a resource profile, ${other.name}. Edit or link that one instead.`);
  await mergeResourceInto({ repository, snapshot, source: other, target: current, tenantId });
  return {
    ...input,
    roles: uniqueStrings(input.roles ?? current.roles ?? [], other.roles ?? []),
    skills: mergedSkills(input.skills ?? current.skills ?? [], other.skills ?? []),
  };
}

/**
 * An email on a profile without a login is where its task access link goes. Someone with a
 * login in the workspace signs in instead (409 email_has_login), and an address belongs to one
 * active profile without a login (409 email_in_use). A profile linked to a login has no email of
 * its own (400 resource_has_login); linking one keeps the email it had, unused.
 */
async function requireResourceEmail({ authRepository, current, effectiveInput, input, snapshot, tenantId }) {
  const email = effectiveInput.email ?? null;
  if (!email) return;
  if (effectiveInput.userId) {
    if (input.email) throw new HttpError(400, 'A profile with an Odin login uses the email of that login.', { details: { code: 'resource_has_login' } });
    return;
  }
  if (input.email === undefined && input.userId === undefined && input.status === undefined) return;
  const account = await authRepository?.findUserByEmail?.(email);
  if (belongsToTenant(account, tenantId)) {
    throw new HttpError(409, `${email} belongs to a member of this workspace, who signs in to Odin instead.`, { details: { code: 'email_has_login' } });
  }
  const taken = effectiveInput.status !== 'inactive' && snapshot.resources.find((record) => record.id !== current?.id && !record.userId
    && record.status === 'active' && record.email === email);
  if (taken) throw new HttpError(409, `${taken.name}'s profile already uses ${email}.`, { details: { code: 'email_in_use' } });
}

/** A project's bill rate for a person can't undercut the minimum on their profile. */
function requireRateFloor(snapshot, allocation) {
  if (allocation.billRate == null) return;
  const resource = snapshot.resources.find((record) => record.id === allocation.resourceId);
  const floor = resource?.minBillRate;
  if (floor != null && Number(allocation.billRate) < Number(floor)) {
    throw new HttpError(400, `The project rate can't be below ${resource.name}'s minimum of ${Number(floor).toFixed(2)} ${resource.currency ?? 'USD'}.`);
  }
}

export async function mutateResourceFinanceForUser({ authRepository = null, complianceRepository, input, operation, projectRepository, recordId = null, repository, resourceType, user }) {
  const tenantId = tenantIdFor(user);
  const snapshot = await repository.listSnapshot({ tenantId });
  const collectionName = {
    accountingPeriod: 'accountingPeriods', allocation: 'allocations', calendar: 'calendarEntries', expense: 'expenses', financial: 'financialEntries', financePolicy: 'financePolicies',
    exchangeRate: 'exchangeRates', expenseReceipt: 'expenseReceipts', pool: 'pools', resource: 'resources',
    resourceRate: 'resourceRates', time: 'timeEntries', timesheetPeriod: 'timesheetPeriods',
  }[resourceType];
  const current = recordId ? snapshot[collectionName]?.find((record) => record.id === recordId) : null;
  if (recordId && !current) throw new HttpError(404, `${resourceType === 'financial' ? 'Financial' : 'Resource'} record not found.`);
  if (resourceType === 'financial' && recordId) await assertRecordsNotHeld({ repository: complianceRepository, resources: [{ resourceId: recordId, resourceType: 'financial_entry' }], tenantId });
  const effectiveInput = { ...(current ?? {}), ...input };
  if (['accountingPeriod', 'calendar', 'allocation', 'timesheetPeriod'].includes(resourceType) && effectiveInput.endDate < effectiveInput.startDate) {
    throw new HttpError(400, 'End date must be on or after start date.');
  }
  if (resourceType === 'resourceRate' && effectiveInput.effectiveEnd && effectiveInput.effectiveEnd < effectiveInput.effectiveStart) {
    throw new HttpError(400, 'Effective end must be on or after effective start.');
  }
  if (resourceType === 'exchangeRate' && effectiveInput.baseCurrency === effectiveInput.quoteCurrency) {
    throw new HttpError(400, 'Base and quote currencies must differ.');
  }
  if (resourceType === 'timesheetPeriod' && (snapshot.timesheetPeriods ?? []).some((period) => period.id !== recordId && period.startDate <= effectiveInput.endDate && period.endDate >= effectiveInput.startDate)) {
    throw new HttpError(409, 'Timesheet periods cannot overlap.');
  }
  if (resourceType === 'accountingPeriod' && (snapshot.accountingPeriods ?? []).some((period) => period.id !== recordId && period.startDate <= effectiveInput.endDate && period.endDate >= effectiveInput.startDate)) {
    throw new HttpError(409, 'Accounting periods cannot overlap.');
  }
  if (resourceType === 'resourceRate' && effectiveInput.status === 'approved' && (snapshot.resourceRates ?? []).some((rate) => rate.id !== recordId && rate.resourceId === effectiveInput.resourceId && rate.currency === effectiveInput.currency && rate.status === 'approved' && (rate.effectiveEnd ?? '9999-12-31') >= effectiveInput.effectiveStart && (effectiveInput.effectiveEnd ?? '9999-12-31') >= rate.effectiveStart)) {
    throw new HttpError(409, 'Approved resource rate periods cannot overlap.');
  }
  if (resourceType === 'expenseReceipt' && (snapshot.expenseReceipts ?? []).some((receipt) => receipt.id !== recordId && receipt.storageKey === effectiveInput.storageKey)) {
    throw new HttpError(409, 'Receipt storage keys must be unique.');
  }
  if (['pool', 'resource', 'calendar', 'allocation', 'timesheetPeriod'].includes(resourceType)) requireResourceManager(user, tenantId);
  if (['accountingPeriod', 'financial', 'financePolicy', 'expense', 'resourceRate', 'expenseReceipt', 'exchangeRate'].includes(resourceType)) requireFinanceManager(user, tenantId);
  if (resourceType === 'financial') requireFinancePoster(user, tenantId, effectiveInput);
  if (resourceType === 'resource') requirePool(snapshot, effectiveInput.poolId);
  if (resourceType === 'resource') await requireResourceEmail({ authRepository, current, effectiveInput, input, snapshot, tenantId });
  if (['calendar', 'allocation', 'time', 'expense', 'resourceRate'].includes(resourceType)) requireResource(snapshot, effectiveInput.resourceId);
  if (resourceType === 'time') {
    requireTimesheetPeriod(snapshot, effectiveInput.periodId);
    const period = (snapshot.timesheetPeriods ?? []).find((record) => record.id === effectiveInput.periodId);
    if (period && (period.status !== 'open' || effectiveInput.workDate < period.startDate || effectiveInput.workDate > period.endDate)) {
      throw new HttpError(409, 'Time entries must belong to an open period containing the work date.');
    }
  }
  if (resourceType === 'expenseReceipt') {
    const expense = snapshot.expenses.find((record) => record.id === effectiveInput.expenseId);
    if (!expense) throw new HttpError(404, 'Expense record not found.');
    await requireProject({ capability: PROJECT_CAPABILITIES.READ, input: expense, projectRepository, tenantId, user });
  }
  if (['allocation', 'expense'].includes(resourceType)) await requireProject({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, input: effectiveInput, projectRepository, tenantId, user });
  if (resourceType === 'financePolicy') await requireProject({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, input: effectiveInput, projectRepository, tenantId, user });
  if (resourceType === 'time') await requireProject({ capability: PROJECT_CAPABILITIES.READ, input: effectiveInput, projectRepository, tenantId, user });
  if (resourceType === 'financial') await requireProject({ capability: PROJECT_CAPABILITIES.READ, input: effectiveInput, projectRepository, tenantId, user });
  if (resourceType === 'expense' && effectiveInput.status === 'approved' && tenantRole(user, tenantId) !== 'admin') {
    const policies = (snapshot.financePolicies ?? []).filter((policy) => policy.status === 'active' && (!policy.projectId || policy.projectId === effectiveInput.projectId));
    const policy = policies.find((item) => item.projectId === effectiveInput.projectId) ?? policies.find((item) => !item.projectId);
    if (policy && Number(policy.expenseApprovalAmount) > 0 && Number(effectiveInput.amount) >= Number(policy.expenseApprovalAmount)) throw new HttpError(403, `Expenses at or above ${policy.expenseApprovalAmount} require tenant administrator approval.`);
  }
  if (resourceType === 'time' && !canManageResources(user, tenantId)) {
    const resource = snapshot.resources.find((record) => record.id === effectiveInput.resourceId);
    if (!resource || resource.userId !== user.id || effectiveInput.status !== 'submitted') throw new HttpError(404, 'Time entry not found.');
  }
  if (resourceType === 'allocation') requireRateFloor(snapshot, effectiveInput);
  const operationInput = resourceType === 'resource'
    ? await prepareResourceLink({ authRepository, current, input, repository, snapshot, tenantId })
    : input;
  const value = await operation(repository, { input: operationInput, tenantId });
  if (value == null || value === false) throw new HttpError(404, `${resourceType === 'financial' ? 'Financial' : 'Resource'} record not found.`);
  return { ok: true, value };
}

const LIVE_ALLOCATION = new Set(['proposed', 'approved', 'active', 'held']);

// An MCP connection limited to some projects (grantProjectIds) sees only the people allocated to
// those projects, never the rest of the workspace's directory, logins or rates.
function grantResourceIds(snapshot, grantProjectIds) {
  if (!grantProjectIds?.length) return null;
  return new Set(snapshot.allocations.filter((record) => grantProjectIds.includes(record.projectId)).map((record) => record.resourceId));
}

/**
 * The people on one project as resources: each allocation with its resource (rates only for
 * finance managers), the id their work is owned under, and, for resource managers, the whole
 * directory to add people from. A connection limited to some projects gets only the part of the
 * directory on those projects, and only their logins (directoryLimited).
 */
export async function getProjectTeamForUser({ authRepository = null, grantProjectIds = null, projectId, projectRepository, repository, tenantsRepository = null, user }) {
  const tenantId = tenantIdFor(user);
  await requireProjectCapability({ capability: PROJECT_CAPABILITIES.READ, projectId, repository: projectRepository, tenantId, user });
  const snapshot = await repository.listSnapshot({ tenantId });
  const granted = grantResourceIds(snapshot, grantProjectIds);
  const financeVisible = canManageFinance(user, tenantId);
  const managed = canManageResources(user, tenantId);
  const shape = (resource) => {
    const base = {
      capacityHoursPerWeek: resource.capacityHoursPerWeek, currency: resource.currency, id: resource.id, location: resource.location,
      name: resource.name, roles: resource.roles ?? [], skills: resource.skills ?? [], status: resource.status, userId: resource.userId ?? null, version: resource.version,
      ...(managed ? { email: resource.email ?? null } : {}),
    };
    return financeVisible ? { ...base, billRate: resource.billRate, costRate: resource.costRate, minBillRate: resource.minBillRate ?? null } : base;
  };
  const resourcesById = new Map(snapshot.resources.map((resource) => [resource.id, resource]));
  const allocations = snapshot.allocations
    .filter((record) => record.projectId === projectId)
    .map((record) => ({ ...record, billRate: financeVisible ? record.billRate ?? null : null }));
  const onProject = new Set(allocations.filter((record) => LIVE_ALLOCATION.has(record.status)).map((record) => record.resourceId));
  const people = [...onProject].map((resourceId) => resourcesById.get(resourceId)).filter(Boolean).map((resource) => ({
    assigneeId: resource.userId || resourceAssigneeId(resource.id),
    resource: shape(resource),
  }));
  const directory = managed ? snapshot.resources.filter((resource) => (resource.status === 'active' || onProject.has(resource.id)) && (!granted || granted.has(resource.id))) : [];
  const logins = granted && new Set(directory.map((resource) => resource.userId).filter(Boolean));
  return {
    allocations,
    canManage: managed,
    canSeeRates: financeVisible,
    directory: directory.map(shape),
    ...(granted ? { directoryLimited: true } : {}),
    people: people.sort((left, right) => left.resource.name.localeCompare(right.resource.name)),
    projectId,
    users: managed ? (await tenantPeople({ authRepository, tenantId, tenantsRepository })).filter((person) => !logins || logins.has(person.id)) : [],
  };
}

/**
 * Adds someone without an Odin login (a contractor, a vendor's engineer, a role not yet filled) to
 * a project: a resource profile with no login, allocated to the project, who can then own work as
 * `resource:<id>`. An active profile without a login with the same email, or else under the same
 * name, is reused rather than duplicated, and its details are left as they are, except that a
 * profile with no email takes the one given; someone already on the project is left alone. A name
 * matching a workspace user is refused (409) unless an email says who they are: that person has a
 * login, so they join as a member or by being given work, which links their profile.
 */
export async function addProjectResourceForUser({ authRepository = null, grantProjectIds = null, input, projectId, projectRepository, repository, tenantsRepository = null, today = new Date().toISOString().slice(0, 10), user }) {
  const tenantId = tenantIdFor(user);
  requireResourceManager(user, tenantId);
  await requireProjectCapability({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectId, repository: projectRepository, tenantId, user });
  const { allocation: requested, email = null, ...profile } = input;
  if (!email) {
    const login = (await tenantPeople({ authRepository, tenantId, tenantsRepository })).find((person) => namesMatch(person.name, input.name));
    if (login) throw new HttpError(409, `${login.name} has an Odin login in this workspace. Add them to the project as a member, or give them work, instead.`);
  }

  const snapshot = await repository.listSnapshot({ tenantId });
  const byEmail = email ? snapshot.resources.find((record) => !record.userId && record.status === 'active' && record.email === email) : null;
  const byName = byEmail ? null : matchUnlinkedResource(snapshot.resources, { name: input.name });
  // A profile under the name with another email is someone else.
  let existing = byEmail ?? (byName && !(email && byName.email) ? byName : null);
  // A connection limited to some projects can't reach a profile from other projects by its name.
  if (existing && grantResourceIds(snapshot, grantProjectIds)?.has(existing.id) === false) {
    throw new HttpError(403, 'Someone with this name has a profile in projects this connection does not cover.');
  }
  if (email && existing?.email !== email) {
    await requireResourceEmail({ authRepository, current: existing, effectiveInput: { ...(existing ?? { status: 'active', userId: null }), email }, input: { email }, snapshot, tenantId });
    if (existing) existing = await repository.updateResource({ input: { email, expectedVersion: existing.version }, resourceId: existing.id, tenantId });
  }
  const current = existing && snapshot.allocations.find((record) => record.resourceId === existing.id && record.projectId === projectId && LIVE_ALLOCATION.has(record.status));
  if (current) return { added: false, allocation: current, assigneeId: resourceAssigneeId(existing.id), created: false, ok: true, resource: existing };

  const project = (await projectRepository.listProjectsForTenant({ tenantId, user })).find((entry) => entry.id === projectId);
  const window = assignmentAllocationWindow({ endDate: project?.endDate, startDate: requested.startDate ?? project?.startDate }, today);
  const startDate = requested.startDate ?? window.startDate;
  const endDate = requested.endDate ?? window.endDate;
  if (endDate < startDate) throw new HttpError(400, 'End date must be on or after start date.');
  const allocationFor = (resource) => ({
    allocationPercent: Math.min(200, Math.round((requested.hoursPerWeek / (Number(resource.capacityHoursPerWeek) || 40)) * 1000) / 10),
    billRate: requested.billRate, endDate, hoursPerWeek: requested.hoursPerWeek, origin: 'manual', projectId,
    resourceId: resource.id, role: requested.role, scenario: 'baseline', startDate, status: requested.status,
  });
  if (existing) requireRateFloor(snapshot, allocationFor(existing));

  const resource = existing ?? await repository.createResource({ input: { ...profile, email, minBillRate: null, poolId: null, status: 'active', userId: null }, tenantId });
  let allocation;
  try {
    allocation = await repository.createAllocation({ input: allocationFor(resource), tenantId });
  } catch (error) {
    // A profile made for this project alone goes with it, rather than sit unallocated.
    if (!existing) await repository.deleteResource({ expectedVersion: resource.version, resourceId: resource.id, tenantId }).catch(() => {});
    throw error;
  }
  return { added: true, allocation, assigneeId: resourceAssigneeId(resource.id), created: !existing, ok: true, resource };
}

/**
 * Edits the profile of someone without a login on the project (the MCP and assistant tool): name,
 * email, roles, location or weekly capacity, with the Resources tab's checks. Someone with a login
 * takes their name and email from it.
 */
export async function updateProjectResourceForUser({ authRepository = null, complianceRepository = null, input, projectId, projectRepository, repository, resourceId, user }) {
  const tenantId = tenantIdFor(user);
  requireResourceManager(user, tenantId);
  await requireProjectCapability({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectId, repository: projectRepository, tenantId, user });
  const snapshot = await repository.listSnapshot({ tenantId });
  const resource = snapshot.resources.find((record) => record.id === resourceId);
  const onProject = resource && snapshot.allocations.some((record) => record.resourceId === resourceId && record.projectId === projectId && LIVE_ALLOCATION.has(record.status));
  if (!onProject) throw new HttpError(404, 'Resource record not found.');
  if (resource.userId) throw new HttpError(409, `${resource.name} has an Odin login, which their name and email come from.`, { details: { code: 'resource_has_login' } });
  const { value } = await mutateResourceFinanceForUser({
    authRepository, complianceRepository, input, operation: (store, args) => store.updateResource({ ...args, resourceId }),
    projectRepository, recordId: resourceId, repository, resourceType: 'resource', user,
  });
  return { ok: true, resource: value };
}

// Task access. A manager turns a project's tasks on for someone without
// a login (their own, or everyone's) and sends them their access link. It takes what managing the
// project's resources takes: a workspace admin or manager role and plan-edit access to the project.
// `access` is the access service's deps (accessServiceDeps).

async function requireTaskAccessManager({ projectId, projectRepository, user }) {
  const tenantId = tenantIdFor(user);
  requireResourceManager(user, tenantId);
  if (projectId) await requireProjectCapability({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectId, repository: projectRepository, tenantId, user });
  return tenantId;
}

async function taskAccessEntry(access, { grants, resource, tenantId }) {
  const grant = grants.find((record) => record.resourceId === resource.id && !record.revokedAt);
  return {
    email: resource.email ?? null,
    link: await describeAccessLink(access, { email: resource.email, tenantId }),
    name: resource.name,
    resourceId: resource.id,
    scope: grant?.scope ?? 'off',
  };
}

/** Each person on the project without a login: their task access, email and access link. */
export async function listProjectTaskAccessForUser({ access, projectId, projectRepository, repository, user }) {
  const tenantId = await requireTaskAccessManager({ projectId, projectRepository, user });
  const snapshot = await repository.listSnapshot({ tenantId });
  const onProject = new Set(snapshot.allocations.filter((record) => record.projectId === projectId && LIVE_ALLOCATION.has(record.status)).map((record) => record.resourceId));
  const people = snapshot.resources.filter((resource) => onProject.has(resource.id) && !resource.userId).sort((left, right) => left.name.localeCompare(right.name));
  const grants = await access.accessRepository.listTaskAccess({ projectId, tenantId });
  const entries = [];
  for (const resource of people) entries.push(await taskAccessEntry(access, { grants, resource, tenantId }));
  return { entries, ok: true };
}

/**
 * The resource without a login whose task access is being set or sent, on this project. Turning
 * access on takes an active profile with an email, allocated to the project.
 */
function taskAccessResource(snapshot, { projectId, resourceId }) {
  const resource = snapshot.resources.find((record) => record.id === resourceId);
  if (!resource) throw new HttpError(404, 'Resource record not found.');
  if (resource.userId) throw new HttpError(409, `${resource.name} has an Odin login and signs in instead.`, { details: { code: 'resource_has_login' } });
  if (resource.status !== 'active') throw new HttpError(409, `${resource.name}'s profile is inactive.`, { details: { code: 'resource_inactive' } });
  if (!resource.email) throw new HttpError(409, `Add an email to ${resource.name}'s profile first.`, { details: { code: 'resource_needs_email' } });
  const allocated = snapshot.allocations.some((record) => record.resourceId === resourceId && record.projectId === projectId && LIVE_ALLOCATION.has(record.status));
  if (!allocated) throw new HttpError(409, `${resource.name} is not on this project.`, { details: { code: 'resource_not_on_project' } });
  return resource;
}

/** Sets someone's task access on the project: off, their own tasks, or everyone's. */
export async function setProjectTaskAccessForUser({ access, input, projectId, projectRepository, repository, resourceId, user }) {
  const tenantId = await requireTaskAccessManager({ projectId, projectRepository, user });
  const snapshot = await repository.listSnapshot({ tenantId });
  const resource = input.scope === 'off'
    ? snapshot.resources.find((record) => record.id === resourceId)
    : taskAccessResource(snapshot, { projectId, resourceId });
  if (!resource) throw new HttpError(404, 'Resource record not found.');
  await access.accessRepository.setTaskAccess({ by: user.id, now: access.clock(), projectId, resourceId, scope: input.scope, tenantId });
  const grants = await access.accessRepository.listTaskAccess({ projectId, resourceIds: [resourceId], tenantId });
  return { entry: await taskAccessEntry(access, { grants, resource, tenantId }), ok: true };
}

/**
 * Emails someone their access link, or returns it to copy (shown once). Their task access on the
 * project must be on: the link would otherwise open nothing here.
 */
export async function sendTaskAccessLinkForUser({ access, input, projectId, projectRepository, repository, resourceId, user }) {
  const tenantId = await requireTaskAccessManager({ projectId, projectRepository, user });
  const resource = taskAccessResource(await repository.listSnapshot({ tenantId }), { projectId, resourceId });
  const grants = await access.accessRepository.listTaskAccess({ projectId, resourceIds: [resourceId], tenantId });
  if (!grants.some((grant) => !grant.revokedAt)) {
    throw new HttpError(409, `Turn on task access for ${resource.name} first.`, { details: { code: 'task_access_off' } });
  }
  return issueAccessLink(access, { delivery: input.delivery, email: resource.email, recipientName: resource.name, sender: user, tenantId });
}

/** The access link for a resource's email: its state, or null when there is none. */
export async function getResourceAccessLinkForUser({ access, repository, resourceId, user }) {
  const tenantId = await requireTaskAccessManager({ user });
  const resource = (await repository.listSnapshot({ tenantId })).resources.find((record) => record.id === resourceId);
  if (!resource) throw new HttpError(404, 'Resource record not found.');
  return { link: await describeAccessLink(access, { email: resource.email, tenantId }), ok: true };
}

/** Turns off the access link for a resource's email across the workspace. */
export async function revokeResourceAccessLinkForUser({ access, repository, resourceId, user }) {
  const tenantId = await requireTaskAccessManager({ user });
  const resource = (await repository.listSnapshot({ tenantId })).resources.find((record) => record.id === resourceId);
  if (!resource) throw new HttpError(404, 'Resource record not found.');
  const revoked = await revokeAccessLink(access, { email: resource.email, revokedBy: `user:${user.id}`, tenantId });
  return { ok: true, revoked };
}

// The project-scoped routes below are what the MCP and assistant tools call. Each names its project
// in the path, holds records to that project, and then applies the same rules as the CRUD routes.

const todayIso = () => new Date().toISOString().slice(0, 10);
const sharePercent = (hours, resource) => Math.min(200, Math.round((Number(hours) / (Number(resource?.capacityHoursPerWeek) || 40)) * 1000) / 10);
const roundHours = (value) => Math.round(value * 100) / 100;
const latestFirst = (left, right) => right.workDate.localeCompare(left.workDate) || String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? ''));

function projectRecord(snapshot, collection, projectId, recordId) {
  const record = (snapshot[collection] ?? []).find((entry) => entry.id === recordId && entry.projectId === projectId);
  if (!record) throw new HttpError(404, 'Resource record not found.');
  return record;
}

// Time in a period that is not open stays as it is: 423, so callers can tell it from a conflict.
function lockedPeriod(period) {
  if (period && period.status !== 'open') throw new HttpError(423, `The ${period.name} timesheet period is ${period.status}.`);
  return period ?? null;
}
const periodHolding = (snapshot, workDate) => lockedPeriod((snapshot.timesheetPeriods ?? []).find((record) => record.startDate <= workDate && record.endDate >= workDate));
const requireOpenPeriod = (snapshot, periodId) => lockedPeriod(periodId ? (snapshot.timesheetPeriods ?? []).find((record) => record.id === periodId) : null);

function projectItems(project) {
  return (project?.epics ?? []).flatMap((epic) => [epic, ...(epic.stories ?? []).flatMap((story) => [story, ...(story.tasks ?? [])])]);
}
async function requireProjectItem({ itemId, projectId, projectRepository, tenantId }) {
  if (!itemId) return;
  const project = await projectRepository.getProjectDetail({ projectId, tenantId });
  if (!projectItems(project).some((item) => item.id === itemId)) throw new HttpError(404, 'Work item not found on this project.');
}

// Without a resource manager's role, someone sees and changes only time on their own profile.
function ownTime(snapshot, user, tenantId) {
  if (canManageResources(user, tenantId)) return () => true;
  const own = snapshot.resources.find((record) => record.userId === user.id)?.id;
  return (entry) => Boolean(own) && entry.resourceId === own;
}

/**
 * Logs time on a project in one step. The person defaults to the signed-in user's resource
 * profile, the date to today, and the period is the one holding the date. Someone without a
 * profile is refused (422): Odin makes profiles when people are given work or added on Resources,
 * and that is a resource manager's call, not a side effect of logging time.
 */
export async function logProjectTimeForUser({ complianceRepository, input, projectId, projectRepository, repository, today = todayIso(), user }) {
  const tenantId = tenantIdFor(user);
  await requireProjectCapability({ capability: PROJECT_CAPABILITIES.READ, projectId, repository: projectRepository, tenantId, user });
  const snapshot = await repository.listSnapshot({ tenantId });
  const resourceId = input.resourceId ?? snapshot.resources.find((record) => record.userId === user.id)?.id;
  if (!resourceId) throw new HttpError(422, 'You have no resource profile in this workspace to log time against.');
  const workDate = input.workDate ?? today;
  const period = periodHolding(snapshot, workDate);
  await requireProjectItem({ itemId: input.workItemId, projectId, projectRepository, tenantId });
  return mutateResourceFinanceForUser({
    complianceRepository,
    input: { billable: input.billable, hours: input.hours, note: input.note, periodId: period?.id ?? null, projectId, resourceId, status: 'submitted', workDate, workItemId: input.workItemId ?? null },
    operation: (store, args) => store.createTimeEntry(args), projectRepository, repository, resourceType: 'time', user,
  });
}

export async function updateProjectTimeEntryForUser({ complianceRepository, input, projectId, projectRepository, repository, timeEntryId, user }) {
  const tenantId = tenantIdFor(user);
  await requireProjectCapability({ capability: PROJECT_CAPABILITIES.READ, projectId, repository: projectRepository, tenantId, user });
  const snapshot = await repository.listSnapshot({ tenantId });
  const current = projectRecord(snapshot, 'timeEntries', projectId, timeEntryId);
  if (!ownTime(snapshot, user, tenantId)(current)) throw new HttpError(404, 'Time entry not found.');
  requireOpenPeriod(snapshot, current.periodId);
  const changes = { ...input };
  if (input.workDate && input.workDate !== current.workDate) changes.periodId = periodHolding(snapshot, input.workDate)?.id ?? null;
  await requireProjectItem({ itemId: input.workItemId, projectId, projectRepository, tenantId });
  return mutateResourceFinanceForUser({
    complianceRepository, input: changes, operation: (store, args) => store.updateTimeEntry({ ...args, timeEntryId }),
    projectRepository, recordId: timeEntryId, repository, resourceType: 'time', user,
  });
}

export async function deleteProjectTimeEntryForUser({ complianceRepository, expectedVersion, projectId, projectRepository, repository, timeEntryId, user }) {
  const tenantId = tenantIdFor(user);
  await requireProjectCapability({ capability: PROJECT_CAPABILITIES.READ, projectId, repository: projectRepository, tenantId, user });
  const snapshot = await repository.listSnapshot({ tenantId });
  requireOpenPeriod(snapshot, projectRecord(snapshot, 'timeEntries', projectId, timeEntryId).periodId);
  return deleteResourceFinanceForUser({
    complianceRepository, expectedVersion, operation: (store, args) => store.deleteTimeEntry({ ...args, timeEntryId }),
    recordId: timeEntryId, repository, resourceType: 'time', user,
  });
}

/** Time entries on the projects the user can see, newest first, with names for people, projects and work items. */
export async function listTimeEntriesForUser({ input, projectRepository, repository, user }) {
  const tenantId = tenantIdFor(user);
  if (input.projectId) await requireProjectCapability({ capability: PROJECT_CAPABILITIES.READ, projectId: input.projectId, repository: projectRepository, tenantId, user });
  const [snapshot, projects] = await Promise.all([repository.listSnapshot({ tenantId }), projectRepository.listProjectsForTenant({ tenantId, user })]);
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const visible = ownTime(snapshot, user, tenantId);
  const myResourceId = snapshot.resources.find((record) => record.userId === user.id)?.id ?? null;
  const entries = snapshot.timeEntries.filter((entry) => projectNames.has(entry.projectId) && visible(entry)
    && (!input.projectId || entry.projectId === input.projectId) && (!input.resourceId || entry.resourceId === input.resourceId)
    && (input.mine !== 'true' || entry.resourceId === myResourceId)
    && (!input.from || entry.workDate >= input.from) && (!input.to || entry.workDate <= input.to)).sort(latestFirst);
  const shown = entries.slice(0, input.limit);
  // Work item names come from each project's tree, read once per project shown (at most ten).
  const itemNames = new Map();
  for (const projectId of [...new Set(shown.filter((entry) => entry.workItemId).map((entry) => entry.projectId))].slice(0, 10)) {
    for (const item of projectItems(await projectRepository.getProjectDetail({ projectId, tenantId }))) itemNames.set(item.id, item.name);
  }
  const resourceNames = new Map(snapshot.resources.map((record) => [record.id, record.name]));
  const hours = (status) => roundHours(entries.filter((entry) => !status || entry.status === status).reduce((sum, entry) => sum + Number(entry.hours), 0));
  return {
    entries: shown.map((entry) => ({
      billable: Boolean(entry.billable), hours: entry.hours, id: entry.id, note: entry.note ?? '', periodId: entry.periodId ?? null,
      projectId: entry.projectId, projectName: projectNames.get(entry.projectId) ?? '', resourceId: entry.resourceId, resourceName: resourceNames.get(entry.resourceId) ?? '',
      // Only work items named from a project's epics, stories and tasks: an id stored for anything
      // else could be a ticket from outside that nobody has validated.
      status: entry.status, version: entry.version, workDate: entry.workDate,
      workItemId: itemNames.has(entry.workItemId) ? entry.workItemId : null, workItemName: itemNames.get(entry.workItemId) ?? null,
      // A claimed entry is locked until invoice-gen releases it.
      invoice: timeEntryInvoice(entry, canManageFinance(user, tenantId)), invoiced: Boolean(entry.invoiceClaimId),
    })),
    myResourceId,
    ok: true,
    total: entries.length,
    totals: {
      approvedHours: hours('approved'), billableHours: roundHours(entries.filter((entry) => entry.billable).reduce((sum, entry) => sum + Number(entry.hours), 0)),
      hours: hours(), rejectedHours: hours('rejected'), submittedHours: hours('submitted'),
    },
  };
}

/** Leave, holidays and working-hour overrides overlapping the dates, soonest first; others' only for resource managers. */
export async function listCalendarEntriesForUser({ input, repository, user }) {
  const tenantId = tenantIdFor(user);
  const snapshot = await repository.listSnapshot({ tenantId });
  const visible = ownTime(snapshot, user, tenantId);
  const myResourceId = snapshot.resources.find((record) => record.userId === user.id)?.id ?? null;
  const resourceNames = new Map(snapshot.resources.map((record) => [record.id, record.name]));
  const entries = snapshot.calendarEntries.filter((entry) => visible(entry)
    && (!input.resourceId || entry.resourceId === input.resourceId) && (input.mine !== 'true' || entry.resourceId === myResourceId)
    && (!input.from || entry.endDate >= input.from) && (!input.to || entry.startDate <= input.to))
    .sort((left, right) => left.startDate.localeCompare(right.startDate));
  return {
    entries: entries.slice(0, input.limit).map((entry) => ({
      endDate: entry.endDate, entryType: entry.entryType, hoursPerDay: entry.hoursPerDay, id: entry.id, note: entry.note ?? '', resourceId: entry.resourceId,
      resourceName: resourceNames.get(entry.resourceId) ?? '', startDate: entry.startDate, status: entry.status, timezone: entry.timezone, version: entry.version, weekdays: entry.weekdays,
    })),
    myResourceId,
    ok: true,
    total: entries.length,
  };
}

/**
 * Allocates someone already in Odin to a project: a resource from the directory, or a workspace
 * user. A user without a profile gets one linked to their login, as the Resources tab makes it,
 * and loses it again if the allocation is refused. Someone already on the project is left alone.
 */
export async function addProjectAllocationForUser({ authRepository = null, complianceRepository, grantProjectIds = null, input, projectId, projectRepository, repository, tenantsRepository = null, today = todayIso(), user }) {
  const tenantId = tenantIdFor(user);
  requireResourceManager(user, tenantId);
  await requireProjectCapability({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectId, repository: projectRepository, tenantId, user });
  const snapshot = await repository.listSnapshot({ tenantId });
  const existing = snapshot.resources.find((record) => (input.resourceId ? record.id === input.resourceId : record.userId === input.userId));
  if ((input.resourceId && !existing) || (existing && existing.status !== 'active')) throw new HttpError(404, 'Resource record not found.');
  // A connection limited to some projects reaches only profiles already on them, however it names one.
  if (existing && grantResourceIds(snapshot, grantProjectIds)?.has(existing.id) === false) throw new HttpError(404, 'Resource record not found.');
  const assigneeId = (resource) => resource.userId || resourceAssigneeId(resource.id);
  const current = existing && snapshot.allocations.find((record) => record.resourceId === existing.id && record.projectId === projectId && LIVE_ALLOCATION.has(record.status));
  if (current) return { added: false, allocation: current, assigneeId: assigneeId(existing), created: false, ok: true, resource: existing };

  const project = (await projectRepository.listProjectsForTenant({ tenantId, user })).find((entry) => entry.id === projectId);
  const window = assignmentAllocationWindow({ endDate: project?.endDate, startDate: input.startDate ?? project?.startDate }, today);
  const allocationFor = (resource) => ({
    allocationPercent: input.allocationPercent ?? sharePercent(input.hoursPerWeek, resource), billRate: input.billRate,
    endDate: input.endDate ?? window.endDate, hoursPerWeek: input.hoursPerWeek, origin: 'manual', projectId, resourceId: resource.id,
    role: input.role, scenario: 'baseline', startDate: input.startDate ?? window.startDate, status: input.status,
  });
  const shared = { authRepository, complianceRepository, projectRepository, repository, user };
  let resource = existing;
  if (!resource) {
    const account = (await tenantPeople({ authRepository, tenantId, tenantsRepository })).find((person) => person.id === input.userId);
    if (!account) throw new HttpError(404, 'That user is not in this workspace.');
    resource = (await mutateResourceFinanceForUser({ ...shared, input: assignmentResourceInput(account), operation: (store, args) => store.createResource(args), resourceType: 'resource' })).value;
  }
  try {
    const { value } = await mutateResourceFinanceForUser({ ...shared, input: allocationFor(resource), operation: (store, args) => store.createAllocation(args), resourceType: 'allocation' });
    return { added: true, allocation: value, assigneeId: assigneeId(resource), created: !existing, ok: true, resource };
  } catch (error) {
    if (!existing) await repository.deleteResource({ expectedVersion: resource.version, resourceId: resource.id, tenantId }).catch(() => {});
    throw error;
  }
}

/** Changes an allocation on the project; new hours without a new share keep the share in step, as the Resources tab does. */
export async function updateProjectAllocationForUser({ allocationId, complianceRepository, input, projectId, projectRepository, repository, user }) {
  const tenantId = tenantIdFor(user);
  requireResourceManager(user, tenantId);
  await requireProjectCapability({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectId, repository: projectRepository, tenantId, user });
  const snapshot = await repository.listSnapshot({ tenantId });
  const current = projectRecord(snapshot, 'allocations', projectId, allocationId);
  const changes = { ...input };
  if (input.hoursPerWeek !== undefined && input.allocationPercent === undefined) {
    changes.allocationPercent = sharePercent(input.hoursPerWeek, snapshot.resources.find((record) => record.id === current.resourceId));
  }
  return mutateResourceFinanceForUser({
    complianceRepository, input: changes, operation: (store, args) => store.updateAllocation({ ...args, allocationId }),
    projectRepository, recordId: allocationId, repository, resourceType: 'allocation', user,
  });
}

export async function deleteProjectAllocationForUser({ allocationId, complianceRepository, expectedVersion, projectId, projectRepository, repository, user }) {
  const tenantId = tenantIdFor(user);
  requireResourceManager(user, tenantId);
  await requireProjectCapability({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectId, repository: projectRepository, tenantId, user });
  projectRecord(await repository.listSnapshot({ tenantId }), 'allocations', projectId, allocationId);
  return deleteResourceFinanceForUser({
    complianceRepository, expectedVersion, operation: (store, args) => store.deleteAllocation({ ...args, allocationId }),
    recordId: allocationId, repository, resourceType: 'allocation', user,
  });
}

export async function levelProjectAllocationForUser({ allocationId, grantProjectIds = null, input, projectId, projectRepository, repository, user }) {
  const tenantId = tenantIdFor(user);
  requireResourceManager(user, tenantId);
  const snapshot = await repository.listSnapshot({ tenantId });
  projectRecord(snapshot, 'allocations', projectId, allocationId);
  if (grantResourceIds(snapshot, grantProjectIds)?.has(input.targetResourceId) === false) throw new HttpError(404, 'Target resource not found.');
  return levelResourceAllocationForUser({ allocationId, input, projectRepository, repository, user });
}

// People delete their own time while it is still submitted and its period is open, as they can
// change it then; anyone else's time takes a resource manager. The repository checks it all again
// as it deletes, so a period locked in between still wins. Returns what the delete must check.
async function requireTimeDeleter({ recordId, repository, tenantId, user }) {
  if (canManageResources(user, tenantId)) return null;
  const snapshot = await repository.listSnapshot({ tenantId });
  const entry = snapshot.timeEntries.find((record) => record.id === recordId);
  const own = snapshot.resources.find((record) => record.userId === user.id)?.id;
  if (!entry || !own || entry.resourceId !== own || entry.status !== 'submitted') throw new HttpError(404, 'Time entry not found.');
  requireOpenPeriod(snapshot, entry.periodId);
  return { resourceId: own };
}

export async function deleteResourceFinanceForUser({ complianceRepository, expectedVersion, operation, recordId, repository, resourceType, user }) {
  const tenantId = tenantIdFor(user);
  if (['accountingPeriod', 'financial', 'financePolicy', 'expense', 'resourceRate', 'expenseReceipt', 'exchangeRate'].includes(resourceType)) requireFinanceManager(user, tenantId);
  else if (resourceType !== 'time') requireResourceManager(user, tenantId);
  const ownSubmitted = resourceType === 'time' ? await requireTimeDeleter({ recordId, repository, tenantId, user }) : null;
  if (resourceType === 'financial') await assertRecordsNotHeld({ repository: complianceRepository, resources: [{ resourceId: recordId, resourceType: 'financial_entry' }], tenantId });
  const value = await operation(repository, { expectedVersion, tenantId, ...(ownSubmitted ? { ownSubmitted } : {}) });
  if (!value) throw new HttpError(404, `${resourceType === 'financial' ? 'Financial' : 'Resource'} record not found.`);
  return { ok: true };
}
