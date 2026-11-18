import JSZip from 'jszip';

import { getTenantMembership, PROJECT_CAPABILITIES, requireProjectCapability } from '../../lib/auth/project-capabilities.js';
import { projectStanding } from '../../lib/auth/project-standing.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { assertRecordsNotHeld } from '../compliance/legal-hold.js';
import { canDeleteProject } from './project-deletion.service.js';
import { buildOperationLogContext, logBackendError } from '../../lib/logging/backend-logger.js';
import { PROJECT_KIND_ENGAGEMENT } from '../../lib/projects/project-kind.js';
import { BOARD_SCOPE_DELIVERY, BOARD_SCOPE_PURSUIT, isPursuitItem, onlyPursuitWork, readsPursuitWork, withoutPursuitWork } from '../../lib/projects/pursuit.js';
import { nameOutsideAssignees } from '../pursuit/pursuit-visibility.js';
import { cascadeStoryCompletion } from '../../lib/projects/work-progress.js';
import { recordWorkCompletionMetrics } from '../metrics/work-completion-metrics.js';
import { applyProjectTemplate, applyWorkItemTemplateDefaults, planProjectTemplate, planWorkItemTemplate } from '../workflows/template-application.js';
import { ensureTicketWorkflowBinding } from '../workflows/ticket-workflow.js';
import { emailTicketIntakeLink, presentTicketIntakeInvitation } from './ticket-intake-mail.js';
import { externalTicketSource, ticketReviewFingerprint } from './ticket-review-classifier.js';
import { prepareWorkflowProjectMutation, recordWorkflowTransitions } from '../workflows/workflows.service.js';
import { canEditWorkItemRelations, listDescribedWorkItemRelations } from './work-item-relations.js';

function getPrimaryTenantId(user) {
  return user.memberships?.[0]?.tenantId ?? null;
}

function requirePrimaryTenantId(user) {
  const tenantId = getPrimaryTenantId(user);

  if (!tenantId) {
    throw new HttpError(403, 'This account is not assigned to a tenant.');
  }

  return tenantId;
}

function requireTenantAdmin(user) {
  const tenantId = requirePrimaryTenantId(user);
  const membership = user.memberships?.find((item) => item.tenantId === tenantId) ?? user.memberships?.[0] ?? null;

  if (membership?.role !== 'admin') {
    throw new HttpError(403, 'Tenant admin access is required.');
  }

  return tenantId;
}

function cloneProjectValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function findProjectItemContext(project, itemId) {
  for (const [epicIndex, epic] of (project?.epics ?? []).entries()) {
    if (epic.id === itemId) return { collection: project.epics, index: epicIndex, itemType: 'epic', node: epic, parentId: null };
    for (const [storyIndex, story] of (epic.stories ?? []).entries()) {
      if (story.id === itemId) return { collection: epic.stories, index: storyIndex, itemType: 'story', node: story, parentId: epic.id };
      for (const [taskIndex, task] of (story.tasks ?? []).entries()) {
        if (task.id === itemId) return { collection: story.tasks, index: taskIndex, itemType: 'task', node: task, parentId: story.id };
      }
    }
  }
  for (const [ticketIndex, ticket] of (project?.tickets ?? []).entries()) {
    if (ticket.id === itemId) return { collection: project.tickets, index: ticketIndex, itemType: 'ticket', node: ticket, parentId: ticket.parentId ?? null };
  }
  return null;
}

function projectItemCollection(project, itemType, parentId) {
  if (itemType === 'epic') return project.epics;
  if (itemType === 'ticket') {
    // Tickets are a flat project-level collection; parentId is a reference, not containment.
    if (parentId) {
      const parent = findProjectItemContext(project, parentId);
      if (!parent || !['epic', 'story', 'task'].includes(parent.itemType)) {
        throw new HttpError(400, 'Tickets require an existing epic, story, or task parent when a parent is set.');
      }
    }
    if (!Array.isArray(project.tickets)) project.tickets = [];
    return project.tickets;
  }
  const parent = findProjectItemContext(project, parentId);
  const requiredType = itemType === 'story' ? 'epic' : 'story';
  if (!parent || parent.itemType !== requiredType) throw new HttpError(400, `Invalid ${requiredType} parent for ${itemType}.`);
  return itemType === 'story' ? parent.node.stories : parent.node.tasks;
}

function previewProjectItemMutation(project, { input, itemId = null, operation, restoreSnapshot = null }) {
  const next = cloneProjectValue(project);
  if (operation === 'create') {
    const collection = projectItemCollection(next, input.itemType, input.parentId ?? null);
    const node = { ...cloneProjectValue(input.item), id: input.item.id ?? 'pending-project-item' };
    if (input.itemType === 'epic') node.stories = [];
    if (input.itemType === 'story') node.tasks = [];
    collection.splice(Math.min(input.position ?? collection.length, collection.length), 0, node);
    return next;
  }
  const context = findProjectItemContext(next, itemId);
  if (operation === 'delete') {
    if (!context) throw new HttpError(404, 'Project item not found.');
    context.collection.splice(context.index, 1);
    return next;
  }
  if (operation === 'restore') {
    if (context) context.collection.splice(context.index, 1);
    const snapshot = cloneProjectValue(restoreSnapshot);
    const collection = projectItemCollection(next, snapshot.itemType, snapshot.parentId ?? null);
    const node = { ...snapshot.node };
    if (snapshot.itemType === 'epic') node.stories = context?.node?.stories ?? [];
    if (snapshot.itemType === 'story') node.tasks = context?.node?.tasks ?? [];
    collection.splice(Math.min(snapshot.position ?? collection.length, collection.length), 0, node);
    return next;
  }
  if (!context) throw new HttpError(404, 'Project item not found.');
  const children = context.itemType === 'epic' ? context.node.stories : context.itemType === 'story' ? context.node.tasks : null;
  const node = { ...context.node, ...(input.patch ?? {}) };
  if (children) node[context.itemType === 'epic' ? 'stories' : 'tasks'] = children;
  context.collection[context.index] = node;
  const nextParentId = input.parentId === undefined ? context.parentId : input.parentId;
  const nextCollection = projectItemCollection(next, context.itemType, nextParentId ?? null);
  if (nextCollection !== context.collection) {
    context.collection.splice(context.collection.indexOf(node), 1);
    nextCollection.splice(Math.min(input.position ?? nextCollection.length, nextCollection.length), 0, node);
  } else if (input.position !== undefined) {
    const currentIndex = nextCollection.indexOf(node);
    nextCollection.splice(currentIndex, 1);
    nextCollection.splice(Math.min(input.position, nextCollection.length), 0, node);
  }
  return next;
}

