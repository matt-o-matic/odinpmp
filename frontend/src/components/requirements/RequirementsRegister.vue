<script setup>
import { computed, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import RequirementsAvatar from './RequirementsAvatar.vue';
import RequirementsBulkDialog from './RequirementsBulkDialog.vue';
import RequirementsSignals from './RequirementsSignals.vue';
import RequirementsTopicFormDialog from './RequirementsTopicFormDialog.vue';
import {
  REGISTER_FILTERS,
  chipToneClass,
  evidenceLine,
  filterRegisterRows,
  outcomeLabel,
  peopleOptions,
  registerFilterCounts,
  rowSignals,
  topicPeople,
  topicSettled,
  topicStateChip,
} from '../../lib/requirements/requirements-topics.js';
import { copyText } from '../../lib/clipboard.js';
import { proposedAnswerStatusChip, summaryCardDigest } from '../../lib/requirements/requirements-sources.js';
import { briefCitation, briefLineNumber, trackLabel } from '../../lib/requirements/requirements-tracks.js';
import { commentPlainText } from '../../lib/rich-content/comment-markdown.js';

// The track's question register: one card per topic with its Odin summary, each opening the
// topic page. Search and filters apply directly; Add topic opens its own dialog. Selected
// topics can be changed together (assign, agree, defer, dismiss, reopen, delete).
const props = defineProps({
  abilities: { required: true, type: Object },
  briefLines: { default: () => [], type: Array },
  drafting: { default: false, type: Boolean },
  error: { default: '', type: String },
  highlightIds: { default: () => [], type: Array },
  loaded: { default: false, type: Boolean },
  projectId: { required: true, type: String },
  rows: { default: () => [], type: Array },
  // People a topic can be assigned to, for the Add topic dialog's People tab.
  stakeholders: { default: () => [], type: Array },
  track: { required: true, type: String },
  users: { default: () => [], type: Array },
});

const emit = defineEmits(['bulk-done', 'created', 'draft', 'reload']);

const route = useRoute();
const router = useRouter();
const view = ref('all');
const query = ref('');
const addOpen = ref(false);
const copyState = ref({ id: '', ok: false });
let copyTimer = null;

const sourceRef = computed(() => String(route.query.line ?? ''));
const counts = computed(() => registerFilterCounts(props.rows));
const visibleRows = computed(() => filterRegisterRows(props.rows, { q: query.value, sourceRef: sourceRef.value, view: view.value }));
const highlighted = computed(() => new Set(props.highlightIds));

// --- selection and bulk actions ---------------------------------------------------
const selected = ref([]);
const bulkAction = ref('');
const selectedSet = computed(() => new Set(selected.value));
const selectedRows = computed(() => props.rows.filter((row) => selectedSet.value.has(row.id)));
const visibleSelected = computed(() => visibleRows.value.filter((row) => selectedSet.value.has(row.id)).length);
const peopleChoices = computed(() => peopleOptions({ stakeholders: props.stakeholders, users: props.users }));
const bulkActions = computed(() => [
  { icon: 'bi-person-plus', id: 'assign', label: 'Assign', show: props.abilities.assign },
  { icon: 'bi-check2-circle', id: 'agree', label: 'Agree', show: props.abilities.recordDecisions },
  { icon: 'bi-hourglass', id: 'defer', label: 'Defer', show: props.abilities.recordDecisions },
  { icon: 'bi-archive', id: 'dismiss', label: 'Dismiss', show: props.abilities.changeStatus && view.value !== 'dismissed' },
  { icon: 'bi-arrow-counterclockwise', id: 'reopen', label: 'Reopen', show: props.abilities.changeStatus && view.value === 'dismissed' },
  { icon: 'bi-trash', id: 'delete', label: 'Delete', show: props.abilities.deleteTopics },
].filter((action) => action.show));
const canSelect = computed(() => bulkActions.value.length > 0);

// Topics that left the list (deleted, moved) drop out of the selection.
watch(
  () => props.rows,
  (rows) => {
    const ids = new Set(rows.map((row) => row.id));
    if (selected.value.some((id) => !ids.has(id))) selected.value = selected.value.filter((id) => ids.has(id));
  },
);

function toggleSelected(id, checked) {
  selected.value = checked ? [...new Set([...selected.value, id])] : selected.value.filter((entry) => entry !== id);
}

function toggleAllVisible(checked) {
  const visible = visibleRows.value.map((row) => row.id);
  selected.value = checked
    ? [...new Set([...selected.value, ...visible])]
    : selected.value.filter((id) => !visible.includes(id));
}

// Done topics leave the selection; skipped and failed ones stay selected to act on again.
function handleBulkDone(result) {
  bulkAction.value = '';
  const done = new Set((result.results ?? []).filter((entry) => entry.status === 'done').map((entry) => entry.topicId));
  selected.value = selected.value.filter((id) => !done.has(id));
  emit('bulk-done', result);
}

const MAX_OTHERS = 4;

/** Who a card's badges stand for, read out and shown on hover, since the badges carry initials only. */
function peopleLabel({ others, owner }) {
  const parts = [owner ? `Owner: ${owner.name}` : 'No owner'];
  const required = others.filter((person) => person.role === 'required');
  const involved = others.filter((person) => person.role !== 'required');
  if (required.length) parts.push(`Required: ${required.map((person) => person.name).join(', ')}`);
  if (involved.length) parts.push(`Also involved: ${involved.map((person) => person.name).join(', ')}`);
  return parts.join('. ');
}

const cards = computed(() => visibleRows.value.map((row) => {
  const chip = topicStateChip(row);
  const people = topicPeople(row);
  const signals = rowSignals(row);
  const digest = summaryCardDigest(row.summary, { settled: topicSettled(row) });
  return {
    answerChip: proposedAnswerStatusChip(digest.proposedAnswerStatus, { blocking: signals.blocking }),
    chipClass: chipToneClass(chip.tone),
    chipLabel: chip.label,
    citation: briefCitation(row.sourceRef, props.briefLines),
    digest,
    evidence: evidenceLine(row.evidence),
    lineNumber: briefLineNumber(row.sourceRef, props.briefLines),
    others: people.others.slice(0, MAX_OTHERS),
    othersMore: Math.max(0, people.others.length - MAX_OTHERS),
    owner: people.owner,
    peopleLabel: peopleLabel(people),
    row,
    signals,
  };
}));

// New topics (added or drafted) are highlighted; show them even under another filter.
watch(
  () => props.highlightIds,
  (ids) => {
    if (ids.length > 0) view.value = 'all';
  },
);

function topicLocation(row) {
  return { name: 'project-requirements-topic', params: { projectId: props.projectId, topicId: row.id } };
}

// The card's title is a stretched link, so its text can't be selected; this copies it instead.
// The result shows on the button for a moment: a check when copied, a warning when not.
async function copyPrompt(row) {
  const copied = await copyText(row.prompt);
  copyState.value = { id: row.id, ok: copied };
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => {
    copyState.value = { id: '', ok: false };
  }, 2000);
}

