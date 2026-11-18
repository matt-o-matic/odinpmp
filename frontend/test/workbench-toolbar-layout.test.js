import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const modalSource = readFileSync(
  new URL('../src/components/projects/ProjectPlanningEditorModal.vue', import.meta.url),
  'utf8',
);

const taskTableSource = readFileSync(
  new URL('../src/components/projects/ProjectTaskTable.vue', import.meta.url),
  'utf8',
);

const detailViewSource = readFileSync(
  new URL('../src/views/ProjectDetailView.vue', import.meta.url),
  'utf8',
);

const styleSource = readFileSync(
  new URL('../src/style.css', import.meta.url),
  'utf8',
);

const outlinePaneSource = readFileSync(
  new URL('../src/components/projects/ProjectOutlinePane.vue', import.meta.url),
  'utf8',
);

const kanbanWorkspaceSource = readFileSync(
  new URL('../src/components/projects/ProjectKanbanWorkspace.vue', import.meta.url),
  'utf8',
);

test('planning modal uses a visible explicit close icon button instead of btn-close', () => {
  assert.equal(modalSource.includes('btn-close planning-editor-modal__dismiss'), false);
  assert.match(modalSource, /bi bi-x-lg/);
});

test('task header uses a split dropdown with add as the primary action', () => {
  assert.match(taskTableSource, /aria-label="Task actions"/);
  assert.match(taskTableSource, /btn-group action-dropdown/);
  assert.match(taskTableSource, /Add task/);
  assert.match(taskTableSource, /Generate tasks/);
});

test('task row actions use a split dropdown with edit as the primary action', () => {
  assert.match(taskTableSource, /aria-label="Task row actions"/);
  assert.match(taskTableSource, /Edit task/);
  assert.match(taskTableSource, /Remove task/);
});

