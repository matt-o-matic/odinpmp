<script setup>
import { computed } from 'vue';
import { RouterLink } from 'vue-router';

import './plans.css';
import { decisionRows } from '../../../lib/requirements/requirements-plans.js';
import { formatShortDate } from '../../../lib/requirements/requirements-time.js';
import { chipToneClass } from '../../../lib/requirements/requirements-topics.js';
import { plural } from '../../../lib/requirements/requirements-tracks.js';
import RequirementsDecisionStatement from '../RequirementsDecisionStatement.vue';

// "Decisions this plan builds on": the track's topic decisions and accepted preferences
// with their D-labels, active ones first, then superseded ones with what replaced them. A
// decision the shown plan cites but that was superseded is flagged as a stale citation.
const props = defineProps({
  decisions: { default: () => [], type: Array },
  error: { default: '', type: String },
  loaded: { default: false, type: Boolean },
  plan: { default: null, type: Object },
  projectId: { required: true, type: String },
});

const emit = defineEmits(['retry']);

const model = computed(() => decisionRows(props.decisions, props.plan));

function rowId(id) {
  return `rq-plan-decision-${String(id).replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

function focusDecision(id) {
  const element = typeof document !== 'undefined' ? document.getElementById(rowId(id)) : null;
  element?.focus?.({ preventScroll: true });
  element?.scrollIntoView?.({ block: 'center' });
}

function topicLocation(topicId) {
  return { name: 'project-requirements-topic', params: { projectId: props.projectId, topicId } };
}
</script>

<template>
  <section class="rq-panel rq-stack" aria-labelledby="rq-plan-decisions-heading">
    <div class="rq-row rq-row--between rq-row--wrap">
      <h3 id="rq-plan-decisions-heading" class="rq-eyebrow">Decisions this plan builds on</h3>
      <span v-if="loaded && !error" class="rq-xs rq-muted">{{ model.countsText }}</span>
    </div>
    <div v-if="error" class="error-banner rq-row rq-row--between" role="alert">
      <span>{{ error }}</span>
      <button class="ghost-button ghost-button--compact" type="button" @click="emit('retry')">Try again</button>
    </div>
    <p v-else-if="!loaded" class="rq-small rq-muted mb-0">Loading decisions…</p>
    <p v-else-if="model.rows.length === 0" class="rq-small rq-muted mb-0">
      No decisions or accepted preferences yet. A plan is drafted from them, so record some in the Decide stage first.
    </p>
    <ol v-else class="rq-plan-decisions">
      <li
        v-for="row in model.rows"
        :id="rowId(row.id)"
        :key="row.id"
        class="rq-plan-decision"
        :class="{ 'rq-plan-decision--superseded': row.superseded }"
        tabindex="-1"
      >
        <span class="rq-plan-decision__id">{{ row.label }}</span>
        <div>
          <div class="rq-row rq-row--tight rq-row--wrap">
            <span class="rq-chip" :class="chipToneClass(row.chip.tone)">{{ row.chip.label }}</span>
            <span v-if="row.stale" class="rq-chip rq-chip--warn">
              <i class="bi bi-exclamation-triangle" aria-hidden="true"></i>Cited by v{{ plan?.version }} · superseded
            </span>
            <span class="rq-xs rq-muted">
              <template v-if="row.superseded && row.supersededByLabel">by
                <button class="rq-link-button" type="button" @click="focusDecision(row.supersededById)">{{ row.supersededByLabel }}</button>
              </template>
              <template v-else>
                {{ row.decidedBy?.name || 'Team member' }} · {{ formatShortDate(row.decidedAt) }}<template v-if="row.sourceCount"> · {{ plural(row.sourceCount, 'source') }}</template>
              </template>
            </span>
          </div>
          <div class="rq-plan-decision__statement">
            <span v-if="row.superseded" class="visually-hidden">Superseded: </span>
            <RequirementsDecisionStatement :statement="row.statement" />
          </div>
          <p v-if="!row.superseded && (row.topic || row.preference?.dimension || row.supersedesLabel)" class="rq-xs rq-muted mb-0">
            <template v-if="row.topic">Topic: <RouterLink :to="topicLocation(row.topic.id)">{{ row.topic.prompt }}</RouterLink></template>
            <template v-else-if="row.preference?.dimension">{{ row.preference.dimension }}</template>
            <template v-if="row.supersedesLabel">
              · supersedes <button class="rq-link-button" type="button" @click="focusDecision(row.supersedesId)">{{ row.supersedesLabel }}</button>
            </template>
          </p>
        </div>
      </li>
    </ol>
  </section>
</template>
