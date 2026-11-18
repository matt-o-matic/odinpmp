<script setup>
import { computed } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import RequirementsSignals from '../../components/requirements/RequirementsSignals.vue';
import { useRequirementsWorkspace } from '../../lib/requirements/requirements-context.js';
import {
  buildMyItemGroups,
  describeMyItemStages,
  filterMyItemGroups,
  myItemActionLabel,
  myItemAnswerChip,
  myItemMeta,
  myItemSecondaryAction,
  myItemTarget,
  myItemTitle,
  myItemWhen,
} from '../../lib/requirements/requirements-my-items.js';
import { chipToneClass } from '../../lib/requirements/requirements-topics.js';
import { REQUIREMENTS_STAGES, REQUIREMENTS_TRACKS, stageLocation, trackChipClass, trackLabel } from '../../lib/requirements/requirements-tracks.js';

const route = useRoute();
const router = useRouter();
const workspace = useRequirementsWorkspace();
// Rounds open the guided review; without that route they open the round's results page.
const roundReview = router.hasRoute('project-requirements-round-review');

const loaded = computed(() => workspace.myItems.value != null);
const groups = computed(() => buildMyItemGroups(workspace.myItems.value, { canDecide: workspace.canDecide.value }));
const stageCards = computed(() => describeMyItemStages(groups.value));
// The picked stage lives in the query so a filtered list survives a reload and can be linked.
const pickedStage = computed(() => {
  const value = String(route.query.stage ?? '');
  return REQUIREMENTS_STAGES.some((stage) => stage.id === value) ? value : '';
});
const pickedLabel = computed(() => REQUIREMENTS_STAGES.find((stage) => stage.id === pickedStage.value)?.label ?? '');
const rows = computed(() => {
  const now = new Date();
  return filterMyItemGroups(groups.value, pickedStage.value).map((group) => ({
    ...group,
    items: group.items.map((item) => ({
      action: myItemActionLabel(item),
      answerChip: myItemAnswerChip(item),
      item,
      meta: myItemMeta(item),
      primary: item.action === 'decide',
      secondary: myItemSecondaryAction(item, workspace.projectId.value, { canPublish: workspace.abilities.value.publishRounds }),
      target: myItemTarget(item, workspace.projectId.value, { roundReview }),
      title: myItemTitle(item),
      when: myItemWhen(item, { now }),
    })),
  }));
});

function trackLocation(track, stage = 'discuss') {
  return stageLocation(workspace.projectId.value, track, stage);
}

function pickStage(stage) {
  const query = { ...route.query };
  if (stage && stage !== pickedStage.value) query.stage = stage;
  else delete query.stage;
  router.replace({ query });
}
</script>

<template>
  <div class="rq-groups rq-my-items">
    <h2 class="visually-hidden" tabindex="-1" data-rq-focus>My open items</h2>

    <p v-if="!loaded && workspace.myItemsLoading.value" class="rq-muted rq-small">Loading your open items…</p>

    <div v-else-if="!loaded && workspace.myItemsError.value" class="error-banner rq-row rq-row--between" role="alert">
      <span>{{ workspace.myItemsError.value }}</span>
      <button class="ghost-button ghost-button--compact" type="button" @click="workspace.refreshMyItems({ passive: false })">Try again</button>
    </div>

    <div v-if="loaded" class="rq-stagetabs" role="group" aria-label="Your open items by stage">
      <button
        v-for="card in stageCards"
        :key="card.id"
        class="rq-stagetab"
        :class="{ 'rq-stagetab--on': card.id === pickedStage }"
        type="button"
        :aria-pressed="card.id === pickedStage ? 'true' : 'false'"
        @click="pickStage(card.id)"
      >
        <span class="rq-stagetab__top">
          <span class="rq-stagetab__num" aria-hidden="true">{{ card.number }}</span>
          <span class="rq-stagetab__name">{{ card.label }}</span>
          <span v-if="card.tone !== 'idle'" class="rq-stagetab__dot" :class="`rq-stagetab__dot--${card.tone}`" aria-hidden="true"></span>
        </span>
        <span class="rq-stagetab__status">{{ card.status }}</span>
      </button>
    </div>

    <div v-if="loaded && groups.length > 0 && rows.length === 0" class="rq-empty">
      <p><strong>Nothing in {{ pickedLabel }} is waiting on you.</strong></p>
      <p class="rq-row rq-row--wrap rq-small">
        <!-- Review is project-wide: one place, not one per track. -->
        <RouterLink v-if="pickedStage === 'review'" :to="trackLocation('', 'review')">Open Review</RouterLink>
        <template v-else>
          <span>Open {{ pickedLabel }} in:</span>
          <RouterLink v-for="track in REQUIREMENTS_TRACKS" :key="track" :to="trackLocation(track, pickedStage)">{{ trackLabel(track) }}</RouterLink>
        </template>
        <button class="rq-linkbutton" type="button" @click="pickStage('')">Show all your items</button>
      </p>
    </div>

    <div v-else-if="loaded && rows.length === 0" class="rq-empty">
      <p><strong>Nothing is waiting on you.</strong></p>
      <p class="rq-small">Topics assigned to you, reviews you're invited to, and decisions you can make show up here.</p>
      <p class="rq-row rq-row--wrap rq-small">
        <span>Browse the tracks:</span>
        <RouterLink v-for="track in REQUIREMENTS_TRACKS" :key="track" :to="trackLocation(track)">{{ trackLabel(track) }}</RouterLink>
      </p>
    </div>

    <section v-for="group in rows" :key="group.key" class="rq-group" :aria-labelledby="`rq-group-${group.key}`">
      <div class="rq-group__head">
        <h3 :id="`rq-group-${group.key}`" class="rq-group__title">{{ group.title }}</h3>
        <span class="rq-xs rq-muted">{{ group.items.length }}<template v-if="group.note"> · {{ group.note }}</template></span>
      </div>
      <ul class="rq-group__list">
        <li v-for="row in group.items" :key="`${row.item.kind}:${row.item.id}`" class="rq-item">
          <span class="rq-chip rq-track-chip" :class="trackChipClass(row.item.track)">{{ trackLabel(row.item.track) }}</span>
          <div>
            <div class="rq-item__title">{{ row.title }}</div>
            <div class="rq-item__meta">
              <span v-if="row.answerChip" class="rq-chip rq-chip--wrap" :class="chipToneClass(row.answerChip.tone)">{{ row.answerChip.label }}</span>
              <RequirementsSignals v-if="row.item.kind === 'topic' && row.item.action === 'decide'" :signals="row.item.meta?.signals ?? {}" />
              <span>{{ row.meta }}</span>
            </div>
          </div>
          <span class="rq-item__when" :class="{ 'rq-item__when--due': row.when.due }">{{ row.when.text }}</span>
          <span class="rq-item__actions">
            <RouterLink
              :class="row.primary ? 'primary-button primary-button--compact' : 'ghost-button ghost-button--compact'"
              :to="row.target"
              :aria-label="`${row.action}: ${row.title}`"
            >
              {{ row.action }}
            </RouterLink>
            <RouterLink
              v-if="row.secondary"
              class="primary-button primary-button--compact"
              :to="row.secondary.target"
              :aria-label="`${row.secondary.label}: ${row.title}`"
            >
              {{ row.secondary.label }}
            </RouterLink>
          </span>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.rq-my-items {
  max-width: 77rem;
}

button.rq-stagetab {
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.rq-linkbutton {
  padding: 0;
  border: 0;
  background: none;
  color: var(--rq-link);
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}

.rq-item__actions {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  justify-content: flex-end;
}
</style>
