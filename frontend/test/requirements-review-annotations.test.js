import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LAYER_COLORS,
  annotationLayers,
  annotationPayload,
  annotationsOnLiveState,
  annotationsOnSurface,
  countMarksByScreen,
  dataUrlToBlob,
  editorHiddenAuthors,
  elementHintLabel,
  elementHintPayload,
  hintPoint,
  isEditableAnnotation,
  liveStateKeys,
  localAnnotation,
  lockedRef,
  mergeAnnotationLists,
  numberShapes,
  personColor,
  reviewActor,
  scrollOffset,
  surfaceKeyOf,
  threadTree,
  toCanvasMark,
} from '../src/lib/requirements/review-annotations.js';

const style = { color: '#c2410c', stroke: 3 };
const pin = (x, y, number = 1) => ({ number, schemaVersion: 1, style, type: 'pin', x, y });
const box = (x, y) => ({ h: 40, schemaVersion: 1, style, type: 'box', w: 60, x, y });

function server(overrides) {
  return {
    actions: { carry: false, changeStatus: true, close: false, comment: true, delete: true, edit: true },
    anchor: {},
    authorName: 'Ravi Shah',
    authorRef: 'person:ravi',
    category: null,
    id: 'a1',
    isMine: true,
    number: 1,
    screenId: 'home',
    shapes: [pin(100, 120)],
    snapshotFileId: null,
    status: 'open',
    thread: [],
    ...overrides,
  };
}

test('person colors are stable and come from the layer palette', () => {
  assert.equal(personColor('person:ravi'), personColor('person:ravi'));
  assert.ok(LAYER_COLORS.includes(personColor('person:jamie')));
});

test('canvas marks lock the reviewer\'s own marks that can no longer be edited', () => {
  const bounds = { height: 800, width: 1280 };
  const open = toCanvasMark(server(), { bounds });
  assert.equal(open.authorRef, 'person:ravi');
  assert.equal(open.number, 1);
  assert.equal(open.shapes[0].type, 'pin');
  const outdated = toCanvasMark(server({ actions: { carry: true, close: true, edit: false }, status: 'outdated' }), { bounds });
  assert.equal(outdated.authorRef, lockedRef('person:ravi'));
  assert.equal(outdated.status, 'outdated');
  const closedRound = toCanvasMark(server(), { bounds, readOnly: true });
  assert.equal(closedRound.authorRef, lockedRef('person:ravi'));
  const theirs = toCanvasMark(server({ authorRef: 'person:jamie', isMine: false }), { bounds });
  assert.equal(theirs.authorRef, 'person:jamie');
  assert.deepEqual(editorHiddenAuthors(['person:ravi']), ['person:ravi', 'person:ravi~locked']);
  assert.equal(isEditableAnnotation({ isMine: true, localOnly: true }), true);
  assert.equal(isEditableAnnotation({ actions: { edit: false }, isMine: true }), false);
});

test('surfaces group prototype marks by snapshot, local snapshot, or blank frame', () => {
  const list = [
    server({ id: 'img', screenId: 'home' }),
    server({ id: 'snap', screenId: 'flow', snapshotFileId: 's-1', stateKey: 'pick-time' }),
    server({ id: 'local', localSnapshotId: 'snap-local', screenId: 'flow' }),
    server({ anchor: { snapshotUnavailable: true }, id: 'blank', screenId: 'flow', stateKey: 'confirm' }),
  ];
  assert.equal(surfaceKeyOf(list[0]), 'image');
  assert.equal(surfaceKeyOf(list[1]), 'snapshot:s-1');
  assert.equal(surfaceKeyOf(list[2]), 'local:snap-local');
  assert.equal(surfaceKeyOf(list[3]), 'blank:confirm');
  assert.deepEqual(annotationsOnSurface(list, { screenId: 'home' }).map((entry) => entry.id), ['img']);
  assert.deepEqual(annotationsOnSurface(list, { screenId: 'flow', snapshot: { localId: 'snap-local', snapshotFileId: 's-1' } }).map((entry) => entry.id), ['snap', 'local']);
  assert.deepEqual(annotationsOnSurface(list, { screenId: 'flow', snapshot: { stateKey: 'confirm', unavailable: true } }).map((entry) => entry.id), ['blank']);
});

