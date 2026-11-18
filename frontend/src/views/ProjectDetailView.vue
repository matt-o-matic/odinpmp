<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import ProjectKanbanWorkspace from '../components/projects/ProjectKanbanWorkspace.vue';
import ProjectLiveUpdateNotice from '../components/projects/ProjectLiveUpdateNotice.vue';
import ProjectOutlinePane from '../components/projects/ProjectOutlinePane.vue';
import ProjectPlanningEditorModal from '../components/projects/ProjectPlanningEditorModal.vue';
import ProjectCommentsPanel from '../components/projects/ProjectCommentsPanel.vue';
import ProjectDeleteAction from '../components/projects/ProjectDeleteAction.vue';
import ProjectFileTree from '../components/projects/ProjectFileTree.vue';
import ProjectGovernanceWorkspace from '../components/projects/ProjectGovernanceWorkspace.vue';
import ProjectInsightsWorkspace from '../components/projects/insights/ProjectInsightsWorkspace.vue';
import ChannelsWorkspace from '../components/channels/ChannelsWorkspace.vue';
import ProjectBillingPanel from '../components/projects/ProjectBillingPanel.vue';
import { workspaceModules } from '../lib/workspace/index.js';
import PursuitBoardPanel from '../components/pursuit/PursuitBoardPanel.vue';
import PursuitInsightsPanel from '../components/pursuit/PursuitInsightsPanel.vue';
import ProjectTicketsPanel from '../components/projects/ProjectTicketsPanel.vue';
import ProjectResourcesWorkspace from '../components/projects/ProjectResourcesWorkspace.vue';
import { projectAssignees } from '../lib/resources/resources.js';
import ProjectStakeholdersPanel from '../components/projects/ProjectStakeholdersPanel.vue';
import ProjectSplitStoryModal from '../components/projects/ProjectSplitStoryModal.vue';
import ProjectSprintsWorkspace from '../components/projects/ProjectSprintsWorkspace.vue';
import ProjectWorkbenchEditor from '../components/projects/ProjectWorkbenchEditor.vue';
import StoryReassignModal from '../components/projects/StoryReassignModal.vue';
import RequirementsWorkspace from '../components/requirements/RequirementsWorkspace.vue';
import RichContentEditor from '../components/rich-content/RichContentEditor.vue';
import { myItemsBadgeCount } from '../lib/requirements/requirements-my-items.js';
import { apiClient, authSession } from '../lib/auth/index.js';
import { projectContacts } from '../lib/assistant/project-contacts.js';
import { projectStore } from '../lib/projects/index.js';
import {
  closePlanningEditorModal as closePlanningEditorModalState,
  createPlanningEditorModalState,
  openPlanningEditorModal as openPlanningEditorModalState,
  selectPlanningEditorModalItem,
  updatePlanningEditorModalDraftProject,
} from '../lib/projects/project-planning-editor-modal.js';
import { useOverlayScrollLock } from '../lib/ui/overlay-scroll-lock.js';
import { createProjectLiveUpdates, describeLiveUpdateActors } from '../lib/projects/project-live-updates.js';
import { provideProjectRefresh } from '../lib/live/live-refresh.js';
import { mergeProjects } from '../lib/projects/project-merge.js';
import { applyEstimateRollups, usesChildEstimates, watchEstimateRollups } from '../lib/projects/work-estimates.js';
import { projectSelectionForItem } from '../lib/projects/work-item-relations.js';
import {
  cloneProject,
  createEpicDraft,
  createProjectSelection,
  createStoryDraft,
  createTaskDraft,
  normalizeDateValue,
  resolveProjectSelection,
  resolveSelectionCollection,
  serializeProjectMetadata,
  serializeProjectSnapshot,
  serializeProjectTree,
} from '../lib/projects/project-editor.js';
import {
  createEditableProjectBriefState,
  formatProjectBriefListMarkdown,
  parseProjectBriefListMarkdown,
  serializeEditableProjectBrief,
} from '../lib/projects/project-brief.js';

const route = useRoute();
const router = useRouter();
const errorMessage = ref('');
const successMessage = ref('');
const draftProject = ref(null);
const persistedProject = ref(null);
const baselineSnapshot = ref('');
const activeSelection = ref({ type: 'project' });
const collapsedNodes = ref({});
const filterQuery = ref('');
const statusFilters = ref([]);
const resourceFilters = ref([]);
const validUsers = ref([]);
const tenantUsers = ref([]);
// The project's resources (allocations and their profiles). Anyone allocated can own work,
// including people without an Odin login, so pickers offer members plus allocated resources.
const projectTeam = ref(null);
const projectTeamError = ref('');
const assignableUsers = computed(() => projectAssignees(validUsers.value, projectTeam.value));
const validStatusTypes = ref({});
const validTaskTypes = ref({});
const aiAnalysis = ref('');
const aiSuggestion = ref('');
const aiWorking = ref(false);
const aiSuggestionModalOpen = ref(false);
const aiAnalysisModalOpen = ref(false);
const projectSettingsOpen = ref(false);
const projectSettingsTab = ref('details');
const projectExporting = ref(false);
const planningEditorModalState = ref(createPlanningEditorModalState());
const workspaceRefreshVersion = ref(0);
// Files, comments and related work in the item editor and settings reload when it moves.
provideProjectRefresh(workspaceRefreshVersion);
const projectSnapshot = computed(() => (project.value ? serializeProjectSnapshot(project.value) : null));
const storyReassignState = ref({ sourceEpicId: '', storyId: '', storyName: '' });
const splitStoryOpen = ref(false);
const splitStoryTarget = ref(null);
const structureOutlineOpen = ref(false);
const isCompactWorkbench = ref(false);
const overlayScrollLocked = computed(() => {
  return aiSuggestionModalOpen.value
    || aiAnalysisModalOpen.value
    || projectSettingsOpen.value
    || structureOutlineOpen.value;
});
const activeWorkspace = computed(() => {
  if (route.name === 'project-sprints') {
    return 'sprints';
  }

  if (route.name === 'project-kanban') {
    return 'kanban';
  }

  if (route.name === 'project-governance') {
    return 'governance';
  }

  if (route.name === 'project-tickets') {
    return 'tickets';
  }

  if (route.name === 'project-channels') {
    return 'channels';
  }

  if (route.name === 'project-insights') {
    return 'insights';
  }

  if (route.name === 'project-pursuit') {
    return 'pursuit';
  }

  if (route.name === 'project-resources') {
    return 'resources';
  }

  if (route.name === 'project-billing') {
    return 'billing';
  }

  if (String(route.name ?? '').startsWith('project-requirements')) {
    return 'requirements';
  }

  return 'structure';
});
// Count on the Requirements tab: everything waiting on the signed-in person there.
const requirementsBadgeCount = ref(0);

function setRequirementsCounts(payload) {
  requirementsBadgeCount.value = myItemsBadgeCount(payload);
}

async function loadRequirementsCounts(projectId) {
  if (!projectId || !authSession.state.token) {
    requirementsBadgeCount.value = 0;
    return;
  }

  try {
    setRequirementsCounts(await apiClient.passive.getRequirementsMyItems(projectId, authSession.state.token));
  } catch {
    requirementsBadgeCount.value = 0;
  }
}

const projectStatusOptions = ['Planned', 'In Progress', 'At Risk', 'Review', 'Completed', 'Archived'];
const workStatusOptions = ['Not Started', 'In Progress', 'At Risk', 'Review', 'Completed'];
const PROJECT_SETTINGS_TABS = new Set(['details', 'comments', 'files', 'stakeholders']);
const PROJECT_BRIEF_LIST_FIELDS = ['stakeholders', 'requirements', 'dependencies', 'constraints', 'successMetrics', 'assumptions'];

function normalizeProjectSettingsTab(value) {
  const normalizedValue = String(value ?? '').trim().toLowerCase();
  return PROJECT_SETTINGS_TABS.has(normalizedValue) ? normalizedValue : 'details';
}

