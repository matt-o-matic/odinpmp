// Which optional modules a workspace has on (docs/engagements/plan.md, "Consulting module").
// Workspace admins switch them; every member can see whether one is on, so the app can show or
// hide what it holds.
import { HttpError } from '../../lib/errors/http-error.js';
import { CONSULTING_MODULE, WORKSPACE_MODULE_KEYS } from './workspace-modules.repository.js';

const MODULE_LABELS = { [CONSULTING_MODULE]: 'Consulting' };

function tenantIdFor(user) {
  const tenantId = user?.memberships?.[0]?.tenantId;
  if (!tenantId) throw new HttpError(403, 'This account is not assigned to a tenant.');
  return tenantId;
}

function isWorkspaceAdmin(user, tenantId) {
  return String(user?.memberships?.find((membership) => membership.tenantId === tenantId)?.role ?? '').toLowerCase() === 'admin';
}

export function moduleDisabledError(moduleKey) {
  return new HttpError(403, `The ${MODULE_LABELS[moduleKey] ?? moduleKey} module is switched off for this workspace.`, {
    details: { code: 'module_disabled', module: moduleKey },
  });
}

export async function isModuleEnabled(repository, tenantId, moduleKey) {
  if (!repository || !tenantId) return false;
  return (await repository.getModule({ moduleKey, tenantId })).enabled === true;
}

/** Throws 403 `module_disabled` unless the workspace has the module on. */
export async function requireModuleEnabled(repository, tenantId, moduleKey) {
  if (!await isModuleEnabled(repository, tenantId, moduleKey)) throw moduleDisabledError(moduleKey);
}

/**
 * Express middleware for routes that belong to a module, such as the engagement and billing
 * routes. Mount it after the auth middleware: it reads the active tenant from request.auth.
 */
export function createRequireModule({ moduleKey, workspaceModulesRepository }) {
  return async function requireModuleMiddleware(request, _response, next) {
    try {
      await requireModuleEnabled(workspaceModulesRepository, tenantIdFor(request.auth?.user), moduleKey);
      next();
    } catch (error) {
      next(error);
    }
  };
}

// What a switch affects, so the screen can say it before the admin confirms.
async function moduleImpact({ moduleKey, projectRepository, tenantId }) {
  if (moduleKey === CONSULTING_MODULE) {
    return { openEngagements: projectRepository?.countOpenEngagements ? await projectRepository.countOpenEngagements({ tenantId }) : 0 };
  }
  return {};
}

function presentModule(record, { admin, impact }) {
  const base = { enabled: record.enabled, key: record.moduleKey, label: MODULE_LABELS[record.moduleKey] ?? record.moduleKey };
  if (!admin) return base;
  return { ...base, impact, updatedAt: record.updatedAt, updatedBy: record.updatedBy, version: record.version };
}

export async function listWorkspaceModulesForUser({ projectRepository, repository, user }) {
  const tenantId = tenantIdFor(user);
  const admin = isWorkspaceAdmin(user, tenantId);
  const records = await repository.listModules({ tenantId });
  return {
    canManage: admin,
    modules: await Promise.all(records.map(async (record) => presentModule(record, {
      admin,
      impact: admin ? await moduleImpact({ moduleKey: record.moduleKey, projectRepository, tenantId }) : null,
    }))),
  };
}

export async function updateWorkspaceModuleForUser({ input, projectRepository, repository, user }) {
  const tenantId = tenantIdFor(user);
  if (!isWorkspaceAdmin(user, tenantId)) throw new HttpError(403, 'Only workspace admins can switch modules.', { details: { code: 'workspace_admin_required' } });
  if (!WORKSPACE_MODULE_KEYS.includes(input.key)) throw new HttpError(404, 'Module not found.');
  const before = await repository.getModule({ moduleKey: input.key, tenantId });
  const saved = await repository.setModule({ enabled: input.enabled, expectedVersion: input.expectedVersion, moduleKey: input.key, tenantId, userId: user.id });
  return {
    after: saved,
    before,
    module: presentModule(saved, { admin: true, impact: await moduleImpact({ moduleKey: input.key, projectRepository, tenantId }) }),
  };
}
