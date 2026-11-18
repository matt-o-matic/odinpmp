import { z } from 'zod';

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

function nullableDateField() {
  return z.preprocess((value) => {
    if (value === '' || value == null) {
      return null;
    }

    // A full timestamp (an older client or cached tree) still names a day; keep the date part.
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
      return value.slice(0, 10);
    }

    return value;
  }, z.string().regex(isoDatePattern, 'Date must use YYYY-MM-DD format.').nullable());
}

function nullableIntegerField({ max = 9999, min = 0 } = {}) {
  return z.preprocess((value) => {
    if (value === '' || value == null) {
      return null;
    }

    return value;
  }, z.number().int().min(min).max(max).nullable());
}

function nullableDecimalField({ max = 999999, min = 0 } = {}) {
  return z.preprocess((value) => {
    if (value === '' || value == null) {
      return null;
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }

      const numeric = Number(trimmed);
      return Number.isFinite(numeric) ? numeric : value;
    }

    return value;
  }, z.number().min(min).max(max).nullable());
}

function nullableStringField({ max = 500 } = {}) {
  return z.preprocess((value) => {
    if (value == null) {
      return '';
    }

    return value;
  }, z.string().trim().max(max));
}

function nullableReferenceField({ max = 128 } = {}) {
  return z.preprocess((value) => {
    if (value === '' || value == null) {
      return null;
    }

    return value;
  }, z.string().trim().min(1).max(max).nullable());
}

function stringListField({ itemMax = 5000, maxItems = 40 } = {}) {
  return z.preprocess((value) => {
    if (value == null || value === '') {
      return [];
    }

    return value;
  }, z.array(z.string().trim().min(1).max(itemMax)).max(maxItems));
}

const projectTaskSchema = z.object({
  // Hours actually spent on the item, kept apart from the target estimate.
  actualHours: nullableDecimalField({ max: 100000 }).optional().default(null),
  // Set when someone overrides the points and hours an item with children would roll up.
  estimateOverride: z.boolean().optional(),
  assigneeId: z.preprocess((value) => {
    if (value === '' || value == null) {
      return null;
    }

    return value;
  }, z.string().trim().min(1).max(120).nullable()).optional(),
  assigneeName: nullableStringField({ max: 120 }).optional().default(''),
  // Kanban column key the item was placed in; null lets the board place it by status.
  boardColumn: z.preprocess((value) => {
    if (value === '' || value == null) {
      return null;
    }

    return value;
  }, z.string().trim().min(1).max(80).nullable()).optional(),
  description: nullableStringField({ max: 5000 }).optional().default(''),
  id: z.string().trim().min(1).max(120).optional(),
  name: z.string().trim().min(1).max(200),
  // Manual percent complete for in-flight work; null falls back to the status default.
  percentComplete: nullableIntegerField({ max: 100 }).optional().default(null),
  points: nullableIntegerField({ max: 999 }).optional().default(null),
  priority: z.preprocess((value) => value ?? 4, z.number().int().min(1).max(7)).optional().default(4),
  progress: z.number().min(0).max(100).optional(),
  // Hours of work left; blank clears it. Left out, a save keeps the stored value.
  remainingHours: nullableDecimalField({ max: 100000 }).optional(),
  sprintId: z.preprocess((value) => {
    if (value === '' || value == null) {
      return null;
    }

    return value;
  }, z.string().trim().min(1).max(120).nullable()).optional().default(null),
  sprintSortOrder: nullableIntegerField({ max: 999999 }).optional().default(null),
  status: z.string().trim().min(1).max(80).optional().default('Not Started'),
  targetEndDate: nullableDateField().optional().default(null),
  targetHourEstimate: nullableIntegerField({ max: 100000 }).optional().default(null),
  targetStartDate: nullableDateField().optional().default(null),
});

export const TICKET_CATEGORIES = ['defect', 'support', 'question', 'change_request'];
export const TICKET_SEVERITIES = ['S1', 'S2', 'S3', 'S4'];
export const TICKET_EXTERNAL_REVIEW_STATES = ['not_external', 'pending', 'validated', 'rejected'];
export const WORK_ITEM_RELATION_TYPES = ['caused_by', 'affects', 'duplicate_of', 'blocks'];

