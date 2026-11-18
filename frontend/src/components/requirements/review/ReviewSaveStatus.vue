<script setup>
import { computed } from 'vue';

import { describeSaveStatus } from '../../../lib/requirements/review-autosave.js';

// "Saved 10:42", "Saving…", or "Couldn't save" with Retry. The text is a polite live region,
// so screen-reader users hear when work is saved and when it is not. Failed changes stay on
// screen; Retry sends them again.
const props = defineProps({
  compact: { default: false, type: Boolean },
  status: { default: null, type: Object },
});

const emit = defineEmits(['retry']);

const described = computed(() => describeSaveStatus(props.status));
const icon = computed(() => ({ error: 'bi-exclamation-triangle', saved: 'bi-cloud-check', saving: 'bi-arrow-repeat' })[described.value.tone] ?? '');
</script>

<template>
  <span class="rq-savestate" :class="[`rq-savestate--${described.tone}`, { 'rq-savestate--compact': compact }]" data-testid="rq-save-status">
    <span role="status" aria-live="polite" aria-atomic="true" class="rq-savestate__text">
      <template v-if="described.label">
        <i class="bi" :class="icon" aria-hidden="true"></i>{{ described.label }}<span v-if="described.tone === 'error'" class="visually-hidden">. Your changes are kept on this page.</span>
      </template>
    </span>
    <button v-if="described.tone === 'error'" class="rq-text-action rq-savestate__retry" type="button" @click="emit('retry')">Retry</button>
  </span>
</template>
