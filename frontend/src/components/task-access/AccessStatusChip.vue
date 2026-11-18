<script setup>
import { computed } from 'vue';

import { statusLabel, statusTone } from '../../lib/task-access/access-view.js';

// An item's status as a chip: an icon and the status text, so color is never the only signal.
// Workflow state keys (`in_progress`) show as words.
const props = defineProps({
  status: { default: '', type: String },
});

const tone = computed(() => statusTone(props.status));
</script>

<template>
  <span class="rq-chip access-status" :class="`access-status--${tone.tone}`">
    <i class="bi" :class="tone.icon" aria-hidden="true"></i>{{ statusLabel(status) || 'No status' }}
  </span>
</template>
