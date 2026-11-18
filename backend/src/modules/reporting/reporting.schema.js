import { z } from 'zod';

const id = z.string().trim().min(1).max(128);
const expectedVersion = z.number().int().positive();
const visibility = z.enum(['private', 'project', 'tenant']).default('private');
const boundedFilters = z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()])).default({});

export const globalSearchQuerySchema = z.object({
  facets: z.string().trim().max(2000).optional().default(''),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  projectId: id.optional(),
  query: z.string().trim().min(1).max(500),
  types: z.string().trim().max(1000).optional().default(''),
});

export const savedViewCreateSchema = z.object({
  columns: z.array(z.string().trim().min(1).max(128)).max(64).default([]),
  filters: boundedFilters,
  name: z.string().trim().min(1).max(240),
  projectId: id.nullable().optional().default(null),
  sort: z.array(z.object({ direction: z.enum(['asc', 'desc']), field: z.string().trim().min(1).max(128) })).max(8).default([]),
  surface: z.enum(['global_search', 'projects', 'portfolio', 'resources', 'workflows', 'governance', 'reports']),
  visibility,
});
export const savedViewUpdateSchema = savedViewCreateSchema.partial().extend({ expectedVersion });

export const reportDefinitionCreateSchema = z.object({
  columns: z.array(z.string().trim().min(1).max(128)).min(1).max(64),
  dataset: z.enum(['executive', 'portfolio', 'project', 'work_items', 'sprint', 'resource', 'financial', 'risk', 'agent_governance', 'workflow']),
  description: z.string().trim().max(4000).default(''),
  filters: boundedFilters,
  groupBy: z.array(z.string().trim().min(1).max(128)).max(8).default([]),
  name: z.string().trim().min(1).max(240),
  projectId: id.nullable().optional().default(null),
  status: z.enum(['active', 'inactive']).default('active'),
  visualization: z.enum(['table', 'summary', 'bar', 'line', 'pie']).default('table'),
  visibility,
});
export const reportDefinitionUpdateSchema = reportDefinitionCreateSchema.partial().extend({ expectedVersion });

export const reportSubscriptionCreateSchema = z.object({
  deliveryChannel: z.enum(['in_app', 'email']).default('in_app'),
  enabled: z.boolean().default(true),
  format: z.enum(['csv', 'xlsx', 'pdf', 'json']).default('csv'),
  nextRunAt: z.coerce.date(),
  recipients: z.array(z.string().trim().email().max(320)).max(50).default([]),
  reportId: id,
  schedule: z.object({
    intervalMinutes: z.number().int().min(15).max(525_600),
    timezone: z.string().trim().min(1).max(100).default('UTC'),
  }),
});
export const reportSubscriptionUpdateSchema = reportSubscriptionCreateSchema.partial().extend({ expectedVersion });

export const reportWorkspaceQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  projectId: id.optional(),
  query: z.string().trim().max(240).default(''),
  status: z.enum(['active', 'inactive']).optional(),
});

export const executeReportSchema = z.object({
  format: z.enum(['json', 'csv', 'xlsx', 'pdf']).default('json'),
  limit: z.number().int().min(1).max(10_000).default(1000),
  parameters: boundedFilters,
});

export const biFeedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(10_000).default(1000),
  offset: z.coerce.number().int().min(0).max(10_000_000).default(0),
  projectId: id.optional(),
});

export const reportingAnalyticsQuerySchema = z.object({
  days: z.coerce.number().int().min(7).max(365).default(90),
  projectId: id.optional(),
});

export const versionedReportingDeleteSchema = z.object({ expectedVersion });