function copyIcon(id) {
  if (copyState.value.id !== id) return 'bi-copy';
  return copyState.value.ok ? 'bi-check2' : 'bi-exclamation-triangle';
}

function copyLabel(id) {
  if (copyState.value.id !== id) return 'Copy question';
  return copyState.value.ok ? 'Question copied' : 'Copying failed';
}

function clearLine() {
  const nextQuery = { ...route.query };
  delete nextQuery.line;
  router.replace({ query: nextQuery });
}

function handleSaved(topic) {
  addOpen.value = false;
  emit('created', topic);
}
</script>

<template>
  <div class="rq-stack">
    <div class="rq-regbar">
      <fieldset class="rq-seg">
        <legend class="visually-hidden">Show topics</legend>
        <label v-for="filter in REGISTER_FILTERS" :key="filter.id" class="rq-seg__option">
          <input v-model="view" type="radio" name="rq-register-view" :value="filter.id" />
          <span>{{ filter.label }}<template v-if="filter.id !== 'all'"> · {{ counts[filter.id] }}</template></span>
        </label>
      </fieldset>
      <label class="visually-hidden" :for="`rq-register-search-${track}`">Filter topics</label>
      <input
        :id="`rq-register-search-${track}`"
        v-model="query"
        class="form-control form-control-sm"
        placeholder="Filter topics…"
        type="search"
      />
      <span v-if="sourceRef" class="rq-chip rq-chip--neutral">
        Citing {{ briefCitation(sourceRef, briefLines) || 'a brief line' }}
        <button class="rq-text-action" type="button" aria-label="Show topics from every brief line" @click="clearLine">
          <i class="bi bi-x-lg" aria-hidden="true"></i>
        </button>
      </span>
      <span class="rq-grow"></span>
      <button v-if="abilities.addTopics" class="ghost-button ghost-button--compact" type="button" @click="addOpen = true">
        <i class="bi bi-plus-lg" aria-hidden="true"></i>
        Add topic
      </button>
      <button
        v-if="abilities.draftQuestions"
        class="ghost-button ghost-button--compact"
        type="button"
        :disabled="drafting"
        @click="emit('draft')"
      >
        <i class="bi bi-journal-text" aria-hidden="true"></i>
        {{ drafting ? 'Drafting questions…' : 'Draft questions from brief' }}
      </button>
    </div>

    <div v-if="canSelect && cards.length > 0" class="rq-bulkbar" :class="{ 'rq-bulkbar--active': selected.length }" role="toolbar" aria-label="Selected topics">
      <label class="rq-bulkbar__all">
        <input
          class="form-check-input mt-0"
          type="checkbox"
          :checked="visibleSelected > 0 && visibleSelected === visibleRows.length"
          :indeterminate.prop="visibleSelected > 0 && visibleSelected < visibleRows.length"
          @change="toggleAllVisible($event.target.checked)"
        />
        <span>{{ selected.length ? `${selected.length} selected` : 'Select all shown' }}</span>
      </label>
      <template v-if="selected.length">
        <button v-for="action in bulkActions" :key="action.id" class="ghost-button ghost-button--compact" type="button" @click="bulkAction = action.id">
          <i class="bi" :class="action.icon" aria-hidden="true"></i>{{ action.label }}…
        </button>
        <button class="rq-text-action" type="button" @click="selected = []">Clear selection</button>
      </template>
    </div>

    <div v-if="error" class="error-banner rq-row rq-row--between" role="alert">
      <span>{{ error }}</span>
      <button class="ghost-button ghost-button--compact" type="button" @click="emit('reload')">Try again</button>
    </div>

    <p v-if="!loaded && !error" class="rq-muted rq-small mb-0">Loading topics…</p>
    <p v-else-if="loaded && cards.length === 0" class="rq-muted rq-small mb-0">
      <template v-if="rows.length === 0">
        No topics yet.
        <template v-if="abilities.draftQuestions">Draft questions from the brief, or add a topic.</template>
      </template>
      <template v-else>No topics match this filter.</template>
    </p>

    <ol v-if="cards.length > 0" class="rq-topic-cards" :aria-label="`${trackLabel(track)} topics`">
      <li
        v-for="card in cards"
        :key="card.row.id"
        class="rq-topic-card"
        :class="{ 'rq-row--new': highlighted.has(card.row.id), 'rq-topic-card--selected': selectedSet.has(card.row.id) }"
      >
        <div class="rq-topic-card__head">
          <input
            v-if="canSelect"
            class="form-check-input mt-0 rq-topic-card__select"
            type="checkbox"
            :aria-label="`Select: ${card.row.prompt}`"
            :checked="selectedSet.has(card.row.id)"
            @change="toggleSelected(card.row.id, $event.target.checked)"
          />
          <span class="rq-chip" :class="card.chipClass">{{ card.chipLabel }}</span>
          <RequirementsSignals :signals="card.signals" />
          <span class="rq-grow"></span>
          <span v-if="card.evidence" class="rq-xs rq-muted">{{ card.evidence }}</span>
          <span
            v-if="card.owner || card.others.length"
            class="rq-topic-card__people"
            role="img"
            :aria-label="card.peopleLabel"
            :title="card.peopleLabel"
          >
            <RequirementsAvatar v-if="card.owner" class="rq-avatar--owner" :person="card.owner" />
            <span v-if="card.others.length" class="rq-avatars">
              <RequirementsAvatar v-for="person in card.others" :key="person.ref" :person="person" />
              <span v-if="card.othersMore" class="rq-avatar rq-avatar--sm rq-avatar--more" aria-hidden="true">+{{ card.othersMore }}</span>
            </span>
          </span>
          <span v-else class="rq-xs rq-muted">Unassigned</span>
        </div>

        <div class="rq-topic-card__titlerow">
          <h3 class="rq-topic-card__title">
            <RouterLink class="rq-topic-card__link" :to="topicLocation(card.row)">{{ card.row.prompt }}</RouterLink>
          </h3>
          <button
            class="ghost-button ghost-button--compact ghost-button--icon rq-topic-card__copy"
            type="button"
            :aria-label="copyLabel(card.row.id)"
            :title="copyLabel(card.row.id)"
            @click="copyPrompt(card.row)"
          >
            <i class="bi" :class="copyIcon(card.row.id)" aria-hidden="true"></i>
          </button>
        </div>
        <div v-if="card.citation" class="rq-register__cite">
          <span v-if="card.lineNumber" class="rq-cite" aria-hidden="true">{{ card.lineNumber }}</span>
          {{ card.citation }}
        </div>

        <div class="rq-topic-card__summary">
          <template v-if="card.row.decision">
            <p class="rq-topic-card__lead mb-0">
              <span class="rq-eyebrow">{{ outcomeLabel(card.row.decision.outcome) }}</span>
              {{ commentPlainText(card.row.decision.statement) }}
            </p>
          </template>
          <p v-else-if="card.digest.kind === 'none'" class="rq-xs rq-muted mb-0">No Odin summary yet. It appears once people start contributing.</p>
          <p v-else-if="card.digest.kind === 'thin'" class="rq-xs rq-muted mb-0">Odin needs input from two or more people to summarize this.</p>
          <p v-else-if="card.digest.kind === 'empty'" class="rq-xs rq-muted mb-0">Odin has nothing to report yet.</p>
          <template v-else>
            <p v-if="card.digest.proposedAnswer" class="rq-topic-card__lead mb-0">
              <span class="rq-eyebrow">Odin summary</span>
              {{ card.digest.proposedAnswer }}
              <span v-if="card.answerChip" class="rq-chip rq-chip--wrap" :class="chipToneClass(card.answerChip.tone)">{{ card.answerChip.label }}</span>
            </p>
            <p v-else class="rq-eyebrow mb-0">Odin summary</p>
            <ul v-if="card.digest.groups.length" class="rq-topic-card__groups">
              <li v-for="group in card.digest.groups" :key="group.key" class="rq-topic-card__group" :class="`rq-topic-card__group--${group.key}`">
                <span class="rq-topic-card__label">{{ group.label }}</span>
                <ul class="rq-topic-card__entries">
                  <li v-for="(entry, index) in group.items" :key="index">
                    {{ entry.text }}
                    <span v-if="entry.blocking" class="rq-chip rq-chip--bad">blocking</span>
                  </li>
                  <li v-if="group.more > 0" class="rq-muted">and {{ group.more }} more</li>
                </ul>
              </li>
            </ul>
          </template>
        </div>
      </li>
    </ol>

    <RequirementsBulkDialog
      :action="bulkAction"
      :open="Boolean(bulkAction)"
      :options="peopleChoices"
      :project-id="projectId"
      :topics="selectedRows"
      @close="bulkAction = ''"
      @done="handleBulkDone"
    />
    <RequirementsTopicFormDialog
      :brief-lines="briefLines"
      :can-assign="Boolean(abilities.assign)"
      :open="addOpen"
      :project-id="projectId"
      :stakeholders="stakeholders"
      :track="track"
      :users="users"
      @close="addOpen = false"
      @saved="handleSaved"
    />
  </div>
</template>