function normalizeNullableNumberField(value) {
  if (value === '' || value == null) {
    return null;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function hasPlanningNumber(value) {
  return value !== '' && value != null && Number.isFinite(Number(value));
}

function pointsForEstimatedHours(value) {
  if (!hasPlanningNumber(value)) {
    return null;
  }

  const hours = Number(value);
  if (hours <= 8) return 1;
  if (hours <= 16) return 2;
  if (hours <= 24) return 3;
  if (hours <= 40) return 5;
  if (hours <= 80) return 10;
  return null;
}

function maxHoursForStoryPoints(value) {
  if (!hasPlanningNumber(value)) {
    return null;
  }

  switch (Number(value)) {
    case 1:
      return 8;
    case 2:
      return 16;
    case 3:
      return 24;
    case 5:
      return 40;
    case 10:
      return 80;
    default:
      return null;
  }
}

function normalizeWorkItemPlanningFields(item) {
  if (!item || typeof item !== 'object') {
    return;
  }

  for (const child of item.stories ?? []) {
    normalizeWorkItemPlanningFields(child);
  }

  for (const child of item.tasks ?? []) {
    normalizeWorkItemPlanningFields(child);
  }

  const hadDirectPlanning = hasPlanningNumber(item.points)
    || hasPlanningNumber(item.targetHourEstimate)
    || Boolean(item.targetStartDate)
    || Boolean(item.targetEndDate)
    || Boolean(item.assigneeId)
    || Boolean(item.assigneeName);
  const priority = Number(item.priority);
  item.priority = Number.isFinite(priority) && priority >= 1 && priority <= 7 ? priority : 4;
  if (item.priority === 1 && !hadDirectPlanning) {
    item.priority = 4;
  }

  item.points = normalizeNullableNumberField(item.points);
  item.targetHourEstimate = normalizeNullableNumberField(item.targetHourEstimate);
  item.targetStartDate = normalizeDateValue(item.targetStartDate);
  item.targetEndDate = normalizeDateValue(item.targetEndDate);

  // Items with children take their estimate from them (applyEstimateRollups). Only an
  // estimate entered by hand fills a missing points or hours value from the scale.
  if (usesChildEstimates(item)) {
    return;
  }

  if (!hasPlanningNumber(item.points)) {
    item.points = pointsForEstimatedHours(item.targetHourEstimate);
  }

  if (!hasPlanningNumber(item.targetHourEstimate)) {
    item.targetHourEstimate = maxHoursForStoryPoints(item.points);
  }
}

function normalizeProjectDetailState(project) {
  if (!project || typeof project !== 'object') {
    return project;
  }

  for (const epic of project.epics ?? []) {
    normalizeWorkItemPlanningFields(epic);
  }
  applyEstimateRollups(project);

  return {
    ...project,
    assistantState: {
      ...(project.assistantState ?? {}),
      brief: createEditableProjectBriefState(project.assistantState?.brief ?? {}),
    },
  };
}

function serializeProjectDetailSnapshot(project) {
  if (!project) {
    return null;
  }

  return {
    assistantBrief: serializeEditableProjectBrief(project.assistantState?.brief ?? {}),
    metadata: serializeProjectMetadata(project),
    tree: serializeProjectTree(project),
  };
}

function createProjectBriefListEditorState(brief = {}) {
  return Object.fromEntries(
    PROJECT_BRIEF_LIST_FIELDS.map((field) => [
      field,
      formatProjectBriefListMarkdown(brief?.[field] ?? []),
    ]),
  );
}

function setProjectState(project) {
  const normalizedProject = normalizeProjectDetailState(cloneProject(project));
  persistedProject.value = normalizedProject;
  draftProject.value = cloneProject(normalizedProject);
  projectBriefListDrafts.value = createProjectBriefListEditorState(normalizedProject.assistantState?.brief ?? {});
  baselineSnapshot.value = JSON.stringify(serializeProjectDetailSnapshot(normalizedProject));
  activeSelection.value = resolveProjectSelection(normalizedProject, activeSelection.value).selection;
}

function normalizeGeneratedNodes(nodes = []) {
  for (const node of nodes ?? []) {
    if (node?.aiGenerated === true && node.aiAccepted == null) {
      node.aiAccepted = false;
    }

    normalizeGeneratedNodes(node?.stories);
    normalizeGeneratedNodes(node?.tasks);
  }
}

// `quiet` reloads after someone else's change: in the background, keeping what is shown on failure.
async function loadValidUsers(projectId, { quiet = false } = {}) {
  if (!projectId || !authSession.state.token) {
    return;
  }

  try {
    const result = await (quiet ? apiClient.passive : apiClient).getProjectValidUsers(projectId, authSession.state.token);
    if (quiet && projectId !== project.value?.id) return;
    validUsers.value = Array.isArray(result.project_users) ? result.project_users : [];
    tenantUsers.value = Array.isArray(result.tenant_users) ? result.tenant_users : [];
    validStatusTypes.value = result.validStatusTypes ?? {};
    validTaskTypes.value = result.validTaskTypes ?? {};
  } catch {
    if (quiet) return;
    validUsers.value = [];
    tenantUsers.value = [];
    validStatusTypes.value = {};
    validTaskTypes.value = {};
  }
}

async function loadProjectTeam(projectId, { quiet = false } = {}) {
  if (!projectId || !authSession.state.token) return;
  try {
    const team = await (quiet ? apiClient.passive : apiClient).getProjectTeam(projectId, authSession.state.token);
    if (quiet && projectId !== project.value?.id) return;
    projectTeam.value = team;
    projectTeamError.value = '';
  } catch (error) {
    if (quiet) return;
    projectTeam.value = null;
    projectTeamError.value = error.message ?? 'Unable to load the project\'s resources.';
  }
}

async function handleTeamChanged(message) {
  if (!project.value?.id) return;
  await Promise.all([loadValidUsers(project.value.id), loadProjectTeam(project.value.id)]);
  if (message) showWorkspaceMessage(message);
}

async function loadProject(projectId) {
  errorMessage.value = '';
  successMessage.value = '';

  try {
    const project = await projectStore.loadProject(projectId);
    // An engagement has its own page, with only the sections it has.
    if (project?.kind === 'engagement') {
      // A link to a channel keeps it: the engagement page has Channels too.
      await router.replace(route.name === 'project-channels'
        ? { name: 'engagement-detail', params: { projectId, section: 'channels' }, query: route.query }
        : { name: 'engagement-detail', params: { projectId } });
      return;
    }
    setProjectState(project);
    void loadRequirementsCounts(projectId);
    await Promise.all([
      loadValidUsers(projectId),
      loadProjectTeam(projectId),
      // Fills projectStakeholderContacts for the Requirements stakeholder pickers.
      projectContacts.load(projectId).catch(() => null),
    ]);
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to load the project detail.';
  }
}

watch(
  () => route.params.projectId,
  (projectId) => {
    if (typeof projectId === 'string') {
      loadProject(projectId);
    }
  },
  { immediate: true },
);

watch(
  () => route.query.projectSettings,
  (projectSettings) => {
    const nextTab = String(projectSettings ?? '').trim();
    if (!nextTab) {
      return;
    }

    // Permissions became the Resources tab; old links land there.
    if (nextTab.toLowerCase() === 'permissions') {
      const projectId = route.params.projectId;
      if (typeof projectId === 'string' && projectId) {
        router.replace({ name: 'project-resources', params: { projectId } });
      }
      return;
    }

    // Clarifications moved into the Requirements tab; old links land there.
    if (nextTab.toLowerCase() === 'clarifications') {
      const projectId = route.params.projectId;
      if (typeof projectId === 'string' && projectId) {
        router.replace({ name: 'project-requirements', params: { projectId } });
      }
      return;
    }

    projectSettingsOpen.value = true;
    projectSettingsTab.value = normalizeProjectSettingsTab(nextTab);
  },
  { immediate: true },
);

// Related-work links open an item as ?item=<id>; select it once the project is loaded.
watch(
  () => [route.query.item, persistedProject.value?.id],
  ([itemId]) => {
    if (!itemId || !persistedProject.value) return;
    const selection = projectSelectionForItem(persistedProject.value, String(itemId));
    if (selection) handleSelect(selection);
    router.replace({ query: { ...route.query, item: undefined } });
  },
  { immediate: true },
);

const project = computed(() => draftProject.value);
const projectBriefListDrafts = ref(createProjectBriefListEditorState());

function projectBriefListMarkdown(field) {
  return projectBriefListDrafts.value?.[field] ?? '';
}

function setProjectBriefListFieldFromMarkdown(field, value) {
  if (!project.value?.assistantState?.brief) {
    return;
  }

  const markdown = String(value ?? '');
  projectBriefListDrafts.value = {
    ...projectBriefListDrafts.value,
    [field]: markdown,
  };
  project.value.assistantState.brief[field] = parseProjectBriefListMarkdown(markdown);
}

let compactWorkbenchMediaQuery = null;
let releaseCompactWorkbenchListener = null;

function syncCompactWorkbench(matches) {
  isCompactWorkbench.value = Boolean(matches);

  if (!isCompactWorkbench.value) {
    structureOutlineOpen.value = false;
  }
}

function handleCompactWorkbenchChange(event) {
  syncCompactWorkbench(event?.matches);
}

function openStructureOutline() {
  if (!isCompactWorkbench.value) {
    return;
  }

  structureOutlineOpen.value = true;
}

function closeStructureOutline() {
  structureOutlineOpen.value = false;
}

function toggleStructureOutline() {
  if (structureOutlineOpen.value) {
    closeStructureOutline();
    return;
  }

  openStructureOutline();
}

watch(activeWorkspace, (workspace) => {
  if (workspace !== 'structure') {
    closeStructureOutline();
  }
});

onMounted(() => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return;
  }

  compactWorkbenchMediaQuery = window.matchMedia('(max-width: 1279px)');
  syncCompactWorkbench(compactWorkbenchMediaQuery.matches);

  if (typeof compactWorkbenchMediaQuery.addEventListener === 'function') {
    compactWorkbenchMediaQuery.addEventListener('change', handleCompactWorkbenchChange);
    releaseCompactWorkbenchListener = () => {
      compactWorkbenchMediaQuery?.removeEventListener('change', handleCompactWorkbenchChange);
    };
    return;
  }

  compactWorkbenchMediaQuery.addListener?.(handleCompactWorkbenchChange);
  releaseCompactWorkbenchListener = () => {
    compactWorkbenchMediaQuery?.removeListener?.(handleCompactWorkbenchChange);
  };
});

onBeforeUnmount(() => {
  releaseCompactWorkbenchListener?.();
  compactWorkbenchMediaQuery = null;
  releaseCompactWorkbenchListener = null;
});

useOverlayScrollLock(overlayScrollLocked);

const activeDetail = computed(() => resolveProjectSelection(project.value, activeSelection.value));
const planningEditorProject = computed(() => planningEditorModalState.value.draftProject);
// Re-estimating any item updates the totals of every item above it as you type.
watchEstimateRollups(() => draftProject.value);
watchEstimateRollups(() => planningEditorProject.value);
const planningEditorProjectSnapshot = computed(() => (
  planningEditorProject.value ? serializeProjectSnapshot(planningEditorProject.value) : null
));
const planningEditorActiveDetail = computed(() => resolveProjectSelection(
  planningEditorProject.value,
  planningEditorModalState.value.selection,
));

