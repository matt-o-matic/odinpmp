import { z } from 'zod';

const targetTypeSchema = z.enum(['project', 'epic', 'story', 'task', 'ticket']);
// People to @mention by user id, for clients that do not write the editor's mention spans.
const mentionsSchema = z.array(z.string().trim().min(1).max(120)).max(20).optional();

export const commentQuerySchema = z.object({
  targetId: z.string().trim().min(1).max(120),
  targetType: targetTypeSchema,
});

export const commentCreateSchema = commentQuerySchema.extend({
  comment: z.string().trim().min(1).max(50000),
  mentions: mentionsSchema,
  parentId: z.preprocess((value) => {
    if (value === '' || value == null) {
      return null;
    }

    return value;
  }, z.string().trim().min(1).max(120).nullable()).optional().default(null),
});

export const commentUpdateSchema = z.object({
  comment: z.string().trim().min(1).max(50000),
  mentions: mentionsSchema,
});

export const commentVoteSchema = z.object({
  vote: z.enum(['up', 'down']),
});
