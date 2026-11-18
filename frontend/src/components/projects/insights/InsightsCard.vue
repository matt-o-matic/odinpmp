<script setup>
import { computed, ref } from 'vue';
import { RouterLink } from 'vue-router';

import { formatDay } from '../../../lib/insights/insights-format.js';

// The frame every Insights card shares: title, help, table toggle, its own state (loading,
// refreshing, thin history, empty, error) and, in edit mode, move and remove controls.

const props = defineProps({
  action: { default: null, type: Object },
  actionTo: { default: null, type: [Object, String] },
  availableOn: { default: null, type: String },
  bare: { default: false, type: Boolean },
  canMoveDown: { default: false, type: Boolean },
  canMoveUp: { default: false, type: Boolean },
  cardId: { required: true, type: String },
  editing: { default: false, type: Boolean },
  eyebrow: { default: '', type: String },
  help: { default: '', type: String },
  message: { default: '', type: String },
  notes: { default: () => [], type: Array },
  refreshing: { default: false, type: Boolean },
  size: { default: 'half', type: String },
  status: { default: 'loading', type: String },
  subtitle: { default: '', type: String },
  tableAvailable: { default: true, type: Boolean },
  title: { required: true, type: String },
});

const emit = defineEmits(['move-down', 'move-up', 'remove', 'retry']);

const helpOpen = ref(false);
const showTable = ref(false);
const titleId = computed(() => `${props.cardId}-title`);
const helpId = computed(() => `${props.cardId}-help`);
const hasData = computed(() => props.status === 'ready' || props.status === 'thin');
const titleHidden = computed(() => props.bare && !props.editing);
</script>

<template>
  <article
    :id="cardId"
    class="insights-card"
    :class="[`insights-card--${size}`, { 'insights-card--bare': bare && !editing, 'insights-card--editing': editing, 'insights-card--refreshing': refreshing }]"
    :aria-labelledby="titleId"
    :aria-busy="refreshing || status === 'loading' ? 'true' : 'false'"
  >
    <header class="insights-card__head" :class="{ 'visually-hidden': titleHidden }">
      <div class="insights-card__heading">
        <p v-if="eyebrow" class="insights-card__eyebrow">{{ eyebrow }}</p>
        <h3 :id="titleId" class="insights-card__title">{{ title }}</h3>
        <p v-if="subtitle" class="insights-card__subtitle">{{ subtitle }}</p>
      </div>
      <div class="insights-card__tools">
        <template v-if="editing">
          <button class="insights-icon-button" type="button" :disabled="!canMoveUp" :aria-label="`Move ${title} earlier`" @click="emit('move-up')">
            <i class="bi bi-arrow-up" aria-hidden="true"></i>
          </button>
          <button class="insights-icon-button" type="button" :disabled="!canMoveDown" :aria-label="`Move ${title} later`" @click="emit('move-down')">
            <i class="bi bi-arrow-down" aria-hidden="true"></i>
          </button>
          <button class="insights-icon-button insights-icon-button--danger" type="button" :aria-label="`Remove ${title}`" @click="emit('remove')">
            <i class="bi bi-x-lg" aria-hidden="true"></i>
          </button>
        </template>
        <template v-else-if="!bare">
          <button
            v-if="help"
            class="insights-icon-button"
            type="button"
            :aria-controls="helpId"
            :aria-expanded="helpOpen ? 'true' : 'false'"
            :aria-label="`How ${title} is calculated`"
            @click="helpOpen = !helpOpen"
          >
            <i class="bi bi-info-circle" aria-hidden="true"></i>
          </button>
          <button
            v-if="tableAvailable && hasData"
            class="insights-icon-button"
            type="button"
            :aria-label="`Show ${title} as a table`"
            :aria-pressed="showTable ? 'true' : 'false'"
            @click="showTable = !showTable"
          >
            <i class="bi bi-table" aria-hidden="true"></i>
          </button>
        </template>
      </div>
    </header>
    <p v-if="helpOpen && !editing" :id="helpId" class="insights-card__help">{{ help }}</p>

    <div class="insights-card__body">
      <div v-if="status === 'loading'" class="insights-card__placeholder" role="status">
        <span class="visually-hidden">Loading {{ title }}</span>
      </div>
      <div v-else-if="status === 'error'" class="insights-card__error" role="alert">
        <i class="bi bi-exclamation-octagon-fill" aria-hidden="true"></i>
        <span>{{ message || `${title} could not be loaded. Other cards are unaffected.` }}</span>
        <button class="btn btn-sm btn-outline-secondary" type="button" @click="emit('retry')">Retry</button>
      </div>
      <div v-else-if="status === 'empty'" class="insights-card__empty">
        <i class="bi bi-inbox" aria-hidden="true"></i>
        <p>{{ message }}</p>
        <RouterLink v-if="actionTo && action" class="btn btn-sm btn-outline-secondary" :to="actionTo">{{ action.label }}</RouterLink>
      </div>
      <template v-else>
        <slot :show-table="showTable" />
        <p v-if="status === 'thin'" class="insights-card__note insights-card__note--thin">
          <i class="bi bi-hourglass-split" aria-hidden="true"></i>
          <span>{{ message }}<template v-if="availableOn"> Check back on {{ formatDay(availableOn) }}.</template></span>
        </p>
        <p v-for="note in notes" :key="note" class="insights-card__note">
          <i class="bi bi-info-circle" aria-hidden="true"></i>
          <span>{{ note }}</span>
        </p>
      </template>
    </div>

    <p v-if="refreshing" class="insights-card__refreshing" role="status">
      <span class="spinner-border spinner-border-sm" aria-hidden="true"></span>
      Refreshing…
    </p>
    <footer v-if="$slots.footer && hasData" class="insights-card__foot">
      <slot name="footer" />
    </footer>
  </article>
</template>
