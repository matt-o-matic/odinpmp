<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, useId, useSlots, watch } from 'vue';

import { AnnotationHistory } from '../../../lib/requirements/annotation-history.js';
import { applyDrafts, diffSnapshots, ownSnapshot, reconcileDrafts, recordDraft } from '../../../lib/requirements/annotation-drafts.js';
import { isMarkFaded, isMarkVisible, markLabel } from '../../../lib/requirements/annotation-layers.js';
import {
  DEFAULT_LAYER_COLOR,
  MAX_TEXT_LENGTH,
  SHAPE_TYPES,
  STROKE_WIDTHS,
  annotationPalette,
  arrowPath,
  createShape,
  defaultShapeAt,
  dragHandle,
  finishPenPoints,
  handlesFor,
  hitTest,
  markAnchor,
  markBounds,
  markNumbers,
  moveShape,
  newAnnotationId,
  nextMarkNumber,
  normalizeColor,
  normalizeShape,
  readableInk,
  resizeShapeBy,
  shapeBounds,
  shapeTypeLabel,
  textLabelColors,
  textMetrics,
} from '../../../lib/requirements/annotation-shapes.js';
import { TOOL_META, toolForKey } from '../../../lib/requirements/annotation-tools.js';

// Zoom is the real scale: 100% shows the image pixel for pixel. Fit, the default, follows the
// workspace as the window resizes and fills it, above 100% when the image is smaller than the
// space. Any other zoom keeps its scale when the window changes.
const MAX_SCALE = 4;
const MIN_SCALE = 0.05;
const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
const NUDGE = 5; // source px per arrow key
const EDGE = 16; // CSS px of stage around the image
const OVERLAY_GAP = 12; // CSS px between a floating control bar and the image
const DRAG_START = 6; // CSS px a press on a pin or text moves before it becomes a drag
const PIN_SIZE = 28; // CSS px, matches --pin-size
const POPOVER_GAP = 12; // CSS px between the open thread and its mark, the bars, or the workspace edge
const HIT_TOLERANCE = { mouse: 8, pen: 12, touch: 22 }; // CSS px around strokes

const props = defineProps({
  activeId: { default: null, type: String },
  // Feedback dimension labels for custom categories, keyed by id.
  categoryLabels: { default: () => ({}), type: Object },
  // { ref, name, color }. Without it the canvas is read-only.
  currentActor: { default: null, type: Object },
  height: { required: true, type: Number, validator: (value) => value > 0 },
  hiddenAuthors: { default: () => [], type: Array },
  imageAlt: { default: 'Screen under review', type: String },
  imageUrl: { default: '', type: String },
  label: { default: 'Annotation canvas', type: String },
  // [{ id, authorRef, authorName, color, category, status, shapes, number }]
  marks: { default: () => [], type: Array },
  readonly: { default: false, type: Boolean },
  // Changing it clears undo history and local drafts, for example when the same canvas shows another screen.
  screenKey: { default: '', type: String },
  showResolved: { default: true, type: Boolean },
  showZoom: { default: true, type: Boolean },
  unavailableText: { default: 'Image unavailable', type: String },
  width: { required: true, type: Number, validator: (value) => value > 0 },
});

const tool = defineModel('tool', { default: 'select', type: String });
// The scale (1 = 100%), or null for Fit.
const zoom = defineModel('zoom', { default: null, type: Number });
const color = defineModel('color', { default: '', type: String });
const stroke = defineModel('stroke', { default: STROKE_WIDTHS.thin, type: Number });
const emit = defineEmits(['create', 'update', 'delete', 'select', 'pin-click']);
const slots = useSlots();

const workspaceEl = ref(null);
const sceneEl = ref(null);
const textLayerEl = ref(null);
const topBarEl = ref(null);
const bottomBarEl = ref(null);
const popoverEl = ref(null);
// Where the open thread sits, in CSS px inside the scene.
const popoverPlace = ref(null);

const history = new AnnotationHistory();
const historyTick = ref(0);
const drafts = ref({});
// The shapes of one annotation while it is being drawn, dragged or typed; committed on release or blur.
const live = shallowRef(null);
const selectedId = ref(props.activeId ?? null);
const selectedShape = ref(0);
const viewport = reactive({ width: 0, height: 0, top: EDGE, bottom: EDGE });
const imageFailed = ref(false);
const announcement = ref('');
const activeKind = ref(null);
const hintId = useId();

let interaction = null;
let textSession = null;
let lastPinPress = null;
let resizeObserver = null;
let popoverObserver = null;
const pointers = new Map();
// Numbers of the reviewer's annotations, kept so an annotation restored by undo gets its old number back.
const numberMemory = new Map();
const freshIds = new Set();

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const pct = (value, total) => `${(value / total) * 100}%`;

const area = computed(() => ({ width: props.width, height: props.height }));
const actorRef = computed(() => props.currentActor?.ref || '');
const actorColor = computed(() => normalizeColor(props.currentActor?.color) || DEFAULT_LAYER_COLOR);
const canEdit = computed(() => !props.readonly && Boolean(actorRef.value));
const palette = computed(() => annotationPalette(actorColor.value));
const drawColor = computed(() => normalizeColor(color.value) || actorColor.value);
const drawStroke = computed(() => (stroke.value > 0 ? stroke.value : STROKE_WIDTHS.thin));
const drawing = computed(() => canEdit.value && tool.value !== 'select');

const fitScale = computed(() => {
  const width = viewport.width - EDGE * 2 - 2;
  const height = viewport.height - viewport.top - viewport.bottom - 2;
  if (width <= 0 || height <= 0) return 0;
  return Math.min(width / props.width, height / props.height);
});
const fitting = computed(() => zoom.value == null);
// Zooming out stops at Fit or 100%, whichever is smaller; zooming in reaches at least 400%.
const minScale = computed(() => Math.max(MIN_SCALE, Math.min(fitScale.value || 1, 1)));
const maxScale = computed(() => Math.max(MAX_SCALE, fitScale.value));
const scale = computed(() => Math.max(0.01, fitting.value ? fitScale.value : clampScale(zoom.value)));
const zoomPercent = computed(() => Math.round(scale.value * 100));

const committedMarks = computed(() => applyDrafts(props.marks, drafts.value));
const effectiveMarks = computed(() => {
  const current = live.value;
  if (!current) return committedMarks.value;
  let found = false;
  const result = committedMarks.value.map((mark) => {
    if (mark.id !== current.id) return mark;
    found = true;
    return { ...mark, shapes: current.shapes };
  });
  if (!found && current.mark) result.push({ ...current.mark, shapes: current.shapes });
  return result;
});
const numbers = computed(() => markNumbers(effectiveMarks.value));
const shownMarks = computed(() =>
  effectiveMarks.value.filter(
    (mark) =>
      mark.id === selectedId.value ||
      mark.id === live.value?.id ||
      isMarkVisible(mark, { hiddenAuthors: props.hiddenAuthors, showResolved: props.showResolved }),
  ),
);
const selectedMark = computed(() => shownMarks.value.find((mark) => mark.id === selectedId.value) || null);
const selectedEditable = computed(() => Boolean(selectedMark.value) && isEditable(selectedMark.value));
// The history object is not reactive; reading historyTick makes these recompute after each step.
const canUndo = computed(() => Boolean(historyTick.value + 1) && canEdit.value && history.canUndo);
const canRedo = computed(() => Boolean(historyTick.value + 1) && canEdit.value && history.canRedo);
const canDelete = computed(() => selectedEditable.value && Boolean(selectedMark.value.shapes?.[selectedShape.value]));