function countLabel(count, singular, plural = `${singular}s`) {
  const numericCount = Number(count) || 0;
  return `${numericCount} ${numericCount === 1 ? singular : plural}`;
}

const projectStats = computed(() => {
  const value = project.value;
  const epics = value?.epics ?? [];

  let completedEpics = 0;
  let completedPoints = 0;
  let completedStories = 0;
  let completedTasks = 0;
  let totalPoints = 0;
  let totalStories = 0;
  let totalTasks = 0;

  for (const epic of epics) {
    if (epic?.status === 'Completed') {
      completedEpics += 1;
    }

    const stories = epic?.stories ?? [];
    totalStories += stories.length;

    for (const story of stories) {
      const points = Number(story?.points ?? 0) || 0;
      totalPoints += points;

      if (story?.status === 'Completed') {
        completedStories += 1;
        completedPoints += points;
      }

      const tasks = story?.tasks ?? [];
      totalTasks += tasks.length;

      for (const task of tasks) {
        if (task?.status === 'Completed') {
          completedTasks += 1;
        }
      }
    }
  }

  const totalEpics = epics.length;

  return {
    completedEpics,
    completedPoints,
    completedStories,
    completedTasks,
    pendingStories: Math.max(0, totalStories - completedStories),
    pendingTasks: Math.max(0, totalTasks - completedTasks),
    totalEpics,
    totalPoints,
    totalStories,
    totalTasks,
  };
});
const compactWorkbenchContext = computed(() => {
  const detail = activeDetail.value;
  const currentProject = project.value;
  const currentItem = detail?.item;
  const fallbackTitle = currentProject?.name ?? 'Project overview';

  if (!detail || !currentItem) {
    return {
      eyebrow: 'Viewing',
      meta: 'Project',
      title: fallbackTitle,
    };
  }

  if (detail.type === 'epic') {
    return {
      eyebrow: 'Viewing',
      meta: `Epic · ${countLabel(currentItem?.stories?.length, 'story')}`,
      title: currentItem?.name ?? 'Epic',
    };
  }

  if (detail.type === 'story') {
    return {
      eyebrow: 'Viewing',
      meta: `Story · ${countLabel(currentItem?.tasks?.length, 'task')}`,
      title: currentItem?.name ?? 'Story',
    };
  }

  if (detail.type === 'task') {
    return {
      eyebrow: 'Viewing',
      meta: `Task · ${currentItem?.status ?? 'Not started'}`,
      title: currentItem?.name ?? 'Task',
    };
  }

  return {
    eyebrow: 'Viewing',
    meta: `Project · ${countLabel(projectStats.value.totalStories, 'story')}`,
    title: fallbackTitle,
  };
});
const hasUnsavedChanges = computed(() => {
  if (!project.value) {
    return false;
  }

  return JSON.stringify(serializeProjectDetailSnapshot(project.value)) !== baselineSnapshot.value;
});

const currentUserId = computed(() => authSession.state.currentUser?.id ?? '');
const currentUserRole = computed(() => authSession.state.currentUser?.role ?? 'user');
const canExportProject = computed(() => currentUserRole.value === 'admin');
const canDeleteProject = computed(() => projectStore.state.activeProjectPermissions?.canDelete === true);
// Billing follows finance visibility (invoice-gen E-08) and the Consulting module (E-12).
const canSeeBilling = computed(() => workspaceModules.state.consulting && projectStore.state.activeProjectPermissions?.canManage === true);
const canManagePermissions = computed(() => currentUserRole.value === 'admin' || currentUserRole.value === 'manager');
const editorTarget = computed(() => {
  if (!project.value || !activeDetail.value.item) {
    return {
      targetId: '',
      targetType: 'project',
    };
  }

  if (activeDetail.value.type === 'project') {
    return {
      targetId: project.value.id,
      targetType: 'project',
    };
  }

  return {
    targetId: activeDetail.value.item.id,
    targetType: activeDetail.value.type,
  };
});

async function persistProjectDraft(nextProject) {
  errorMessage.value = '';
  successMessage.value = '';

  const metadataPayload = serializeProjectMetadata(nextProject);
  const treePayload = serializeProjectTree(nextProject);
  const assistantBriefPayload = serializeEditableProjectBrief(nextProject?.assistantState?.brief ?? {});
  const persistedSnapshot = serializeProjectDetailSnapshot(persistedProject.value);
  let savedProject = projectStore.state.activeProject ?? nextProject;

  if (JSON.stringify(metadataPayload) !== JSON.stringify(persistedSnapshot?.metadata ?? null)) {
    savedProject = await projectStore.saveProject(nextProject.id, metadataPayload);
    treePayload.expectedUpdatedAt = savedProject.updatedAt;
  }

  if (JSON.stringify(treePayload) !== JSON.stringify(persistedSnapshot?.tree ?? null)) {
    savedProject = await projectStore.saveProjectItems(nextProject.id, nextProject);
  }

  if (JSON.stringify(assistantBriefPayload) !== JSON.stringify(persistedSnapshot?.assistantBrief ?? null)) {
    savedProject = await projectStore.saveProjectAssistantBrief(nextProject.id, assistantBriefPayload);
  }

  return savedProject;
}

async function handleSaveProject() {
  if (!project.value || blockSaveForPendingLiveUpdate()) {
    return;
  }

  try {
    const savedProject = await persistProjectDraft(project.value);
    setProjectState(savedProject);
    successMessage.value = 'Project details saved.';
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to save the project.';
  }
}

function downloadBase64File({ base64, filename, mimeType }) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function handleExportProject() {
  if (!project.value || !authSession.state.token || projectExporting.value) {
    return;
  }

  projectExporting.value = true;
  errorMessage.value = '';
  successMessage.value = '';

  try {
    const result = await apiClient.exportProject(project.value.id, authSession.state.token);
    if (!result.base64OdinProject || !result.filename) {
      throw new Error('No project archive returned.');
    }
    downloadBase64File({
      base64: result.base64OdinProject,
      filename: result.filename,
      mimeType: 'application/zip',
    });
    successMessage.value = 'Project archive downloaded.';
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to export the project.';
  } finally {
    projectExporting.value = false;
  }
}

function handleRevertProject() {
  if (!persistedProject.value) {
    return;
  }

  draftProject.value = cloneProject(persistedProject.value);
  activeSelection.value = resolveProjectSelection(draftProject.value, activeSelection.value).selection;
  successMessage.value = 'Unsaved draft changes reverted.';
  errorMessage.value = '';
}

async function handleEnhanceDescription() {
  if (!project.value || !authSession.state.token) {
    return;
  }

  errorMessage.value = '';
  successMessage.value = '';
  aiWorking.value = true;
  aiSuggestionModalOpen.value = false;

  try {
    const result = await apiClient.enhanceProjectDescription(
      project.value.id,
      {
        description: project.value.description ?? '',
        project: serializeProjectSnapshot(project.value),
      },
      authSession.state.token,
    );

    aiSuggestion.value = result.suggestions[0] ?? '';
    if (aiSuggestion.value) {
      aiSuggestionModalOpen.value = true;
    }
    successMessage.value = 'AI description suggestion generated.';
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to generate an AI description suggestion.';
  } finally {
    aiWorking.value = false;
  }
}

function applyAiSuggestion() {
  if (!project.value || !aiSuggestion.value) {
    return;
  }

  project.value.description = aiSuggestion.value;
  activeSelection.value = { type: 'project' };
  aiSuggestionModalOpen.value = false;
  successMessage.value = 'AI description suggestion applied to the draft.';
}

async function handleAnalyzeProject() {
  if (!project.value || !authSession.state.token) {
    return;
  }

  errorMessage.value = '';
  successMessage.value = '';
  aiWorking.value = true;
  aiAnalysisModalOpen.value = false;

  try {
    const result = await apiClient.analyzeProject(
      project.value.id,
      {
        project: serializeProjectSnapshot(project.value),
      },
      authSession.state.token,
    );

    aiAnalysis.value = result.analysis;
    if (aiAnalysis.value) {
      aiAnalysisModalOpen.value = true;
    }
    successMessage.value = 'AI project analysis generated.';
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to analyze the project.';
  } finally {
    aiWorking.value = false;
  }
}

function closeAiSuggestionModal() {
  aiSuggestionModalOpen.value = false;
}

function closeAiAnalysisModal() {
  aiAnalysisModalOpen.value = false;
}

async function handleGenerateStructure() {
  if (!project.value || !authSession.state.token) {
    return;
  }

  errorMessage.value = '';
  successMessage.value = '';
  aiWorking.value = true;

  try {
    const result = await apiClient.generateProjectStructure(
      project.value.id,
      {
        project: serializeProjectSnapshot(project.value),
      },
      authSession.state.token,
    );

    const epics = result.epics ?? [];
    normalizeGeneratedNodes(epics);

    project.value.epics = project.value.epics.length === 0
      ? epics
      : [...project.value.epics, ...epics];
    successMessage.value = 'AI starter structure added to the draft.';
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to generate project structure.';
  } finally {
    aiWorking.value = false;
  }
}

function handleSelect(selection) {
  activeSelection.value = createProjectSelection(selection);

  if (isCompactWorkbench.value && activeWorkspace.value === 'structure') {
    closeStructureOutline();
  }
}

function toggleCollapse({ type, ids }) {
  const key = [type, ...ids].join(':');
  collapsedNodes.value = {
    ...collapsedNodes.value,
    [key]: !collapsedNodes.value[key],
  };
}

function updateFilterQuery(value) {
  filterQuery.value = value;
}

function updateStatusFilters(value) {
  statusFilters.value = Array.isArray(value) ? value : [];
}

function updateResourceFilters(value) {
  resourceFilters.value = Array.isArray(value) ? value : [];
}

