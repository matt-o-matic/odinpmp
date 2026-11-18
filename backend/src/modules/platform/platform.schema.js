import { z } from 'zod';
import { PLATFORM_EVENT_TYPES } from './platform-event-registry.js';

export const PLATFORM_SCOPES = Object.freeze([
  'audit.read',
  // invoice-gen's billing routes (docs/invoice-gen-connection/api-contract.md).
  'billing.read',
  'billing.write',
  'projects.read',
  'projects.write',
]);

export { PLATFORM_EVENT_TYPES } from './platform-event-registry.js';

const exactHttpsUrl = z.string().trim().url().max(2000).refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
}, 'Webhook URLs must be HTTPS and cannot include credentials or fragments.');
const oauthRedirectUri = z.string().trim().url().max(2000).refine((value) => {
  const url = new URL(value);
  return (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) && !url.username && !url.password && !url.hash;
}, 'OAuth redirect URIs must use HTTPS or an HTTP loopback address and cannot include credentials or fragments.');

export const platformIdSchema = z.string().uuid();
export const platformWorkspaceQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export const platformProjectsQuerySchema = z.object({
  kind: z.enum(['delivery', 'engagement', 'all']).default('all'),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export const platformIdempotencyKeySchema = z.string().trim().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/);

export const oauthApplicationCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  projectIds: z.array(z.string().trim().min(1).max(128)).max(500).default([]),
  redirectUris: z.array(oauthRedirectUri).max(20).default([]),
  scopes: z.array(z.enum(PLATFORM_SCOPES)).min(1).max(20),
});

export const oauthApplicationUpdateSchema = oauthApplicationCreateSchema.partial().extend({
  enabled: z.boolean().optional(),
  expectedVersion: z.number().int().positive(),
});

export const oauthCredentialRotateSchema = z.object({
  expectedVersion: z.number().int().positive(),
});

const oauthClientCredentialsTokenSchema = z.object({
  client_id: z.string().trim().min(10).max(200),
  client_secret: z.string().trim().min(32).max(500),
  grant_type: z.literal('client_credentials'),
  scope: z.string().trim().max(1000).optional().default(''),
});
const oauthAuthorizationCodeTokenSchema = z.object({
  client_id: z.string().trim().min(10).max(200), client_secret: z.string().trim().min(32).max(500),
  code: z.string().trim().min(40).max(500), code_verifier: z.string().trim().min(43).max(128),
  grant_type: z.literal('authorization_code'), redirect_uri: oauthRedirectUri,
});
export const oauthTokenSchema = z.discriminatedUnion('grant_type', [oauthClientCredentialsTokenSchema, oauthAuthorizationCodeTokenSchema]);
export const oauthAuthorizationConsentSchema = z.object({
  approved: z.literal(true), clientId: z.string().trim().min(10).max(200),
  codeChallenge: z.string().trim().regex(/^[A-Za-z0-9_-]{43,128}$/), codeChallengeMethod: z.literal('S256'),
  redirectUri: oauthRedirectUri, scope: z.string().trim().min(1).max(1000), state: z.string().trim().min(8).max(500),
});

export const webhookSubscriptionCreateSchema = z.object({
  description: z.string().trim().max(1000).default(''),
  eventTypes: z.array(z.enum(PLATFORM_EVENT_TYPES)).min(1).max(50),
  name: z.string().trim().min(2).max(120),
  url: exactHttpsUrl,
});

export const webhookSubscriptionUpdateSchema = webhookSubscriptionCreateSchema.partial().extend({
  enabled: z.boolean().optional(),
  expectedVersion: z.number().int().positive(),
});

export const webhookReplaySchema = z.object({
  expectedVersion: z.number().int().positive(),
});