const ticketFieldsSchema = z.object({
  actualResult: nullableStringField({ max: 8000 }).optional().default(''),
  buildVersion: nullableStringField({ max: 120 }).optional().default(''),
  category: z.enum(TICKET_CATEGORIES).optional().default('defect'),
  environmentId: nullableReferenceField().optional().default(null),
  expectedResult: nullableStringField({ max: 8000 }).optional().default(''),
  externalReviewState: z.enum(TICKET_EXTERNAL_REVIEW_STATES).optional().default('not_external'),
  fixedInReleaseId: nullableReferenceField().optional().default(null),
  foundInReleaseId: nullableReferenceField().optional().default(null),
  reporterExternalId: nullableReferenceField().optional().default(null),
  reproSteps: nullableStringField({ max: 8000 }).optional().default(''),
  severity: z.enum(TICKET_SEVERITIES).optional().default('S3'),
});

const storySchema = projectTaskSchema.extend({
  sourceClarificationIds: z.array(z.string().trim().min(1).max(120)).optional().default([]),
  tasks: z.array(projectTaskSchema).optional().default([]),
});

const epicSchema = projectTaskSchema.extend({
  stories: z.array(storySchema).optional().default([]),
});

export const projectWriteSchema = z.object({
  description: nullableStringField({ max: 8000 }).optional().default(''),
  endDate: nullableDateField().optional().default(null),
  name: z.string().trim().min(1).max(160),
  startDate: nullableDateField().optional().default(null),
  status: z.string().trim().min(1).max(80),
});

// Creating from a project template seeds workflows, custom fields and a starter outline.
export const projectCreateSchema = projectWriteSchema.extend({
  templateId: z.string().trim().min(1).max(128).nullable().optional().default(null),
});

export const projectUpdateSchema = projectWriteSchema.extend({
  expectedUpdatedAt: z.string().datetime({ offset: true }),
});

export const projectAssistantBriefWriteSchema = z.object({
  assumptions: stringListField({ maxItems: 20 }).optional().default([]),
  benefits: nullableStringField({ max: 5000 }).optional().default(''),
  constraints: stringListField({ maxItems: 20 }).optional().default([]),
  currentState: nullableStringField({ max: 5000 }).optional().default(''),
  dependencies: stringListField({ maxItems: 20 }).optional().default([]),
  implementationEffort: nullableStringField({ max: 5000 }).optional().default(''),
  name: nullableStringField({ max: 160 }).optional().default(''),
  objective: nullableStringField({ max: 5000 }).optional().default(''),
  proposedSolution: nullableStringField({ max: 5000 }).optional().default(''),
  requirements: stringListField({ maxItems: 40 }).optional().default([]),
  stakeholders: stringListField({ maxItems: 20 }).optional().default([]),
  successMetrics: stringListField({ maxItems: 20 }).optional().default([]),
});

// Strip replacement defaults before making a patch: omitted fields must stay untouched.
export const projectAssistantBriefPatchSchema = z.object({
  expectedUpdatedAt: z.string().datetime({ offset: true }).nullable(),
  patch: z.object(Object.fromEntries(Object.entries(projectAssistantBriefWriteSchema.shape)
    .map(([key, field]) => [key, field.removeDefault().optional()]))).strict()
    .refine((patch) => Object.keys(patch).length > 0, 'At least one brief field is required.'),
}).strict();

export const projectTreeSchema = z.object({
  epics: z.array(epicSchema).optional().default([]),
  expectedUpdatedAt: z.string().datetime({ offset: true }),
});

const projectItemTypeSchema = z.enum(['epic', 'story', 'task', 'ticket']);
const projectItemFieldsSchema = projectTaskSchema.extend({
  sourceClarificationIds: z.array(z.string().trim().min(1).max(120)).optional().default([]),
}).merge(ticketFieldsSchema.partial());
export const projectItemPatchSchema = projectItemFieldsSchema.omit({ id: true }).partial();

export const projectItemCreateSchema = z.object({
  item: projectItemFieldsSchema,
  itemType: projectItemTypeSchema,
  parentId: z.string().trim().min(1).max(120).nullable().optional().default(null),
  position: z.number().int().min(0).max(100000).optional(),
  // A work-item template whose custom-field defaults are recorded on the new item.
  templateId: z.string().trim().min(1).max(128).nullable().optional().default(null),
});

export const projectItemUpdateSchema = z.object({
  expectedVersion: z.number().int().positive(),
  parentId: z.string().trim().min(1).max(120).nullable().optional(),
  patch: projectItemPatchSchema,
  position: z.number().int().min(0).max(100000).optional(),
}).superRefine((value, context) => {
  if (Object.keys(value.patch ?? {}).length === 0 && value.parentId === undefined && value.position === undefined) {
    context.addIssue({ code: 'custom', message: 'At least one item field, parent, or position change is required.' });
  }
});

