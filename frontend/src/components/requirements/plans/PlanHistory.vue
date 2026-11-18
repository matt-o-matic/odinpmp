<script setup>
import { computed } from 'vue';
import { RouterLink, useRoute } from 'vue-router';

import './plans.css';
import { historyRows } from '../../../lib/requirements/requirements-plans.js';
import { chipToneClass } from '../../../lib/requirements/requirements-topics.js';

// Every version of the track's plan, newest first. Older versions stay readable.
const props = defineProps({
  plans: { default: () => [], type: Array },
  selectedId: { default: '', type: String },
});

const route = useRoute();
const rows = computed(() => historyRows(props.plans, { selectedId: props.selectedId }));
const latestId = computed(() => rows.value[0]?.id ?? '');

function location(id) {
  const query = { ...route.query };
  if (id === latestId.value) delete query.plan;
  else query.plan = id;
  return { name: route.name, params: { ...route.params }, query };
}
</script>

<template>
  <section v-if="rows.length > 1" class="rq-panel rq-stack" aria-labelledby="rq-plan-versions-heading">
    <h3 id="rq-plan-versions-heading" class="rq-eyebrow">Versions</h3>
    <ol class="rq-plan-versions">
      <li v-for="row in rows" :key="row.id" class="rq-plan-version" :class="{ 'rq-plan-version--on': row.selected }">
        <span class="rq-plan-version__num">v{{ row.version }}</span>
        <span class="rq-xs rq-muted">
          <span class="rq-chip me-1" :class="chipToneClass(row.chip.tone)">{{ row.chip.label }}</span>{{ row.meta }}
        </span>
        <span v-if="row.selected" class="rq-xs rq-muted">Shown</span>
        <RouterLink v-else class="rq-xs" :to="location(row.id)" :aria-label="`View version ${row.version}`">View</RouterLink>
      </li>
    </ol>
  </section>
</template>