async function requireProjectAccessForUser(user, projectId, repository, capability) {
  const tenantId = requirePrimaryTenantId(user);
  await requireProjectCapability({ capability, projectId, repository, tenantId, user });
  return tenantId;
}

function isoDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function safeArchiveName(value = 'project') {
  return String(value || 'project')
    .replace(/[^A-Za-z0-9_\-]/g, '_')
    .slice(0, 80) || 'project';
}

async function parseProjectArchive(base64OdinProject, user, operation) {
  const base64 = String(base64OdinProject ?? '').trim();

  if (!base64) {
    throw new HttpError(400, 'base64OdinProject is required');
  }

  try {
    const bytes = Buffer.from(base64, 'base64');
    const zip = await JSZip.loadAsync(bytes);
    const jsonFile = zip.file('project.json');
    if (!jsonFile) {
      throw new Error('project.json missing from archive');
    }

    return {
      archiveData: JSON.parse(await jsonFile.async('string')),
      zip,
    };
  } catch (error) {
    logBackendError({
      context: buildOperationLogContext(operation, {
        archiveLength: base64.length,
        tenantId: getPrimaryTenantId(user),
        userId: user?.id ?? null,
      }),
      error,
      level: 'warn',
      message: 'Project archive payload could not be parsed.',
    });
    throw new HttpError(400, error?.message ?? 'Invalid project archive.');
  }
}

async function extractVaultFiles(zip, archiveData) {
  const files = Array.isArray(archiveData?.files) ? archiveData.files : [];
  const vaultFiles = new Map();

  for (const file of files) {
    const fileId = String(file?.id ?? '').trim();
    if (!fileId) {
      continue;
    }

    const entry = zip.file(`vault/${fileId}`);
    if (!entry) {
      throw new HttpError(400, `Vault file ${fileId} missing from archive.`);
    }
    vaultFiles.set(fileId, await entry.async('nodebuffer'));
  }

  // Earlier versions, in archives made since files had them.
  for (const version of Array.isArray(archiveData?.fileVersions) ? archiveData.fileVersions : []) {
    const versionId = String(version?.id ?? '').trim();
    const entry = versionId ? zip.file(`vault-versions/${versionId}`) : null;
    if (!entry) {
      throw new HttpError(400, `Vault file version ${versionId} missing from archive.`);
    }
    vaultFiles.set(versionId, await entry.async('nodebuffer'));
  }

  return vaultFiles;
}

function logProjectsRepositoryFailure({ error, operation, projectId = null, sprintId = null, storyId = null, user, extra = {} }) {
  logBackendError({
    context: buildOperationLogContext(operation, {
      projectId,
      sprintId,
      storyId,
      tenantId: getPrimaryTenantId(user),
      userId: user?.id ?? null,
      ...extra,
    }),
    error,
    level: 'warn',
    message: 'Projects repository operation failed.',
  });
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeAssistantBriefText(value = '') {
  return String(value ?? '').trim();
}

function normalizeAssistantBriefList(values = []) {
  return [...new Set((values ?? []).map((value) => String(value ?? '').trim()).filter(Boolean))];
}

function buildEditableAssistantBrief(existing = {}, input = {}) {
  return {
    ...existing,
    assumptions: normalizeAssistantBriefList(input.assumptions ?? []),
    benefits: normalizeAssistantBriefText(input.benefits),
    constraints: normalizeAssistantBriefList(input.constraints ?? []),
    currentState: normalizeAssistantBriefText(input.currentState),
    dependencies: normalizeAssistantBriefList(input.dependencies ?? []),
    implementationEffort: normalizeAssistantBriefText(input.implementationEffort),
    name: normalizeAssistantBriefText(input.name),
    objective: normalizeAssistantBriefText(input.objective),
    proposedSolution: normalizeAssistantBriefText(input.proposedSolution),
    requirements: normalizeAssistantBriefList(input.requirements ?? []),
    stakeholders: normalizeAssistantBriefList(input.stakeholders ?? []),
    successMetrics: normalizeAssistantBriefList(input.successMetrics ?? []),
  };
}

// Delivery projects; engagements too with includeEngagements (the caller checks the module).
export async function listProjectsForUser(user, repository, { includeEngagements = false } = {}) {
  const tenantId = requirePrimaryTenantId(user);

  return {
    ok: true,
    projects: await repository.listProjectsForTenant({
      includeEngagements,
      tenantId,
      user,
    }),
  };
}

export async function getProjectForUser(user, projectId, repository, assistantRepository = null, { pursuit = 'none' } = {}) {
  const tenantId = requirePrimaryTenantId(user);

  const access = await requireProjectCapability({
    capability: PROJECT_CAPABILITIES.READ,
    projectId,
    repository,
    tenantId,
    user,
  });

  // Pursuit work only when asked for (readsPursuitWork in lib/projects/pursuit.js).
  const loaded = await repository.getProjectDetail({
    includePursuit: pursuit !== 'none',
    projectId,
    tenantId,
  });

  if (!loaded) {
    throw new HttpError(404, 'Project not found.');
  }
  let project = pursuit === 'none' || readsPursuitWork(pursuit, loaded.kind) ? loaded : withoutPursuitWork(loaded);
  // Pursuit tasks assigned to a guest or stakeholder carry their name, as on the pursuit board.
  if (pursuit !== 'none' && assistantRepository?.listProjectStakeholders) {
    project = nameOutsideAssignees(project, await assistantRepository.listProjectStakeholders({ projectId, tenantId }));
  }

  const assistantState = assistantRepository?.getProjectAssistantState
    ? await assistantRepository.getProjectAssistantState({ projectId, tenantId })
    : null;

  const tenantRole = getTenantMembership(user, tenantId)?.role;
  return {
    ok: true,
    permissions: {
      canDelete: canDeleteProject({ projectRole: access?.projectRole, tenantRole }),
      ...projectStanding({ projectRole: access?.projectRole, tenantRole, userCapabilities: user.capabilities }),
    },
    project: assistantState ? { ...project, assistantState } : project,
  };
}

export async function exportProjectArchiveForUser(user, projectId, repository, assistantRepository = null) {
  const tenantId = requireTenantAdmin(user);

  if (!repository.exportProjectArchiveData) {
    throw new HttpError(400, 'Project export requires a database or archive-capable repository.');
  }

  const archiveData = await repository.exportProjectArchiveData({
    projectId,
    tenantId,
  });

  if (!archiveData) {
    throw new HttpError(404, 'Project not found.');
  }

  if (assistantRepository?.getProjectAssistantState) {
    archiveData.assistantProjectState = await assistantRepository.getProjectAssistantState({
      projectId,
      tenantId,
    });
  }

  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(archiveData, null, 2));

  for (const file of archiveData.files ?? []) {
    if (file?.id && file?.contentsBase64) {
      zip.file(`vault/${file.id}`, Buffer.from(file.contentsBase64, 'base64'));
      delete file.contentsBase64;
    }
  }

  for (const version of archiveData.fileVersions ?? []) {
    if (version?.id && version?.contentsBase64) {
      zip.file(`vault-versions/${version.id}`, Buffer.from(version.contentsBase64, 'base64'));
      delete version.contentsBase64;
    }
  }

  zip.file('project.json', JSON.stringify(archiveData, null, 2));

  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  const filename = `${safeArchiveName(archiveData.project?.name)}.project.${isoDateOnly(new Date())}.odin-project`;

  return {
    base64OdinProject: Buffer.from(bytes).toString('base64'),
    filename,
    ok: true,
  };
}

