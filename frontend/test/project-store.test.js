import assert from 'node:assert/strict';
import test from 'node:test';

import { createProjectStore } from '../src/lib/projects/project-store.js';

test('loadProjects stores the fetched project summaries', async () => {
  const store = createProjectStore({
    apiClient: {
      async getProjects(token) {
        assert.equal(token, 'session-token');
        return {
          projects: [{ id: 'project-1', name: 'Launch Readiness' }],
        };
      },
    },
    authSession: {
      state: {
        token: 'session-token',
      },
    },
  });

  await store.loadProjects();

  assert.equal(store.state.projects.length, 1);
  assert.equal(store.state.projects[0].name, 'Launch Readiness');
});

test('loadProject stores the active project detail', async () => {
  const store = createProjectStore({
    apiClient: {
      async getProject(projectId, token) {
        assert.equal(projectId, 'project-1');
        assert.equal(token, 'session-token');
        return {
          project: {
            epics: [],
            id: 'project-1',
            name: 'Launch Readiness',
          },
        };
      },
    },
    authSession: {
      state: {
        token: 'session-token',
      },
    },
  });

  await store.loadProject('project-1');

  assert.equal(store.state.activeProject.id, 'project-1');
  assert.equal(store.state.activeProject.name, 'Launch Readiness');
});

test('createProject stores the new active project and updates the project list', async () => {
  const store = createProjectStore({
    apiClient: {
      async createProject(payload, token) {
        assert.equal(token, 'session-token');
        assert.equal(payload.name, 'Admin Rebuild');

        return {
          project: {
            description: 'Replace the legacy admin dashboard.',
            epics: [],
            id: 'project-2',
            name: 'Admin Rebuild',
            role: 'admin',
            status: 'Planned',
            tenantId: 'tenant-acme',
          },
        };
      },
    },
    authSession: {
      state: {
        token: 'session-token',
      },
    },
  });

  const project = await store.createProject({
    name: 'Admin Rebuild',
  });

  assert.equal(project.id, 'project-2');
  assert.equal(store.state.activeProject.id, 'project-2');
  assert.equal(store.state.projects.length, 1);
  assert.equal(store.state.projects[0].name, 'Admin Rebuild');
});

test('saveProject and saveProjectTree refresh the active project and list summary', async () => {
  const store = createProjectStore({
    apiClient: {
      async updateProject(projectId, payload, token) {
        assert.equal(projectId, 'project-1');
        assert.equal(token, 'session-token');
        assert.equal(payload.status, 'At Risk');

        return {
          project: {
            description: payload.description,
            epics: [],
            id: projectId,
            name: payload.name,
            role: 'admin',
            status: payload.status,
            tenantId: 'tenant-acme',
          },
        };
      },
      async updateProjectTree(projectId, payload, token) {
        assert.equal(projectId, 'project-1');
        assert.equal(token, 'session-token');
        assert.equal(payload.epics.length, 1);

        return {
          project: {
            description: 'Updated',
            epics: payload.epics,
            id: projectId,
            name: 'Launch Readiness Revamp',
            role: 'admin',
            status: 'At Risk',
            tenantId: 'tenant-acme',
          },
        };
      },
    },
    authSession: {
      state: {
        token: 'session-token',
      },
    },
  });
  store.state.activeProject = {
    assistantState: {
      brief: {
        narrative: 'Full committed brief.',
      },
    },
    id: 'project-1',
  };

  await store.saveProject('project-1', {
    description: 'Updated',
    name: 'Launch Readiness Revamp',
    status: 'At Risk',
  });

  assert.equal(store.state.activeProject.status, 'At Risk');
  assert.equal(store.state.activeProject.assistantState.brief.narrative, 'Full committed brief.');
  assert.equal(store.state.projects[0].name, 'Launch Readiness Revamp');

  await store.saveProjectTree('project-1', {
    epics: [
      {
        id: 'epic-1',
        name: 'Execution',
        stories: [],
      },
    ],
  });

  assert.equal(store.state.activeProject.epics[0].name, 'Execution');
  assert.equal(store.state.activeProject.assistantState.brief.narrative, 'Full committed brief.');
  assert.equal(store.state.projects[0].status, 'At Risk');
});

test('saveProjectItems uses granular optimistic mutations instead of whole-tree replacement', async () => {
  const calls = [];
  const baseProject = {
    epics: [{ id: 'epic-1', name: 'Execution', status: 'Not Started', version: 1, stories: [{ id: 'story-1', name: 'Existing story', status: 'Not Started', version: 2, tasks: [] }] }],
    id: 'project-1', name: 'Launch', status: 'In Progress', tenantId: 'tenant-acme', updatedAt: '2026-07-11T10:00:00.000Z',
  };
  let serverProject = JSON.parse(JSON.stringify(baseProject));
  const store = createProjectStore({
    apiClient: {
      async createProjectItem(projectId, payload) {
        calls.push(['create', projectId, payload]);
        serverProject.epics[0].stories.push({ ...payload.item, version: 1, tasks: [] });
        return { project: serverProject };
      },
      async updateProjectItem(projectId, itemId, payload) {
        calls.push(['update', projectId, itemId, payload]);
        const story = serverProject.epics[0].stories.find((item) => item.id === itemId);
        Object.assign(story, payload.patch, { version: story.version + 1 });
        return { project: serverProject };
      },
      async deleteProjectItem() { throw new Error('unexpected delete'); },
    },
    authSession: { state: { token: 'session-token' } },
  });
  store.state.activeProject = baseProject;
  const nextProject = JSON.parse(JSON.stringify(baseProject));
  nextProject.epics[0].stories[0].name = 'Renamed story';
  nextProject.epics[0].stories.push({ id: 'story-2', name: 'New story', status: 'Not Started', tasks: [] });

  const saved = await store.saveProjectItems('project-1', nextProject);

  assert.deepEqual(calls.map((call) => call[0]), ['create', 'update']);
  assert.equal(calls[1][3].expectedVersion, 2);
  assert.equal(saved.epics[0].stories[0].name, 'Renamed story');
  assert.equal(saved.epics[0].stories[1].version, 1);
});

