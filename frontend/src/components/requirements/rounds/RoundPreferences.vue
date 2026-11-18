<script setup>
import { ref } from 'vue';

import './rounds.css';
import RequirementsDialog from '../RequirementsDialog.vue';
import { copyText } from '../../../lib/clipboard.js';
import { askInNextRoundText } from '../../../lib/requirements/requirements-rounds.js';
import { chipToneClass, stanceLabel } from '../../../lib/requirements/requirements-topics.js';
import { plural } from '../../../lib/requirements/requirements-tracks.js';

// Proposed preferences from this round's Odin summaries. People
// with decision rights edit or accept one, which records it in their name, while the round
// is open; closing the round settles them with the round decision, and they never appear
// in Decide. Undecided ones can be carried into the next round: there is no draft round to attach them to yet, so
// "Ask in round N" copies a ready-to-paste question for the next package or round note.
const props = defineProps({
  canAccept: { default: false, type: Boolean },
  canAsk: { default: false, type: Boolean },
  // A closed round's preferences were settled with its decision: shown, not accepted.
  closed: { default: false, type: Boolean },
  error: { default: '', type: String },
  items: { default: () => [], type: Array },
  loaded: { default: false, type: Boolean },
  nextNumber: { required: true, type: Number },
  round: { required: true, type: Object },
  track: { required: true, type: String },
});

const emit = defineEmits(['accept', 'retry']);

const status = ref('');
const fallback = ref({ open: false, text: '' });

function tone(stance) {
  return chipToneClass(stance === 'keep' ? 'ok' : stance === 'change' ? 'warn' : 'neutral');
}

function stanceText(stance) {
  const label = stanceLabel(stance);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

async function ask(item) {
  const text = askInNextRoundText({ item: { ...item, screenTitle: item.origin.replace(/^from /, '') }, nextNumber: props.nextNumber, round: props.round, track: props.track });
  status.value = '';
  if (await copyText(text)) {
    status.value = `Copied the question for round ${props.nextNumber}. Paste it into the next package’s questions or the next round’s note to reviewers.`;
  } else {
    fallback.value = { open: true, text };
  }
}

function selectAll(event) {
  event.target.select?.();
}
</script>

<template>
  <section class="rq-panel rq-stack" aria-labelledby="rq-round-prefs-heading">
    <div class="rq-row rq-row--between rq-row--wrap">
      <h3 id="rq-round-prefs-heading" class="rq-eyebrow">{{ closed ? 'Preferences from this round' : 'Proposed preferences from this round' }}</h3>
      <span v-if="closed" class="rq-xs rq-muted">Settled with the round decision when the round closed.</span>
      <span v-else class="rq-xs rq-muted">Accepting one records a decision in your name. Admins and managers only.</span>
    </div>
    <div v-if="error" class="error-banner rq-row rq-row--between" role="alert">
      <span>{{ error }}</span>
      <button class="ghost-button ghost-button--compact" type="button" @click="emit('retry')">Try again</button>
    </div>
    <p v-else-if="!loaded" class="rq-small rq-muted mb-0">Loading proposed preferences…</p>
    <p v-else-if="items.length === 0" class="rq-small rq-muted mb-0">Nothing proposed from this round. Odin proposes preferences once its summaries find them.</p>
    <ul v-else class="rq-prefs">
      <li v-for="item in items" :key="item.key" class="rq-pref">
        <span class="rq-chip" :class="tone(item.stance)">{{ stanceText(item.stance) }}</span>
        <span>
          <strong>{{ item.statement }}</strong>
          <span class="rq-xs rq-muted"> · {{ [item.dimension, item.origin, plural(item.sources?.length ?? 0, 'source')].filter(Boolean).join(' · ') }}</span>
        </span>
        <span class="rq-pref__actions">
          <template v-if="item.stance === 'undecided'">
            <button v-if="canAsk" class="ghost-button ghost-button--compact" type="button" :aria-label="`Ask in round ${nextNumber}: ${item.statement}`" @click="ask(item)">
              <i class="bi bi-question-circle" aria-hidden="true"></i>Ask in round {{ nextNumber }}
            </button>
          </template>
          <template v-else-if="canAccept && !closed">
            <button class="ghost-button ghost-button--compact" type="button" :aria-label="`Edit preference: ${item.statement}`" @click="emit('accept', { focus: 'statement', item })">Edit</button>
            <button class="primary-button primary-button--compact" type="button" :aria-label="`Accept preference: ${item.statement}`" @click="emit('accept', { focus: 'submit', item })">Accept</button>
          </template>
        </span>
      </li>
    </ul>
    <p v-if="status" class="rq-sum__note rq-small mb-0" role="status">{{ status }}</p>

    <RequirementsDialog :open="fallback.open" :title="`Ask in round ${nextNumber}`" @close="fallback.open = false" @submit="fallback.open = false">
      <div class="rq-field">
        <label for="rq-ask-copy">Copy this into the next package’s questions or the next round’s note</label>
        <textarea id="rq-ask-copy" class="form-control" data-autofocus readonly rows="4" :value="fallback.text" @focus="selectAll"></textarea>
      </div>
      <template #footer>
        <button class="primary-button" type="submit">Done</button>
      </template>
    </RequirementsDialog>
  </section>
</template>
