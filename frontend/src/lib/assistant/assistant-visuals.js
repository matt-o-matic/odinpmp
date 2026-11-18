// Visuals in assistant replies: fenced ```chart, ```mermaid and ```dot (Graphviz) blocks become
// a chart, a diagram or a graph. This module splits a reply into text and visual segments,
// reads the chart spec, builds the Chart.js config, and cleans Graphviz output.

const VISUAL_FENCE = /```[ \t]*(chart|mermaid|dot|graphviz)(?![\w-])([^\n]*?)(?:\n([\s\S]*?))?```/gi;
const OPEN_VISUAL_FENCE = /```[ \t]*(chart|mermaid|dot|graphviz)(?![\w-])[^\n]*(?:\n[\s\S]*)?$/i;
const KIND = { chart: 'chart', dot: 'graphviz', graphviz: 'graphviz', mermaid: 'mermaid' };

// Models sometimes start the content on the fence line ("```chart: {...}"); keep that part. Any
// other text after the language is an ordinary info string.
function fenceLineContent(info) {
  const rest = info.trim();
  if (rest.startsWith(':')) return rest.slice(1).trim();
  return rest.startsWith('{') ? rest : '';
}

// Text and visual segments in order. A visual still being written (no closing fence yet) is
// a pending segment, so the reply never flashes raw chart JSON while it streams.
export function splitAssistantContent(text = '') {
  const source = String(text ?? '');
  const segments = [];
  let last = 0;
  for (const match of source.matchAll(VISUAL_FENCE)) {
    if (match.index > last) segments.push({ kind: 'text', text: source.slice(last, match.index) });
    const body = [fenceLineContent(match[2]), match[3] ?? ''].filter((part) => part.trim()).join('\n');
    segments.push({ kind: 'visual', source: body.trim(), type: KIND[match[1].toLowerCase()] });
    last = match.index + match[0].length;
  }
  const rest = source.slice(last);
  const open = rest.match(OPEN_VISUAL_FENCE);
  if (open) {
    if (open.index > 0) segments.push({ kind: 'text', text: rest.slice(0, open.index) });
    segments.push({ kind: 'visual', pending: true, source: '', type: KIND[open[1].toLowerCase()] });
  } else if (rest) {
    segments.push({ kind: 'text', text: rest });
  }
  return segments.filter((segment) => segment.kind === 'visual' || segment.text.trim());
}

export const CHART_TYPES = ['bar', 'horizontal-bar', 'stacked-bar', 'line', 'area', 'pie', 'doughnut'];
const MAX_SERIES = 8;
const MAX_LABELS = 60;

// The palette from the dataviz method, validated against Odin's chart surfaces: categorical
// hues in fixed order, stepped separately for light (#ffffff) and dark (#13233a).
export const CHART_PALETTE = Object.freeze({
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
});

const clip = (value, max) => String(value ?? '').slice(0, max);

// Reads the model's chart JSON into a checked spec, or explains what is wrong.
export function parseChartSpec(source = '') {
  let raw;
  try {
    raw = JSON.parse(source);
  } catch {
    return { error: 'The chart data is not valid JSON.' };
  }
  if (!raw || typeof raw !== 'object') return { error: 'The chart data is not an object.' };
  const type = String(raw.type ?? 'bar').toLowerCase();
  if (!CHART_TYPES.includes(type)) return { error: `Unknown chart type "${type}".` };
  const labels = Array.isArray(raw.labels) ? raw.labels.slice(0, MAX_LABELS).map((label) => clip(label, 80)) : [];
  const rawSeries = Array.isArray(raw.series) ? raw.series : Array.isArray(raw.datasets) ? raw.datasets : [];
  const series = rawSeries.slice(0, MAX_SERIES).map((entry, index) => ({
    data: (Array.isArray(entry?.data) ? entry.data : []).slice(0, labels.length || MAX_LABELS).map((value) => (Number.isFinite(Number(value)) ? Number(value) : null)),
    name: clip(entry?.name ?? entry?.label ?? `Series ${index + 1}`, 60),
  })).filter((entry) => entry.data.some((value) => value !== null));
  if (!labels.length || !series.length) return { error: 'The chart has no labels or data.' };
  const round = type === 'pie' || type === 'doughnut';
  return {
    spec: {
      labels,
      series: round ? series.slice(0, 1) : series,
      title: clip(raw.title, 120),
      type,
      unit: clip(raw.unit, 20),
      xLabel: clip(raw.xLabel, 60),
      yLabel: clip(raw.yLabel, 60),
    },
  };
}

function themeColors(dark) {
  return dark
    ? { grid: 'rgba(237, 243, 251, 0.10)', surface: '#13233a', text: '#c4d2e8', title: '#edf3fb' }
    : { grid: 'rgba(7, 17, 31, 0.08)', surface: '#ffffff', text: '#52514e', title: '#07111f' };
}

const formatValue = (value, unit) => (value == null ? '—' : `${Number(value).toLocaleString('en-US')}${unit ? ` ${unit}` : ''}`);

