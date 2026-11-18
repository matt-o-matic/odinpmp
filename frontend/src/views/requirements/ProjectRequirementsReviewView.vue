<script setup>
import { computed } from 'vue';

import RequirementsReviewStage from '../../components/requirements/RequirementsReviewStage.vue';
import { useRequirementsWorkspace } from '../../lib/requirements/requirements-context.js';
import { REVIEW_TRACK } from '../../lib/requirements/requirements-tracks.js';

// The Review tab. Review is project-wide: one round open at a time, for screens and
// prototypes, with questions from either track.
const workspace = useRequirementsWorkspace();
const stages = computed(() => (workspace.overview.value?.review ? { review: workspace.overview.value.review } : null));
</script>

<template>
  <div class="rq-stack">
    <h2 class="visually-hidden" tabindex="-1" data-rq-focus>Review</h2>
    <p v-if="workspace.overviewError.value && !stages" class="error-banner mb-0" role="alert">{{ workspace.overviewError.value }}</p>
    <RequirementsReviewStage :stages="stages" :track="REVIEW_TRACK" />
  </div>
</template>