export const projectItemDeleteSchema = z.object({
  expectedVersion: z.number().int().positive(),
  // Refuse (409) while anything links to the item or is on it, rather than take or strand it.
  withoutDependents: z.boolean().optional(),
});

// External review gate. Gates assistant visibility only, never scheduling. Agents'
// tools send agentCheck, so their validations go through the automated check.
export const ticketReviewDecisionSchema = z.object({
  agentCheck: z.boolean().optional(),
  expectedVersion: z.number().int().positive(),
  state: z.enum(['validated', 'rejected']),
});

export const ticketReviewQueueQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  projectId: z.string().trim().min(1).max(120).optional(),
});

// Each ticket listed may cost a Decisions API call, so pages stay small.
export const ticketsAwaitingReviewQuerySchema = z.object({
  itemId: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(25).optional().default(10),
});

// Cross-project ticket query. Project is a filter, not a container.
export const ticketListQuerySchema = z.object({
  assigneeIds: z.preprocess(splitCsvOrArray, z.array(z.string().trim().min(1).max(120))).optional().default([]),
  categories: z.preprocess(splitCsvOrArray, z.array(z.enum(TICKET_CATEGORIES))).optional().default([]),
  cursor: z.string().trim().max(200).optional().default(''),
  environmentIds: z.preprocess(splitCsvOrArray, z.array(z.string().trim().min(1).max(36))).optional().default([]),
  externalReviewStates: z.preprocess(splitCsvOrArray, z.array(z.enum(TICKET_EXTERNAL_REVIEW_STATES))).optional().default([]),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  projectIds: z.preprocess(splitCsvOrArray, z.array(z.string().trim().min(1).max(120))).optional().default([]),
  releaseIds: z.preprocess(splitCsvOrArray, z.array(z.string().trim().min(1).max(36))).optional().default([]),
  // Only tickets a reporter has reopened at least once.
  reopened: z.preprocess((value) => value === true || value === 'true', z.boolean()).optional().default(false),
  search: z.preprocess((value) => (value == null ? '' : value), z.string().trim().max(200)).optional().default(''),
  severities: z.preprocess(splitCsvOrArray, z.array(z.enum(TICKET_SEVERITIES))).optional().default([]),
  statusValues: z.preprocess(splitCsvOrArray, z.array(z.string().trim().min(1).max(80))).optional().default([]),
});

export const workItemRelationCreateSchema = z.object({
  relationType: z.enum(WORK_ITEM_RELATION_TYPES),
  toItemId: z.string().trim().min(1).max(120),
});

// External intake. The invite token carries the project, so a reporter
// never selects or needs to know one.
export const ticketIntakeInvitationCreateSchema = z.object({
  expiresAt: z.string().datetime({ offset: true }).nullable().optional().default(null),
  reporterEmail: z.string().trim().email().max(255),
  reporterName: nullableStringField({ max: 160 }).optional().default(''),
}).strict();

export const inboundTicketMailSchema = z.object({
  fromEmail: z.string().trim().email().max(255),
  htmlBody: nullableStringField({ max: 200_000 }).optional().default(''),
  inReplyTo: nullableStringField({ max: 255 }).optional().default(''),
  messageId: z.string().trim().min(1).max(255),
  provider: z.string().trim().min(1).max(80),
  subject: nullableStringField({ max: 255 }).optional().default(''),
  textBody: nullableStringField({ max: 200_000 }).optional().default(''),
  toEmail: z.string().trim().email().max(255),
});

// Attachment limits on the public surface. Deliberately narrow: evidence for a
// defect report is screenshots, logs, and documents, not arbitrary binaries.
export const PUBLIC_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const PUBLIC_ATTACHMENT_MAX_COUNT = 5;
// Five full-size files would make a ~67 MB JSON body on an unauthenticated route, so the
// files of one submission share a smaller combined budget.
export const PUBLIC_ATTACHMENT_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
// JSON body limit for the public intake route (app.js): the base64 attachment budget plus
// room for the text fields.
export const PUBLIC_TICKET_SUBMISSION_BODY_LIMIT_BYTES = Math.ceil(PUBLIC_ATTACHMENT_MAX_TOTAL_BYTES * 4 / 3) + 1024 * 1024;
export const PUBLIC_ATTACHMENT_ALLOWED_TYPES = [
  'application/pdf',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/csv',
  'text/plain',
];

