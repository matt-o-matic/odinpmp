import { reactive } from 'vue';

import { withWorkingMode } from '../api/client.js';
import { usesChildEstimates } from './work-estimates.js';

function sortProjects(projects) {
  return [...projects].sort((left, right) => {
    if (left.rank == null && right.rank != null) {
      return 1;
    }

    if (left.rank != null && right.rank == null) {
      return -1;
    }

    if (left.rank != null && right.rank != null && left.rank !== right.rank) {
      return left.rank - right.rank;
    }

    return left.name.localeCompare(right.name);
  });
}

function summarizeProject(project) {
  return {
    createdAt: project.createdAt ?? null,
    description: project.description ?? '',
    endDate: project.endDate ?? null,
    id: project.id,
    name: project.name,
    rank: project.rank ?? null,
    role: project.role ?? 'admin',
    startDate: project.startDate ?? null,
    status: project.status,
    tenantId: project.tenantId,
    updatedAt: project.updatedAt ?? null,
  };
}

function upsertProjectSummary(projects, project) {
  const summary = summarizeProject(project);
  const index = projects.findIndex((item) => item.id === project.id);

  if (index === -1) {
    return sortProjects([...projects, summary]);
  }

  const nextProjects = [...projects];
  nextProjects[index] = {
    ...nextProjects[index],
    ...summary,
  };

  return sortProjects(nextProjects);
}

function preserveProjectAssistantState(project, existingProject) {
  if (!project || project.assistantState || project.id !== existingProject?.id || !existingProject?.assistantState) {
    return project;
  }

  return {
    ...project,
    assistantState: existingProject.assistantState,
  };
}

function flattenProjectItems(project) {
  const items = [];
  const add = (node, itemType, parentId, position) => {
    const { stories: _stories, tasks: _tasks, updatedAt: _updatedAt, version, ...item } = node;
    items.push({
      depth: itemType === 'epic' ? 0 : itemType === 'story' ? 1 : 2,
      id: node.id,
      item,
      itemType,
      parentId,
      position,
      rollsUp: usesChildEstimates(node),
      version: Number(version ?? 1),
    });
  };
  for (const [epicIndex, epic] of (project?.epics ?? []).entries()) {
    add(epic, 'epic', null, epicIndex);
    for (const [storyIndex, story] of (epic.stories ?? []).entries()) {
      add(story, 'story', epic.id, storyIndex);
      for (const [taskIndex, task] of (story.tasks ?? []).entries()) add(task, 'task', story.id, taskIndex);
    }
  }
  return items;
}

// Rolled-up points and hours follow the children, so a child's edit is not a parent edit.
function comparableProjectItem(entry) {
  const copy = { ...entry.item };
  delete copy.assigneeName;
  delete copy.progress;
  if (entry.rollsUp) {
    delete copy.points;
    delete copy.targetHourEstimate;
  }
  return copy;
}

function buildProjectItemMutations(currentProject, nextProject) {
  const current = flattenProjectItems(currentProject);
  const next = flattenProjectItems(nextProject);
  const currentById = new Map(current.map((item) => [item.id, item]));
  const nextById = new Map(next.map((item) => [item.id, item]));
  const deletes = current.filter((item) => !nextById.has(item.id)).sort((left, right) => right.depth - left.depth);
  const creates = next.filter((item) => !currentById.has(item.id)).sort((left, right) => left.depth - right.depth);
  const updates = next.filter((item) => {
    const existing = currentById.get(item.id);
    return existing && projectItemChanged(existing, item);
  });
  return { creates, deletes, updates };
}

function projectItemChanged(existing, item) {
  return existing.parentId !== item.parentId
    || existing.position !== item.position
    || JSON.stringify(comparableProjectItem(existing)) !== JSON.stringify(comparableProjectItem(item));
}

