// Annotations in the guided review: server records to editor marks, the surface a mark sits
// on (an image screen, a prototype snapshot, or a blank frame when capture failed), save
// payloads, and merging a refetch with edits that have not been saved yet.

import { buildLayers } from './annotation-layers.js';
import { fromServerShapes, markBounds, normalizeColor, toServerShapes } from './annotation-shapes.js';

// Layer colors per reviewer, picked from the reviewer's reference so they stay stable.
export const LAYER_COLORS = Object.freeze(['#c2410c', '#7c3aed', '#0369a1', '#4d7c0f', '#be185d', '#0f766e', '#a16207', '#4338ca']);

const STATUS_LABELS = Object.freeze({
  carried: 'Carried forward',
  outdated: 'Outdated',
  resolved: 'Resolved',
  superseded: 'Superseded',
});

// Own marks the editor must not change (an earlier round's, or any once the round closed)
// are passed under this suffix, so the editor treats them as someone else's.
const LOCKED_SUFFIX = '~locked';

export function personColor(ref) {
  const text = String(ref ?? '');
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  return LAYER_COLORS[hash % LAYER_COLORS.length];
}

export function annotationStatusLabel(status) {
  return STATUS_LABELS[status] ?? '';
}

export function lockedRef(ref) {
  return `${ref}${LOCKED_SUFFIX}`;
}

/** Hidden layers as the editor sees them: each hidden person, plus their locked marks. */
export function editorHiddenAuthors(hidden = []) {
  return hidden.flatMap((ref) => [ref, lockedRef(ref)]);
}

/** The surface an annotation is drawn on. */
export function surfaceKeyOf(annotation) {
  if (annotation?.snapshotFileId) return `snapshot:${annotation.snapshotFileId}`;
  if (annotation?.localSnapshotId) return `local:${annotation.localSnapshotId}`;
  if (annotation?.anchor?.snapshotUnavailable) return `blank:${annotation.stateKey ?? ''}`;
  return 'image';
}

/** Keys that identify one snapshot surface (its stored id, and its local id before upload). */
export function snapshotSurfaceKeys(snapshot) {
  if (!snapshot) return ['image'];
  if (snapshot.unavailable) return [`blank:${snapshot.stateKey ?? ''}`];
  const keys = [];
  if (snapshot.snapshotFileId) keys.push(`snapshot:${snapshot.snapshotFileId}`);
  if (snapshot.localId) keys.push(`local:${snapshot.localId}`);
  return keys;
}

export function annotationsOnScreen(annotations = [], screenId) {
  return annotations.filter((annotation) => annotation.screenId === screenId);
}

export function annotationsOnSurface(annotations = [], { screenId, snapshot = null } = {}) {
  const keys = new Set(snapshotSurfaceKeys(snapshot));
  return annotationsOnScreen(annotations, screenId).filter((annotation) => {
    if (!snapshot) return true;
    if (keys.has(surfaceKeyOf(annotation))) return true;
    return Boolean(snapshot.localId && annotation.localSnapshotId === snapshot.localId);
  });
}

/**
 * State keys a mark on the prototype's current state may carry: the declared state, the
 * bridge's key, and the bridge's path-plus-hash key for the same place, which a mark gets
 * when the prototype had not declared the state yet.
 */
export function liveStateKeys(state, declaredKey = '') {
  if (!state) return [];
  return [...new Set([declaredKey, state.key, `${state.path ?? ''}${state.hash ?? ''}`].filter(Boolean))];
}

/** Marks to draw over the live prototype: this version's marks on the state it shows. */
export function annotationsOnLiveState(annotations = [], { screenId, stateKeys = [] } = {}) {
  const keys = new Set(stateKeys);
  return annotationsOnScreen(annotations, screenId).filter((annotation) => keys.has(annotation.stateKey) && !['outdated', 'superseded'].includes(annotation.status));
}

/** How far a mark moves on the live page: where the page was scrolled for its snapshot, less where it is now. */
export function scrollOffset(annotation, scroll) {
  const from = annotation?.anchor?.scroll;
  return { x: (Number(from?.x) || 0) - (Number(scroll?.x) || 0), y: (Number(from?.y) || 0) - (Number(scroll?.y) || 0) };
}

