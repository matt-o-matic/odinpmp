import { z } from 'zod';

const id = z.string().trim().min(1).max(36);
const optionalId = id.nullable().optional().default(null);
const nodeStatuses = ['proposed', 'active', 'on_hold', 'completed', 'cancelled'];
const objectiveStatuses = ['draft', 'active', 'achieved', 'at_risk', 'cancelled'];

export const createPortfolioNodeSchema = z.object({
  description: z.string().trim().max(10_000).default(''),
  governanceStage: z.string().trim().max(80).default('intake'),
  kind: z.enum(['portfolio', 'program']),
  name: z.string().trim().min(1).max(255),
  ownerId: optionalId,
  parentId: optionalId,
  scoring: z.object({
    costWeight: z.number().min(0).max(1).default(0.2),
    riskWeight: z.number().min(0).max(1).default(0.2),
    strategicWeight: z.number().min(0).max(1).default(0.6),
  }).default({}),
  sponsorId: optionalId,
  status: z.enum(nodeStatuses).default('active'),
});

export const updatePortfolioNodeSchema = createPortfolioNodeSchema.partial().extend({ expectedVersion: z.number().int().positive() });

export const createStrategyObjectiveSchema = z.object({
  currentValue: z.number().default(0),
  description: z.string().trim().max(10_000).default(''),
  kind: z.enum(['objective', 'key_result']).default('objective'),
  parentId: optionalId,
  status: z.enum(objectiveStatuses).default('active'),
  targetValue: z.number().default(100),
  title: z.string().trim().min(1).max(255),
  unit: z.string().trim().max(64).default('percent'),
  weight: z.number().min(0).max(100).default(1),
});

export const updateStrategyObjectiveSchema = createStrategyObjectiveSchema.partial().extend({ expectedVersion: z.number().int().positive() });

export const createPortfolioAlignmentSchema = z.object({
  benefitUnit: z.string().trim().max(64).default(''),
  benefitValue: z.number().default(0),
  costScore: z.number().min(0).max(100).default(0),
  demandStatus: z.enum(['candidate', 'approved', 'active', 'held', 'rejected']).default('candidate'),
  objectiveId: optionalId,
  portfolioNodeId: id,
  projectId: id,
  fundingCurrency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default('USD'),
  requestedFunding: z.number().finite().min(0).max(1_000_000_000_000).default(0),
  requestedHours: z.number().finite().min(0).max(10_000_000).default(0),
  riskScore: z.number().min(0).max(100).default(0),
  scenario: z.enum(['baseline', 'optimistic', 'constrained']).default('baseline'),
  strategicScore: z.number().min(0).max(100).default(0),
});

export const updatePortfolioAlignmentSchema = createPortfolioAlignmentSchema.partial().extend({ expectedVersion: z.number().int().positive() });
export const versionedPortfolioDeleteSchema = z.object({ expectedVersion: z.number().int().positive() });

export const createPortfolioPlanSchema = z.object({
  fundingCurrency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default('USD'),
  fundingLimit: z.number().finite().min(0).max(1_000_000_000_000),
  name: z.string().trim().min(1).max(255),
  portfolioNodeId: id,
  resourceHoursLimit: z.number().finite().min(0).max(10_000_000),
  scenario: z.enum(['baseline', 'optimistic', 'constrained']).default('baseline'),
  status: z.enum(['draft', 'submitted', 'approved', 'rejected']).default('draft'),
  decisionNote: z.string().trim().max(4000).default(''),
});
export const updatePortfolioPlanSchema = createPortfolioPlanSchema.partial().extend({ expectedVersion: z.number().int().positive() });
export const capturePortfolioBaselineSchema = z.object({ name: z.string().trim().min(1).max(255), portfolioNodeId: id, scenario: z.enum(['baseline', 'optimistic', 'constrained']).default('baseline') });

export const portfolioQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  query: z.string().trim().max(255).default(''),
  sort: z.enum(['name', 'score', 'updatedAt']).default('name'),
  status: z.enum(nodeStatuses).optional(),
});

export { nodeStatuses, objectiveStatuses };
