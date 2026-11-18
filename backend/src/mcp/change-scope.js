import { OdinApiError } from './api-client.js';

// Project-wide changes belong to a project's admins and managers (by project or workspace role).
// Odin's routes let anyone who can edit the plan make them one at a time, but an MCP client (the
// in-app assistant included) can make dozens in one go, so MCP clients are held to a narrower
// rule. Someone who can edit the plan but is not an admin or manager cannot change:
// - the project's settings, dates or brief, its sprints, its board setup, or its milestones,
//   dependencies, working calendar and schedule baselines;
// - more than ITEM_LIMIT work items in one tool call (for the in-app assistant, in one turn).
// Who may do what comes from the project read (permissions, see lib/auth/project-standing.js).
// Only an explicit "edits the plan, not a manager" refuses. Odin's routes still check every write,
// and refuse people who cannot edit the plan at all as they always have.

export const ITEM_LIMIT = 10;

const PROJECT = String.raw`^/api/projects/([A-Za-z0-9_-]+)`;
const PROJECT_WIDE = [
  [/^PUT$/, new RegExp(`${PROJECT}$`), 'the project\'s settings and dates'],
  [/^PATCH$/, new RegExp(`${PROJECT}/assistant-brief$`), 'the project\'s brief'],
  [/^(?:POST|PUT)$/, new RegExp(`${PROJECT}/sprints(?:/.*)?$`), 'sprints'],
  [/^PUT$/, new RegExp(`${PROJECT}/kanban/config$`), 'the board setup'],
  [/^PUT$/, new RegExp(`${PROJECT}/billing/milestones$`), 'the SOW milestones stories bill to'],
  [/^(?:POST|PUT|PATCH|DELETE)$/, new RegExp(`${PROJECT}/governance/(?:milestones|dependencies|working-calendar|schedule-baselines)(?:/.*)?$`), 'milestones, dependencies, the working calendar or schedule baselines'],
];
const ITEM_WRITES = [
  [/^POST$/, new RegExp(`${PROJECT}/items$`)],
  [/^(?:PATCH|DELETE)$/, new RegExp(`${PROJECT}/items/[^/]+$`)],
  [/^POST$/, new RegExp(`${PROJECT}/kanban/reorder$`)],
  [/^POST$/, new RegExp(`${PROJECT}/items/[^/]+/(?:restore|review)$`)],
  [/^POST$/, new RegExp(`${PROJECT}/stories/[^/]+/split$`)],
];
// A batch of checked changes (odin_apply_item_changes) writes up to 25 items in one request: it is
// refused whole when its items would pass the limit, and counts the items it changed.
const BATCH_WRITE = [[/^POST$/, new RegExp(`${PROJECT}/item-changes$`)]];
const PROJECT_READ = new RegExp(`${PROJECT}$`);
const batchItems = (body) => new Set((Array.isArray(body?.changes) ? body.changes : []).map((change) => change?.itemId)).size;
// Changes that wrote this time: applied, or partly saved. A replay wrote nothing new.
const batchWrote = (result) => (Array.isArray(result?.results) ? result.results : [])
  .filter((entry) => (entry?.status === 'applied' || entry?.partial) && !entry?.replayed).length;

const matching = (rules, method, path) => rules.find(([verb, pattern]) => verb.test(method) && pattern.test(path));
const limited = (permissions) => permissions.canEditPlan === true && permissions.canManage === false;
const roleLabel = (permissions) => permissions.projectRole ?? (permissions.workspaceRole ? `workspace ${permissions.workspaceRole}` : 'none');

/** Wraps an Odin API client so every MCP tool built on it keeps to the rule above. */
export function withChangeScope(api) {
  if (!api || api.checkItemLimit) return api;
  const permissionsByProject = new Map();
  const itemsChanged = new Map();

  async function permissionsFor(projectId) {
    if (!permissionsByProject.has(projectId)) {
      const { permissions } = await api.request('GET', `/api/projects/${encodeURIComponent(projectId)}`);
      permissionsByProject.set(projectId, permissions ?? {});
    }
    return permissionsByProject.get(projectId);
  }

  function refuse(permissions, message) {
    throw new OdinApiError(403, 'needs_project_manager', `${message} Your role on this project is ${roleLabel(permissions)}. A project admin or manager can make this change.`, {
      details: { itemLimit: ITEM_LIMIT, role: roleLabel(permissions) },
    });
  }

  // Before a write that changes `count` work items, or before a bulk tool's first write so it is
  // refused whole rather than halfway.
  async function checkItemLimit(projectId, count = 1) {
    const used = itemsChanged.get(projectId) ?? 0;
    if (used + count <= ITEM_LIMIT) return;
    const permissions = await permissionsFor(projectId);
    if (!limited(permissions)) return;
    refuse(permissions, `Only a project admin or manager can change more than ${ITEM_LIMIT} work items at once${used ? ` (${used} changed already)` : ''}.`);
  }

  return {
    ...api,
    checkItemLimit,
    // A long-lived MCP server starts each tool call afresh, with roles read again.
    reset() {
      permissionsByProject.clear();
      itemsChanged.clear();
    },
    async request(method, path, ...options) {
      const projectWide = method !== 'GET' && matching(PROJECT_WIDE, method, path);
      const itemWrite = method !== 'GET' && matching(ITEM_WRITES, method, path);
      if (projectWide) {
        const projectId = decodeURIComponent(path.match(projectWide[1])[1]);
        const permissions = await permissionsFor(projectId);
        if (limited(permissions)) refuse(permissions, `Only a project admin or manager can change ${projectWide[2]}.`);
      }
      const itemProject = itemWrite ? decodeURIComponent(path.match(itemWrite[1])[1]) : null;
      if (itemProject) await checkItemLimit(itemProject, 1);
      const batch = method !== 'GET' && matching(BATCH_WRITE, method, path);
      const batchProject = batch ? decodeURIComponent(path.match(batch[1])[1]) : null;
      const note = (projectId, count) => itemsChanged.set(projectId, (itemsChanged.get(projectId) ?? 0) + count);
      if (batchProject) await checkItemLimit(batchProject, batchItems(options[0]?.body));
      let result;
      try {
        result = await api.request(method, path, ...options);
      } catch (error) {
        // A batch that may have saved before the reply was lost counts in full.
        if (batchProject && error?.outcomeUnknown) note(batchProject, batchItems(options[0]?.body));
        throw error;
      }
      if (method === 'GET' && PROJECT_READ.test(path) && result?.permissions) {
        permissionsByProject.set(decodeURIComponent(path.match(PROJECT_READ)[1]), result.permissions);
      }
      if (itemProject) note(itemProject, 1);
      if (batchProject) note(batchProject, batchWrote(result));
      return result;
    },
  };
}
