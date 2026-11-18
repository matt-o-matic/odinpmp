<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';

import RequirementsPreferenceAcceptDialog from './RequirementsPreferenceAcceptDialog.vue';
import RequirementsSignals from './RequirementsSignals.vue';
import { apiClient, authSession } from '../../lib/auth/index.js';
import { describeRequirementsError } from '../../lib/requirements/requirements-errors.js';
import { proposedAnswerStatusChip } from '../../lib/requirements/requirements-sources.js';
import { formatShortDate } from '../../lib/requirements/requirements-time.js';
import {
  buildDecisionLog,
  chipToneClass,
  evidenceLine,
  isRoundPreference,
  rowProposedAnswerStatus,
  sortRegisterRows,
  stanceLabel,
} from '../../lib/requirements/requirements-topics.js';
import { plural } from '../../lib/requirements/requirements-tracks.js';
import RequirementsDecisionStatement from './RequirementsDecisionStatement.vue';

// Decide stage: the track's decision log with its supersedes chain, the topics waiting for
// a decision, and the preference queue. Only people with decision rights can accept.
const props = defineProps({
  abilities: { required: true, type: Object },
  projectId: { required: true, type: String },
  refreshKey: { default: 0, type: Number },
  topics: { default: () => [], type: Array },
  track: { required: true, type: String },
});

const emit = defineEmits(['changed', 'message']);

const route = useRoute();
const decisions = ref([]);
const proposed = ref([]);
const loaded = ref(false);
const error = ref('');
const accept = ref({ item: null, open: false });

// Labels come from the full log, so a decision keeps its D-number; preferences from a
// review round stay with the round and are left out here.
const log = computed(() => buildDecisionLog(decisions.value).filter((entry) => !isRoundPreference(entry)));
const topicCount = computed(() => decisions.value.filter((decision) => decision.kind === 'topic').length);
const preferenceCount = computed(() => decisions.value.filter((decision) => decision.kind === 'preference' && !isRoundPreference(decision)).length);
// Agreed topics with nothing blocking first, then answers awaiting confirmation, then blocked ones.
const waiting = computed(() => sortRegisterRows(props.topics.filter((row) => row.state === 'ready')).map((row) => ({
  answerChip: proposedAnswerStatusChip(rowProposedAnswerStatus(row), { blocking: row.signals?.blocking }),
  row,
})));
const focusPreference = computed(() => String(route.query.preference ?? ''));

let sequence = 0;
async function load() {
  const current = ++sequence;
  const token = authSession.state.token;
  try {
    const [decisionResult, preferenceResult] = await Promise.all([
      apiClient.passive.listRequirementsDecisions(props.projectId, props.track, {}, token),
      apiClient.passive.listRequirementsPreferences(props.projectId, props.track, token),
    ]);
    if (current !== sequence) return;
    decisions.value = decisionResult.decisions ?? [];
    proposed.value = (preferenceResult.proposed ?? []).filter((item) => !isRoundPreference(item));
    error.value = '';
  } catch (caught) {
    if (current !== sequence) return;
    error.value = describeRequirementsError(caught, 'Unable to load decisions.').message;
  } finally {
    if (current === sequence) loaded.value = true;
  }
}

watch(() => [props.projectId, props.track, props.refreshKey], load, { immediate: true });

watch(
  () => [focusPreference.value, proposed.value.length],
  async ([key]) => {
    if (!key) return;
    await nextTick();
    const element = typeof document !== 'undefined' ? document.getElementById(preferenceDomId(key)) : null;
    element?.focus?.({ preventScroll: true });
    element?.scrollIntoView?.({ block: 'center' });
  },
  { immediate: true },
);

