// Annotation shape model for review screens (package-spec.md section 8).
// Every coordinate is in source pixels of the screen image or snapshot, so marks keep their place at any zoom.

export const SHAPE_SCHEMA_VERSION = 1;
export const SHAPE_TYPES = Object.freeze(['pin', 'box', 'arrow', 'pen', 'highlight', 'text']);
export const ANNOTATION_TOOLS = Object.freeze(['select', ...SHAPE_TYPES]);
export const STROKE_WIDTHS = Object.freeze({ thin: 3, thick: 6 });
export const MIN_MARK_SIZE = 4;
export const PEN_TOLERANCE = 1.5;
export const MAX_PEN_POINTS = 2000;
export const MAX_TEXT_LENGTH = 2000;
export const MIN_FONT_SIZE = 4;
export const MAX_FONT_SIZE = 512;
export const MAX_STROKE = 24;
export const ANNOTATION_BLACK = '#07111f';
export const ANNOTATION_YELLOW = '#facc15';
export const DEFAULT_LAYER_COLOR = '#c2410c';

const RECT_TYPES = new Set(['box', 'highlight', 'text']);
const CORNERS = ['nw', 'ne', 'sw', 'se'];
const CORNER_LABELS = { nw: 'top-left', ne: 'top-right', sw: 'bottom-left', se: 'bottom-right' };
const TYPE_LABELS = { pin: 'Pin', box: 'Box', arrow: 'Arrow', pen: 'Pen', highlight: 'Highlight', text: 'Text' };

const round1 = (value) => Math.round(value * 10) / 10;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

function imageBounds(bounds) {
  const width = Number(bounds?.width);
  const height = Number(bounds?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new TypeError('Annotation bounds need a positive width and height in source pixels.');
  }
  return { width, height };
}

export function shapeTypeLabel(type) {
  return TYPE_LABELS[type] || 'Mark';
}

export function normalizeColor(value) {
  if (typeof value !== 'string') return null;
  const hex = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(hex)) return hex;
  if (/^#[0-9a-f]{3}$/.test(hex)) return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  return null;
}

// The three swatches: the reviewer's layer color, then black and yellow.
export function annotationPalette(layerColor) {
  const colors = [normalizeColor(layerColor) || DEFAULT_LAYER_COLOR, ANNOTATION_BLACK, ANNOTATION_YELLOW];
  return colors.filter((color, index) => colors.indexOf(color) === index);
}

export function normalizeStyle(style) {
  if (!style || typeof style !== 'object') return null;
  const color = normalizeColor(style.color);
  if (!color || !finite(style.stroke) || style.stroke <= 0) return null;
  return { color, stroke: round1(clamp(style.stroke, 1, MAX_STROKE)) };
}

export function createStyle({ color, stroke } = {}) {
  return normalizeStyle({ color, stroke }) || { color: normalizeColor(color) || DEFAULT_LAYER_COLOR, stroke: STROKE_WIDTHS.thin };
}