const sceneStyle = computed(() => ({
  width: `${props.width * scale.value}px`,
  height: `${props.height * scale.value}px`,
  visibility: fitScale.value > 0 ? 'visible' : 'hidden',
}));
const stageStyle = computed(() => ({ padding: `${viewport.top}px ${EDGE}px ${viewport.bottom}px` }));
const textLayerStyle = computed(() => ({
  width: `${props.width}px`,
  height: `${props.height}px`,
  transform: `scale(${scale.value})`,
  '--annotation-unscale': 1 / scale.value,
}));

const pins = computed(() => {
  const list = [];
  for (const mark of shownMarks.value) {
    (mark.shapes || []).forEach((shape, index) => {
      if (shape?.type !== 'pin') return;
      const number = numbers.value.get(mark.id);
      const pinColor = normalizeColor(mark.color) || shape.style?.color || DEFAULT_LAYER_COLOR;
      list.push({
        key: `${mark.id}:${index}`,
        id: mark.id,
        index,
        number,
        color: pinColor,
        ink: readableInk(pinColor),
        left: pct(shape.x, props.width),
        top: pct(shape.y, props.height),
        active: mark.id === selectedId.value,
        faded: isMarkFaded(mark),
        movable: isEditable(mark) && tool.value === 'select',
        label: markLabel(mark, { number, categoryLabels: props.categoryLabels }),
      });
    });
  }
  return list;
});

const selectionOutline = computed(() => {
  const shape = selectedMark.value?.shapes?.[selectedShape.value];
  if (!shape || shape.type === 'pin') return null;
  const box = shapeBounds(shape);
  const pad = 6 / scale.value;
  return { x: box.x - pad, y: box.y - pad, w: box.w + pad * 2, h: box.h + pad * 2 };
});

const handles = computed(() => {
  if (tool.value !== 'select' || !selectedEditable.value || activeKind.value === 'draw' || activeKind.value === 'pinch') return [];
  const mark = selectedMark.value;
  if (!committedMarks.value.some((entry) => entry.id === mark.id)) return [];
  return handlesFor(mark.shapes[selectedShape.value]).map((handle) => ({
    ...handle,
    left: pct(handle.x, props.width),
    top: pct(handle.y, props.height),
  }));
});

const popover = computed(() => {
  if (!slots.popover || !selectedMark.value || activeKind.value === 'draw') return null;
  if (!committedMarks.value.some((entry) => entry.id === selectedMark.value.id)) return null;
  const anchor = markAnchor(selectedMark.value);
  if (!anchor) return null;
  return {
    mark: selectedMark.value,
    number: numbers.value.get(selectedMark.value.id),
    own: isOwn(selectedMark.value),
    anchor,
    bounds: markBounds(selectedMark.value) ?? { x: anchor.x, y: anchor.y, w: 0, h: 0 },
    pinned: (selectedMark.value.shapes || []).some((shape) => shape.type === 'pin'),
  };
});
const popoverStyle = computed(() => {
  const place = popoverPlace.value;
  if (place) return { left: `${place.left}px`, top: `${place.top}px`, maxHeight: `${place.maxHeight}px` };
  // First render only: placePopover() measures and moves it before the browser paints.
  const anchor = popover.value?.anchor;
  return anchor ? { left: `${anchor.x * scale.value}px`, top: `${anchor.y * scale.value}px` } : {};
});

const hint = computed(() =>
  canEdit.value
    ? 'Tools: V select, C pin, B box, A arrow, P pen, H highlight, T text. With a drawing tool, press Enter to place a mark in the middle of the view. Arrow keys move the selected mark by 5 pixels and Shift with arrow keys resizes it. Delete removes it. Control or Command with Z undoes, and with Shift redoes. Enter opens the selected mark. Escape clears the selection.'
    : 'Enter opens the selected mark. Hold Control and scroll, or pinch, to zoom.',
);

function clampScale(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? clamp(number, minScale.value, maxScale.value) : fitScale.value;
}

function isOwn(mark) {
  return Boolean(actorRef.value) && mark?.authorRef === actorRef.value;
}

function isEditable(mark) {
  return canEdit.value && isOwn(mark);
}

function ownState() {
  return ownSnapshot(committedMarks.value, actorRef.value);
}

function currentStyle() {
  return { color: drawColor.value, stroke: drawStroke.value };
}

// Every new annotation gets the next number on the screen; a pin shows its annotation's number.
function claimNumber(id) {
  const number = nextMarkNumber(effectiveMarks.value);
  numberMemory.set(id, number);
  freshIds.add(id);
  return number;
}

function markMeta(id, number) {
  return {
    id,
    authorRef: actorRef.value,
    authorName: props.currentActor?.name || 'You',
    color: actorColor.value,
    category: null,
    status: 'open',
    number,
  };
}

function normalizeAll(shapes) {
  return shapes.map((shape) => normalizeShape(shape, area.value)).filter(Boolean);
}

function replaceEntry(snapshot, id, shapes) {
  if (!shapes.length) return snapshot.filter((entry) => entry.id !== id);
  if (!snapshot.some((entry) => entry.id === id)) return [...snapshot, { id, shapes }];
  return snapshot.map((entry) => (entry.id === id ? { id, shapes } : entry));
}

function announce(text) {
  announcement.value = '';
  nextTick(() => {
    announcement.value = text;
  });
}

// Turns a before/after pair of the reviewer's own marks into local drafts and create, update and delete events.
function applyChange(before, after) {
  const { created, updated, deleted } = diffSnapshots(before, after);
  let next = drafts.value;
  const events = [];
  for (const id of deleted) {
    const number = committedMarks.value.find((mark) => mark.id === id)?.number;
    if (number) numberMemory.set(id, number);
  }
  for (const entry of created) {
    // A restored annotation is one that undo brings back after a delete; the parent can reattach its thread.
    const restored = !freshIds.has(entry.id);
    const number = numberMemory.get(entry.id) ?? claimNumber(entry.id);
    freshIds.delete(entry.id);
    next = recordDraft(next, props.marks, { type: 'create', id: entry.id, shapes: entry.shapes, mark: markMeta(entry.id, number) });
    events.push(['create', { id: entry.id, shapes: entry.shapes, number, restored }]);
  }
  for (const entry of updated) {
    next = recordDraft(next, props.marks, { type: 'update', id: entry.id, shapes: entry.shapes });
    events.push(['update', entry.id, entry.shapes]);
  }
  for (const id of deleted) {
    next = recordDraft(next, props.marks, { type: 'delete', id });
    events.push(['delete', id]);
  }
  drafts.value = next;
  for (const [name, ...args] of events) emit(name, ...args);
}

function commit(before, after) {
  if (!history.commit(before, after)) return false;
  historyTick.value += 1;
  applyChange(before, after);
  return true;
}

function select(id, shapeIndex = 0) {
  selectedShape.value = shapeIndex;
  if (selectedId.value === id) return;
  selectedId.value = id;
  emit('select', id);
  const mark = id ? effectiveMarks.value.find((entry) => entry.id === id) : null;
  if (mark) announce(`Selected ${markLabel(mark, { number: numbers.value.get(id), categoryLabels: props.categoryLabels })}`);
}

function setTool(next) {
  if (TOOL_META[next]) tool.value = next;
}

