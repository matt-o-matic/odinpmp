import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(8).max(200),
});

// Every sign-up form sends these. `website` is a honeypot people never see, so any value means a bot.
const signupGuardFields = {
  recaptchaToken: z.string().max(4000).optional().default(''),
  website: z.string().max(500).optional().default(''),
};

export const registerSchema = z
  .object({
    authMethod: z.enum(['basic', 'google']).default('basic'),
    createTenant: z.boolean().default(true),
    email: z.string().trim().email().max(320),
    name: z.string().trim().min(1).max(120),
    password: z.string().max(200).optional().default(''),
    tenantName: z.string().trim().min(1).max(120),
    ...signupGuardFields,
  })
  .superRefine((value, context) => {
    if (value.authMethod === 'basic' && value.password.length < 8) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Password must be at least 8 characters for basic auth registrations.',
        path: ['password'],
      });
    }
  });

export const availabilitySchema = z.object({
  email: z.string().trim().email().max(320),
  tenantName: z.string().trim().max(120).optional().default(''),
});

export const refreshSessionSchema = z.object({
  refreshToken: z.string().trim().min(1).optional(),
});

export const switchTenantSchema = z.object({
  tenantId: z.string().uuid(),
});

export const twoFactorVerifySchema = z.object({
  challengeToken: z.string().trim().min(1),
  code: z.string().trim().min(6).max(64),
});

export const twoFactorCodeSchema = z.object({
  code: z.string().trim().min(6).max(64),
});

export const breakGlassStartSchema = loginSchema.extend({
  reason: z.string().trim().min(20).max(2000),
  tenantId: z.string().uuid().optional(),
});

export const breakGlassVerifySchema = z.object({
  challengeToken: z.string().trim().min(1),
  code: z.string().trim().min(6).max(64),
});

export const invitedRegistrationSchema = z.object({
  name: z.string().trim().min(1).max(120),
  password: z.string().min(8).max(200),
  ...signupGuardFields,
}).strict();

export const verifyRegistrationSchema = z.object({
  token: z.string().trim().min(20).max(200),
});
