import { z } from 'zod';

const id = z.string().trim().min(1).max(128);
const expectedVersion = z.number().int().positive();
const itemType = z.enum(['project', 'epic', 'story', 'task', 'ticket']);
const role = z.enum(['admin', 'manager', 'contributor', 'editor', 'member', 'user', 'viewer']);
export const WORKFLOW_ITEM_TYPES = itemType.options;

export const workflowStateSchema = z.object({
  category: z.enum(['backlog', 'active', 'done', 'cancelled']).default('backlog'),
  initial: z.boolean().default(false),
  key: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(120),
  requiredFields: z.array(z.string().trim().min(1).max(128)).max(32).default([]),
  slaHours: z.number().int().min(0).max(87600).default(0),
  terminal: z.boolean().default(false),
});

export const workflowTransitionSchema = z.object({
  allowedRoles: z.array(role).max(16).default([]),
  approvalRequired: z.boolean().default(false),
  approverRoles: z.array(role).max(16).default([]),
  fromState: z.string().trim().min(1).max(80),
  key: z.string().trim().min(1).max(120),
  requiredFields: z.array(z.string().trim().min(1).max(128)).max(32).default([]),
  toState: z.string().trim().min(1).max(80),
});

const workflowDefinitionBase = z.object({
  description: z.string().trim().max(4000).default(''),
  itemTypes: z.array(itemType).min(1).max(5),
  name: z.string().trim().min(1).max(240),
  states: z.array(workflowStateSchema).min(1).max(64),
  status: z.enum(['active', 'inactive']).default('active'),
  transitions: z.array(workflowTransitionSchema).max(256).default([]),
});
function validWorkflow(value) {
  const keys = value.states.map((state) => state.key);
  return new Set(keys).size === keys.length
    && value.states.filter((state) => state.initial).length === 1
    && value.transitions.every((transition) => keys.includes(transition.fromState) && keys.includes(transition.toState));
}
const validWorkflowMessage = { message: 'Workflow states must be unique, have one initial state, and contain every transition endpoint.' };
export const workflowDefinitionCreateSchema = workflowDefinitionBase.refine(validWorkflow, validWorkflowMessage);
export const workflowDefinitionUpdateSchema = workflowDefinitionBase.partial().extend({ expectedVersion });

export const workflowBindingCreateSchema = z.object({ itemType, projectId: id, workflowId: id });
export const workflowBindingUpdateSchema = workflowBindingCreateSchema.partial().extend({ expectedVersion });

export const workflowApprovalRequestSchema = z.object({
  expiresAt: z.string().datetime({ offset: true }).nullable().optional().default(null),
  fromState: z.string().trim().min(1).max(80),
  itemId: id,
  itemType,
  note: z.string().trim().max(2000).default(''),
  projectId: id,
  toState: z.string().trim().min(1).max(80),
  transitionKey: z.string().trim().min(1).max(120),
});
// MCP clients name the approval's project, so a grant limited to some projects reaches only theirs.
export const workflowApprovalDecisionSchema = z.object({
  decisionNote: z.string().trim().max(2000).default(''),
  expectedVersion,
  projectId: id.optional(),
  status: z.enum(['approved', 'rejected']),
});

export const projectBaselineCreateSchema = z.object({
  name: z.string().trim().min(1).max(240),
  note: z.string().trim().max(4000).default(''),
  projectId: id,
});

const customFieldDefinitionBase = z.object({
  description: z.string().trim().max(2000).default(''),
  fieldType: z.enum(['string', 'number', 'date', 'boolean', 'enum']),
  name: z.string().trim().min(1).max(160),
  options: z.array(z.string().trim().min(1).max(240)).max(128).default([]),
  required: z.boolean().default(false),
  scope: itemType,
  status: z.enum(['active', 'inactive']).default('active'),
});
const enumOptionsRequired = [(value) => value.fieldType !== 'enum' || value.options.length > 0, { message: 'Enum custom fields require at least one option.', path: ['options'] }];
export const customFieldDefinitionCreateSchema = customFieldDefinitionBase.refine(...enumOptionsRequired);
export const customFieldDefinitionUpdateSchema = z.object({
  description: z.string().trim().max(2000).optional(), expectedVersion,
  name: z.string().trim().min(1).max(160).optional(), options: z.array(z.string().trim().min(1).max(240)).max(128).optional(),
  required: z.boolean().optional(), status: z.enum(['active', 'inactive']).optional(),
});

// Template payloads are typed per kind. Rows written before these schemas existed may hold
// free-form payloads; they stay readable and are flagged by describeTemplatePayload.
const outlinePoints = z.number().int().min(0).max(999).nullable().default(null);
const outlineTaskSchema = z.object({
  description: z.string().trim().max(5000).default(''),
  name: z.string().trim().min(1).max(200),
  points: outlinePoints,
});
const outlineStorySchema = outlineTaskSchema.extend({ tasks: z.array(outlineTaskSchema).max(50).default([]) });
const outlineEpicSchema = outlineTaskSchema.extend({ stories: z.array(outlineStorySchema).max(50).default([]) });
export const PROJECT_TEMPLATE_OUTLINE_LIMIT = 500;

export const workflowTemplatePayloadSchema = workflowDefinitionBase
  .pick({ description: true, itemTypes: true, states: true, transitions: true })
  .strict()
  .refine(validWorkflow, validWorkflowMessage);