test('saveProjectItems skips task writes the server already made while saving their story', async () => {
  const calls = [];
  const baseProject = {
    epics: [{
      id: 'epic-1', name: 'Execution', status: 'In Progress', version: 1,
      stories: [{
        id: 'story-1', name: 'Story', status: 'In Progress', version: 1,
        tasks: [{ boardColumn: 'doing', id: 'task-1', name: 'Task', status: 'In Progress', version: 1 }],
      }],
    }],
    id: 'project-1', name: 'Launch', status: 'In Progress', tenantId: 'tenant-acme', updatedAt: '2026-07-11T10:00:00.000Z',
  };
  const serverProject = JSON.parse(JSON.stringify(baseProject));
  const store = createProjectStore({
    apiClient: {
      async createProjectItem() { throw new Error('unexpected create'); },
      async deleteProjectItem() { throw new Error('unexpected delete'); },
      async updateProjectItem(projectId, itemId, payload) {
        calls.push(itemId);
        const story = serverProject.epics[0].stories[0];
        Object.assign(story, { status: payload.patch.status, version: story.version + 1 });
        // The server completes the story's open tasks in the same write.
        Object.assign(story.tasks[0], { boardColumn: null, status: 'Completed', version: 2 });
        return { project: serverProject };
      },
    },
    authSession: { state: { token: 'session-token' } },
  });
  store.state.activeProject = baseProject;
  const nextProject = JSON.parse(JSON.stringify(baseProject));
  nextProject.epics[0].stories[0].status = 'Completed';
  Object.assign(nextProject.epics[0].stories[0].tasks[0], { boardColumn: null, status: 'Completed' });

  const saved = await store.saveProjectItems('project-1', nextProject);

  assert.deepEqual(calls, ['story-1']);
  assert.equal(saved.epics[0].stories[0].tasks[0].status, 'Completed');
});

test('saveProjectAssistantBrief refreshes the active project detail while keeping the project summary intact', async () => {
  const store = createProjectStore({
    apiClient: {
      async updateProjectAssistantBrief(projectId, payload, token) {
        assert.equal(projectId, 'project-1');
        assert.equal(token, 'session-token');
        assert.equal(payload.objective, 'Show the rich brief separately from the short description.');
        return {
          project: {
            assistantState: {
              brief: {
                ...payload,
                committedAt: '2026-05-27T12:46:09.789Z',
                narrative: 'Legacy short summary.',
                sourceSessionId: 'session-123',
              },
            },
            description: 'Short project description.',
            epics: [],
            id: 'project-1',
            name: 'Launch Readiness',
            role: 'admin',
            status: 'In Progress',
            tenantId: 'tenant-acme',
          },
        };
      },
    },
    authSession: {
      state: {
        token: 'session-token',
      },
    },
  });
  store.state.projects = [{
    id: 'project-1',
    name: 'Launch Readiness',
    status: 'In Progress',
  }];
  store.state.activeProject = {
    assistantState: {
      brief: {
        objective: 'Old objective.',
      },
    },
    description: 'Short project description.',
    epics: [],
    id: 'project-1',
    name: 'Launch Readiness',
    role: 'admin',
    status: 'In Progress',
    tenantId: 'tenant-acme',
  };

  await store.saveProjectAssistantBrief('project-1', {
    assumptions: ['Keep the short description independent.'],
    benefits: 'Makes the committed brief editable.',
    constraints: ['Do not overwrite the short description.'],
    currentState: 'Rich brief exists separately from the short description.',
    dependencies: ['Assistant state route'],
    implementationEffort: 'Medium',
    name: 'Launch Readiness',
    objective: 'Show the rich brief separately from the short description.',
    proposedSolution: 'Render assistantState.brief in the relevant surfaces.',
    requirements: ['Manual edits save through the new project brief endpoint.'],
    stakeholders: ['Executive Sponsor'],
    successMetrics: ['Reload preserves the rich brief.'],
  });

  assert.equal(
    store.state.activeProject.assistantState.brief.objective,
    'Show the rich brief separately from the short description.',
  );
  assert.equal(store.state.activeProject.description, 'Short project description.');
  assert.equal(store.state.projects[0].name, 'Launch Readiness');
});

test('saveProjectItems sends a chosen work-item template with the create call', async () => {
  const calls = [];
  const baseProject = { epics: [{ id: 'epic-1', name: 'Execution', status: 'Not Started', stories: [], version: 1 }], id: 'project-1', name: 'Launch', updatedAt: '2026-07-11T10:00:00.000Z' };
  const store = createProjectStore({
    apiClient: {
      async createProjectItem(projectId, payload) {
        calls.push(payload);
        return { project: baseProject };
      },
    },
    authSession: { state: { token: 'session-token' } },
  });
  store.state.activeProject = baseProject;
  const nextProject = JSON.parse(JSON.stringify(baseProject));
  nextProject.epics[0].stories.push({ id: 'story-2', name: 'Spike', status: 'Not Started', tasks: [], workItemTemplateId: 'template-1' });

  await store.saveProjectItems('project-1', nextProject);

  assert.equal(calls[0].templateId, 'template-1');
  assert.equal('workItemTemplateId' in calls[0].item, false);
});
