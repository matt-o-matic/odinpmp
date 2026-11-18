import { z } from 'zod';

const id = z.string().trim().min(1).max(128);
const optionalId = id.nullable().optional().default(null);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default('USD');
const amount = z.number().finite().min(-1_000_000_000_000).max(1_000_000_000_000);
const expectedVersion = z.number().int().positive();
const timezone = z.string().trim().min(1).max(80).refine((value) => { try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; } }, 'Timezone must be a valid IANA timezone.');
const weekdays = z.array(z.number().int().min(0).max(6)).min(1).max(7).refine((values) => new Set(values).size === values.length, 'Weekdays must be unique.').default([1, 2, 3, 4, 5]);

export const resourceSkillSchema = z.object({
  level: z.number().int().min(1).max(5).default(3),
  name: z.string().trim().min(1).max(120),
});

export const resourcePoolCreateSchema = z.object({
  description: z.string().trim().max(4000).default(''),
  managerId: optionalId,
  name: z.string().trim().min(1).max(240),
  status: z.enum(['active', 'inactive']).default('active'),
});
export const resourcePoolUpdateSchema = resourcePoolCreateSchema.partial().extend({ expectedVersion });

// Where a profile without a login gets its task access link. Blank means none.
export const resourceEmail = z.preprocess(
  (value) => (value == null || (typeof value === 'string' && !value.trim()) ? null : value),
  z.string().trim().toLowerCase().email().max(255).nullable(),
);

export const enterpriseResourceCreateSchema = z.object({
  billRate: z.number().finite().min(0).max(1_000_000).default(0),
  capacityHoursPerWeek: z.number().finite().min(0).max(168).default(40),
  costRate: z.number().finite().min(0).max(1_000_000).default(0),
  currency,
  email: resourceEmail.optional().default(null),
  location: z.string().trim().max(240).default(''),
  // The lowest bill rate a project may set for this person; null means no floor.
  minBillRate: z.number().finite().min(0).max(1_000_000).nullable().optional().default(null),
  name: z.string().trim().min(1).max(240),
  poolId: optionalId,
  roles: z.array(z.string().trim().min(1).max(120)).max(32).default([]),
  skills: z.array(resourceSkillSchema).max(64).default([]),
  status: z.enum(['active', 'inactive']).default('active'),
  userId: optionalId,
});
export const enterpriseResourceUpdateSchema = enterpriseResourceCreateSchema.partial().extend({ expectedVersion });

// Someone without an Odin login added to one project: their profile, and their allocation there.
// Dates left out follow the project's; hours left out mean none committed yet.
export const projectResourceAllocationSchema = z.object({
  billRate: z.number().finite().min(0).max(1_000_000).nullable().optional().default(null),
  endDate: date.optional(),
  hoursPerWeek: z.number().finite().min(0).max(168).default(0),
  role: z.string().trim().max(120).default(''),
  startDate: date.optional(),
  status: z.enum(['proposed', 'approved', 'active', 'held']).default('active'),
});
export const projectResourceCreateSchema = enterpriseResourceCreateSchema.omit({ minBillRate: true, poolId: true, status: true, userId: true }).extend({
  allocation: projectResourceAllocationSchema.default({}),
});
// Their profile as the project's tools may change it.
export const projectResourceUpdateSchema = enterpriseResourceCreateSchema
  .pick({ capacityHoursPerWeek: true, email: true, location: true, name: true, roles: true })
  .partial()
  .extend({ expectedVersion })
  .strict();

// Task access for a profile without a login on one project: off, their own tasks, or everyone's.
export const projectTaskAccessSchema = z.object({ scope: z.enum(['off', 'own', 'all']) }).strict();
// Their access link, emailed to them or shown once to copy.
export const taskAccessLinkSchema = z.object({ delivery: z.enum(['email', 'manual']) }).strict();

// Someone already in Odin allocated to one project: a resource from the directory, or a workspace
// user, who gets a profile linked to their login the way the Resources tab makes one. Left out, the
// share of their week follows from the hours.
export const projectAllocationCreateSchema = projectResourceAllocationSchema.extend({
  allocationPercent: z.number().finite().min(0).max(200).optional(),
  resourceId: id.optional(),
  userId: id.optional(),
}).refine((value) => Boolean(value.resourceId) !== Boolean(value.userId), { message: 'Give a resourceId or a userId.', path: ['resourceId'] });
export const projectAllocationUpdateSchema = z.object({
  allocationPercent: z.number().finite().min(0).max(200),
  billRate: z.number().finite().min(0).max(1_000_000).nullable(),
  endDate: date,
  hoursPerWeek: z.number().finite().min(0).max(168),
  role: z.string().trim().max(120),
  startDate: date,
  status: z.enum(['proposed', 'approved', 'active', 'held', 'completed']),
}).partial().extend({ expectedVersion });

