import { z } from 'zod';

import { HOME_LENSES } from './home-lenses.js';

// agentView=1 builds Home without the tickets agents may not see (D-027). odin_get_my_work always
// sends it.
export const homeQuerySchema = z.object({
  agentView: z.enum(['0', '1']).optional(),
  lens: z.enum(HOME_LENSES).optional(),
});

export const homeLensSchema = z.object({
  lens: z.enum(HOME_LENSES),
});

export const homeProposalParamsSchema = z.object({
  proposalId: z.string().regex(/^rp_[a-f0-9]{16}$/, 'Unknown recovery proposal.'),
});
