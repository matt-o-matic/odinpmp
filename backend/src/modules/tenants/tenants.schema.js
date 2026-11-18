import { z } from 'zod';

function requiredString(max) {
  return z.string().trim().min(1).max(max);
}

function optionalString(max) {
  return z.preprocess(
    (value) => (value == null ? '' : value),
    z.string().trim().max(max),
  );
}

export const updateTenantSchema = z.object({
  tenant_name: requiredString(255),
  domains: z.array(requiredString(255)).optional().default([]),
});

export const inviteUserSchema = z.object({
  email: z.string().trim().email().max(255),
  role: z.enum(['user', 'manager', 'admin']).default('user'),
});

export const revokeInviteSchema = z.object({
  invite_token: requiredString(255),
});

export const auditLogQuerySchema = z.object({
  start_date: optionalString(20).optional().default(''),
  end_date: optionalString(20).optional().default(''),
  search_text: optionalString(200).optional().default(''),
  output_type: z.enum(['json', 'xlsx']).optional().default('json'),
});

const aiCapabilityEntrySchema = z.object({
  enabledTools: z.array(optionalString(80)).optional().default([]),
  model: optionalString(120).optional().default(''),
  reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional().default('max'),
}).passthrough();

export const openAiConfigSchema = z.object({
  openai_key: optionalString(200).optional().default(''),
  available_models: z.array(optionalString(200)).optional().default([]),
  capabilities: z.object({
    briefEnhancement: aiCapabilityEntrySchema.optional(),
    clarificationDiscussion: aiCapabilityEntrySchema.optional(),
    clarificationSynthesis: aiCapabilityEntrySchema.optional(),
    intakeDialogue: aiCapabilityEntrySchema.optional(),
    projectAnalysis: aiCapabilityEntrySchema.optional(),
    requirementsDraftQuestions: aiCapabilityEntrySchema.optional(),
    requirementsPlan: aiCapabilityEntrySchema.optional(),
    requirementsSummary: aiCapabilityEntrySchema.optional(),
    storyGeneration: aiCapabilityEntrySchema.optional(),
    structureGeneration: aiCapabilityEntrySchema.optional(),
    taskGeneration: aiCapabilityEntrySchema.optional(),
  }).partial().optional().default({}),
  model_to_function: z.object({
    aiEnhance: optionalString(120).optional().default(''),
    aiGenerate: optionalString(120).optional().default(''),
    aiGenerateTasks: optionalString(120).optional().default(''),
    aiAnalyze: optionalString(120).optional().default(''),
  }).partial().optional().default({}),
  valid_config: z.boolean().optional(),
}).passthrough();

export const saveOpenAiConfigRequestSchema = z.object({
  openai_config: openAiConfigSchema,
});

export const fetchOpenAiModelsSchema = z.object({
  openai_key: optionalString(200).optional().default(''),
});

const userRoleSchema = z.enum(['user', 'manager', 'admin']);

export const updateUsersRequestSchema = z.object({
  change_role: z.array(z.object({ email: z.string().trim().email().max(255), role: userRoleSchema })).optional().default([]),
  updates: z.array(z.object({
    email: z.string().trim().email().max(255),
    name: optionalString(255).optional(),
    role: userRoleSchema.optional(),
    resource_cost: z.preprocess((value) => (value === '' || value == null ? null : Number(value)), z.number().finite().positive().nullable()).optional(),
    default_bill_rate: z.preprocess((value) => (value === '' || value == null ? null : Number(value)), z.number().finite().positive().nullable()).optional(),
    min_bill_rate: z.preprocess((value) => (value === '' || value == null ? null : Number(value)), z.number().finite().positive().nullable()).optional(),
  })).optional().default([]),
}).strict();

export const resetPasswordSchema = z.object({
  email: z.string().trim().email().max(255),
}).strict();

export const logoutUserSessionsSchema = z.object({
  userId: requiredString(64),
}).strict();

export const removeUserFromTenantSchema = z.object({
  userId: requiredString(64),
}).strict();

export const statusDefinitionSchema = z.object({
  id: optionalString(64).optional().default(''),
  is_default: z.boolean().optional(),
  name: requiredString(50),
  sort_order: z.preprocess((value) => (value == null || value === '' ? 0 : Number(value)), z.number().int().min(0).max(10_000)).optional().default(0),
}).passthrough();

export const updateStatusDefinitionsSchema = z.object({
  statuses: z.array(statusDefinitionSchema).optional().default([]),
}).strict();

export const taskTypeDefinitionSchema = z.object({
  id: optionalString(64).optional().default(''),
  is_default: z.boolean().optional(),
  name: requiredString(50),
  sort_order: z.preprocess((value) => (value == null || value === '' ? 0 : Number(value)), z.number().int().min(0).max(10_000)).optional().default(0),
}).passthrough();

export const updateTaskTypeDefinitionsSchema = z.object({
  task_types: z.array(taskTypeDefinitionSchema).optional().default([]),
}).strict();

export const restoreTenantSchema = z.object({
  base64Odin: z.string().trim().min(10).max(50_000_000),
}).strict();

// Ticket configuration lists: environments and release identifiers.
const ticketConfigEntrySchema = z.object({
  id: z.string().trim().min(1).max(36).optional(),
  name: z.string().trim().min(1).max(160),
  projectId: z.string().trim().min(1).max(36).nullable().optional().default(null),
  sortOrder: z.preprocess((value) => (value == null || value === '' ? 0 : Number(value)), z.number().int().min(0).max(10_000)).optional().default(0),
  status: z.enum(['active', 'inactive']).optional().default('active'),
}).strict();

export const updateTicketConfigListSchema = z.object({
  entries: z.array(ticketConfigEntrySchema).max(500).optional().default([]),
  // Optional so older callers keep last-writer-wins; the admin screen always sends it.
  expectedRevision: z.string().trim().min(1).max(64).optional(),
}).strict();

export const ticketConfigListKindSchema = z.enum(['environments', 'releases']);
