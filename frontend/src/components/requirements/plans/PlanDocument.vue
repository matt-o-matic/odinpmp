<script setup>
import { computed } from 'vue';

import './plans.css';
import { citationChips, staleNotice } from '../../../lib/requirements/requirements-plans.js';

// One plan version as people read it: objective, scope, what is not in scope, and the
// acceptance criteria with the decisions each cites. Citations to superseded decisions are
// flagged. No AI-drafted tag anywhere.
const props = defineProps({
  labels: { default: () => new Map(), type: Map },
  plan: { required: true, type: Object },
});

const notice = computed(() => staleNotice(props.plan, { labels: props.labels }));

function chips(ids) {
  return citationChips(ids, { labels: props.labels, plan: props.plan });
}
</script>

<template>
  <div class="rq-plan-doc">
    <p v-if="notice" class="rq-notice rq-small mb-0" role="note">
      <i class="bi bi-exclamation-triangle" aria-hidden="true"></i>{{ notice }}
    </p>

    <h4>Objective</h4>
    <p class="mb-0">{{ plan.objective || 'Not set yet.' }}</p>

    <h4>Scope</h4>
    <p v-if="!plan.scope?.length" class="rq-muted mb-0">Nothing in scope yet.</p>
    <ul v-else>
      <li v-for="(item, index) in plan.scope" :key="`scope-${index}`">
        {{ item.text }}
        <span v-if="item.decisionIds?.length" class="rq-sources">
          <span
            v-for="chip in chips(item.decisionIds)"
            :key="chip.id"
            class="rq-source"
            :class="{ 'rq-source--stale': chip.state !== 'active' }"
            role="note"
            :aria-label="chip.ariaLabel"
          >{{ chip.label }}<i v-if="chip.state !== 'active'" class="bi bi-exclamation-triangle ms-1" aria-hidden="true"></i></span>
        </span>
      </li>
    </ul>

    <template v-if="plan.nonGoals?.length">
      <h4>Not in scope</h4>
      <ul>
        <li v-for="(item, index) in plan.nonGoals" :key="`non-${index}`">
          {{ item.text }}
          <span v-if="item.decisionIds?.length" class="rq-sources">
            <span
              v-for="chip in chips(item.decisionIds)"
              :key="chip.id"
              class="rq-source"
              :class="{ 'rq-source--stale': chip.state !== 'active' }"
              role="note"
              :aria-label="chip.ariaLabel"
            >{{ chip.label }}<i v-if="chip.state !== 'active'" class="bi bi-exclamation-triangle ms-1" aria-hidden="true"></i></span>
          </span>
        </li>
      </ul>
    </template>

    <h4>Acceptance criteria</h4>
    <p v-if="!plan.criteria?.length" class="rq-muted mb-0">No acceptance criteria yet. A plan needs at least one before it can be approved.</p>
    <div v-else class="rq-plan-criteria-scroll" role="region" aria-label="Acceptance criteria table" tabindex="0">
      <table class="rq-table rq-plan-criteria">
        <caption class="visually-hidden">Acceptance criteria and the decisions each one cites</caption>
        <thead>
          <tr>
            <th scope="col">ID</th>
            <th scope="col">Scenario and expected result</th>
            <th scope="col">From</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="criterion in plan.criteria" :key="criterion.id">
            <td>{{ criterion.id }}</td>
            <td>{{ criterion.scenario }}</td>
            <td>
              <span class="rq-sources">
                <span
                  v-for="chip in chips(criterion.decisionIds)"
                  :key="chip.id"
                  class="rq-source"
                  :class="{ 'rq-source--stale': chip.state !== 'active' }"
                  role="note"
                  :aria-label="chip.ariaLabel"
                >{{ chip.label }}<i v-if="chip.state !== 'active'" class="bi bi-exclamation-triangle ms-1" aria-hidden="true"></i></span>
                <span v-if="!criterion.decisionIds?.length" class="rq-muted">—</span>
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
