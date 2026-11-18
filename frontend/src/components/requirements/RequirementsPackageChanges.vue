<script setup>
import { computed } from 'vue';

import { describePackageChanges } from '../../lib/requirements/requirements-packages.js';
import { chipToneClass } from '../../lib/requirements/requirements-topics.js';

// "What changed since round N": every screen compared with the
// previous version by id and content hash, changed screens first.
const props = defineProps({
  changes: { default: null, type: Object },
  // { [screenId]: entry URL } for thumbnails of image screens.
  imageUrls: { default: () => ({}), type: Object },
});

const emit = defineEmits(['select']);

const described = computed(() => describePackageChanges(props.changes));
</script>

<template>
  <section class="rq-panel rq-stack rq-stack--sm" aria-labelledby="rq-pkg-changes-heading">
    <h3 id="rq-pkg-changes-heading" class="rq-eyebrow">{{ described.heading }}</h3>
    <p class="rq-xs rq-muted mb-0">{{ described.summary }}</p>
    <ul v-if="described.rows.length" class="rq-diff">
      <li v-for="row in described.rows" :key="`${row.change}-${row.screenId}`" class="rq-diff__row">
        <span class="rq-diff__thumb" :class="`rq-diff__thumb--${row.change}`" aria-hidden="true">
          <img v-if="row.change !== 'removed' && imageUrls[row.screenId]" :src="imageUrls[row.screenId]" alt="" referrerpolicy="no-referrer" />
          <i v-else-if="row.change === 'new'" class="bi bi-plus-lg"></i>
          <i v-else-if="row.change === 'removed'" class="bi bi-dash-lg"></i>
          <i v-else class="bi bi-window"></i>
        </span>
        <span class="rq-diff__text">
          <button
            v-if="row.change !== 'removed'"
            class="rq-link-button rq-diff__title"
            type="button"
            @click="emit('select', row.screenId)"
          >{{ row.title }}</button>
          <strong v-else class="rq-diff__title">{{ row.title }}</strong>
          <span class="rq-xs rq-muted d-block">{{ row.detail }}</span>
        </span>
        <span class="rq-chip" :class="chipToneClass(row.chip.tone)">{{ row.chip.label }}</span>
      </li>
    </ul>
  </section>
</template>
