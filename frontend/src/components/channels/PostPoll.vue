<script setup>
import { computed, inject, reactive, ref, useId, watch } from 'vue';

import { POST_FILES_KEY } from '../../lib/channels/attachments.js';
import { useChannelApi } from '../../lib/channels/channel-api.js';
import { channelErrorMessage } from '../../lib/channels/channels.js';
import { answerDraft, answerPayload, closingLabel, kindLabel, moveEntry, optionLabels, percent, votesLabel } from '../../lib/channels/polls.js';
import RequirementsConfirmDialog from '../requirements/RequirementsConfirmDialog.vue';

// A post's poll (docs/engagements/plan.md, Polls): a form to vote in it, then the results. People
// change their vote until it closes. Another person's vote arrives with the conversation's live
// refresh, as a new `poll`. The conversation says which project (or direct message) and token
// to call with, as it does for attachments.
const props = defineProps({
  poll: { required: true, type: Object },
  postId: { required: true, type: String },
});
const emit = defineEmits(['update']);

const api = useChannelApi();
const place = inject(POST_FILES_KEY, null);
const projectId = () => place?.projectId?.() ?? '';
const token = () => place?.token?.() ?? '';
const uid = useId();
const draft = ref(answerDraft(props.poll));
const changing = ref(false);
const busy = ref(false);
const error = ref('');
const announce = ref('');
const closing = reactive({ busy: false, error: '', open: false });
const dragging = ref(-1);
// Someone yet to vote in a poll that shows results to all can look before voting.
const peek = ref(false);

const voted = computed(() => Boolean(props.poll.myAnswer));
const showForm = computed(() => props.poll.canVote && (!voted.value || changing.value));
const answer = computed(() => answerPayload(props.poll, draft.value));
const labels = computed(() => optionLabels(props.poll));
const closesText = computed(() => closingLabel(props.poll));
const results = computed(() => props.poll.results);
const showResults = computed(() => !showForm.value || (peek.value && Boolean(results.value)));
const scale = computed(() => Array.from({ length: props.poll.settings?.scaleMax ?? 5 }, (_, index) => index + 1));
const maxChoices = computed(() => props.poll.settings?.maxChoices ?? null);
const formHint = computed(() => {
  if (props.poll.kind === 'multiple') return maxChoices.value ? `Pick up to ${maxChoices.value}.` : 'Pick as many as apply.';
  if (props.poll.kind === 'ranking') return 'Put the options in order, best first. Use the arrow buttons, or drag.';
  return '';
});

// A newer poll (someone voted, or it closed) resets the form unless the person is changing their vote.
watch(() => props.poll, (poll) => {
  if (!changing.value) draft.value = answerDraft(poll);
});

function toggle(optionId) {
  const picked = new Set(draft.value.optionIds);
  if (picked.has(optionId)) picked.delete(optionId);
  else picked.add(optionId);
  draft.value = { optionIds: props.poll.options.map((option) => option.id).filter((id) => picked.has(id)) };
}

function move(index, step) {
  const order = moveEntry(draft.value.order, index, step);
  if (order === draft.value.order) return;
  draft.value = { order };
  const at = index + step;
  announce.value = `${labels.value.get(order[at])} moved to place ${at + 1} of ${order.length}.`;
}

function dragStart(index, event) {
  dragging.value = index;
  event.dataTransfer?.setData('text/plain', String(index));
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
}

function dropAt(index) {
  const from = dragging.value;
  dragging.value = -1;
  if (from < 0 || from === index) return;
  const order = [...draft.value.order];
  const [entry] = order.splice(from, 1);
  order.splice(index, 0, entry);
  draft.value = { order };
  announce.value = `${labels.value.get(entry)} moved to place ${index + 1} of ${order.length}.`;
}

async function submit() {
  if (!answer.value || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const result = await api.votePoll(projectId(), props.postId, answer.value, token());
    changing.value = false;
    emit('update', result.poll);
  } catch (failure) {
    error.value = channelErrorMessage(failure, 'Your vote could not be saved.');
  } finally {
    busy.value = false;
  }
}

function startChange() {
  draft.value = answerDraft(props.poll);
  changing.value = true;
}

function cancelChange() {
  changing.value = false;
  draft.value = answerDraft(props.poll);
}

async function closePoll() {
  closing.busy = true;
  closing.error = '';
  try {
    const result = await api.closePoll(projectId(), props.postId, token());
    closing.open = false;
    emit('update', result.poll);
  } catch (failure) {
    closing.error = channelErrorMessage(failure, 'The poll could not be closed.');
  } finally {
    closing.busy = false;
  }
}

const voters = (list) => (list?.length ? list.join(', ') : '');
</script>

