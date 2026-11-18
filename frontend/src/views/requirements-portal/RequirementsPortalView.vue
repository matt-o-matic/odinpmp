<script setup>
import { computed, onBeforeUnmount, provide, ref, shallowRef, watch } from 'vue';
import { RouterView, useRoute } from 'vue-router';

import PortalHeader from '../../components/requirements/portal/PortalHeader.vue';
import PortalLinkProblem from '../../components/requirements/portal/PortalLinkProblem.vue';
import { apiClient } from '../../lib/auth/index.js';
import { PORTAL_CONTEXT } from '../../lib/requirements/portal-context.js';
import { classifyPortalError, isLinkProblem } from '../../lib/requirements/portal-view.js';
import { createPortalFeed } from '../../lib/requirements/review-adapters.js';
import { batchTouchesInbox } from '../../lib/requirements/review-live.js';

// The stakeholder portal at /requirements/:token (Q-03). The link token is the only
// credential. This shell loads what the link can see, keeps it live through the link's own
// event stream, and shows the explanation screens when the link stops working. The app's
// header and navigation are hidden here (App.vue, route meta `portal`).
const route = useRoute();

const portal = shallowRef(null);
const rounds = shallowRef([]);
const loading = ref(false);
const problem = ref(null);
const liveBatch = shallowRef(null);
let feed = null;
let stopListening = null;
let sequence = 0;

const token = computed(() => String(route.params.token ?? ''));
const isReview = computed(() => route.name === 'requirements-portal-review');

function stopFeed() {
  stopListening?.();
  stopListening = null;
  feed?.stop();
  feed = null;
}

async function load({ passive = false } = {}) {
  const current = ++sequence;
  const value = token.value;
  if (!value) return;
  if (!passive) loading.value = true;
  const client = passive ? apiClient.passive : apiClient;
  try {
    const [data, list] = await Promise.all([
      client.getRequirementsPortal(value),
      // Without the rounds API (no rounds yet on this server) the inbox shows questions only.
      client.listRequirementsPortalRounds(value).catch((error) => {
        if (Number(error?.status) === 404 && !isLinkProblem(error)) return { rounds: [] };
        throw error;
      }),
    ]);
    if (current !== sequence) return;
    portal.value = data;
    rounds.value = list?.rounds ?? [];
    problem.value = null;
    if (!feed) startFeed();
  } catch (error) {
    if (current !== sequence) return;
    if (passive && !isLinkProblem(error)) return;
    reportProblem(error);
  } finally {
    if (current === sequence) loading.value = false;
  }
}

function startFeed() {
  feed = createPortalFeed({ apiClient, portalToken: token.value });
  stopListening = feed.listen((batch) => {
    liveBatch.value = batch;
    if (batchTouchesInbox(batch)) load({ passive: true });
  });
}

function reportProblem(error) {
  const classified = classifyPortalError(error);
  problem.value = classified;
  if (classified.kind !== 'rate-limited' && classified.kind !== 'failed') stopFeed();
}

watch(token, () => {
  stopFeed();
  portal.value = null;
  rounds.value = [];
  problem.value = null;
  load();
}, { immediate: true });

onBeforeUnmount(stopFeed);

// The review page hears the same stream's batches, so a reconnect needs no re-wiring.
const liveFeed = {
  listen(listener) {
    return watch(liveBatch, (batch) => {
      if (batch) listener(batch);
    });
  },
};

provide(PORTAL_CONTEXT, {
  liveBatch,
  liveFeed,
  portal,
  reload: () => load({ passive: true }),
  reportProblem,
  rounds,
  token,
});

const eyebrow = computed(() => (portal.value?.project?.name ? `${portal.value.project.name} · client portal` : 'Client portal'));
</script>

<template>
  <div class="rq-workspace rq-portal" :class="{ 'rq-portal--review': isReview && !problem }">
    <PortalHeader
      v-if="!isReview || problem || !portal"
      :eyebrow="eyebrow"
      :link="portal?.link ?? null"
      :show-link="Boolean(portal) && !problem"
      :stakeholder="problem ? null : portal?.stakeholder ?? null"
    />
    <PortalLinkProblem
      v-if="problem"
      :problem="problem"
      :token="token"
      @retry="load()"
      @revoked="problem = { kind: 'revoked' }"
    />
    <div v-else-if="loading && !portal" class="rq-review-page">
      <p class="rq-review-card rq-small rq-muted mb-0" role="status">Loading your review…</p>
    </div>
    <RouterView v-else-if="portal" />
  </div>
</template>
