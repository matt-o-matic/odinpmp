<script setup>
import { computed } from 'vue';
import { RouterLink } from 'vue-router';

import { REQUIREMENTS_STAGES, describeStage, stageLocation, trackLabel } from '../../lib/requirements/requirements-tracks.js';

const props = defineProps({
  projectId: { required: true, type: String },
  stage: { required: true, type: String },
  stages: { default: null, type: Object },
  track: { required: true, type: String },
});

const items = computed(() => REQUIREMENTS_STAGES.map((stage) => {
  const described = props.stages ? describeStage(stage.id, props.stages) : { status: 'Loading…', tone: 'idle' };
  return { ...stage, ...described, active: stage.id === props.stage };
}));
</script>

<template>
  <nav class="rq-stagetabs" :aria-label="`${trackLabel(track)} stages`">
    <RouterLink
      v-for="item in items"
      :key="item.id"
      class="rq-stagetab"
      :class="{ 'rq-stagetab--on': item.active, 'rq-stagetab--done': item.tone === 'done' }"
      :aria-current="item.active ? 'page' : undefined"
      :to="stageLocation(projectId, track, item.id)"
    >
      <span class="rq-stagetab__top">
        <span class="rq-stagetab__num" aria-hidden="true">{{ item.number }}</span>
        <span class="rq-stagetab__name">{{ item.label }}</span>
        <span v-if="item.tone !== 'idle'" class="rq-stagetab__dot" :class="`rq-stagetab__dot--${item.tone}`" aria-hidden="true"></span>
      </span>
      <span class="rq-stagetab__status">{{ item.status }}</span>
    </RouterLink>
  </nav>
</template>