export function createProjectStore({ apiClient, authSession }) {
  const state = reactive({
    activeProject: null,
    activeProjectPermissions: { canDelete: false },
    loading: false,
    // One-shot message for the next screen, such as the project list after a delete.
    notice: '',
    projects: [],
    saving: false,
  });

  return {
    state,
    // `background` is for prefetches the user did not ask for, such as warming the nav dropdown.
    async loadProjects({ background = false } = {}) {
      if (!authSession.state.token) {
        throw new Error('Authentication is required to load projects.');
      }

      state.loading = true;

      try {
        const client = background ? withWorkingMode(apiClient, 'passive') : apiClient;
        const result = await client.getProjects(authSession.state.token);
        state.projects = result.projects;
        return result.projects;
      } finally {
        state.loading = false;
      }
    },
    async loadProject(projectId) {
      if (!authSession.state.token) {
        throw new Error('Authentication is required to load a project.');
      }

      state.loading = true;

      try {
        const result = await apiClient.getProject(projectId, authSession.state.token);
        state.activeProject = result.project;
        // canManage: project or workspace admin or manager, who also see billing.
        state.activeProjectPermissions = { canDelete: Boolean(result.permissions?.canDelete), canManage: Boolean(result.permissions?.canManage) };
        return result.project;
      } finally {
        state.loading = false;
      }
    },
    async createProject(payload) {
      if (!authSession.state.token) {
        throw new Error('Authentication is required to create a project.');
      }

      state.saving = true;

      try {
        const result = await apiClient.createProject(payload, authSession.state.token);
        state.activeProject = result.project;
        state.projects = upsertProjectSummary(state.projects, result.project);
        return result.project;
      } finally {
        state.saving = false;
      }
    },
    async deleteProject(projectId) {
      if (!authSession.state.token) {
        throw new Error('Authentication is required to delete a project.');
      }

      const result = await apiClient.deleteProject(projectId, authSession.state.token);
      const name = result.project?.name ?? state.projects.find((project) => project.id === projectId)?.name ?? 'The project';
      // The open project view navigates away itself; clearing activeProject here would
      // unmount the delete action before it can report success.
      state.projects = state.projects.filter((project) => project.id !== projectId);
      state.notice = `Deleted ${name}. A tenant admin can restore it from Tenant Admin, Deleted Projects.`;
      return result.project;
    },
    takeNotice() {
      const notice = state.notice;
      state.notice = '';
      return notice;
    },
    async saveProject(projectId, payload) {
      if (!authSession.state.token) {
        throw new Error('Authentication is required to update a project.');
      }

      state.saving = true;

      try {
        const result = await apiClient.updateProject(projectId, payload, authSession.state.token);
        const project = preserveProjectAssistantState(result.project, state.activeProject);
        state.activeProject = project;
        state.projects = upsertProjectSummary(state.projects, project);
        return project;
      } finally {
        state.saving = false;
      }
    },
    async saveProjectAssistantBrief(projectId, payload) {
      if (!authSession.state.token) {
        throw new Error('Authentication is required to update a project brief.');
      }

      state.saving = true;

      try {
        const result = await apiClient.updateProjectAssistantBrief(projectId, payload, authSession.state.token);
        const project = preserveProjectAssistantState(result.project, state.activeProject);
        state.activeProject = project;
        state.projects = upsertProjectSummary(state.projects, project);
        return project;
      } finally {
        state.saving = false;
      }
    },
    async saveProjectTree(projectId, payload) {
      if (!authSession.state.token) {
        throw new Error('Authentication is required to update project tasks.');
      }

      state.saving = true;

      try {
        const result = await apiClient.updateProjectTree(projectId, payload, authSession.state.token);
        const project = preserveProjectAssistantState(result.project, state.activeProject);
        state.activeProject = project;
        state.projects = upsertProjectSummary(state.projects, project);
        return project;
      } finally {
        state.saving = false;
      }
    },
    async saveProjectItems(projectId, nextProject) {
      if (!authSession.state.token) throw new Error('Authentication is required to update project tasks.');
      state.saving = true;
      try {
        const mutations = buildProjectItemMutations(state.activeProject, nextProject);
        let result = { project: state.activeProject };
        for (const item of mutations.deletes) {
          result = await apiClient.deleteProjectItem(projectId, item.id, { expectedVersion: item.version }, authSession.state.token);
        }
        for (const item of mutations.creates) {
          const { workItemTemplateId, ...fields } = item.item;
          result = await apiClient.createProjectItem(projectId, {
            item: fields,
            itemType: item.itemType,
            parentId: item.parentId,
            position: item.position,
            ...(workItemTemplateId ? { templateId: workItemTemplateId } : {}),
          }, authSession.state.token);
        }
        for (const item of mutations.updates) {
          const existing = flattenProjectItems(result.project).find((candidate) => candidate.id === item.id)
            ?? flattenProjectItems(state.activeProject).find((candidate) => candidate.id === item.id);
          // An earlier write in this save can already have made this change on the server
          // (completing a story completes its tasks), so skip writes that would change nothing.
          if (existing && !projectItemChanged(existing, item)) continue;
          result = await apiClient.updateProjectItem(projectId, item.id, {
            expectedVersion: existing?.version ?? item.version,
            parentId: item.parentId,
            patch: item.item,
            position: item.position,
          }, authSession.state.token);
        }
        const project = preserveProjectAssistantState(result.project, state.activeProject);
        state.activeProject = project;
        state.projects = upsertProjectSummary(state.projects, project);
        return project;
      } finally {
        state.saving = false;
      }
    },
  };
}
