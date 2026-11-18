import { z } from 'zod';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const compliancePolicyUpdateSchema = z.object({
  auditRetentionDays: z.number().int().min(30).max(3650),
  dataRegion: z.enum(['au', 'ca', 'eu', 'uk', 'us']),
  expectedVersion: z.number().int().nonnegative(),
  legalHold: z.boolean(),
  privacyDeletionDays: z.number().int().min(1).max(365),
  wormRetentionDays: z.number().int().min(30).max(3650),
});

export const complianceAuditExportSchema = z.object({
  endDate: date,
  startDate: date,
}).refine((value) => value.endDate >= value.startDate, {
  message: 'End date must be on or after start date.',
  path: ['endDate'],
});

export const complianceIdSchema = z.string().uuid();

export const complianceSiemFeedSchema = z.object({
  cursor: z.string().trim().max(1000).default(''),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

export const privacyErasureRequestSchema = z.object({
  reason: z.string().trim().min(10).max(2000),
  subjectUserId: z.string().trim().min(1).max(128),
});

export const privacyErasureExecuteSchema = z.object({
  expectedVersion: z.number().int().positive(),
});

export const legalHoldCreateSchema = z.object({
  reason: z.string().trim().min(10).max(4000),
  resourceId: z.string().trim().min(1).max(255),
  resourceType: z.enum(['audit_export', 'connector_object', 'file', 'financial_entry', 'privacy_subject', 'project', 'report']),
});
export const legalHoldReleaseSchema = z.object({ expectedVersion: z.number().int().positive(), reason: z.string().trim().min(10).max(4000) });
export const controlAttestationCreateSchema = z.object({
  controlKey: z.string().trim().regex(/^[a-z][a-z0-9_.-]{2,127}$/),
  evidenceRefs: z.array(z.string().trim().min(1).max(500)).min(1).max(100),
  periodEnd: date,
  periodStart: date,
  statement: z.string().trim().min(20).max(8000),
}).refine((value) => value.periodEnd >= value.periodStart, { message: 'Period end must be on or after period start.', path: ['periodEnd'] });
