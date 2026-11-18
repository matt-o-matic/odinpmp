<script setup>
import { computed, nextTick, onMounted, ref } from 'vue';

import { apiClient } from '../../../lib/auth/index.js';
import { classifyPortalError } from '../../../lib/requirements/portal-view.js';
import { formatShortDate } from '../../../lib/requirements/requirements-time.js';

// When the link no longer opens the portal: not found, expired (with "Request a new
// link", which tells the project's admins and managers), turned off (no request: the team
// chose to), too many requests, or a failed load.
const props = defineProps({
  problem: { required: true, type: Object },
  token: { required: true, type: String },
});

const emit = defineEmits(['retry', 'revoked']);

const heading = ref(null);
const requesting = ref(false);
const requested = ref(null);
const requestError = ref('');

const kind = computed(() => props.problem.kind);
const expiredOn = computed(() => (props.problem.expiredAt ? formatShortDate(props.problem.expiredAt) : ''));
const title = computed(() => ({
  expired: 'This link has expired',
  failed: 'The review didn’t load',
  'not-found': 'This link doesn’t work',
  'rate-limited': 'Too many requests for a moment',
  revoked: 'This link was turned off',
})[kind.value] ?? 'This link doesn’t work');

onMounted(async () => {
  await nextTick();
  heading.value?.focus();
});

async function requestLink() {
  if (requesting.value) return;
  requesting.value = true;
  requestError.value = '';
  try {
    const result = await apiClient.requestRequirementsPortalLink(props.token);
    requested.value = { already: Boolean(result?.alreadyRequested) };
  } catch (error) {
    const problem = classifyPortalError(error);
    if (problem.kind === 'revoked') emit('revoked');
    else if (problem.kind === 'rate-limited') requestError.value = 'Too many requests from this link. Wait a minute, then try again.';
    else if (problem.kind === 'not-found') requestError.value = 'This link can’t ask for a new one. Contact the project team directly.';
    else requestError.value = 'The request didn’t go through. Try again.';
  } finally {
    requesting.value = false;
  }
}
</script>

<template>
  <div class="rq-review-page">
    <section class="rq-review-card rq-stack rq-linkproblem" aria-labelledby="rq-linkproblem-heading" data-testid="rq-link-problem">
      <i class="bi rq-linkproblem__icon" :class="kind === 'expired' ? 'bi-hourglass-bottom' : kind === 'rate-limited' ? 'bi-stopwatch' : 'bi-link-45deg'" aria-hidden="true"></i>
      <h1 id="rq-linkproblem-heading" ref="heading" class="rq-title rq-title--lg rq-section-heading" tabindex="-1">{{ title }}</h1>

      <template v-if="kind === 'expired'">
        <p class="mb-0">Review links stay active while you have open requests, then for 14 more days<template v-if="expiredOn">. This one ended on {{ expiredOn }}</template>.</p>
        <p class="mb-0">Ask for a new link and the project team will send one to your email.</p>
        <div v-if="requested" class="success-banner" role="status">
          <template v-if="requested.already">You already asked for a new link. The project team has been told and will send one to your email.</template>
          <template v-else>Request sent. The project team will send a new link to your email.</template>
        </div>
        <div v-else>
          <button class="primary-button" type="button" :disabled="requesting" @click="requestLink">{{ requesting ? 'Sending request…' : 'Request a new link' }}</button>
        </div>
        <p v-if="requestError" class="error-banner mb-0" role="alert">{{ requestError }}</p>
      </template>

      <template v-else-if="kind === 'revoked'">
        <p class="mb-0">The project team turned this link off. If you still need to take part, contact them directly.</p>
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
        <p class="mb-0">Check that you opened the whole link from your email. If it still doesn’t work, ask the project team to send a new one.</p>
      </template>
    </section>
  </div>
</template>
