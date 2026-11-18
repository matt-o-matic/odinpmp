// Scales, ticks and SVG paths for the Insights charts. Charts are drawn at their rendered
// width (the viewBox matches the element), so text keeps its size at every breakpoint.

const DAY_MS = 86_400_000;

export function dayMs(value) {
  return Date.parse(`${String(value).slice(0, 10)}T00:00:00.000Z`);
}

/** A rounded axis maximum and its tick values, about `count` steps from zero. */
export function niceTicks(maxValue, count = 4) {
  const max = Number(maxValue);
  if (!Number.isFinite(max) || max <= 0) return { max: 1, ticks: [0, 1] };
  const rough = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= rough) ?? 10 * magnitude;
  const niceMax = Math.ceil(max / step) * step;
  const ticks = [];
  for (let value = 0; value <= niceMax + step / 2; value += step) ticks.push(Math.round(value * 1000) / 1000);
  return { max: niceMax, ticks };
}

export function linearScale(domainMin, domainMax, rangeMin, rangeMax) {
  const span = domainMax - domainMin || 1;
  return (value) => rangeMin + ((value - domainMin) / span) * (rangeMax - rangeMin);
}

/** Evenly spaced day ticks across [start, end], at most `count`, always including both ends. */
export function dayTicks(start, end, count = 5) {
  const from = dayMs(start);
  const to = dayMs(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [String(start).slice(0, 10)];
  const days = Math.round((to - from) / DAY_MS);
  const step = Math.max(1, Math.ceil(days / Math.max(1, count - 1)));
  const ticks = [];
  for (let offset = 0; offset < days; offset += step) ticks.push(new Date(from + offset * DAY_MS).toISOString().slice(0, 10));
  const last = new Date(to).toISOString().slice(0, 10);
  if (days - (ticks.length - 1) * step < step / 2 && ticks.length > 1) ticks.pop();
  ticks.push(last);
  return ticks;
}

function format(value) {
  return Math.round(value * 10) / 10;
}

/** SVG path through points ({ x, y } in pixels); null y values break the line. */
export function linePath(points) {
  let path = '';
  let pen = false;
  for (const point of points) {
    if (point.y == null || !Number.isFinite(point.y)) {
      pen = false;
      continue;
    }
    path += `${pen ? 'L' : 'M'}${format(point.x)},${format(point.y)}`;
    pen = true;
  }
  return path;
}

/** Closed area between an upper line and a lower line (or a baseline y). */
export function areaPath(upper, lower) {
  const valid = upper.filter((point) => Number.isFinite(point.y));
  if (valid.length === 0) return '';
  const bottom = Array.isArray(lower) ? lower.filter((point) => Number.isFinite(point.y)) : valid.map((point) => ({ x: point.x, y: lower }));
  const top = valid.map((point, index) => `${index ? 'L' : 'M'}${format(point.x)},${format(point.y)}`).join('');
  const back = [...bottom].reverse().map((point) => `L${format(point.x)},${format(point.y)}`).join('');
  return `${top}${back}Z`;
}

/** A column rising from `baseline` to `top`, with 4px rounded data end and square base. */
export function columnPath(x, width, top, baseline, radius = 4) {
  const height = baseline - top;
  if (height <= 0) return '';
  const r = Math.min(radius, width / 2, height);
  return `M${format(x)},${format(baseline)}V${format(top + r)}Q${format(x)},${format(top)} ${format(x + r)},${format(top)}H${format(x + width - r)}Q${format(x + width)},${format(top)} ${format(x + width)},${format(top + r)}V${format(baseline)}Z`;
}

/** Index of the value in a sorted numeric list nearest to `target`. */
export function nearestIndex(values, target) {
  let best = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (Math.abs(values[index] - target) < Math.abs(values[best] - target)) best = index;
  }
  return best;
}