function openProjectSettings(event) {
  event?.preventDefault?.();
  closeStructureOutline();
  projectSettingsOpen.value = true;
  projectSettingsTab.value = 'details';
}

function closeProjectSettings() {
  projectSettingsOpen.value = false;
}

async function handleProjectDeleted() {
  projectSettingsOpen.value = false;
  await router.push({ name: 'projects' });
  projectStore.state.activeProject = null;
  projectStore.state.activeProjectPermissions = { canDelete: false };
}

function collapseAllOutline() {
  if (!project.value) {
    return;
  }

  const next = {};

  for (const epic of project.value.epics ?? []) {
    next[`epic:${epic.id}`] = true;

    for (const story of epic.stories ?? []) {
      next[`story:${epic.id}:${story.id}`] = true;
    }
  }

  collapsedNodes.value = next;
}

function expandAllOutline() {
  collapsedNodes.value = {};
}

function addEpic() {
  if (!project.value) {
    return;
  }

  const epic = createEpicDraft();
  project.value.epics.push(epic);
  activeSelection.value = { type: 'epic', epicId: epic.id };
}

function addStory(epicId) {
  if (!project.value) {
    return null;
  }

  const resolved = resolveProjectSelection(project.value, { type: 'epic', epicId });

  if (!resolved.epic) {
    return null;
  }

  const story = createStoryDraft();
  resolved.epic.stories.push(story);
  const nextSelection = {
    type: 'story',
    epicId,
    storyId: story.id,
  };
  activeSelection.value = nextSelection;
  return nextSelection;
}

function addTask({ epicId, storyId }) {
  if (!project.value) {
    return null;
  }

  const resolved = resolveProjectSelection(project.value, { type: 'story', epicId, storyId });

  if (!resolved.story) {
    return null;
  }

  const task = createTaskDraft();
  resolved.story.tasks.push(task);
  const nextSelection = {
    type: 'task',
    epicId,
    storyId,
    taskId: task.id,
  };
  activeSelection.value = nextSelection;
  return nextSelection;
}

function addStoryToProject(targetProject, epicId) {
  if (!targetProject) {
    return null;
  }

  const resolved = resolveProjectSelection(targetProject, { type: 'epic', epicId });
  if (!resolved.epic) {
    return null;
  }

  const story = createStoryDraft();
  resolved.epic.stories.push(story);
  return {
    type: 'story',
    epicId,
    storyId: story.id,
  };
}

function addTaskToProject(targetProject, { epicId, storyId }) {
  if (!targetProject) {
    return null;
  }

  const resolved = resolveProjectSelection(targetProject, { type: 'story', epicId, storyId });
  if (!resolved.story) {
    return null;
  }

  const task = createTaskDraft();
  resolved.story.tasks.push(task);
  return {
    type: 'task',
    epicId,
    storyId,
    taskId: task.id,
  };
}

function beginSplitStory({ epicId, storyId }) {
  const sourceProject = planningEditorModalState.value.open
    ? planningEditorProject.value
    : project.value;

  if (!sourceProject) {
    splitStoryTarget.value = null;
    splitStoryOpen.value = false;
    return;
  }

  const epic = sourceProject.epics?.find((entry) => entry.id === epicId) ?? null;
  const story = epic?.stories?.find((entry) => entry.id === storyId) ?? null;
  splitStoryTarget.value = story;
  splitStoryOpen.value = Boolean(story);
}

async function handleSplitResult(result) {
  splitStoryOpen.value = false;
  splitStoryTarget.value = null;

  if (result?.project) {
    setProjectState(result.project);
    if (planningEditorModalState.value.open) {
      planningEditorModalState.value = updatePlanningEditorModalDraftProject(
        planningEditorModalState.value,
        result.project,
      );
    }
    successMessage.value = 'Story split.';
    errorMessage.value = '';
    return;
  }

  if (project.value?.id) {
    await loadProject(project.value.id);
  }
}

function beginStoryReassign({ epicId, storyId }) {
  const sourceProject = planningEditorModalState.value.open
    ? planningEditorProject.value
    : project.value;

  if (!sourceProject) {
    storyReassignState.value = { sourceEpicId: '', storyId: '', storyName: '' };
    return;
  }

  const sourceEpic = sourceProject.epics?.find((entry) => entry.id === epicId) ?? null;
  const story = sourceEpic?.stories?.find((entry) => entry.id === storyId) ?? null;

  storyReassignState.value = {
    sourceEpicId: epicId,
    storyId,
    storyName: story?.name ?? '',
  };
}

function handleStoryReassign({ targetEpicId }) {
  if (!project.value) {
    return null;
  }

  const { sourceEpicId, storyId } = storyReassignState.value ?? {};
  if (!sourceEpicId || !storyId || !targetEpicId || sourceEpicId === targetEpicId) {
    return null;
  }

  const sourceEpic = project.value.epics?.find((entry) => entry.id === sourceEpicId) ?? null;
  const targetEpic = project.value.epics?.find((entry) => entry.id === targetEpicId) ?? null;

  if (!sourceEpic || !targetEpic) {
    return null;
  }

  sourceEpic.stories = Array.isArray(sourceEpic.stories) ? sourceEpic.stories : [];
  targetEpic.stories = Array.isArray(targetEpic.stories) ? targetEpic.stories : [];

  const index = sourceEpic.stories.findIndex((entry) => entry.id === storyId);
  if (index < 0) {
    return null;
  }

  const [story] = sourceEpic.stories.splice(index, 1);
  targetEpic.stories.push(story);

  collapsedNodes.value = {
    ...collapsedNodes.value,
    [`epic:${targetEpicId}`]: false,
    [`story:${targetEpicId}:${storyId}`]: false,
  };

  const nextSelection = {
    type: 'story',
    epicId: targetEpicId,
    storyId,
  };
  activeSelection.value = nextSelection;
  return nextSelection;
}

function handleStoryReassignInProject(targetProject, { targetEpicId }) {
  if (!targetProject) {
    return null;
  }

  const { sourceEpicId, storyId } = storyReassignState.value ?? {};
  if (!sourceEpicId || !storyId || !targetEpicId || sourceEpicId === targetEpicId) {
    return null;
  }

  const sourceEpic = targetProject.epics?.find((entry) => entry.id === sourceEpicId) ?? null;
  const targetEpic = targetProject.epics?.find((entry) => entry.id === targetEpicId) ?? null;
  if (!sourceEpic || !targetEpic) {
    return null;
  }

  sourceEpic.stories = Array.isArray(sourceEpic.stories) ? sourceEpic.stories : [];
  targetEpic.stories = Array.isArray(targetEpic.stories) ? targetEpic.stories : [];

  const index = sourceEpic.stories.findIndex((entry) => entry.id === storyId);
  if (index < 0) {
    return null;
  }

  const [story] = sourceEpic.stories.splice(index, 1);
  targetEpic.stories.push(story);

  return {
    type: 'story',
    epicId: targetEpicId,
    storyId,
  };
}

function removeItem(selection) {
  if (!project.value) {
    return null;
  }

  const collection = resolveSelectionCollection(project.value, selection);

  if (!collection || collection.index < 0) {
    return null;
  }

  collection.list.splice(collection.index, 1);
  activeSelection.value = collection.fallbackSelection;
  successMessage.value = 'Draft item removed. Save the project to persist the change.';
  errorMessage.value = '';
  return collection.fallbackSelection;
}

function removeItemFromProject(targetProject, selection) {
  if (!targetProject) {
    return null;
  }

  const collection = resolveSelectionCollection(targetProject, selection);
  if (!collection || collection.index < 0) {
    return null;
  }

  collection.list.splice(collection.index, 1);
  return collection.fallbackSelection;
}

function showWorkspaceMessage(message) {
  successMessage.value = message;
  errorMessage.value = '';
}

function showWorkspaceError(message) {
  errorMessage.value = message;
  successMessage.value = '';
}

function withPersistedAssistantState(project) {
  return project?.assistantState || !persistedProject.value?.assistantState
    ? project
    : { ...project, assistantState: persistedProject.value.assistantState };
}

function handleWorkspaceProjectUpdated(project) {
  receiveServerProject(project, [{ id: 'self', name: 'Your change on another screen' }]);
}

// ── Live project updates ─────────────────────────────────────
// Changes saved elsewhere refresh this screen. Without local edits the new state applies
// directly; with unsaved edits (structure draft or the item editor) the user merges the
// incoming changes into their draft or discards their edits.
const liveUpdate = ref(null);
let stopLiveUpdates = null;
let liveFetchSequence = 0;
let liveRecheckAfterSave = false;

function comparableProjectSnapshot(value) {
  const snapshot = serializeProjectDetailSnapshot(value);
  if (!snapshot) return '';
  delete snapshot.metadata.expectedUpdatedAt;
  delete snapshot.tree.expectedUpdatedAt;
  return JSON.stringify(snapshot);
}

const planningEditorHasEdits = computed(() => (
  planningEditorModalState.value.open
  && Boolean(planningEditorProject.value)
  && comparableProjectSnapshot(planningEditorProject.value) !== comparableProjectSnapshot(persistedProject.value)
));
const hasLocalProjectEdits = computed(() => hasUnsavedChanges.value || planningEditorHasEdits.value);

function computeLiveMerge(remote, resolutions = {}) {
  const base = persistedProject.value;
  const normalizedRemote = normalizeProjectDetailState(cloneProject(withPersistedAssistantState(remote)));
  const options = { base, normalizeBrief: serializeEditableProjectBrief, resolutions, theirs: normalizedRemote };
  const structure = mergeProjects({ ...options, mine: draftProject.value });
  const modal = planningEditorModalState.value.open && planningEditorProject.value
    ? mergeProjects({ ...options, mine: planningEditorProject.value })
    : null;
  const conflicts = [...structure.conflicts];
  for (const conflict of modal?.conflicts ?? []) {
    if (!conflicts.some((entry) => entry.key === conflict.key)) conflicts.push(conflict);
  }

  return { conflicts, modal, normalizedRemote, structure };
}

