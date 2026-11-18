import { z } from 'zod';

// Server-side check of annotation shapes (package-spec.md section 8). It mirrors the
// editor's model in frontend/src/lib/requirements/annotation-shapes.js: schemaVersion 1,
// a style with a hex color and a stroke of 1-24 source pixels, finite coordinates inside
// the screen or snapshot, and no mark smaller than 4 source pixels. The editor clamps and
// rounds before it sends, so anything outside these rules is rejected, not repaired.
// Pin numbers are the server's: every pin takes its annotation's display number.

export const SHAPE_SCHEMA_VERSION = 1;
export const MIN_MARK_SIZE = 4;
export const MIN_STROKE = 1;
export const MAX_STROKE = 24;
export const MAX_PEN_POINTS = 2000;
export const MAX_TEXT_LENGTH = 2000;
export const MIN_FONT_SIZE = 4;
export const MAX_FONT_SIZE = 512;
// Coordinates are rounded to 0.1 px by the editor; allow that much past the edge.
const EDGE_TOLERANCE = 0.1;

const finite = z.number().finite();
const style = z.object({
  color: z.string().trim().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/),
  stroke: finite,
}).strip();
const head = { schemaVersion: z.literal(SHAPE_SCHEMA_VERSION), style };

const shapeSchema = z.discriminatedUnion('type', [
  z.object({ ...head, number: z.number().int().min(1).optional(), type: z.literal('pin'), x: finite, y: finite }).strip(),
  z.object({ ...head, h: finite, type: z.literal('box'), w: finite, x: finite, y: finite }).strip(),
  z.object({ ...head, h: finite, type: z.literal('highlight'), w: finite, x: finite, y: finite }).strip(),
  z.object({ ...head, type: z.literal('arrow'), x: finite, x2: finite, y: finite, y2: finite }).strip(),
  z.object({ ...head, points: z.array(z.tuple([finite, finite])).min(2).max(MAX_PEN_POINTS), type: z.literal('pen') }).strip(),
  z.object({
    ...head,
    fontSize: finite,
    h: finite,
    text: z.string().max(MAX_TEXT_LENGTH),
    type: z.literal('text'),
    w: finite,
    x: finite,
    y: finite,
  }).strip(),
]);

function round1(value) {
  return Math.round(value * 10) / 10;
}

function normalizeColor(value) {
  const hex = value.trim().toLowerCase();
  return hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
}

function issue(index, code, message) {
  return { code, index, message };
}

function structuralCode(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'not_object';
  if (!['pin', 'box', 'highlight', 'arrow', 'pen', 'text'].includes(input.type)) return 'unknown_type';
  if (input.schemaVersion !== SHAPE_SCHEMA_VERSION) return 'unsupported_schema_version';
  if (!style.safeParse(input.style).success) return 'invalid_style';
  if (input.type === 'pen' && (!Array.isArray(input.points) || input.points.length < 2 || input.points.length > MAX_PEN_POINTS)) return 'invalid_points';
  return 'invalid_shape';
}

/**
 * Validates shapes against a screen or snapshot of `bounds` ({ width, height } in source
 * pixels). Returns `{ ok: true, shapes }` with normalized shapes (lower-case six-digit
 * colors, coordinates rounded to 0.1 px), or `{ ok: false, issues: [{ index, code, message }] }`.
 */
export function validateShapes(inputs, bounds) {
  const width = Number(bounds?.width);
  const height = Number(bounds?.height);
  const issues = [];
  const shapes = [];
  const inX = (value) => value >= -EDGE_TOLERANCE && value <= width + EDGE_TOLERANCE;
  const inY = (value) => value >= -EDGE_TOLERANCE && value <= height + EDGE_TOLERANCE;

  (Array.isArray(inputs) ? inputs : []).forEach((input, index) => {
    const parsed = shapeSchema.safeParse(input);
    if (!parsed.success) {
      issues.push(issue(index, structuralCode(input), 'This mark is not a valid annotation shape.'));
      return;
    }
    const shape = parsed.data;
    if (shape.style.stroke < MIN_STROKE || shape.style.stroke > MAX_STROKE) {
      issues.push(issue(index, 'invalid_style', `Stroke width must be ${MIN_STROKE}-${MAX_STROKE} px.`));
      return;
    }
    const normalizedStyle = { color: normalizeColor(shape.style.color), stroke: round1(shape.style.stroke) };
    const base = { schemaVersion: SHAPE_SCHEMA_VERSION, style: normalizedStyle, type: shape.type };

    if (shape.type === 'pin') {
      if (!inX(shape.x) || !inY(shape.y)) { issues.push(issue(index, 'out_of_bounds', 'The pin is outside the screen.')); return; }
      shapes.push({ ...base, number: shape.number ?? 1, x: round1(shape.x), y: round1(shape.y) });
      return;
    }

    if (shape.type === 'arrow') {
      if (![shape.x, shape.x2].every(inX) || ![shape.y, shape.y2].every(inY)) {
        issues.push(issue(index, 'out_of_bounds', 'The arrow is outside the screen.'));
        return;
      }
      if (Math.hypot(shape.x2 - shape.x, shape.y2 - shape.y) < MIN_MARK_SIZE) {
        issues.push(issue(index, 'too_small', `Marks must be at least ${MIN_MARK_SIZE} px.`));
        return;
      }
      shapes.push({ ...base, x: round1(shape.x), x2: round1(shape.x2), y: round1(shape.y), y2: round1(shape.y2) });
      return;
    }

    if (shape.type === 'pen') {
      if (shape.points.some(([x, y]) => !inX(x) || !inY(y))) {
        issues.push(issue(index, 'out_of_bounds', 'The stroke leaves the screen.'));
        return;
      }
      const xs = shape.points.map(([x]) => x);
      const ys = shape.points.map(([, y]) => y);
      if (Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) < MIN_MARK_SIZE) {
        issues.push(issue(index, 'too_small', `Marks must be at least ${MIN_MARK_SIZE} px.`));
        return;
      }
      shapes.push({ ...base, points: shape.points.map(([x, y]) => [round1(x), round1(y)]) });
      return;
    }

    // box, highlight, text: a rectangle with a non-negative size.
    if (shape.w < MIN_MARK_SIZE || shape.h < MIN_MARK_SIZE) {
      issues.push(issue(index, 'too_small', `Marks must be at least ${MIN_MARK_SIZE} px.`));
      return;
    }
    if (!inX(shape.x) || !inY(shape.y) || !inX(shape.x + shape.w) || !inY(shape.y + shape.h)) {
      issues.push(issue(index, 'out_of_bounds', 'The mark is outside the screen.'));
      return;
    }
    const rect = { h: round1(shape.h), w: round1(shape.w), x: round1(shape.x), y: round1(shape.y) };
    if (shape.type !== 'text') {
      shapes.push({ ...base, ...rect });
      return;
    }
    if (!shape.text.trim()) { issues.push(issue(index, 'empty_text', 'A text label needs text.')); return; }
    if (shape.fontSize < MIN_FONT_SIZE || shape.fontSize > MAX_FONT_SIZE) {
      issues.push(issue(index, 'invalid_number', `Font size must be ${MIN_FONT_SIZE}-${MAX_FONT_SIZE} px.`));
      return;
    }
    shapes.push({ ...base, ...rect, fontSize: round1(shape.fontSize), text: shape.text });
  });

  return issues.length > 0 ? { issues, ok: false } : { ok: true, shapes };
}

/** Every pin shows its annotation's display number. */
export function numberPins(shapes, number) {
  return (shapes ?? []).map((shape) => (shape?.type === 'pin' ? { ...shape, number } : shape));
}
