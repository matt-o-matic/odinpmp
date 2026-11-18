import { z } from 'zod';

import { projectItemPatchSchema } from '../projects/projects.schema.js';

// odin_apply_item_changes: a batch of checked changes (docs/mcp-change-feed/plan.md). The route
// and the MCP tool validate with the same schema.
export const MAX_APPLY_CHANGES = 25;

const itemChangeSchema = z.object({
  comment: z.string().trim().min(1).max(10_000).optional(),
  evidence: z.array(z.object({ note: z.string().trim().max(500).optional(), ref: z.string().trim().min(1).max(500) }).strict()).max(10).optional(),
  expected: z.object({
    changeSeq: z.number().int().min(0).optional(),
    version: z.number().int().positive(),
    workflowVersion: z.number().int().positive().nullable().optional(),
  }).strict(),
  idempotencyKey: z.string().trim().regex(/^[A-Za-z0-9._:-]{8,128}$/, 'Use 8 to 128 letters, digits, dots, colons, underscores or hyphens.'),
  itemId: z.string().trim().min(1).max(120),
  patch: projectItemPatchSchema.strict().optional(),
  reason: z.string().trim().min(1).max(1000),
}).strict().refine((change) => Boolean(change.comment) || Object.keys(change.patch ?? {}).length > 0, 'A change needs a patch, a comment, or both.');
export const itemChangesSchema = z.object({
  basedOn: z.string().trim().min(1).max(400).optional(),
  changes: z.array(itemChangeSchema).min(1).max(MAX_APPLY_CHANGES),
}).strict();
