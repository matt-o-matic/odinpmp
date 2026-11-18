import { z } from 'zod';

const id = z.string().uuid();
const expectedVersion = z.number().int().positive();
const boundedText = (max) => z.string().trim().max(max);
const roleKey = z.string().trim().regex(/^[a-z][a-z0-9_]{1,63}$/);
const capabilityArray = z.array(z.string().trim().regex(/^[a-z][a-z0-9_.:-]{1,127}$/)).max(200);
const capabilities = capabilityArray.default([]);

export const identityWorkspaceQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export const breakGlassPolicySchema = z.object({
  enabled: z.boolean().default(false),
  expectedVersion: z.number().int().nonnegative().default(0),
  maxSessionMinutes: z.number().int().min(5).max(60).default(15),
  userIds: z.array(boundedText(128).min(1)).max(10).default([]).transform((values) => [...new Set(values)]),
}).superRefine((value, context) => {
  if (value.enabled && value.userIds.length === 0) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Enabled break-glass access requires at least one designated account.', path: ['userIds'] });
});

export const identityPolicySchema = z.object({
  defaultRoleKey: roleKey.default('user'),
  expectedVersion: z.number().int().nonnegative().default(0),
  jitEnabled: z.boolean().default(false),
  loginEnforcement: z.enum(['optional', 'required']).default('optional'),
  provider: z.object({
    audience: boundedText(500).default(''),
    clientId: boundedText(500).default(''),
    decryptionKeyReference: boundedText(500).default(''),
    emailAttribute: boundedText(500).default('email'),
    entryPoint: z.string().trim().url().max(2000).or(z.literal('')).default(''),
    groupsAttribute: boundedText(500).default('groups'),
    idpCertificate: boundedText(16000).default(''),
    issuer: boundedText(1000).default(''),
    metadataUrl: z.string().trim().url().max(2000).or(z.literal('')).default(''),
    secretReference: boundedText(500).default(''),
    spSigningCertReference: boundedText(500).default(''),
    spSigningKeyReference: boundedText(500).default(''),
  }).default({}),
  ssoMode: z.enum(['none', 'oidc', 'saml']).default('none'),
}).superRefine((value, context) => {
  if (value.ssoMode !== 'none' && !value.provider.issuer && !value.provider.metadataUrl) context.addIssue({ code: z.ZodIssueCode.custom, message: 'SSO requires an issuer or metadata URL.', path: ['provider'] });
  if (value.ssoMode === 'saml' && !value.provider.entryPoint) context.addIssue({ code: z.ZodIssueCode.custom, message: 'SAML requires an identity-provider entry point.', path: ['provider', 'entryPoint'] });
  if (value.ssoMode === 'saml' && !value.provider.idpCertificate) context.addIssue({ code: z.ZodIssueCode.custom, message: 'SAML requires an identity-provider signing certificate.', path: ['provider', 'idpCertificate'] });
  if (value.loginEnforcement === 'required' && value.ssoMode === 'none') context.addIssue({ code: z.ZodIssueCode.custom, message: 'Required SSO enforcement needs an OIDC or SAML provider.', path: ['loginEnforcement'] });
});

export const verifiedDomainCreateSchema = z.object({ domain: z.string().trim().toLowerCase().regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/), verificationMethod: z.enum(['dns_txt', 'manual']).default('dns_txt') });
export const verifiedDomainVerifySchema = z.object({ expectedVersion, proof: boundedText(2000).default('') });
export const identityDeleteSchema = z.object({ expectedVersion });

export const customRoleCreateSchema = z.object({ capabilities, description: boundedText(1000).default(''), key: roleKey, name: boundedText(120).min(1) });
export const customRoleUpdateSchema = customRoleCreateSchema.partial().extend({ expectedVersion });

export const identityGroupCreateSchema = z.object({ description: boundedText(1000).default(''), externalId: boundedText(255).default(''), name: boundedText(160).min(1), roleKeys: z.array(roleKey).max(50).default([]) });
export const identityGroupUpdateSchema = identityGroupCreateSchema.partial().extend({ expectedVersion });
export const groupMembershipSchema = z.object({ userId: boundedText(128).min(1) });

export const accessReviewCreateSchema = z.object({ dueAt: z.string().datetime(), name: boundedText(240).min(1), reviewerUserId: boundedText(128).min(1), scope: z.enum(['tenant', 'groups', 'service_accounts']).default('tenant') });
export const accessReviewDecisionSchema = z.object({ decision: z.enum(['approve', 'revoke']), expectedVersion, note: boundedText(2000).default('') });
export const accessReviewCampaignCreateSchema = z.object({
  durationDays: z.number().int().min(1).max(90).default(14),
  enabled: z.boolean().default(true),
  intervalDays: z.number().int().min(7).max(366),
  name: boundedText(240).min(1),
  nextRunAt: z.string().datetime(),
  reviewerUserId: boundedText(128).min(1),
  scope: z.enum(['tenant', 'groups', 'service_accounts']).default('tenant'),
});
export const accessReviewCampaignUpdateSchema = accessReviewCampaignCreateSchema.partial().extend({ expectedVersion });

export const serviceAccountCreateSchema = z.object({ description: boundedText(1000).default(''), expiresAt: z.string().datetime().nullable().default(null), name: boundedText(160).min(1), projectIds: z.array(boundedText(128).min(1)).max(200).default([]), scopes: capabilityArray.min(1) });
export const serviceAccountUpdateSchema = serviceAccountCreateSchema.partial().extend({ enabled: z.boolean().optional(), expectedVersion });
export const serviceCredentialRotateSchema = z.object({ expectedVersion, expiresAt: z.string().datetime().nullable().default(null) });

export const impersonationRequestSchema = z.object({ expiresAt: z.string().datetime(), reason: boundedText(2000).min(10), targetUserId: boundedText(128).min(1) });
export const impersonationDecisionSchema = z.object({ decision: z.enum(['approved', 'rejected']), expectedVersion, note: boundedText(2000).default('') });
export const impersonationEndSchema = z.object({ expectedVersion });

export { id as identityIdSchema };
