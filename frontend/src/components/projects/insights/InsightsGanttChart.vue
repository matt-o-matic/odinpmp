<script setup>
import { computed, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';

import { useElementWidth } from '../../../lib/insights/use-chart-frame.js';
import {
  GANTT_ROW_HEIGHT,
  GANTT_SUMMARY_ROW_HEIGHT,
  GANTT_ZOOMS,
  chainOf,
  dayLabel,
  driverLabel,
  durationSourceLabel,
  ganttTicks,
  groupRowsByPerson,
  linkPath,
  linkPhrase,
  plural,
  resourceColor,
  resourceIndex,
  spanLabel,
  typeLabel,
  visibleAnchor,
  visibleGanttRows,
} from '../../../lib/insights/gantt.js';

// The project timeline: stories on working-day offsets, coloured by person, grouped by epic or
// by person. Hover or select a bar to trace what holds it back and what it holds back.

const props = defineProps({
  data: { required: true, type: Object },
  projectId: { required: true, type: String },
});

const BAR_HEIGHT = 18;
const RIGHT_ROOM = 132;

const groupBy = ref('epic');
const collapsed = ref(new Set());
const showDone = ref(true);
const showLinks = ref(true);
const zoomIndex = ref(0);
const focus = ref(null);
const hoverId = ref('');
const pinnedId = ref('');
const tooltip = ref(null);
const frame = ref(null);
const scroller = ref(null);
const width = useElementWidth(scroller, 960);

watch(groupBy, () => {
  collapsed.value = new Set();
  pinnedId.value = '';
});

const resources = computed(() => resourceIndex(props.data.resources));
const names = computed(() => new Map(props.data.rows.map((row) => [row.id, row.name])));
const sprints = computed(() => new Map(props.data.sprints.map((sprint) => [sprint.id, sprint])));
const rowsById = computed(() => new Map(props.data.rows.map((row) => [row.id, row])));
const hasUnassigned = computed(() => props.data.rows.some((row) => row.leaf && !row.assigneeId));
const finish = computed(() => Math.max(...props.data.rows.map((row) => row.finish)));

const baseRows = computed(() => (groupBy.value === 'person' ? groupRowsByPerson(props.data.rows, props.data.resources) : props.data.rows));
const rows = computed(() => visibleGanttRows(baseRows.value, { collapsed: collapsed.value, hideDone: !showDone.value }));
const hasGroups = computed(() => baseRows.value.some((row) => !row.leaf));

const labelWidth = computed(() => (width.value < 640 ? 168 : 272));
const fitPx = computed(() => Math.max(3, (width.value - labelWidth.value - RIGHT_ROOM) / props.data.total));
const pxPerDay = computed(() => (zoomIndex.value === 0 ? fitPx.value : Math.max(fitPx.value, GANTT_ZOOMS[zoomIndex.value])));
const timelineWidth = computed(() => Math.ceil(props.data.total * pxPerDay.value + RIGHT_ROOM));
const x = (offset) => offset * pxPerDay.value;
const ticks = computed(() => ganttTicks(props.data.total, pxPerDay.value));

const layout = computed(() => {
  const tops = new Map();
  let top = 0;
  for (const row of rows.value) {
    tops.set(row.id, top);
    top += row.leaf ? GANTT_ROW_HEIGHT : GANTT_SUMMARY_ROW_HEIGHT;
  }
  return { height: top, tops };
});
const rowHeight = (row) => (row.leaf ? GANTT_ROW_HEIGHT : GANTT_SUMMARY_ROW_HEIGHT);
const centerY = (row) => layout.value.tops.get(row.id) + rowHeight(row) / 2;

// Highlight: a traced chain (hover or selection) wins over a legend or flag focus.
const tracedId = computed(() => pinnedId.value || hoverId.value);
const traced = computed(() => (tracedId.value && rowsById.value.has(tracedId.value) ? chainOf(tracedId.value, props.data.links, props.data.rows) : null));
const FLAG_TESTS = Object.freeze({
  blocked: (row) => row.activelyBlocked,
  critical: (row) => row.critical,
  late: (row) => row.late,
  leveled: (row) => row.driver?.kind === 'resource',
  slipping: (row) => row.slipsSprint && !row.done,
});
function matchesFocus(row) {
  const current = focus.value;
  if (!current) return true;
  if (current.kind === 'resource') return current.id ? row.assigneeId === current.id : !row.assigneeId;
  return FLAG_TESTS[current.flag]?.(row) ?? true;
}
function dimmed(row) {
  if (!row.leaf) return false;
  if (traced.value) return !traced.value.has(row.id);
  return !matchesFocus(row);
}

const links = computed(() => {
  if (!showLinks.value) return [];
  const visibleIds = new Set(rows.value.map((row) => row.id));
  const anchor = visibleAnchor(baseRows.value, visibleIds);
  const byId = new Map(rows.value.map((row) => [row.id, row]));
  const blockedUnder = (id) => props.data.rows.some((row) => row.leaf && row.activelyBlocked && (row.id === id || row.parentId === id));
  const seen = new Set();
  const drawn = [];
  for (const link of props.data.links) {
    const from = byId.get(anchor(link.from));
    const to = byId.get(anchor(link.to));
    if (!from || !to || from === to) continue;
    const key = `${from.id}>${to.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const fromX = x(['SS', 'SF'].includes(link.type) ? from.start : from.finish);
    const toX = x(['FF', 'SF'].includes(link.type) ? to.finish : to.start);
    const state = link.done ? 'done' : blockedUnder(link.to) ? 'blocking' : 'open';
    const lit = traced.value ? traced.value.has(link.from) && traced.value.has(link.to) : null;
    drawn.push({ d: linkPath({ fromX, fromY: centerY(from), toX, toY: centerY(to) }), key, lit, state });
  }
  // Lit and blocking links draw last, on top.
  const weight = (link) => (link.lit ? 2 : 0) + (link.state === 'blocking' ? 1 : 0);
  return drawn.sort((left, right) => weight(left) - weight(right));
});

const chips = computed(() => {
  const counts = props.data.counts;
  return [
    { count: counts.blocked, flag: 'blocked', icon: 'bi-sign-stop-fill', label: `${counts.blocked} blocked now`, tone: 'critical' },
    { count: counts.late, flag: 'late', icon: 'bi-clock-history', label: `${counts.late} late`, tone: 'warn' },
    { count: counts.slipping, flag: 'slipping', icon: 'bi-box-arrow-right', label: `${plural(counts.slipping, 'story runs', 'stories run')} past ${counts.slipping === 1 ? 'its' : 'their'} sprint`, tone: 'warn' },
    { count: counts.leveled, flag: 'leveled', icon: 'bi-hourglass-split', label: `${counts.leveled} waiting on ${counts.leveled === 1 ? 'its person' : 'their people'}`, tone: '' },
    { count: counts.critical, flag: 'critical', icon: 'bi-lightning-charge-fill', label: `Critical path · ${counts.critical}`, tone: '' },
  ].filter((chip) => chip.count > 0);
});

const headline = computed(() => {
  const parts = [`${plural(props.data.counts.placed, 'story', 'stories')}`, plural(props.data.resources.length, 'person', 'people')];
  if (props.data.sprints.length) parts.push(plural(props.data.sprints.length, 'sprint'));
  return parts.join(' · ');
});

const ariaSummary = computed(() => {
  const parts = [`Project timeline: ${headline.value}, finishing on working ${dayLabel(finish.value - 1).toLowerCase()}`];
  if (props.data.now != null) parts.push(`today is ${dayLabel(props.data.now).toLowerCase()}`);
  for (const chip of chips.value) parts.push(chip.label);
  return `${parts.join('; ')}. Use the table view for every story.`;
});

function toggleFocus(next) {
  pinnedId.value = '';
  const current = focus.value;
  const same = current && current.kind === next.kind && current.id === next.id && current.flag === next.flag;
  focus.value = same ? null : next;
}
const focusActive = (next) => focus.value && focus.value.kind === next.kind && focus.value.id === next.id && focus.value.flag === next.flag;

function toggleCollapsed(id) {
  const next = new Set(collapsed.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsed.value = next;
}
function setAllCollapsed(value) {
  collapsed.value = value ? new Set(baseRows.value.filter((row) => !row.leaf).map((row) => row.id)) : new Set();
}

function zoom(step) {
  zoomIndex.value = Math.max(0, Math.min(GANTT_ZOOMS.length - 1, zoomIndex.value + step));
}

function rowColor(row) {
  if (row.type === 'person') return resourceColor(row.assigneeId ? resources.value.get(row.assigneeId) : null);
  return row.leaf ? resourceColor(resources.value.get(row.assigneeId)) : 'var(--gantt-summary)';
}

function itemLocation(row) {
  return { name: 'project-detail', params: { projectId: props.projectId }, query: { item: row.id } };
}

function personName(id) {
  return id ? resources.value.get(id)?.name ?? 'Former member' : 'Unassigned';
}

function barLabel(row) {
  if (!row.leaf) {
    const parts = [`${row.doneCount}/${row.leafCount} done`];
    if (row.blockedCount) parts.push(`${row.blockedCount} blocked`);
    return parts.join(' · ');
  }
  if (!row.assigneeId) return row.trackId ? `Unassigned · ${resources.value.get(row.trackId)?.short ?? ''}'s next gap` : 'Unassigned';
  return resources.value.get(row.assigneeId)?.short ?? '';
}

function details(row) {
  if (!row.leaf) {
    return {
      lines: [
        ['When', spanLabel(row)],
        ['Done', `${row.doneCount} of ${plural(row.leafCount, 'story', 'stories')}`],
        ...(row.blockedCount ? [['Blocked now', plural(row.blockedCount, 'story', 'stories')]] : []),
        ...(row.lateCount ? [['Late', plural(row.lateCount, 'story', 'stories')]] : []),
      ],
      subtitle: typeLabel(row.type),
      title: row.name,
    };
  }
  const sprint = row.sprintId ? sprints.value.get(row.sprintId) : null;
  const lines = [
    ['Person', row.assigneeId ? personName(row.assigneeId) : `Unassigned${row.trackId ? `, fitted into ${resources.value.get(row.trackId)?.short ?? 'a teammate'}'s next gap` : ''}`],
    ['When', `${spanLabel(row)}${durationSourceLabel(row.durationSource) ? ` (${durationSourceLabel(row.durationSource)})` : ''}`],
  ];
  if (sprint) lines.push(['Sprint', `${sprint.name}${row.slipsSprint ? `, runs ${plural(row.finish - sprint.end, 'day')} past it` : ''}`]);
  lines.push(['Starts then', driverLabel(row, { names: names.value, resources: resources.value, sprints: sprints.value })]);
  if (row.start > row.earliest) lines.push(['Could start', `${dayLabel(row.earliest)} if ${row.assigneeId ? resources.value.get(row.assigneeId)?.short ?? 'its person' : 'someone'} were free`]);
  lines.push(['Status', `${row.done ? 'Done' : row.status}${!row.done && row.progress ? ` · ${Math.round(row.progress)}%` : ''}`]);
  const flags = [];
  if (row.activelyBlocked) flags.push('Blocked now');
  if (row.late) flags.push('Late');
  if (row.critical) flags.push('On the critical path');
  if (row.cyclic) flags.push('In a blocking loop');
  return {
    blockers: row.blockedBy ?? [],
    flags,
    lines,
    subtitle: [typeLabel(row.type), row.parentId ? names.value.get(row.parentId) : null].filter(Boolean).join(' · '),
    title: row.name,
  };
}

const tip = computed(() => (tooltip.value ? details(tooltip.value.row) : null));

function ariaFor(row) {
  const info = details(row);
  return [info.title, ...info.lines.map(([label, value]) => `${label}: ${value}`), ...(info.flags ?? [])].join('. ');
}

function showTooltip(row, event) {
  const bounds = frame.value?.getBoundingClientRect();
  if (!bounds) return;
  const source = event?.clientX != null && event.type.startsWith('pointer') ? { x: event.clientX, y: event.clientY } : (() => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: rect.left + Math.min(rect.width, 40), y: rect.bottom };
  })();
  const left = Math.min(Math.max(8, source.x - bounds.left + 14), Math.max(8, bounds.width - 312));
  tooltip.value = { below: source.y - bounds.top < bounds.height * 0.55, left, row, top: source.y - bounds.top };
}

function enter(row, event) {
  hoverId.value = row.id;
  showTooltip(row, event);
}
function leave(row) {
  if (hoverId.value === row.id) hoverId.value = '';
  if (!pinnedId.value) tooltip.value = null;
  else if (tooltip.value?.row.id !== pinnedId.value) tooltip.value = null;
}
function select(row, event) {
  pinnedId.value = pinnedId.value === row.id ? '' : row.id;
  if (pinnedId.value) showTooltip(row, event);
}
function clearSelection() {
  pinnedId.value = '';
  hoverId.value = '';
  tooltip.value = null;
}
</script>

<template>
  <div ref="frame" class="gantt" role="group" :aria-label="ariaSummary" @keydown.esc="clearSelection">
    <div class="gantt__summary">
      <p class="gantt__headline">
        <span>Finishes <strong>{{ dayLabel(finish - 1) }}</strong></span>
        <span class="gantt__headline-meta">{{ headline }}<template v-if="data.now != null"> · today is {{ dayLabel(data.now) }}</template></span>
      </p>
      <ul v-if="chips.length" class="gantt__chips" aria-label="Highlight">
        <li v-for="chip in chips" :key="chip.flag">
          <button
            class="gantt-chip"
            :class="chip.tone ? `gantt-chip--${chip.tone}` : ''"
            type="button"
            :aria-pressed="focusActive({ flag: chip.flag, kind: 'flag' }) ? 'true' : 'false'"
            @click="toggleFocus({ flag: chip.flag, kind: 'flag' })"
          >
            <i class="bi" :class="chip.icon" aria-hidden="true"></i>{{ chip.label }}
          </button>
        </li>
      </ul>
    </div>

    <div class="gantt__toolbar">
      <div class="gantt__segmented" role="radiogroup" aria-label="Group rows by">
        <button v-for="option in [{ key: 'epic', label: 'By epic' }, { key: 'person', label: 'By person' }]" :key="option.key" class="btn btn-sm" :class="groupBy === option.key ? 'btn-primary' : 'btn-outline-secondary'" type="button" role="radio" :aria-checked="groupBy === option.key ? 'true' : 'false'" @click="groupBy = option.key">{{ option.label }}</button>
      </div>
      <button class="btn btn-sm btn-outline-secondary" type="button" :aria-pressed="showLinks ? 'true' : 'false'" @click="showLinks = !showLinks">
        <i class="bi bi-diagram-2" aria-hidden="true"></i> Blocking links
      </button>
      <button class="btn btn-sm btn-outline-secondary" type="button" :aria-pressed="showDone ? 'true' : 'false'" @click="showDone = !showDone">
        <i class="bi bi-check2-all" aria-hidden="true"></i> Done work
      </button>
      <template v-if="hasGroups">
        <button class="insights-icon-button" type="button" aria-label="Expand every group" title="Expand all" @click="setAllCollapsed(false)"><i class="bi bi-arrows-expand" aria-hidden="true"></i></button>
        <button class="insights-icon-button" type="button" aria-label="Collapse every group" title="Collapse all" @click="setAllCollapsed(true)"><i class="bi bi-arrows-collapse" aria-hidden="true"></i></button>
      </template>
      <div class="gantt__zoom" role="group" aria-label="Zoom">
        <button class="insights-icon-button" type="button" aria-label="Zoom out" :disabled="zoomIndex === 0" @click="zoom(-1)"><i class="bi bi-zoom-out" aria-hidden="true"></i></button>
        <button class="btn btn-sm btn-link gantt__fit" type="button" :disabled="zoomIndex === 0" @click="zoomIndex = 0">Fit</button>
        <button class="insights-icon-button" type="button" aria-label="Zoom in" :disabled="zoomIndex === GANTT_ZOOMS.length - 1" @click="zoom(1)"><i class="bi bi-zoom-in" aria-hidden="true"></i></button>
      </div>
    </div>

    <ul class="gantt__legend" aria-label="People">
      <li v-for="resource in data.resources" :key="resource.id">
        <button
          class="gantt-person"
          type="button"
          :style="{ '--c': resourceColor(resources.get(resource.id)) }"
          :aria-pressed="focusActive({ id: resource.id, kind: 'resource' }) ? 'true' : 'false'"
          :title="`${resource.name}: ${plural(resource.open, 'open story', 'open stories')}, free from ${dayLabel(resource.finish)}`"
          @click="toggleFocus({ id: resource.id, kind: 'resource' })"
        >
          <span class="gantt-person__swatch" aria-hidden="true"></span>
          <span>{{ resource.name }}</span>
          <small>free {{ dayLabel(resource.finish) }}</small>
        </button>
      </li>
      <li v-if="hasUnassigned">
        <button class="gantt-person" type="button" style="--c: var(--gantt-unassigned)" :aria-pressed="focusActive({ id: null, kind: 'resource' }) ? 'true' : 'false'" @click="toggleFocus({ id: null, kind: 'resource' })">
          <span class="gantt-person__swatch" aria-hidden="true"></span><span>Unassigned</span>
        </button>
      </li>
    </ul>

    <div ref="scroller" class="gantt__scroller" @click.self="clearSelection">
      <div class="gantt__canvas" :style="{ width: `${labelWidth + timelineWidth}px`, '--label-w': `${labelWidth}px` }">
        <div class="gantt__header" aria-hidden="true">
          <div class="gantt__corner">
            <span>{{ groupBy === 'person' ? 'Person / story' : 'Epic / story' }}</span>
            <small>Working days</small>
          </div>
          <div class="gantt__scale" :style="{ width: `${timelineWidth}px` }">
            <div class="gantt__sprints">
              <span
                v-for="sprint in data.sprints"
                :key="sprint.id"
                class="gantt__sprint"
                :class="{ 'gantt__sprint--active': sprint.id === data.activeSprintId }"
                :style="{ left: `${x(sprint.start)}px`, width: `${x(sprint.end - sprint.start)}px` }"
                :title="`${sprint.name}: ${dayLabel(sprint.start)}–${dayLabel(sprint.end - 1)}`"
              >{{ sprint.name }}</span>
            </div>
            <div class="gantt__ticks">
              <span v-for="tick in ticks" :key="tick" :style="{ left: `${x(tick)}px` }">{{ tick + 1 }}</span>
              <span v-if="data.now != null" class="gantt__today-pill" :style="{ left: `${x(data.now)}px` }">Today</span>
            </div>
          </div>
        </div>

        <div class="gantt__body" :style="{ height: `${layout.height}px` }">
          <div class="gantt__backdrop" aria-hidden="true" :style="{ left: `${labelWidth}px`, width: `${timelineWidth}px` }">
            <span
              v-for="(sprint, index) in data.sprints"
              :key="sprint.id"
              class="gantt__band"
              :class="{ 'gantt__band--alt': index % 2 === 1, 'gantt__band--active': sprint.id === data.activeSprintId }"
              :style="{ left: `${x(sprint.start)}px`, width: `${x(sprint.end - sprint.start)}px` }"
            ></span>
            <span v-for="tick in ticks" :key="tick" class="gantt__gridline" :style="{ left: `${x(tick)}px` }"></span>
            <span v-if="data.now != null" class="gantt__today" :style="{ left: `${x(data.now)}px` }"></span>
            <svg v-if="links.length" class="gantt__links" :width="timelineWidth" :height="layout.height">
              <defs>
                <marker v-for="state in ['open', 'done', 'blocking', 'lit']" :id="`gantt-arrow-${state}`" :key="state" class="gantt__arrow" :class="`gantt__arrow--${state}`" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                  <path d="M0,0 L8,4 L0,8 z" />
                </marker>
              </defs>
              <path
                v-for="link in links"
                :key="link.key"
                class="gantt__link"
                :class="[`gantt__link--${link.state}`, { 'gantt__link--lit': link.lit, 'gantt__link--faded': link.lit === false }]"
                :d="link.d"
                :marker-end="`url(#gantt-arrow-${link.lit ? 'lit' : link.state})`"
              />
            </svg>
          </div>

          <div
            v-for="row in rows"
            :key="row.id"
            class="gantt-row"
            :class="[row.leaf ? 'gantt-row--leaf' : 'gantt-row--summary', { 'gantt-row--traced': tracedId === row.id }]"
            :style="{ height: `${rowHeight(row)}px` }"
          >
            <div class="gantt-row__label" :style="{ paddingLeft: `${0.5 + row.level * 1.1}rem` }">
              <button
                v-if="!row.leaf"
                class="gantt-row__toggle"
                type="button"
                :aria-expanded="collapsed.has(row.id) ? 'false' : 'true'"
                :aria-label="`${collapsed.has(row.id) ? 'Expand' : 'Collapse'} ${row.name}`"
                @click="toggleCollapsed(row.id)"
              >
                <i class="bi" :class="collapsed.has(row.id) ? 'bi-chevron-right' : 'bi-chevron-down'" aria-hidden="true"></i>
              </button>
              <span v-else class="gantt-row__dot" :style="{ '--c': rowColor(row) }" aria-hidden="true"></span>
              <span v-if="row.type === 'person'" class="gantt-row__name">{{ row.name }}</span>
              <RouterLink v-else class="gantt-row__name" :class="{ 'gantt-row__name--done': row.done }" :to="itemLocation(row)" :title="row.name">{{ row.name }}</RouterLink>
              <span v-if="!row.leaf" class="gantt-row__meta">{{ row.doneCount }}/{{ row.leafCount }}</span>
            </div>
            <div class="gantt-row__track" :style="{ width: `${timelineWidth}px` }">
              <template v-if="row.leaf">
                <span
                  v-if="row.sprintId && sprints.get(row.sprintId)"
                  class="gantt-window"
                  :class="{ 'gantt-window--dim': dimmed(row) }"
                  aria-hidden="true"
                  :style="{ left: `${x(sprints.get(row.sprintId).start)}px`, width: `${x(sprints.get(row.sprintId).end - sprints.get(row.sprintId).start)}px` }"
                ></span>
                <span
                  v-if="row.start > row.earliest"
                  class="gantt-wait"
                  :class="{ 'gantt-wait--dim': dimmed(row) }"
                  aria-hidden="true"
                  :style="{ left: `${x(row.earliest)}px`, width: `${x(row.start - row.earliest)}px`, '--c': rowColor(row) }"
                ></span>
              </template>
              <button
                class="gantt-bar"
                :class="[
                  row.leaf ? 'gantt-bar--leaf' : row.type === 'person' ? 'gantt-bar--person' : 'gantt-bar--summary',
                  {
                    'gantt-bar--blocked': row.activelyBlocked,
                    'gantt-bar--critical': row.critical && focusActive({ flag: 'critical', kind: 'flag' }),
                    'gantt-bar--dim': dimmed(row),
                    'gantt-bar--done': row.done,
                    'gantt-bar--estimate-missing': ['sprint', 'default'].includes(row.durationSource),
                    'gantt-bar--selected': pinnedId === row.id,
                    'gantt-bar--unassigned': row.leaf && !row.assigneeId,
                  },
                ]"
                type="button"
                :style="{ left: `${x(row.start)}px`, width: `${Math.max(4, x(row.finish - row.start))}px`, '--c': rowColor(row), '--p': `${row.progress ?? 0}%` }"
                :aria-label="ariaFor(row)"
                :aria-pressed="pinnedId === row.id ? 'true' : 'false'"
                @blur="leave(row)"
                @click.stop="select(row, $event)"
                @focus="enter(row, $event)"
                @pointerenter="enter(row, $event)"
                @pointerleave="leave(row)"
                @pointermove="tooltip && tooltip.row.id === row.id && !pinnedId && showTooltip(row, $event)"
              >
                <span class="gantt-bar__fill" aria-hidden="true"></span>
              </button>
              <span class="gantt-bar__label" :class="{ 'gantt-bar__label--dim': dimmed(row) }" aria-hidden="true" :style="{ left: `${x(row.finish) + 6}px` }">
                <i v-if="row.activelyBlocked" class="bi bi-sign-stop-fill gantt-flag gantt-flag--critical"></i>
                <i v-if="row.late" class="bi bi-clock-history gantt-flag gantt-flag--warn"></i>
                <i v-if="row.leaf && row.slipsSprint && !row.done" class="bi bi-box-arrow-right gantt-flag gantt-flag--warn"></i>
                <i v-if="row.done && row.leaf" class="bi bi-check-lg gantt-flag"></i>
                {{ barLabel(row) }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <ul class="gantt__key" aria-hidden="true">
      <li><span class="gantt-key gantt-key--planned"></span>Planned</li>
      <li><span class="gantt-key gantt-key--progress"></span>Done so far</li>
      <li><span class="gantt-key gantt-key--blocked"></span>Blocked now</li>
      <li><span class="gantt-key gantt-key--wait"></span>Waiting for its person</li>
      <li><span class="gantt-key gantt-key--window"></span>Its sprint</li>
      <li><span class="gantt-key gantt-key--estimate"></span>No estimate</li>
    </ul>

    <div
      v-if="tooltip"
      class="gantt-tip"
      :class="{ 'gantt-tip--above': !tooltip.below }"
      role="status"
      :style="{ left: `${tooltip.left}px`, top: `${tooltip.top}px` }"
    >
      <p class="gantt-tip__subtitle">{{ tip.subtitle }}</p>
      <p class="gantt-tip__title">{{ tip.title }}</p>
      <dl class="gantt-tip__lines">
        <template v-for="[label, value] in tip.lines" :key="label">
          <dt>{{ label }}</dt>
          <dd>{{ value }}</dd>
        </template>
      </dl>
      <ul v-if="tip.blockers?.length" class="gantt-tip__blockers">
        <li v-for="blocker in tip.blockers" :key="blocker.id + (blocker.viaId ?? '')">
          <i class="bi" :class="blocker.done ? 'bi-check-circle-fill gantt-flag--good' : 'bi-sign-stop-fill gantt-flag--critical'" aria-hidden="true"></i>
          <span>{{ blocker.name }}</span>
          <small>{{ linkPhrase(blocker) }}{{ blocker.viaId ? ` · via ${names.get(blocker.viaId)}` : '' }}{{ blocker.done ? ' · done' : '' }}</small>
        </li>
      </ul>
      <p v-if="tip.flags?.length" class="gantt-tip__flags">{{ tip.flags.join(' · ') }}</p>
      <p class="gantt-tip__hint">{{ pinnedId === tooltip.row.id ? 'Showing its chain. Esc or select again to clear.' : 'Select to keep its chain highlighted.' }}</p>
    </div>
  </div>
</template>
