<script setup>
import { computed } from 'vue';

import './rounds.css';

// Direction preference under the verdict grid: a bar of who preferred which direction, then
// the full tallies as a table and any remix requests. Reviewers who gave no stance are "Not
// answered" and never count toward a direction.
const props = defineProps({
  // From buildDirectionPreference(results).
  preference: { required: true, type: Object },
});

const rowIndex = computed(() => new Map(props.preference.rows.map((row, index) => [`direction:${row.directionId}`, index])));
const remix = computed(() => props.preference.rows.filter((row) => row.remixNotes.length > 0));

function remixText(row) {
  return row.remixNotes.map((note) => `“${note.remix}” (${note.name})`).join('; ');
}

function segmentClass(segment) {
  if (segment.kind === 'direction') return `rq-dirbar__seg--d${(rowIndex.value.get(segment.key) ?? 0) % 4}`;
  return `rq-dirbar__seg--${segment.kind}`;
}
</script>

<template>
  <section class="rq-stack rq-stack--sm" aria-labelledby="rq-directions-heading">
    <div class="rq-row rq-row--between rq-row--wrap">
      <h3 id="rq-directions-heading" class="rq-eyebrow">Direction preference</h3>
      <span class="rq-xs rq-muted">{{ preference.answeredText }}</span>
    </div>
    <div v-if="preference.segments.length" class="rq-dirbar" aria-hidden="true">
      <span
        v-for="segment in preference.segments"
        :key="segment.key"
        class="rq-dirbar__seg"
        :class="segmentClass(segment)"
        :style="{ flex: `${segment.count} 1 0` }"
      >{{ segment.label }}</span>
    </div>
    <table class="rq-dirtable">
      <caption class="visually-hidden">Direction stances by count</caption>
      <thead>
        <tr>
          <th scope="col">Direction</th>
          <th scope="col" class="rq-num">Preferred</th>
          <th scope="col" class="rq-num">Acceptable</th>
          <th scope="col" class="rq-num">Rejected</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in preference.rows" :key="row.directionId">
          <th scope="row">{{ row.letter }} · {{ row.title }}</th>
          <td class="rq-num">{{ row.tallies.preferred }}</td>
          <td class="rq-num">{{ row.tallies.acceptable }}</td>
          <td class="rq-num">{{ row.tallies.rejected }}</td>
        </tr>
      </tbody>
    </table>
    <p v-if="preference.notAnswered || preference.noPreference" class="rq-xs rq-muted mb-0">
      <template v-if="preference.noPreference">{{ preference.noPreference }} answered without preferring a direction. </template>
      <template v-if="preference.notAnswered">{{ preference.notAnswered }} not answered yet; they count toward no direction.</template>
    </p>
    <div v-if="remix.length" class="rq-stack rq-stack--sm">
      <p class="rq-xs rq-muted mb-0"><strong>Remix requests</strong></p>
      <ul class="rq-answers">
        <li v-for="row in remix" :key="row.directionId">
          <span class="rq-muted">{{ row.letter }} · {{ row.title }}:</span> {{ remixText(row) }}
        </li>
      </ul>
    </div>
  </section>
</template>
