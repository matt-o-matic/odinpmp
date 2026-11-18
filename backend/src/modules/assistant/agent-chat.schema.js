import { z } from 'zod';

const id = z.string().trim().min(1).max(120);
const pageContext = z.object({
  itemId: id.optional(),
  label: z.string().trim().max(200).optional(),
  view: z.string().trim().max(80).optional(),
}).strip().nullable().optional();

export const agentChatCreateSchema = z.object({
  projectId: id.nullable().optional().default(null),
}).strict();

export const agentChatUpdateSchema = z.object({
  allowWebResearch: z.boolean().optional(),
  title: z.string().trim().min(1).max(120).optional(),
}).strict();

export const agentChatMessageSchema = z.object({
  allowWebResearch: z.boolean().optional(),
  attachments: z.array(z.object({
    dataUrl: z.string().max(8 * 1024 * 1024).regex(/^data:image\/(png|jpe?g|gif|webp);base64,/, 'Images must be PNG, JPEG, GIF or WebP.').optional(),
    mimeType: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(200),
    size: z.number().int().min(0).max(50 * 1024 * 1024).optional(),
    text: z.string().max(200000).optional(),
  }).strict().refine((file) => file.text !== undefined || file.dataUrl !== undefined, 'Attach file text or an image.')).max(6).optional().default([]),
  message: z.string().trim().min(1).max(20000),
  pageContext,
}).strict();

export const agentChatConfirmationSchema = z.object({
  callId: id,
  decision: z.enum(['approve', 'decline']),
  pageContext,
}).strict();

export const agentChatProposalSchema = z.object({
  decision: z.enum(['apply', 'dismiss']),
  itemIds: z.array(id).max(200).optional(),
  proposalId: id,
}).strict();
