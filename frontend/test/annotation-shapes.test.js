import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANNOTATION_BLACK,
  ANNOTATION_YELLOW,
  MAX_PEN_POINTS,
  SHAPE_SCHEMA_VERSION,
  STROKE_WIDTHS,
  annotationPalette,
  arrowPath,
  createShape,
  defaultShapeAt,
  dragHandle,
  finishPenPoints,
  fromServerShape,
  fromServerShapes,
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
  resizeShape,
  resizeShapeBy,
  shapeBounds,
  simplifyPath,
  toServerShape,
  toServerShapes,
  validateShape,
} from '../src/lib/requirements/annotation-shapes.js';

const AREA = { width: 1280, height: 800 };
const STYLE = { color: '#c2410c', stroke: STROKE_WIDTHS.thin };
const shape = (fields) => ({ schemaVersion: 1, style: STYLE, ...fields });

test('validateShape accepts each of the six types and returns schemaVersion 1 with style', () => {
  const inputs = [
    shape({ type: 'pin', x: 10, y: 20, number: 1 }),
    shape({ type: 'box', x: 728, y: 381, w: 512, h: 154 }),
    shape({ type: 'arrow', x: 430, y: 360, x2: 335, y2: 318 }),
    shape({ type: 'pen', points: [[1, 1], [20, 30], [40, 10]] }),
    shape({ type: 'highlight', x: 44, y: 198, w: 470, h: 60 }),
    shape({ type: 'text', x: 930, y: 555, w: 150, h: 38, text: 'before tax?', fontSize: 17 }),
  ];
  for (const input of inputs) {
    const result = validateShape(input, AREA);
    assert.equal(result.ok, true, `${input.type}: ${result.error}`);
    assert.equal(result.shape.schemaVersion, SHAPE_SCHEMA_VERSION);
    assert.equal(result.shape.type, input.type);
    assert.deepEqual(result.shape.style, STYLE);
  }
});

test('validateShape rejects unknown types, missing or future schema versions, bad style and non-finite numbers', () => {
  assert.equal(validateShape(null, AREA).error, 'not_object');
  assert.equal(validateShape([], AREA).error, 'not_object');
  assert.equal(validateShape(shape({ type: 'circle', x: 1, y: 1, w: 9, h: 9 }), AREA).error, 'unknown_type');
  assert.equal(validateShape({ ...shape({ type: 'box', x: 1, y: 1, w: 9, h: 9 }), schemaVersion: undefined }, AREA).error, 'unsupported_schema_version');
  assert.equal(validateShape({ ...shape({ type: 'box', x: 1, y: 1, w: 9, h: 9 }), schemaVersion: 2 }, AREA).error, 'unsupported_schema_version');
  assert.equal(validateShape({ ...shape({ type: 'box', x: 1, y: 1, w: 9, h: 9 }), style: undefined }, AREA).error, 'invalid_style');
  assert.equal(validateShape({ ...shape({ type: 'box', x: 1, y: 1, w: 9, h: 9 }), style: { color: 'red', stroke: 3 } }, AREA).error, 'invalid_style');
  assert.equal(validateShape({ ...shape({ type: 'box', x: 1, y: 1, w: 9, h: 9 }), style: { color: '#c2410c', stroke: 0 } }, AREA).error, 'invalid_style');
  assert.equal(validateShape(shape({ type: 'box', x: Number.NaN, y: 1, w: 9, h: 9 }), AREA).error, 'invalid_number');
  assert.equal(validateShape(shape({ type: 'box', x: '1', y: 1, w: 9, h: 9 }), AREA).error, 'invalid_number');
  assert.equal(validateShape(shape({ type: 'arrow', x: 1, y: 1, x2: Infinity, y2: 9 }), AREA).error, 'invalid_number');
  assert.equal(validateShape(shape({ type: 'pen', points: [[1, 1], [Number.NaN, 2]] }), AREA).error, 'invalid_number');
  assert.equal(validateShape(shape({ type: 'pen', points: [[1, 1]] }), AREA).error, 'invalid_points');
  assert.equal(validateShape(shape({ type: 'pin', x: 1, y: 1, number: 0 }), AREA).error, 'invalid_pin_number');
  assert.equal(validateShape(shape({ type: 'pin', x: 1, y: 1, number: 1.5 }), AREA).error, 'invalid_pin_number');
  assert.equal(validateShape(shape({ type: 'text', x: 1, y: 1, w: 90, h: 30, text: '   ', fontSize: 16 }), AREA).error, 'empty_text');
  assert.equal(validateShape(shape({ type: 'text', x: 1, y: 1, w: 90, h: 30, text: 'x'.repeat(2001), fontSize: 16 }), AREA).error, 'invalid_text');
  assert.equal(validateShape(shape({ type: 'text', x: 1, y: 1, w: 90, h: 30, text: 'ok' }), AREA).error, 'invalid_number');
  assert.throws(() => validateShape(shape({ type: 'pin', x: 1, y: 1, number: 1 }), { width: 0, height: 10 }), TypeError);
});