const liveUpdateConflicts = computed(() => (liveUpdate.value ? computeLiveMerge(liveUpdate.value.remote).conflicts : []));
const liveUpdateMessage = computed(() => (
  liveUpdate.value
    ? `${describeLiveUpdateActors(liveUpdate.value.actors)} updated this project while you were editing.`
    : ''
));

function applyLiveMerge(remote, resolutions = {}) {
  const { modal, normalizedRemote, structure } = computeLiveMerge(remote, resolutions);
  projectStore.state.activeProject = withPersistedAssistantState(remote);
  persistedProject.value = normalizedRemote;
  baselineSnapshot.value = JSON.stringify(serializeProjectDetailSnapshot(normalizedRemote));
  draftProject.value = normalizeProjectDetailState(structure.merged);
  projectBriefListDrafts.value = createProjectBriefListEditorState(draftProject.value.assistantState?.brief ?? {});
  activeSelection.value = resolveProjectSelection(draftProject.value, activeSelection.value).selection;
  if (modal) {
    planningEditorModalState.value = updatePlanningEditorModalDraftProject(planningEditorModalState.value, modal.merged);
  }
  liveUpdate.value = null;
}

function receiveServerProject(remote, actors = []) {
  if (!remote || remote.id !== persistedProject.value?.id) return;

  if (!hasLocalProjectEdits.value) {
    projectStore.state.activeProject = withPersistedAssistantState(remote);
    setProjectState(withPersistedAssistantState(remote));
    if (planningEditorModalState.value.open) {
      planningEditorModalState.value = updatePlanningEditorModalDraftProject(planningEditorModalState.value, persistedProject.value);
    }
    liveUpdate.value = null;
    return;
  }

  const contentChanged = comparableProjectSnapshot(normalizeProjectDetailState(cloneProject(withPersistedAssistantState(remote))))
    !== comparableProjectSnapshot(persistedProject.value);
  if (!contentChanged) {
    // Only versions or timestamps moved; rebase the draft quietly so the next save is accepted.
    applyLiveMerge(remote);
    return;
  }

  liveUpdate.value = {
    actors: [...(liveUpdate.value?.actors ?? []), ...actors].filter((actor, index, list) => (
      list.findIndex((entry) => entry.id === actor.id) === index
    )),
    remote,
  };
}

async function handleLiveProjectChange(batch = {}) {
  const projectId = persistedProject.value?.id;
  const token = authSession.state.token;
  if (!projectId || !token) return;

  if (projectStore.state.saving) {
    liveRecheckAfterSave = true;
    return;
  }

  const sequence = ++liveFetchSequence;
  let remote;
  try {
    // Every caller reacts to someone else's change, so this refetch stays in the background.
    remote = (await apiClient.passive.getProject(projectId, token)).project;
  } catch (error) {
    if (error?.status === 404) {
      errorMessage.value = 'This project was deleted or you no longer have access to it.';
      successMessage.value = '';
    }
    return;
  }
  if (sequence !== liveFetchSequence || projectStore.state.saving) {
    liveRecheckAfterSave = liveRecheckAfterSave || projectStore.state.saving;
    return;
  }

  receiveServerProject(remote, batch.actors ?? []);
  workspaceRefreshVersion.value += 1;
  // People and resources added or changed elsewhere (by MCP clients too) show up in the Resources
  // tab and in assignee choices.
  void loadValidUsers(projectId, { quiet: true });
  void loadProjectTeam(projectId, { quiet: true });
}

function handleLiveMerge(resolutions) {
  if (!liveUpdate.value) return;
  applyLiveMerge(liveUpdate.value.remote, resolutions);
  successMessage.value = 'Merged the latest project changes into your draft. Review and save when ready.';
  errorMessage.value = '';
}

function handleLiveDiscard() {
  if (!liveUpdate.value) return;
  const remote = withPersistedAssistantState(liveUpdate.value.remote);
  projectStore.state.activeProject = remote;
  setProjectState(remote);
  if (planningEditorModalState.value.open) {
    planningEditorModalState.value = updatePlanningEditorModalDraftProject(planningEditorModalState.value, persistedProject.value);
  }
  liveUpdate.value = null;
  successMessage.value = 'Discarded your edits and loaded the latest project.';
  errorMessage.value = '';
}

function blockSaveForPendingLiveUpdate() {
  if (!liveUpdate.value) return false;
  errorMessage.value = 'This project changed while you were editing. Merge or discard the incoming changes before saving.';
  successMessage.value = '';
  return true;
}

watch(
  () => [persistedProject.value?.id ?? '', authSession.state.token ?? ''],
  ([projectId, token]) => {
    stopLiveUpdates?.();
    stopLiveUpdates = null;
    liveUpdate.value = null;
    if (!projectId || !token) return;
    stopLiveUpdates = createProjectLiveUpdates({
      apiClient,
      getToken: () => authSession.state.token,
      onChange: handleLiveProjectChange,
      projectId,
    });
  },
);

watch(
  () => projectStore.state.saving,
  (saving) => {
    if (!saving && liveRecheckAfterSave) {
      liveRecheckAfterSave = false;
      handleLiveProjectChange({ actors: liveUpdate.value?.actors ?? [] });
    }
  },
);

watch(hasLocalProjectEdits, (hasEdits) => {
  // Reverting or saving the draft clears the conflict; pull the latest state directly.
  if (!hasEdits && liveUpdate.value) {
    handleLiveProjectChange({ actors: liveUpdate.value.actors });
  }
});

onBeforeUnmount(() => {
  stopLiveUpdates?.();
  stopLiveUpdates = null;
});

function selectPlanningItem(selection) {
  handleSelect(selection);

  if (project.value?.id) {
    router.push({
      name: 'project-detail',
      params: {
        projectId: project.value.id,
      },
    });
  }
}

function openPlanningEditorModal(selection) {
  planningEditorModalState.value = openPlanningEditorModalState(
    planningEditorModalState.value,
    selection,
    project.value,
  );
}

function closePlanningEditorModal() {
  planningEditorModalState.value = closePlanningEditorModalState(planningEditorModalState.value);
}

function selectPlanningEditorItem(selection) {
  planningEditorModalState.value = selectPlanningEditorModalItem(
    planningEditorModalState.value,
    selection,
  );
}

function addStoryFromPlanningModal(epicId) {
  const nextSelection = addStoryToProject(planningEditorProject.value, epicId);
  if (nextSelection) {
    planningEditorModalState.value = updatePlanningEditorModalDraftProject(
      planningEditorModalState.value,
      planningEditorProject.value,
    );
    selectPlanningEditorItem(nextSelection);
  }
}

function addTaskFromPlanningModal(payload) {
  const nextSelection = addTaskToProject(planningEditorProject.value, payload);
  if (nextSelection) {
    planningEditorModalState.value = updatePlanningEditorModalDraftProject(
      planningEditorModalState.value,
      planningEditorProject.value,
    );
    selectPlanningEditorItem(nextSelection);
  }
}

function removeItemFromPlanningModal(selection) {
  const nextSelection = removeItemFromProject(planningEditorProject.value, selection);
  if (nextSelection) {
    planningEditorModalState.value = updatePlanningEditorModalDraftProject(
      planningEditorModalState.value,
      planningEditorProject.value,
    );
  }
  if (!nextSelection || nextSelection.type === 'project') {
    closePlanningEditorModal();
    return;
  }

  selectPlanningEditorItem(nextSelection);
}

function handleStoryReassignFromPlanningModal(payload) {
  const nextSelection = handleStoryReassignInProject(planningEditorProject.value, payload);
  if (nextSelection) {
    planningEditorModalState.value = updatePlanningEditorModalDraftProject(
      planningEditorModalState.value,
      planningEditorProject.value,
    );
    selectPlanningEditorItem(nextSelection);
  }
}

async function savePlanningEditorModal() {
  if (!planningEditorProject.value || blockSaveForPendingLiveUpdate()) {
    return;
  }

  try {
    const savedProject = await persistProjectDraft(planningEditorProject.value);
    setProjectState(savedProject);
    workspaceRefreshVersion.value += 1;
    activeSelection.value = createProjectSelection(planningEditorModalState.value.selection);
    planningEditorModalState.value = closePlanningEditorModalState(planningEditorModalState.value);
    successMessage.value = 'Project changes saved.';
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to save the project.';
  }
}
</script>