export async function inspectProjectArchiveForUser(user, input, repository) {
  const tenantId = requireTenantAdmin(user);

  if (!repository.inspectProjectArchiveData) {
    throw new HttpError(400, 'Project import requires a database or archive-capable repository.');
  }

  const { archiveData } = await parseProjectArchive(input?.base64OdinProject, user, 'projects.inspectArchive');
  const result = await repository.inspectProjectArchiveData({
    archiveData,
    tenantId,
  });

  return {
    ok: true,
    ...result,
  };
}

export async function importProjectArchiveForUser(user, input, repository, assistantRepository = null, complianceRepository = null) {
  const tenantId = requireTenantAdmin(user);

  if (!repository.importProjectArchiveData) {
    throw new HttpError(400, 'Project import requires a database or archive-capable repository.');
  }

  const { archiveData, zip } = await parseProjectArchive(input?.base64OdinProject, user, 'projects.importArchive');
  if ((input?.overwriteMode ?? 'none') !== 'none') {
    const inspection = await repository.inspectProjectArchiveData({ archiveData, tenantId });
    const resources = inspection.conflicts
      .filter((conflict) => conflict.type === 'project' || conflict.type === 'file')
      .map((conflict) => ({ resourceId: conflict.id, resourceType: conflict.type }));
    if (resources.length) await assertRecordsNotHeld({ repository: complianceRepository, resources, tenantId });
  }
  const vaultFiles = await extractVaultFiles(zip, archiveData);

  const result = await repository.importProjectArchiveData({
    archiveData,
    assistantRepository,
    tenantId,
    user,
    overwriteMode: input?.overwriteMode ?? 'none',
    userMappings: input?.userMappings ?? [],
    vaultFiles,
  });

  return {
    ok: true,
    ...result,
  };
}

export async function createProjectForUser(user, input, repository, workflowRepository = null) {
  const tenantId = requirePrimaryTenantId(user);
  const { templateId = null, ...projectInput } = input;
  const templatePlan = templateId
    ? await planProjectTemplate({ projectInput, templateId, tenantId, user, workflowRepository })
    : null;
  let project;

  try {
    project = await repository.createProject({
      input: projectInput,
      tenantId,
      user,
    });
  } catch (error) {
    logProjectsRepositoryFailure({
      error,
      extra: {
        projectName: input.name ?? null,
        status: input.status ?? null,
      },
      operation: 'projects.createProject',
      user,
    });
    throw error;
  }

  // A template that cannot be applied removes the new project again before rethrowing.
  if (templatePlan) {
    project = await applyProjectTemplate({ plan: templatePlan, project, projectRepository: repository, tenantId, user, workflowRepository });
  }

  // A new project gets the default ticket lifecycle without manual configuration.
  // A binding failure must not fail project creation, since tickets are optional.
  if (project?.id) {
    try {
      await ensureTicketWorkflowBinding({ projectId: project.id, repository: workflowRepository, tenantId });
    } catch (error) {
      logProjectsRepositoryFailure({
        error,
        extra: { projectId: project.id },
        operation: 'projects.ensureTicketWorkflowBinding',
        user,
      });
    }
  }

  return {
    ok: true,
    project,
  };
}

export async function updateProjectForUser(user, projectId, input, repository, workflowRepository = null) {
  const tenantId = requirePrimaryTenantId(user);
  let project;

  await requireProjectCapability({
    capability: PROJECT_CAPABILITIES.PLAN_EDIT,
    projectId,
    repository,
    tenantId,
    user,
  });

  const workflowPlan = await prepareWorkflowProjectMutation({
    input,
    mode: 'project',
    projectId,
    projectRepository: repository,
    user,
    workflowRepository,
  });

  try {
    project = await repository.updateProject({
      input,
      projectId,
      tenantId,
      user,
    });
  } catch (error) {
    logProjectsRepositoryFailure({
      error,
      extra: {
        projectName: input.name ?? null,
        status: input.status ?? null,
      },
      operation: 'projects.updateProject',
      projectId,
      user,
    });
    throw error;
  }

  if (!project) {
    throw new HttpError(404, 'Project not found.');
  }

  await recordWorkflowTransitions(workflowRepository, workflowPlan.transitions);

  return {
    ok: true,
    project,
  };
}