test('marks smaller than 4 source pixels are discarded', () => {
  assert.equal(validateShape(shape({ type: 'box', x: 10, y: 10, w: 3.9, h: 50 }), AREA).error, 'too_small');
  assert.equal(validateShape(shape({ type: 'highlight', x: 10, y: 10, w: 50, h: 3 }), AREA).error, 'too_small');
  assert.equal(validateShape(shape({ type: 'arrow', x: 10, y: 10, x2: 12, y2: 12 }), AREA).error, 'too_small');
  assert.equal(validateShape(shape({ type: 'pen', points: [[10, 10], [11, 12], [12, 11]] }), AREA).error, 'too_small');
  assert.equal(validateShape(shape({ type: 'box', x: 10, y: 10, w: 4, h: 4 }), AREA).ok, true);
  assert.equal(validateShape(shape({ type: 'pen', points: [[10, 10], [14, 10]] }), AREA).ok, true, 'a straight pen line is kept');
  assert.equal(validateShape(shape({ type: 'pin', x: 0, y: 0, number: 1 }), AREA).ok, true, 'pins have no size');
});

test('shapes are clamped to the image, negative sizes are flipped, coordinates rounded and unknown fields dropped', () => {
  const box = normalizeShape({ ...shape({ type: 'box', x: 1200, y: -20, w: 200, h: 100 }), onclick: 'alert(1)' }, AREA);
  assert.deepEqual(box, { schemaVersion: 1, type: 'box', x: 1200, y: 0, w: 80, h: 80, style: STYLE });

  const flipped = normalizeShape(shape({ type: 'highlight', x: 100, y: 100, w: -50.04, h: -20 }), AREA);
  assert.deepEqual([flipped.x, flipped.y, flipped.w, flipped.h], [50, 80, 50, 20]);

  const arrow = normalizeShape(shape({ type: 'arrow', x: -5, y: 10.26, x2: 2000, y2: 900 }), AREA);
  assert.deepEqual([arrow.x, arrow.y, arrow.x2, arrow.y2], [0, 10.3, 1280, 800]);

  const pen = normalizeShape(shape({ type: 'pen', points: [[-10, 5], [1300, 900]] }), AREA);
  assert.deepEqual(pen.points, [[0, 5], [1280, 800]]);

  const pin = normalizeShape(shape({ type: 'pin', x: 9999, y: -1, number: 3 }), AREA);
  assert.deepEqual([pin.x, pin.y, pin.number], [1280, 0, 3]);

  const text = normalizeShape(shape({ type: 'text', x: 10, y: 10, w: 100, h: 30, text: 'Hi', fontSize: 9000 }), AREA);
  assert.equal(text.fontSize, 512);

  const style = normalizeShape({ ...shape({ type: 'box', x: 1, y: 1, w: 9, h: 9 }), style: { color: '#ABC', stroke: 99 } }, AREA).style;
  assert.deepEqual(style, { color: '#aabbcc', stroke: 24 });
});

