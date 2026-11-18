<script setup>
import { computed } from 'vue';
import { RouterLink } from 'vue-router';

import './rounds.css';
import RequirementsAvatar from '../RequirementsAvatar.vue';
import { feedbackAnchor, roundSourceChips } from '../../../lib/requirements/requirements-rounds.js';
import { hasSummaryFindings, normalizeSummaryOutput, outstandingOwnerText } from '../../../lib/requirements/requirements-sources.js';
import { describeSummaryStatus, summaryPeople } from '../../../lib/requirements/requirements-summary-status.js';

// The Odin summary of one screen in a round, or of the whole round. Labeled "Odin summary"
// like any contributor, with no disclaimer or AI badge (Q-14a). Every point shows the
// feedback behind it: annotation numbers, comment labels, and the people whose verdicts,
// direction choices, or answers it cites. Feedback themes group every annotation and
// comment; with `feedbackLocation`, their citations open in "Marks and comments".
const props = defineProps({
  canRefresh: { default: false, type: Boolean },
  // The round's "Marks and comments" view: annotation and comment citations link there.
  feedbackLocation: { default: null, type: Object },
  headingId: { required: true, type: String },
  people: { default: () => new Map(), type: Map },
  refreshResult: { default: null, type: Object },
  refreshing: { default: false, type: Boolean },
  // { current: { createdAt, id, output, sources }, status } from the results API, or null.
  scope: { default: null, type: Object },
  screenTitles: { default: () => ({}), type: Object },
  // Round summaries cite several screens, so annotation chips name their screen.
  showScreen: { default: false, type: Boolean },
  // What the summary covers, shown after the label: "Booking home", "Round 2".
  subject: { default: '', type: String },
});

const emit = defineEmits(['refresh']);

const current = computed(() => props.scope?.current ?? null);
const output = computed(() => normalizeSummaryOutput(current.value?.output ?? null));
const hasFindings = computed(() => hasSummaryFindings(output.value));
const freshness = computed(() => describeSummaryStatus({ status: props.scope?.status ?? null, summary: current.value }));
// Whose move each outstanding item is: the people it waits on, else the suggested role.
const outstanding = computed(() => output.value.outstanding.map((entry) => ({
  ...entry,
  owner: outstandingOwnerText({
    names: personList(entry.waitingOn, entry.waitingOnNames).map((person) => person.name),
    role: entry.suggestedOwnerRole,
  }),
})));

function chips(refs) {
  return roundSourceChips(refs, {
    lookup: current.value?.sources ?? [],
    people: props.people,
    screenTitles: props.screenTitles,
    showScreen: props.showScreen,
  }).map((chip) => {
    const hash = !chip.removed && props.feedbackLocation ? feedbackAnchor(chip.ref) : '';
    return hash ? { ...chip, to: { ...props.feedbackLocation, hash } } : chip;
  });
}

function chipAttrs(chip) {
  return chip.to
    ? { 'aria-label': `${chip.ariaLabel}, open in Marks and comments`, to: chip.to }
    : { 'aria-label': chip.ariaLabel, role: 'note' };
}

function personList(refs, names) {
  const context = { users: [], stakeholders: [] };
  return summaryPeople(refs, names, context).map((person) => ({ ...person, name: props.people.get(person.ref) || person.name }));
}
</script>

