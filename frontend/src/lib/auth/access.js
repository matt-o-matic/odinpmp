// Client-side mirrors of the backend's role checks, used to hide menu entries and guard routes.
// The backend still enforces every rule. `user.role` is the role in the active workspace: the
// session serializer reports the active tenant's membership, and the auth middleware puts that
// membership first, which is the one the backend services check (`memberships[0]`).

export function workspaceRole(user) {
  return user?.role ?? null;
}

export function isWorkspaceAdmin(user) {
  return workspaceRole(user) === 'admin';
}

function hasCapability(user, capability) {
  return isWorkspaceAdmin(user) || Boolean(user?.capabilities?.includes(capability));
}

export function canManageIdentity(user) {
  return hasCapability(user, 'identity.manage');
}

export function canManageIntegrations(user) {
  return hasCapability(user, 'integrations.manage');
}

// backend/src/modules/ranking/ranking.service.js requireRankingRole
export function canRankProjects(user) {
  return ['admin', 'manager'].includes(workspaceRole(user));
}

// backend/src/modules/memory/agent-memory.service.js tenantIdFor: any workspace member.
// Project rights then decide which memories show and who may change them.
export function canViewAgentMemory(user) {
  return Boolean(workspaceRole(user));
}

const ACCESS_RULES = {
  agentMemory: { allowed: canViewAgentMemory, notice: 'What the AI remembers is available to workspace members.' },
  admin: { allowed: isWorkspaceAdmin, notice: 'Tenant administration is available to workspace admins.' },
  // backend/src/modules/compliance/compliance.service.js requireAdmin
  compliance: { allowed: isWorkspaceAdmin, notice: 'Compliance controls are available to workspace admins.' },
  // backend/src/modules/tenants/tenants.service.js listTicketConfigListForUser
  ticketConfig: { allowed: isWorkspaceAdmin, notice: 'Ticket environments and releases are managed by workspace admins.' },
  'identity.manage': { allowed: canManageIdentity, notice: 'Identity & access needs the identity management permission.' },
  'integrations.manage': { allowed: canManageIntegrations, notice: 'API & integrations needs the integration management permission.' },
  rankProjects: { allowed: canRankProjects, notice: 'Rank Projects is available to workspace admins and managers.' },
};

function accessKeyForMeta(meta = {}) {
  if (meta.requiresAdmin) return 'admin';
  return meta.requiredCapability ?? meta.requiredAccess ?? null;
}

// Returns null when the route is allowed, otherwise the notice code to show after redirecting.
export function deniedAccessFor(meta, user) {
  const key = accessKeyForMeta(meta);
  if (!key) return null;
  const allowed = ACCESS_RULES[key]?.allowed ?? ((candidate) => hasCapability(candidate, key));
  return allowed(user) ? null : key;
}

export function accessNoticeMessage(code) {
  if (typeof code !== 'string' || !code) return '';
  return ACCESS_RULES[code]?.notice ?? 'You don’t have access to that page in this workspace.';
}
