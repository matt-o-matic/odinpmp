// Tool names, icons and single-key shortcuts shared by the annotation toolbar and canvas.

import { ANNOTATION_BLACK, ANNOTATION_YELLOW, ANNOTATION_TOOLS } from './annotation-shapes.js';

export const TOOL_META = Object.freeze({
  select: { label: 'Select', icon: 'bi-cursor', key: 'V' },
  pin: { label: 'Pin a comment', icon: 'bi-pin-angle', key: 'C' },
  box: { label: 'Box', icon: 'bi-square', key: 'B' },
  arrow: { label: 'Arrow', icon: 'bi-arrow-up-right', key: 'A' },
  pen: { label: 'Pen', icon: 'bi-pencil', key: 'P' },
  highlight: { label: 'Highlight', icon: 'bi-highlighter', key: 'H' },
  text: { label: 'Text label', icon: 'bi-fonts', key: 'T' },
});

export function toolForKey(key) {
  const upper = String(key || '').toUpperCase();
  return ANNOTATION_TOOLS.find((tool) => TOOL_META[tool].key === upper) || null;
}

export function swatchLabel(color, index) {
  if (color === ANNOTATION_BLACK) return 'Black';
  if (color === ANNOTATION_YELLOW) return 'Yellow';
  return index === 0 ? 'Your layer color' : `Color ${color}`;
}
