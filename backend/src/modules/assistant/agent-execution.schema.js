import { z } from 'zod';

export const agentRunStatuses = [
  'queued', 'running', 'paused', 'waiting_approval', 'retry_scheduled',
  'completed', 'failed', 'cancelled', 'dead_lettered',
];

export const agentStepStatuses = ['pending', 'running', 'completed', 'failed', 'skipped', 'cancelled'];
export const agentToolCallStatuses = ['pending', 'running', 'completed', 'failed', 'cancelled'];
export const agentApprovalStatuses = ['pending', 'approved', 'rejected', 'expired', 'cancelled'];
export const agentGoalStatuses = ['active', 'paused', 'completed', 'cancelled'];
export const agentGoalNotificationStatuses = ['unread', 'read', 'dismissed'];

const identifier = z.string().trim().min(1).max(128);
const optionalIdentifier = identifier.optional().nullable();

const verifierCriteriaSchema = z.object({
  eventIds: z.array(identifier).max(100).optional(),
  eventTypes: z.array(identifier).max(32).optional(),
  notificationIds: z.array(identifier).max(100).optional(),
  requireEmail: z.boolean().optional(),
  requireNotification: z.boolean().optional(),
  subscriptionIds: z.array(identifier).max(100).optional(),
}).passthrough().default({});

const verifierTypeSchema = z.enum(['communication.v1', 'integration.v1', 'project_health.v1', 'resource_finance.v1', 'workflow.v1']);

const verifierPredicateSchema = z.object({
  checkId: identifier,
  criteria: verifierCriteriaSchema,
  id: identifier,
  type: verifierTypeSchema,
});

const verifierExpressionSchema = z.lazy(() => z.union([
  verifierPredicateSchema,
  z.object({ all: z.array(verifierExpressionSchema).min(1).max(32) }),
  z.object({ any: z.array(verifierExpressionSchema).min(1).max(32) }),
  z.object({ not: verifierExpressionSchema }),
]));

const agentGoalSuccessSchema = z.object({
  measure: z.string().trim().max(4000).optional(),
  plan: z.object({
    root: verifierExpressionSchema,
    version: z.literal('verifier-plan.v1'),
  }).optional(),
  verifier: z.object({
    criteria: verifierCriteriaSchema,
    requiredCheckIds: z.array(z.string().trim().min(1).max(128)).max(32).default([]),
    type: verifierTypeSchema,
  }).optional(),
}).passthrough().default({});

export const createAgentGoalSchema = z.object({
  constraints: z.record(z.unknown()).default({}),
  projectId: optionalIdentifier,
  scope: z.record(z.unknown()).default({}),
  success: agentGoalSuccessSchema,
  title: z.string().trim().min(1).max(255),
});

export const updateAgentGoalSchema = createAgentGoalSchema.partial().extend({
  expectedVersion: z.number().int().positive(),
  status: z.enum(agentGoalStatuses).optional(),
});

export const createAgentMonitorSchema = z.object({
  condition: z.record(z.unknown()).default({}),
  eventType: z.string().trim().min(1).max(128).nullable().optional().default(null),
  intervalMinutes: z.number().int().min(5).max(525_600).nullable().optional().default(null),
  nextRunAt: z.coerce.date().nullable().optional().default(null),
  payload: z.record(z.unknown()).default({}),
  stop: z.object({
    endAt: z.coerce.date().nullable().optional().default(null),
    maxRuns: z.number().int().positive().max(100_000).nullable().optional().default(null),
  }).default({}),
  title: z.string().trim().min(1).max(255),
  triggerType: z.enum(['schedule', 'event']),
}).superRefine((value, context) => {
  if (value.triggerType === 'schedule' && !value.intervalMinutes) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Scheduled monitors require intervalMinutes.', path: ['intervalMinutes'] });
  if (value.triggerType === 'event' && !value.eventType) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Event monitors require eventType.', path: ['eventType'] });
});

