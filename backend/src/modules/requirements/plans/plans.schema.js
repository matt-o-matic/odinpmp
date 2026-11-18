import { z } from 'zod';

import { trackSchema } from '../requirements.schema.js';
import { PLAN_LIMITS } from './plan-content.js';

// Request bodies for the track plan routes. Decision citations accept decision ids (what
// the API returns) or display labels such as D-07.

const decisionRefs = z.array(z.string().trim().min(1).max(80)).max(PLAN_LIMITS.decisionIdsPerItem).optional().default([]);

const planItemSchema = z.object({
  decisionIds: decisionRefs,
  text: z.string().trim().min(1).max(PLAN_LIMITS.text),
});

const criterionSchema = z.object({
  decisionIds: decisionRefs,
  id: z.preprocess((value) => (value == null ? '' : value), z.string().trim().max(20)).optional().default(''),
  scenario: z.string().trim().min(1).max(PLAN_LIMITS.scenario),
});

export const planListQuerySchema = z.object({
  track: z.preprocess((value) => (value === '' ? undefined : value), trackSchema.optional()),
});

// `revision` is the optimistic-concurrency counter every plan response carries. It is not
// the plan's version number (v1, v2, ...), which only grows when a new version is created.
export const planPatchSchema = z.object({
  criteria: z.array(criterionSchema).max(PLAN_LIMITS.criteria).optional(),
  nonGoals: z.array(planItemSchema).max(PLAN_LIMITS.items).optional(),
  objective: z.string().trim().max(PLAN_LIMITS.objective).optional(),
  revision: z.number().int().min(1),
  scope: z.array(planItemSchema).max(PLAN_LIMITS.items).optional(),
}).refine((value) => ['criteria', 'nonGoals', 'objective', 'scope'].some((key) => value[key] !== undefined), {
  message: 'Provide at least one of objective, scope, nonGoals, or criteria.',
});

// Approval names the revision the approver reviewed, so an edit made after they loaded the
// plan is a conflict instead of being approved unseen.
export const planApproveSchema = z.object({
  revision: z.number().int().min(1),
});