<template>
  <section class="post-poll" :aria-labelledby="`${uid}-question`">
    <header class="post-poll__head">
      <span class="post-poll__kind"><i class="bi bi-bar-chart-line" aria-hidden="true"></i> {{ kindLabel(poll.kind) }}<template v-if="poll.settings?.anonymous"> · Anonymous</template></span>
      <span v-if="closesText" class="post-poll__state" :class="{ 'post-poll__state--closed': poll.closed }">{{ closesText }}</span>
    </header>
    <p :id="`${uid}-question`" class="post-poll__question">{{ poll.question }}</p>

    <form v-if="showForm" class="post-poll__form" @submit.prevent="submit">
      <p v-if="formHint" :id="`${uid}-hint`" class="post-poll__hint">{{ formHint }}</p>

      <fieldset v-if="poll.kind === 'single'" class="post-poll__choices">
        <legend class="visually-hidden">{{ poll.question }}</legend>
        <label v-for="option in poll.options" :key="option.id" class="post-poll__choice">
          <input type="radio" :name="`${uid}-choice`" :checked="draft.optionIds[0] === option.id" @change="draft = { optionIds: [option.id] }" />
          <span>{{ option.label }}</span>
        </label>
      </fieldset>

      <fieldset v-else-if="poll.kind === 'multiple'" class="post-poll__choices" :aria-describedby="`${uid}-hint`">
        <legend class="visually-hidden">{{ poll.question }}</legend>
        <label v-for="option in poll.options" :key="option.id" class="post-poll__choice">
          <input type="checkbox" :checked="draft.optionIds.includes(option.id)" :disabled="Boolean(maxChoices) && draft.optionIds.length >= maxChoices && !draft.optionIds.includes(option.id)" @change="toggle(option.id)" />
          <span>{{ option.label }}</span>
        </label>
      </fieldset>

      <ol v-else-if="poll.kind === 'ranking'" class="post-poll__rank" :aria-label="`Your order for: ${poll.question}`" :aria-describedby="`${uid}-hint`">
        <li
          v-for="(optionId, index) in draft.order"
          :key="optionId"
          class="post-poll__rank-item"
          :class="{ 'post-poll__rank-item--dragging': dragging === index }"
          draggable="true"
          @dragstart="dragStart(index, $event)"
          @dragend="dragging = -1"
          @dragover.prevent
          @drop.prevent="dropAt(index)"
        >
          <span class="post-poll__rank-place" aria-hidden="true">{{ index + 1 }}</span>
          <i class="bi bi-grip-vertical post-poll__grip" aria-hidden="true"></i>
          <span class="post-poll__rank-label">{{ labels.get(optionId) }}</span>
          <button class="post-poll__icon" type="button" :aria-label="`Move ${labels.get(optionId)} up`" :disabled="index === 0" @click="move(index, -1)">
            <i class="bi bi-arrow-up" aria-hidden="true"></i>
          </button>
          <button class="post-poll__icon" type="button" :aria-label="`Move ${labels.get(optionId)} down`" :disabled="index === draft.order.length - 1" @click="move(index, 1)">
            <i class="bi bi-arrow-down" aria-hidden="true"></i>
          </button>
        </li>
      </ol>

      <div v-else-if="poll.kind === 'text'" class="rq-field">
        <label class="visually-hidden" :for="`${uid}-text`">Your answer</label>
        <input :id="`${uid}-text`" v-model="draft.text" class="form-control" maxlength="500" autocomplete="off" placeholder="Your answer" />
      </div>

      <fieldset v-else-if="poll.kind === 'rating'" class="post-poll__scale">
        <legend class="visually-hidden">{{ poll.question }}, from 1 to {{ scale.length }}</legend>
        <label v-for="value in scale" :key="value" class="post-poll__scale-value">
          <input type="radio" :name="`${uid}-rating`" :checked="draft.value === value" @change="draft = { value }" />
          <span>{{ value }}</span>
        </label>
      </fieldset>

      <span class="visually-hidden" aria-live="polite">{{ announce }}</span>
      <p v-if="error" class="error-banner mb-0" role="alert">{{ error }}</p>
      <div class="post-poll__actions">
        <button class="primary-button primary-button--compact" type="submit" :disabled="busy || !answer">{{ busy ? 'Saving…' : voted ? 'Save vote' : 'Vote' }}</button>
        <button v-if="changing" class="ghost-button ghost-button--compact" type="button" :disabled="busy" @click="cancelChange">Cancel</button>
      </div>
    </form>

    <div v-if="showResults" :id="`${uid}-results`" class="post-poll__results" :aria-label="`Results: ${votesLabel(poll.voterCount)}`" role="group">
      <template v-if="results">
        <ul v-if="results.kind === 'single' || results.kind === 'multiple'" class="post-poll__bars">
          <li v-for="option in results.options" :key="option.id" class="post-poll__bar" :class="{ 'post-poll__bar--mine': poll.myAnswer?.optionIds?.includes(option.id) }">
            <div class="post-poll__bar-line">
              <span class="post-poll__bar-label">{{ option.label }}<template v-if="poll.myAnswer?.optionIds?.includes(option.id)"><i class="bi bi-check2 ms-1" aria-hidden="true"></i><span class="visually-hidden">(your choice)</span></template></span>
              <span class="post-poll__bar-count">{{ option.count }} · {{ percent(option.share) }}</span>
            </div>
            <span class="post-poll__track" aria-hidden="true"><span class="post-poll__fill" :style="{ width: percent(option.share) }"></span></span>
            <span v-if="voters(option.voters)" class="post-poll__voters">{{ voters(option.voters) }}</span>
          </li>
        </ul>

        <ol v-else-if="results.kind === 'ranking'" class="post-poll__bars">
          <li v-for="option in results.options" :key="option.id" class="post-poll__bar">
            <div class="post-poll__bar-line">
              <span class="post-poll__bar-label"><span class="post-poll__rank-place">{{ option.place }}</span> {{ option.label }}</span>
              <span class="post-poll__bar-count">{{ option.points }} pts<template v-if="option.averageRank !== null"> · avg. rank {{ option.averageRank }}</template></span>
            </div>
            <span class="post-poll__track" aria-hidden="true"><span class="post-poll__fill" :style="{ width: percent(option.share) }"></span></span>
          </li>
        </ol>

        <ul v-else-if="results.kind === 'text'" class="post-poll__answers">
          <li v-if="!results.answers.length" class="post-poll__hint">No answers yet.</li>
          <li v-for="entry in results.answers" :key="entry.text" class="post-poll__answer">
            <span class="post-poll__answer-text">{{ entry.text }}</span>
            <span v-if="entry.count > 1" class="post-poll__answer-count">×{{ entry.count }}</span>
            <span v-if="voters(entry.voters)" class="post-poll__voters">{{ voters(entry.voters) }}</span>
          </li>
        </ul>

        <div v-else-if="results.kind === 'rating'" class="post-poll__rating">
          <p class="post-poll__average"><strong>{{ results.average ?? '—' }}</strong> <span>average of {{ results.scaleMax }}</span></p>
          <ul class="post-poll__bars post-poll__bars--compact">
            <li v-for="entry in results.distribution" :key="entry.value" class="post-poll__bar">
              <div class="post-poll__bar-line">
                <span class="post-poll__bar-label">{{ entry.value }}<template v-if="poll.myAnswer?.value === entry.value"><i class="bi bi-check2 ms-1" aria-hidden="true"></i><span class="visually-hidden">(your rating)</span></template></span>
                <span class="post-poll__bar-count">{{ entry.count }}</span>
              </div>
              <span class="post-poll__track" aria-hidden="true"><span class="post-poll__fill" :style="{ width: percent(entry.share) }"></span></span>
              <span v-if="voters(entry.voters)" class="post-poll__voters">{{ voters(entry.voters) }}</span>
            </li>
          </ul>
        </div>
      </template>
      <p v-else-if="poll.resultsHidden" class="post-poll__hint">Results show once you vote.</p>
    </div>

    <footer class="post-poll__foot">
      <span class="post-poll__count">{{ votesLabel(poll.voterCount) }}</span>
      <button v-if="showForm && results" class="ghost-button ghost-button--compact" type="button" :aria-expanded="peek ? 'true' : 'false'" :aria-controls="`${uid}-results`" @click="peek = !peek">{{ peek ? 'Hide results' : 'See results' }}</button>
      <button v-if="voted && poll.canVote && !changing" class="ghost-button ghost-button--compact" type="button" @click="startChange">Change vote</button>
      <button v-if="poll.canClose" class="ghost-button ghost-button--compact" type="button" @click="closing.open = true; closing.error = ''">Close poll</button>
    </footer>

    <RequirementsConfirmDialog
      :busy="closing.busy"
      confirm-label="Close poll"
      :error="closing.error"
      :open="closing.open"
      title="Close this poll?"
      @close="closing.open = false"
      @confirm="closePoll"
    >
      <p class="mb-0">Nobody can vote or change their vote after this. The results stay.</p>
    </RequirementsConfirmDialog>
  </section>
