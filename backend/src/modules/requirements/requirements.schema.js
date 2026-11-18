import { z } from 'zod';

import { DECISION_OUTCOMES, REQUIREMENTS_TRACKS } from './requirements.repository.js';

function optionalString(max = 5000) {
  return z.preprocess((value) => value == null ? '' : value, z.string().trim().max(max));
}

export const trackSchema = z.enum(REQUIREMENTS_TRACKS);

export const SOURCE_REF_PATTERN = /^[a-z][a-z0-9-]*(?::[A-Za-z0-9._-]+)*$/;

const sourceRefSchema = z.string().trim().min(1).max(160).regex(SOURCE_REF_PATTERN, 'Use a source reference such as brief:requirements:2.');

const assignmentSchema = z.object({
  actorId: z.string().trim().min(1).max(120),
  actorType: z.enum(['stakeholder', 'user']),
  label: optionalString(255).optional().default(''),
  role: z.enum(['primary', 'required', 'collaborator']).optional().default('collaborator'),
});

export const topicListQuerySchema = z.object({
  // `summaries` adds each topic's current Odin summary output (team audience, with names).
  include: z.preprocess((value) => (value === '' ? undefined : value), z.enum(['summaries']).optional()),
  q: optionalString(200).optional().default(''),
  // `all` leaves dismissed topics out; `every` includes them (the register filters on the client).
  view: z.enum(['all', 'every', 'needs-decision', 'open', 'decided', 'dismissed']).optional().default('all'),
});

export const topicCreateSchema = z.object({
  assignments: z.array(assignmentSchema).max(20).optional().default([]),
  prompt: z.string().trim().min(1).max(2000),
  rationale: optionalString(2000).optional().default(''),
  settles: optionalString(160).optional().default(''),
  sourceRef: z.preprocess((value) => (value === '' ? null : value), sourceRefSchema.nullable()).optional().default(null),
  suggestedOwnerRole: optionalString(120).optional().default(''),
});

export const topicPatchSchema = z.object({
  assignments: z.array(assignmentSchema).max(20).optional(),
  // Optional precondition: save the assignments only if exactly these stakeholder ids would
  // be emailed an invitation (409 and no change otherwise), and email only them.
  expectedInvitationRecipients: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  prompt: z.string().trim().min(1).max(2000).optional(),
  rationale: z.string().trim().max(2000).optional(),
  settles: z.string().trim().max(160).optional(),
  status: z.enum(['open', 'resolved', 'dismissed']).optional(),
  suggestedOwnerRole: z.string().trim().max(120).optional(),
}).refine((value) => Object.values(value).some((entry) => entry !== undefined), {
  message: 'Provide at least one field to change.',
}).refine(({ assignments, expectedInvitationRecipients, ...fields }) => expectedInvitationRecipients === undefined
  || (assignments !== undefined && Object.values(fields).every((entry) => entry === undefined)), {
  message: 'expectedInvitationRecipients can only accompany assignments.',
});

const bulkPersonSchema = z.object({
  actorId: z.string().trim().min(1).max(120),
  actorType: z.enum(['stakeholder', 'user']),
});

export const TOPIC_BULK_ACTIONS = Object.freeze(['agree', 'assign', 'defer', 'delete', 'dismiss', 'reopen']);

export const topicBulkSchema = z.object({
  action: z.enum(TOPIC_BULK_ACTIONS),
  // assign: each topic's people change the same way. An omitted owner keeps each topic's
  // owner; null clears it. add joins as "also involve"; remove takes people off entirely.
  assign: z.object({
    add: z.array(bulkPersonSchema).max(20).optional().default([]),
    owner: bulkPersonSchema.nullable().optional(),
    remove: z.array(bulkPersonSchema).max(20).optional().default([]),
  }).optional(),
  // defer: the reason recorded on every topic.
  statement: z.string().trim().max(10_000).optional().default(''),
  topicIds: z.array(z.string().trim().min(1).max(36)).min(1).max(100),
}).refine((value) => value.action !== 'assign' || (value.assign && (value.assign.owner !== undefined || value.assign.add.length || value.assign.remove.length)), {
  message: 'Choose an owner, people to add, or people to remove.',
}).refine((value) => value.action !== 'defer' || value.statement.length > 0, {
  message: 'Say why these topics are deferred.',
});

export const topicMoveSchema = z.object({
  track: trackSchema,
});

export const topicCommentSchema = z.object({
  body: z.string().trim().min(1).max(20_000),
  parentCommentId: optionalString(120).optional().default(''),
});

export const topicCommentUpdateSchema = z.object({
  body: z.string().trim().min(1).max(20_000),
});

export const topicCommentVoteSchema = z.object({
  vote: z.enum(['up', 'down']),
});

const sourcesSchema = z.array(z.string().trim().min(1).max(160)).max(50).optional().default([]);

export const decisionCreateSchema = z.object({
  outcome: z.enum(DECISION_OUTCOMES),
  sourceSummaryId: optionalString(36).optional().default(''),
  sources: sourcesSchema,
  statement: z.string().trim().min(1).max(10_000),
  supersedesId: optionalString(36).optional().default(''),
  topicId: z.string().trim().min(1).max(36),
});

export const decisionPatchSchema = z.object({
  outcome: z.enum(DECISION_OUTCOMES).optional(),
  sources: z.array(z.string().trim().min(1).max(160)).max(50).optional(),
  statement: z.string().trim().min(1).max(10_000).optional(),
  version: z.number().int().min(1),
});

export const decisionListQuerySchema = z.object({
  kind: z.enum(['topic', 'preference', 'round']).optional(),
});

export const preferenceAcceptSchema = z.object({
  dimension: z.string().trim().min(1).max(80),
  key: optionalString(120).optional().default(''),
  outcome: z.enum(['agreed', 'decided']).optional().default('agreed'),
  sourceSummaryId: optionalString(36).optional().default(''),
  sources: sourcesSchema,
  stance: z.enum(['keep', 'change', 'undecided']),
  statement: z.string().trim().min(1).max(10_000),
  track: trackSchema,
});

export const accessLinkCreateSchema = z.object({
  // Email the new link to the stakeholder as well as returning it.
  send: z.boolean().optional().default(false),
  stakeholderId: z.string().trim().min(1).max(36),
});

export const accessLinkExtendSchema = z.object({
  until: z.string().trim().datetime({ offset: true }),
});

// Structured output for "Draft questions from brief". The service validates every
// provider's output against this schema, including stubs and the local fixture.
export const draftQuestionsOutputSchema = z.object({
  questions: z.array(z.object({
    prompt: z.string().trim().min(1).max(2000),
    rationale: z.string().trim().max(2000).default(''),
    recommendation: z.string().trim().max(600).default(''),
    settles: z.string().trim().max(400).default(''),
    sourceRef: z.string().trim().min(1).max(160),
    suggestedOwnerRole: z.string().trim().max(120).default(''),
  })).max(40),
});