export async function updateProjectAssistantBriefForUser(
  user,
  projectId,
  input,
  repository,
  assistantRepository,
) {
  const tenantId = requirePrimaryTenantId(user);
  await requireProjectCapability({
    capability: PROJECT_CAPABILITIES.PLAN_EDIT,
    projectId,
    repository,
    tenantId,
    user,
  });
  const project = await repository.getProjectDetail({
    projectId,
    tenantId,
  });

  if (!project) {
    throw new HttpError(404, 'Project not found.');
  }

  if (!assistantRepository?.getProjectAssistantState || !assistantRepository?.saveProjectAssistantState) {
    throw new HttpError(500, 'Project assistant brief storage is unavailable.');
  }

  const existingAssistantState = input.patch ? null : await assistantRepository.getProjectAssistantState({
    projectId,
    tenantId,
  });
  const assistantState = await assistantRepository.saveProjectAssistantState({
    projectId,
    tenantId,
    ...(input.patch ? { briefUpdate: input } : {}),
    value: {
      ...(!input.patch ? { brief: buildEditableAssistantBrief(existingAssistantState?.brief ?? {}, input) } : {}),
      updatedAt: nowIso(),
    },
  });

  return {
    ok: true,
    project: {
      ...project,
      assistantState,
    },
  };
}

export async function saveProjectTreeForUser(user, projectId, input, repository, workflowRepository = null, metricsRepository = null) {
  const tenantId = requirePrimaryTenantId(user);
  let project;

  await requireProjectCapability({
    capability: PROJECT_CAPABILITIES.PLAN_EDIT,
    projectId,
    repository,
    tenantId,
    user,
  });

  const currentProject = await repository.getProjectDetail({ projectId, tenantId });
  if (currentProject) {
    cascadeStoryCompletion(currentProject.epics, input.epics);
  }

  const workflowPlan = await prepareWorkflowProjectMutation({
    input,
    mode: 'tree',
    projectId,
    projectRepository: repository,
    user,
    workflowRepository,
  });

  try {
    project = await repository.replaceProjectTree({
      input,
      projectId,
      tenantId,
      user,
    });
  } catch (error) {
    logProjectsRepositoryFailure({
      error,
      extra: {
        treeItemCount: Array.isArray(input?.items) ? input.items.length : null,
      },
      operation: 'projects.saveTree',
      projectId,
      user,
    });
    throw error;
  }

  if (!project) {
    throw new HttpError(404, 'Project not found.');
  }

  await recordWorkflowTransitions(workflowRepository, workflowPlan.transitions);
  await recordWorkCompletionMetrics({ actorUserId: user.id, after: project, before: currentProject, metricsRepository, projectId, tenantId, workflowRepository });

  return {
    ok: true,
    // The plan saved delivery work only; the pursuit work it kept stays off its screen.
    project: withoutPursuitWork(project),
  };
}

async function mutateProjectItemForUser({ complianceRepository = null, input, itemId = null, metricsRepository = null, notifyTicketStatusChange = null, operation, projectId, repository, user, verifyTicketContent = null, workflowRepository = null }) {
  const tenantId = requirePrimaryTenantId(user);
  await requireProjectCapability({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectId, repository, tenantId, user });
  if (operation === 'delete') await assertRecordsNotHeld({ repository: complianceRepository, resources: [{ resourceId: projectId, resourceType: 'project' }], tenantId });
  // Writes see pursuit work too, so the pursuit board's tasks can be edited like any other.
  const currentProject = await repository.getProjectDetail({ includePursuit: true, projectId, tenantId });
  if (!currentProject) throw new HttpError(404, 'Project not found.');

  let restoreSnapshot = null;
  if (operation === 'restore') {
    const revisions = await repository.listProjectItemRevisions({ itemId, limit: 100, projectId, tenantId });
    const selected = revisions.find((revision) => revision.id === input.revisionId);
    if (!selected) throw new HttpError(404, 'Project item revision not found.');
    restoreSnapshot = input.state === 'before' ? selected.before : selected.after;
    if (!restoreSnapshot && input.state === 'after') restoreSnapshot = selected.before;
    if (!restoreSnapshot) throw new HttpError(409, 'This revision has no restorable item state.');
  }
  const result = await writeProjectItemChange({
    currentProject, input, itemId, metricsRepository, operation, projectId, repository, restoreSnapshot, tenantId, user, verifyTicketContent, workflowRepository,
    planTransitions: async (nextProject) => (await prepareWorkflowProjectMutation({
      input: { epics: nextProject.epics, tickets: nextProject.tickets ?? [] }, mode: 'tree', projectId, projectRepository: repository, user, workflowRepository,
    })).transitions,
  });
  const previous = findProjectItemContext(currentProject, itemId);
  if (notifyTicketStatusChange && previous?.itemType === 'ticket' && result.item) {
    await notifyTicketStatusChange({ after: result.item, before: previous.node, projectId, projectName: currentProject.name, tenantId });
  }
  return { ok: true, ...result, project: projectForItemResponse(result.project, [previous?.node, result.item]) };
}

/**
 * The project an item write answers with: the pursuit board's work when the item is pursuit work
 * (before or after the write), else the plan's delivery work, so neither screen gains the other's
 * items from a save.
 */
export function projectForItemResponse(project, nodes) {
  if (!project) return project;
  return nodes.some(isPursuitItem) ? onlyPursuitWork(project) : withoutPursuitWork(project);
}

/**
 * Writes one item change once the caller has settled that `user` may make it. The change is
 * previewed and checked against the project's workflows (`planTransitions` gets the project as
 * it would be after the change), the repository writes it, checking the item's version and
 * recording a revision, and the workflow transitions and completion metrics are recorded.
 * `cascadeStories` lets a story completed here complete its open tasks, as it does in the app;
 * callers that only ever edit tasks turn it off.
 */
export async function writeProjectItemChange({ cascadeStories = true, currentProject, input, itemId = null, metricsRepository = null, operation, planTransitions, projectId, repository, restoreSnapshot = null, tenantId, user, verifyTicketContent = null, workflowRepository = null }) {
  const nextProject = previewProjectItemMutation(currentProject, { input, itemId, operation, restoreSnapshot });
  // The repository completes the open tasks of a story that becomes Completed, so workflow
  // rules check those task transitions as well.
  if (operation === 'update' && cascadeStories) cascadeStoryCompletion(currentProject.epics, nextProject.epics);
  const transitions = await planTransitions(nextProject);
  const method = operation === 'create'
    ? 'createProjectItem'
    : operation === 'update'
      ? 'updateProjectItem'
      : operation === 'delete'
        ? 'deleteProjectItem'
        : 'restoreProjectItemRevision';
  const params = { input, itemId, projectId, tenantId, user };
  if (verifyTicketContent) params.verifyTicketContent = verifyTicketContent;
  if (operation === 'delete') Object.assign(params, { expectedVersion: input.expectedVersion, withoutDependents: input.withoutDependents === true });
  if (operation === 'restore') {
    params.expectedVersion = input.expectedVersion;
    params.revisionId = input.revisionId;
    params.revisionState = input.state;
  }
  const result = await repository[method](params);
  if (!result) throw new HttpError(404, 'Project item not found.');
  await recordWorkflowTransitions(workflowRepository, transitions);
  await recordWorkCompletionMetrics({ actorUserId: user.id, after: result.project, before: currentProject, metricsRepository, projectId, tenantId, workflowRepository });
  return result;
}