</template>

<style scoped>
.post-poll { display: grid; gap: 0.6rem; max-width: 34rem; padding: 0.75rem; border: 1px solid var(--line); border-radius: 0.55rem; background: var(--surface); }
.post-poll__head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0.5rem; color: var(--muted); font-size: 0.78rem; }
.post-poll__kind { display: inline-flex; align-items: center; gap: 0.3rem; font-weight: 600; letter-spacing: 0.02em; text-transform: uppercase; }
.post-poll__state--closed { color: var(--ink-soft); font-weight: 600; }
.post-poll__question { margin: 0; color: var(--ink); font-size: 1rem; font-weight: 600; overflow-wrap: anywhere; }
.post-poll__form { display: grid; gap: 0.5rem; }
.post-poll__hint { margin: 0; color: var(--muted); font-size: 0.82rem; }
.post-poll__choices,
.post-poll__scale { display: grid; gap: 0.35rem; margin: 0; padding: 0; border: 0; }
.post-poll__choice { display: flex; align-items: center; gap: 0.6rem; min-height: 2.75rem; padding: 0.35rem 0.75rem; border: 1px solid var(--line); border-radius: 0.45rem; cursor: pointer; overflow-wrap: anywhere; }
.post-poll__choice:has(input:checked) { border-color: var(--accent); }
.post-poll__choice:has(input:disabled) { opacity: 0.55; cursor: not-allowed; }
.post-poll__choice input { flex: none; width: 1.15rem; height: 1.15rem; }
.post-poll__choice:focus-within,
.post-poll__scale-value:focus-within { outline: 0.18rem solid var(--accent); outline-offset: 0.1rem; }
.post-poll__scale { display: flex; flex-wrap: wrap; gap: 0.3rem; }
.post-poll__scale-value { position: relative; display: inline-flex; align-items: center; justify-content: center; min-width: 2.75rem; min-height: 2.75rem; border: 1px solid var(--line); border-radius: 0.45rem; cursor: pointer; font-weight: 600; }
.post-poll__scale-value input { position: absolute; opacity: 0; inset: 0; cursor: pointer; }
.post-poll__scale-value:has(input:checked) { border-color: var(--accent); background: var(--accent); color: #fff; }
.post-poll__rank { display: grid; gap: 0.3rem; margin: 0; padding: 0; list-style: none; }
.post-poll__rank-item { display: grid; grid-template-columns: auto auto minmax(0, 1fr) 2.75rem 2.75rem; gap: 0.4rem; align-items: center; min-height: 2.75rem; padding-left: 0.5rem; border: 1px solid var(--line); border-radius: 0.45rem; background: var(--surface); }
.post-poll__rank-item--dragging { opacity: 0.5; }
.post-poll__rank-place { display: inline-flex; align-items: center; justify-content: center; min-width: 1.5rem; height: 1.5rem; border-radius: 999px; background: var(--surface-soft); color: var(--ink); font-size: 0.78rem; font-weight: 700; }
.post-poll__grip { color: var(--muted); cursor: grab; }
.post-poll__rank-label { overflow-wrap: anywhere; }
.post-poll__icon { display: inline-flex; align-items: center; justify-content: center; width: 2.75rem; height: 2.75rem; border: 0; border-left: 1px solid var(--line); background: transparent; color: var(--ink); }
.post-poll__icon:disabled { opacity: 0.35; }
.post-poll__icon:focus-visible { outline: 0.18rem solid var(--accent); outline-offset: -0.2rem; }
.post-poll__actions,
.post-poll__foot { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; }
.post-poll__actions .primary-button,
.post-poll__actions .ghost-button,
.post-poll__foot .ghost-button { min-height: 2.75rem; }
.post-poll__foot { justify-content: flex-start; }
.post-poll__count { margin-right: auto; color: var(--muted); font-size: 0.82rem; }
.post-poll__bars,
.post-poll__answers { display: grid; gap: 0.45rem; margin: 0; padding: 0; list-style: none; }
.post-poll__bars--compact { gap: 0.25rem; }
.post-poll__bar { display: grid; gap: 0.2rem; }
.post-poll__bar-line { display: flex; justify-content: space-between; gap: 0.5rem; font-size: 0.88rem; }
.post-poll__bar-label { display: inline-flex; align-items: center; gap: 0.3rem; min-width: 0; overflow-wrap: anywhere; }
.post-poll__bar--mine .post-poll__bar-label { font-weight: 600; }
.post-poll__bar-count { flex: none; color: var(--muted); font-variant-numeric: tabular-nums; }
.post-poll__track { display: block; height: 0.5rem; overflow: hidden; border-radius: 999px; background: var(--surface-soft); }
.post-poll__fill { display: block; height: 100%; border-radius: inherit; background: var(--accent); }
.post-poll__voters { color: var(--muted); font-size: 0.76rem; }
.post-poll__answer { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.4rem; padding: 0.4rem 0.6rem; border-radius: 0.4rem; background: var(--surface-soft); }
.post-poll__answer-text { overflow-wrap: anywhere; }
.post-poll__answer-count { color: var(--ink-soft); font-weight: 700; }
.post-poll__answer .post-poll__voters { flex-basis: 100%; }
.post-poll__average { display: flex; align-items: baseline; gap: 0.4rem; margin: 0 0 0.35rem; }
.post-poll__average strong { font-size: 1.6rem; }
.post-poll__average span { color: var(--muted); font-size: 0.85rem; }
</style>
