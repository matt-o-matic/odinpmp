import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('../src/views/ProjectDetailView.vue', import.meta.url),
  'utf8',
);

test('project details source keeps short description editing separate from project brief editing', () => {
  assert.match(source, /Project Description/);
  assert.match(source, /Project Brief/);
  assert.match(source, /projectStore\.saveProjectAssistantBrief/);
});

test('project detail has no clarifications card or settings tab and sends old clarification links to Requirements', () => {
  assert.doesNotMatch(source, /ProjectClarificationsPanel/);
  assert.doesNotMatch(source, /projectSettingsTab === 'clarifications'/);
  assert.doesNotMatch(source, /clarificationStats/);
  assert.match(source, /const PROJECT_SETTINGS_TABS = new Set\(\['details', 'comments', 'files', 'stakeholders'\]\);/);
  // Permissions became the project's Resources tab; old settings links land there.
  assert.match(source, /nextTab\.toLowerCase\(\) === 'permissions'[\s\S]*?router\.replace\(\{ name: 'project-resources', params: \{ projectId \} \}\)/);
  assert.match(source, /nextTab\.toLowerCase\(\) === 'clarifications'[\s\S]*?router\.replace\(\{ name: 'project-requirements', params: \{ projectId \} \}\)/);
  // Stakeholder contacts for the Requirements pickers still come from this load.
  assert.match(source, /projectContacts\.load\(projectId\)/);
});

test('project details source removes the redundant brief name field and uses rich editors for multi-line brief fields', () => {
  assert.doesNotMatch(source, /Brief Name/);
  assert.match(source, /setProjectBriefListFieldFromMarkdown/);
  assert.equal((source.match(/<RichContentEditor/g) ?? []).length >= 7, true);
  assert.doesNotMatch(source, /textarea v-model="project\.assistantState\.brief\.objective"/);
});