test('createShape starts each tool with schemaVersion and style', () => {
  for (const type of ['pin', 'box', 'arrow', 'pen', 'highlight', 'text']) {
    const created = createShape(type, { x: 10, y: 20 }, { style: { color: '#07111F', stroke: 6 }, number: 4 });
    assert.equal(created.schemaVersion, 1);
    assert.deepEqual(created.style, { color: '#07111f', stroke: 6 });
  }
  assert.equal(createShape('pin', { x: 1, y: 1 }, { number: 4 }).number, 4);
  assert.deepEqual(createShape('pen', { x: 1, y: 2 }).points, [[1, 2]]);
  assert.equal(createShape('text', { x: 1, y: 2 }, { fontSize: 20 }).text, '');
  assert.deepEqual(createShape('box', { x: 1, y: 2 }, { style: { color: 'nope' } }).style, { color: '#c2410c', stroke: 3 });
  assert.throws(() => createShape('circle', { x: 1, y: 1 }), TypeError);
});

test('annotationPalette offers the layer color, black and yellow without duplicates', () => {
  assert.deepEqual(annotationPalette('#7C3AED'), ['#7c3aed', ANNOTATION_BLACK, ANNOTATION_YELLOW]);
  assert.deepEqual(annotationPalette(ANNOTATION_YELLOW), [ANNOTATION_YELLOW, ANNOTATION_BLACK]);
  assert.deepEqual(annotationPalette('not a color'), ['#c2410c', ANNOTATION_BLACK, ANNOTATION_YELLOW]);
  assert.equal(normalizeColor('url(javascript:1)'), null);
  assert.equal(readableInk(ANNOTATION_YELLOW), ANNOTATION_BLACK);
  assert.equal(readableInk('#c2410c'), '#ffffff');
});

test('bounds cover every shape type and the whole annotation', () => {
  assert.deepEqual(shapeBounds(shape({ type: 'arrow', x: 50, y: 40, x2: 10, y2: 80 })), { x: 10, y: 40, w: 40, h: 40 });
  assert.deepEqual(shapeBounds(shape({ type: 'pen', points: [[5, 9], [1, 3], [8, 4]] })), { x: 1, y: 3, w: 7, h: 6 });
  assert.deepEqual(shapeBounds(shape({ type: 'pin', x: 5, y: 6, number: 1 })), { x: 5, y: 6, w: 0, h: 0 });
  const mark = { id: 'a', shapes: [shape({ type: 'pin', x: 100, y: 100, number: 1 }), shape({ type: 'box', x: 120, y: 50, w: 30, h: 20 })] };
  assert.deepEqual(markBounds(mark), { x: 100, y: 50, w: 50, h: 50 });
  assert.equal(markBounds({ id: 'b', shapes: [] }), null);
  assert.deepEqual(markAnchor(mark), { x: 100, y: 100 }, 'a pin anchors the thread');
  assert.deepEqual(markAnchor({ id: 'c', shapes: [mark.shapes[1]] }), { x: 120, y: 70 });
});

test('moveShape moves every type and stops at the image edge without deforming', () => {
  const box = shape({ type: 'box', x: 10, y: 10, w: 100, h: 50 });
  assert.deepEqual(moveShape(box, 5, -5, AREA), { ...box, x: 15, y: 5 });
  assert.deepEqual(moveShape(box, -50, 2000, AREA), { ...box, x: 0, y: 750 }, 'clamped as a whole');

  const arrow = shape({ type: 'arrow', x: 10, y: 10, x2: 60, y2: 30 });
  assert.deepEqual(moveShape(arrow, 5, 5, AREA), { ...arrow, x: 15, y: 15, x2: 65, y2: 35 });
  assert.deepEqual(moveShape(arrow, -100, 0, AREA), { ...arrow, x: 0, x2: 50 });

  const pen = shape({ type: 'pen', points: [[10, 10], [20, 30]] });
  assert.deepEqual(moveShape(pen, 1270, 0, AREA).points, [[1270, 10], [1280, 30]]);

  const pin = shape({ type: 'pin', x: 10, y: 10, number: 1 });
  assert.deepEqual(moveShape(pin, -5, 5, AREA), { ...pin, x: 5, y: 15 });
  assert.equal(box.x, 10, 'the input is not mutated');
});

