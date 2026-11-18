<script setup>
import { computed } from 'vue';

import RequirementsAvatar from './RequirementsAvatar.vue';
import RequirementsSourceChips from './RequirementsSourceChips.vue';
import { hasSummaryFindings, normalizeSummaryOutput, outstandingOwnerText } from '../../lib/requirements/requirements-sources.js';
import { describeSummaryStatus, summaryPeople } from '../../lib/requirements/requirements-summary-status.js';

// The Odin summary for one topic. Labeled "Odin summary" like any contributor, with no
// disclaimer or AI badge (Q-14a). `compact` is the register's quick view. A failed run
// keeps the previous summary, shown as "Last updated <time>" plus "refresh failed".
const props = defineProps({
  canAsk: { default: false, type: Boolean },
  // Shows Refresh (members and up); the parent runs it and passes the result back.
  canRefresh: { default: false, type: Boolean },
  compact: { default: false, type: Boolean },
  contributionLine: { default: '', type: String },
  groupHeadingTag: { default: 'h3', type: String },
  headingId: { default: '', type: String },
  headingTag: { default: 'h2', type: String },
  numbering: { default: null, type: Object },
  people: { default: () => ({}), type: Object },
  // { message, tone } from the last refresh, or null.
  refreshResult: { default: null, type: Object },
  refreshing: { default: false, type: Boolean },
  // The topic's summaryStatus: { lastAttemptAt, lastAttemptStatus, refreshPending }.
  status: { default: null, type: Object },
  summary: { default: null, type: Object },
});

const emit = defineEmits(['ask', 'cite', 'refresh']);

const output = computed(() => normalizeSummaryOutput(props.summary?.output ?? null));
const hasFindings = computed(() => hasSummaryFindings(output.value));
const freshness = computed(() => describeSummaryStatus({ status: props.status, summary: props.summary }));

// Whose move each outstanding item is: the people it waits on, else the suggested role.
const outstanding = computed(() => output.value.outstanding.map((entry) => ({
  ...entry,
  owner: outstandingOwnerText({
    names: people(entry.waitingOn, entry.waitingOnNames).map((person) => person.name),
    role: entry.suggestedOwnerRole,
  }),
})));

function people(refs, names) {
  return summaryPeople(refs, names, props.people);
}
</script>