function stepHistory(direction) {
  if (!canEdit.value) return;
  finishTextEditing();
  cancelInteraction();
  const current = ownState();
  const target = direction === 'undo' ? history.undo(current) : history.redo(current);
  historyTick.value += 1;
  if (!target) return;
  const selectedWasOwn = current.some((entry) => entry.id === selectedId.value);
  applyChange(current, target);
  if (selectedWasOwn && !target.some((entry) => entry.id === selectedId.value)) select(null);
  announce(direction === 'undo' ? 'Undone' : 'Redone');
}

function undo() {
  stepHistory('undo');
}

function redo() {
  stepHistory('redo');
}

function deleteSelected() {
  const mark = selectedMark.value;
  if (!mark || !isEditable(mark)) return;
  const before = ownState();
  const shapes = mark.shapes.filter((_, index) => index !== selectedShape.value);
  if (!commit(before, replaceEntry(before, mark.id, shapes))) return;
  if (shapes.length) selectedShape.value = Math.min(selectedShape.value, shapes.length - 1);
  else select(null);
  announce('Mark deleted');
}

// Sets the drawing color or stroke and applies it to the selected mark. Pins always use the layer color.
function applyStyle({ color: nextColor, stroke: nextStroke } = {}) {
  if (nextColor !== undefined) color.value = nextColor;
  if (nextStroke !== undefined) stroke.value = nextStroke;
  const mark = selectedMark.value;
  const shape = mark?.shapes?.[selectedShape.value];
  if (!shape || shape.type === 'pin' || !isEditable(mark)) return;
  const style = { color: normalizeColor(nextColor) || shape.style.color, stroke: nextStroke ?? shape.style.stroke };
  const before = ownState();
  commit(before, replaceEntry(before, mark.id, normalizeAll(mark.shapes.map((entry, index) => (index === selectedShape.value ? { ...entry, style } : entry)))));
}

function updateSelectedShape(change) {
  const mark = selectedMark.value;
  const shape = mark?.shapes?.[selectedShape.value];
  if (!shape || !isEditable(mark)) return;
  const before = ownState();
  const shapes = mark.shapes.map((entry, index) => (index === selectedShape.value ? change(entry) : entry));
  commit(before, replaceEntry(before, mark.id, normalizeAll(shapes)));
}

function discardDrafts(ids) {
  if (!ids) {
    drafts.value = {};
    return;
  }
  const next = { ...drafts.value };
  for (const id of ids) delete next[id];
  drafts.value = next;
}

// Sets a fixed scale. The image point `anchor` stays under the client point (x, y).
async function zoomTo(value, anchor, clientX, clientY) {
  zoom.value = Math.round(clampScale(value) * 1000) / 1000;
  await nextTick();
  const workspace = workspaceEl.value;
  const scene = sceneEl.value;
  if (!workspace || !scene || !anchor) return;
  const rect = scene.getBoundingClientRect();
  workspace.scrollLeft += rect.left + (anchor.x / props.width) * rect.width - clientX;
  workspace.scrollTop += rect.top + (anchor.y / props.height) * rect.height - clientY;
}

function zoomAroundCenter(value) {
  const rect = workspaceEl.value?.getBoundingClientRect();
  if (!rect) return;
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  zoomTo(value, clientToSource(x, y, false), x, y);
}

// The buttons step through common zoom levels, from wherever Fit or a pinch left the scale.
function stepZoom(direction) {
  const current = scale.value;
  const next = direction > 0
    ? ZOOM_STEPS.find((step) => step > current + 0.005) ?? maxScale.value
    : [...ZOOM_STEPS].reverse().find((step) => step < current - 0.005) ?? minScale.value;
  zoomAroundCenter(next);
}

const zoomIn = () => stepZoom(1);
const zoomOut = () => stepZoom(-1);
const actualSize = () => zoomAroundCenter(1);
function fit() {
  zoom.value = null;
}
const canZoomIn = computed(() => scale.value < maxScale.value - 0.005);
const canZoomOut = computed(() => scale.value > minScale.value + 0.005);
const atActualSize = computed(() => Math.abs(scale.value - 1) < 0.005);

function clientToSource(clientX, clientY, clampToImage = true) {
  const rect = sceneEl.value.getBoundingClientRect();
  const x = ((clientX - rect.left) / rect.width) * props.width;
  const y = ((clientY - rect.top) / rect.height) * props.height;
  return clampToImage ? { x: clamp(x, 0, props.width), y: clamp(y, 0, props.height) } : { x, y };
}

function measure() {
  const workspace = workspaceEl.value;
  if (!workspace) return;
  // An on-screen keyboard only shortens the workspace; keep the scale so the text being typed does not shrink.
  if (isEditingText() && workspace.clientWidth === viewport.width && viewport.height) return;
  const barHeight = (el) => (el?.offsetHeight ? el.offsetHeight + OVERLAY_GAP + EDGE / 2 : EDGE);
  viewport.width = workspace.clientWidth;
  viewport.height = workspace.clientHeight;
  viewport.top = barHeight(topBarEl.value);
  viewport.bottom = barHeight(bottomBarEl.value);
}

// Keeps the open thread inside the visible workspace, clear of the floating bars, at any mark
// size, zoom or scroll. It tries below or above the mark, then beside it, and otherwise pins
// it to the visible area; a thread taller than that area scrolls inside itself.
function placePopover() {
  const el = popoverEl.value;
  const info = popover.value;
  const workspace = workspaceEl.value;
  if (!el || !info || !workspace || !sceneEl.value) {
    popoverPlace.value = null;
    return;
  }
  const s = scale.value;
  const gap = POPOVER_GAP;
  const scene = sceneEl.value.getBoundingClientRect();
  const view = workspace.getBoundingClientRect();
  const barTop = topBarEl.value?.offsetHeight ? topBarEl.value.getBoundingClientRect().bottom : view.top;
  const barBottom = bottomBarEl.value?.offsetHeight ? bottomBarEl.value.getBoundingClientRect().top : view.top + workspace.clientHeight;
  // The visible area, in scene px.
  const minTop = barTop + gap - scene.top;
  const maxBottom = Math.max(minTop + 120, barBottom - gap - scene.top);
  const minLeft = view.left + gap - scene.left;
  const maxRight = view.left + workspace.clientWidth - gap - scene.left;
  const width = el.offsetWidth;
  const height = el.scrollHeight;
  const fitsY = (top) => top >= minTop && top + height <= maxBottom;
  const fitsX = (left) => left >= minLeft && left + width <= maxRight;
  const clampX = (left) => clamp(left, minLeft, Math.max(minLeft, maxRight - width));
  const clampY = (top) => clamp(top, minTop, Math.max(minTop, maxBottom - height));

  const { anchor, bounds } = info;
  const end = anchor.x * s + gap;
  const start = anchor.x * s - gap - width;
  const left = clampX(anchor.x > props.width / 2 && fitsX(start) ? start : fitsX(end) ? end : start);
  const below = anchor.y * s + gap;
  // A pin's marker stands above its point.
  const above = bounds.y * s - (info.pinned ? PIN_SIZE * 1.2 : 0) - gap - height;
  // Marks low on the screen prefer to open upward, clear of the toolbar.
  const vertical = anchor.y > props.height * 0.55 ? [above, below] : [below, above];

  let place = null;
  const top = vertical.find(fitsY);
  if (top !== undefined) place = { left, top };
  else {
    // Too tall a mark for either: beside it, level with its top.
    const right = (bounds.x + bounds.w) * s + gap;
    const beside = [right, bounds.x * s - gap - width].find(fitsX);
    place = { left: beside ?? left, top: clampY(beside === undefined ? below : bounds.y * s) };
  }
  place.maxHeight = maxBottom - minTop;
  const current = popoverPlace.value;
  if (!current || current.left !== place.left || current.top !== place.top || current.maxHeight !== place.maxHeight) popoverPlace.value = place;
}