const resourceCalendarEntryBaseSchema = z.object({
  endDate: date,
  entryType: z.enum(['working_override', 'leave', 'holiday']),
  hoursPerDay: z.number().finite().min(0).max(24).default(0),
  note: z.string().trim().max(2000).default(''),
  resourceId: id,
  startDate: date,
  status: z.enum(['requested', 'approved', 'rejected']).default('approved'),
  timezone: timezone.default('UTC'),
  weekdays,
});
export const resourceCalendarEntryCreateSchema = resourceCalendarEntryBaseSchema.refine((value) => value.endDate >= value.startDate, { message: 'End date must be on or after start date.', path: ['endDate'] });
export const resourceCalendarEntryUpdateSchema = resourceCalendarEntryBaseSchema.partial().extend({ expectedVersion });

const resourceAllocationBaseSchema = z.object({
  allocationPercent: z.number().finite().min(0).max(200).default(100),
  // What this project bills for the person; null falls back to the resource's bill rate.
  billRate: z.number().finite().min(0).max(1_000_000).nullable().optional().default(null),
  endDate: date,
  hoursPerWeek: z.number().finite().min(0).max(168).default(40),
  // 'assignment' marks allocations Odin added because the person was given work on the project.
  origin: z.enum(['manual', 'assignment']).default('manual'),
  projectId: id,
  resourceId: id,
  role: z.string().trim().max(120).default(''),
  scenario: z.enum(['baseline', 'optimistic', 'constrained']).default('baseline'),
  startDate: date,
  status: z.enum(['proposed', 'approved', 'active', 'held', 'completed']).default('proposed'),
});
export const resourceAllocationCreateSchema = resourceAllocationBaseSchema.refine((value) => value.endDate >= value.startDate, { message: 'End date must be on or after start date.', path: ['endDate'] });
export const resourceAllocationUpdateSchema = resourceAllocationBaseSchema.partial().extend({ expectedVersion });
export const resourceAllocationLevelSchema = z.object({
  expectedVersion,
  hours: z.number().finite().positive().max(168),
  targetResourceId: id,
});

const accountingPeriodBaseSchema = z.object({
  endDate: date,
  fiscalYear: z.number().int().min(1900).max(9999),
  name: z.string().trim().min(1).max(160),
  periodNumber: z.number().int().min(1).max(53),
  startDate: date,
  status: z.enum(['open', 'locked', 'closed']).default('open'),
});
export const accountingPeriodCreateSchema = accountingPeriodBaseSchema.refine((value) => value.endDate >= value.startDate, { message: 'End date must be on or after start date.', path: ['endDate'] });
export const accountingPeriodUpdateSchema = accountingPeriodBaseSchema.partial().extend({ expectedVersion });

export const financePolicyCreateSchema = z.object({
  actualCostVariancePercent: z.number().finite().min(0).max(1000).default(0),
  expenseApprovalAmount: z.number().finite().min(0).max(1_000_000_000_000).default(0),
  forecastVariancePercent: z.number().finite().min(0).max(1000).default(0),
  minimumMarginPercent: z.number().finite().min(-1000).max(100).default(0),
  name: z.string().trim().min(1).max(160),
  projectId: optionalId,
  status: z.enum(['active', 'inactive']).default('active'),
});
export const financePolicyUpdateSchema = financePolicyCreateSchema.partial().extend({ expectedVersion });

export const projectFinancialEntryCreateSchema = z.object({
  amount,
  category: z.string().trim().max(160).default(''),
  currency,
  effectiveDate: date,
  entryKind: z.enum(['budget', 'funding', 'forecast', 'commitment', 'actual_cost', 'revenue', 'capitalized_cost']),
  note: z.string().trim().max(4000).default(''),
  projectId: id,
  sourceId: optionalId,
  sourceType: z.string().trim().max(120).default('manual'),
  status: z.enum(['draft', 'approved', 'posted', 'void']).default('draft'),
});
export const projectFinancialEntryUpdateSchema = projectFinancialEntryCreateSchema.partial().extend({ expectedVersion });

export const timeEntryCreateSchema = z.object({
  billable: z.boolean().default(false),
  hours: z.number().finite().positive().max(24),
  note: z.string().trim().max(2000).default(''),
  periodId: optionalId,
  projectId: id,
  resourceId: id,
  status: z.enum(['submitted', 'approved', 'rejected']).default('submitted'),
  workDate: date,
  workItemId: optionalId,
});
export const timeEntryUpdateSchema = timeEntryCreateSchema.partial().extend({ expectedVersion });