<template>
  <div class="rq-stack">
    <div class="rq-row rq-row--between rq-row--wrap rq-row--tight">
      <component :is="headingTag" :id="headingId || undefined" class="rq-eyebrow rq-section-heading" tabindex="-1">Odin summary</component>
      <span class="rq-row rq-row--tight rq-row--wrap rq-sum__status">
        <span v-if="freshness.updatedText" class="rq-xs rq-muted">{{ freshness.updatedText }}</span>
        <span v-if="freshness.failed" class="rq-xs rq-sum__failed">
          <i class="bi bi-exclamation-triangle me-1" aria-hidden="true"></i>{{ freshness.failedText }}
        </span>
        <span v-else-if="freshness.pending && !refreshing" class="rq-xs rq-muted">· update queued</span>
        <button
          v-if="canRefresh"
          class="rq-text-action"
          type="button"
          :disabled="refreshing"
          @click="emit('refresh')"
        >
          <i class="bi bi-arrow-clockwise me-1" aria-hidden="true"></i>{{ refreshing ? 'Refreshing…' : 'Refresh' }}<span v-if="!refreshing" class="visually-hidden"> the Odin summary</span>
        </button>
      </span>
    </div>
    <p
      v-if="refreshResult?.message"
      class="mb-0 rq-small"
      :class="refreshResult.tone === 'error' ? 'error-banner' : 'rq-sum__note'"
      :role="refreshResult.tone === 'error' ? 'alert' : 'status'"
    >{{ refreshResult.message }}</p>
    <p v-if="summary && contributionLine && !compact" class="rq-xs rq-muted mb-0">{{ contributionLine }}</p>

    <p v-if="!summary && freshness.failed" class="rq-small rq-muted mb-0">Odin couldn’t summarize this discussion yet. It will try again.</p>
    <p v-else-if="!summary" class="rq-small rq-muted mb-0">No summary yet. Odin summarizes the discussion once people start contributing.</p>
    <p v-else-if="output.insufficientInput" class="rq-small mb-0">
      <strong>Not enough input yet</strong>
      <span class="rq-muted"> · Odin summarizes once two or more people have contributed.</span>
    </p>
    <p v-else-if="!hasFindings" class="rq-small rq-muted mb-0">Nothing to report yet.</p>

    <div v-else class="rq-sum">
      <section v-if="output.aligned.length" class="rq-sum__group rq-sum__group--aligned">
        <component :is="groupHeadingTag" class="rq-sum__head" :class="{ 'visually-hidden': compact }">
          <i class="bi bi-check2-circle" aria-hidden="true"></i>Aligned · {{ output.aligned.length }}
        </component>
        <ul class="rq-sum__list">
          <li v-for="(entry, index) in output.aligned" :key="`aligned-${index}`" class="rq-sum__item">
            {{ entry.statement }}
            <span class="rq-sum__meta">
              <span v-if="!compact && (entry.supporters?.length || entry.supporterNames?.length)" class="rq-avatars">
                <RequirementsAvatar v-for="person in people(entry.supporters, entry.supporterNames)" :key="person.ref" :person="person" standalone />
              </span>
              <RequirementsSourceChips :interactive="!compact" :numbering="numbering" :sources="entry.sources ?? []" @cite="emit('cite', $event)" />
            </span>
          </li>
        </ul>
      </section>

      <section v-if="output.divergent.length" class="rq-sum__group rq-sum__group--divergent">
        <component :is="groupHeadingTag" class="rq-sum__head" :class="{ 'visually-hidden': compact }">
          <i class="bi bi-arrow-left-right" aria-hidden="true"></i>Diverging · {{ output.divergent.length }}
        </component>
        <ul class="rq-sum__list">
          <li v-for="(entry, index) in output.divergent" :key="`divergent-${index}`" class="rq-sum__item">
            {{ entry.issue }}
            <template v-if="compact">
              <span class="rq-sum__meta">
                <RequirementsSourceChips
                  :interactive="false"
                  :numbering="numbering"
                  :sources="(entry.positions ?? []).flatMap((position) => position?.sources ?? [])"
                />
              </span>
            </template>
            <ul v-else class="list-unstyled mb-0">
              <li v-for="(position, positionIndex) in entry.positions ?? []" :key="positionIndex" class="rq-sum__position">
                <span v-if="position.actors?.length || position.actorNames?.length" class="rq-avatars">
                  <RequirementsAvatar v-for="person in people(position.actors, position.actorNames)" :key="person.ref" :person="person" standalone />
                </span>
                <span>
                  {{ position.summary }}
                  <RequirementsSourceChips :numbering="numbering" :sources="position.sources ?? []" @cite="emit('cite', $event)" />
                </span>
              </li>
            </ul>
          </li>
        </ul>
      </section>

      <section v-if="output.underExplored.length && !compact" class="rq-sum__group rq-sum__group--under">
        <component :is="groupHeadingTag" class="rq-sum__head">
          <i class="bi bi-compass" aria-hidden="true"></i>Under-explored · {{ output.underExplored.length }}
        </component>
        <ul class="rq-sum__list">
          <li v-for="(entry, index) in output.underExplored" :key="`under-${index}`" class="rq-sum__item">
            {{ entry.area }}
            <span v-if="entry.why" class="rq-xs rq-muted d-block">{{ entry.why }}</span>
            <button
              v-if="canAsk && entry.suggestedQuestion"
              class="rq-ask"
              type="button"
              :aria-label="`Ask the group: ${entry.suggestedQuestion}`"
              @click="emit('ask', entry.suggestedQuestion)"
            >
              Ask the group <span aria-hidden="true">→</span>
            </button>
          </li>
        </ul>
      </section>

      <section v-if="output.outstanding.length" class="rq-sum__group rq-sum__group--outstanding">
        <component :is="groupHeadingTag" class="rq-sum__head" :class="{ 'visually-hidden': compact }">
          <i class="bi bi-flag" aria-hidden="true"></i>Outstanding · {{ output.outstanding.length }}
        </component>
        <ul class="rq-sum__list">
          <li v-for="(entry, index) in outstanding" :key="`outstanding-${index}`" class="rq-sum__item">
            {{ entry.item }}
            <span v-if="entry.blocking" class="rq-chip rq-chip--bad">blocking</span>
            <span v-if="!compact && entry.owner" class="rq-xs rq-muted"> · {{ entry.owner }}</span>
            <span v-if="entry.sources.length" class="rq-sum__meta">
              <RequirementsSourceChips :interactive="!compact" :numbering="numbering" :sources="entry.sources" @cite="emit('cite', $event)" />
            </span>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>
