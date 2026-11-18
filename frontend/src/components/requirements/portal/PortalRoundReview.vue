<script setup>
import { computed, shallowRef, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';

import PortalHeader from './PortalHeader.vue';
import ReviewGuided from '../review/ReviewGuided.vue';
import ReviewSaveStatus from '../review/ReviewSaveStatus.vue';
import { apiClient } from '../../../lib/auth/index.js';
import { usePortal } from '../../../lib/requirements/portal-context.js';
import { roundAsker } from '../../../lib/requirements/portal-view.js';
import { trackLabel } from '../../../lib/requirements/requirements-tracks.js';
import { createReviewAdapter, reviewScope } from '../../../lib/requirements/review-adapters.js';

// The guided review for a stakeholder, on the portal's round API and the link's stream.
const route = useRoute();
const { liveFeed, portal, reportProblem, rounds, token } = usePortal();

const roundId = computed(() => String(route.params.roundId ?? ''));
const adapter = shallowRef(null);
const listed = computed(() => rounds.value.find((round) => round.id === roundId.value) ?? null);
const asker = computed(() => (listed.value ? roundAsker(listed.value, portal.value?.project?.name ?? '').name : ''));

watch([token, roundId], ([value, round]) => {
  adapter.value = value && round ? createReviewAdapter({ apiClient, liveFeed, scope: reviewScope({ portalToken: value, roundId: round }) }) : null;
}, { immediate: true });

function eyebrow(round) {
  const project = portal.value?.project?.name ?? 'Client portal';
  return round ? `${project} · ${trackLabel(round.track)}` : project;
}
</script>

<template>
  <ReviewGuided v-if="adapter" :key="roundId" :adapter="adapter" :asker="asker" audience="portal" @link-problem="reportProblem">
    <template #header="{ phone, retry, round, save, title }">
      <PortalHeader :eyebrow="eyebrow(round)" :show-link="false" :stakeholder="phone ? null : portal?.stakeholder ?? null" :title="title">
        <template #status>
          <RouterLink class="rq-portal-head__home" :to="{ name: 'requirements-portal', params: { token } }">
            <i class="bi bi-arrow-left" aria-hidden="true"></i><span :class="{ 'visually-hidden': phone }">All requests</span>
          </RouterLink>
          <ReviewSaveStatus :compact="phone" :status="save" @retry="retry()" />
        </template>
      </PortalHeader>
    </template>
    <template #not-found>
      <RouterLink class="ghost-button ghost-button--compact" :to="{ name: 'requirements-portal', params: { token } }">Back to your requests</RouterLink>
    </template>
  </ReviewGuided>
</template>
