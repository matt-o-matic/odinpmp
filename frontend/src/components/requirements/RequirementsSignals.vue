<script setup>
import { computed } from 'vue';

import { signalBadges, signalsAriaLabel } from '../../lib/requirements/requirements-topics.js';

const props = defineProps({
  signals: { default: () => ({}), type: Object },
});

const badges = computed(() => signalBadges(props.signals));
const label = computed(() => signalsAriaLabel(props.signals));
</script>

<template>
  <span v-if="badges.length" class="rq-signals" role="img" :aria-label="label">
    <span v-for="badge in badges" :key="badge.key" class="rq-signal" :class="badge.className" aria-hidden="true">
      {{ badge.count }} <i v-if="badge.icon" class="bi" :class="badge.icon"></i><template v-else>{{ badge.symbol }}</template>
    </span>
  </span>
  <span v-else class="rq-xs rq-muted"><span aria-hidden="true">—</span><span class="visually-hidden">No summary signals yet</span></span>
</template>