const publicTicketAttachmentSchema = z.object({
  contentBase64: z.string().min(1).max(Math.ceil(PUBLIC_ATTACHMENT_MAX_BYTES * 4 / 3) + 1024),
  contentType: z.enum(PUBLIC_ATTACHMENT_ALLOWED_TYPES),
  fileName: z.string().trim().min(1).max(255),
}).strict();

export const publicTicketSubmissionSchema = z.object({
  attachments: z.array(publicTicketAttachmentSchema).max(PUBLIC_ATTACHMENT_MAX_COUNT).optional().default([]),
  actualResult: nullableStringField({ max: 8000 }).optional().default(''),
  buildVersion: nullableStringField({ max: 120 }).optional().default(''),
  category: z.enum(TICKET_CATEGORIES).optional().default('defect'),
  description: nullableStringField({ max: 8000 }).optional().default(''),
  environmentId: nullableReferenceField({ max: 36 }).optional().default(null),
  expectedResult: nullableStringField({ max: 8000 }).optional().default(''),
  foundInReleaseId: nullableReferenceField({ max: 36 }).optional().default(null),
  name: z.string().trim().min(1).max(200),
  reproSteps: nullableStringField({ max: 8000 }).optional().default(''),
  severity: z.enum(TICKET_SEVERITIES).optional().default('S3'),
}).strict();

export const projectItemRestoreSchema = z.object({
  expectedVersion: z.number().int().positive(),
  revisionId: z.string().trim().min(1).max(120),
  state: z.enum(['before', 'after']).optional().default('after'),
});

export const projectItemRevisionQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
});

export const projectValidUsersSchema = z.object({
  projectId: z.string().trim().min(1).max(120),
});

export const projectPermissionUserSchema = z.object({
  id: z.string().trim().min(1).max(120),
  // Legacy requires > 0 when provided.
  project_allocation: nullableDecimalField({ max: 1000, min: 0.001 }).optional().default(null),
  // Legacy stores this as DECIMAL(8,2).
  project_bill_rate: nullableDecimalField({ max: 999999, min: 0.01 }).optional().default(null),
  role: z.enum(['admin', 'manager', 'user']).optional().default('user'),
});

export const projectPermissionsWriteSchema = z.object({
  validUsers: z.array(projectPermissionUserSchema).optional().default([]),
});

export const projectArchiveInspectSchema = z.object({
  base64OdinProject: z.string().trim().min(1),
});

export const projectArchiveUserMappingSchema = z.object({
  sourceUserId: z.string().trim().min(1).max(120),
  targetUserId: z.preprocess((value) => {
    if (value === '' || value == null) {
      return null;
    }

    return value;
  }, z.string().trim().min(1).max(120).nullable()).optional().default(null),
});

export const projectArchiveImportSchema = projectArchiveInspectSchema.extend({
  overwriteMode: z.enum(['none', 'project', 'all']).optional().default('none'),
  userMappings: z.array(projectArchiveUserMappingSchema).optional().default([]),
});

export const sprintWriteSchema = z.object({
  endDate: nullableDateField().optional().default(null),
  goal: nullableStringField({ max: 5000 }).optional().default(''),
  name: z.string().trim().min(1).max(160),
  startDate: nullableDateField().optional().default(null),
  status: z.enum(['planned', 'active', 'completed', 'archived']).optional().default('planned'),
});

export const sprintStaffingEntrySchema = z.object({
  allocationPctOverride: nullableDecimalField({ max: 1000, min: 0 }).optional().default(null),
  capacityHours: nullableDecimalField({ max: 100000, min: 0 }).optional().default(null),
  notes: nullableStringField({ max: 1000 }).optional().default(''),
  userId: z.string().trim().min(1).max(120),
});

export const sprintStaffingWriteSchema = z.object({
  staffing: z.array(sprintStaffingEntrySchema).optional().default([]),
});

export const sprintAssignmentSchema = z.object({
  itemId: z.string().trim().min(1).max(120),
  itemType: z.enum(['story', 'task']),
  sprintId: z.preprocess((value) => {
    if (value === '' || value == null) {
      return null;
    }

    return value;
  }, z.string().trim().min(1).max(120).nullable()).optional().default(null),
});

export const sprintAssignmentsWriteSchema = z.object({
  assignments: z.array(sprintAssignmentSchema).min(1),
});

