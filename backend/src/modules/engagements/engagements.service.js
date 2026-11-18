// Engagements: create and list them, convert one to a delivery
// project, mark one lost and reopen it. Every operation needs the Consulting module on.
import { requireDecisionRights } from '../../lib/auth/decision-rights.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { buildOperationLogContext, logBackendError } from '../../lib/logging/backend-logger.js';
import { unreadByProjectForUser } from '../channels/channels.service.js';
import { applyProjectTemplateToExistingProject, planProjectTemplate } from '../workflows/template-application.js';
import { ensureTicketWorkflowBinding } from '../workflows/ticket-workflow.js';
import { CONSULTING_MODULE } from '../workspace-modules/workspace-modules.repository.js';
import { requireModuleEnabled } from '../workspace-modules/workspace-modules.service.js';
import { moveOpenPursuitTasksStep, openPursuitTaskIds } from '../pursuit/pursuit.service.js';
import { assertEngagementTransition } from './engagements.repository.js';

const CONVERTED_PROJECT_STATUS = 'Planned';

function tenantIdFor(user) {
  const tenantId = user?.memberships?.[0]?.tenantId;
  if (!tenantId) throw new HttpError(403, 'This account is not assigned to a tenant.');
  return tenantId;
}

async function requireConsulting(workspaceModulesRepository, user) {
  const tenantId = tenantIdFor(user);
  await requireModuleEnabled(workspaceModulesRepository, tenantId, CONSULTING_MODULE);
  return tenantId;
}

/**
 * Keeps the engagement's guests as the project's stakeholders when it converts, inside the
 * conversion's transaction (`executor` is null in memory). A guest is invited through a
 * stakeholder record on the project (guests.service.js), so every guest is one already, and their
 * channels, posts and files stay with the same record. This checks that each current guest's
 * record is still on the project, and refuses the conversion (nothing changes) if one is not, so
 * no guest is lost. Returns how many guests there are.
 */
export async function addEngagementGuestsAsStakeholders({ assistantRepository = null, executor = null, projectId, projectRepository = null, tenantId }) {
  if (!projectRepository?.listProjectChannelGuests) return 0;
  const guests = await projectRepository.listProjectChannelGuests({ ...(executor ? { executor } : {}), projectId, tenantId });
  const stakeholderIds = [...new Set(guests.map((guest) => guest.stakeholderId))];
  if (!stakeholderIds.length) return 0;
  let present;
  if (executor) {
    const [rows] = await executor.query('SELECT id FROM project_stakeholders WHERE tenant_id = ? AND project_id = ? AND id IN (?)', [tenantId, projectId, stakeholderIds]);
    present = new Set(rows.map((row) => row.id));
  } else {
    present = new Set(((await assistantRepository?.listProjectStakeholders?.({ projectId, tenantId })) ?? []).map((stakeholder) => stakeholder.id));
  }
  const missing = stakeholderIds.filter((id) => !present.has(id));
  if (missing.length) {
    throw new HttpError(409, 'Some guests of this engagement have no stakeholder record on it, so converting would lose them. Invite them again, then convert.', { details: { code: 'guest_stakeholder_missing', stakeholderIds: missing } });
  }
  return stakeholderIds.length;
}

export async function listEngagementsForUser({ input = {}, projectRepository, user, workspaceModulesRepository }) {
  const tenantId = await requireConsulting(workspaceModulesRepository, user);
  const listed = await projectRepository.listEngagements({ tenantId, user });
  const counts = { lost: 0, open: 0, won: 0 };
  for (const engagement of listed) counts[engagement.status] = (counts[engagement.status] ?? 0) + 1;
  const shown = input.status ? listed.filter((engagement) => engagement.status === input.status) : listed;
  // Posts the person has not read in each engagement's open channels.
  const unread = await unreadByProjectForUser({ projectRepository }, user, shown.map((engagement) => engagement.id));
  return {
    counts,
    engagements: shown.map((engagement) => ({ ...engagement, unreadCount: unread.get(engagement.id) ?? 0 })),
  };
}

export async function createEngagementForUser({ input, projectRepository, user, workspaceModulesRepository }) {
  const tenantId = await requireConsulting(workspaceModulesRepository, user);
  const project = await projectRepository.createEngagement({ input, tenantId, user });
  // The hidden Pursuit epic and story that the Board tab's tasks go under.
  await projectRepository.ensurePursuitStory({ projectId: project.id, tenantId });
  return { ok: true, project };
}

