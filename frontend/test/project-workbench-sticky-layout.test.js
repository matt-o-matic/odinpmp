import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const outlineSource = readFileSync(
  new URL('../src/components/projects/ProjectOutlinePane.vue', import.meta.url),
  'utf8',
);
const editorSource = readFileSync(
  new URL('../src/components/projects/ProjectWorkbenchEditor.vue', import.meta.url),
  'utf8',
);
const styleSource = readFileSync(
  new URL('../src/style.css', import.meta.url),
  'utf8',
);

test('project outline uses a dedicated scroll region with compact filters', () => {
  assert.match(outlineSource, /const FILTER_COMPACT_SCROLL_TOP = 36;/);
  assert.match(outlineSource, /const outlineTreeScrolled = ref\(false\);/);
  assert.match(outlineSource, /const filtersAreCompact = computed/);
  assert.match(outlineSource, /function handleOutlineTreeScroll\(event\)/);
  assert.match(outlineSource, /class="outline-card outline-card--controls"/);
  assert.match(outlineSource, /class="outline-filter-stack" :class="\{ 'outline-filter-stack--compact': filtersAreCompact \}"/);
  assert.match(outlineSource, /class="outline-filter outline-filter--compact"/);
  assert.match(outlineSource, /class="outline-filter outline-filter--full"/);
  assert.match(outlineSource, /class="outline-filter__summary"/);
  assert.match(outlineSource, /ref="outlineTreeScrollRef" class="outline-tree-scroll" @scroll="handleOutlineTreeScroll"/);
  assert.match(outlineSource, /class="outline-project-overview outline-row--project-sticky"/);
  assert.match(outlineSource, /class="outline-project-overview__action"[\s\S]*aria-label="Expand all"/);
  assert.match(outlineSource, /class="outline-project-overview__action"[\s\S]*aria-label="Collapse all"/);
  assert.doesNotMatch(outlineSource, /<div class="actions-row" style="margin-top: 0\.8rem">/);
});

test('project workbench sticky offsets are shared across tabs, panes, and editor header', () => {
  assert.match(editorSource, /class="workbench-card workbench-card--hero"/);
  assert.match(styleSource, /--project-detail-tabs-sticky-top: calc\(6\.25rem - 2px\);/);
  assert.match(styleSource, /--project-workbench-sticky-offset: calc\(var\(--project-detail-tabs-sticky-top, 6\.25rem\) \+ 3\.35rem\);/);
  assert.match(styleSource, /\.workbench-pane--outline \{\s*grid-template-rows: auto auto minmax\(0, 1fr\);/);
  assert.match(styleSource, /\.outline-tree-scroll \{\s*overflow-y: auto;/);
  assert.match(styleSource, /\.outline-filter-stack > \.outline-filter \{\s*overflow: hidden;\s*transition: max-height 180ms ease, opacity 140ms ease, transform 180ms ease;/);
  assert.match(styleSource, /\.workbench-pane--editor \.workbench-card--hero \{\s*position: sticky;/);
  assert.match(styleSource, /\.outline-row--project-sticky \{\s*position: sticky;/);
});

test('the editor pane keeps wide story content inside its column', () => {
  // An implicit auto column would grow to the task table's min-content and push cards
  // under the context pane.
  assert.match(styleSource, /\.workbench-pane--editor \{\s*min-width: 0;\s*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(styleSource, /\.task-table-wrap \{\s*overflow-x: auto;/);
});

test('fields keep their natural height when a neighbor in the row is taller', () => {
  assert.match(styleSource, /\.field-group \{\s*display: grid;\s*align-content: start;/);
});
