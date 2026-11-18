import { z } from 'zod';

export const waitlistSignupSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(320),
  company: z.string().trim().max(100).optional().default(''),
  companySize: z.string().trim().max(50).optional().default(''),
  industry: z.string().trim().max(100).optional().default(''),
  comments: z.string().trim().max(2000).optional().default(''),
  betaInterest: z.boolean().optional().default(false),
  // A field people never see. Anything in it means a bot filled the form.
  website: z.string().max(500).optional().default(''),
});
