<script setup>
import { computed } from 'vue';
import { RouterLink } from 'vue-router';

import {
  countIcon,
  initials,
  percentWidth,
  shortDate,
  sourceFailed,
  sparklinePaths,
  sprintEndLabel,
  unitShort,
} from '../../lib/home/home-format.js';

// The right rail: counts for the view, sprint progress against the ideal line, change trends
// and the top contributors. It stacks under the list on narrow screens.
const props = defineProps({
  lens: { required: true, type: String },
  payload: { required: true, type: Object },
});

const rail = computed(() => props.payload.rail ?? {});
const viewer = computed(() => props.payload.viewer ?? {});
const sources = computed(() => props.payload.sources ?? []);
const countsTitle = computed(() => (props.lens === 'workspace' ? 'Workspace at a glance' : 'At a glance'));
const countsScope = computed(() => {
  if (props.lens !== 'team') return '';
  const managed = viewer.value.managedProjectCount ?? 0;
  return `your ${managed} ${managed === 1 ? 'project' : 'projects'}`;
});
const sprintTitle = computed(() => ({ 'my-work': 'Your sprint', team: 'Active sprints', workspace: 'Sprints at risk' })[props.lens]);
const sprintRows = computed(() => rail.value.sprints ?? []);
const changes = computed(() => rail.value.changeTrends);
const spark = computed(() => sparklinePaths(changes.value?.series ?? []));
const leaderboard = computed(() => rail.value.leaderboard);

function sprintBarLabel(row) {
  const unit = unitShort(row.unit);
  const ideal = Math.round((row.idealPct / 100) * row.committedPoints);
  return `${row.donePoints} of ${row.committedPoints} ${unit} done; ${ideal} ${unit} would be done by today on the ideal line.`;
}
</script>