function focusWorkspace() {
  workspaceEl.value?.focus({ preventScroll: true });
}

function capture(event) {
  try {
    workspaceEl.value.setPointerCapture(event.pointerId);
  } catch {
    // The pointer is already gone or synthetic.
  }
}

function release(pointerId) {
  if (pointers.has(pointerId)) return; // touches stay captured so their pointerup always arrives
  try {
    workspaceEl.value?.releasePointerCapture(pointerId);
  } catch {
    // Not captured.
  }
}

function setInteraction(next) {
  interaction = next;
  activeKind.value = next?.kind || null;
}

function cancelInteraction() {
  if (!interaction) return;
  if (interaction.pointerId !== undefined) release(interaction.pointerId);
  if (['draw', 'move', 'handle'].includes(interaction.kind)) live.value = null;
  setInteraction(null);
}

function hitTolerance(event) {
  return (HIT_TOLERANCE[event.pointerType] ?? HIT_TOLERANCE.mouse) / scale.value;
}

function isEditingText() {
  const active = document.activeElement;
  return Boolean(active?.tagName === 'TEXTAREA' && textLayerEl.value?.contains(active));
}

function finishTextEditing() {
  if (isEditingText()) document.activeElement.blur();
}

function onPointerDown(event) {
  const target = event.target;
  if (target.closest?.('[data-annotation-popover]')) return;
  const textarea = target.closest?.('textarea');
  if (textarea && document.activeElement === textarea) return; // native caret placement while typing
  const touch = event.pointerType === 'touch';
  if (touch) {
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    capture(event);
    if (pointers.size === 2 && interaction?.kind !== 'pinch') {
      event.preventDefault();
      startPinch();
      return;
    }
  }
  if (interaction?.kind === 'pinch' || pointers.size > 2) return;
  if (interaction && interaction.pointerId === event.pointerId) cancelInteraction(); // its pointerup was lost
  if (interaction || event.button !== 0 || !event.isPrimary) return;
  finishTextEditing();

  // A pinch that follows restores this selection, so the first finger of a pinch does not select a mark.
  const base = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, selectionBefore: [selectedId.value, selectedShape.value] };
  const handleEl = target.closest?.('[data-handle]');
  const pinEl = target.closest?.('[data-pin-id]');
  const textEl = target.closest?.('[data-text-id]');
  const selecting = !drawing.value;

  if (handleEl && selectedEditable.value) {
    event.preventDefault();
    focusWorkspace();
    capture(event);
    beginEdit('handle', selectedMark.value, selectedShape.value, clientToSource(event.clientX, event.clientY), { ...base, handle: handleEl.dataset.handle });
    return;
  }
  if (pinEl || (textEl && selecting)) {
    const el = pinEl || textEl;
    const id = el.dataset.pinId || el.dataset.textId;
    const index = Number(el.dataset.shapeIndex) || 0;
    event.preventDefault();
    capture(event);
    if (!pinEl) focusWorkspace();
    select(id, index);
    setInteraction({ ...base, kind: 'press', target: pinEl ? 'pin' : 'text', id, index, start: clientToSource(event.clientX, event.clientY) });
    return;
  }
  if (!sceneEl.value?.contains(target)) {
    if (selecting || touch) {
      event.preventDefault();
      startPan(event, base);
    }
    return;
  }

  event.preventDefault();
  focusWorkspace();
  const point = clientToSource(event.clientX, event.clientY);
  if (selecting) {
    const hit = hitTest(shownMarks.value, point, { tolerance: hitTolerance(event), pinRadius: PIN_SIZE / 2 / scale.value });
    if (!hit) {
      select(null);
      startPan(event, base);
      return;
    }
    select(hit.id, hit.shapeIndex);
    const mark = effectiveMarks.value.find((entry) => entry.id === hit.id);
    capture(event);
    if (isEditable(mark)) beginEdit('move', mark, hit.shapeIndex, point, base);
    else startPan(event, base);
    return;
  }
  capture(event);
  startDraw(point, base);
}

function beginEdit(kind, mark, index, point, base) {
  setInteraction({ ...base, kind, id: mark.id, index, start: point, before: ownState(), original: mark.shapes[index], shapes: mark.shapes });
}

function startPan(event, from = event) {
  const workspace = workspaceEl.value;
  capture(event);
  setInteraction({
    kind: 'pan',
    pointerId: event.pointerId,
    clientX: from.clientX,
    clientY: from.clientY,
    left: workspace.scrollLeft,
    top: workspace.scrollTop,
    selectionBefore: from.selectionBefore,
  });
}

function startDraw(point, base) {
  const type = tool.value;
  if (type === 'text') {
    startText(point);
    return;
  }
  if (!SHAPE_TYPES.includes(type)) return;
  const id = newAnnotationId();
  const number = claimNumber(id);
  const shape = createShape(type, point, { style: currentStyle(), number });
  live.value = { id, shapes: [shape], mark: markMeta(id, number) };
  setInteraction({ ...base, kind: 'draw', id, start: point, before: ownState() });
}

// A new text label: a one-line box at Fit size that grows as the reviewer types. It is committed on blur,
// and an empty box is dropped without leaving an undo step.
async function startText(point) {
  const fitted = fitScale.value || 1;
  const fontSize = 16 / fitted;
  const metrics = textMetrics(fontSize);
  const width = Math.min(props.width, 240 / fitted);
  const height = Math.min(props.height, metrics.lineHeight + metrics.padding * 2);
  const origin = { x: clamp(point.x, 0, props.width - width), y: clamp(point.y, 0, props.height - height) };
  const shape = createShape('text', origin, { style: currentStyle(), fontSize, width, height });
  const id = newAnnotationId();
  textSession = { id, before: ownState() };
  live.value = { id, shapes: [shape], mark: markMeta(id, claimNumber(id)) };
  tool.value = 'select';
  await nextTick();
  focusText(id, 0);
}

function focusText(id, index) {
  const el = textLayerEl.value?.querySelector(`textarea[data-text-id="${CSS.escape(id)}"][data-shape-index="${index}"]`);
  if (!el) return;
  el.focus({ preventScroll: true });
  el.setSelectionRange(el.value.length, el.value.length);
}

function onPointerMove(event) {
  if (pointers.has(event.pointerId)) pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  const current = interaction;
  if (!current) return;
  if (current.kind === 'pinch') {
    updatePinch();
    return;
  }
  if (current.pointerId !== event.pointerId) return;
  if (current.kind === 'press') {
    if (Math.hypot(event.clientX - current.clientX, event.clientY - current.clientY) < DRAG_START) return;
    const mark = effectiveMarks.value.find((entry) => entry.id === current.id);
    if (current.target === 'pin') lastPinPress = { id: current.id, at: performance.now() };
    if (mark && isEditable(mark)) beginEdit('move', mark, current.index, current.start, current);
    else startPan(event, current);
  }
  applyPointer(event);
}