export const updateAgentMonitorSchema = z.object({
  condition: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
  eventType: z.string().trim().min(1).max(128).nullable().optional(),
  expectedVersion: z.number().int().positive(),
  intervalMinutes: z.number().int().min(5).max(525_600).nullable().optional(),
  nextRunAt: z.coerce.date().nullable().optional(),
  payload: z.record(z.unknown()).optional(),
  stop: z.object({
    endAt: z.coerce.date().nullable().optional().default(null),
    maxRuns: z.number().int().positive().max(100_000).nullable().optional().default(null),
  }).optional(),
  title: z.string().trim().min(1).max(255).optional(),
});

export const updateAgentGoalNotificationSchema = z.object({
  expectedVersion: z.number().int().positive(),
  status: z.enum(agentGoalNotificationStatuses),
});

export const agentRunBudgetSchema = z.object({
  costUsd: z.number().nonnegative().default(5),
  externalMessages: z.number().int().nonnegative().default(10),
  inputTokens: z.number().int().nonnegative().default(200_000),
  mutations: z.number().int().nonnegative().default(50),
  outputTokens: z.number().int().nonnegative().default(50_000),
  toolCalls: z.number().int().nonnegative().default(100),
  wallClockMs: z.number().int().positive().default(5 * 60 * 1000),
}).default({});

export const agentRunUsageSchema = z.object({
  costUsd: z.number().nonnegative().default(0),
  externalMessages: z.number().int().nonnegative().default(0),
  inputTokens: z.number().int().nonnegative().default(0),
  mutations: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  toolCalls: z.number().int().nonnegative().default(0),
  wallClockMs: z.number().int().nonnegative().default(0),
}).default({});

export const recordAgentRunTraceSchema = z.object({
  costUsd: z.number().nonnegative().default(0),
  eval: z.unknown().optional().nullable(),
  idempotencyKey: identifier,
  inputTokens: z.number().int().nonnegative().default(0),
  latencyMs: z.number().int().nonnegative().default(0),
  metadata: z.unknown().default({}),
  model: z.string().trim().max(128).optional().nullable(),
  outputTokens: z.number().int().nonnegative().default(0),
  policy: z.unknown().optional().nullable(),
  promptId: z.string().trim().max(128).optional().nullable(),
  requestId: z.string().trim().max(256).optional().nullable(),
  runId: identifier,
  stepId: optionalIdentifier,
  toolCallId: optionalIdentifier,
  traceType: z.enum(['model', 'tool', 'policy', 'eval']).default('model'),
});

export const enqueueAgentRunSchema = z.object({
  budgets: agentRunBudgetSchema,
  goalId: optionalIdentifier,
  idempotencyKey: identifier,
  maxAttempts: z.number().int().min(1).max(20).default(5),
  payload: z.unknown().default({}),
  projectId: optionalIdentifier,
  runType: identifier.default('assistant_turn'),
  sessionId: optionalIdentifier,
  tenantId: identifier,
  userId: optionalIdentifier,
});

export const claimAgentRunSchema = z.object({
  leaseMs: z.number().int().min(100).max(60 * 60 * 1000).default(30_000),
  now: z.coerce.date().optional(),
  runTypes: z.array(identifier).optional(),
  workerId: identifier,
});

export const ownedAgentRunSchema = z.object({
  leaseToken: identifier,
  now: z.coerce.date().optional(),
  runId: identifier,
  workerId: identifier,
});

export const failAgentRunSchema = ownedAgentRunSchema.extend({
  error: z.unknown(),
  retryBaseMs: z.number().int().min(1).max(60 * 60 * 1000).default(1000),
  retryable: z.boolean().default(true),
});

export const createAgentStepSchema = z.object({
  idempotencyKey: identifier,
  input: z.unknown().default({}),
  name: identifier,
  runId: identifier,
  sequence: z.number().int().nonnegative(),
  stepType: identifier.default('task'),
});

export const createToolCallSchema = z.object({
  arguments: z.unknown().default({}),
  idempotencyKey: identifier,
  runId: identifier,
  stepId: optionalIdentifier,
  toolName: identifier,
});

export const createApprovalSchema = z.object({
  expiresAt: z.coerce.date().optional().nullable(),
  policy: z.unknown().default({}),
  requestedBy: optionalIdentifier,
  runId: identifier,
  stepId: optionalIdentifier,
  summary: z.string().trim().min(1).max(4000),
  toolCallId: optionalIdentifier,
});
