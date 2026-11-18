// Which Requirements controls a person sees. The API enforces every rule; these helpers
// only keep the UI from offering actions that would come back as 404 (plan.md,
// Permissions). Decision rights come from the API's `canDecide`.

const COLLABORATE_PROJECT_ROLES = new Set(['admin', 'contributor', 'editor', 'manager', 'member', 'user']);
const TENANT_COLLABORATE_ROLES = new Set(['admin', 'manager']);
// project.plan.edit (backend/src/lib/auth/project-capabilities.js): members and plain users
// collaborate but do not draft, edit, or propose work from plans.
const PLAN_EDIT_PROJECT_ROLES = new Set(['admin', 'contributor', 'editor', 'manager']);

function normalized(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * Member and up can draft, add, edit, assign, delete, and comment. Viewers read only.
 * An unknown project role counts as a member: the server still checks.
 */
export function canCollaborateOnProject({ canDecide = false, projectRole = '', tenantRole = '' } = {}) {
  if (canDecide) return true;
  if (TENANT_COLLABORATE_ROLES.has(normalized(tenantRole))) return true;
  const role = normalized(projectRole);
  if (!role) return true;
  return COLLABORATE_PROJECT_ROLES.has(role);
}

/**
 * Draft, edit, and propose work from track plans. An unknown project role counts as a
 * member here, which cannot; the server still checks.
 */
export function canEditPlans({ canDecide = false, projectRole = '', tenantRole = '' } = {}) {
  if (canDecide) return true;
  if (TENANT_COLLABORATE_ROLES.has(normalized(tenantRole))) return true;
  return PLAN_EDIT_PROJECT_ROLES.has(normalized(projectRole));
}

/**
 * Every permission-driven switch for the Requirements views in one place. The Requirements
 * overview and My open items report `canCollaborate` and `canEditPlans` from the server's
 * capability check; when present they win over the role guess, because the project detail
 * API does not say which project role the caller has.
 */
export function requirementsAbilities({ canCollaborate = null, canDecide = false, canEditPlans: canEditPlansFlag = null, projectRole = '', tenantRole = '' } = {}) {
  const collaborate = typeof canCollaborate === 'boolean'
    ? canCollaborate
    : canCollaborateOnProject({ canDecide, projectRole, tenantRole });
  const editPlans = typeof canEditPlansFlag === 'boolean'
    ? canEditPlansFlag
    : canEditPlans({ canDecide, projectRole, tenantRole });
  return {
    acceptPreferences: Boolean(canDecide),
    // Approve a track plan; the approver owns it (Q-04, Q-14).
    approvePlans: Boolean(canDecide),
    addTopics: collaborate,
    assign: collaborate,
    changeStatus: Boolean(canDecide),
    // Close a round, or close the open one while publishing the next (Q-04).
    closeRounds: Boolean(canDecide),
    comment: collaborate,
    deleteTopics: collaborate,
    draftQuestions: collaborate,
    editPlans,
    editTopics: collaborate,
    // Change a round's due date, reminder, note, and reviewers, and resend invitations.
    manageRounds: collaborate,
    manageLinks: Boolean(canDecide),
    // Move a topic between tracks. Decided topics also need decision rights (server-checked).
    moveTopics: collaborate,
    // Publish a draft package as a round and invite reviewers (Q-05).
    publishRounds: collaborate,
    // Propose epics and stories from an approved plan into the proposer's AI Workspace review.
    proposeWork: editPlans,
    recordDecisions: Boolean(canDecide),
    refreshSummary: collaborate,
    uploadPackages: collaborate,
    vote: collaborate,
    withdrawPackages: collaborate,
  };
}

/** Whether the topic page shows the Record a decision form. */
export function showDecisionForm({ abilities, activeDecision = null, replacing = false, topic = null } = {}) {
  if (!abilities?.recordDecisions || !topic) return false;
  if (topic.state === 'dismissed') return false;
  return !activeDecision || replacing;
}

/**
 * The people the assign and reviewer pickers offer. The project's valid-users list needs
 * plan-edit rights, so for members it is empty; the Requirements overview carries the
 * project's members (name, email, project role) for everyone who can read the project.
 */
export function workspaceMembers({ overview = null, validUsers = [] } = {}) {
  if (Array.isArray(validUsers) && validUsers.length > 0) return validUsers;
  return Array.isArray(overview?.members) ? overview.members : [];
}
