import { z } from 'zod';
import { OdinApiError } from './api-client.js';

// A project's billing from invoice-gen (docs/invoice-gen-connection/plan.md): its SOW, milestone
// hours and invoices, and the SOW milestone each story bills to. Odin's routes allow only project
// admins and managers and workspace admins and managers (finance visibility, E-08), for reads and
// for changes alike, so no model can reach past that. There are no claim or release tools:
// invoice-gen claims time as it drafts invoices, and releases it when one is voided.

const projectPath = (projectId) => `/api/projects/${encodeURIComponent(projectId)}`;

const ERRORS = {
  400: ['http_400', 'Odin rejected the assignments. Each names a story id and a milestone id from odin_get_project_billing, or null to clear it.'],
  404: ['http_404', 'Project not found or not readable.'],
};

function remap(error) {
  if (error instanceof OdinApiError && error.code === `http_${error.status}` && ERRORS[error.status]) {
    const [code, message] = ERRORS[error.status];
    throw new OdinApiError(error.status, code, message, { outcomeUnknown: error.outcomeUnknown });
  }
  throw error;
}

/** Registers the billing tools on createOdinToolCatalog's `tool` helper. */
export function registerBillingTools({ api, dryRun, id, tool }) {
  async function call(method, path, options = {}) {
    try {
      return await api.request(method, path, options);
    } catch (error) {
      return remap(error);
    }
  }

  tool('odin_get_project_billing', [
    'Read a project\'s billing from invoice-gen: the linked client and SOW, each SOW milestone with its budget, billed, claimed-but-unbilled and approved-but-unclaimed hours, the "No SOW" hours,',
    'the invoices with their status and overdue flag, when invoice-gen last sent anything, and each story with the milestone it bills to.',
    'Only project admins and managers, and workspace admins and managers, can read billing. Needs the Consulting module.',
  ].join(' '), z.object({ projectId: id }).strict(), async ({ projectId }) => {
    const [billing, mapping] = await Promise.all([
      call('GET', `${projectPath(projectId)}/billing`),
      call('GET', `${projectPath(projectId)}/billing/milestones`),
    ]);
    return {
      ok: true,
      heardAt: billing.heardAt ?? null,
      invoices: billing.invoices ?? [],
      link: billing.link ?? null,
      milestones: billing.milestones ?? [],
      noSow: billing.noSow ?? null,
      stories: mapping.stories ?? [],
    };
  }, { purpose: 'See a project\'s SOW, invoices, and billed or unbilled hours per SOW milestone, or which stories bill to which milestone.' });

  const assignment = z.object({
    storyId: id,
    milestoneId: z.number().int().nonnegative().nullable().describe('A milestone id from odin_get_project_billing, or null to take the story off its milestone.'),
  }).strict();
  tool('odin_set_story_milestones', [
    'Set the SOW milestone stories bill to, many at once: time logged on a story, or on a task under it, bills to that milestone. A story holds one milestone at most;',
    'setting another moves it. Stories can come from any epic. Only project admins and managers, and workspace admins and managers, can change this.',
  ].join(' '), z.object({ projectId: id, assignments: z.array(assignment).min(1).max(100), dryRun }).strict(), async ({ assignments, dryRun: preview, projectId }) => {
    const path = `${projectPath(projectId)}/billing/milestones`;
    if (preview) return { ok: true, dryRun: true, validation: 'schema_only', authorizationChecked: false, request: { method: 'PUT', path, body: { assignments } } };
    const result = await call('PUT', path, { body: { assignments } });
    return { ok: true, changed: result.changed ?? [], milestones: result.milestones ?? [], stories: (result.stories ?? []).filter((story) => assignments.some((entry) => entry.storyId === story.id)) };
  }, { write: true, purpose: 'Assign stories to SOW milestones for invoicing, such as putting the login stories under the Build milestone.' });
}