test('a new local annotation records its snapshot, or the blank-frame note when capture failed', () => {
  const onSnapshot = localAnnotation({ authorName: 'Ravi', authorRef: 'person:ravi', id: 'n1', number: 4, screenId: 'flow', shapes: [pin(5, 5, 4)], snapshot: { localId: 'snap-1', snapshotFileId: null, stateKey: 'pick-time' } });
  assert.equal(onSnapshot.localSnapshotId, 'snap-1');
  assert.equal(onSnapshot.stateKey, 'pick-time');
  assert.equal(onSnapshot.localOnly, true);
  const blank = localAnnotation({ authorName: 'Ravi', authorRef: 'person:ravi', id: 'n2', number: 5, screenId: 'flow', shapes: [pin(5, 5, 5)], snapshot: { stateKey: 'confirm', unavailable: true } });
  assert.deepEqual(blank.anchor, { note: 'Snapshot unavailable', snapshotUnavailable: true });
  assert.equal(blank.localSnapshotId, null);
  const scrolled = localAnnotation({ authorName: 'Ravi', authorRef: 'person:ravi', id: 'n3', number: 6, screenId: 'flow', shapes: [pin(5, 5, 6)], snapshot: { localId: 'snap-2', scroll: { x: 0, y: 340 }, stateKey: 'pick-time' } });
  assert.deepEqual(scrolled.anchor, { scroll: { x: 0, y: 340 } });
});

test('browsing shows this version’s marks on the state the prototype shows, moved by the page’s scroll', () => {
  const state = { declared: true, hash: '#go-review', key: 'review', path: 'prototypes/flow/index.html' };
  assert.deepEqual(liveStateKeys(state, 'review'), ['review', 'prototypes/flow/index.html#go-review']);
  assert.deepEqual(liveStateKeys({ declared: false, hash: '', key: 'index.html', path: 'index.html' }, 'index.html'), ['index.html']);
  assert.deepEqual(liveStateKeys(null, 'review'), []);

  const list = [
    server({ id: 'declared', screenId: 'flow', snapshotFileId: 's-1', stateKey: 'review' }),
    server({ id: 'raw', screenId: 'flow', snapshotFileId: 's-2', stateKey: 'prototypes/flow/index.html#go-review' }),
    server({ id: 'other', screenId: 'flow', snapshotFileId: 's-3', stateKey: 'checkout' }),
    server({ id: 'old', screenId: 'flow', snapshotFileId: 's-4', stateKey: 'review', status: 'outdated' }),
    server({ id: 'elsewhere', screenId: 'home', stateKey: 'review' }),
  ];
  assert.deepEqual(annotationsOnLiveState(list, { screenId: 'flow', stateKeys: liveStateKeys(state, 'review') }).map((entry) => entry.id), ['declared', 'raw']);

  assert.deepEqual(scrollOffset(server({ anchor: { scroll: { x: 0, y: 300 } } }), { x: 0, y: 120 }), { x: 0, y: 180 });
  assert.deepEqual(scrollOffset(server(), { x: 10, y: 50 }), { x: -10, y: -50 });
  assert.deepEqual(scrollOffset(server(), null), { x: 0, y: 0 });
});

test('layers list each author, with the reviewer first when they can annotate', () => {
  const me = reviewActor({ actorRef: 'person:ravi', name: 'Ravi Shah' });
  assert.deepEqual([me.name, me.ref, me.color], ['Ravi Shah', 'person:ravi', personColor('person:ravi')]);
  assert.equal(reviewActor(undefined).name, 'You');
  const list = [server({ authorName: 'Server name' }), server({ authorName: 'Jamie Ortiz', authorRef: 'person:jamie', id: 'a2', isMine: false })];
  assert.deepEqual(annotationLayers(list, { actor: me }).map((layer) => [layer.ref, layer.name, layer.count, layer.self]), [['person:ravi', 'Ravi Shah', 1, true], ['person:jamie', 'Jamie Ortiz', 1, false]]);
  assert.deepEqual(annotationLayers([list[1]], { actor: me, readOnly: true }).map((layer) => layer.ref), ['person:jamie']);
});

