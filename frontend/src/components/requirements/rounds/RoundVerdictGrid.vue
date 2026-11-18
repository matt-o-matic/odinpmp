<script setup>
import { computed } from 'vue';

import './rounds.css';
import RequirementsAvatar from '../RequirementsAvatar.vue';
import { VERDICT_LEGEND, verdictMeta } from '../../../lib/requirements/requirements-rounds.js';

// Verdicts by reviewer: one row per reviewer, one column per screen. A missing verdict is a
// hatched "Not reviewed" cell and never counts as agreement. Column headers pick the screen
// whose Odin summary shows beside the grid; a cell shows that reviewer's verdict notes below
// the grid.
const props = defineProps({
  // [{ key, label }] feedback dimensions, for verdict details.
  dimensions: { default: () => [], type: Array },
  // From buildVerdictGrid(results).
  grid: { required: true, type: Object },
  selectedCell: { default: null, type: Object },
  selectedScreenId: { default: '', type: String },
});

const emit = defineEmits(['select-cell', 'select-screen']);

const dimensionLabel = computed(() => new Map(props.dimensions.map((dimension) => [dimension.key, dimension.label])));
const reviewerCount = computed(() => props.grid.rows.length);
const detail = computed(() => {
  const cell = props.selectedCell;
  if (!cell) return null;
  const row = props.grid.rows.find((entry) => entry.actorRef === cell.actorRef);
  const column = props.grid.columns.find((entry) => entry.screenId === cell.screenId);
  const found = row?.cells.find((entry) => entry.screenId === cell.screenId);
  if (!row || !column || !found) return null;
  const verdict = found.verdict ?? null;
  return {
    dimensions: Object.entries(verdict?.dimensions ?? {}).map(([key, value]) => ({ key, label: dimensionLabel.value.get(key) ?? key, value: verdictMeta(value).label })),
    label: found.label,
    name: row.name,
    notReviewed: found.notReviewed,
    notes: [
      verdict?.stay ? { label: 'What should stay', text: verdict.stay } : null,
      verdict?.change ? { label: 'What should change', text: verdict.change } : null,
      verdict?.mixed ? { label: 'Mixed feelings', text: verdict.mixed } : null,
    ].filter(Boolean),
    screen: column.title,
  };
});

function isSelected(row, cell) {
  return props.selectedCell?.actorRef === row.actorRef && props.selectedCell?.screenId === cell.screenId;
}
</script>

<template>
  <div class="rq-stack rq-stack--sm rq-vgrid-wrap">
    <div class="rq-row rq-row--between rq-row--wrap">
      <h3 id="rq-verdicts-heading" class="rq-eyebrow">Verdicts by reviewer</h3>
      <ul class="rq-vlegend" aria-label="Legend">
        <li v-for="entry in VERDICT_LEGEND" :key="entry.key">
          <span class="rq-vswatch rq-vcell" :class="entry.className" aria-hidden="true"></span>{{ entry.label }}
        </li>
      </ul>
    </div>

    <p v-if="grid.columns.length === 0" class="rq-small rq-muted mb-0">This package has no screens, so there are no screen verdicts.</p>
    <p v-else-if="grid.rows.length === 0" class="rq-small rq-muted mb-0">No reviewers yet.</p>
    <div v-else class="rq-vgrid-scroll" role="region" aria-labelledby="rq-verdicts-heading" tabindex="0">
      <table class="rq-vgrid">
        <caption class="visually-hidden">Verdicts by reviewer and screen. Choose a screen to see its Odin summary, or a verdict to see its notes.</caption>
        <thead>
          <tr>
            <th class="rq-vgrid__corner" scope="col"><span class="visually-hidden">Reviewer</span></th>
            <th v-for="column in grid.columns" :key="column.screenId" scope="col">
              <button
                class="rq-vhead"
                :class="{ 'rq-vhead--on': column.screenId === selectedScreenId }"
                type="button"
                :aria-pressed="column.screenId === selectedScreenId ? 'true' : 'false'"
                @click="emit('select-screen', column.screenId)"
              >
                <span>{{ column.title }}</span>
                <small>{{ column.marksText }}</small>
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in grid.rows" :key="row.actorRef">
            <th scope="row">
              <span class="rq-vgrid__who">
                <RequirementsAvatar :person="row.person" />
                <span class="rq-vgrid__who-name">{{ row.name }}</span>
                <span v-if="row.required" class="rq-chip rq-chip--outline rq-vgrid__req"><span aria-hidden="true">req.</span><span class="visually-hidden">required reviewer</span></span>
                <span v-if="row.removed" class="rq-vgrid__removed">removed</span>
              </span>
            </th>
            <td
              v-for="(cell, index) in row.cells"
              :key="cell.screenId"
              :class="{ 'rq-vgrid__col--on': grid.columns[index].screenId === selectedScreenId }"
            >
              <button
                class="rq-vcell"
                :class="[cell.className, { 'rq-vcell--on': isSelected(row, cell) }]"
                type="button"
                :aria-label="`${row.name}, ${grid.columns[index].title}: ${cell.label}`"
                :aria-pressed="isSelected(row, cell) ? 'true' : 'false'"
                @click="emit('select-cell', { actorRef: row.actorRef, screenId: cell.screenId })"
              >{{ cell.short }}</button>
            </td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" class="rq-xs rq-muted">Reviewed</th>
            <td v-for="column in grid.columns" :key="column.screenId" class="rq-vgrid__tally">
              <span aria-hidden="true">{{ column.tally.reviewed }} of {{ reviewerCount }}</span>
              <span class="visually-hidden">{{ column.title }}: {{ column.tallyText }}</span>
            </td>
          </tr>
        </tfoot>
      </table>
    </div>

    <div v-if="detail" class="rq-verdict-detail" role="status">
      <p class="mb-0">
        <strong>{{ detail.name }}</strong> on <strong>{{ detail.screen }}</strong>:
        <template v-if="detail.notReviewed">not reviewed yet.</template>
        <template v-else>{{ detail.label }}.</template>
      </p>
      <dl v-if="detail.dimensions.length || detail.notes.length">
        <template v-for="dimension in detail.dimensions" :key="dimension.key">
          <dt>{{ dimension.label }}</dt>
          <dd>{{ dimension.value }}</dd>
        </template>
        <template v-for="note in detail.notes" :key="note.label">
          <dt>{{ note.label }}</dt>
          <dd>{{ note.text }}</dd>
        </template>
      </dl>
    </div>
  </div>
</template>