function applyPointer(event) {
  const current = interaction;
  if (current.kind === 'pan') {
    workspaceEl.value.scrollLeft = current.left - (event.clientX - current.clientX);
    workspaceEl.value.scrollTop = current.top - (event.clientY - current.clientY);
    return;
  }
  const point = clientToSource(event.clientX, event.clientY);
  if (current.kind === 'draw') {
    const shape = live.value?.shapes[0];
    if (!shape) return;
    let next;
    if (shape.type === 'pin') next = { ...shape, x: point.x, y: point.y };
    else if (shape.type === 'arrow') next = { ...shape, x2: point.x, y2: point.y };
    else if (shape.type === 'pen') {
      const gap = 1 / scale.value;
      const samples = event.getCoalescedEvents?.() || [];
      for (const sample of samples.length ? samples : [event]) {
        const p = clientToSource(sample.clientX, sample.clientY);
        const last = shape.points.at(-1);
        if (Math.hypot(p.x - last[0], p.y - last[1]) >= gap) shape.points.push([p.x, p.y]);
      }
      next = { ...shape };
    } else {
      next = { ...shape, x: Math.min(current.start.x, point.x), y: Math.min(current.start.y, point.y), w: Math.abs(point.x - current.start.x), h: Math.abs(point.y - current.start.y) };
    }
    live.value = { ...live.value, shapes: [next] };
    return;
  }
  if (current.kind === 'move' || current.kind === 'handle') {
    const next =
      current.kind === 'move'
        ? moveShape(current.original, point.x - current.start.x, point.y - current.start.y, area.value)
        : dragHandle(current.original, current.handle, point, area.value);
    live.value = { id: current.id, shapes: current.shapes.map((shape, index) => (index === current.index ? next : shape)) };
  }
}

function onPointerUp(event, cancelled = false) {
  pointers.delete(event.pointerId);
  const current = interaction;
  if (!current) return;
  if (current.kind === 'pinch') {
    if (pointers.size < 2) setInteraction(null);
    return;
  }
  if (current.pointerId !== event.pointerId) return;
  setInteraction(null);
  release(event.pointerId);
  if (cancelled) {
    if (['draw', 'move', 'handle'].includes(current.kind)) live.value = null;
    return;
  }
  if (current.kind === 'press') {
    if (current.target === 'pin') {
      lastPinPress = { id: current.id, at: performance.now() };
      emit('pin-click', current.id);
    } else if (isEditable(effectiveMarks.value.find((entry) => entry.id === current.id))) {
      focusText(current.id, current.index);
    }
    return;
  }
  if (current.kind === 'draw') finishDraw(current);
  else if (current.kind === 'move' || current.kind === 'handle') commitLive(current);
}

// Keyboard and assistive-technology activation of a pin. Pointer presses are handled on pointerup.
function onPinClick(pin) {
  if (lastPinPress?.id === pin.id && performance.now() - lastPinPress.at < 700) return;
  select(pin.id, pin.index);
  emit('pin-click', pin.id);
}

function finishDraw(current) {
  let shape = live.value?.id === current.id ? live.value.shapes[0] : null;
  live.value = null;
  if (!shape) return;
  if (shape.type === 'pen') shape = { ...shape, points: finishPenPoints(shape.points) };
  const normalized = normalizeShape(shape, area.value);
  if (!normalized) {
    announce('Too small to keep. Drag further to draw a mark.');
    return;
  }
  if (!commit(current.before, [...current.before, { id: current.id, shapes: [normalized] }])) return;
  select(current.id, 0);
  tool.value = 'select';
  announce(`${shapeTypeLabel(normalized.type)} added`);
}

function commitLive(current) {
  const shapes = live.value?.id === current.id ? live.value.shapes : null;
  live.value = null;
  if (shapes) commit(current.before, replaceEntry(current.before, current.id, normalizeAll(shapes)));
}

function startPinch() {
  // Undo whatever the first finger started, including a selection it made.
  const selectionBefore = interaction?.selectionBefore;
  if (interaction && interaction.kind !== 'pinch') cancelInteraction();
  if (selectionBefore) select(...selectionBefore);
  const [a, b] = [...pointers.values()];
  const x = (a.x + b.x) / 2;
  const y = (a.y + b.y) / 2;
  setInteraction({ kind: 'pinch', distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)), zoom: scale.value, anchor: clientToSource(x, y, false) });
}

function updatePinch() {
  if (pointers.size < 2) return;
  const [a, b] = [...pointers.values()];
  zoomTo((interaction.zoom * Math.hypot(b.x - a.x, b.y - a.y)) / interaction.distance, interaction.anchor, (a.x + b.x) / 2, (a.y + b.y) / 2);
}

function onWheel(event) {
  if (!event.ctrlKey) return;
  event.preventDefault();
  zoomTo(scale.value * Math.exp(-event.deltaY / 100), clientToSource(event.clientX, event.clientY, false), event.clientX, event.clientY);
}

function onTextFocus(mark, index) {
  if (!textSession || textSession.id !== mark.id) textSession = { id: mark.id, before: ownState() };
  if (committedMarks.value.some((entry) => entry.id === mark.id)) select(mark.id, index);
}

function onTextInput(mark, index, event) {
  const el = event.target;
  const current = live.value?.id === mark.id ? live.value : { id: mark.id, shapes: mark.shapes, mark: null };
  const shapes = current.shapes.map((shape, i) => {
    if (i !== index) return shape;
    const next = { ...shape, text: el.value };
    // The layer is scaled with a transform, so scrollHeight is already in source pixels.
    if (el.scrollHeight > next.h + 0.5) next.h = Math.min(props.height - next.y, el.scrollHeight);
    return next;
  });
  live.value = { ...current, shapes };
}

function onTextBlur(mark, index) {
  const session = textSession;
  textSession = null;
  const current = live.value?.id === mark.id ? live.value : null;
  if (!current) return;
  live.value = null;
  if (!session) return;
  const shapes = normalizeAll(current.shapes);
  if (!commit(session.before, replaceEntry(session.before, mark.id, shapes))) return;
  if (shapes.length) select(mark.id, Math.min(index, shapes.length - 1));
  else if (selectedId.value === mark.id) select(null);
  if (current.mark && shapes.length) announce('Text label added');
}

function placeAtCenter(type) {
  const rect = workspaceEl.value.getBoundingClientRect();
  const center = clientToSource(rect.left + rect.width / 2, rect.top + rect.height / 2);
  if (type === 'text') {
    startText(center);
    return;
  }
  const id = newAnnotationId();
  const number = claimNumber(id);
  const shape = normalizeShape(defaultShapeAt(type, center, { bounds: area.value, style: currentStyle(), number, size: 120 / scale.value }) || {}, area.value);
  if (!shape) return;
  const before = ownState();
  if (!commit(before, [...before, { id, shapes: [shape] }])) return;
  select(id, 0);
  tool.value = 'select';
  announce(`${shapeTypeLabel(type)} added`);
}

function arrowDelta(key) {
  return {
    dx: key === 'ArrowLeft' ? -NUDGE : key === 'ArrowRight' ? NUDGE : 0,
    dy: key === 'ArrowUp' ? -NUDGE : key === 'ArrowDown' ? NUDGE : 0,
  };
}