test('the save payload carries shapes, category, snapshot, state key, element hint, and restored', () => {
  const annotation = server({
    category: 'behavior',
    elementHint: { box: { height: 40, width: 300, x: 10, y: 20 }, odinId: 'slot-day', tag: 'div', text: 'Mon 13 Tue 14' },
    screenId: 'flow',
    shapes: [pin(100, 120), box(10, 10)],
    snapshotFileId: 'snap-9',
    stateKey: 'pick-time',
  });
  const payload = annotationPayload(annotation, { bounds: { height: 800, width: 1280 }, restored: true });
  assert.equal(payload.screenId, 'flow');
  assert.equal(payload.category, 'behavior');
  assert.equal(payload.snapshotFileId, 'snap-9');
  assert.equal(payload.stateKey, 'pick-time');
  assert.equal(payload.restored, true);
  assert.deepEqual(payload.elementHint, { box: { height: 40, width: 300, x: 10, y: 20 }, odinId: 'slot-day', tag: 'div', text: 'Mon 13 Tue 14' });
  assert.equal(payload.shapes.length, 2);
  assert.equal(elementHintPayload({ box: { x: 'nope' }, tag: 'button' }).box, null);
  assert.deepEqual(elementHintLabel({ odinId: 'continue', tag: 'a', text: '  Continue   to confirm ' }), { name: 'Continue to confirm', odinId: 'continue' });
  assert.deepEqual(elementHintLabel({ odinId: null, tag: 'div', text: '' }), { name: 'div element', odinId: '' });
});

test('hint points use the first pin, else the middle of the mark', () => {
  assert.deepEqual(hintPoint([box(0, 0), pin(30, 40)]), { x: 30, y: 40 });
  assert.deepEqual(hintPoint([box(10, 20)]), { x: 40, y: 40 });
  assert.equal(hintPoint([]), null);
  assert.deepEqual(numberShapes([pin(1, 1, 1), box(0, 0)], 7).map((shape) => shape.number ?? null), [7, null]);
});

test('a refetch keeps unsaved local edits, local creates, and pending deletes', () => {
  const local = new Map([
    ['a1', server({ category: 'color', shapes: [pin(500, 500)] })],
    ['new', { ...server({ id: 'new' }), localOnly: true }],
    ['gone', server({ id: 'gone' })],
  ]);
  const remote = [
    server({ number: 3, shapes: [pin(100, 120, 3)], thread: [{ body: 'Hello', id: 'c1' }] }),
    server({ id: 'gone' }),
    server({ authorRef: 'person:jamie', id: 'theirs', isMine: false }),
  ];
  const merged = mergeAnnotationLists({ deletedIds: new Set(['gone']), local, pendingIds: new Set(['a1', 'new']), server: remote });
  assert.deepEqual(merged.map((entry) => entry.id), ['a1', 'theirs', 'new']);
  const a1 = merged[0];
  assert.equal(a1.shapes[0].x, 500, 'local marks win while a save is pending');
  assert.equal(a1.shapes[0].number, 3, 'with the server number');
  assert.equal(a1.category, 'color');
  assert.equal(a1.thread.length, 1, 'the thread comes from the server');

  const settled = mergeAnnotationLists({ local, pendingIds: new Set(), server: remote });
  assert.equal(settled[0].shapes[0].x, 100, 'without a pending save the server wins');
  assert.ok(!settled.some((entry) => entry.id === 'new'), 'a local-only mark with nothing pending is not invented');
});

test('mark counts and threads', () => {
  const list = [server({ id: '1' }), server({ id: '2', screenId: 'flow' }), server({ id: '3', isMine: false }), server({ id: '4', status: 'outdated' })];
  assert.deepEqual(countMarksByScreen(list), { flow: 1, home: 1 });
  const tree = threadTree([
    { id: 'c1', parentCommentId: null },
    { id: 'c2', parentCommentId: 'c1' },
    { id: 'c3', parentCommentId: 'c2' },
    { id: 'c4', parentCommentId: null },
  ]);
  assert.deepEqual(tree.map((entry) => [entry.comment.id, entry.replies.map((reply) => reply.id)]), [['c1', ['c2', 'c3']], ['c4', []]]);
});

test('dataUrlToBlob decodes the bridge snapshot', async () => {
  const blob = dataUrlToBlob(`data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')}`);
  assert.equal(blob.type, 'image/png');
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(dataUrlToBlob('not a data url'), null);
});
