// Request shapes for the billing routes. The /api/v1 ones follow
// docs/invoice-gen-connection/api-contract.md, which invoice-gen is built against: extra fields
// are dropped rather than refused, so invoice-gen can add fields without breaking Odin.
import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
const timestamp = z.string().trim().datetime({ offset: true });
const externalKey = z.union([z.number().int().nonnegative(), z.string().trim().min(1).max(64)]);
// Links shown in Odin go only to web pages.
const webUrl = z.string().trim().max(2000).refine((value) => {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}, 'Use an http or https URL.');
const optionalWebUrl = z.union([webUrl, z.literal('')]).nullable().optional().transform((value) => value || '');

export const externalInvoiceIdSchema = z.string().trim().regex(/^[A-Za-z0-9._:-]{1,64}$/, 'Use invoice-gen\'s invoice id.');
const entryId = z.string().trim().min(1).max(128);

export const billingLinkSchema = z.object({
  customer: z.object({ id: externalKey, name: z.string().trim().max(255).default('') }),
  lineOfBusiness: z.object({ id: externalKey, name: z.string().trim().max(255).default('') }).nullable().optional().default(null),
  agreement: z.object({
    id: externalKey,
    title: z.string().trim().max(500).default(''),
    status: z.string().trim().min(1).max(32),
    rateCents: z.number().int().nonnegative().nullable().optional().default(null),
    url: optionalWebUrl,
    executedAt: timestamp.nullable().optional().default(null),
    milestones: z.array(z.object({
      id: z.number().int().nonnegative(),
      name: z.string().trim().max(255).default(''),
      shortLabel: z.string().trim().max(80).nullable().optional().transform((value) => value ?? ''),
      hours: z.number().finite().nonnegative().default(0),
    })).max(200).default([]),
  }).nullable().optional().default(null),
  sourceUpdatedAt: timestamp,
});

export const invoiceSummarySchema = z.object({
  number: z.string().trim().max(120).nullable().optional().transform((value) => value ?? ''),
  status: z.enum(['draft', 'submitted', 'paid', 'void']),
  overdue: z.boolean().default(false),
  issueDate: isoDate.nullable().optional().default(null),
  submittedDate: isoDate.nullable().optional().default(null),
  dueDate: isoDate.nullable().optional().default(null),
  paidDate: isoDate.nullable().optional().default(null),
  hours: z.number().finite().min(0).max(1_000_000).default(0),
  totalCents: z.number().int().default(0),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/).transform((value) => value.toUpperCase()).default('USD'),
  url: optionalWebUrl,
  sourceUpdatedAt: timestamp,
});

export const invoiceClaimSchema = z.object({
  externalInvoiceId: externalKey.transform(String).pipe(externalInvoiceIdSchema),
  add: z.array(entryId).max(5000).default([]),
  remove: z.array(entryId).max(5000).default([]),
});

export const billableTimeQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
  includeInvoice: externalInvoiceIdSchema.optional(),
}).refine((value) => value.from <= value.to, { message: 'from must be on or before to.', path: ['from'] });

// The story mapping managers set (PUT /api/projects/:projectId/billing/milestones).
export const storyMilestonesUpdateSchema = z.object({
  assignments: z.array(z.object({
    storyId: z.string().trim().min(1).max(128),
    milestoneId: z.number().int().nonnegative().nullable(),
  }).strict()).min(1).max(500),
}).strict();
