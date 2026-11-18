import { hasDecisionRights } from './decision-rights.js';
import { PROJECT_CAPABILITIES, hasProjectCapability } from './project-capabilities.js';

// What someone may decide on a project, from their project and workspace roles:
// - canEditPlan: change work items at all;
// - canManage: make project-wide changes (its settings and dates, sprints, board, milestones,
//   dependencies, many items at once). Admins and managers, the people who also hold
//   Requirements decision rights;
// - canManageMembers: change who is on the project.
// The assistant is told this each turn, and MCP clients are held to it (mcp/change-scope.js).
export function projectStanding({ projectRole = null, tenantRole = null, userCapabilities = [] } = {}) {
  const has = (capability) => hasProjectCapability({ capability, projectRole, tenantRole, userCapabilities });
  const role = (value) => (value ? String(value).trim().toLowerCase() : null);
  return {
    canEditPlan: has(PROJECT_CAPABILITIES.PLAN_EDIT),
    canManage: hasDecisionRights({ projectRole, tenantRole }),
    canManageMembers: has(PROJECT_CAPABILITIES.ADMIN),
    projectRole: role(projectRole),
    workspaceRole: role(tenantRole),
  };
}
