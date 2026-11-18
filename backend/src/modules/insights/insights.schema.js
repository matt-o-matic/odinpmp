import { z } from 'zod';

import { BUILT_IN_CARD_TYPES, MAX_INSIGHTS_CARDS, REPORT_CARD_TYPE } from './insights-layout.js';

export const INSIGHTS_DAY_OPTIONS = Object.freeze([30, 90, 180]);

// agentView=1 builds Insights without the tickets agents may not see (D-027). odin_get_insights and
// odin_get_timeline always send it.
export const insightsQuerySchema = z.object({
  agentView: z.enum(['0', '1']).optional(),
  days: z.coerce.number().int().refine((value) => INSIGHTS_DAY_OPTIONS.includes(value), 'Choose 30, 90 or 180 days.').default(90),
  sprintId: z.string().trim().max(128).optional().transform((value) => value || null),
  unit: z.enum(['points', 'items']).default('points'),
});

const builtInCardSchema = z.object({ type: z.enum(BUILT_IN_CARD_TYPES) }).strict();
const reportCardSchema = z.object({ reportId: z.string().trim().min(1).max(128), type: z.literal(REPORT_CARD_TYPE) }).strict();

export const insightsLayoutWriteSchema = z.object({
  cards: z.array(z.union([builtInCardSchema, reportCardSchema])).max(MAX_INSIGHTS_CARDS),
  expectedVersion: z.number().int().min(0),
}).strict();

export const insightsLayoutResetSchema = z.object({
  expectedVersion: z.number().int().min(1),
}).strict();