function onKeydown(event) {
  const target = event.target;
  const key = event.key;
  if (target.closest?.('[data-annotation-popover]')) return;
  if (target.tagName === 'TEXTAREA') {
    if (key === 'Escape') {
      event.preventDefault();
      target.blur();
      focusWorkspace();
    }
    return;
  }
  const mod = event.ctrlKey || event.metaKey;
  if (mod && key.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
    return;
  }
  if (mod && key.toLowerCase() === 'y') {
    event.preventDefault();
    redo();
    return;
  }
  if (mod || event.altKey) return;

  const handleEl = target.closest?.('[data-handle]');
  if (handleEl && key.startsWith('Arrow')) {
    event.preventDefault();
    const { dx, dy } = arrowDelta(key);
    updateSelectedShape((shape) => {
      const handle = handlesFor(shape).find((entry) => entry.id === handleEl.dataset.handle);
      return handle ? dragHandle(shape, handle.id, { x: handle.x + dx, y: handle.y + dy }, area.value) : shape;
    });
    return;
  }
  if (key === 'Escape') {
    if (interaction) cancelInteraction();
    else if (selectedId.value) select(null);
    else if (tool.value !== 'select') tool.value = 'select';
    else return;
    event.preventDefault();
    return;
  }
  if (key === 'Delete' || key === 'Backspace') {
    if (!selectedEditable.value) return;
    event.preventDefault();
    deleteSelected();
    return;
  }
  if (key.startsWith('Arrow')) {
    if (!selectedEditable.value) return; // arrow keys scroll the view
    event.preventDefault();
    const { dx, dy } = arrowDelta(key);
    updateSelectedShape((shape) => (event.shiftKey ? resizeShapeBy(shape, dx, dy, area.value) : moveShape(shape, dx, dy, area.value)));
    return;
  }
  if (key === 'Enter' || key === ' ') {
    if (handleEl) return;
    if (drawing.value && tool.value !== 'pen') {
      event.preventDefault();
      placeAtCenter(tool.value);
    } else if (selectedId.value) {
      event.preventDefault();
      emit('pin-click', selectedId.value);
    }
    return;
  }
  if (canEdit.value && key.length === 1) {
    const next = toolForKey(key);
    if (!next) return;
    event.preventDefault();
    tool.value = next;
    announce(`${TOOL_META[next].label} tool`);
  }
}

function preventGesture(event) {
  event.preventDefault();
}

function textStyle(shape) {
  const metrics = textMetrics(shape.fontSize);
  return {
    left: `${shape.x}px`,
    top: `${shape.y}px`,
    width: `${shape.w}px`,
    height: `${shape.h}px`,
    padding: `${metrics.padding}px`,
    fontSize: `${shape.fontSize}px`,
    lineHeight: `${metrics.lineHeight}px`,
    color: textLabelColors(shape.style?.color).ink,
  };
}

function penPoints(shape) {
  return shape.points.map(([x, y]) => `${x},${y}`).join(' ');
}

function boxRadius(shape) {
  return Math.min(8, shape.w / 4, shape.h / 4);
}

watch(
  () => props.activeId,
  (id) => {
    if ((id ?? null) === selectedId.value) return;
    selectedId.value = id ?? null;
    selectedShape.value = 0;
  },
);

watch(
  () => props.marks,
  (marks) => {
    drafts.value = reconcileDrafts(marks, drafts.value);
  },
  { deep: true },
);

watch(
  () => [props.screenKey, actorRef.value],
  ([screenKey], [previousKey]) => {
    // Another screen opens at Fit.
    if (screenKey !== previousKey) zoom.value = null;
    cancelInteraction();
    textSession = null;
    live.value = null;
    drafts.value = {};
    history.clear();
    historyTick.value += 1;
  },
);

watch(
  () => props.imageUrl,
  () => {
    imageFailed.value = false;
  },
);

watch(
  () => props.readonly,
  (readonly) => {
    if (readonly) {
      finishTextEditing();
      cancelInteraction();
    }
  },
);

watch(
  () => [popover.value, scale.value, viewport.width, viewport.height, viewport.top, viewport.bottom],
  placePopover,
  { flush: 'post' },
);

// A thread grows as comments arrive; it is re-placed whenever it changes size.
watch(popoverEl, (el) => {
  popoverObserver?.disconnect();
  if (!el) return;
  popoverObserver = new ResizeObserver(placePopover);
  popoverObserver.observe(el);
});

onMounted(() => {
  resizeObserver = new ResizeObserver(measure);
  for (const el of [workspaceEl.value, topBarEl.value, bottomBarEl.value]) if (el) resizeObserver.observe(el);
  measure();
  // Safari zooms the page on pinch despite touch-action; its gesture events can be cancelled.
  workspaceEl.value.addEventListener('gesturestart', preventGesture);
  workspaceEl.value.addEventListener('gesturechange', preventGesture);
  workspaceEl.value.addEventListener('scroll', placePopover, { passive: true });
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  popoverObserver?.disconnect();
  workspaceEl.value?.removeEventListener('gesturestart', preventGesture);
  workspaceEl.value?.removeEventListener('gesturechange', preventGesture);
  workspaceEl.value?.removeEventListener('scroll', placePopover);
});

defineExpose({ applyStyle, deleteSelected, discardDrafts, fit, redo, setTool, undo, zoomIn, zoomOut, focus: focusWorkspace });
</script>

