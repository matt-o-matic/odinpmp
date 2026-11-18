<script setup>
import { computed, reactive, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';

import './insights.css';
import InsightsAddCardDialog from './InsightsAddCardDialog.vue';
import InsightsBuiltInCard from './InsightsBuiltInCard.vue';
import InsightsHealthBanner from './InsightsHealthBanner.vue';
import InsightsReportCard from './InsightsReportCard.vue';
import { apiClient, authSession } from '../../../lib/auth/index.js';
import {
  DEFAULT_INSIGHTS_CARDS,
  INSIGHTS_CARDS,
  REPORT_CARD_TYPE,
  addCard,
  addableCards,
  cardKey,
  cloneCards,
  isDefaultLayout,
  moveCard,
  removeCard,
  sameCards,
} from '../../../lib/insights/insights-layout.js';
import { formatDateTime, reportsLocation } from '../../../lib/insights/insights-format.js';

// Project Insights: one dashboard per project. Read-only by default; project admins and
// managers switch to edit mode to add, remove and reorder cards for everyone on the project.

const props = defineProps({
  projectId: { required: true, type: String },
  projectName: { default: '', type: String },
  refreshVersion: { default: 0, type: Number },
});

const DAY_OPTIONS = [
  { label: 'Last 30 days', value: 30 },
  { label: 'Last 90 days', value: 90 },
  { label: 'Last 180 days', value: 180 },
];
const FORBIDDEN_COST_NOTE = 'Cost and earned value are visible to managers and admins.';

const filters = reactive({ days: 90, sprintId: '', unit: 'points' });
const payload = ref(null);
const loading = ref(false);
const loadError = ref('');
const editing = ref(false);
const draft = ref([]);
const saving = ref(false);
const editError = ref('');
const addOpen = ref(false);
const announcement = ref('');
let sequence = 0;

const token = computed(() => authSession.state.token);
const layoutCards = computed(() => payload.value?.layout?.cards ?? cloneCards(DEFAULT_INSIGHTS_CARDS));
const visibleCards = computed(() => (editing.value ? draft.value : layoutCards.value));
const viewer = computed(() => payload.value?.viewer ?? { canEditLayout: false, canSeeFinance: false });
const refreshing = computed(() => loading.value && Boolean(payload.value));
const firstLoad = computed(() => loading.value && !payload.value);
const addable = computed(() => addableCards(draft.value, { canSeeFinance: viewer.value.canSeeFinance, reports: payload.value?.reports ?? [] }));
const sprintOptions = computed(() => payload.value?.sprints ?? []);
const health = computed(() => (payload.value?.health?.headline ? payload.value.health : null));

async function load() {
  if (!props.projectId || !token.value) return;
  const current = ++sequence;
  loading.value = true;
  loadError.value = '';
  try {
    const response = await apiClient.passive.getProjectInsights(props.projectId, { days: filters.days, sprintId: filters.sprintId, unit: filters.unit }, token.value);
    if (current === sequence) payload.value = response;
  } catch (error) {
    if (current === sequence) loadError.value = error.message ?? 'Unable to load Insights.';
  } finally {
    if (current === sequence) loading.value = false;
  }
}

watch(() => [props.projectId, props.refreshVersion], load, { immediate: true });
watch(() => [filters.days, filters.sprintId, filters.unit], load);
watch(() => props.projectId, () => {
  editing.value = false;
  payload.value = null;
});

function startEditing() {
  draft.value = cloneCards(layoutCards.value);
  editError.value = '';
  editing.value = true;
}

function cancelEditing() {
  editing.value = false;
  editError.value = '';
}

function resetDraft() {
  draft.value = cloneCards(DEFAULT_INSIGHTS_CARDS);
  announcement.value = 'Default cards restored. Save the layout to keep them.';
}

function move(index, offset) {
  draft.value = moveCard(draft.value, index, offset);
}

function remove(index, title) {
  draft.value = removeCard(draft.value, index);
  announcement.value = `${title} removed. Save the layout to keep the change.`;
}

function add(card) {
  draft.value = addCard(draft.value, card);
  addOpen.value = false;
  announcement.value = 'Card added at the end of the dashboard. Save the layout to keep it.';
}

async function saveLayout() {
  const layout = payload.value?.layout;
  if (!layout) return;
  if (sameCards(draft.value, layout.cards) && !(isDefaultLayout(draft.value) && !layout.isDefault)) {
    editing.value = false;
    return;
  }
  saving.value = true;
  editError.value = '';
  try {
    const response = isDefaultLayout(draft.value) && layout.version > 0
      ? await apiClient.resetProjectInsightsLayout(props.projectId, layout.version, token.value)
      : await apiClient.saveProjectInsightsLayout(props.projectId, { cards: draft.value, expectedVersion: layout.version }, token.value);
    payload.value = { ...payload.value, layout: response.layout };
    editing.value = false;
    announcement.value = 'Dashboard layout saved for everyone on this project.';
  } catch (error) {
    editError.value = error.status === 409
      ? 'Someone else changed this dashboard while you were editing. Cancel, then customize again to start from their version.'
      : error.message ?? 'Unable to save the layout.';
  } finally {
    saving.value = false;
  }
}

function builtInPayload(card) {
  const value = payload.value?.cards?.[card.type] ?? null;
  if (editing.value && value?.status === 'forbidden') return { data: null, message: FORBIDDEN_COST_NOTE, status: 'empty' };
  return value;
}

function isForbidden(card) {
  return !editing.value && payload.value?.cards?.[card.type]?.status === 'forbidden';
}

function cardTitle(card) {
  if (card.type === REPORT_CARD_TYPE) return payload.value?.reports?.find((report) => report.id === card.reportId)?.name ?? 'Saved report';
  return INSIGHTS_CARDS[card.type]?.title ?? card.type;
}
</script>

<template>
  <section class="insights" aria-labelledby="insights-title">
    <header class="insights-head">
      <div>
        <h2 id="insights-title" class="insights-head__title">Insights</h2>
        <p class="insights-head__lead">Delivery, flow, quality and schedule{{ projectName ? ` for ${projectName}` : '' }}.</p>
      </div>
      <div class="insights-head__actions">
        <span v-if="payload?.asOf" class="insights-head__asof">As of {{ formatDateTime(payload.asOf) }}</span>
        <button class="btn btn-sm btn-outline-secondary" type="button" :disabled="loading" @click="load">
          <i class="bi bi-arrow-clockwise" aria-hidden="true"></i> Refresh
        </button>
        <RouterLink class="btn btn-sm btn-outline-secondary" :to="reportsLocation(projectId)">
          <i class="bi bi-box-arrow-up-right" aria-hidden="true"></i> Open in Reports
        </RouterLink>
        <button v-if="viewer.canEditLayout && !editing" class="btn btn-sm btn-outline-primary" type="button" :disabled="!payload" @click="startEditing">
          <i class="bi bi-grid-1x2" aria-hidden="true"></i> Customize
        </button>
      </div>
    </header>

    <div class="insights-filters" role="group" aria-label="Insights filters">
      <label class="insights-field">
        <span>Date range</span>
        <select v-model.number="filters.days" class="form-select form-select-sm">
          <option v-for="option in DAY_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
      </label>
      <label class="insights-field">
        <span>Sprint</span>
        <select v-model="filters.sprintId" class="form-select form-select-sm">
          <option value="">Active sprint</option>
          <option v-for="sprint in sprintOptions" :key="sprint.id" :value="sprint.id">{{ sprint.name }} · {{ sprint.status }}</option>
        </select>
      </label>
      <fieldset class="insights-unit">
        <legend class="insights-unit__legend">Count by</legend>
        <div class="insights-unit__options">
          <template v-for="unit in ['points', 'items']" :key="unit">
            <input :id="`insights-unit-${unit}`" v-model="filters.unit" class="btn-check" type="radio" name="insights-unit" :value="unit" />
            <label class="btn btn-sm btn-outline-primary" :for="`insights-unit-${unit}`">{{ unit === 'points' ? 'Points' : 'Items' }}</label>
          </template>
        </div>
      </fieldset>
      <p class="insights-filters__hint"><i class="bi bi-funnel" aria-hidden="true"></i> Applies to every chart on this page</p>
    </div>

    <section v-if="editing" class="insights-editbar" aria-labelledby="insights-editbar-title">
      <div>
        <h3 id="insights-editbar-title" class="insights-editbar__title">Customizing this dashboard</h3>
        <p class="insights-editbar__lead">Changes apply for everyone on the project. Move, remove or add cards, then save.</p>
        <p v-if="editError" class="insights-editbar__error" role="alert">{{ editError }}</p>
      </div>
      <div class="insights-editbar__actions">
        <button class="btn btn-sm btn-outline-secondary" type="button" @click="addOpen = true"><i class="bi bi-plus-lg" aria-hidden="true"></i> Add card</button>
        <button class="btn btn-sm btn-outline-secondary" type="button" @click="resetDraft">Reset to default</button>
        <button class="btn btn-sm btn-outline-secondary" type="button" :disabled="saving" @click="cancelEditing">Cancel</button>
        <button class="btn btn-sm btn-primary" type="button" :disabled="saving" @click="saveLayout">{{ saving ? 'Saving…' : 'Save layout' }}</button>
      </div>
    </section>

    <div v-if="loadError && !payload" class="insights-alert" role="alert">
      <i class="bi bi-exclamation-octagon-fill" aria-hidden="true"></i>
      <span>{{ loadError }}</span>
      <button class="btn btn-sm btn-outline-secondary" type="button" @click="load">Retry</button>
    </div>
    <div v-else-if="loadError" class="insights-alert insights-alert--soft" role="status">
      <i class="bi bi-exclamation-circle" aria-hidden="true"></i>
      <span>Refresh failed: {{ loadError }} Showing the results from {{ formatDateTime(payload.asOf) }}.</span>
    </div>

    <InsightsHealthBanner v-if="health" :health="health" :project-id="projectId" />

    <p v-if="visibleCards.length === 0" class="insights-empty-layout">
      No cards on this dashboard.<template v-if="viewer.canEditLayout && !editing"> Choose Customize to add some.</template>
    </p>

    <div v-if="!(loadError && !payload)" class="insights-grid" :class="{ 'insights-grid--first-load': firstLoad }">
      <template v-for="(card, index) in visibleCards" :key="cardKey(card)">
        <InsightsReportCard
          v-if="card.type === REPORT_CARD_TYPE"
          :can-move-down="index < visibleCards.length - 1"
          :can-move-up="index > 0"
          :editing="editing"
          :project-id="projectId"
          :refresh-version="refreshVersion"
          :report-id="card.reportId"
          :token="token"
          @move-down="move(index, 1)"
          @move-up="move(index, -1)"
          @remove="remove(index, cardTitle(card))"
        />
        <p v-else-if="isForbidden(card)" class="insights-note-row">
          <i class="bi bi-shield-lock" aria-hidden="true"></i> {{ FORBIDDEN_COST_NOTE }}
        </p>
        <InsightsBuiltInCard
          v-else
          :can-move-down="index < visibleCards.length - 1"
          :can-move-up="index > 0"
          :card="builtInPayload(card)"
          :editing="editing"
          :loading="firstLoad"
          :project-id="projectId"
          :refreshing="refreshing"
          :type="card.type"
          :unit="payload?.filters?.unit ?? filters.unit"
          @move-down="move(index, 1)"
          @move-up="move(index, -1)"
          @remove="remove(index, cardTitle(card))"
          @retry="load"
        />
      </template>
    </div>

    <p class="visually-hidden" aria-live="polite">{{ announcement }}</p>
    <InsightsAddCardDialog :addable="addable" :open="addOpen" @add="add" @close="addOpen = false" />
  </section>
</template>
