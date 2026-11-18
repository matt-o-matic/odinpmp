import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const projectsViewSource = readFileSync(
  new URL('../src/views/ProjectsView.vue', import.meta.url),
  'utf8',
);
const appSource = readFileSync(
  new URL('../src/App.vue', import.meta.url),
  'utf8',
);

test('project import closes the Bootstrap offcanvas before navigating to the imported project', () => {
  assert.match(projectsViewSource, /import \{ Offcanvas \} from 'bootstrap';/);
  assert.match(projectsViewSource, /function closeImportProjectDrawer\(\)/);
  assert.match(projectsViewSource, /function clearStaleBootstrapOverlayScrollLock\(\)/);
  assert.match(projectsViewSource, /function waitForOverlayCleanupFrame\(\)/);
  assert.match(projectsViewSource, /Offcanvas\.getOrCreateInstance\(drawer\)/);
  assert.match(projectsViewSource, /hidden\.bs\.offcanvas/);
  assert.match(projectsViewSource, /window\.setTimeout\(finish, 400\)/);
  assert.match(projectsViewSource, /document\.body\.style\.removeProperty\('overflow'\)/);
  assert.match(projectsViewSource, /document\.body\.style\.removeProperty\('padding-right'\)/);
  assert.match(projectsViewSource, /await closeImportProjectDrawer\(\);\s*clearStaleBootstrapOverlayScrollLock\(\);\s*await router\.push/);
  assert.match(projectsViewSource, /await waitForOverlayCleanupFrame\(\);\s*clearStaleBootstrapOverlayScrollLock\(\);/);
});

test('navbar new project opens the manual project offcanvas directly', () => {
  assert.match(appSource, /:to="\{ name: 'projects' \}"/);
  assert.match(appSource, /:to="\{ name: 'projects', query: \{ new: 'project' \} \}"/);
  assert.match(projectsViewSource, /const CREATE_PROJECT_DRAWER_ID = 'createProjectDrawer';/);
  assert.match(projectsViewSource, /function openDrawer\(drawerId\)/);
  assert.match(projectsViewSource, /function registerDrawerCleanup\(drawerId\)/);
  assert.match(projectsViewSource, /drawer\.addEventListener\('hidden\.bs\.offcanvas', handler\)/);
  assert.match(projectsViewSource, /function openImportProjectDrawer\(\)/);
  assert.match(projectsViewSource, /function openCreateProjectDrawer\(\)/);
  assert.match(projectsViewSource, /function openCreateProjectDrawerFromRoute\(\)/);
  assert.match(projectsViewSource, /route\.query\.new !== 'project'/);
  assert.match(projectsViewSource, /openCreateProjectDrawer\(\);/);
  assert.match(projectsViewSource, /delete query\.new;/);
  assert.doesNotMatch(projectsViewSource, /data-bs-toggle="offcanvas"/);
});

test('project import conflicts use DOM overwrite choices instead of browser confirms', () => {
  assert.match(projectsViewSource, /const pendingImportOverwriteMode = ref\(''\);/);
  assert.match(projectsViewSource, /const importConflictGroups = computed/);
  assert.match(projectsViewSource, /function openImportOverwriteConfirmation\(mode\)/);
  assert.match(projectsViewSource, /function abortImportProject\(\)/);
  assert.match(projectsViewSource, /overwriteMode,/);
  assert.match(projectsViewSource, /Abort/);
  assert.match(projectsViewSource, /Overwrite Project/);
  assert.match(projectsViewSource, /Overwrite All/);
  assert.match(projectsViewSource, /Existing project match/);
  assert.match(projectsViewSource, /Supporting history/);
  assert.doesNotMatch(projectsViewSource, /group\.ids\.slice/);
  assert.doesNotMatch(projectsViewSource, /window\.confirm|confirm\(/);
  assert.doesNotMatch(projectsViewSource, /window\.alert|alert\(/);
});

test('an archive from another workspace says it imports as a copy', () => {
  assert.match(projectsViewSource, /v-if="importInspection\.importsAsCopy"/);
  assert.match(projectsViewSource, /imported as a separate copy/);
  assert.match(projectsViewSource, /importInspection\.importsAsCopy \? 'Import as Copy' : 'Import Project'/);
});
