<script setup>
import { computed, nextTick, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';

import { formatShortDate } from '../../lib/requirements/requirements-time.js';

// When the access link no longer opens a page: not found, expired, turned off, too many
// requests, a failed load, or (on a project page) a project that is no longer shared. Same
// look as the requirements portal's link screens; there is no "request a new link" here, so
// each screen says to ask the project team.
const props = defineProps({
  hubLink: { default: null, type: Object },
  problem: { required: true, type: Object },
});

const emit = defineEmits(['retry']);

const heading = ref(null);
const kind = computed(() => props.problem.kind);
const expiredOn = computed(() => (props.problem.expiredAt ? formatShortDate(props.problem.expiredAt) : ''));
const title = computed(() => ({
  expired: 'This link has expired',
  failed: 'This page didn’t load',
  'no-project': 'This project is no longer shared with you',
  'not-found': 'This link doesn’t work',
  'rate-limited': 'Too many requests for a moment',
  revoked: 'This link was turned off',
})[kind.value] ?? 'This link doesn’t work');
const icon = computed(() => ({
  expired: 'bi-hourglass-bottom',
  'no-project': 'bi-folder-x',
  'rate-limited': 'bi-stopwatch',
})[kind.value] ?? 'bi-link-45deg');

onMounted(async () => {
  await nextTick();
  heading.value?.focus();
});
</script>

<template>
  <div class="rq-review-page">
    <section class="rq-review-card rq-stack rq-linkproblem" aria-labelledby="access-linkproblem-heading" data-testid="access-link-problem">
      <i class="bi rq-linkproblem__icon" :class="icon" aria-hidden="true"></i>
      <h1 id="access-linkproblem-heading" ref="heading" class="rq-title rq-title--lg rq-section-heading" tabindex="-1">{{ title }}</h1>

      <template v-if="kind === 'expired'">
        <p class="mb-0">Links stop working 14 days after the last work shared with you ends<template v-if="expiredOn">. This one ended on {{ expiredOn }}</template>.</p>
        <p class="mb-0">Ask the project team to send you a new link.</p>
      </template>

      <template v-else-if="kind === 'revoked'">
        <p class="mb-0">The project team turned this link off. If you still need access, ask them for a new link.</p>
      </template>

      <template v-else-if="kind === 'no-project'">
        <p class="mb-0">The project team turned off your access to this project. If you still need it, ask them.</p>
        <div v-if="hubLink"><RouterLink class="ghost-button" :to="hubLink"><i class="bi bi-arrow-left" aria-hidden="true"></i>Your projects</RouterLink></div>
      </template>

      <template v-else-if="kind === 'rate-limited'">
        <p class="mb-0">This link made a lot of requests in a short time. Wait a moment, then try again.</p>
        <div><button class="ghost-button" type="button" @click="emit('retry')">Try again</button></div>
      </template>

      <template v-else-if="kind === 'failed'">
        <p class="mb-0">Something went wrong while loading. Check your connection and try again.</p>
        <div><button class="ghost-button" type="button" @click="emit('retry')">Try again</button></div>
      </template>

      <template v-else>
        <p class="mb-0">Check that you opened the whole link from your email. If it still doesn’t work, ask the project team for a new link.</p>
      </template>
    </section>
  </div>
</template>