export const projectTemplatePayloadSchema = z.object({
  customFields: z.array(customFieldDefinitionBase.omit({ status: true }).refine(...enumOptionsRequired)).max(64).default([]),
  outline: z.object({ epics: z.array(outlineEpicSchema).max(50).default([]) }).default({}),
  workflowBindings: z.array(z.object({
    itemType,
    sourceId: id,
    sourceKind: z.enum(['workflow_template', 'workflow_definition']),
  })).max(5).default([]),
}).strict().superRefine((value, context) => {
  if (!value.workflowBindings.length && !value.outline.epics.length && !value.customFields.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Add a workflow binding, a starter outline, or a custom field.' });
  }
  const itemTypes = value.workflowBindings.map((binding) => binding.itemType);
  if (new Set(itemTypes).size !== itemTypes.length) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Bind each item type at most once.', path: ['workflowBindings'] });
  const fieldKeys = value.customFields.map((field) => `${field.scope}:${field.name.toLowerCase()}`);
  if (new Set(fieldKeys).size !== fieldKeys.length) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Custom field names must be unique per item type.', path: ['customFields'] });
  const outlineCount = value.outline.epics.reduce((total, epic) => total + 1 + epic.stories.reduce((count, story) => count + 1 + story.tasks.length, 0), 0);
  if (outlineCount > PROJECT_TEMPLATE_OUTLINE_LIMIT) context.addIssue({ code: z.ZodIssueCode.custom, message: `A starter outline can hold up to ${PROJECT_TEMPLATE_OUTLINE_LIMIT} items.`, path: ['outline'] });
});

export const workItemTemplatePayloadSchema = z.object({
  acceptanceCriteria: z.string().trim().max(4000).default(''),
  category: z.enum(['defect', 'support', 'question', 'change_request']).nullable().default(null),
  customFieldDefaults: z.array(z.object({
    fieldId: id,
    value: z.union([z.string().trim().max(2000), z.number(), z.boolean()]),
  })).max(32).default([]),
  description: z.string().trim().max(5000).default(''),
  itemType: z.enum(['epic', 'story', 'task', 'ticket']),
  points: outlinePoints,
  priority: z.number().int().min(1).max(7).nullable().default(null),
  severity: z.enum(['S1', 'S2', 'S3', 'S4']).nullable().default(null),
}).strict().superRefine((value, context) => {
  if (value.itemType !== 'ticket' && (value.category || value.severity)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Category and severity apply to ticket templates only.', path: ['itemType'] });
  }
  const fieldIds = value.customFieldDefaults.map((entry) => entry.fieldId);
  if (new Set(fieldIds).size !== fieldIds.length) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Set each custom field default once.', path: ['customFieldDefaults'] });
});

export const TEMPLATE_PAYLOAD_SCHEMAS = { project: projectTemplatePayloadSchema, work_item: workItemTemplatePayloadSchema, workflow: workflowTemplatePayloadSchema };
const templateKind = z.enum(['project', 'workflow', 'work_item']);

/** Parses a payload for its kind, reporting issues under `payload`. */
export function parseTemplatePayload(kind, payload, context) {
  const result = TEMPLATE_PAYLOAD_SCHEMAS[kind].safeParse(payload);
  if (result.success) return result.data;
  for (const issue of result.error.issues) context.addIssue({ code: z.ZodIssueCode.custom, message: issue.message, path: ['payload', ...issue.path] });
  return z.NEVER;
}

const projectTemplateBase = z.object({
  description: z.string().trim().max(4000).default(''),
  kind: templateKind,
  name: z.string().trim().min(1).max(240),
  payload: z.unknown(),
  status: z.enum(['active', 'inactive']).default('active'),
});
export const projectTemplateCreateSchema = projectTemplateBase
  .transform((value, context) => ({ ...value, payload: parseTemplatePayload(value.kind, value.payload, context) }));
// A payload-only update is checked against the stored kind, so the service validates payloads.
export const projectTemplateUpdateSchema = projectTemplateBase.partial().extend({ expectedVersion });
export const templateListQuerySchema = z.object({
  kind: templateKind.optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

/** Validity of a stored template payload; legacy free-form rows report `needs_update`. */
export function describeTemplatePayload(template) {
  const schema = TEMPLATE_PAYLOAD_SCHEMAS[template?.kind];
  if (!schema) return { payloadIssues: ['Unknown template kind.'], payloadStatus: 'needs_update' };
  const result = schema.safeParse(template.payload ?? {});
  if (result.success) return { payloadIssues: [], payloadStatus: 'valid' };
  return {
    payloadIssues: result.error.issues.slice(0, 5).map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message)),
    payloadStatus: 'needs_update',
  };
}

export const customFieldValueWriteSchema = z.object({
  expectedVersion: z.number().int().positive().nullable().optional().default(null),
  fieldId: id,
  itemId: id,
  itemType,
  projectId: id,
  value: z.unknown(),
});

export const workflowWorkspaceQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  projectId: id.optional(),
  query: z.string().trim().max(240).default(''),
  status: z.enum(['active', 'inactive']).optional(),
});
export const versionedWorkflowDeleteSchema = z.object({ expectedVersion });
export const customValueDeleteSchema = versionedWorkflowDeleteSchema.extend({ projectId: id.optional() });