<template>
  <section class="dashboard-panel dashboard-panel--workbench">
    <div v-if="errorMessage" class="error-banner" style="margin-top: 1rem">{{ errorMessage }}</div>
    <div v-else-if="successMessage" class="success-banner" style="margin-top: 1rem">{{ successMessage }}</div>

    <template v-if="project">
      <div class="project-detail-tabs-bar">
        <nav class="project-detail-tabs" aria-label="Project workspace tabs">
          <RouterLink
            class="project-detail-tabs__item"
            :class="{ 'project-detail-tabs__item--active': activeWorkspace === 'structure' }"
            :to="{ name: 'project-detail', params: { projectId: project.id } }"
          >
            Project Structure
          </RouterLink>
          <RouterLink
            class="project-detail-tabs__item"
            :class="{ 'project-detail-tabs__item--active': activeWorkspace === 'sprints' }"
            :to="{ name: 'project-sprints', params: { projectId: project.id } }"
          >
            Sprints
          </RouterLink>
          <RouterLink
            class="project-detail-tabs__item"
            :class="{ 'project-detail-tabs__item--active': activeWorkspace === 'kanban' }"
            :to="{ name: 'project-kanban', params: { projectId: project.id } }"
          >
            Kanban
          </RouterLink>
          <RouterLink
            class="project-detail-tabs__item"
            :class="{ 'project-detail-tabs__item--active': activeWorkspace === 'governance' }"
            :to="{ name: 'project-governance', params: { projectId: project.id } }"
          >
            Governance
          </RouterLink>
          <RouterLink
            class="project-detail-tabs__item"
            :class="{ 'project-detail-tabs__item--active': activeWorkspace === 'tickets' }"
            :to="{ name: 'project-tickets', params: { projectId: project.id } }"
          >
            Tickets
          </RouterLink>
          <RouterLink
            class="project-detail-tabs__item rq-project-tab"
            :class="{ 'project-detail-tabs__item--active': activeWorkspace === 'requirements' }"
            :aria-current="activeWorkspace === 'requirements' ? 'page' : undefined"
            :to="{ name: 'project-requirements', params: { projectId: project.id } }"
          >
            Requirements
            <span v-if="requirementsBadgeCount > 0" class="rq-tab-badge" aria-hidden="true">{{ requirementsBadgeCount }}</span>
            <span v-if="requirementsBadgeCount > 0" class="visually-hidden">, {{ requirementsBadgeCount }} waiting on you</span>
          </RouterLink>
          <RouterLink
            class="project-detail-tabs__item"
            :class="{ 'project-detail-tabs__item--active': activeWorkspace === 'channels' }"
            :aria-current="activeWorkspace === 'channels' ? 'page' : undefined"
            :to="{ name: 'project-channels', params: { projectId: project.id } }"
          >
            Channels
          </RouterLink>
          <RouterLink
            class="project-detail-tabs__item"
            :class="{ 'project-detail-tabs__item--active': activeWorkspace === 'resources' }"
            :aria-current="activeWorkspace === 'resources' ? 'page' : undefined"
            :to="{ name: 'project-resources', params: { projectId: project.id } }"
          >
            Resources
          </RouterLink>
          <RouterLink
            class="project-detail-tabs__item"
            :class="{ 'project-detail-tabs__item--active': activeWorkspace === 'insights' }"
            :aria-current="activeWorkspace === 'insights' ? 'page' : undefined"
            :to="{ name: 'project-insights', params: { projectId: project.id } }"
          >
            Insights
          </RouterLink>
          <RouterLink
            v-if="canSeeBilling"
            class="project-detail-tabs__item"
            :class="{ 'project-detail-tabs__item--active': activeWorkspace === 'billing' }"
            :aria-current="activeWorkspace === 'billing' ? 'page' : undefined"
            :to="{ name: 'project-billing', params: { projectId: project.id } }"
          >
            Billing
          </RouterLink>
          <!-- A converted engagement keeps its pursuit board and insights (docs/engagements/plan.md). -->
          <RouterLink
            v-if="project.convertedAt"
            class="project-detail-tabs__item"
            :class="{ 'project-detail-tabs__item--active': activeWorkspace === 'pursuit' }"
            :aria-current="activeWorkspace === 'pursuit' ? 'page' : undefined"
            :to="{ name: 'project-pursuit', params: { projectId: project.id } }"
          >
            Pursuit
          </RouterLink>
        </nav>

        <div class="project-detail-tabs-bar__actions">
          <RouterLink class="pill-link project-detail-tabs-bar__back" to="/projects">Back to projects</RouterLink>
        </div>
      </div>

      <div v-if="activeWorkspace === 'structure' && isCompactWorkbench" class="project-workbench-toolbar">
        <button
          :aria-expanded="structureOutlineOpen ? 'true' : 'false'"
          :aria-label="structureOutlineOpen ? 'Hide structure navigator' : 'Open structure navigator'"
          class="project-workbench-toolbar__trigger"
          :class="{ 'project-workbench-toolbar__trigger--active': structureOutlineOpen }"
          type="button"
          @click="toggleStructureOutline"
        >
          <i class="bi bi-diagram-3" aria-hidden="true"></i>
          <span>Structure navigator</span>
        </button>
        <div class="project-workbench-toolbar__context">
          <span class="project-workbench-toolbar__eyebrow">{{ compactWorkbenchContext.eyebrow }}</span>
          <span class="project-workbench-toolbar__selection">{{ compactWorkbenchContext.title }}</span>
        </div>
        <span class="project-workbench-toolbar__meta">{{ compactWorkbenchContext.meta }}</span>
      </div>


      <button
        v-if="activeWorkspace === 'structure' && isCompactWorkbench && structureOutlineOpen"
        class="project-workbench-outline-backdrop"
        type="button"
        aria-label="Close outline"
        @click="closeStructureOutline"
      ></button>

      <div
        v-if="activeWorkspace === 'structure'"
        class="project-workbench"
        :class="{ 'project-workbench--outline-callable': isCompactWorkbench }"
      >
        <ProjectOutlinePane
          :active-selection="activeSelection"
          :collapsed-nodes="collapsedNodes"
          :dismissible="isCompactWorkbench"
          :drawer-open="structureOutlineOpen"
          :filter-query="filterQuery"
          :resource-filters="resourceFilters"
          :project="project"
          :status-filters="statusFilters"
          :valid-users="assignableUsers"
          @add-epic="addEpic"
          @add-story="addStory"
          @add-task="addTask"
          @collapse-all="collapseAllOutline"
          @close="closeStructureOutline"
          @expand-all="expandAllOutline"
          @select="handleSelect"
          @toggle-collapse="toggleCollapse"
          @update:filter-query="updateFilterQuery"
          @update:resource-filters="updateResourceFilters"
          @update:status-filters="updateStatusFilters"
        />

        <ProjectWorkbenchEditor
          :active-detail="activeDetail"
          :api-base-url="authSession.state.apiBaseUrl"
          :can-manage-billing="canSeeBilling"
          :current-user-id="currentUserId"
          :current-user-role="currentUserRole"
          :has-unsaved-changes="hasUnsavedChanges"
          :project-id="project.id"
          :project-snapshot="projectSnapshot"
          :project-status-options="projectStatusOptions"
          :token="authSession.state.token"
          :valid-users="assignableUsers"
          :work-status-options="workStatusOptions"
          @add-story="addStory"
          @add-task="addTask"
          @remove-item="removeItem"
          @reassign-story="beginStoryReassign"
          @restored="handleWorkspaceProjectUpdated"
          @select="handleSelect"
          @split-story="beginSplitStory"
        />

        <aside id="rightPane" class="workbench-pane--context">
          <div class="card mb-3">
            <div class="card-body">
              <h5 class="mb-3"><i class="bi bi-lightning-charge me-1"></i> Actions</h5>
              <button class="btn btn-primary w-100" type="button" :disabled="aiWorking" @click="handleAnalyzeProject">
                Analyze Project
              </button>
            </div>
          </div>

          <div class="card mb-3">
            <div class="card-body pb-2">
              <h5 class="mb-0"><i class="bi bi-bar-chart-line me-1"></i> Project Stats</h5>
            </div>
            <ul class="list-group list-group-flush">
              <li class="list-group-item d-flex justify-content-between align-items-center">
                Total Epics
                <span class="badge bg-primary rounded-pill">{{ projectStats.totalEpics }}</span>
              </li>
              <li class="list-group-item d-flex justify-content-between align-items-center">
                Completed Epics
                <span class="badge bg-success rounded-pill">{{ projectStats.completedEpics }}</span>
              </li>
              <li class="list-group-item d-flex justify-content-between align-items-center">
                Total Stories
                <span class="badge bg-primary rounded-pill">{{ projectStats.totalStories }}</span>
              </li>
              <li class="list-group-item d-flex justify-content-between align-items-center">
                Completed Stories
                <span class="badge bg-success rounded-pill">{{ projectStats.completedStories }}</span>
              </li>
              <li class="list-group-item d-flex justify-content-between align-items-center">
                Pending Stories
                <span class="badge bg-warning text-dark rounded-pill">{{ projectStats.pendingStories }}</span>
              </li>
              <li class="list-group-item d-flex justify-content-between align-items-center">
                Total Tasks
                <span class="badge bg-primary rounded-pill">{{ projectStats.totalTasks }}</span>
              </li>
              <li class="list-group-item d-flex justify-content-between align-items-center">
                Completed Tasks
                <span class="badge bg-success rounded-pill">{{ projectStats.completedTasks }}</span>
              </li>
              <li class="list-group-item d-flex justify-content-between align-items-center">
                Pending Tasks
                <span class="badge bg-warning text-dark rounded-pill">{{ projectStats.pendingTasks }}</span>
              </li>
              <li class="list-group-item d-flex justify-content-between align-items-center">
                Total Points
                <span class="badge bg-primary rounded-pill">{{ projectStats.totalPoints }}</span>
              </li>
              <li class="list-group-item d-flex justify-content-between align-items-center">
                Completed Points
                <span class="badge bg-success rounded-pill">{{ projectStats.completedPoints }}</span>
              </li>
            </ul>
          </div>

          <div class="card">
            <div class="card-body pb-2">
              <h5 class="mb-0"><i class="bi bi-grid me-1"></i> Project Views</h5>
            </div>
            <ul class="list-group list-group-flush">
              <li class="list-group-item">
                <RouterLink :to="{ name: 'project-insights', params: { projectId: project.id } }">Insights and reports</RouterLink>
              </li>
              <li class="list-group-item">
                <a href="#" @click.prevent="openProjectSettings">Settings</a>
              </li>
            </ul>
          </div>
        </aside>
      </div>
      <ProjectSprintsWorkspace
        v-else-if="activeWorkspace === 'sprints'"
        :project="project"
        :project-id="project.id"
        :token="authSession.state.token"
        :refresh-version="workspaceRefreshVersion"
        @edit-item="openPlanningEditorModal"
        @error="showWorkspaceError"
        @message="showWorkspaceMessage"
        @project-updated="handleWorkspaceProjectUpdated"
        @select-item="selectPlanningItem"
      />
      <ProjectKanbanWorkspace
        v-else-if="activeWorkspace === 'kanban'"
        :project="project"
        :project-id="project.id"
        :token="authSession.state.token"
        :valid-users="assignableUsers"
        :refresh-version="workspaceRefreshVersion"
        :work-status-options="workStatusOptions"
        @edit-item="openPlanningEditorModal"
        @error="showWorkspaceError"
        @message="showWorkspaceMessage"
        @project-updated="handleWorkspaceProjectUpdated"
      />
      <ProjectTicketsPanel
        v-else-if="activeWorkspace === 'tickets'"
        :project-id="project.id"
        :refresh-version="workspaceRefreshVersion"
      />
      <ProjectResourcesWorkspace
        v-else-if="activeWorkspace === 'resources'"
        :can-manage-access="canManagePermissions"
        :members="validUsers"
        :project="project"
        :team="projectTeam"
        :team-error="projectTeamError"
        :tenant-users="tenantUsers"
        @changed="handleTeamChanged"
      />
      <ChannelsWorkspace
        v-else-if="activeWorkspace === 'channels'"
        :project-id="project.id"
      />
      <div v-else-if="activeWorkspace === 'pursuit'" class="project-pursuit">
        <PursuitBoardPanel allow-move :project-id="project.id" :refresh-version="workspaceRefreshVersion" @moved="handleLiveProjectChange()" />
        <PursuitInsightsPanel :project-id="project.id" :refresh-version="workspaceRefreshVersion" />
      </div>
      <ProjectInsightsWorkspace
        v-else-if="activeWorkspace === 'insights'"
        :project-id="project.id"
        :project-name="project.name"
        :refresh-version="workspaceRefreshVersion"
      />
      <ProjectBillingPanel
        v-else-if="activeWorkspace === 'billing'"
        :project-id="project.id"
        :refresh-version="workspaceRefreshVersion"
      />
      <RequirementsWorkspace
        v-else-if="activeWorkspace === 'requirements'"
        :project="project"
        :stakeholders="projectContacts.state.stakeholders"
        :valid-users="validUsers"
        @counts="setRequirementsCounts"
      />
      <ProjectGovernanceWorkspace
        v-else
        :current-user-id="currentUserId"
        :project="project"
        :project-id="project.id"
        :token="authSession.state.token"
        :refresh-version="workspaceRefreshVersion"
        :users="tenantUsers"
        @error="showWorkspaceError"
        @message="showWorkspaceMessage"
      />

      <ProjectLiveUpdateNotice
        :busy="projectStore.state.saving"
        :conflicts="liveUpdateConflicts"
        :message="liveUpdateMessage"
        :visible="Boolean(liveUpdate)"
        @discard="handleLiveDiscard"
        @merge="handleLiveMerge"
      />

      <ProjectPlanningEditorModal
        :active-detail="planningEditorActiveDetail"
        :api-base-url="authSession.state.apiBaseUrl"
        :current-user-id="currentUserId"
        :current-user-role="currentUserRole"
        :open="planningEditorModalState.open"
        :project-id="project.id"
        :project-status-options="projectStatusOptions"
        :project-snapshot="planningEditorProjectSnapshot"
        :saving="projectStore.state.saving"
        :token="authSession.state.token"
        :valid-users="assignableUsers"
        :work-status-options="workStatusOptions"
        @add-story="addStoryFromPlanningModal"
        @add-task="addTaskFromPlanningModal"
        @close="closePlanningEditorModal"
        @remove-item="removeItemFromPlanningModal"
        @reassign-story="beginStoryReassign"
        @save="savePlanningEditorModal"
        @select="selectPlanningEditorItem"
        @split-story="beginSplitStory"
      />

      <StoryReassignModal
        :project="project"
        :source-epic-id="storyReassignState.sourceEpicId"
        :story-id="storyReassignState.storyId"
        :story-name="storyReassignState.storyName"
        @reassign="planningEditorModalState.open ? handleStoryReassignFromPlanningModal($event) : handleStoryReassign($event)"
      />

      <ProjectSplitStoryModal
        :open="splitStoryOpen"
        :project-id="project.id"
        :sprints="[]"
        :story="splitStoryTarget"
        :token="authSession.state.token"
        @close="splitStoryOpen = false"
        @split="handleSplitResult"
      />

      <div
        v-if="aiSuggestionModalOpen"
        class="modal fade show"
        tabindex="-1"
        aria-modal="true"
        role="dialog"
        style="display: block;"
      >
        <div class="modal-dialog modal-dialog-centered modal-dialog-scrollable modal-lg">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title">AI Suggestion</h5>
              <button class="btn-close" type="button" aria-label="Close" @click="closeAiSuggestionModal"></button>
            </div>
            <div class="modal-body">
              <div class="rich-copy" v-html="aiSuggestion"></div>
            </div>
            <div class="modal-footer">
              <button class="btn btn-secondary btn-sm" type="button" @click="closeAiSuggestionModal">Close</button>
              <button class="btn btn-primary btn-sm" type="button" @click="applyAiSuggestion">Apply</button>
            </div>
          </div>
        </div>
      </div>
      <div v-if="aiSuggestionModalOpen" class="modal-backdrop fade show"></div>

      <div
        v-if="aiAnalysisModalOpen"
        class="modal fade show"
        tabindex="-1"
        aria-modal="true"
        role="dialog"
        style="display: block;"
      >
        <div class="modal-dialog modal-dialog-centered modal-dialog-scrollable modal-lg">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title">AI Project Analysis</h5>
              <button class="btn-close" type="button" aria-label="Close" @click="closeAiAnalysisModal"></button>
            </div>
            <div class="modal-body">
              <div class="rich-copy" v-html="aiAnalysis"></div>
            </div>
            <div class="modal-footer">
              <button class="btn btn-secondary btn-sm" type="button" @click="closeAiAnalysisModal">Close</button>
            </div>
          </div>
        </div>
      </div>
      <div v-if="aiAnalysisModalOpen" class="modal-backdrop fade show"></div>

      <div v-if="projectSettingsOpen" class="project-settings-backdrop" @click="closeProjectSettings"></div>
      <aside v-if="projectSettingsOpen" class="project-settings-drawer" aria-label="Project settings drawer">
        <div class="project-settings-drawer__rail">
          <button class="project-settings-drawer__close" type="button" aria-label="Close settings" @click="closeProjectSettings">
            <i class="bi bi-arrow-left-short" aria-hidden="true"></i>
            <span>Done</span>
          </button>
          <h2>{{ project.name }}</h2>
          <nav class="project-settings-drawer__nav" aria-label="Project settings sections">
            <button
              class="project-settings-drawer__nav-item"
              :class="{ 'project-settings-drawer__nav-item--active': projectSettingsTab === 'details' }"
              type="button"
              @click="projectSettingsTab = 'details'"
            >
              <span class="project-settings-drawer__nav-item-row">
                <i class="bi bi-pencil-square project-settings-drawer__nav-icon"></i>
                Details
              </span>
            </button>
            <button
              class="project-settings-drawer__nav-item"
              :class="{ 'project-settings-drawer__nav-item--active': projectSettingsTab === 'comments' }"
              type="button"
              @click="projectSettingsTab = 'comments'"
            >
              <span class="project-settings-drawer__nav-item-row">
                <i class="bi bi-chat-text project-settings-drawer__nav-icon"></i>
                Comments
              </span>
            </button>
            <button
              class="project-settings-drawer__nav-item"
              :class="{ 'project-settings-drawer__nav-item--active': projectSettingsTab === 'files' }"
              type="button"
              @click="projectSettingsTab = 'files'"
            >
              <span class="project-settings-drawer__nav-item-row">
                <i class="bi bi-folder project-settings-drawer__nav-icon"></i>
                Files
              </span>
            </button>
            <button
              class="project-settings-drawer__nav-item"
              :class="{ 'project-settings-drawer__nav-item--active': projectSettingsTab === 'stakeholders' }"
              type="button"
              @click="projectSettingsTab = 'stakeholders'"
            >
              <span class="project-settings-drawer__nav-item-row">
                <i class="bi bi-people project-settings-drawer__nav-icon"></i>
                Stakeholders
              </span>
            </button>
            <RouterLink
              class="project-settings-drawer__nav-item"
              :to="{ name: 'project-resources', params: { projectId: project.id } }"
              @click="closeProjectSettings"
            >
              <span class="project-settings-drawer__nav-item-row">
                <i class="bi bi-people project-settings-drawer__nav-icon"></i>
                Resources and access
              </span>
            </RouterLink>
          </nav>
          <ProjectDeleteAction v-if="canDeleteProject" :project="project" @deleted="handleProjectDeleted" />
        </div>

        <div class="project-settings-drawer__body">
          <header class="project-settings-drawer__header">
            <h3>
              <template v-if="projectSettingsTab === 'details'">Edit Project</template>
              <template v-else-if="projectSettingsTab === 'comments'">Project Comments</template>
              <template v-else-if="projectSettingsTab === 'files'">File Vault</template>
              <template v-else-if="projectSettingsTab === 'stakeholders'">Project Stakeholders</template>
            </h3>
          </header>

          <section v-if="projectSettingsTab === 'details'" class="project-settings-section">
            <div class="field-group">
              <label>Project Name</label>
              <input v-model="project.name" />
            </div>
            <div class="field-group">
              <label>Project Status</label>
              <select v-model="project.status">
                <option v-for="option in projectStatusOptions" :key="option">{{ option }}</option>
              </select>
            </div>
            <div class="field-row">
              <div class="field-group">
                <label>Start Date</label>
                <input v-model="project.startDate" type="date" />
              </div>
              <div class="field-group">
                <label>End Date</label>
                <input v-model="project.endDate" type="date" />
              </div>
            </div>
            <div class="field-group">
              <label>Project Description</label>
              <RichContentEditor
                v-model="project.description"
                min-height="15rem"
                :project-id="project.id"
                storage-format="markdown"
                :target-id="project.id"
                target-type="project"
                :title="project.name"
                :token="authSession.state.token"
              />
            </div>
            <div class="field-group">
              <label>Project Brief</label>
              <p class="muted-copy">This is the structured committed assistant brief. It stays separate from the short project description above.</p>
            </div>
            <div class="field-group">
              <label>Objective</label>
              <RichContentEditor
                v-model="project.assistantState.brief.objective"
                min-height="10rem"
                :project-id="project.id"
                storage-format="markdown"
                :target-id="project.id"
                target-type="project"
                :title="project.name"
                :token="authSession.state.token"
              />
            </div>
            <div class="field-group">
              <label>Current State</label>
              <RichContentEditor
                v-model="project.assistantState.brief.currentState"
                min-height="10rem"
                :project-id="project.id"
                storage-format="markdown"
                :target-id="project.id"
                target-type="project"
                :title="project.name"
                :token="authSession.state.token"
              />
            </div>
            <div class="field-group">
              <label>Proposed Solution and Scope</label>
              <RichContentEditor
                v-model="project.assistantState.brief.proposedSolution"
                min-height="12rem"
                :project-id="project.id"
                storage-format="markdown"
                :target-id="project.id"
                target-type="project"
                :title="project.name"
                :token="authSession.state.token"
              />
            </div>
            <div class="field-group">
              <label>Benefits</label>
              <RichContentEditor
                v-model="project.assistantState.brief.benefits"
                min-height="10rem"
                :project-id="project.id"
                storage-format="markdown"
                :target-id="project.id"
                target-type="project"
                :title="project.name"
                :token="authSession.state.token"
              />
            </div>
            <div class="field-group">
              <label>Implementation Effort</label>
              <RichContentEditor
                v-model="project.assistantState.brief.implementationEffort"
                min-height="8rem"
                :project-id="project.id"
                storage-format="markdown"
                :target-id="project.id"
                target-type="project"
                :title="project.name"
                :token="authSession.state.token"
              />
            </div>
            <div class="field-group">
              <label>Stakeholders</label>
              <RichContentEditor
                :model-value="projectBriefListMarkdown('stakeholders')"
                min-height="8rem"
                :project-id="project.id"
                storage-format="markdown"
                :target-id="project.id"
                target-type="project"
                :title="project.name"
                :token="authSession.state.token"
                @update:model-value="setProjectBriefListFieldFromMarkdown('stakeholders', $event)"
              />
            </div>
            <div class="field-group">
              <label>Requirements</label>
              <RichContentEditor
                :model-value="projectBriefListMarkdown('requirements')"
                min-height="12rem"
                :project-id="project.id"
                storage-format="markdown"
                :target-id="project.id"
                target-type="project"
                :title="project.name"
                :token="authSession.state.token"
                @update:model-value="setProjectBriefListFieldFromMarkdown('requirements', $event)"
              />
            </div>
            <div class="field-group">
              <label>Dependencies</label>
              <RichContentEditor
                :model-value="projectBriefListMarkdown('dependencies')"
                min-height="8rem"
                :project-id="project.id"
                storage-format="markdown"
                :target-id="project.id"
                target-type="project"
                :title="project.name"
                :token="authSession.state.token"
                @update:model-value="setProjectBriefListFieldFromMarkdown('dependencies', $event)"
              />
            </div>
            <div class="field-group">
              <label>Constraints</label>
              <RichContentEditor
                :model-value="projectBriefListMarkdown('constraints')"
                min-height="8rem"
                :project-id="project.id"
                storage-format="markdown"
                :target-id="project.id"
                target-type="project"
                :title="project.name"
                :token="authSession.state.token"
                @update:model-value="setProjectBriefListFieldFromMarkdown('constraints', $event)"
              />
            </div>
            <div class="field-group">
              <label>Success Metrics</label>
              <RichContentEditor
                :model-value="projectBriefListMarkdown('successMetrics')"
                min-height="8rem"
                :project-id="project.id"
                storage-format="markdown"
                :target-id="project.id"
                target-type="project"
                :title="project.name"
                :token="authSession.state.token"
                @update:model-value="setProjectBriefListFieldFromMarkdown('successMetrics', $event)"
              />
            </div>
            <div class="field-group">
              <label>Assumptions</label>
              <RichContentEditor
                :model-value="projectBriefListMarkdown('assumptions')"
                min-height="8rem"
                :project-id="project.id"
                storage-format="markdown"
                :target-id="project.id"
                target-type="project"
                :title="project.name"
                :token="authSession.state.token"
                @update:model-value="setProjectBriefListFieldFromMarkdown('assumptions', $event)"
              />
            </div>
          </section>

          <ProjectCommentsPanel
            v-else-if="projectSettingsTab === 'comments'"
            :api-base-url="authSession.state.apiBaseUrl"
            :current-user-id="currentUserId"
            :current-user-role="currentUserRole"
            :project-id="project.id"
            :target-id="project.id"
            target-type="project"
            :token="authSession.state.token"
          />

          <ProjectFileTree
            v-else-if="projectSettingsTab === 'files'"
            :focus-file-id="String(route.query.file ?? '')"
            :focus-signing-id="String(route.query.signing ?? '')"
            :project-id="project.id"
            :token="authSession.state.token"
            @navigate="closeProjectSettings"
          />

          <section v-else-if="projectSettingsTab === 'stakeholders'" class="project-settings-section">
            <ProjectStakeholdersPanel :project-id="project.id" />
          </section>

        </div>

        <footer class="project-settings-drawer__footer">
          <button
            v-if="canExportProject"
            class="secondary-button"
            type="button"
            :disabled="projectExporting"
            @click="handleExportProject"
          >
            <i class="bi bi-download" aria-hidden="true"></i>
            {{ projectExporting ? 'Exporting...' : 'Export' }}
          </button>
          <button class="secondary-button" type="button" @click="closeProjectSettings">Cancel</button>
          <button class="primary-button" type="button" :disabled="projectStore.state.saving" @click="handleSaveProject">
            {{ projectStore.state.saving ? 'Saving...' : 'Save Project' }}
          </button>
        </footer>
      </aside>

      <div v-if="hasUnsavedChanges" class="workbench-save-bar">
        <div>
          <p class="card-eyebrow">Unsaved changes</p>
          <strong>Draft differs from the last saved project state.</strong>
        </div>
        <div class="actions-row">
          <button class="ghost-button" type="button" @click="handleRevertProject">Revert draft</button>
          <button class="primary-button" type="button" :disabled="projectStore.state.saving" @click="handleSaveProject">
            {{ projectStore.state.saving ? 'Saving...' : 'Save project' }}
          </button>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.project-pursuit {
  display: grid;
  gap: 1.25rem;
  min-width: 0;
}