export async function createProjectItemForUser(user, projectId, input, repository, workflowRepository = null) {
  const { templateId = null, ...itemInput } = input;
  if (!templateId) return mutateProjectItemForUser({ input: itemInput, operation: 'create', projectId, repository, user, workflowRepository });
  const tenantId = requirePrimaryTenantId(user);
  const plan = await planWorkItemTemplate({ itemType: itemInput.itemType, templateId, tenantId, workflowRepository });
  const result = await mutateProjectItemForUser({ input: itemInput, operation: 'create', projectId, repository, user, workflowRepository });
  return applyWorkItemTemplateDefaults({ plan, projectId, result, tenantId, workflowRepository });
}

// `notifyTicketStatusChange` (ticket-intake-mail.js) tells an intake reporter about a
// status change; every path that can change a ticket's status passes it.
export async function updateProjectItemForUser(user, projectId, itemId, input, repository, workflowRepository = null, notifyTicketStatusChange = null, metricsRepository = null) {
  return mutateProjectItemForUser({ input, itemId, metricsRepository, notifyTicketStatusChange, operation: 'update', projectId, repository, user, workflowRepository });
}

export async function deleteProjectItemForUser(user, projectId, itemId, input, repository, workflowRepository = null, complianceRepository = null) {
  return mutateProjectItemForUser({ complianceRepository, input, itemId, operation: 'delete', projectId, repository, user, workflowRepository });
}

export async function restoreProjectItemForUser(user, projectId, itemId, input, repository, workflowRepository = null, notifyTicketStatusChange = null, metricsRepository = null) {
  return mutateProjectItemForUser({ input, itemId, metricsRepository, notifyTicketStatusChange, operation: 'restore', projectId, repository, user, workflowRepository });
}

// Cross-project ticket listing. Authorization resolves through each owning
// project exactly as it does for other work items, so no tenant-level rule is needed.
export async function listTicketsForUser(user, input, repository) {
  const tenantId = requirePrimaryTenantId(user);
  return {
    ok: true,
    ...await repository.listTickets({ filters: input, tenantId, user }),
  };
}

export async function listProjectTicketsForUser(user, projectId, input, repository) {
  const tenantId = requirePrimaryTenantId(user);
  await requireProjectCapability({ capability: PROJECT_CAPABILITIES.READ, projectId, repository, tenantId, user });
  return {
    ok: true,
    ...await repository.listTickets({ filters: { ...input, projectIds: [projectId] }, tenantId, user }),
  };
}

export async function listWorkItemRelationsForUser(user, projectId, itemId, repository) {
  const tenantId = requirePrimaryTenantId(user);
  const access = await requireProjectCapability({ capability: PROJECT_CAPABILITIES.READ, projectId, repository, tenantId, user });
  return {
    canEdit: canEditWorkItemRelations({ access, tenantId, user }),
    ok: true,
    relations: await listDescribedWorkItemRelations({ itemId, projectId, repository, tenantId }),
  };
}

// Every relation in a project (from, to, type), for queries across the whole project.
export async function listProjectWorkItemRelationsForUser(user, projectId, repository) {
  const tenantId = requirePrimaryTenantId(user);
  await requireProjectCapability({ capability: PROJECT_CAPABILITIES.READ, projectId, repository, tenantId, user });
  const relations = await repository.listWorkItemRelations({ itemId: null, projectId, tenantId });
  return { ok: true, relations: relations.map(({ createdAt, fromItemId, id, relationType, toItemId }) => ({ createdAt, fromItemId, id, relationType, toItemId })) };
}

export async function createWorkItemRelationForUser(user, projectId, itemId, input, repository) {
  const tenantId = requirePrimaryTenantId(user);
  await requireProjectCapability({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectId, repository, tenantId, user });
  const saved = await repository.createWorkItemRelation({ input, itemId, projectId, tenantId, user });
  if (!saved) throw new HttpError(404, 'Project not found.');
  // created is false when the same link was already there.
  return { created: saved.created, ok: true, relation: saved.relation };
}

export async function deleteWorkItemRelationForUser(user, projectId, relationId, repository) {
  const tenantId = requirePrimaryTenantId(user);
  await requireProjectCapability({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectId, repository, tenantId, user });
  const deleted = await repository.deleteWorkItemRelation({ projectId, relationId, tenantId, user });
  if (!deleted) throw new HttpError(404, 'Work item relation not found.');
  return { ok: true };
}

// Intake invitations. Creating one is a project-configuration act, so it needs
// the same plan-edit capability as other project configuration.
// The link is emailed to the reporter on create; `email` reports whether that was queued,
// and the URL is returned either way so the creator can copy it.
export async function createTicketIntakeInvitationForUser(user, projectId, input, repository, { frontendAppUrl = '', mailRepository = null } = {}) {
  const tenantId = requirePrimaryTenantId(user);
  await requireProjectCapability({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectId, repository, tenantId, user });
  const invitation = await repository.createTicketIntakeInvitation({ input, projectId, tenantId, user });
  if (!invitation) throw new HttpError(404, 'Project not found.');
  const project = await repository.getProjectDetail({ projectId, tenantId });
  const email = await emailTicketIntakeLink({ frontendAppUrl, invitation, mailRepository, projectName: project?.name ?? '', user });
  const presented = presentTicketIntakeInvitation(invitation, frontendAppUrl);
  return { email, invitation: presented, ok: true, url: presented.url };
}

