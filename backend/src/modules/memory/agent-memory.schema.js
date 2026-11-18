import { z } from 'zod';

const memoryTypes = ['decision', 'risk', 'change', 'meeting', 'preference', 'outcome', 'episode', 'fact'];
const sensitivities = ['public', 'internal', 'confidential', 'restricted'];

export const createAgentMemorySchema = z.object({
  confidence: z.number().min(0).max(1).default(1),
  content: z.string().trim().min(1).max(20_000),
  freshnessAt: z.coerce.date().nullable().optional().default(null),
  memoryType: z.enum(memoryTypes),
  projectId: z.string().trim().min(1).max(36).nullable().optional().default(null),
  provenance: z.object({
    sourceId: z.string().trim().max(255).optional().default(''),
    contentHash: z.string().trim().max(128).optional().default(''),
    sourceType: z.string().trim().min(1).max(128),
    sourceUrl: z.string().trim().url().max(2000).optional().or(z.literal('')).default(''),
  }).passthrough(),
  sensitivity: z.enum(sensitivities).default('internal'),
  sourceAt: z.coerce.date(),
  title: z.string().trim().min(1).max(255),
});

export const searchAgentMemorySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  projectIds: z.array(z.string().trim().min(1).max(36)).max(100).default([]),
  query: z.string().trim().min(1).max(1000),
  types: z.array(z.enum(memoryTypes)).max(memoryTypes.length).default([]),
});

export const browseAgentMemorySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
  // A project id, 'personal' for memory not tied to a project, or empty for everything visible.
  project: z.string().trim().max(36).default(''),
  query: z.string().trim().max(200).default(''),
  sensitivities: z.array(z.enum(sensitivities)).max(sensitivities.length).default([]),
  sort: z.enum(['newest', 'oldest', 'confidence']).default('newest'),
  types: z.array(z.enum(memoryTypes)).max(memoryTypes.length).default([]),
});

export const correctAgentMemorySchema = z.object({
  confidence: z.number().min(0).max(1).optional(),
  content: z.string().trim().min(1).max(20_000).optional(),
  expectedVersion: z.number().int().positive(),
  memoryType: z.enum(memoryTypes).optional(),
  sensitivity: z.enum(sensitivities).optional(),
  title: z.string().trim().min(1).max(255).optional(),
}).refine((value) => ['confidence', 'content', 'memoryType', 'sensitivity', 'title'].some((key) => value[key] !== undefined), { message: 'Change at least one field.' });

export const forgetAgentMemorySchema = z.object({ expectedVersion: z.number().int().positive() });
export const updateAgentMemoryGovernanceSchema = z.object({
  expectedVersion: z.number().int().positive(),
  expiresAt: z.coerce.date().nullable().optional(),
  legalHold: z.boolean().optional(),
  retentionPolicyId: z.string().trim().max(128).nullable().optional(),
});
export const purgeExpiredAgentMemorySchema = z.object({ cutoffAt: z.coerce.date().optional().default(() => new Date()) });

export { memoryTypes, sensitivities };