/** The reviewer as the editor and the layer bar show them. */
export function reviewActor(me) {
  return { color: personColor(me?.actorRef), name: me?.name || 'You', ref: me?.actorRef ?? '' };
}

/** The layer bar's layers, one per author. The reviewer comes first when they can annotate. */
export function annotationLayers(annotations = [], { actor, readOnly = false } = {}) {
  return buildLayers(annotations.map((annotation) => ({
    authorName: annotation.isMine ? actor?.name ?? annotation.authorName : annotation.authorName,
    authorRef: annotation.authorRef,
    color: annotation.color || annotation.shapes?.[0]?.style?.color || personColor(annotation.authorRef),
  })), readOnly ? null : actor);
}

/** An annotation can be edited by its author while it belongs to the open round. */
export function isEditableAnnotation(annotation, { readOnly = false } = {}) {
  if (readOnly || !annotation?.isMine) return false;
  if (annotation.localOnly) return true;
  return Boolean(annotation.actions?.edit);
}

/** The editor's mark for an annotation. `bounds` is the surface size in source pixels. */
export function toCanvasMark(annotation, { bounds, readOnly = false } = {}) {
  const color = normalizeColor(annotation.color) || normalizeColor(annotation.shapes?.[0]?.style?.color) || personColor(annotation.authorRef);
  const editable = isEditableAnnotation(annotation, { readOnly });
  return {
    authorName: annotation.authorName || 'Reviewer',
    authorRef: annotation.isMine && !editable ? lockedRef(annotation.authorRef) : annotation.authorRef,
    category: annotation.category ?? null,
    color,
    id: annotation.id,
    number: Number.isInteger(annotation.number) && annotation.number > 0 ? annotation.number : undefined,
    shapes: fromServerShapes(annotation.shapes, { color, height: bounds.height, width: bounds.width }),
    status: annotation.status ?? 'open',
  };
}

/** The reviewer's own new annotation, before the server has seen it. */
export function localAnnotation({ authorName, authorRef, id, number, screenId, shapes, snapshot = null }) {
  const now = new Date().toISOString();
  return {
    actions: { carry: false, changeStatus: true, close: false, comment: true, delete: true, edit: true },
    anchor: snapshot?.unavailable ? { note: 'Snapshot unavailable', snapshotUnavailable: true } : snapshot?.scroll ? { scroll: snapshot.scroll } : {},
    authorName,
    authorRef,
    category: null,
    color: shapes?.[0]?.style?.color ?? null,
    createdAt: now,
    elementHint: null,
    id,
    isMine: true,
    localOnly: true,
    localSnapshotId: snapshot && !snapshot.unavailable ? snapshot.localId ?? null : null,
    number,
    screenId,
    shapes,
    snapshotFileId: snapshot?.snapshotFileId ?? null,
    snapshotUrl: null,
    stateKey: snapshot?.stateKey ?? null,
    status: 'open',
    thread: [],
    updatedAt: now,
  };
}

/** PUT /annotations/:id body. */
export function annotationPayload(annotation, { bounds = null, restored = false } = {}) {
  const shapes = bounds ? toServerShapes(annotation.shapes, bounds) : annotation.shapes;
  const payload = {
    anchor: annotation.anchor ?? {},
    category: annotation.category || null,
    elementHint: annotation.elementHint ? elementHintPayload(annotation.elementHint) : null,
    restored: Boolean(restored),
    screenId: annotation.screenId,
    shapes,
    snapshotFileId: annotation.snapshotFileId ?? null,
    stateKey: annotation.stateKey ?? null,
  };
  return payload;
}

function finiteBox(box) {
  if (!box || typeof box !== 'object') return null;
  const values = ['x', 'y', 'width', 'height'].map((key) => Number(box[key]));
  if (!values.every(Number.isFinite)) return null;
  const [x, y, width, height] = values;
  return { height, width, x, y };
}

/** The bridge's hint, trimmed to what the server stores. */
export function elementHintPayload(hint) {
  if (!hint || typeof hint !== 'object') return null;
  return {
    box: finiteBox(hint.box),
    odinId: typeof hint.odinId === 'string' && hint.odinId ? hint.odinId.slice(0, 64) : null,
    tag: typeof hint.tag === 'string' && hint.tag ? hint.tag.slice(0, 40) : null,
    text: typeof hint.text === 'string' && hint.text ? hint.text.slice(0, 200) : null,
  };
}

