<script setup>
import { RouterLink } from 'vue-router';

// Result of "Draft questions from brief": what was added, or why nothing was.
defineProps({
  busy: { default: false, type: Boolean },
  // { tone: 'success' | 'error', message, code?, retryable?, showRegisterLink? }
  feedback: { required: true, type: Object },
  projectId: { required: true, type: String },
  track: { required: true, type: String },
});

defineEmits(['dismiss', 'retry']);
</script>

<template>
  <div v-if="feedback.tone === 'error'" class="error-banner rq-row rq-row--between rq-row--wrap" role="alert">
    <span>{{ feedback.message }}</span>
    <span class="rq-row rq-row--tight">
      <RouterLink
        v-if="feedback.code === 'brief_empty'"
        class="ghost-button ghost-button--compact"
        :to="{ name: 'project-detail', params: { projectId }, query: { projectSettings: 'details' } }"
      >
        Open the project brief
      </RouterLink>
      <button v-if="feedback.retryable" class="ghost-button ghost-button--compact" type="button" :disabled="busy" @click="$emit('retry')">
        Try again
      </button>
      <button class="rq-dialog__close" type="button" aria-label="Dismiss message" @click="$emit('dismiss')">
        <i class="bi bi-x-lg" aria-hidden="true"></i>
      </button>
    </span>
  </div>
  <div v-else class="success-banner rq-row rq-row--between rq-row--wrap" role="status">
    <span>{{ feedback.message }}</span>
    <span class="rq-row rq-row--tight">
      <RouterLink
        v-if="feedback.showRegisterLink"
        class="ghost-button ghost-button--compact"
        :to="{ name: 'project-requirements-track', params: { projectId, stage: 'discuss', track } }"
      >
        Show in Discuss
      </RouterLink>
      <button class="rq-dialog__close" type="button" aria-label="Dismiss message" @click="$emit('dismiss')">
        <i class="bi bi-x-lg" aria-hidden="true"></i>
      </button>
    </span>
  </div>
</template>
