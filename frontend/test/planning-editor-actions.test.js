import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const workbenchEditorSource = readFileSync(
  new URL('../src/components/projects/ProjectWorkbenchEditor.vue', import.meta.url),
  'utf8',
);

const taskTableSource = readFileSync(
  new URL('../src/components/projects/ProjectTaskTable.vue', import.meta.url),
  'utf8',
);

function extractStoryCommandSection(source) {
  const match = source.match(/<div[^>]*aria-label="Story commands"[^>]*>([\s\S]*?)<\/div>/);
  return match?.[1] ?? '';
}

test('story header command group excludes task creation and generation actions', () => {
  const storyCommands = extractStoryCommandSection(workbenchEditorSource);
  assert.ok(storyCommands, 'expected story command group in workbench editor');
  assert.equal(storyCommands.includes('Add task'), false);
  assert.equal(storyCommands.includes('Generate tasks'), false);
});

test('task table header owns both add-task and generate-tasks actions', () => {
  assert.match(taskTableSource, /Add task/);
  assert.match(taskTableSource, /Generate tasks/);
});

test('project overview renders project-scoped assistant brief', () => {
  assert.match(workbenchEditorSource, /currentItem\.value\?\.assistantState\?\.brief/);
  assert.match(workbenchEditorSource, /Project Brief/);
  assert.match(workbenchEditorSource, /projectBriefHtml/);
});
