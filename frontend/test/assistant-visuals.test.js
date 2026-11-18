import assert from 'node:assert/strict';
import test from 'node:test';

import { CHART_PALETTE, chartConfigFor, chartTable, nextZoomStep, parseChartSpec, splitAssistantContent, svgNaturalSize, ZOOM_STEPS } from '../src/lib/assistant/assistant-visuals.js';

const chartJson = JSON.stringify({ labels: ['Matt', 'Kelly'], series: [{ data: [12, 4], name: 'Open' }], title: 'Open items by owner', type: 'bar', unit: 'items', yLabel: 'Items' });

test('a reply splits into text and visual blocks, and a block still being written is pending', () => {
  const reply = `Here is the load.\n\n\`\`\`chart\n${chartJson}\n\`\`\`\n\nAnd the flow:\n\n\`\`\`mermaid\nflowchart LR\n  A --> B\n\`\`\`\n\n\`\`\`dot\ndigraph { a -> b }\n\`\`\`\nDone.`;
  assert.deepEqual(splitAssistantContent(reply).map((segment) => [segment.kind, segment.type ?? segment.text.trim()]), [
    ['text', 'Here is the load.'],
    ['visual', 'chart'],
    ['text', 'And the flow:'],
    ['visual', 'mermaid'],
    ['visual', 'graphviz'],
    ['text', 'Done.'],
  ]);
  const streaming = splitAssistantContent('Working on it.\n\n```chart\n{"type": "bar", "labels": ["Ma');
  assert.deepEqual(streaming.map((segment) => [segment.kind, segment.pending ?? false]), [['text', false], ['visual', true]]);
  assert.deepEqual(splitAssistantContent('```js\nconst a = 1;\n```').map((segment) => segment.kind), ['text'], 'ordinary code stays code');
  assert.deepEqual(splitAssistantContent('```dotnet\nbuild\n```').map((segment) => segment.kind), ['text'], 'a language that starts with dot is not Graphviz');
});

test('a chart whose JSON starts on the fence line still draws', () => {
  for (const reply of [`\`\`\`chart: ${chartJson}\n\`\`\``, `\`\`\`chart ${chartJson}\n\`\`\``, `\`\`\`chart: ${chartJson}\`\`\``, `\`\`\`Chart\n${chartJson}\n\`\`\``]) {
    const [segment] = splitAssistantContent(reply);
    assert.equal(segment.type, 'chart', reply);
    assert.equal(parseChartSpec(segment.source).spec?.title, 'Open items by owner', reply);
  }
  const [mermaid] = splitAssistantContent('```mermaid: flowchart LR\n  A --> B\n```');
  assert.equal(mermaid.source, 'flowchart LR\n  A --> B');
  const [titled] = splitAssistantContent('```mermaid title="Release"\nflowchart LR\n  A --> B\n```');
  assert.equal(titled.source, 'flowchart LR\n  A --> B', 'other info after the language is ignored');
  assert.deepEqual(splitAssistantContent(`Here:\n\n\`\`\`chart: {"type": "bar", "lab`).map((segment) => [segment.kind, segment.pending ?? false]), [['text', false], ['visual', true]]);
});

test('chart specs are checked and trimmed to what the chart can show', () => {
  const { spec } = parseChartSpec(chartJson);
  assert.deepEqual([spec.type, spec.labels, spec.series[0].data, spec.unit], ['bar', ['Matt', 'Kelly'], [12, 4], 'items']);
  assert.match(parseChartSpec('{not json').error, /not valid JSON/);
  assert.match(parseChartSpec('{"type": "radar", "labels": ["a"], "series": [{"data": [1]}]}').error, /Unknown chart type/);
  assert.match(parseChartSpec('{"type": "bar", "labels": [], "series": []}').error, /no labels or data/);
  const pie = parseChartSpec(JSON.stringify({ labels: ['a', 'b'], series: [{ data: [1, 2], name: 'One' }, { data: [3, 4], name: 'Two' }], type: 'pie' })).spec;
  assert.equal(pie.series.length, 1, 'a pie takes one series');
  const many = parseChartSpec(JSON.stringify({ labels: ['a'], series: Array.from({ length: 12 }, (_, index) => ({ data: [index + 1], name: `S${index}` })), type: 'line' })).spec;
  assert.equal(many.series.length, 8, 'at most eight series');
});

test('chart configs follow the palette and mark specs, with a legend only for two or more series', () => {
  const single = chartConfigFor(parseChartSpec(chartJson).spec);
  assert.equal(single.type, 'bar');
  assert.equal(single.options.plugins.legend.display, false);
  assert.equal(single.data.datasets[0].backgroundColor, CHART_PALETTE.light[0]);
  assert.equal(single.data.datasets[0].borderRadius, 4);
  assert.equal(single.options.scales.y.beginAtZero, true);

  const twoLines = parseChartSpec(JSON.stringify({ labels: ['W1', 'W2'], series: [{ data: [3, 5], name: 'Done' }, { data: [8, 6], name: 'Open' }], type: 'line' })).spec;
  const dark = chartConfigFor(twoLines, { dark: true });
  assert.equal(dark.options.plugins.legend.display, true);
  assert.deepEqual(dark.data.datasets.map((dataset) => dataset.borderColor), CHART_PALETTE.dark.slice(0, 2));
  assert.equal(dark.data.datasets[0].borderWidth, 2);
  assert.equal(dark.options.interaction.mode, 'index');

  const horizontal = chartConfigFor({ ...parseChartSpec(chartJson).spec, type: 'horizontal-bar' });
  assert.equal(horizontal.options.indexAxis, 'y');
  assert.deepEqual(chartTable(parseChartSpec(chartJson).spec), { headers: ['', 'Open'], rows: [['Matt', '12 items'], ['Kelly', '4 items']] });
});

test('the enlarged view zooms in fixed steps from fit and knows a diagram\'s own size', () => {
  assert.equal(nextZoomStep(1, 1), 1.5);
  assert.equal(nextZoomStep(1, -1), 0.75);
  assert.equal(nextZoomStep(ZOOM_STEPS.at(-1), 1), ZOOM_STEPS.at(-1), 'stops at the largest step');
  assert.equal(nextZoomStep(ZOOM_STEPS[0], -1), ZOOM_STEPS[0], 'stops at the smallest step');
  assert.equal(nextZoomStep(1.2, 1), 1.5, 'an in-between level moves to the next step');
  const svg = (attributes) => ({ getAttribute: (name) => attributes[name] ?? null });
  assert.deepEqual(svgNaturalSize(svg({ viewBox: '0 0 640.5 220', width: '100%' })), { height: 220, width: 640.5 });
  assert.deepEqual(svgNaturalSize(svg({ height: '120pt', width: '300pt' })), { height: 120, width: 300 });
  assert.equal(svgNaturalSize(svg({ width: '100%' })), null);
  assert.equal(svgNaturalSize(null), null);
});
