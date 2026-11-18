import { z } from 'zod';

// Bodies the public access link routes take. Each is strict: a field outside the list is a 400,
// whatever the client sends (docs/task-access/plan.md, AC7).

const expectedVersion = z.number().int().positive();
const remainingHours = z.number().finite().min(0).max(100000).nullable();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must use YYYY-MM-DD format.');

// What a person may change on their own task: its status, its board column and remaining hours.
export const accessTaskPatchSchema = z.object({
  boardColumn: z.string().trim().min(1).max(80).optional(),
  expectedVersion,
  remainingHours: remainingHours.optional(),
  status: z.string().trim().min(1).max(80).optional(),
}).strict().refine(
  (value) => value.status !== undefined || value.boardColumn !== undefined || value.remainingHours !== undefined,
  { message: 'Change the status, the column or the remaining hours.' },
);

// A task of their own under a story.
export const accessTaskCreateSchema = z.object({
  description: z.string().trim().max(5000).optional().default(''),
  name: z.string().trim().min(1).max(200),
  targetHourEstimate: z.number().int().min(0).max(100000).nullable().optional().default(null),
}).strict();

export const accessCommentSchema = z.object({
  text: z.string().trim().min(1).max(5000),
}).strict();

// Time on their task, and optionally the hours left on it after that work.
export const accessTimeCreateSchema = z.object({
  hours: z.number().finite().positive().max(24),
  note: z.string().trim().max(2000).optional().default(''),
  remainingHours: remainingHours.optional(),
  workDate: date,
}).strict();

export const accessTimeDeleteQuerySchema = z.object({
  expectedVersion: z.coerce.number().int().positive(),
});