<template>
  <div class="rq-stack">
    <div class="rq-row rq-row--between rq-row--wrap rq-row--tight">
      <h3 :id="headingId" class="rq-eyebrow">Odin summary<template v-if="subject"> · {{ subject }}</template></h3>
      <span class="rq-row rq-row--tight rq-row--wrap rq-sum__status">
        <span v-if="freshness.updatedText" class="rq-xs rq-muted">{{ freshness.updatedText }}</span>
        <span v-if="freshness.failed" class="rq-xs rq-sum__failed">
          <i class="bi bi-exclamation-triangle me-1" aria-hidden="true"></i>{{ freshness.failedText }}
        </span>
        <span v-else-if="freshness.pending && !refreshing" class="rq-xs rq-muted">· update queued</span>
        <button v-if="canRefresh" class="rq-text-action" type="button" :disabled="refreshing" @click="emit('refresh')">
          <i class="bi bi-arrow-clockwise me-1" aria-hidden="true"></i>{{ refreshing ? 'Refreshing…' : 'Refresh' }}<span v-if="!refreshing" class="visually-hidden"> the Odin summary of {{ subject || 'this round' }}</span>
        </button>
      </span>
    </div>
    <p
      v-if="refreshResult?.message"
      class="mb-0 rq-small"
      :class="refreshResult.tone === 'error' ? 'error-banner' : 'rq-sum__note'"
      :role="refreshResult.tone === 'error' ? 'alert' : 'status'"
    >{{ refreshResult.message }}</p>

    <p v-if="!current && freshness.failed" class="rq-small rq-muted mb-0">Odin couldn’t summarize this feedback yet. It will try again.</p>
    <p v-else-if="!current" class="rq-small rq-muted mb-0">No summary yet. Odin summarizes once reviewers start giving feedback.</p>
    <p v-else-if="output.insufficientInput" class="rq-small mb-0">
      <strong>Not enough input yet</strong>
      <span class="rq-muted"> · Odin summarizes once reviewers have marked, commented on, or judged the screens.</span>
    </p>
    <p v-else-if="!hasFindings" class="rq-small rq-muted mb-0">Nothing to report yet.</p>

    <div v-else class="rq-sum">
      <section v-if="output.feedbackThemes.length" class="rq-sum__group rq-sum__group--themes">
        <h4 class="rq-sum__head"><i class="bi bi-chat-square-text" aria-hidden="true"></i>Feedback themes · {{ output.feedbackThemes.length }}</h4>
        <ul class="rq-sum__list">
          <li v-for="(entry, index) in output.feedbackThemes" :key="`theme-${index}`" class="rq-sum__item">
            <strong>{{ entry.theme }}</strong>
            <span v-if="entry.detail" class="d-block">{{ entry.detail }}</span>
            <span class="rq-sum__meta">
              <span class="rq-sources">
                <component :is="chip.to ? RouterLink : 'span'" v-for="chip in chips(entry.sources)" :key="chip.ref" class="rq-source" :class="{ 'rq-source--removed': chip.removed }" v-bind="chipAttrs(chip)">{{ chip.label }}</component>
              </span>
            </span>
          </li>
        </ul>
      </section>

      <section v-if="output.aligned.length" class="rq-sum__group rq-sum__group--aligned">
        <h4 class="rq-sum__head"><i class="bi bi-check2-circle" aria-hidden="true"></i>Aligned · {{ output.aligned.length }}</h4>
        <ul class="rq-sum__list">
          <li v-for="(entry, index) in output.aligned" :key="`aligned-${index}`" class="rq-sum__item">
            {{ entry.statement }}
            <span class="rq-sum__meta">
              <span v-if="entry.supporters?.length || entry.supporterNames?.length" class="rq-avatars">
                <RequirementsAvatar v-for="person in personList(entry.supporters, entry.supporterNames)" :key="person.ref" :person="person" standalone />
              </span>
              <span class="rq-sources">
                <component :is="chip.to ? RouterLink : 'span'" v-for="chip in chips(entry.sources)" :key="chip.ref" class="rq-source" :class="{ 'rq-source--removed': chip.removed }" v-bind="chipAttrs(chip)">{{ chip.label }}</component>
              </span>
            </span>
          </li>
        </ul>
      </section>

      <section v-if="output.divergent.length" class="rq-sum__group rq-sum__group--divergent">
        <h4 class="rq-sum__head"><i class="bi bi-arrow-left-right" aria-hidden="true"></i>Diverging · {{ output.divergent.length }}</h4>
        <ul class="rq-sum__list">
          <li v-for="(entry, index) in output.divergent" :key="`divergent-${index}`" class="rq-sum__item">
            {{ entry.issue }}
            <ul class="list-unstyled mb-0">
              <li v-for="(position, positionIndex) in entry.positions ?? []" :key="positionIndex" class="rq-sum__position">
                <span v-if="position.actors?.length || position.actorNames?.length" class="rq-avatars">
                  <RequirementsAvatar v-for="person in personList(position.actors, position.actorNames)" :key="person.ref" :person="person" standalone />
                </span>
                <span>
                  {{ position.summary }}
                  <span class="rq-sources">
                    <component :is="chip.to ? RouterLink : 'span'" v-for="chip in chips(position.sources)" :key="chip.ref" class="rq-source" :class="{ 'rq-source--removed': chip.removed }" v-bind="chipAttrs(chip)">{{ chip.label }}</component>
                  </span>
                </span>
              </li>
            </ul>
          </li>
        </ul>
      </section>

      <section v-if="output.underExplored.length" class="rq-sum__group rq-sum__group--under">
        <h4 class="rq-sum__head"><i class="bi bi-compass" aria-hidden="true"></i>Under-explored · {{ output.underExplored.length }}</h4>
        <ul class="rq-sum__list">
          <li v-for="(entry, index) in output.underExplored" :key="`under-${index}`" class="rq-sum__item">
            {{ entry.area }}
            <span v-if="entry.why" class="rq-xs rq-muted d-block">{{ entry.why }}</span>
            <span v-if="entry.suggestedQuestion" class="rq-xs d-block"><span class="rq-muted">Could ask:</span> {{ entry.suggestedQuestion }}</span>
          </li>
        </ul>
      </section>

      <section v-if="output.outstanding.length" class="rq-sum__group rq-sum__group--outstanding">
        <h4 class="rq-sum__head"><i class="bi bi-flag" aria-hidden="true"></i>Outstanding · {{ output.outstanding.length }}</h4>
        <ul class="rq-sum__list">
          <li v-for="(entry, index) in outstanding" :key="`outstanding-${index}`" class="rq-sum__item">
            {{ entry.item }}
            <span v-if="entry.blocking" class="rq-chip rq-chip--bad">blocking</span>
            <span v-if="entry.owner" class="rq-xs rq-muted"> · {{ entry.owner }}</span>
            <span v-if="entry.sources.length" class="rq-sum__meta">
              <span class="rq-sources">
                <component :is="chip.to ? RouterLink : 'span'" v-for="chip in chips(entry.sources)" :key="chip.ref" class="rq-source" :class="{ 'rq-source--removed': chip.removed }" v-bind="chipAttrs(chip)">{{ chip.label }}</component>
              </span>
            </span>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>