<template>
  <div
    class="annotation-canvas"
    :class="{
      'annotation-canvas--drawing': drawing,
      'annotation-canvas--readonly': !canEdit,
      'annotation-canvas--panning': activeKind === 'pan',
    }"
    :style="{ '--annotation-ratio': `${(height / width) * 100}%` }"
  >
    <div
      ref="workspaceEl"
      class="annotation-canvas__workspace"
      tabindex="0"
      role="group"
      :aria-label="label"
      :aria-describedby="hintId"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp($event, true)"
      @wheel="onWheel"
      @keydown="onKeydown"
    >
      <div class="annotation-canvas__stage" :style="stageStyle">
        <div ref="sceneEl" class="annotation-canvas__scene" :style="sceneStyle">
          <img
            v-if="imageUrl && !imageFailed"
            class="annotation-canvas__image"
            :src="imageUrl"
            :alt="imageAlt"
            draggable="false"
            @error="imageFailed = true"
          />
          <div v-else class="annotation-canvas__blank" role="img" :aria-label="`${imageAlt}. ${unavailableText}`">
            <span><i class="bi bi-image" aria-hidden="true"></i> {{ unavailableText }}</span>
          </div>

          <svg class="annotation-canvas__marks" :viewBox="`0 0 ${width} ${height}`" preserveAspectRatio="none" aria-hidden="true" focusable="false">
            <g
              v-for="mark in shownMarks"
              :key="mark.id"
              :class="{
                'annotation-canvas__mark--faded': isMarkFaded(mark),
                'annotation-canvas__mark--movable': isEditable(mark),
              }"
            >
              <template v-for="(shape, index) in mark.shapes" :key="index">
                <g v-if="shape.type === 'box'">
                  <rect class="annotation-canvas__hit" :x="shape.x" :y="shape.y" :width="shape.w" :height="shape.h" />
                  <rect
                    :x="shape.x"
                    :y="shape.y"
                    :width="shape.w"
                    :height="shape.h"
                    :rx="boxRadius(shape)"
                    fill="none"
                    :stroke="shape.style.color"
                    :stroke-width="shape.style.stroke"
                  />
                </g>
                <rect
                  v-else-if="shape.type === 'highlight'"
                  class="annotation-canvas__highlight"
                  :x="shape.x"
                  :y="shape.y"
                  :width="shape.w"
                  :height="shape.h"
                  rx="2"
                  :fill="shape.style.color"
                />
                <g v-else-if="shape.type === 'arrow'">
                  <path class="annotation-canvas__hit" :d="arrowPath(shape)" />
                  <path
                    :d="arrowPath(shape)"
                    fill="none"
                    :stroke="shape.style.color"
                    :stroke-width="shape.style.stroke"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </g>
                <g v-else-if="shape.type === 'pen'">
                  <polyline class="annotation-canvas__hit" :points="penPoints(shape)" />
                  <polyline
                    :points="penPoints(shape)"
                    fill="none"
                    :stroke="shape.style.color"
                    :stroke-width="shape.style.stroke"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </g>
                <rect
                  v-else-if="shape.type === 'text'"
                  :x="shape.x"
                  :y="shape.y"
                  :width="shape.w"
                  :height="shape.h"
                  rx="4"
                  :fill="textLabelColors(shape.style.color).fill"
                  fill-opacity="0.94"
                  :stroke="textLabelColors(shape.style.color).frame"
                  stroke-width="1.5"
                  vector-effect="non-scaling-stroke"
                />
              </template>
            </g>
            <rect
              v-if="selectionOutline"
              class="annotation-canvas__selection"
              :x="selectionOutline.x"
              :y="selectionOutline.y"
              :width="selectionOutline.w"
              :height="selectionOutline.h"
              vector-effect="non-scaling-stroke"
            />
          </svg>

          <div ref="textLayerEl" class="annotation-canvas__texts" :style="textLayerStyle">
            <template v-for="mark in shownMarks" :key="mark.id">
              <template v-for="(shape, index) in mark.shapes" :key="index">
                <template v-if="shape.type === 'text'">
                  <textarea
                    v-if="isEditable(mark)"
                    class="annotation-canvas__text"
                    :class="{ 'annotation-canvas__text--faded': isMarkFaded(mark) }"
                    :style="textStyle(shape)"
                    :value="shape.text"
                    :data-text-id="mark.id"
                    :data-shape-index="index"
                    :maxlength="MAX_TEXT_LENGTH"
                    rows="1"
                    aria-label="Text label"
                    placeholder="Type here"
                    @focus="onTextFocus(mark, index)"
                    @input="onTextInput(mark, index, $event)"
                    @blur="onTextBlur(mark, index)"
                  ></textarea>
                  <div
                    v-else
                    class="annotation-canvas__text annotation-canvas__text--readonly"
                    :class="{ 'annotation-canvas__text--faded': isMarkFaded(mark) }"
                    :style="textStyle(shape)"
                    :data-text-id="mark.id"
                    :data-shape-index="index"
                  >{{ shape.text }}</div>
                </template>
              </template>
            </template>
          </div>

          <button
            v-for="pin in pins"
            :key="pin.key"
            type="button"
            class="annotation-canvas__pin"
            :class="{
              'annotation-canvas__pin--active': pin.active,
              'annotation-canvas__pin--faded': pin.faded,
              'annotation-canvas__pin--movable': pin.movable,
            }"
            :style="{ left: pin.left, top: pin.top, '--pin-color': pin.color, '--pin-ink': pin.ink }"
            :data-pin-id="pin.id"
            :data-shape-index="pin.index"
            :aria-label="pin.label"
            :aria-current="pin.active ? 'true' : undefined"
            @click="onPinClick(pin)"
          >
            <span aria-hidden="true">{{ pin.number }}</span>
          </button>

          <button
            v-for="handle in handles"
            :key="handle.id"
            type="button"
            class="annotation-canvas__handle"
            :class="`annotation-canvas__handle--${handle.id}`"
            :style="{ left: handle.left, top: handle.top }"
            :data-handle="handle.id"
            :aria-label="handle.label"
          ></button>

          <div
            v-if="popover"
            ref="popoverEl"
            class="annotation-canvas__popover"
            :style="popoverStyle"
            data-annotation-popover
            @pointerdown.stop
            @keydown.stop
            @wheel.stop
          >
            <slot name="popover" :mark="popover.mark" :number="popover.number" :own="popover.own" :close="() => select(null)"></slot>
          </div>
        </div>
      </div>
    </div>

    <div ref="topBarEl" class="annotation-canvas__bar annotation-canvas__bar--top">
      <div v-if="$slots.controls" class="annotation-canvas__bar-item">
        <slot name="controls"></slot>
      </div>
      <span class="annotation-canvas__bar-spacer"></span>
      <div v-if="showZoom" class="annotation-canvas__bar-item annotation-canvas__zoom" role="group" aria-label="Zoom">
        <button type="button" class="annotation-canvas__zoom-button" aria-label="Zoom out" :disabled="!canZoomOut" @click="zoomOut">
          <i class="bi bi-dash-lg" aria-hidden="true"></i>
        </button>
        <span class="annotation-canvas__zoom-value" :aria-label="`Zoom ${zoomPercent}%${fitting ? ', fit to the view' : ''}`">{{ zoomPercent }}%</span>
        <button type="button" class="annotation-canvas__zoom-button" aria-label="Zoom in" :disabled="!canZoomIn" @click="zoomIn">
          <i class="bi bi-plus-lg" aria-hidden="true"></i>
        </button>
        <button type="button" class="annotation-canvas__zoom-button annotation-canvas__zoom-fit" :aria-pressed="fitting" :disabled="fitting" @click="fit">Fit</button>
        <button type="button" class="annotation-canvas__zoom-button annotation-canvas__zoom-fit" aria-label="Zoom to 100%, pixel for pixel" :disabled="atActualSize && !fitting" @click="actualSize">100%</button>
      </div>
    </div>

    <div v-if="$slots.toolbar" ref="bottomBarEl" class="annotation-canvas__bar annotation-canvas__bar--bottom">
      <div class="annotation-canvas__bar-item">
        <slot
          name="toolbar"
          :tool="tool"
          :setTool="setTool"
          :color="drawColor"
          :setColor="(value) => applyStyle({ color: value })"
          :stroke="drawStroke"
          :setStroke="(value) => applyStyle({ stroke: value })"
          :palette="palette"
          :canUndo="canUndo"
          :canRedo="canRedo"
          :canDelete="canDelete"
          :undo="undo"
          :redo="redo"
          :deleteSelected="deleteSelected"
          :readonly="!canEdit"
        ></slot>
      </div>
    </div>

    <p :id="hintId" class="visually-hidden">{{ hint }}</p>
    <p class="visually-hidden" aria-live="polite">{{ announcement }}</p>
  </div>
</template>

<style scoped>
/* Takes the parent's height when it has one; otherwise the image's aspect ratio sets the height. The padding
   ratio, unlike aspect-ratio, never turns a definite height into a minimum width that widens a grid column. */
.annotation-canvas {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 200px;
  overflow: hidden;
  background:
    radial-gradient(circle at 1px 1px, color-mix(in srgb, var(--line-strong) 70%, transparent) 1px, transparent 0) 0 0 / 18px 18px,
    var(--page-deep);
}

.annotation-canvas::before {
  display: block;
  padding-top: var(--annotation-ratio);
  content: '';
}

.annotation-canvas__workspace {
  position: absolute;
  inset: 0;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  touch-action: none;
  outline: none;
}