function preferenceDomId(key) {
  return `rq-preference-${String(key).replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

function focusDecision(decisionId) {
  const element = typeof document !== 'undefined' ? document.getElementById(`rq-decision-${decisionId}`) : null;
  element?.focus?.({ preventScroll: true });
  element?.scrollIntoView?.({ block: 'center' });
}

function topicLocation(topicId, focus) {
  return {
    name: 'project-requirements-topic',
    params: { projectId: props.projectId, topicId },
    ...(focus ? { query: { focus } } : {}),
  };
}

function openAccept(item) {
  accept.value = { item, open: true };
}

function closeAccept() {
  accept.value = { ...accept.value, open: false };
}

async function handleAccepted() {
  closeAccept();
  emit('message', 'Preference accepted and added to the decision log.');
  emit('changed');
  await load();
}
</script>

<template>
  <div class="rq-decide-grid">
    <section class="rq-panel rq-stack" aria-labelledby="rq-log-heading">
      <div class="rq-row rq-row--between rq-row--wrap">
        <h3 id="rq-log-heading" class="rq-eyebrow">Decision log</h3>
        <span class="rq-xs rq-muted">{{ plural(topicCount, 'decision') }} · {{ plural(preferenceCount, 'preference') }}</span>
      </div>
      <div v-if="error" class="error-banner rq-row rq-row--between" role="alert">
        <span>{{ error }}</span>
        <button class="ghost-button ghost-button--compact" type="button" @click="load">Try again</button>
      </div>
      <p v-else-if="!loaded" class="rq-small rq-muted mb-0">Loading decisions…</p>
      <p v-else-if="log.length === 0" class="rq-small rq-muted mb-0">No decisions yet. Decisions recorded on topics and accepted preferences appear here.</p>
      <ol v-else class="rq-log">
        <li
          v-for="entry in log"
          :id="`rq-decision-${entry.id}`"
          :key="entry.id"
          class="rq-log__entry"
          :class="{ 'rq-log__entry--superseded': entry.status === 'superseded' }"
          tabindex="-1"
        >
          <span class="rq-log__id">{{ entry.label }}</span>
          <div>
            <div class="rq-row rq-row--tight rq-row--wrap">
              <span class="rq-chip" :class="chipToneClass(entry.chip.tone)">{{ entry.chip.label }}</span>
              <span class="rq-xs rq-muted">
                {{ entry.decidedBy?.name || 'Team member' }} · {{ formatShortDate(entry.decidedAt) }}<template v-if="entry.sourceCount"> · {{ plural(entry.sourceCount, 'source') }}</template>
              </span>
            </div>
            <div class="rq-log__statement">
              <span v-if="entry.status === 'superseded'" class="visually-hidden">Superseded: </span>
              <RequirementsDecisionStatement :statement="entry.statement" />
            </div>
            <p class="rq-xs rq-muted mb-0">
              <template v-if="entry.topic">Topic: <RouterLink :to="topicLocation(entry.topic.id)">{{ entry.topic.prompt }}</RouterLink></template>
              <template v-else-if="entry.preference?.dimension">{{ entry.preference.dimension }}</template>
              <template v-if="entry.supersedesLabel">
                · supersedes <button class="rq-link-button" type="button" @click="focusDecision(entry.supersedesId)">{{ entry.supersedesLabel }}</button>
              </template>
              <template v-if="entry.supersededByLabel">
                · replaced by <button class="rq-link-button" type="button" @click="focusDecision(entry.supersededById)">{{ entry.supersededByLabel }}</button>
              </template>
            </p>
          </div>
        </li>
      </ol>
    </section>

    <div class="rq-stack">
      <section class="rq-panel rq-stack" aria-labelledby="rq-waiting-heading">
        <h3 id="rq-waiting-heading" class="rq-eyebrow">Waiting for a decision</h3>
        <p v-if="waiting.length === 0" class="rq-small rq-muted mb-0">No topics are ready for a decision.</p>
        <ul v-else class="rq-queue">
          <li v-for="{ answerChip, row } in waiting" :key="row.id" class="rq-queue__item">
            <span>
              <strong class="rq-small">{{ row.prompt }}</strong>
              <span class="rq-row rq-row--tight rq-row--wrap rq-xs rq-muted mt-1">
                <span v-if="answerChip" class="rq-chip rq-chip--wrap" :class="chipToneClass(answerChip.tone)">{{ answerChip.label }}</span>
                <RequirementsSignals :signals="row.signals" />
                <span v-if="evidenceLine(row.evidence)">{{ evidenceLine(row.evidence) }}</span>
              </span>
            </span>
            <RouterLink
              :class="abilities.recordDecisions ? 'primary-button primary-button--compact' : 'ghost-button ghost-button--compact'"
              :to="topicLocation(row.id, abilities.recordDecisions ? 'decision' : '')"
              :aria-label="`${abilities.recordDecisions ? 'Decide' : 'Open'}: ${row.prompt}`"
            >
              {{ abilities.recordDecisions ? 'Decide' : 'Open' }}
            </RouterLink>
          </li>
        </ul>
      </section>

      <section class="rq-panel rq-stack" aria-labelledby="rq-preferences-heading">
        <div class="rq-stack rq-stack--sm">
          <h3 id="rq-preferences-heading" class="rq-eyebrow">Proposed preferences</h3>
          <p class="rq-xs rq-muted mb-0">Drawn from the latest topic and review summaries. Accepting one records it as a decision in your name.</p>
        </div>
        <p v-if="loaded && proposed.length === 0" class="rq-small rq-muted mb-0">No preferences are waiting.</p>
        <ul v-else class="rq-queue">
          <li
            v-for="item in proposed"
            :id="preferenceDomId(item.key)"
            :key="item.key"
            class="rq-queue__item"
            :class="{ 'rq-queue__item--focus': item.key === focusPreference }"
            tabindex="-1"
          >
            <span>
              <span class="rq-chip" :class="chipToneClass(item.stance === 'keep' ? 'ok' : item.stance === 'change' ? 'warn' : 'neutral')">
                {{ stanceLabel(item.stance) }}
              </span>
              <strong class="rq-small"> {{ item.statement }}</strong>
              <span class="rq-xs rq-muted d-block mt-1">
                {{ item.dimension || 'General' }}<template v-if="item.sources?.length"> · {{ plural(item.sources.length, 'source') }}</template> · {{ formatShortDate(item.proposedAt) }}
              </span>
            </span>
            <button
              v-if="abilities.acceptPreferences"
              class="ghost-button ghost-button--compact"
              type="button"
              :aria-label="`Accept preference: ${item.statement}`"
              @click="openAccept(item)"
            >
              Accept
            </button>
          </li>
        </ul>
      </section>
    </div>

    <RequirementsPreferenceAcceptDialog
      :item="accept.item"
      :open="accept.open"
      :project-id="projectId"
      :track="track"
      @accepted="handleAccepted"
      @close="closeAccept"
    />
  </div>
</template>