test('project detail keeps navigation actions on the same sticky row as workspace tabs', () => {
  const tabsBarBlock = detailViewSource.match(/<div class="project-detail-tabs-bar">([\s\S]*?)<\/div>/)?.[1] ?? '';
  assert.ok(tabsBarBlock, 'expected project detail tabs bar');
  assert.match(tabsBarBlock, /Back to projects/);
  assert.match(tabsBarBlock, /class="project-detail-tabs"/);
  assert.match(tabsBarBlock, /class="project-detail-tabs-bar__actions"/);
  assert.equal(tabsBarBlock.includes('Project settings'), false);
  assert.equal(tabsBarBlock.includes('AI Workspace'), false);
  assert.equal(detailViewSource.includes('project-detail-actions'), false);

  const tabsBarStyle = styleSource.match(/\.project-detail-tabs-bar\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.ok(tabsBarStyle, 'expected project detail tabs bar styles');
  assert.match(tabsBarStyle, /position:\s*sticky;/);
  assert.match(tabsBarStyle, /top:\s*var\(--project-detail-tabs-sticky-top, calc\(6\.25rem - 2px\)\);/);
  assert.match(tabsBarStyle, /grid-template-columns:\s*minmax\(0, 1fr\) auto;/);
  assert.match(tabsBarStyle, /z-index:\s*900;/);
  assert.match(tabsBarStyle, /border-bottom:\s*1px solid var\(--line\);/);

  const tabsBarActionsStyle = styleSource.match(/\.project-detail-tabs-bar__actions\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.ok(tabsBarActionsStyle, 'expected project detail tabs bar action styles');
  assert.match(tabsBarActionsStyle, /display:\s*flex;/);
  assert.match(tabsBarActionsStyle, /align-items:\s*flex-end;/);
  assert.match(tabsBarActionsStyle, /justify-content:\s*flex-end;/);
  assert.match(tabsBarActionsStyle, /white-space:\s*nowrap;/);
});

test('project settings drawer has dark-mode overrides for the done control and sticky header surface', () => {
  assert.match(styleSource, /html\.dark \.project-settings-drawer__close/);
  assert.match(styleSource, /html\.dark \.project-settings-drawer__header \{[\s\S]*background:\s*var\(--surface\)/);
});

test('project detail uses a structure navigator control row below 1280px', () => {
  assert.match(detailViewSource, /const structureOutlineOpen = ref\(false\);/);
  assert.match(detailViewSource, /const isCompactWorkbench = ref\(false\);/);
  assert.match(detailViewSource, /window\.matchMedia\('\(max-width: 1279px\)'\)/);
  assert.match(detailViewSource, /class="project-workbench-toolbar"/);
  assert.match(detailViewSource, /Structure navigator/);
  assert.match(detailViewSource, /project-workbench-toolbar__context/);
  assert.match(detailViewSource, /project-workbench-toolbar__eyebrow/);
  assert.match(detailViewSource, /project-workbench-toolbar__meta/);
  assert.equal(detailViewSource.includes('Hide outline'), false);
  assert.equal(detailViewSource.includes('Show outline'), false);
  assert.match(detailViewSource, /project-workbench-outline-backdrop/);
  assert.match(detailViewSource, /'project-workbench--outline-callable': isCompactWorkbench/);
  assert.match(detailViewSource, /\.project-workbench-outline-backdrop\s*\{[\s\S]*top:\s*5rem;/);
  assert.match(detailViewSource, /\.project-workbench-outline-backdrop\s*\{[\s\S]*rgba\(15, 23, 42, 0\.12\)/);
});

test('project detail desktop panes use bounded sticky navigation and context surfaces', () => {
  const heroBlock = styleSource.match(/\.workbench-card--hero\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.ok(heroBlock, 'expected workbench hero styles');
  assert.match(styleSource, /\.workbench-pane--editor \.workbench-card--hero\s*\{[\s\S]*?position:\s*sticky;/);

  const desktopPaneBlock = styleSource.match(/@media \(min-width: 1280px\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.ok(desktopPaneBlock, 'expected desktop side pane styles');
  assert.match(desktopPaneBlock, /max-height:\s*calc\(100svh - var\(--workbench-sticky-offset\) - 2rem\);/);
  assert.match(desktopPaneBlock, /overflow-y:\s*auto;/);
});

test('project outline pane uses a tablet drawer shell for compact layouts', () => {
  assert.match(outlinePaneSource, /dismissible:\s*\{\s*default:\s*false,\s*type:\s*Boolean/);
  assert.match(outlinePaneSource, /drawerOpen:\s*\{\s*default:\s*false,\s*type:\s*Boolean/);
  assert.match(outlinePaneSource, /'workbench-pane--outline-drawer': dismissible/);
  assert.match(outlinePaneSource, /'workbench-pane--outline-drawer--open': dismissible && drawerOpen/);
  assert.match(outlinePaneSource, /outline-card--drawer-shell/);
  assert.match(outlinePaneSource, /Structure navigator/);
  assert.match(outlinePaneSource, /class="outline-pane__summary"/);
  assert.match(outlinePaneSource, /class="outline-pane__close"/);
  assert.match(outlinePaneSource, /@click="\$emit\('close'\)"/);
  assert.match(outlinePaneSource, /pointer-events:\s*none;/);
  assert.match(outlinePaneSource, /visibility:\s*hidden;/);
  assert.match(outlinePaneSource, /pointer-events:\s*auto;/);
  assert.match(outlinePaneSource, /visibility:\s*visible;/);
  assert.match(outlinePaneSource, /top:\s*5rem;/);
  assert.match(outlinePaneSource, /background:\s*rgba\(251, 253, 255, 0\.975\)/);
});

test('project outline pane requires a sustained touch before drag reordering begins', () => {
  assert.match(outlinePaneSource, /const TOUCH_REORDER_DELAY_MS = 220;/);
  assert.match(outlinePaneSource, /const touchReorderOptions = \{/);
  assert.match(outlinePaneSource, /delay:\s*TOUCH_REORDER_DELAY_MS/);
  assert.match(outlinePaneSource, /delayOnTouchOnly:\s*true/);
  assert.match(outlinePaneSource, /fallbackTolerance:\s*8/);
  assert.match(outlinePaneSource, /touchStartThreshold:\s*6/);
  assert.match(outlinePaneSource, /\.\.\.touchReorderOptions/);
});

test('kanban board requires a sustained touch before drag so taps open cards', () => {
  assert.match(kanbanWorkspaceSource, /const touchReorderOptions = \{/);
  assert.match(kanbanWorkspaceSource, /delayOnTouchOnly:\s*true/);
  assert.equal(kanbanWorkspaceSource.match(/\.\.\.touchReorderOptions/g)?.length, 2);
  assert.match(kanbanWorkspaceSource, /class="kanban-card__title" type="button" @click="openCard\(card\)"/);
});

test('kanban toolbar uses one split dropdown plus an icon-only refresh control', () => {
  assert.match(kanbanWorkspaceSource, /aria-label="Board view actions"/);
  assert.match(kanbanWorkspaceSource, /Board scope/);
  assert.match(kanbanWorkspaceSource, /Layout builder/);
  assert.match(kanbanWorkspaceSource, /Save board view/);
  assert.match(kanbanWorkspaceSource, /aria-label="Refresh board"/);
});
