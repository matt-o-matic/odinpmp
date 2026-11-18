<script setup>
import { computed } from 'vue';
import { RouterLink, useRouter } from 'vue-router';

import './rounds.css';
import { formatShortDate } from '../../../lib/requirements/requirements-time.js';
import { chipToneClass } from '../../../lib/requirements/requirements-topics.js';
import { describeStage } from '../../../lib/requirements/requirements-tracks.js';
import { roundMetaLine, roundStatusChip, sortRounds } from '../../../lib/requirements/requirements-rounds.js';

// The Review tab's rounds: the open round first and highlighted, then earlier rounds newest
// first. Each row opens the round's results; the open round also offers Edit reviewers and
// dates to people who manage rounds. When the list can't load, the overview's one-line
// status still shows what is known.
const props = defineProps({
  canManage: { default: false, type: Boolean },
  error: { default: '', type: String },
  loaded: { default: false, type: Boolean },
  projectId: { required: true, type: String },
  rounds: { default: () => [], type: Array },
  stages: { default: null, type: Object },
});

const emit = defineEmits(['retry']);

const router = useRouter();
const rows = computed(() => sortRounds(props.rounds));
const overviewRound = computed(() => props.stages?.review?.latestRound ?? null);
const overviewStatus = computed(() => (overviewRound.value && props.stages ? describeStage('review', props.stages).status : ''));
const showFallback = computed(() => Boolean(props.error) && Boolean(overviewRound.value));
const empty = computed(() => (props.loaded && !props.error && rows.value.length === 0) || (props.error && !overviewRound.value));
const hasGuidedReview = router.hasRoute('project-requirements-round-review');

function roundLocation(round, query = null) {
  return { name: 'project-requirements-round', params: { projectId: props.projectId, roundId: round.id }, ...(query ? { query } : {}) };
}

function reviewLocation(round) {
  return { name: 'project-requirements-round-review', params: { projectId: props.projectId, roundId: round.id } };
}

function marksLocation(round) {
  return { name: 'project-requirements-round-annotations', params: { projectId: props.projectId, roundId: round.id } };
}

function chipFor(round) {
  const chip = roundStatusChip(round);
  return chip.tone === 'solid' ? 'rq-chip--solid' : chipToneClass(chip.tone);
}
</script>

<template>
  <section class="rq-panel rq-stack" aria-labelledby="rq-review-heading">
    <h3 id="rq-review-heading" class="rq-eyebrow">Review rounds</h3>

    <p v-if="!loaded && !error" class="rq-small rq-muted mb-0">Loading rounds…</p>

    <div v-if="showFallback" class="rq-stack rq-stack--sm">
      <p class="rq-small mb-0"><strong>{{ overviewStatus }}</strong></p>
      <p class="rq-xs rq-muted mb-0">
        <template v-if="overviewRound.publishedAt">Published {{ formatShortDate(overviewRound.publishedAt) }}</template>
        <template v-if="overviewRound.dueAt"> · due {{ formatShortDate(overviewRound.dueAt, { weekday: true }) }}</template>
      </p>
    </div>
    <!-- A polite status, not an alert: the overview line above still says where the track stands. -->
    <div v-if="error && !empty" class="error-banner rq-row rq-row--between" role="status">
      <span>{{ error }}</span>
      <button class="ghost-button ghost-button--compact" type="button" @click="emit('retry')">Try again</button>
    </div>

    <div v-if="empty" class="rq-empty">
      <p><strong>No rounds yet</strong></p>
      <p class="rq-small">Publish a draft package to send it to reviewers as a round. Its progress and results show up here.</p>
    </div>

    <ul v-else-if="loaded && !error" class="rq-rounds" aria-label="Rounds">
      <li v-for="round in rows" :key="round.id" class="rq-round-row" :class="{ 'rq-round-row--open': round.status === 'open' }">
        <span class="rq-round-row__num" aria-hidden="true">R{{ round.number }}</span>
        <div class="rq-round-row__main">
          <RouterLink class="rq-round-row__title" :to="roundLocation(round)" :aria-label="`Round ${round.number}: ${round.title || 'results'}`">
            Round {{ round.number }}<template v-if="round.title"> · {{ round.title }}</template>
          </RouterLink>
          <span class="rq-xs rq-muted">{{ roundMetaLine(round) }}</span>
        </div>
        <span class="rq-chip" :class="chipFor(round)">{{ roundStatusChip(round).label }}</span>
        <div class="rq-round-row__actions">
          <RouterLink
            class="ghost-button ghost-button--compact"
            :to="marksLocation(round)"
            :aria-label="`Marks and comments: round ${round.number}`"
          >
            <i class="bi bi-chat-square-text" aria-hidden="true"></i>Marks and comments
          </RouterLink>
          <RouterLink
            v-if="round.status === 'open' && canManage"
            class="ghost-button ghost-button--compact"
            :to="roundLocation(round, { edit: '1' })"
            :aria-label="`Edit reviewers and dates: round ${round.number}`"
          >
            <i class="bi bi-people" aria-hidden="true"></i>Edit reviewers and dates
          </RouterLink>
          <RouterLink
            v-if="round.status === 'open' && round.me && hasGuidedReview"
            :class="round.me.submittedAt ? 'ghost-button ghost-button--compact' : 'primary-button primary-button--compact'"
            :to="reviewLocation(round)"
            :aria-label="`${round.me.submittedAt ? 'Your review' : 'Review'}: round ${round.number}`"
          >
            <i class="bi bi-pencil-square" aria-hidden="true"></i>{{ round.me.submittedAt ? 'Your review' : 'Review' }}
          </RouterLink>
        </div>
      </li>
    </ul>
  </section>
</template>
