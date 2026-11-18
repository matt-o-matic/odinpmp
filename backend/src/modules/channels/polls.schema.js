import { z } from 'zod';

import { POLL_KINDS, POLL_OPTIONS_MAX, POLL_SHOW_RESULTS } from './polls.js';

// Request shapes for polls (polls.js checks the rest: lengths, duplicates, scales, dates), shared
// by the members', guests' and direct-message routes.

export const pollInputSchema = z.object({
  closesAt: z.string().trim().max(40).nullable().optional(),
  kind: z.enum(POLL_KINDS),
  options: z.array(z.string().max(400)).max(POLL_OPTIONS_MAX).optional().default([]),
  question: z.string().max(600),
  settings: z.object({
    anonymous: z.boolean().optional(),
    maxChoices: z.number().int().min(1).max(POLL_OPTIONS_MAX).nullable().optional(),
    scaleMax: z.number().int().nullable().optional(),
    showResults: z.enum(POLL_SHOW_RESULTS).optional(),
  }).strict().optional().default({}),
}).strict();

const optionId = z.string().trim().min(1).max(16);

export const pollVoteSchema = z.object({
  answer: z.object({
    optionIds: z.array(optionId).max(POLL_OPTIONS_MAX).optional(),
    order: z.array(optionId).max(POLL_OPTIONS_MAX).optional(),
    text: z.string().max(2000).optional(),
    value: z.number().int().optional(),
  }).strict(),
}).strict();