/**
 * Converts an engagement to a delivery project, keeping its id and everything on it. A chosen
 * template is applied first, while the project is still an engagement; the conversion then
 * runs in one step. If either fails, only what the template added is undone and the
 * engagement stays open, as it was. Pursuit tasks stay on the Pursuit tab; with
 * `moveOpenPursuitTasks`, the open ones move to the plan in the same step.
 */
export async function convertEngagementForUser({ assistantRepository = null, input = {}, projectId, projectRepository, user, workflowRepository = null, workspaceModulesRepository, beforeCommit = addEngagementGuestsAsStakeholders }) {
  const tenantId = await requireConsulting(workspaceModulesRepository, user);
  await requireDecisionRights({ projectId, repository: projectRepository, tenantId, user });
  const engagement = await projectRepository.getProjectDetail({ projectId, tenantId });
  assertEngagementTransition(engagement, 'convert');

  let applied = null;
  if (input.templateId) {
    const plan = await planProjectTemplate({ projectInput: { name: engagement.name, status: CONVERTED_PROJECT_STATUS }, templateId: input.templateId, tenantId, user, workflowRepository });
    applied = await applyProjectTemplateToExistingProject({ plan, project: engagement, projectRepository, tenantId, user, workflowRepository });
  }

  const moveTaskIds = input.moveOpenPursuitTasks ? await openPursuitTaskIds({ projectId, projectRepository, tenantId, workflowRepository }) : [];
  const moveTasks = moveOpenPursuitTasksStep({ projectRepository, taskIds: moveTaskIds, user });
  // One transaction: the guests' stakeholder check runs first, so a refused conversion moves nothing.
  const commitSteps = async (context) => {
    await beforeCommit({ ...context, assistantRepository, projectRepository });
    await moveTasks(context);
  };

  let project;
  try {
    project = await projectRepository.convertEngagement({ beforeCommit: commitSteps, projectId, tenantId, user });
  } catch (error) {
    if (applied) await applied.undo(error);
    throw error;
  }

  // A delivery project gets the default ticket lifecycle, as a new project does. Tickets are
  // optional, so a failure here does not undo the conversion.
  try {
    await ensureTicketWorkflowBinding({ projectId, repository: workflowRepository, tenantId });
  } catch (error) {
    logBackendError({ context: buildOperationLogContext('engagements.ensureTicketWorkflowBinding', { projectId, tenantId, userId: user.id }), error, level: 'warn', message: 'Could not bind the ticket workflow to a converted engagement.' });
  }

  return { movedPursuitTaskIds: moveTaskIds, ok: true, project: { ...project, templateApplied: input.templateId ? { templateId: input.templateId } : null } };
}

/** Changes an engagement's customer or owner. The owner must be one of its members. */
export async function updateEngagementForUser({ input, projectId, projectRepository, user, workspaceModulesRepository }) {
  const tenantId = await requireConsulting(workspaceModulesRepository, user);
  await requireDecisionRights({ projectId, repository: projectRepository, tenantId, user });
  if (input.ownerId) {
    const valid = await projectRepository.getValidUsers({ projectId, tenantId });
    if (!(valid?.project_users ?? []).some((member) => String(member.id) === input.ownerId)) {
      throw new HttpError(400, 'The owner must be a member of the engagement. Add them under People first.', { details: { code: 'owner_not_member' } });
    }
  }
  const project = await projectRepository.updateEngagementFields({ customer: input.customer, ownerId: input.ownerId, projectId, tenantId, user });
  return { ok: true, project };
}

export async function closeEngagementForUser({ projectId, projectRepository, user, workspaceModulesRepository }) {
  const tenantId = await requireConsulting(workspaceModulesRepository, user);
  await requireDecisionRights({ projectId, repository: projectRepository, tenantId, user });
  return { ok: true, project: await projectRepository.closeEngagement({ projectId, tenantId, user }) };
}

export async function reopenEngagementForUser({ projectId, projectRepository, user, workspaceModulesRepository }) {
  const tenantId = await requireConsulting(workspaceModulesRepository, user);
  await requireDecisionRights({ projectId, repository: projectRepository, tenantId, user });
  return { ok: true, project: await projectRepository.reopenEngagement({ projectId, tenantId, user }) };
}