function relativeLuminance(color) {
  const hex = normalizeColor(color) || ANNOTATION_BLACK;
  const channel = (offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

// Text and pin numbers drawn on a mark color: white on dark colors, ink on light ones such as yellow.
export function readableInk(color) {
  return relativeLuminance(color) > 0.45 ? ANNOTATION_BLACK : '#ffffff';
}

// Text labels sit on a light card; a light mark color tints the card instead of coloring the letters.
export function textLabelColors(color) {
  const base = normalizeColor(color) || DEFAULT_LAYER_COLOR;
  if (relativeLuminance(base) > 0.45) return { ink: ANNOTATION_BLACK, fill: base, frame: '#8a6516' };
  return { ink: base, fill: '#fffef0', frame: base };
}

export function textMetrics(fontSize) {
  return { lineHeight: fontSize * 1.35, padding: fontSize * 0.45 };
}

function readPoint(point) {
  if (Array.isArray(point) && point.length === 2) return [point[0], point[1]];
  if (point && typeof point === 'object') return [point.x, point.y];
  return null;
}

function rectFrom(x, y, w, h, bounds) {
  let left = x;
  let top = y;
  let right = x + w;
  let bottom = y + h;
  if (right < left) [left, right] = [right, left];
  if (bottom < top) [top, bottom] = [bottom, top];
  left = clamp(left, 0, bounds.width);
  right = clamp(right, 0, bounds.width);
  top = clamp(top, 0, bounds.height);
  bottom = clamp(bottom, 0, bounds.height);
  return { x: round1(left), y: round1(top), w: round1(right - left), h: round1(bottom - top) };
}

function fail(error) {
  return { ok: false, error };
}

// Strict check used before a shape leaves the editor. Rejects unknown types and non-finite numbers,
// clamps to the image, rounds to 0.1 px, drops unknown fields and discards marks under 4 source pixels.
export function validateShape(input, bounds) {
  const area = imageBounds(bounds);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('not_object');
  if (!SHAPE_TYPES.includes(input.type)) return fail('unknown_type');
  if (input.schemaVersion !== SHAPE_SCHEMA_VERSION) return fail('unsupported_schema_version');
  const style = normalizeStyle(input.style);
  if (!style) return fail('invalid_style');
  const head = { schemaVersion: SHAPE_SCHEMA_VERSION, type: input.type };

  if (input.type === 'pin') {
    if (!finite(input.x) || !finite(input.y)) return fail('invalid_number');
    if (!Number.isInteger(input.number) || input.number < 1) return fail('invalid_pin_number');
    return { ok: true, shape: { ...head, x: round1(clamp(input.x, 0, area.width)), y: round1(clamp(input.y, 0, area.height)), number: input.number, style } };
  }

  if (input.type === 'arrow') {
    if (![input.x, input.y, input.x2, input.y2].every(finite)) return fail('invalid_number');
    const x = round1(clamp(input.x, 0, area.width));
    const y = round1(clamp(input.y, 0, area.height));
    const x2 = round1(clamp(input.x2, 0, area.width));
    const y2 = round1(clamp(input.y2, 0, area.height));
    if (Math.hypot(x2 - x, y2 - y) < MIN_MARK_SIZE) return fail('too_small');
    return { ok: true, shape: { ...head, x, y, x2, y2, style } };
  }

  if (input.type === 'pen') {
    if (!Array.isArray(input.points) || input.points.length < 2 || input.points.length > MAX_PEN_POINTS) return fail('invalid_points');
    const points = [];
    for (const raw of input.points) {
      const point = readPoint(raw);
      if (!point || !finite(point[0]) || !finite(point[1])) return fail('invalid_number');
      points.push([round1(clamp(point[0], 0, area.width)), round1(clamp(point[1], 0, area.height))]);
    }
    const box = pointsBounds(points);
    if (Math.max(box.w, box.h) < MIN_MARK_SIZE) return fail('too_small');
    return { ok: true, shape: { ...head, points, style } };
  }

  if (![input.x, input.y, input.w, input.h].every(finite)) return fail('invalid_number');
  const rect = rectFrom(input.x, input.y, input.w, input.h, area);
  if (rect.w < MIN_MARK_SIZE || rect.h < MIN_MARK_SIZE) return fail('too_small');
  if (input.type !== 'text') return { ok: true, shape: { ...head, ...rect, style } };

  if (typeof input.text !== 'string' || input.text.length > MAX_TEXT_LENGTH) return fail('invalid_text');
  if (!input.text.trim()) return fail('empty_text');
  if (!finite(input.fontSize)) return fail('invalid_number');
  return { ok: true, shape: { ...head, ...rect, text: input.text, fontSize: round1(clamp(input.fontSize, MIN_FONT_SIZE, MAX_FONT_SIZE)), style } };
}

export function normalizeShape(input, bounds) {
  const result = validateShape(input, bounds);
  return result.ok ? result.shape : null;
}

// A shape as it starts while drawing. It is not valid until it is dragged out and normalized.
export function createShape(type, point, { style, number, fontSize = 16, width, height } = {}) {
  if (!SHAPE_TYPES.includes(type)) throw new TypeError(`Unknown annotation shape type: ${type}`);
  const head = { schemaVersion: SHAPE_SCHEMA_VERSION, type };
  const shapeStyle = createStyle(style);
  const x = round1(point.x);
  const y = round1(point.y);
  if (type === 'pin') return { ...head, x, y, number: number ?? 1, style: shapeStyle };
  if (type === 'arrow') return { ...head, x, y, x2: x, y2: y, style: shapeStyle };
  if (type === 'pen') return { ...head, points: [[x, y]], style: shapeStyle };
  if (type === 'text') {
    const metrics = textMetrics(fontSize);
    return { ...head, x, y, w: round1(width ?? fontSize * 14), h: round1(height ?? metrics.lineHeight + metrics.padding * 2), text: '', fontSize: round1(fontSize), style: shapeStyle };
  }
  return { ...head, x, y, w: 0, h: 0, style: shapeStyle };
}

function pointsBounds(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function shapeBounds(shape) {
  if (shape.type === 'pin') return { x: shape.x, y: shape.y, w: 0, h: 0 };
  if (shape.type === 'arrow') return pointsBounds([[shape.x, shape.y], [shape.x2, shape.y2]]);
  if (shape.type === 'pen') return pointsBounds(shape.points);
  return { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
}

export function markBounds(mark) {
  const shapes = mark?.shapes || [];
  if (!shapes.length) return null;
  const boxes = shapes.map(shapeBounds);
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.w));
  const bottom = Math.max(...boxes.map((b) => b.y + b.h));
  return { x, y, w: right - x, h: bottom - y };
}

// Moves the whole shape, stopping at the image edge so a shape never deforms against it.
export function moveShape(shape, dx, dy, bounds) {
  const area = imageBounds(bounds);
  const box = shapeBounds(shape);
  const mx = round1(clamp(dx, -box.x, area.width - (box.x + box.w)));
  const my = round1(clamp(dy, -box.y, area.height - (box.y + box.h)));
  if (shape.type === 'pen') return { ...shape, points: shape.points.map(([x, y]) => [round1(x + mx), round1(y + my)]) };
  const moved = { ...shape, x: round1(shape.x + mx), y: round1(shape.y + my) };
  if (shape.type === 'arrow') Object.assign(moved, { x2: round1(shape.x2 + mx), y2: round1(shape.y2 + my) });
  return moved;
}

// Fits the shape into `rect` (source pixels). Pens and arrows scale their points from their old bounds.
export function resizeShape(shape, rect, bounds) {
  const area = imageBounds(bounds);
  if (shape.type === 'pin') return { ...shape };
  const target = rectFrom(rect.x, rect.y, rect.w, rect.h, area);
  target.w = Math.max(MIN_MARK_SIZE, target.w);
  target.h = Math.max(MIN_MARK_SIZE, target.h);
  target.x = round1(Math.min(target.x, area.width - target.w));
  target.y = round1(Math.min(target.y, area.height - target.h));
  if (RECT_TYPES.has(shape.type)) return { ...shape, ...target };
  const box = shapeBounds(shape);
  const sx = box.w > 0 ? target.w / box.w : 1;
  const sy = box.h > 0 ? target.h / box.h : 1;
  const map = ([x, y]) => [round1(target.x + (x - box.x) * sx), round1(target.y + (y - box.y) * sy)];
  if (shape.type === 'pen') return { ...shape, points: shape.points.map(map) };
  const [x, y] = map([shape.x, shape.y]);
  const [x2, y2] = map([shape.x2, shape.y2]);
  return { ...shape, x, y, x2, y2 };
}

// Keyboard resize (Shift + arrow keys). An arrow's end point moves instead.
export function resizeShapeBy(shape, dw, dh, bounds) {
  const area = imageBounds(bounds);
  if (shape.type === 'pin') return { ...shape };
  if (shape.type === 'arrow') {
    return { ...shape, x2: round1(clamp(shape.x2 + dw, 0, area.width)), y2: round1(clamp(shape.y2 + dh, 0, area.height)) };
  }
  const box = shapeBounds(shape);
  // A flat pen stroke has no height to grow; shrinking stops at the minimum instead of flipping the shape.
  const w = box.w > 0 ? Math.max(MIN_MARK_SIZE, box.w + dw) : box.w;
  const h = box.h > 0 ? Math.max(MIN_MARK_SIZE, box.h + dh) : box.h;
  return resizeShape(shape, { x: box.x, y: box.y, w, h }, area);
}

export function handlesFor(shape) {
  if (!shape || shape.type === 'pin') return [];
  if (shape.type === 'arrow') {
    return [
      { id: 'start', x: shape.x, y: shape.y, label: 'Move arrow start' },
      { id: 'end', x: shape.x2, y: shape.y2, label: 'Move arrow end' },
    ];
  }
  const box = shapeBounds(shape);
  const at = { nw: [box.x, box.y], ne: [box.x + box.w, box.y], sw: [box.x, box.y + box.h], se: [box.x + box.w, box.y + box.h] };
  return CORNERS.map((id) => ({ id, x: at[id][0], y: at[id][1], label: `Resize from the ${CORNER_LABELS[id]} corner` }));
}

// Drags one handle to `point`. The opposite corner stays fixed; a corner dragged past it flips the shape.
export function dragHandle(shape, handle, point, bounds) {
  const area = imageBounds(bounds);
  const px = clamp(point.x, 0, area.width);
  const py = clamp(point.y, 0, area.height);
  if (shape.type === 'arrow') {
    if (handle === 'start') return { ...shape, x: round1(px), y: round1(py) };
    if (handle === 'end') return { ...shape, x2: round1(px), y2: round1(py) };
    return { ...shape };
  }
  if (!CORNERS.includes(handle) || shape.type === 'pin') return { ...shape };
  const box = shapeBounds(shape);
  const fx = handle.includes('w') ? box.x + box.w : box.x;
  const fy = handle.startsWith('n') ? box.y + box.h : box.y;
  const w = Math.max(MIN_MARK_SIZE, Math.abs(px - fx));
  const h = Math.max(MIN_MARK_SIZE, Math.abs(py - fy));
  return resizeShape(shape, { x: px < fx ? fx - w : fx, y: py < fy ? fy - h : fy, w, h }, area);
}

// SVG path for an arrow: the shaft, then a two-stroke head at (x2, y2) scaled to the stroke width.
export function arrowPath(shape) {
  const dx = shape.x2 - shape.x;
  const dy = shape.y2 - shape.y;
  const length = Math.hypot(dx, dy);
  const shaft = `M ${shape.x} ${shape.y} L ${shape.x2} ${shape.y2}`;
  if (length < 0.01) return shaft;
  const head = Math.min(Math.max(12, (shape.style?.stroke || STROKE_WIDTHS.thin) * 4), length * 0.5);
  const angle = Math.atan2(dy, dx);
  const wing = (offset) => `${round1(shape.x2 - head * Math.cos(angle + offset))} ${round1(shape.y2 - head * Math.sin(angle + offset))}`;
  return `${shaft} M ${wing(-0.5)} L ${shape.x2} ${shape.y2} L ${wing(0.5)}`;
}

export function distanceToSegment(point, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? clamp(((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared, 0, 1) : 0;
  return Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dy));
}

function strokeHit(shape, p, tolerance) {
  const reach = tolerance + (shape.style?.stroke || STROKE_WIDTHS.thin) / 2;
  if (shape.type === 'arrow') return distanceToSegment(p, [shape.x, shape.y], [shape.x2, shape.y2]) <= reach;
  if (shape.type === 'pen') {
    if (shape.points.length === 1) return Math.hypot(p[0] - shape.points[0][0], p[1] - shape.points[0][1]) <= reach;
    for (let index = 1; index < shape.points.length; index += 1) {
      if (distanceToSegment(p, shape.points[index - 1], shape.points[index]) <= reach) return true;
    }
    return false;
  }
  if (shape.type === 'box') {
    const inOuter = p[0] >= shape.x - reach && p[0] <= shape.x + shape.w + reach && p[1] >= shape.y - reach && p[1] <= shape.y + shape.h + reach;
    const inInner = p[0] > shape.x + reach && p[0] < shape.x + shape.w - reach && p[1] > shape.y + reach && p[1] < shape.y + shape.h - reach;
    return inOuter && !inInner;
  }
  return false;
}

function shapeHit(shape, p, { tolerance, pinRadius }) {
  if (shape.type === 'pin') return Math.hypot(p[0] - shape.x, p[1] - (shape.y - pinRadius)) <= pinRadius + tolerance;
  if (shape.type === 'highlight' || shape.type === 'text') {
    return p[0] >= shape.x - tolerance && p[0] <= shape.x + shape.w + tolerance && p[1] >= shape.y - tolerance && p[1] <= shape.y + shape.h + tolerance;
  }
  return strokeHit(shape, p, tolerance);
}

// Finds the topmost shape under `point` (source pixels). Strokes, filled marks and pins win first; the inside of
// an outline box counts only when nothing else is there, and the smallest such box wins.
export function hitTest(marks, point, { tolerance = 8, pinRadius = 14 } = {}) {
  const p = [point.x, point.y];
  for (let m = marks.length - 1; m >= 0; m -= 1) {
    const shapes = marks[m]?.shapes || [];
    for (let s = shapes.length - 1; s >= 0; s -= 1) {
      if (shapeHit(shapes[s], p, { tolerance, pinRadius })) return { id: marks[m].id, shapeIndex: s };
    }
  }
  let best = null;
  for (let m = marks.length - 1; m >= 0; m -= 1) {
    const shapes = marks[m]?.shapes || [];
    shapes.forEach((shape, s) => {
      if (shape.type !== 'box') return;
      if (p[0] < shape.x || p[0] > shape.x + shape.w || p[1] < shape.y || p[1] > shape.y + shape.h) return;
      const area = shape.w * shape.h;
      if (!best || area < best.area) best = { id: marks[m].id, shapeIndex: s, area };
    });
  }
  return best ? { id: best.id, shapeIndex: best.shapeIndex } : null;
}

// Ramer-Douglas-Peucker, iterative so long strokes cannot overflow the stack.
export function simplifyPath(points, tolerance = PEN_TOLERANCE) {
  const list = (points || []).map(readPoint).filter((point) => point && finite(point[0]) && finite(point[1]));
  if (list.length < 3) return list;
  const keep = new Uint8Array(list.length);
  keep[0] = 1;
  keep[list.length - 1] = 1;
  const stack = [[0, list.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let index = -1;
    let furthest = 0;
    for (let i = first + 1; i < last; i += 1) {
      const distance = distanceToSegment(list[i], list[first], list[last]);
      if (distance > furthest) {
        furthest = distance;
        index = i;
      }
    }
    if (index !== -1 && furthest > tolerance) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return list.filter((_, i) => keep[i]);
}

// Simplifies a finished pen stroke, loosening the tolerance until it fits the point limit.
export function finishPenPoints(points, tolerance = PEN_TOLERANCE) {
  let simplified = simplifyPath(points, tolerance);
  let next = tolerance;
  while (simplified.length > MAX_PEN_POINTS) {
    next *= 2;
    simplified = simplifyPath(simplified, next);
  }
  return simplified;
}

function pinNumbersOf(mark) {
  const numbers = [];
  if (Number.isInteger(mark?.number) && mark.number > 0) numbers.push(mark.number);
  for (const shape of mark?.shapes || []) {
    if (shape?.type === 'pin' && Number.isInteger(shape.number) && shape.number > 0) numbers.push(shape.number);
  }
  return numbers;
}

// Annotations are numbered per screen across every reviewer, in creation order. A new annotation takes the next
// number, and a pin shows its annotation's number. The server may renumber on a collision.
export function nextMarkNumber(marks) {
  let highest = 0;
  for (const mark of marks || []) for (const number of pinNumbersOf(mark)) highest = Math.max(highest, number);
  return highest + 1;
}

// Display number for each annotation: its own number, else its pin's, else the next free number in list order.
export function markNumbers(marks) {
  const numbers = new Map();
  let next = nextMarkNumber(marks);
  for (const mark of marks || []) {
    const [known] = pinNumbersOf(mark);
    numbers.set(mark.id, known ?? next++);
  }
  return numbers;
}

export function primaryShape(mark) {
  const shapes = mark?.shapes || [];
  return shapes.find((shape) => shape.type === 'pin') || shapes[0] || null;
}

// The anchor point for a thread popover: the pin if there is one, else the bottom-left of the mark.
export function markAnchor(mark) {
  const pin = (mark?.shapes || []).find((shape) => shape.type === 'pin');
  if (pin) return { x: pin.x, y: pin.y };
  const box = markBounds(mark);
  return box ? { x: box.x, y: box.y + box.h } : null;
}

// A default shape centred on `center`, used when a keyboard user places a mark with Enter.
export function defaultShapeAt(type, center, { size = 160, style, number, fontSize = 16, bounds } = {}) {
  const area = imageBounds(bounds);
  const half = size / 2;
  const cx = clamp(center.x, 0, area.width);
  const cy = clamp(center.y, 0, area.height);
  if (type === 'pin') return createShape('pin', { x: cx, y: cy }, { style, number });
  if (type === 'arrow') {
    const shape = createShape('arrow', { x: cx - half, y: cy + half / 2 }, { style });
    return normalizeShape({ ...shape, x2: cx, y2: cy }, area);
  }
  if (type === 'text') {
    const shape = createShape('text', { x: cx - half, y: cy }, { style, fontSize, width: size * 1.5 });
    return { ...shape, ...rectFrom(shape.x, shape.y, shape.w, shape.h, area) };
  }
  if (type === 'box' || type === 'highlight') {
    return normalizeShape({ ...createShape(type, { x: cx - half, y: cy - half / 2 }, { style }), w: size, h: size / 2 }, area);
  }
  return null;
}

export function toServerShape(shape, bounds) {
  return normalizeShape({ ...shape, schemaVersion: shape?.schemaVersion ?? SHAPE_SCHEMA_VERSION }, bounds);
}

export function toServerShapes(shapes, bounds) {
  return (shapes || []).map((shape) => toServerShape(shape, bounds)).filter(Boolean);
}

// Reads a stored shape. Missing style falls back to the author's color and the thin stroke, and pen points may be
// `{ x, y }` objects. Unknown types and other schema versions are skipped rather than drawn wrongly.
export function fromServerShape(raw, { width, height, color } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== SHAPE_SCHEMA_VERSION) return null;
  const style = normalizeStyle(raw.style) || createStyle({ color, stroke: raw.style?.stroke });
  const input = { ...raw, schemaVersion: SHAPE_SCHEMA_VERSION, style };
  if (raw.type === 'pen' && Array.isArray(raw.points)) input.points = raw.points.map(readPoint);
  return normalizeShape(input, { width, height });
}

export function fromServerShapes(shapes, options) {
  return (Array.isArray(shapes) ? shapes : []).map((shape) => fromServerShape(shape, options)).filter(Boolean);
}

function randomHex(bytes) {
  const values = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(values);
  return [...values].map((value) => value.toString(16).padStart(2, '0')).join('');
}

// Client ID for a new annotation. randomUUID is missing on plain-HTTP origins other than localhost.
export function newAnnotationId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const hex = randomHex(16).split('');
  hex[12] = '4';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const text = hex.join('');
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}
