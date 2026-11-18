import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(
  new URL('../src/App.vue', import.meta.url),
  'utf8',
);

const homeSource = readFileSync(
  new URL('../src/views/HomeView.vue', import.meta.url),
  'utf8',
);

const projectsSource = readFileSync(
  new URL('../src/views/ProjectsView.vue', import.meta.url),
  'utf8',
);

test('app shell keeps a single global AI workspace launcher in the top navigation', () => {
  assert.match(appSource, /AI Workspace/);
  // Home opens the AI Workspace only on a session it staged for review (a recovery proposal).
  assert.doesNotMatch(homeSource, /Launch AI Workspace|openAssistantWorkspace|mode: 'create-project'/);
  assert.match(homeSource, /buildAssistantRouteQuery\(route\.query, \{ open: true, sessionId: result\.assistantSessionId \}\)/);
  assert.equal(projectsSource.includes('Launch AI Workspace'), false);
});

test('app shell falls back cleanly when the profile image fails to load', () => {
  assert.match(appSource, /const avatarFailed = ref\(false\)/);
  assert.match(appSource, /const showAvatarImage = computed/);
  assert.match(appSource, /@error="handleAvatarError"/);
  assert.match(appSource, /bi bi-person-fill/);
});
