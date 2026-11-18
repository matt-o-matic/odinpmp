import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  describeProjectDeleteError,
  filterDeletedProjects,
  paginate,
  projectNameConfirmed,
} from '../src/lib/projects/project-deletion.js';
import { createProjectStore } from '../src/lib/projects/project-store.js';

function read(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

test('the delete confirmation needs the exact project name', () => {
  assert.equal(projectNameConfirmed('Alpha Launch', 'Alpha Launch'), true);
  assert.equal(projectNameConfirmed('  Alpha Launch ', 'Alpha Launch'), true);
  assert.equal(projectNameConfirmed('alpha launch', 'Alpha Launch'), false);
  assert.equal(projectNameConfirmed('Alpha', 'Alpha Launch'), false);
  assert.equal(projectNameConfirmed('', ''), false);
});

test('delete errors explain legal holds and permissions in plain words', () => {
  assert.match(describeProjectDeleteError({ status: 423 }), /legal hold/);
  assert.match(describeProjectDeleteError({ status: 403 }), /admins or managers/);
  assert.match(describeProjectDeleteError({ status: 404 }), /no longer exists/);
  assert.equal(describeProjectDeleteError({ message: 'Server down', status: 500 }), 'Server down');
});

test('deleted project list filters, sorts and paginates', () => {
  const projects = [
    { deletedAt: '2026-10-01T10:00:00.000Z', deletedByName: 'Ada Admin', id: 'a', name: 'Zeta' },
    { deletedAt: '2026-10-03T10:00:00.000Z', deletedByName: 'Pat Manager', id: 'b', name: 'Alpha' },
    { deletedAt: '2026-10-02T10:00:00.000Z', deletedByName: 'Ada Admin', id: 'c', name: 'Mid' },
  ];
  assert.deepEqual(filterDeletedProjects(projects).map((project) => project.id), ['b', 'c', 'a']);
  assert.deepEqual(filterDeletedProjects(projects, { sort: 'name' }).map((project) => project.id), ['b', 'c', 'a']);
  assert.deepEqual(filterDeletedProjects(projects, { query: 'ada' }).map((project) => project.id), ['c', 'a']);
  assert.deepEqual(filterDeletedProjects(projects, { query: 'zeta' }).map((project) => project.id), ['a']);

  const many = Array.from({ length: 23 }, (_, index) => index);
  assert.deepEqual(paginate(many, 1, 10).items, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(paginate(many, 3, 10).items.length, 3);
  assert.equal(paginate(many, 9, 10).page, 3);
  assert.equal(paginate([], 1, 10).pageCount, 1);
});

test('project store keeps delete permission and removes a deleted project with a notice', async () => {
  const calls = [];
  const store = createProjectStore({
    apiClient: {
      async deleteProject(projectId, token) {
        calls.push([projectId, token]);
        return { project: { id: projectId, name: 'Alpha Launch' } };
      },
      async getProject() {
        return { permissions: { canDelete: true }, project: { epics: [], id: 'project-a', name: 'Alpha Launch' } };
      },
    },
    authSession: { state: { token: 'session-token' } },
  });
  store.state.projects = [{ id: 'project-a', name: 'Alpha Launch' }, { id: 'project-b', name: 'Beta' }];

  await store.loadProject('project-a');
  assert.equal(store.state.activeProjectPermissions.canDelete, true);

  await store.deleteProject('project-a');
  assert.deepEqual(calls, [['project-a', 'session-token']]);
  assert.deepEqual(store.state.projects.map((project) => project.id), ['project-b']);
  assert.match(store.takeNotice(), /^Deleted Alpha Launch\./);
  assert.equal(store.takeNotice(), '');
});

test('project store leaves the list alone when the delete fails', async () => {
  const store = createProjectStore({
    apiClient: {
      async deleteProject() {
        throw Object.assign(new Error('A record-scoped legal hold blocks this change.'), { status: 423 });
      },
    },
    authSession: { state: { token: 'session-token' } },
  });
  store.state.projects = [{ id: 'project-a', name: 'Alpha Launch' }];
  await assert.rejects(store.deleteProject('project-a'), (error) => error.status === 423);
  assert.equal(store.state.projects.length, 1);
  assert.equal(store.state.notice, '');
});

test('project settings offer a separate, permission-gated Delete project action', () => {
  const view = read('../src/views/ProjectDetailView.vue');
  const action = read('../src/components/projects/ProjectDeleteAction.vue');
  assert.match(view, /const canDeleteProject = computed\(\(\) => projectStore\.state\.activeProjectPermissions\?\.canDelete === true\);/);
  assert.match(view, /<\/nav>\s*<ProjectDeleteAction v-if="canDeleteProject" :project="project" @deleted="handleProjectDeleted" \/>/);
  // The store keeps the active project until the view has left, so the action stays mounted to report success.
  assert.match(view, /async function handleProjectDeleted\(\) \{[\s\S]*?await router\.push\(\{ name: 'projects' \}\);\s*projectStore\.state\.activeProject = null;/);
  // A live update for a project that was deleted elsewhere says so instead of failing silently.
  assert.match(view, /error\?\.status === 404[\s\S]*?This project was deleted or you no longer have access to it\./);

  assert.match(action, /<RequirementsConfirmDialog[\s\S]*?:confirm-disabled="!confirmed"/);
  assert.match(action, /Type the project name to confirm/);
  assert.match(action, /projectStore\.deleteProject\(props\.project\.id\)/);
  assert.doesNotMatch(action, /window\.(confirm|alert)|\balert\(/);
  // The only title is the dialog heading, not a hover tooltip.
  assert.deepEqual(action.match(/\btitle="[^"]*"/g), ['title="Delete this project?"']);
  assert.match(action, /min-height: 2\.75rem/);
  assert.match(action, /:root\.dark \.project-delete-action__button \{/);
});

test('the confirm dialog can hold its confirm button until the caller allows it', () => {
  const dialog = read('../src/components/requirements/RequirementsConfirmDialog.vue');
  assert.match(dialog, /confirmDisabled: \{ default: false, type: Boolean \}/);
  assert.match(dialog, /@submit="!confirmDisabled && emit\('confirm'\)"/);
  assert.match(dialog, /:disabled="busy \|\| confirmDisabled"/);
});

test('the projects list shows the delete notice once', () => {
  const view = read('../src/views/ProjectsView.vue');
  assert.match(view, /const noticeMessage = ref\(projectStore\.takeNotice\(\)\);/);
  assert.match(view, /<div v-if="noticeMessage" class="success-banner[^"]*"[^>]*role="status"/);
  assert.match(view, /aria-label="Dismiss message"/);
});

test('tenant admin has a focused Deleted Projects panel with confirmed restore', () => {
  const admin = read('../src/views/AdminView.vue');
  const panel = read('../src/components/admin/DeletedProjectsPanel.vue');
  assert.match(admin, /import DeletedProjectsPanel from '\.\.\/components\/admin\/DeletedProjectsPanel\.vue';/);
  assert.match(admin, /section = 'deleted-projects'/);
  assert.match(admin, /<DeletedProjectsPanel v-else-if="section === 'deleted-projects'" \/>/);

  assert.match(panel, /apiClient\.listDeletedProjects\(authSession\.state\.token\)/);
  assert.match(panel, /apiClient\.restoreDeletedProject\(target\.id, authSession\.state\.token\)/);
  assert.match(panel, /<RequirementsConfirmDialog[\s\S]*?title="Restore this project\?"/);
  assert.match(panel, /type="search"/);
  assert.match(panel, /DELETED_PROJECT_SORTS/);
  assert.match(panel, /aria-label="Deleted projects pages"/);
  assert.match(panel, /:aria-label="`Restore \$\{project\.name\}`"/);
  assert.doesNotMatch(panel, /window\.(confirm|alert)|\balert\(/);
  assert.deepEqual(panel.match(/\btitle="[^"]*"/g), ['title="Restore this project?"']);
});
