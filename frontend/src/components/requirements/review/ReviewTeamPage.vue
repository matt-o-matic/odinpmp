<script setup>
import { computed, onBeforeUnmount, shallowRef, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import ReviewGuided from './ReviewGuided.vue';
import RoundViewTabs from '../rounds/RoundViewTabs.vue';
import { apiClient } from '../../../lib/auth/index.js';
import { useRequirementsWorkspace } from '../../../lib/requirements/requirements-context.js';
import { reviewLocation } from '../../../lib/requirements/requirements-tracks.js';
import { createReviewAdapter, createTeamReviewFeed, reviewScope } from '../../../lib/requirements/review-adapters.js';

// A team member reviewing a round inside the app (route project-requirements-round-review).
// Same guided review as the client portal, on the team review API, with live updates
// from the shared project event stream. `?mark=<id>` opens on that mark, as links from
// Marks and comments do; each mark links back there.
const route = useRoute();
const router = useRouter();
const workspace = useRequirementsWorkspace();

const projectId = computed(() => workspace.projectId.value);
const roundId = computed(() => String(route.params.roundId ?? ''));
// Read once, when the review opens.
const focusMark = String(route.query.mark ?? '');
const adapter = shallowRef(null);
const roundNumber = shallowRef(null);
let feed = null;

watch([projectId, roundId], ([project, round]) => {
  feed?.stop();
  feed = null;
  adapter.value = null;
  if (!project || !round) return;
  feed = createTeamReviewFeed({ apiClient, getToken: workspace.token, projectId: project });
  adapter.value = createReviewAdapter({ apiClient, getToken: workspace.token, liveFeed: feed, scope: reviewScope({ projectId: project, roundId: round }) });
}, { immediate: true });

onBeforeUnmount(() => {
  feed?.stop();
  feed = null;
});

function marksLink(markId) {
  return {
    hash: markId ? `#mark-${markId}` : '',
    name: 'project-requirements-round-annotations',
    params: { projectId: projectId.value, roundId: roundId.value },
  };
}

function onLoaded(data) {
  roundNumber.value = data?.round?.number ?? null;
  workspace.refreshMyItems?.();
}

// The mark is open now; a reload resumes where the reviewer is instead.
function onFocused() {
  if (!route.query.mark) return;
  const { mark: _mark, ...query } = route.query;
  router.replace({ hash: route.hash, query });
}
</script>

<template>
  <div class="rq-stack rq-team-review">
    <div class="rq-team-review__top">
      <nav class="rq-breadcrumb" aria-label="Breadcrumb">
        <ol>
          <li><RouterLink :to="{ name: 'project-requirements', params: { projectId } }">Requirements</RouterLink></li>
          <li><RouterLink :to="reviewLocation(projectId)">Review</RouterLink></li>
          <li><RouterLink :to="{ name: 'project-requirements-round', params: { projectId, roundId } }">Round {{ roundNumber ?? '' }}</RouterLink></li>
          <li aria-current="page">Your review</li>
        </ol>
      </nav>
      <RoundViewTabs current="review" :project-id="projectId" :round-id="roundId" />
    </div>
    <ReviewGuided
      v-if="adapter"
      :key="`${projectId}:${roundId}`"
      :adapter="adapter"
      audience="team"
      :focus-mark="focusMark"
      :marks-link="marksLink"
      @focused="onFocused"
      @loaded="onLoaded"
    >
      <template #not-found>
        <RouterLink class="ghost-button ghost-button--compact" :to="reviewLocation(projectId)">Back to Review</RouterLink>
      </template>
    </ReviewGuided>
  </div>
</template>