/** "Attached to" line parts for an element hint. */
export function elementHintLabel(hint) {
  if (!hint) return null;
  const text = String(hint.text ?? '').replace(/\s+/g, ' ').trim();
  const name = text ? (text.length > 48 ? `${text.slice(0, 47)}…` : text) : hint.tag ? `${hint.tag} element` : 'an element';
  return { name, odinId: hint.odinId || '' };
}

/** Where to ask the prototype which element a mark points at: the first pin, else the mark's middle. */
export function hintPoint(shapes = []) {
  const pin = shapes.find((shape) => shape?.type === 'pin');
  if (pin) return { x: pin.x, y: pin.y };
  const box = markBounds({ shapes });
  if (!box) return null;
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

/** Every pin shows its annotation's number, as the server stores it. */
export function numberShapes(shapes = [], number) {
  if (!Number.isInteger(number) || number < 1) return shapes;
  return shapes.map((shape) => (shape?.type === 'pin' ? { ...shape, number } : shape));
}

/**
 * Merges a refetched annotation list with the review's local records. Annotations with
 * unsaved changes keep the local marks and category but take the server's thread, status,
 * actions and number; local annotations the server has not seen yet stay; ones deleted
 * here and not yet confirmed stay hidden.
 */
export function mergeAnnotationLists({ deletedIds = new Set(), local = new Map(), pendingIds = new Set(), server = [] }) {
  const result = [];
  const serverIds = new Set();
  for (const remote of server) {
    serverIds.add(remote.id);
    if (deletedIds.has(remote.id)) continue;
    const mine = local.get(remote.id);
    if (mine && pendingIds.has(remote.id)) {
      result.push({
        ...remote,
        anchor: mine.anchor ?? remote.anchor,
        category: mine.category,
        elementHint: mine.elementHint ?? remote.elementHint,
        localSnapshotId: mine.localSnapshotId ?? null,
        shapes: numberShapes(mine.shapes, remote.number),
        snapshotFileId: mine.snapshotFileId ?? remote.snapshotFileId,
      });
    } else {
      result.push({ ...remote, localSnapshotId: mine?.localSnapshotId ?? null });
    }
  }
  for (const mine of local.values()) {
    if (serverIds.has(mine.id) || deletedIds.has(mine.id)) continue;
    if (mine.localOnly && pendingIds.has(mine.id)) result.push(mine);
  }
  return result;
}

/** Count of the reviewer's own marks per screen, for the submit summary. */
export function countMarksByScreen(annotations = [], { mineOnly = true } = {}) {
  const counts = {};
  for (const annotation of annotations) {
    if (mineOnly && !annotation.isMine) continue;
    if (['outdated', 'superseded'].includes(annotation.status)) continue;
    counts[annotation.screenId] = (counts[annotation.screenId] ?? 0) + 1;
  }
  return counts;
}

/** Top-level comments with their replies; deeper replies sit under their first ancestor. */
export function threadTree(thread = []) {
  const byId = new Map(thread.map((comment) => [comment.id, comment]));
  const rootOf = (comment) => {
    let current = comment;
    const seen = new Set();
    while (current?.parentCommentId && byId.has(current.parentCommentId) && !seen.has(current.id)) {
      seen.add(current.id);
      current = byId.get(current.parentCommentId);
    }
    return current;
  };
  const roots = [];
  const replies = new Map();
  for (const comment of thread) {
    const root = rootOf(comment);
    if (root === comment) {
      roots.push(comment);
      replies.set(comment.id, []);
    }
  }
  for (const comment of thread) {
    const root = rootOf(comment);
    if (root !== comment) replies.get(root.id)?.push(comment);
  }
  return roots.map((comment) => ({ comment, replies: replies.get(comment.id) ?? [] }));
}

/** Turns the bridge's PNG data URL into bytes for the snapshot upload. */
export function dataUrlToBlob(dataUrl) {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(String(dataUrl ?? ''));
  if (!match) return null;
  const binary = globalThis.atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: match[1] });
}

let localCounter = 0;

export function nextLocalSnapshotId() {
  localCounter += 1;
  return `snap-${Date.now().toString(36)}-${localCounter.toString(36)}`;
}
