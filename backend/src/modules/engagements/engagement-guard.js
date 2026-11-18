// One place for the rules every engagement URL follows (docs/engagements/plan.md):
//  - with the Consulting module off, an engagement's project URLs answer 404, as a missing
//    project does;
//  - delivery views reached by a project URL (Insights) answer 404 for an engagement, while its
//    pursuit Insights (/insights/pursuit) answer as for any project;
//  - a lost engagement is read-only: writes answer 403 `engagement_closed` until it is reopened.
// Mounted on /api/projects/:projectId and /api/files/:fileId ahead of their routers, so every
// route and every MCP tool behind them gets the same answer.
import { HttpError } from '../../lib/errors/http-error.js';
import { PROJECT_KIND_ENGAGEMENT } from '../../lib/projects/project-kind.js';
import { CONSULTING_MODULE } from '../workspace-modules/workspace-modules.repository.js';
import { isModuleEnabled } from '../workspace-modules/workspace-modules.service.js';

const MUTATING_METHODS = new Set(['DELETE', 'PATCH', 'POST', 'PUT']);
// These answer 403 module_disabled themselves, and reopen is the way out of read-only.
const MODULE_ACTION_PATH = /^\/(?:convert|close|reopen)\/?$/;
const REOPEN_PATH = /^\/reopen\/?$/;
// Reading a channel of a lost engagement marks it read; nothing shared changes.
const READ_MARKER_PATH = /^\/channels\/[^/]+\/read\/?$/;
// Removing a guest from a lost engagement's channel only takes access away.
const GUEST_REMOVAL_PATH = /^\/channels\/[^/]+\/guests\/[^/]+\/?$/;
// Delivery views with a per-project URL. An engagement has no delivery Insights until it
// converts; its pursuit Insights are its Insights tab (docs/engagements/plan.md).
const DELIVERY_ONLY_PATH = /^\/insights(?!\/pursuit\/?$)(?:\/|$)/;

/**
 * True for an engagement whose workspace has the Consulting module off. Links for outside people
 * (stakeholder, task access and guest links) treat its project as gone, as member URLs do. With
 * no modules repository the module counts as off, so a forgotten dependency hides rather than shows.
 */
export async function isHiddenByModule({ projectRepository, workspaceModulesRepository }, projectId) {
  const kind = projectRepository?.getProjectKind ? await projectRepository.getProjectKind({ projectId }) : null;
  if (kind?.kind !== PROJECT_KIND_ENGAGEMENT) return false;
  return !await isModuleEnabled(workspaceModulesRepository, kind.tenantId, CONSULTING_MODULE);
}

function notFound() {
  return new HttpError(404, 'Project not found.');
}

function closedError() {
  return new HttpError(403, 'This engagement is marked lost and is read-only. Reopen it to make changes.', {
    details: { code: 'engagement_closed' },
  });
}

// Runs the auth middleware for its effect on request.auth, without ending the request.
function authenticate(requireAuth, request, response) {
  return new Promise((resolve, reject) => {
    requireAuth(request, response, (error) => (error ? reject(error) : resolve()));
  });
}

export function createEngagementGuard({ projectRepository, requireAuth, workspaceModulesRepository }) {
  async function check({ kind, request, response, subPath }) {
    if (kind?.kind !== PROJECT_KIND_ENGAGEMENT) return;
    if (!await isModuleEnabled(workspaceModulesRepository, kind.tenantId, CONSULTING_MODULE)) {
      if (MODULE_ACTION_PATH.test(subPath)) return;
      throw notFound();
    }
    if (DELIVERY_ONLY_PATH.test(subPath)) throw notFound();
    if (kind.engagementStatus !== 'lost' || !MUTATING_METHODS.has(request.method) || REOPEN_PATH.test(subPath) || READ_MARKER_PATH.test(subPath)) return;
    if (request.method === 'DELETE' && GUEST_REMOVAL_PATH.test(subPath)) return;
    // Only someone in the engagement's workspace learns that it is closed.
    if (!request.auth?.user) await authenticate(requireAuth, request, response);
    const inWorkspace = request.auth?.user?.memberships?.some((membership) => membership.tenantId === kind.tenantId);
    throw inWorkspace ? closedError() : notFound();
  }

  return {
    async project(request, response, next) {
      try {
        const kind = projectRepository?.getProjectKind ? await projectRepository.getProjectKind({ projectId: request.params.projectId }) : null;
        await check({ kind, request, response, subPath: request.path ?? '' });
        next();
      } catch (error) {
        next(error);
      }
    },
    // /api/files/:fileId names no project, so the file's project is found through the caller's
    // workspace. The vault routes check the caller's rights on it as before.
    async file(request, response, next) {
      try {
        if (!projectRepository?.getProjectKind || !projectRepository.getFileRecord) return next();
        await authenticate(requireAuth, request, response);
        const tenantId = request.auth?.user?.memberships?.[0]?.tenantId;
        const file = tenantId ? await projectRepository.getFileRecord({ fileId: request.params.fileId, tenantId }) : null;
        const kind = file?.projectId ? await projectRepository.getProjectKind({ projectId: file.projectId }) : null;
        await check({ kind, request, response, subPath: '' });
        next();
      } catch (error) {
        next(error);
      }
    },
  };
}
