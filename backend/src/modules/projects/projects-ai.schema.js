import { z } from 'zod';

function optionalDateField() {
  return z.preprocess((value) => {
    if (value === '' || value == null) {
      return null;
    }

    return value;
  }, z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable());
}

const taskSnapshotSchema = z.object({
  assigneeId: z.string().trim().max(120).nullable().optional().default(null),
  assigneeName: z.string().trim().max(120).optional().default(''),
  description: z.string().trim().max(5000).optional().default(''),
  id: z.string().trim().max(120).optional(),
  name: z.string().trim().min(1).max(200),
  points: z.preprocess((value) => value === '' || value == null ? null : value, z.number().int().nullable()).optional().default(null),
  priority: z.preprocess((value) => value == null ? 4 : value, z.number().int().min(1).max(7)).optional().default(4),
  status: z.string().trim().min(1).max(80).optional().default('Not Started'),
  targetEndDate: optionalDateField().optional().default(null),
  targetHourEstimate: z.preprocess((value) => value === '' || value == null ? null : value, z.number().int().nullable()).optional().default(null),
  targetStartDate: optionalDateField().optional().default(null),
});

const storySnapshotSchema = taskSnapshotSchema.extend({
  sourceClarificationIds: z.array(z.string().trim().max(120)).optional().default([]),
  tasks: z.array(taskSnapshotSchema).optional().default([]),
});

const epicSnapshotSchema = taskSnapshotSchema.extend({
  stories: z.array(storySnapshotSchema).optional().default([]),
});

export const projectSnapshotSchema = z.object({
  description: z.string().trim().max(8000).optional().default(''),
  endDate: optionalDateField().optional().default(null),
  epics: z.array(epicSnapshotSchema).optional().default([]),
  id: z.string().trim().max(120).optional(),
  name: z.string().trim().min(1).max(160),
  startDate: optionalDateField().optional().default(null),
  status: z.string().trim().min(1).max(80).optional().default('Planned'),
});

export const enhanceDescriptionSchema = z.object({
  description: z.string().trim().max(8000).optional().default(''),
  project: projectSnapshotSchema.optional(),
});

export const analyzeProjectSchema = z.object({
  project: projectSnapshotSchema.optional(),
});

export const generateStructureSchema = z.object({
  project: projectSnapshotSchema.optional(),
});

export const generateStoriesSchema = z.object({
  epicId: z.string().trim().min(1).max(120),
  project: projectSnapshotSchema.optional(),
});

export const generateTasksSchema = z.object({
  project: projectSnapshotSchema.optional(),
  storyId: z.string().trim().min(1).max(120),
});

export const enhanceRichTextSchema = z.object({
  element: z.string().trim().min(1).max(120).optional().default(''),
  fullHtml: z.string().optional().default(''),
  fullText: z.string().optional().default(''),
  mode: z.enum(['expand', 'rewrite', 'summarize']).optional().default('rewrite'),
  selectedText: z.string().optional().default(''),
  targetType: z.enum(['comment', 'epic', 'project', 'story', 'task']).optional().default('project'),
  title: z.string().optional().default(''),
});
