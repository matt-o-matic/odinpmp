import { z } from 'zod';

import { CONNECTOR_KEYS } from './connector-catalog.js';

const id = z.string().uuid();
const expectedVersion = z.number().int().positive();

export const connectorWorkspaceQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export const connectorConnectionCreateSchema = z.object({
  authType: z.enum(['oauth2', 'pat', 'webhook']),
  conflictPolicy: z
    .enum(['manual', 'odin_wins', 'source_wins'])
    .default('manual'),
  name: z.string().trim().min(2).max(160),
  projectIds: z.array(z.string().trim().min(1).max(128)).max(500).default([]),
  provider: z.enum(CONNECTOR_KEYS),
  scopes: z.array(z.string().trim().min(1).max(160)).max(100).default([]),
  secretReference: z.string().trim().max(500).default(''),
  settings: z
    .record(
      z.string(),
      z.union([
        z.string().max(2000),
        z.number().finite(),
        z.boolean(),
        z.null(),
      ]),
    )
    .default({}),
  status: z.enum(['active', 'draft', 'paused']).default('draft'),
  syncDirection: z
    .enum(['bidirectional', 'inbound', 'outbound'])
    .default('bidirectional'),
});
export const connectorConnectionUpdateSchema = connectorConnectionCreateSchema
  .partial()
  .extend({ expectedVersion });
export const connectorProviderPolicyCreateSchema = z.object({
  allowedAuthTypes: z.array(z.enum(['oauth2', 'pat', 'webhook'])).min(1).max(3),
  allowedDirections: z.array(z.enum(['bidirectional', 'inbound', 'outbound'])).min(1).max(3),
  allowedScopes: z.array(z.string().trim().min(1).max(160)).max(100).default([]),
  approvalRequired: z.boolean().default(true), dataClassification: z.enum(['internal', 'confidential', 'restricted']).default('confidential'),
  enabled: z.boolean().default(true), maxProjects: z.number().int().min(1).max(500).default(50), outboundEnabled: z.boolean().default(false), provider: z.enum(CONNECTOR_KEYS),
});
export const connectorProviderPolicyUpdateSchema = connectorProviderPolicyCreateSchema.partial().extend({ expectedVersion });
export const connectorConnectionApproveSchema = z.object({ expectedVersion });
export const connectorMappingCreateSchema = z.object({
  connectionId: id,
  externalId: z.string().trim().min(1).max(255),
  objectType: z.string().trim().min(1).max(120),
  odinId: z.string().trim().min(1).max(255),
  projectId: z.string().trim().min(1).max(128),
});
export const connectorConflictResolveSchema = z.object({
  expectedVersion,
  note: z.string().trim().max(4000).default(''),
  resolution: z.enum(['manual_merge', 'odin_wins', 'source_wins']),
});
export const connectorSyncRunSchema = z.object({
  direction: z.enum(['inbound', 'outbound']),
  idempotencyKey: z.string().trim().min(8).max(200),
});
export const connectorEventApplySchema = z.object({ expectedVersion });
export const connectorErpPostingSchema = z.object({
  financialEntryId: id,
  idempotencyKey: z.string().trim().min(8).max(200),
});
export const connectorInboundEventSchema = z.object({
  eventId: z.string().trim().min(1).max(500),
  eventType: z.string().trim().min(1).max(160),
  payload: z.record(z.string(), z.unknown()),
});
export { id as connectorIdSchema };