// A Chart.js config for a spec, following the mark specs: thin marks, rounded bar ends on the
// baseline, 2px lines, recessive grid, one y-axis, a legend only when there are two or more
// series (or slices), and a hover tooltip.
export function chartConfigFor(spec, { dark = false } = {}) {
  const palette = dark ? CHART_PALETTE.dark : CHART_PALETTE.light;
  const colors = themeColors(dark);
  const round = spec.type === 'pie' || spec.type === 'doughnut';
  const horizontal = spec.type === 'horizontal-bar';
  const stacked = spec.type === 'stacked-bar';
  const lineLike = spec.type === 'line' || spec.type === 'area';
  const chartType = round ? spec.type : lineLike ? 'line' : 'bar';
  const datasets = spec.series.map((entry, index) => {
    const color = palette[index % palette.length];
    if (round) {
      return { backgroundColor: spec.labels.map((_, slice) => palette[slice % palette.length]), borderColor: colors.surface, borderWidth: 2, data: entry.data, label: entry.name };
    }
    if (lineLike) {
      return { backgroundColor: spec.type === 'area' ? `${color}33` : color, borderColor: color, borderWidth: 2, data: entry.data, fill: spec.type === 'area' ? 'origin' : false, label: entry.name, pointBackgroundColor: color, pointBorderColor: colors.surface, pointBorderWidth: 2, pointHoverRadius: 6, pointRadius: 4, tension: 0 };
    }
    return { backgroundColor: color, borderColor: colors.surface, borderRadius: 4, borderSkipped: 'start', borderWidth: stacked ? { top: 2 } : 0, data: entry.data, label: entry.name, maxBarThickness: 44 };
  });
  const showLegend = round || spec.series.length > 1;
  // Only the value axis carries gridlines; lines across categories add nothing.
  const axis = (title, { values = false } = {}) => ({
    border: { display: false },
    grid: { color: colors.grid, display: values || lineLike, drawTicks: false },
    stacked,
    ticks: { color: colors.text, padding: 6 },
    title: { color: colors.text, display: Boolean(title), text: title },
  });
  return {
    data: { datasets, labels: spec.labels },
    options: {
      animation: false,
      indexAxis: horizontal ? 'y' : 'x',
      interaction: lineLike ? { intersect: false, mode: 'index' } : { intersect: true, mode: 'nearest' },
      maintainAspectRatio: false,
      plugins: {
        legend: { display: showLegend, labels: { boxHeight: 10, boxWidth: 10, color: colors.text, usePointStyle: true }, position: 'top' },
        title: { color: colors.title, display: Boolean(spec.title), font: { size: 14, weight: '600' }, padding: { bottom: 10 }, text: spec.title },
        tooltip: { callbacks: { label: (item) => `${item.dataset.label}: ${formatValue(item.raw, spec.unit)}` } },
      },
      responsive: true,
      scales: round ? {} : {
        x: { ...axis(horizontal ? spec.yLabel : spec.xLabel, { values: horizontal }), ...(horizontal ? { beginAtZero: true } : {}) },
        y: { ...axis(horizontal ? spec.xLabel : spec.yLabel, { values: !horizontal }), ...(horizontal ? {} : { beginAtZero: true }) },
      },
    },
    type: chartType,
  };
}

// The same numbers as a table, for the "Show data" view and screen readers.
export function chartTable(spec) {
  return {
    headers: [spec.xLabel || '', ...spec.series.map((entry) => entry.name)],
    rows: spec.labels.map((label, index) => [label, ...spec.series.map((entry) => formatValue(entry.data[index], spec.unit))]),
  };
}

// Zoom levels for the enlarged view, as multiples of "fit".
export const ZOOM_STEPS = Object.freeze([0.5, 0.75, 1, 1.5, 2, 3, 4]);

// The next level up (direction 1) or down (-1) from the current zoom, clamped to the ends.
export function nextZoomStep(current, direction) {
  if (direction > 0) return ZOOM_STEPS.find((step) => step > current + 1e-9) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  return [...ZOOM_STEPS].reverse().find((step) => step < current - 1e-9) ?? ZOOM_STEPS[0];
}

// A drawn diagram's own size, from its viewBox (Mermaid and Graphviz both set one), then its
// width and height attributes.
export function svgNaturalSize(svg) {
  if (!svg) return null;
  const box = String(svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  if (box.length === 4 && box[2] > 0 && box[3] > 0) return { height: box[3], width: box[2] };
  const width = parseFloat(svg.getAttribute('width'));
  const height = parseFloat(svg.getAttribute('height'));
  return width > 0 && height > 0 ? { height, width } : null;
}

const UNSAFE_SVG_TAGS =['script', 'foreignObject', 'iframe', 'image', 'use', 'style'];

// Graphviz output, cleaned before it enters the page: no scripts, embedded content, event
// handlers or links.
export function sanitizeGraphvizSvg(svg) {
  for (const tag of UNSAFE_SVG_TAGS) for (const node of [...svg.getElementsByTagName(tag)]) node.remove();
  for (const node of [svg, ...svg.querySelectorAll('*')]) {
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || name === 'href' || name === 'xlink:href' || name.endsWith(':href')) node.removeAttribute(attribute.name);
    }
  }
  for (const anchor of [...svg.getElementsByTagName('a')]) anchor.replaceWith(...anchor.childNodes);
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  // The figure around it carries the accessible name.
  svg.setAttribute('aria-hidden', 'true');
  return svg;
}