test('resizeShape and resizeShapeBy keep the 4 px minimum and the image edge', () => {
  const box = shape({ type: 'box', x: 10, y: 10, w: 100, h: 50 });
  assert.deepEqual(resizeShapeBy(box, 5, 5, AREA), { ...box, w: 105, h: 55 });
  assert.deepEqual(resizeShapeBy(box, -200, -200, AREA), { ...box, w: 4, h: 4 });
  assert.deepEqual(resizeShapeBy({ ...box, x: 1250 }, 100, 0, AREA), { ...box, x: 1250, w: 30 });

  const pen = shape({ type: 'pen', points: [[0, 0], [10, 20]] });
  assert.deepEqual(resizeShape(pen, { x: 0, y: 0, w: 20, h: 40 }, AREA).points, [[0, 0], [20, 40]]);
  const flat = shape({ type: 'pen', points: [[0, 10], [10, 10]] });
  assert.deepEqual(resizeShapeBy(flat, 10, 10, AREA).points, [[0, 10], [20, 10]], 'a flat stroke only stretches along its length');

  const arrow = shape({ type: 'arrow', x: 10, y: 10, x2: 60, y2: 30 });
  assert.deepEqual(resizeShapeBy(arrow, 5, -5, AREA), { ...arrow, x2: 65, y2: 25 }, 'Shift+arrow moves the arrow end');
  const pin = shape({ type: 'pin', x: 10, y: 10, number: 1 });
  assert.deepEqual(resizeShapeBy(pin, 5, 5, AREA), pin);
});

test('handles: four corners for boxes, two ends for arrows, none for pins; dragging keeps the opposite corner', () => {
  const box = shape({ type: 'box', x: 10, y: 10, w: 100, h: 50 });
  assert.deepEqual(handlesFor(box).map((h) => [h.id, h.x, h.y]), [['nw', 10, 10], ['ne', 110, 10], ['sw', 10, 60], ['se', 110, 60]]);
  assert.deepEqual(handlesFor(shape({ type: 'arrow', x: 1, y: 2, x2: 30, y2: 40 })).map((h) => h.id), ['start', 'end']);
  assert.deepEqual(handlesFor(shape({ type: 'pin', x: 1, y: 2, number: 1 })), []);

  assert.deepEqual(dragHandle(box, 'se', { x: 150, y: 100 }, AREA), { ...box, w: 140, h: 90 });
  assert.deepEqual(dragHandle(box, 'nw', { x: 0, y: 0 }, AREA), { ...box, x: 0, y: 0, w: 110, h: 60 });
  assert.deepEqual(dragHandle(box, 'se', { x: 0, y: 0 }, AREA), { ...box, x: 0, y: 0, w: 10, h: 10 }, 'dragging past the fixed corner flips');
  assert.deepEqual(dragHandle(box, 'se', { x: 11, y: 11 }, AREA), { ...box, w: 4, h: 4 }, 'never smaller than 4 px');
  assert.deepEqual(dragHandle(box, 'se', { x: 5000, y: 5000 }, AREA), { ...box, w: 1270, h: 790 });

  const arrow = shape({ type: 'arrow', x: 10, y: 10, x2: 60, y2: 30 });
  assert.deepEqual(dragHandle(arrow, 'start', { x: -4, y: 900 }, AREA), { ...arrow, x: 0, y: 800 });
  assert.deepEqual(dragHandle(arrow, 'end', { x: 70, y: 40 }, AREA), { ...arrow, x2: 70, y2: 40 });
});