export async function listTicketIntakeInvitationsForUser(user, projectId, repository, { frontendAppUrl = '' } = {}) {
  const tenantId = requirePrimaryTenantId(user);
  await requireProjectCapability({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectId, repository, tenantId, user });
  const invitations = await repository.listTicketIntakeInvitations({ projectId, tenantId });
  return { invitations: invitations.map((invitation) => presentTicketIntakeInvitation(invitation, frontendAppUrl)), ok: true };
}

export async function revokeTicketIntakeInvitationForUser(user, projectId, invitationId, repository) {
  const tenantId = requirePrimaryTenantId(user);
  await requireProjectCapability({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectId, repository, tenantId, user });
  const revoked = await repository.revokeTicketIntakeInvitation({ invitationId, projectId, tenantId });
  if (!revoked) throw new HttpError(404, 'Intake invitation not found.');
  return { ok: true };
}

const ticketTarget = ({ projectId, tenantId, ticketId }) => ({ projectId, targetId: ticketId, targetType: 'ticket', tenantId });
// A listed file's contents, for the check to read the files agents could read.
const ticketFileReader = (repository, tenantId) => async (file) => (await repository.getFileAsset?.({ fileId: file.id, tenantId }))?.bytes ?? null;

// An agent validates a ticket from outside the team only when Odin's automated check finds its
// current content safe. The check runs before the write; the write re-reads the ticket,
// its comments and its attachments and refuses if any of it differs from what was checked, so a
// reply or file that lands meanwhile never becomes visible to agents unchecked. Errors name the
// safety label only, never the content.
// A submission arrives in parts: intake saves the ticket before its scanned attachments, and Bug
// Reporter uploads files in calls of their own. An agent waits until nothing on the ticket is newer
// than this, so it never validates a ticket whose files are still on their way.
export const AGENT_VALIDATION_SETTLE_MS = 5 * 60_000;
const STILL_ARRIVING = () => new HttpError(409, 'This ticket, its comments or its files changed in the last few minutes, and its submission may still be arriving. Check it again later.', { details: { code: 'still_arriving' } });
function newestOf(content) {
  const stamps = [];
  const add = (record) => { for (const key of ['createdAt', 'updatedAt']) if (record?.[key]) stamps.push(Date.parse(record[key])); };
  const walk = (comments = []) => { for (const comment of comments) { add(comment); walk(comment.children); } };
  add(content.ticket);
  walk(content.comments ?? []);
  for (const file of content.attachments ?? []) add(file);
  return Math.max(...stamps.filter(Number.isFinite), 0);
}

async function agentValidationCheck({ classifier, now, projectId, repository, reviewState, settleMs, tenantId, ticket }) {
  if (reviewState !== 'pending') throw new HttpError(409, `This ticket was ${reviewState}, so only a person can validate it.`, { details: { code: 'needs_person' } });
  if (now() - newestOf({ ticket }) < settleMs) throw STILL_ARRIVING();
  const target = ticketTarget({ projectId, tenantId, ticketId: ticket.id });
  const classification = (await classifier?.classify({
    attachments: async () => (await repository.listFiles?.(target)) ?? [],
    comments: async () => (await repository.listComments?.(target)) ?? [],
    projectId,
    readFile: ticketFileReader(repository, tenantId),
    tenantId,
    ticket,
  })) ?? null;
  if (classification?.safety !== 'safe') {
    const reason = classification ? `Odin's automated check did not find this ticket safe (safety: ${classification.safety})` : 'Odin could not check this ticket automatically';
    throw new HttpError(409, `${reason}, so an agent cannot validate it. A person needs to review it.`, { details: { code: 'needs_person' } });
  }
  return (content) => {
    if (ticketReviewFingerprint(content) !== classification.fingerprint) {
      throw new HttpError(409, 'The ticket, its comments or its attachments changed while Odin checked it. Run the check again.', { details: { code: 'content_changed' } });
    }
    if (now() - newestOf(content) < settleMs) throw STILL_ARRIVING();
  };
}

// External review gate. Marking a ticket validated or rejected controls whether
// the assistant may see it; it never affects scheduling, assignment, or board presence.
// agentCheck marks an agent's decision (the route sets it for every MCP credential): validating
// then needs the automated check, while rejecting never does.
export async function decideTicketReviewForUser(user, projectId, itemId, input, repository, workflowRepository = null, { agentCheck = false, classifier = null, now = () => Date.now(), settleMs = AGENT_VALIDATION_SETTLE_MS } = {}) {
  const tenantId = requirePrimaryTenantId(user);
  await requireProjectCapability({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectId, repository, tenantId, user });

  const project = await repository.getProjectDetail({ projectId, tenantId });
  if (!project) throw new HttpError(404, 'Project not found.');

  const context = findProjectItemContext(project, itemId);
  if (!context || context.itemType !== 'ticket') throw new HttpError(404, 'Ticket not found.');
  const reviewState = String(context.node.externalReviewState ?? 'not_external');
  if (reviewState === 'not_external') {
    throw new HttpError(409, 'Only externally submitted tickets require review.');
  }
  const verifyTicketContent = agentCheck && input.state === 'validated' && reviewState !== 'validated'
    ? await agentValidationCheck({ classifier, now, projectId, repository, reviewState, settleMs, tenantId, ticket: context.node })
    : null;

  return mutateProjectItemForUser({
    input: { expectedVersion: input.expectedVersion, patch: { externalReviewState: input.state } },
    itemId,
    operation: 'update',
    projectId,
    repository,
    user,
    verifyTicketContent,
    workflowRepository,
  });
}

export async function listTicketReviewQueueForUser(user, input, repository) {
  const tenantId = requirePrimaryTenantId(user);
  const projects = await repository.listProjectsForTenant({ tenantId, user });
  const scoped = input.projectId ? projects.filter((project) => project.id === input.projectId) : projects;
  const pending = [];

  for (const summary of scoped) {
    const project = await repository.getProjectDetail({ projectId: summary.id, tenantId });
    for (const ticket of project?.tickets ?? []) {
      if (String(ticket.externalReviewState ?? 'not_external') !== 'pending') continue;
      pending.push({ ...ticket, projectId: summary.id, projectName: summary.name });
      if (pending.length >= input.limit) return { ok: true, tickets: pending };
    }
  }

  return { ok: true, tickets: pending };
}

