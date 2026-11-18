import { z } from 'zod';

// Request bodies for signature requests.

const id = z.string().trim().min(1).max(120);
const reason = z.preprocess((value) => value ?? '', z.string().trim().max(1000)).optional();

export const signingListQuerySchema = z.object({
  fileId: id.optional(),
  status: z.enum(['pending', 'completed', 'declined', 'cancelled']).optional(),
});

export const signingRequestCreateSchema = z.object({
  kind: z.enum(['acceptance', 'signoff']),
  subjectType: z.enum(['project', 'milestone']).optional(),
  subjectId: id.optional(),
  title: z.string().trim().min(1).max(240),
  statement: z.string().trim().max(4000).optional(),
  message: z.string().trim().max(4000).optional(),
  documents: z.array(z.object({ fileId: id, version: z.number().int().min(1).optional() }).strict()).max(20).default([]),
  signerStakeholderIds: z.array(id).min(1).max(20),
}).strict().refine((value) => value.subjectType !== 'milestone' || Boolean(value.subjectId), { message: 'Give the milestone id as subjectId.', path: ['subjectId'] });

export const signingReasonSchema = z.object({ reason }).strict();

export const signingRemindSchema = z.object({ signerId: id.optional() }).strict();

export const signingPositionSchema = z.object({ position: z.coerce.number().int().min(0).max(100) });

export const signingSignSchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from the email.'),
  fullName: z.string().trim().min(1).max(255),
  title: z.string().trim().max(255).default(''),
  organization: z.string().trim().max(255).default(''),
  consent: z.literal(true),
  browser: z.object({
    language: z.string().max(100).optional(),
    platform: z.string().max(200).optional(),
    timeZone: z.string().max(200).optional(),
  }).default({}),
}).strict();