test('hitTest finds the topmost shape, uses wide stroke tolerance and only counts box interiors last', () => {
  const marks = [
    { id: 'box', shapes: [shape({ type: 'box', x: 100, y: 100, w: 400, h: 300 })] },
    { id: 'arrow', shapes: [shape({ type: 'arrow', x: 150, y: 150, x2: 350, y2: 150 })] },
    { id: 'pen', shapes: [shape({ type: 'pen', points: [[600, 600], [700, 700]] })] },
    { id: 'hl', shapes: [shape({ type: 'highlight', x: 800, y: 100, w: 100, h: 20 })] },
    { id: 'group', shapes: [shape({ type: 'pin', x: 1000, y: 500, number: 1 }), shape({ type: 'text', x: 1000, y: 600, w: 120, h: 30, text: 'Hi', fontSize: 16 })] },
  ];
  assert.deepEqual(hitTest(marks, { x: 250, y: 158 }), { id: 'arrow', shapeIndex: 0 }, 'near the arrow line');
  assert.equal(hitTest(marks, { x: 250, y: 180 }, { tolerance: 8 }).id, 'box', 'inside the box but away from the arrow');
  assert.deepEqual(hitTest(marks, { x: 103, y: 250 }), { id: 'box', shapeIndex: 0 }, 'on the box edge');
  assert.equal(hitTest(marks, { x: 655, y: 645 }).id, 'pen');
  assert.equal(hitTest(marks, { x: 690, y: 600 }), null, 'away from the pen stroke');
  assert.equal(hitTest(marks, { x: 850, y: 110 }).id, 'hl');
  assert.deepEqual(hitTest(marks, { x: 1000, y: 486 }), { id: 'group', shapeIndex: 0 }, 'the pin marker sits above its point');
  assert.deepEqual(hitTest(marks, { x: 1050, y: 610 }), { id: 'group', shapeIndex: 1 });
  assert.equal(hitTest(marks, { x: 1200, y: 20 }), null);
  assert.equal(hitTest(marks, { x: 250, y: 180 }, { tolerance: 40 }).id, 'arrow', 'touch tolerance widens strokes');

  const nested = [
    { id: 'outer', shapes: [shape({ type: 'box', x: 0, y: 0, w: 500, h: 500 })] },
    { id: 'inner', shapes: [shape({ type: 'box', x: 200, y: 200, w: 50, h: 50 })] },
  ];
  assert.equal(hitTest(nested.slice().reverse(), { x: 225, y: 225 }).id, 'inner', 'the smallest box interior wins');
});

test('simplifyPath removes points within 1.5 px of the line and keeps corners', () => {
  const straight = Array.from({ length: 50 }, (_, i) => [i * 2, (i % 2) * 0.5]);
  assert.deepEqual(simplifyPath(straight), [[0, 0], [98, 0.5]]);
  const corner = [[0, 0], [5, 0.2], [10, 0], [10, 5], [10.3, 10], [10, 20]];
  assert.deepEqual(simplifyPath(corner), [[0, 0], [10, 0], [10, 20]]);
  assert.deepEqual(simplifyPath([[1, 1], [2, 2]]), [[1, 1], [2, 2]]);
  assert.deepEqual(simplifyPath([{ x: 0, y: 0 }, { x: 5, y: 0.1 }, { x: 10, y: 0 }]), [[0, 0], [10, 0]]);

  const long = Array.from({ length: 50000 }, (_, i) => [i % 1000, Math.floor(i / 1000) * 10 + (i % 7)]);
  assert.ok(finishPenPoints(long).length <= MAX_PEN_POINTS, 'long scribbles are loosened until they fit');
});

test('mark numbering continues across reviewers and fills marks without a number', () => {
  const marks = [
    { id: 'a', number: 1, shapes: [shape({ type: 'pin', x: 1, y: 1, number: 1 })] },
    { id: 'b', shapes: [shape({ type: 'box', x: 1, y: 1, w: 9, h: 9 })] },
    { id: 'c', shapes: [shape({ type: 'pin', x: 1, y: 1, number: 4 })] },
    { id: 'd', shapes: [shape({ type: 'arrow', x: 1, y: 1, x2: 20, y2: 20 })] },
  ];
  assert.equal(nextMarkNumber(marks), 5);
  assert.equal(nextMarkNumber([]), 1);
  assert.deepEqual([...markNumbers(marks)], [['a', 1], ['b', 5], ['c', 4], ['d', 6]]);
});