// A project's pending external tickets as an agent may see them: no title, text or
// reporter, only what the ticket review classifier made of each, oldest first. Same access as
// deciding a review.
export async function listTicketsAwaitingReviewForUser(user, projectId, input, repository, classifier = null) {
  const tenantId = requirePrimaryTenantId(user);
  await requireProjectCapability({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectId, repository, tenantId, user });

  const project = await repository.getProjectDetail({ projectId, tenantId });
  if (!project) throw new HttpError(404, 'Project not found.');

  const pending = (project.tickets ?? [])
    .filter((ticket) => String(ticket.externalReviewState ?? 'not_external') === 'pending' && (!input.itemId || ticket.id === input.itemId))
    .sort((left, right) => String(left.updatedAt ?? '').localeCompare(String(right.updatedAt ?? '')) || String(left.id).localeCompare(String(right.id)));
  const page = pending.slice(0, input.limit);
  const target = (ticket) => ticketTarget({ projectId, tenantId, ticketId: ticket.id });
  const attachmentsFor = async (ticket) => (await repository.listFiles?.(target(ticket))) ?? [];
  const commentsFor = async (ticket) => (await repository.listComments?.(target(ticket))) ?? [];
  const classifications = classifier ? await classifier.classifyAll({ attachmentsFor, commentsFor, projectId, readFile: ticketFileReader(repository, tenantId), tenantId, tickets: page }) : page.map(() => null);

  return {
    ok: true,
    tickets: page.map((ticket, index) => ({
      category: ticket.category ?? 'defect',
      classification: classifications[index],
      id: ticket.id,
      severity: ticket.severity ?? 'S3',
      source: externalTicketSource(ticket),
      updatedAt: ticket.updatedAt ?? null,
      version: Number(ticket.version ?? 1),
    })),
    total: pending.length,
  };
}

export async function listProjectItemRevisionsForUser(user, projectId, itemId, input, repository) {
  const tenantId = await requireProjectAccessForUser(user, projectId, repository, PROJECT_CAPABILITIES.READ);
  return {
    itemId,
    revisions: await repository.listProjectItemRevisions({ itemId, limit: input.limit, projectId, tenantId }),
  };
}

export async function getProjectValidUsersForUser(user, projectId, repository) {
  const tenantId = await requireProjectAccessForUser(user, projectId, repository, PROJECT_CAPABILITIES.PLAN_EDIT);

  const payload = await repository.getValidUsers({
    projectId,
    tenantId,
    user,
  });

  if (!payload) {
    throw new HttpError(404, 'Project not found.');
  }

  return {
    ok: true,
    ...payload,
  };
}

export async function saveProjectPermissionsForUser(user, projectId, input, repository) {
  const tenantId = await requireProjectAccessForUser(user, projectId, repository, PROJECT_CAPABILITIES.ADMIN);
  let result;

  try {
    result = await repository.setProjectPermissions({
      projectId,
      tenantId,
      user,
      validUsers: input.validUsers ?? [],
    });
  } catch (error) {
    logProjectsRepositoryFailure({
      error,
      extra: {
        validUserCount: Array.isArray(input.validUsers) ? input.validUsers.length : 0,
      },
      operation: 'projects.savePermissions',
      projectId,
      user,
    });
    throw error;
  }

  if (!result) {
    throw new HttpError(404, 'Project not found.');
  }

  return {
    ok: true,
    ...result,
  };
}

export async function listProjectSprintsForUser(user, projectId, repository) {
  const tenantId = await requireProjectAccessForUser(user, projectId, repository, PROJECT_CAPABILITIES.READ);
  const payload = await repository.listProjectSprints({
    projectId,
    tenantId,
    user,
  });

  if (!payload) {
    throw new HttpError(404, 'Project not found.');
  }

  return {
    ok: true,
    ...payload,
  };
}

export async function createProjectSprintForUser(user, projectId, input, repository) {
  const tenantId = await requireProjectAccessForUser(user, projectId, repository, PROJECT_CAPABILITIES.PLAN_EDIT);
  let sprint;

  try {
    sprint = await repository.createProjectSprint({
      input,
      projectId,
      tenantId,
      user,
    });
  } catch (error) {
    logProjectsRepositoryFailure({
      error,
      extra: {
        sprintName: input.name ?? null,
      },
      operation: 'projects.createSprint',
      projectId,
      user,
    });
    throw error;
  }

  if (!sprint) {
    throw new HttpError(404, 'Project not found.');
  }

  return {
    ok: true,
    sprint,
  };
}

export async function updateProjectSprintForUser(user, projectId, sprintId, input, repository) {
  const tenantId = await requireProjectAccessForUser(user, projectId, repository, PROJECT_CAPABILITIES.PLAN_EDIT);
  let sprint;

  try {
    sprint = await repository.updateProjectSprint({
      input,
      projectId,
      sprintId,
      tenantId,
      user,
    });
  } catch (error) {
    logProjectsRepositoryFailure({
      error,
      extra: {
        sprintName: input.name ?? null,
      },
      operation: 'projects.updateSprint',
      projectId,
      sprintId,
      user,
    });
    throw error;
  }

  if (!sprint) {
    throw new HttpError(404, 'Sprint not found.');
  }

  return {
    ok: true,
    sprint,
  };
}

export async function activateProjectSprintForUser(user, projectId, sprintId, repository) {
  const tenantId = await requireProjectAccessForUser(user, projectId, repository, PROJECT_CAPABILITIES.PLAN_EDIT);
  let sprint;

  try {
    sprint = await repository.updateProjectSprintStatus({
      projectId,
      sprintId,
      status: 'active',
      tenantId,
      user,
    });
  } catch (error) {
    logProjectsRepositoryFailure({
      error,
      extra: {
        status: 'active',
      },
      operation: 'projects.activateSprint',
      projectId,
      sprintId,
      user,
    });
    throw error;
  }

  if (!sprint) {
    throw new HttpError(404, 'Sprint not found.');
  }

  return {
    ok: true,
    sprint,
  };
}

