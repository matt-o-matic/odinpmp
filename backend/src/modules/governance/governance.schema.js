import { z } from 'zod';

const id = z.string().trim().min(1).max(128);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional();
const expectedVersion = z.number().int().positive();

export const governanceItemCreateSchema = z.object({
  description: z.string().trim().max(8000).default(''),
  dueDate: date.default(null),
  impact: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  kind: z.enum(['risk', 'assumption', 'issue', 'decision', 'change_request']),
  ownerId: id.nullable().optional().default(null),
  probability: z.enum(['low', 'medium', 'high']).nullable().optional().default(null),
  responsePlan: z.string().trim().max(8000).default(''),
  status: z.enum(['open', 'monitoring', 'approved', 'rejected', 'resolved', 'closed']).default('open'),
  title: z.string().trim().min(1).max(240),
});

export const governanceItemUpdateSchema = governanceItemCreateSchema.partial().extend({ expectedVersion });

export const dependencyCreateSchema = z.object({
  dependencyType: z.enum(['FS', 'SS', 'FF', 'SF']).default('FS'),
  lagDays: z.number().int().min(-365).max(365).default(0),
  predecessorId: id,
  successorId: id,
}).refine((value) => value.predecessorId !== value.successorId, {
  message: 'A work item cannot depend on itself.', path: ['successorId'],
});
export const dependencyUpdateSchema = z.intersection(
  dependencyCreateSchema,
  z.object({ expectedVersion }),
);

export const milestoneCreateSchema = z.object({
  status: z.enum(['planned', 'at_risk', 'achieved', 'missed']).default('planned'),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  title: z.string().trim().min(1).max(240),
  workItemId: id.nullable().optional().default(null),
});

export const milestoneUpdateSchema = milestoneCreateSchema.partial().extend({ expectedVersion });
export const versionedDeleteSchema = z.object({ expectedVersion });

export const workingCalendarWriteSchema = z.object({
  expectedVersion: expectedVersion.nullable().optional().default(null),
  holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(366).optional().default([]),
  hoursPerDay: z.number().min(0.5).max(24).optional().default(8),
  timezone: z.string().trim().min(1).max(80).optional().default('UTC'),
  workingDays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional().default([1, 2, 3, 4, 5]),
}).superRefine((value, context) => {
  if (new Set(value.workingDays).size !== value.workingDays.length) context.addIssue({ code: 'custom', message: 'Working days must be unique.', path: ['workingDays'] });
  if (new Set(value.holidays).size !== value.holidays.length) context.addIssue({ code: 'custom', message: 'Holidays must be unique.', path: ['holidays'] });
  try { new Intl.DateTimeFormat('en-US', { timeZone: value.timezone }); } catch { context.addIssue({ code: 'custom', message: 'Timezone must be a valid IANA timezone.', path: ['timezone'] }); }
});

// agentView=1 answers with only what agents may see (D-027). The governance tools always send it,
// and every MCP credential gets it anyway.
export const governanceAgentViewQuerySchema = z.object({ agentView: z.enum(['0', '1']).optional() });

export const scheduleBaselineCreateSchema = z.object({
  name: z.string().trim().min(1).max(160),
  note: z.string().trim().max(2000).optional().default(''),
});