<template>
  <aside class="home-col" aria-label="Summary">
    <section class="home-panel" aria-labelledby="home-counts-title">
      <div class="home-panel__head">
        <h2 id="home-counts-title" class="home-h3">{{ countsTitle }}</h2>
        <span v-if="countsScope" class="home-small home-muted">{{ countsScope }}</span>
        <RouterLink v-if="lens === 'team'" class="home-link ms-auto" :to="{ name: 'reporting' }">Dashboards</RouterLink>
      </div>
      <div class="home-stats">
        <component
          :is="entry.href ? RouterLink : 'div'"
          v-for="entry in rail.counts"
          :key="entry.key"
          class="home-stat"
          :class="entry.severity ? `home-stat--${entry.severity}` : ''"
          :to="entry.href ?? undefined"
        >
          <span class="home-stat__label"><i class="bi" :class="countIcon(entry.key)" aria-hidden="true"></i>{{ entry.label }}</span>
          <span class="home-stat__value">{{ entry.value ?? '—' }}</span>
          <span class="home-stat__note">{{ entry.note }}</span>
        </component>
      </div>
    </section>

    <section class="home-panel" aria-labelledby="home-sprints-title">
      <div class="home-panel__head">
        <h2 id="home-sprints-title" class="home-h3">{{ sprintTitle }}</h2>
        <span v-if="lens === 'workspace'" class="home-small home-muted">across the workspace</span>
        <RouterLink v-if="lens === 'my-work' && sprintRows[0]" class="home-link ms-auto" :to="sprintRows[0].link">Board</RouterLink>
        <RouterLink v-else-if="lens === 'workspace'" class="home-link ms-auto" :to="{ name: 'portfolio' }">Portfolio</RouterLink>
        <span v-else-if="lens === 'team' && sprintRows.length" class="home-small home-muted ms-auto">| marks where work should be today</span>
      </div>
      <div v-for="row in sprintRows" :key="row.id" class="home-sprint" :class="{ 'home-sprint--behind': row.status === 'behind' }">
        <div class="home-sprint__top">
          <span class="home-sprint__name">{{ row.name }}</span>
          <span class="home-small home-muted">{{ row.projectName }}</span>
          <span class="ms-auto home-badge" :class="row.status === 'behind' ? 'home-badge--warn' : 'home-badge--ok'">
            <i class="bi" :class="row.status === 'behind' ? 'bi-exclamation-triangle-fill' : 'bi-check-circle-fill'" aria-hidden="true"></i>
            {{ row.status === 'behind' ? 'At risk' : 'On track' }}
          </span>
        </div>
        <div class="home-bar" role="img" :aria-label="sprintBarLabel(row)">
          <span :style="{ width: `${percentWidth(row.donePoints, row.committedPoints)}%` }"></span>
          <span class="home-ideal" :style="{ left: `${Math.min(100, row.idealPct)}%` }"></span>
        </div>
        <div class="home-sprint__meta">
          <span>{{ row.donePoints }} of {{ row.committedPoints }} {{ unitShort(row.unit) }} · {{ sprintEndLabel(row.endDate, payload.asOf) }}</span>
          <span v-if="row.myItems">Your items: {{ row.myItems.done }} of {{ row.myItems.total }} done</span>
        </div>
      </div>
      <p v-if="!sprintRows.length" class="home-panel__body home-muted">
        {{ lens === 'workspace' ? 'No sprint is at risk.' : 'Not enough activity yet. Sprint progress shows once a sprint with your work starts.' }}
      </p>
    </section>

    <section class="home-panel" aria-labelledby="home-changes-title">
      <div class="home-panel__head">
        <h2 id="home-changes-title" class="home-h3">Changes</h2>
        <span class="home-small home-muted">{{ lens === 'workspace' ? 'whole workspace' : 'your projects' }}</span>
        <span class="home-small home-muted ms-auto">30 days</span>
      </div>
      <div v-if="changes" class="home-panel__body">
        <p class="d-flex align-items-baseline gap-2">
          <span class="home-big">{{ changes.total }}</span>
          <span class="home-small home-muted">changes · {{ changes.yesterday }} yesterday</span>
        </p>
        <svg class="home-spark" viewBox="0 0 320 56" preserveAspectRatio="none" role="img" :aria-label="`Daily changes over the last 30 days, ${changes.total} in all.`">
          <path class="home-spark__area" :d="spark.area" />
          <path class="home-spark__line" :d="spark.line" />
          <circle v-if="spark.last" :cx="spark.last.x" :cy="spark.last.y" r="4" />
        </svg>
        <p v-if="changes.series.length" class="d-flex justify-content-between home-small home-muted">
          <span>{{ shortDate(changes.series[0].date) }}</span><span>{{ shortDate(changes.series.at(-1).date) }}</span>
        </p>
      </div>
      <p v-else class="home-panel__body home-muted">{{ sourceFailed(sources, 'changes') ? 'Change trends could not load.' : 'No changes recorded yet.' }}</p>
    </section>

    <section class="home-panel" aria-labelledby="home-leaders-title">
      <div class="home-panel__head">
        <h2 id="home-leaders-title" class="home-h3">Top contributors</h2>
        <span class="home-small home-muted ms-auto">{{ leaderboard?.days ?? 7 }} days</span>
      </div>
      <ol v-if="leaderboard?.top?.length" class="home-leaders">
        <li v-for="row in [...leaderboard.top, ...(leaderboard.me ? [leaderboard.me] : [])]" :key="row.id" class="home-leader" :class="{ 'home-leader--me': row.isCurrentUser }">
          <span class="home-count">{{ row.rank }}</span>
          <span class="home-avatar" aria-hidden="true">{{ initials(row.name) }}</span>
          <span class="home-leader__name">{{ row.name }}<template v-if="row.isCurrentUser"> (you)</template></span>
          <span class="home-small">{{ row.points }} pts · {{ row.tasks }} {{ row.tasks === 1 ? 'task' : 'tasks' }}</span>
        </li>
      </ol>
      <p v-else class="home-panel__body home-muted">{{ sourceFailed(sources, 'leaderboard') ? 'Top contributors could not load.' : 'No finished work in the last 7 days.' }}</p>
      <div class="home-panel__foot"><RouterLink class="home-link" :to="{ name: 'leaderboard' }">Full leaderboard</RouterLink></div>
    </section>
  </aside>
</template>