export async function completeProjectSprintForUser(user, projectId, sprintId, repository) {
  const tenantId = await requireProjectAccessForUser(user, projectId, repository, PROJECT_CAPABILITIES.PLAN_EDIT);
  let sprint;

  try {
    sprint = await repository.updateProjectSprintStatus({
      projectId,
      sprintId,
      status: 'completed',
      tenantId,
      user,
    });
  } catch (error) {
    logProjectsRepositoryFailure({
      error,
      extra: {
        status: 'completed',
      },
      operation: 'projects.completeSprint',
      projectId,
      sprintId,
      user,
    });
    throw error;
  }

  if (!sprint) {
    throw new HttpError(404, 'Sprint not found.');
  }

  return {
    ok: true,
    sprint,
  };
}

export async function saveSprintStaffingForUser(user, projectId, sprintId, input, repository) {
  const tenantId = await requireProjectAccessForUser(user, projectId, repository, PROJECT_CAPABILITIES.PLAN_EDIT);
  let result;

  try {
    result = await repository.saveSprintStaffing({
      projectId,
      sprintId,
      staffing: input.staffing ?? [],
      tenantId,
      user,
    });
  } catch (error) {
    logProjectsRepositoryFailure({
      error,
      extra: {
        staffingCount: Array.isArray(input.staffing) ? input.staffing.length : 0,
      },
      operation: 'projects.saveSprintStaffing',
      projectId,
      sprintId,
      user,
    });
    throw error;
  }

  if (!result) {
    throw new HttpError(404, 'Sprint not found.');
  }

  return {
    ok: true,
    ...result,
  };
}

export async function assignSprintItemsForUser(user, projectId, input, repository) {
  const tenantId = await requireProjectAccessForUser(user, projectId, repository, PROJECT_CAPABILITIES.PLAN_EDIT);
  let project;

  try {
    project = await repository.assignItemsToSprint({
      assignments: input.assignments ?? [],
      projectId,
      tenantId,
      user,
    });
  } catch (error) {
    logProjectsRepositoryFailure({
      error,
      extra: {
        assignmentCount: Array.isArray(input.assignments) ? input.assignments.length : 0,
      },
      operation: 'projects.assignSprintItems',
      projectId,
      user,
    });
    throw error;
  }

  if (!project) {
    throw new HttpError(404, 'Project not found.');
  }

  return {
    ok: true,
    project,
  };
}

export async function splitProjectStoryForUser(user, projectId, storyId, input, repository) {
  const tenantId = await requireProjectAccessForUser(user, projectId, repository, PROJECT_CAPABILITIES.PLAN_EDIT);
  let result;

  try {
    result = await repository.splitStory({
      input,
      projectId,
      storyId,
      tenantId,
      user,
    });
  } catch (error) {
    logProjectsRepositoryFailure({
      error,
      extra: {
        splitCount: Array.isArray(input?.stories) ? input.stories.length : null,
      },
      operation: 'projects.splitStory',
      projectId,
      storyId,
      user,
    });
    throw error;
  }

  if (!result) {
    throw new HttpError(404, 'Story not found.');
  }

  return {
    ok: true,
    ...result,
  };
}

// Which board a kanban request means: the one it names, else an engagement's pursuit board and a
// delivery project's own (src/lib/projects/pursuit.js).
async function resolveBoardScope(repository, projectId, scope) {
  if (scope) return scope;
  const kind = repository.getProjectKind ? await repository.getProjectKind({ projectId }) : null;
  return kind?.kind === PROJECT_KIND_ENGAGEMENT ? BOARD_SCOPE_PURSUIT : BOARD_SCOPE_DELIVERY;
}

export async function getProjectKanbanConfigForUser(user, projectId, repository, { scope = null } = {}) {
  const tenantId = await requireProjectAccessForUser(user, projectId, repository, PROJECT_CAPABILITIES.READ);
  const config = await repository.getKanbanConfig({
    projectId,
    scope: await resolveBoardScope(repository, projectId, scope),
    tenantId,
    user,
  });

  if (!config) {
    throw new HttpError(404, 'Project not found.');
  }

  return {
    ok: true,
    config,
  };
}

export async function saveProjectKanbanConfigForUser(user, projectId, input, repository, { scope = null } = {}) {
  const tenantId = await requireProjectAccessForUser(user, projectId, repository, PROJECT_CAPABILITIES.PLAN_EDIT);
  const boardScope = await resolveBoardScope(repository, projectId, scope);
  let config;

  try {
    config = await repository.saveKanbanConfig({
      config: input,
      projectId,
      scope: boardScope,
      tenantId,
      user,
    });
  } catch (error) {
    logProjectsRepositoryFailure({
      error,
      extra: {
        columnCount: Array.isArray(input?.columns) ? input.columns.length : null,
      },
      operation: 'projects.saveKanbanConfig',
      projectId,
      user,
    });
    throw error;
  }

  if (!config) {
    throw new HttpError(404, 'Project not found.');
  }

  return {
    ok: true,
    config,
  };
}

export async function reorderProjectKanbanItemForUser(user, projectId, input, repository, { scope = null } = {}) {
  const tenantId = await requireProjectAccessForUser(user, projectId, repository, PROJECT_CAPABILITIES.PLAN_EDIT);
  const boardScope = await resolveBoardScope(repository, projectId, scope);
  let reordered;

  try {
    reordered = await repository.reorderKanbanItem({
      afterItemId: input.afterItemId ?? null,
      beforeItemId: input.beforeItemId ?? null,
      itemId: input.itemId,
      projectId,
      scope: boardScope,
      tenantId,
    });
  } catch (error) {
    logProjectsRepositoryFailure({
      error,
      extra: {
        itemId: input.itemId,
      },
      operation: 'projects.reorderKanbanItem',
      projectId,
      user,
    });
    throw error;
  }

  if (!reordered) {
    throw new HttpError(404, 'Board item not found.');
  }

  return {
    ok: true,
  };
}

export async function getProjectKanbanBoardForUser(user, projectId, input, repository) {
  const tenantId = await requireProjectAccessForUser(user, projectId, repository, PROJECT_CAPABILITIES.READ);
  const { scope = null, ...filters } = input ?? {};
  const boardScope = await resolveBoardScope(repository, projectId, scope);
  const board = await repository.getKanbanBoard({
    filters,
    projectId,
    scope: boardScope,
    tenantId,
    user,
  });

  if (!board) {
    throw new HttpError(404, 'Project not found.');
  }

  return {
    ok: true,
    board: { ...board, scope: boardScope },
  };
}