export const storySplitSchema = z.object({
  assigneeId: z.preprocess((value) => {
    if (value === '' || value == null) {
      return null;
    }

    return value;
  }, z.string().trim().min(1).max(120).nullable()).optional().default(null),
  description: nullableStringField({ max: 5000 }).optional().default(''),
  name: z.string().trim().min(1).max(200),
  points: nullableIntegerField({ max: 999 }).optional().default(null),
  priority: z.preprocess((value) => value ?? 4, z.number().int().min(1).max(7)).optional().default(4),
  sprintId: z.preprocess((value) => {
    if (value === '' || value == null) {
      return null;
    }

    return value;
  }, z.string().trim().min(1).max(120).nullable()).optional().default(null),
  status: z.string().trim().min(1).max(80).optional().default('Not Started'),
  sourceClarificationIds: z.array(z.string().trim().min(1).max(120)).optional().default([]),
  targetEndDate: nullableDateField().optional().default(null),
  targetHourEstimate: nullableIntegerField({ max: 100000 }).optional().default(null),
  targetStartDate: nullableDateField().optional().default(null),
  taskIds: z.array(z.string().trim().min(1).max(120)).min(1),
});

const kanbanColumnSchema = z.object({
  defaultStatus: z.string().trim().min(1).max(80),
  key: z.string().trim().min(1).max(80).optional(),
  name: z.string().trim().min(1).max(80),
  statuses: z.array(z.string().trim().min(1).max(80)).min(1),
});

const kanbanFiltersSchema = z.object({
  assigneeIds: z.array(z.string().trim().min(1).max(120)).optional().default([]),
  hideDone: z.boolean().optional().default(false),
  includeBacklog: z.boolean().optional().default(true),
  issueTypes: z.array(z.enum(['story', 'task', 'ticket'])).optional().default([]),
  search: nullableStringField({ max: 200 }).optional().default(''),
  selectedSprintIds: z.array(z.string().trim().min(1).max(120)).optional().default([]),
  statusValues: z.array(z.string().trim().min(1).max(80)).optional().default([]),
});

const kanbanPresetSchema = z.object({
  filters: kanbanFiltersSchema,
  id: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(120),
});

export const kanbanConfigWriteSchema = kanbanFiltersSchema.extend({
  columns: z.array(kanbanColumnSchema).optional().default([]),
  presets: z.array(kanbanPresetSchema).optional().default([]),
  swimlane: z.enum(['none', 'assignee', 'epic', 'sprint', 'issueType']).optional().default('none'),
});

function splitCsvOrArray(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => String(item ?? '').split(',')).map((item) => item.trim()).filter(Boolean);
  }

  if (value == null || value === '') {
    return [];
  }

  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

const kanbanItemIdField = z.preprocess((value) => (value === '' ? null : value), z.string().trim().min(1).max(120).nullable());

// Places a card in the project-wide board order, directly after or before a neighbor.
export const kanbanReorderSchema = z.object({
  afterItemId: kanbanItemIdField.optional().default(null),
  beforeItemId: kanbanItemIdField.optional().default(null),
  itemId: z.string().trim().min(1).max(120),
});

// Which board: the project's delivery board or its pursuit board (src/lib/projects/pursuit.js).
// Left out, an engagement means its pursuit board and a delivery project its own.
const kanbanScopeField = z.enum(['delivery', 'pursuit']).optional();
export const kanbanScopeQuerySchema = z.object({ scope: kanbanScopeField });

export const kanbanBoardQuerySchema = z.object({
  scope: kanbanScopeField,
  assigneeIds: z.preprocess(splitCsvOrArray, z.array(z.string().trim().min(1).max(120))).optional().default([]),
  hideDone: z.preprocess((value) => value === true || value === 'true' || value === '1', z.boolean()).optional().default(false),
  includeBacklog: z.preprocess((value) => value == null ? true : value === true || value === 'true' || value === '1', z.boolean()).optional().default(true),
  issueTypes: z.preprocess(splitCsvOrArray, z.array(z.enum(['story', 'task', 'ticket']))).optional().default([]),
  search: z.preprocess((value) => value == null ? '' : value, z.string().trim().max(200)).optional().default(''),
  selectedSprintIds: z.preprocess(splitCsvOrArray, z.array(z.string().trim().min(1).max(120))).optional().default([]),
  statusValues: z.preprocess(splitCsvOrArray, z.array(z.string().trim().min(1).max(80))).optional().default([]),
});