// Time logged on one project through its own route. Left out, the person is the signed-in user's
// resource profile and the date is today; the timesheet period is always the one holding the date.
export const projectTimeEntryCreateSchema = z.object({
  billable: z.boolean().default(false),
  hours: z.number().finite().positive().max(24),
  note: z.string().trim().max(2000).default(''),
  resourceId: id.optional(),
  workDate: date.optional(),
  workItemId: optionalId,
});
export const projectTimeEntryUpdateSchema = z.object({
  billable: z.boolean(),
  hours: z.number().finite().positive().max(24),
  note: z.string().trim().max(2000),
  status: z.enum(['submitted', 'approved', 'rejected']),
  workDate: date,
  workItemId: id.nullable(),
}).partial().extend({ expectedVersion });
const mine = z.enum(['true', 'false']).optional();
export const timeEntryListQuerySchema = z.object({
  from: date.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  mine,
  projectId: id.optional(),
  resourceId: id.optional(),
  to: date.optional(),
});
export const calendarEntryListQuerySchema = timeEntryListQuerySchema.omit({ projectId: true });

export const expenseEntryCreateSchema = z.object({
  amount: amount.refine((value) => value >= 0, 'Expense amount cannot be negative.'),
  category: z.string().trim().min(1).max(160),
  currency,
  expenseDate: date,
  note: z.string().trim().max(2000).default(''),
  projectId: id,
  receiptReference: z.string().trim().max(500).default(''),
  resourceId: optionalId,
  status: z.enum(['submitted', 'approved', 'rejected']).default('submitted'),
});
export const expenseEntryUpdateSchema = expenseEntryCreateSchema.partial().extend({ expectedVersion });

const resourceRateBaseSchema = z.object({
  billRate: z.number().finite().min(0).max(1_000_000),
  costRate: z.number().finite().min(0).max(1_000_000),
  currency,
  effectiveEnd: date.nullable().optional().default(null),
  effectiveStart: date,
  resourceId: id,
  status: z.enum(['draft', 'approved', 'retired']).default('draft'),
});
export const resourceRateCreateSchema = resourceRateBaseSchema.refine((value) => !value.effectiveEnd || value.effectiveEnd >= value.effectiveStart, { message: 'Effective end must be on or after effective start.', path: ['effectiveEnd'] });
export const resourceRateUpdateSchema = resourceRateBaseSchema.partial().extend({ expectedVersion });

const timesheetPeriodBaseSchema = z.object({
  approvalDueDate: date.nullable().optional().default(null),
  endDate: date,
  name: z.string().trim().min(1).max(160),
  startDate: date,
  status: z.enum(['open', 'locked', 'closed']).default('open'),
});
export const timesheetPeriodCreateSchema = timesheetPeriodBaseSchema.refine((value) => value.endDate >= value.startDate, { message: 'End date must be on or after start date.', path: ['endDate'] });
export const timesheetPeriodUpdateSchema = timesheetPeriodBaseSchema.partial().extend({ expectedVersion });

export const expenseReceiptCreateSchema = z.object({
  contentType: z.string().trim().min(1).max(160),
  expenseId: id,
  fileName: z.string().trim().min(1).max(240),
  sha256: z.string().trim().toLowerCase().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().nonnegative().max(100_000_000),
  status: z.enum(['active', 'deleted']).default('active'),
  storageKey: z.string().trim().min(1).max(500),
});
export const expenseReceiptUpdateSchema = expenseReceiptCreateSchema.partial().extend({ expectedVersion });
export const expenseReceiptUploadSchema = z.object({
  contentBase64: z.string().trim().min(1).max(14_000_000),
  contentType: z.enum(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']),
  fileName: z.string().trim().min(1).max(240),
});

const exchangeRateBaseSchema = z.object({
  baseCurrency: currency,
  effectiveDate: date,
  quoteCurrency: currency,
  rate: z.number().finite().positive().max(1_000_000),
  source: z.string().trim().min(1).max(160).default('manual'),
  status: z.enum(['draft', 'approved', 'retired']).default('draft'),
});
export const exchangeRateCreateSchema = exchangeRateBaseSchema.refine((value) => value.baseCurrency !== value.quoteCurrency, { message: 'Base and quote currencies must differ.', path: ['quoteCurrency'] });
export const exchangeRateUpdateSchema = exchangeRateBaseSchema.partial().extend({ expectedVersion });

export const resourceFinanceQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  projectId: id.optional(),
  query: z.string().trim().max(240).default(''),
  reportingCurrency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(),
  scenario: z.enum(['baseline', 'optimistic', 'constrained']).optional(),
  status: z.string().trim().max(64).default(''),
});

export const versionedResourceFinanceDeleteSchema = z.object({ expectedVersion });
