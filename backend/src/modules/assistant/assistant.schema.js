import { z } from 'zod';

function optionalString(max = 5000) {
  return z.preprocess((value) => value == null ? '' : value, z.string().trim().max(max));
}

export const assistantStakeholderContactSchema = z.object({
  email: z.string().trim().email().max(255),
  name: z.string().trim().min(1).max(255),
  roleTitle: optionalString(160).optional().default(''),
});

export const assistantStakeholderContactUpdateSchema = z.object({
  email: z.string().trim().email().max(255).optional(),
  name: z.string().trim().min(1).max(255).optional(),
  roleTitle: z.string().trim().max(160).optional(),
}).refine((value) => Object.values(value).some((entry) => entry !== undefined), {
  message: 'Provide a name, email or role title to change.',
});

const inboundClarificationMailAttachmentSchema = z.object({
  contentBase64: z.string().trim().min(1).max(20_000_000),
  contentType: optionalString(255).optional().default('application/octet-stream'),
  fileName: z.string().trim().min(1).max(255),
});

export const inboundClarificationMailSchema = z.object({
  attachments: z.array(inboundClarificationMailAttachmentSchema).max(20).optional().default([]),
  fromEmail: z.string().trim().email().max(255),
  htmlBody: optionalString(200_000).optional().default(''),
  inReplyTo: optionalString(255).optional().default(''),
  messageId: z.string().trim().min(1).max(255),
  provider: z.string().trim().min(1).max(80),
  subject: optionalString(255).optional().default(''),
  textBody: optionalString(200_000).optional().default(''),
  toEmail: z.string().trim().email().max(255),
});
