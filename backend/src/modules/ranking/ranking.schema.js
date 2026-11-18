import { z } from 'zod';

export const rankingVoteSchema = z.object({
  loserId: z.string().trim().min(1),
  winnerId: z.string().trim().min(1),
});

export const rankingSkipSchema = z.object({
  projectAId: z.string().trim().min(1),
  projectBId: z.string().trim().min(1),
});

export const rankingCompletionQuerySchema = z
  .object({
    threshold: z.coerce.number().int().min(1).max(100).default(70),
  })
  .passthrough();

