import { z } from 'zod';

import { trackSchema } from '../requirements.schema.js';
import { DIRECTION_STANCES, VERDICT_DIMENSION_VALUES, VERDICT_OVERALL_VALUES } from './round-manifest.js';
import { ROUND_OUTCOMES } from './rounds.repository.js';

// Request bodies for rounds and the review API. Shapes are validated in two steps:
// structure here (zod), then bounds and minimum size in annotation-shapes.js, where the
// screen's pixel size is known.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function optionalText(max) {
  return z.preprocess((value) => (value == null ? '' : value), z.string().trim().max(max));
}

export const uuidSchema = z.string().trim().regex(UUID_PATTERN, 'Use a UUID.');

const reviewerSchema = z.object({
  actorId: z.string().trim().min(1).max(36),
  actorType: z.enum(['user', 'stakeholder']),
  required: z.boolean().optional().default(false),
});

const futureDate = z.string().trim().datetime({ offset: true });

const reminderSchema = z.object({ daysBefore: z.number().int().min(1).max(30) }).nullable();

export const closeRoundSchema = z.object({
  directionId: optionalText(120).optional().default(''),
  outcome: z.enum(ROUND_OUTCOMES),
  statement: optionalText(10_000).optional().default(''),
});

export const publishRoundSchema = z.object({
  closePrevious: closeRoundSchema.optional(),
  dueAt: futureDate.nullable().optional().default(null),
  note: optionalText(4000).optional().default(''),
  packageId: z.string().trim().min(1).max(36),
  reminder: reminderSchema.optional().default(null),
  reviewers: z.array(reviewerSchema).min(1).max(100),
});

export const patchRoundSchema = z.object({
  addReviewers: z.array(reviewerSchema).max(100).optional(),
  dueAt: futureDate.nullable().optional(),
  note: z.string().trim().max(4000).optional(),
  reminder: reminderSchema.optional(),
  removeReviewerIds: z.array(z.string().trim().min(1).max(36)).max(100).optional(),
  updateReviewers: z.array(z.object({ id: z.string().trim().min(1).max(36), required: z.boolean() })).max(100).optional(),
}).refine((value) => Object.values(value).some((entry) => entry !== undefined), {
  message: 'Provide at least one field to change.',
});

export const roundListQuerySchema = z.object({
  track: z.preprocess((value) => (value === '' ? undefined : value), trackSchema.optional()),
});

export const feedbackQuerySchema = z.object({
  cursor: z.string().trim().max(40).optional(),
  limit: z.preprocess((value) => (value === undefined || value === '' ? undefined : Number(value)), z.number().int().min(1).max(500).optional()),
});

export const summaryRefreshSchema = z.object({
  screenId: optionalText(120).optional().default(''),
});

// --- Review API -------------------------------------------------------------

export const directionStanceSchema = z.object({
  remix: optionalText(2000).optional().default(''),
  stance: z.enum(DIRECTION_STANCES),
});

export const screenVerdictSchema = z.object({
  change: optionalText(4000).optional().default(''),
  dimensions: z.record(z.string().trim().min(1).max(64), z.enum(VERDICT_DIMENSION_VALUES)).optional().default({}),
  mixed: optionalText(4000).optional().default(''),
  overall: z.enum(VERDICT_OVERALL_VALUES),
  stay: optionalText(4000).optional().default(''),
});

export const answerSchema = z.object({
  value: z.union([z.string(), z.number(), z.array(z.string().max(64)).max(12)]),
});

export const positionSchema = z.object({
  directionId: z.string().trim().max(120).nullable().optional(),
  questionId: z.string().trim().max(120).nullable().optional(),
  screenId: z.string().trim().max(120).nullable().optional(),
  stateKey: z.string().trim().max(512).nullable().optional(),
  step: z.enum(['overview', 'directions', 'screens', 'questions', 'submit']),
});

const finite = z.number().finite();

const elementHintSchema = z.object({
  box: z.object({ height: finite, width: finite, x: finite, y: finite }).nullable().optional(),
  odinId: z.string().max(64).nullable().optional(),
  tag: z.string().max(40).nullable().optional(),
  text: z.string().max(200).nullable().optional(),
});

export const MAX_SHAPES_PER_ANNOTATION = 50;

export const annotationUpsertSchema = z.object({
  anchor: z.object({
    note: z.string().trim().max(500).optional(),
    // Where the prototype was scrolled when its snapshot was taken, so the mark can sit on the live page.
    scroll: z.object({ x: finite, y: finite }).optional(),
    snapshotUnavailable: z.boolean().optional(),
  }).optional().default({}),
  category: z.string().trim().max(64).nullable().optional().default(null),
  elementHint: elementHintSchema.nullable().optional().default(null),
  restored: z.boolean().optional().default(false),
  screenId: z.string().trim().min(1).max(120),
  shapes: z.array(z.unknown()).min(1).max(MAX_SHAPES_PER_ANNOTATION),
  snapshotFileId: uuidSchema.nullable().optional().default(null),
  stateKey: z.string().trim().max(512).nullable().optional().default(null),
});

export const annotationStatusSchema = z.object({
  status: z.enum(['open', 'resolved']),
});

export const annotationCommentSchema = z.object({
  body: z.string().trim().min(1).max(10_000),
  parentCommentId: optionalText(36).optional().default(''),
});

export const annotationCommentUpdateSchema = z.object({
  body: z.string().trim().min(1).max(10_000),
});

export const snapshotQuerySchema = z.object({
  screenId: z.string().trim().max(120).optional(),
  stateKey: z.string().trim().max(512).optional(),
});