test('server round-trip keeps every type equal and fills missing style from the author color', () => {
  const shapes = [
    shape({ type: 'pin', x: 10, y: 20, number: 2 }),
    shape({ type: 'box', x: 728, y: 381, w: 512, h: 154 }),
    shape({ type: 'arrow', x: 430, y: 360, x2: 335, y2: 318 }),
    shape({ type: 'pen', points: [[1, 1], [20, 30], [40, 10]] }),
    shape({ type: 'highlight', x: 44, y: 198, w: 470, h: 60 }),
    shape({ type: 'text', x: 930, y: 555, w: 150, h: 38, text: 'before tax?', fontSize: 17 }),
  ];
  const sent = toServerShapes(shapes, AREA);
  assert.equal(sent.length, 6);
  const json = JSON.parse(JSON.stringify(sent));
  assert.deepEqual(fromServerShapes(json, { ...AREA, color: '#000000' }), sent);

  assert.equal(toServerShape({ ...shapes[1], schemaVersion: undefined }, AREA).schemaVersion, 1);
  assert.deepEqual(toServerShapes([shapes[0], shape({ type: 'box', x: 1, y: 1, w: 1, h: 1 })], AREA), [shapes[0]], 'tiny marks are not sent');

  const legacy = fromServerShape({ type: 'pen', points: [{ x: 1, y: 1 }, { x: 30, y: 4 }] }, { ...AREA, color: '#7C3AED' });
  assert.deepEqual(legacy, { schemaVersion: 1, type: 'pen', points: [[1, 1], [30, 4]], style: { color: '#7c3aed', stroke: 3 } });
  assert.equal(fromServerShape({ ...shapes[1], schemaVersion: 2 }, AREA), null, 'a future schema is skipped, not misdrawn');
  assert.equal(fromServerShape({ ...shapes[1], type: 'ellipse' }, AREA), null);
  assert.deepEqual(fromServerShapes('nope', AREA), []);
});

test('defaultShapeAt places keyboard-created marks around the centre inside the image', () => {
  const pin = defaultShapeAt('pin', { x: 640, y: 400 }, { bounds: AREA, number: 3, style: STYLE });
  assert.deepEqual([pin.type, pin.x, pin.y, pin.number], ['pin', 640, 400, 3]);
  const box = defaultShapeAt('box', { x: 5, y: 5 }, { bounds: AREA, style: STYLE });
  assert.equal(validateShape(box, AREA).ok, true);
  assert.ok(box.x >= 0 && box.y >= 0);
  assert.equal(validateShape(defaultShapeAt('arrow', { x: 640, y: 400 }, { bounds: AREA, style: STYLE }), AREA).ok, true);
  const text = defaultShapeAt('text', { x: 1270, y: 790 }, { bounds: AREA, style: STYLE });
  assert.ok(text.x + text.w <= AREA.width && text.y + text.h <= AREA.height);
  assert.equal(defaultShapeAt('pen', { x: 1, y: 1 }, { bounds: AREA }), null, 'freehand needs a pointer');
});

test('arrowPath draws the shaft and a head sized from the stroke, capped at half the length', () => {
  assert.equal(arrowPath(shape({ type: 'arrow', x: 0, y: 0, x2: 100, y2: 0 })), 'M 0 0 L 100 0 M 89.5 5.8 L 100 0 L 89.5 -5.8');
  const thick = arrowPath({ ...shape({ type: 'arrow', x: 0, y: 0, x2: 100, y2: 0 }), style: { color: '#c2410c', stroke: 6 } });
  assert.match(thick, /M 78\.9 11\.5 L 100 0/, 'thick strokes get a larger head');
  assert.match(arrowPath(shape({ type: 'arrow', x: 0, y: 0, x2: 10, y2: 0 })), /M 5\.6 2\.4 L 10 0/);
  assert.equal(arrowPath(shape({ type: 'arrow', x: 5, y: 5, x2: 5, y2: 5 })), 'M 5 5 L 5 5');
});

test('newAnnotationId returns distinct v4 UUIDs', () => {
  const ids = new Set(Array.from({ length: 50 }, () => newAnnotationId()));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