.annotation-canvas__workspace:focus-visible {
  box-shadow: inset 0 0 0 3px var(--accent);
}

.annotation-canvas__stage {
  display: grid;
  place-items: center;
  box-sizing: border-box;
  width: max-content;
  min-width: 100%;
  min-height: 100%;
}

.annotation-canvas__scene {
  position: relative;
  border-radius: 0.5rem;
  background: #ffffff;
  box-shadow: var(--shadow-strong);
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}

.annotation-canvas--drawing .annotation-canvas__scene {
  cursor: crosshair;
}

.annotation-canvas--panning .annotation-canvas__workspace {
  cursor: grabbing;
}

.annotation-canvas__image,
.annotation-canvas__blank {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: inherit;
  pointer-events: none;
  -webkit-user-drag: none;
}

.annotation-canvas__blank {
  display: grid;
  place-items: center;
  border: 2px dashed var(--line-strong);
  background: var(--surface-soft);
  color: var(--muted);
  font-size: 0.86rem;
}

.annotation-canvas__marks {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  pointer-events: none;
}

/* Wide invisible strokes give each thin mark a comfortable hover target. Hit testing itself is in annotation-shapes.js. */
.annotation-canvas__hit {
  fill: none;
  stroke: transparent;
  stroke-width: 20px;
  vector-effect: non-scaling-stroke;
  pointer-events: stroke;
  cursor: pointer;
}

.annotation-canvas__highlight {
  fill-opacity: 0.35;
  mix-blend-mode: multiply;
  pointer-events: fill;
  cursor: pointer;
}

.annotation-canvas__mark--movable .annotation-canvas__hit,
.annotation-canvas__mark--movable .annotation-canvas__highlight {
  cursor: move;
}

.annotation-canvas--drawing .annotation-canvas__hit,
.annotation-canvas--drawing .annotation-canvas__highlight {
  pointer-events: none;
}

.annotation-canvas__mark--faded {
  opacity: 0.4;
}

.annotation-canvas__selection {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.5px;
  stroke-dasharray: 6 5;
}

.annotation-canvas__texts {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: 0 0;
  pointer-events: none;
}

.annotation-canvas__text {
  position: absolute;
  box-sizing: border-box;
  display: block;
  min-height: 0;
  margin: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  font-family: var(--font-mono);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  overflow: hidden;
  resize: none;
  outline: none;
  pointer-events: auto;
  cursor: text;
}

.annotation-canvas__text:focus {
  box-shadow: 0 0 0 calc(2px * var(--annotation-unscale, 1)) var(--accent);
}

.annotation-canvas__text::placeholder {
  color: color-mix(in srgb, currentColor 55%, transparent);
}

.annotation-canvas__text--readonly {
  cursor: pointer;
}

.annotation-canvas__text--faded {
  opacity: 0.4;
}

.annotation-canvas--drawing .annotation-canvas__text {
  pointer-events: none;
}

.annotation-canvas__pin {
  --pin-size: 28px;
  position: absolute;
  z-index: 2;
  display: grid;
  place-items: center;
  width: var(--pin-size);
  height: var(--pin-size);
  min-height: 0;
  margin: calc(var(--pin-size) * -1.2071) 0 0 calc(var(--pin-size) * -0.5);
  padding: 0;
  border: 2px solid #ffffff;
  border-radius: 999px 999px 999px 0;
  background: var(--pin-color);
  box-shadow: 0 6px 14px rgba(7, 17, 31, 0.25);
  rotate: -45deg;
  cursor: pointer;
}

/* A 44 px touch target around the 28 px marker. */
.annotation-canvas__pin::before {
  position: absolute;
  inset: -8px;
  content: '';
}

.annotation-canvas__pin span {
  color: var(--pin-ink);
  font-size: 11px;
  font-weight: 700;
  rotate: 45deg;
}

.annotation-canvas__pin--movable {
  cursor: move;
}

.annotation-canvas__pin--active {
  z-index: 3;
  outline: 3px solid color-mix(in srgb, var(--pin-color) 35%, transparent);
  outline-offset: 2px;
}

.annotation-canvas__pin--faded {
  opacity: 0.4;
}

.annotation-canvas__pin:focus-visible {
  outline: 3px solid var(--accent);
  outline-offset: 2px;
}

/* While a drawing tool is active, strokes may start on a pin; keyboard users can still focus pins. */
.annotation-canvas--drawing .annotation-canvas__pin {
  pointer-events: none;
}

/* 44 px hit area with a small visible grip. */
.annotation-canvas__handle {
  position: absolute;
  z-index: 4;
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  min-height: 0;
  margin: -22px 0 0 -22px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  cursor: nwse-resize;
  touch-action: none;
}

.annotation-canvas__handle::before {
  width: 12px;
  height: 12px;
  border: 2px solid var(--accent);
  border-radius: 3px;
  background: #ffffff;
  content: '';
}

.annotation-canvas__handle--ne,
.annotation-canvas__handle--sw {
  cursor: nesw-resize;
}

.annotation-canvas__handle--start,
.annotation-canvas__handle--end {
  cursor: move;
}

.annotation-canvas__handle--start::before,
.annotation-canvas__handle--end::before {
  border-radius: 999px;
}

.annotation-canvas__handle:focus-visible {
  outline: 3px solid var(--accent);
  outline-offset: -8px;
}

.annotation-canvas__popover {
  position: absolute;
  z-index: 5;
  width: min(30rem, 85vw);
  overflow-y: auto;
  overscroll-behavior: contain;
  border-radius: 0.6rem;
  touch-action: pan-x pan-y;
  user-select: text;
  -webkit-user-select: text;
  cursor: auto;
}

.annotation-canvas__bar {
  position: absolute;
  right: 0.75rem;
  left: 0.75rem;
  z-index: 6;
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  pointer-events: none;
}

.annotation-canvas__bar--top {
  top: 0.75rem;
}

.annotation-canvas__bar--bottom {
  bottom: 0.75rem;
  justify-content: center;
}

.annotation-canvas__bar-item {
  max-width: 100%;
  pointer-events: auto;
}

.annotation-canvas__bar-spacer {
  flex: 1 1 auto;
}

.annotation-canvas__zoom {
  display: flex;
  align-items: center;
  gap: 0.15rem;
  padding: 0.15rem;
  border: 1px solid var(--line);
  border-radius: 0.6rem;
  background: color-mix(in srgb, var(--surface) 96%, transparent);
  box-shadow: var(--shadow);
  color: var(--ink);
}

.annotation-canvas__zoom-button {
  display: grid;
  place-items: center;
  min-width: 40px;
  height: 40px;
  padding: 0 0.5rem;
  border: 0;
  border-radius: 0.45rem;
  background: transparent;
  color: var(--ink-soft);
  font-family: var(--font-mono);
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
}

.annotation-canvas__zoom-button:disabled {
  cursor: default;
  opacity: 0.4;
}

.annotation-canvas__zoom-button:focus-visible {
  outline: 3px solid var(--accent);
  outline-offset: -2px;
}

@media (hover: hover) {
  .annotation-canvas__zoom-button:not(:disabled):hover {
    background: var(--surface-tint);
    color: var(--ink);
  }
}

.annotation-canvas__zoom-value {
  min-width: 3.2rem;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  text-align: center;
}

@media (pointer: coarse) {
  .annotation-canvas__zoom-button {
    min-width: 44px;
    height: 44px;
  }
}
</style>