.project-workbench-toolbar {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.8rem;
  margin-top: 0.75rem;
  padding: 0.72rem 0.82rem;
  border: 1px solid var(--line);
  border-radius: 1rem;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(246, 249, 253, 0.94));
}

.project-workbench-toolbar__trigger {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 2.4rem;
  padding: 0.55rem 0.9rem;
  border: 0;
  border-radius: 999px;
  background: #0f172a;
  color: #fff;
  font-size: 0.76rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  white-space: nowrap;
}

.project-workbench-toolbar__trigger--active {
  background: #1d4ed8;
}

.project-workbench-toolbar__context {
  min-width: 0;
  display: grid;
  gap: 0.12rem;
}

.project-workbench-toolbar__eyebrow {
  color: var(--muted);
  font-size: 0.7rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.project-workbench-toolbar__selection {
  min-width: 0;
  color: var(--ink);
  font-size: 0.96rem;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-workbench-toolbar__meta {
  display: inline-flex;
  align-items: center;
  min-height: 2.2rem;
  padding: 0.42rem 0.72rem;
  border-radius: 999px;
  background: rgba(37, 99, 235, 0.08);
  color: #35507a;
  font-size: 0.76rem;
  font-weight: 700;
  white-space: nowrap;
}

.project-workbench-outline-backdrop {
  position: fixed;
  top: 5rem;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 69;
  border: 0;
  background: linear-gradient(90deg, rgba(15, 23, 42, 0.12) 0%, rgba(15, 23, 42, 0.06) 54%, rgba(15, 23, 42, 0) 100%);
}

@media (max-width: 1280px) {
  .project-workbench.project-workbench--outline-callable {
    grid-template-columns: minmax(0, 1fr);
  }

  .project-workbench-toolbar {
    position: sticky;
    top: 5rem;
    z-index: 30;
    padding: 0.72rem 0.82rem;
    background: var(--surface);
  }
}

@media (max-width: 760px) {
  .project-workbench-toolbar {
    grid-template-columns: 1fr;
  }

  .project-workbench-toolbar__trigger {
    width: 100%;
    justify-content: center;
  }

  .project-workbench-toolbar__context,
  .project-workbench-toolbar__selection,
  .project-workbench-toolbar__meta {
    width: 100%;
  }
}
</style>
