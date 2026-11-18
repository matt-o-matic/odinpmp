import assert from 'node:assert/strict';
import test from 'node:test';

import { buildLayers, categoryLabel, initials, isMarkFaded, markLabel, markTypeLabel, visibleMarks } from '../src/lib/requirements/annotation-layers.js';

const shape = (type, extra = {}) => ({ schemaVersion: 1, type, style: { color: '#c2410c', stroke: 3 }, ...extra });
const marks = [
  { id: '1', authorRef: 'jo', authorName: 'Jamie Ortiz', color: '#7c3aed', category: 'hierarchy', status: 'open', shapes: [shape('pin', { x: 1, y: 1, number: 1 })] },
  { id: '2', authorRef: 'me', authorName: 'Ravi Shah', color: '#c2410c', category: 'type', status: 'open', shapes: [shape('pin', { x: 1, y: 1, number: 2 }), shape('box', { x: 1, y: 1, w: 9, h: 9 })] },
  { id: '3', authorRef: 'jo', authorName: 'Jamie Ortiz', color: '#7c3aed', category: 'custom_tone', status: 'resolved', shapes: [shape('arrow', { x: 1, y: 1, x2: 9, y2: 9 })] },
];

test('initials use the first and last word', () => {
  assert.equal(initials('Ravi Shah'), 'RS');
  assert.equal(initials('Ana María de la Ruiz'), 'AR');
  assert.equal(initials('cher'), 'CH');
  assert.equal(initials('  '), '?');
});

test('buildLayers lists the current reviewer first, then authors in order, with counts', () => {
  const layers = buildLayers(marks, { ref: 'me', name: 'Ravi Shah', color: '#C2410C' });
  assert.deepEqual(layers.map((l) => [l.ref, l.count, l.self]), [['me', 1, true], ['jo', 2, false]]);
  assert.equal(layers[0].color, '#c2410c');
  assert.deepEqual(buildLayers([], { ref: 'me', name: 'Ravi Shah' }).map((l) => l.count), [0], 'your own layer shows before you mark anything');
});

test('visibleMarks hides hidden layers and, unless asked, resolved marks', () => {
  assert.deepEqual(visibleMarks(marks).map((m) => m.id), ['1', '2', '3']);
  assert.deepEqual(visibleMarks(marks, { hiddenAuthors: ['jo'] }).map((m) => m.id), ['2']);
  assert.deepEqual(visibleMarks(marks, { showResolved: false }).map((m) => m.id), ['1', '2']);
  assert.equal(isMarkFaded(marks[2]), true);
  assert.equal(isMarkFaded(marks[0]), false);
});

test('markLabel reads "number. type · author · category" with status when not open', () => {
  assert.equal(markLabel(marks[0], { number: 1 }), '1. Pin · Jamie Ortiz · Hierarchy & navigation');
  assert.equal(markLabel(marks[0], { number: 1, categoryLabels: { hierarchy: 'Hierarchy' } }), '1. Pin · Jamie Ortiz · Hierarchy');
  assert.equal(markLabel(marks[1], { number: 2 }), '2. Pin + 1 mark · Ravi Shah · Type & size');
  assert.equal(markLabel(marks[2], { number: 3 }), '3. Arrow · Jamie Ortiz · Custom tone · Resolved');
  assert.equal(markLabel({ id: 'x', shapes: [] }), '?. Mark · Reviewer');
  assert.equal(markTypeLabel({ shapes: [shape('box'), shape('pen'), shape('text')] }), 'Box + 2 marks');
  assert.equal(categoryLabel(''), '');
});
