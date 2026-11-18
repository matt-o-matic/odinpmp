<script setup>
import { computed } from 'vue';
import { RouterLink, useRoute } from 'vue-router';

import './plans.css';
import { proposedWorkGroups, reviewLinkLocation } from '../../../lib/requirements/requirements-plans.js';
import { chipToneClass } from '../../../lib/requirements/requirements-topics.js';

// Proposed work from an approved plan, per person who proposed it: each epic and story with
// the criteria it implements, the decisions behind them, and whether it was applied, is
// still pending, or was dismissed. Proposals live in the proposer's AI Workspace review, so
// only the proposer gets the link there; everyone else sees status. Nothing becomes a work
// item until a person applies it (Q-06).
const props = defineProps({
  labels: { default: () => new Map(), type: Map },
  plan: { required: true, type: Object },
});

const route = useRoute();
const groups = computed(() => proposedWorkGroups(props.plan.proposedWork ?? [], { labels: props.labels, plan: props.plan }));

function reviewLocation(group) {
  return reviewLinkLocation(group.reviewLink, route);
}
</script>

<template>
  <section class="rq-panel rq-stack" aria-labelledby="rq-plan-work-heading">
    <div class="rq-row rq-row--between rq-row--wrap">
      <h3 id="rq-plan-work-heading" class="rq-eyebrow">Proposed work · pending review</h3>
      <span class="rq-xs rq-muted">Nothing is created until someone applies it</span>
    </div>
    <p v-if="groups.length === 0" class="rq-small rq-muted mb-0">No work proposed from this plan yet.</p>
    <div v-for="group in groups" :key="group.key" class="rq-work-group" :aria-label="group.heading" role="group">
      <div class="rq-row rq-row--between rq-row--wrap">
        <span class="rq-small"><strong>{{ group.heading }}</strong> <span class="rq-xs rq-muted">· {{ group.countsText }}</span></span>
        <RouterLink
          v-if="group.reviewLink && reviewLocation(group)"
          class="primary-button primary-button--compact"
          :to="reviewLocation(group)"
        >
          <i class="bi bi-stars" aria-hidden="true"></i>Review in AI Workspace
        </RouterLink>
      </div>
      <ul class="rq-work-list" :aria-label="`Work proposed by ${group.mine ? 'you' : group.name}`">
        <li v-for="item in group.items" :key="item.itemId" class="rq-work" :class="{ 'rq-work--nested': item.nested }">
          <i class="bi rq-work__icon" :class="item.kind === 'epic' ? 'bi-collection' : 'bi-card-checklist'" aria-hidden="true"></i>
          <span class="rq-work__text">
            <strong>{{ item.kindLabel }} · {{ item.title }}</strong>
            <span v-if="item.meta" class="rq-xs rq-muted"> · {{ item.meta }}</span>
          </span>
          <span class="rq-chip" :class="chipToneClass(item.chip.tone)">{{ item.chip.label }}</span>
        </li>
      </ul>
      <p v-if="!group.mine && group.counts.pending > 0" class="rq-xs rq-muted mb-0">
        {{ group.name }} reviews these in their AI Workspace.
      </p>
    </div>
    <p v-if="groups.some((group) => group.reviewLink)" class="rq-xs rq-muted mb-0">
      <i class="bi bi-info-circle" aria-hidden="true"></i> Review opens your AI Workspace, like other assistant proposals. Apply or dismiss each item there.
    </p>
  </section>
</template>
