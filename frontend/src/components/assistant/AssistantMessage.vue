<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';

import { activitySummary, liveStatus, parseOdinHref, planProgress, renderAssistantMarkdown } from '../../lib/assistant/assistant-format.js';
import { splitAssistantContent } from '../../lib/assistant/assistant-visuals.js';
import AssistantChangesCard from './AssistantChangesCard.vue';
import AssistantProposalCard from './AssistantProposalCard.vue';
import AssistantVisual from './AssistantVisual.vue';
import AssistantTypingDots from './AssistantTypingDots.vue';

// One message in a chat. An assistant message shows its plan, a collapsible line for the tools it
// used, the reply, sources, any confirmation or proposal card, and what it changed in Odin (with
// an undo). `live` marks the reply still being written.
const props = defineProps({
  apiBaseUrl: { default: undefined, type: String },
  busy: { default: false, type: Boolean },
  live: { default: false, type: Boolean },
  // The live turn (phase and start time) behind the working indicator.
  liveState: { default: null, type: Object },
  message: { required: true, type: Object },
  pendingCallId: { default: null, type: String },
  undoing: { default: false, type: Boolean },
});
const emit = defineEmits(['confirm', 'open-link', 'resolve-proposal', 'undo']);

const activityOpen = ref(false);
const planOpen = ref(props.live);
const copied = ref(false);

// Text renders as markdown; ```chart, ```mermaid and ```dot blocks render as visuals.
const segments = computed(() => splitAssistantContent(props.message.content ?? '').map((segment) => (segment.kind === 'text' ? { ...segment, html: renderAssistantMarkdown(segment.text, props.apiBaseUrl) } : segment)));
const activity = computed(() => props.message.activity ?? []);
// While the reply is live, a clock keeps the indicator's label and elapsed time current.
const now = ref(Date.now());
let clock = null;
watch(() => props.live, (live) => {
  if (live && !clock) clock = setInterval(() => { now.value = Date.now(); }, 500);
  if (!live && clock) { clearInterval(clock); clock = null; }
}, { immediate: true });
onBeforeUnmount(() => { if (clock) clearInterval(clock); });
const status = computed(() => (props.live ? liveStatus(props.liveState ?? { activity: activity.value, startedAt: new Date().toISOString() }, now.value) : null));
// Identical errors in a row read once.
const errorText = (entry, index) => (entry.error && index > 0 && activity.value[index - 1].error === entry.error ? 'same reason' : entry.error);
const plan = computed(() => props.message.plan ?? null);
const progress = computed(() => planProgress(plan.value));
const confirmation = computed(() => props.message.confirmation ?? null);
const awaitingAnswer = computed(() => confirmation.value?.status === 'pending' && confirmation.value.callId === props.pendingCallId);
const CONFIRMATION_OUTCOMES = { approved: 'You confirmed this.', declined: 'You cancelled this.', pending: 'This is no longer waiting.', skipped: 'Skipped when you sent a new message.' };
const STEP_ICONS = { done: 'bi-check-circle-fill', in_progress: 'bi-arrow-right-circle', pending: 'bi-circle', skipped: 'bi-dash-circle' };

function handleContentClick(event) {
  const anchor = event.target.closest?.('a');
  if (!anchor) return;
  const target = parseOdinHref(anchor.getAttribute('href'));
  if (target) {
    event.preventDefault();
    emit('open-link', target);
    return;
  }
  if (/^https?:/i.test(anchor.getAttribute('href') ?? '')) {
    event.preventDefault();
    window.open(anchor.href, '_blank', 'noopener');
  }
}

async function copyReply() {
  try {
    await navigator.clipboard.writeText(props.message.content ?? '');
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 1500);
  } catch {
    copied.value = false;
  }
}
</script>

<template>
  <article v-if="message.role === 'user'" class="message message--user" aria-label="Your message">
    <div class="message__bubble">
      <p class="message__text">{{ message.content }}</p>
      <ul v-if="message.attachments?.length" class="message__files">
        <li v-for="file in message.attachments" :key="file.name">
          <i class="bi" :class="file.mimeType?.startsWith('image/') ? 'bi-image' : 'bi-file-earmark-text'" aria-hidden="true"></i>
          {{ file.name }}
        </li>
      </ul>
    </div>
  </article>

  <article v-else class="message message--assistant" :aria-label="live ? 'Assistant reply in progress' : 'Assistant reply'" :aria-busy="live ? 'true' : undefined">
    <div v-if="plan?.length" class="message__plan">
      <button class="message__toggle" type="button" :aria-expanded="planOpen" @click="planOpen = !planOpen">
        <i class="bi bi-list-check" aria-hidden="true"></i>
        Plan · {{ progress.done }} of {{ progress.total }} done
        <i class="bi" :class="planOpen ? 'bi-chevron-up' : 'bi-chevron-down'" aria-hidden="true"></i>
      </button>
      <ol v-if="planOpen" class="message__steps">
        <li v-for="(step, index) in plan" :key="index" :class="`message__step message__step--${step.status}`">
          <i class="bi" :class="STEP_ICONS[step.status] ?? 'bi-circle'" aria-hidden="true"></i>
          <span>{{ step.title }}</span>
          <span class="visually-hidden">({{ step.status.replace('_', ' ') }})</span>
        </li>
      </ol>
    </div>

    <div v-if="activity.length" class="message__activity">
      <button class="message__toggle" type="button" :aria-expanded="activityOpen" @click="activityOpen = !activityOpen">
        <i class="bi bi-tools" aria-hidden="true"></i>
        <span>{{ activitySummary(activity) }}</span>
        <i class="bi" :class="activityOpen ? 'bi-chevron-up' : 'bi-chevron-down'" aria-hidden="true"></i>
      </button>
      <ul v-if="activityOpen" class="message__tools">
        <li v-for="(entry, index) in activity" :key="entry.callId" :class="{ 'message__tool--failed': entry.ok === false }">
          <span v-if="entry.status === 'running'" class="spinner-border spinner-border-sm" aria-hidden="true"></span>
          <i v-else class="bi" :class="entry.ok === false ? 'bi-x-circle' : 'bi-check2'" aria-hidden="true"></i>
          <span class="message__tool-label">{{ entry.label }}</span>
          <span v-if="entry.error" class="message__tool-error">{{ errorText(entry, index) }}</span>
        </li>
      </ul>
    </div>

    <div v-if="message.content" class="message__content rich-copy" @click="handleContentClick">
      <template v-for="(segment, index) in segments" :key="index">
        <AssistantVisual v-if="segment.kind === 'visual'" :visual="segment" />
        <!-- eslint-disable-next-line vue/no-v-html -- rendered by renderRichTextToHtml, which sanitizes -->
        <div v-else class="message__markdown" v-html="segment.html"></div>
      </template>
    </div>
    <p v-if="message.error" class="message__error" role="alert">
      <i class="bi bi-exclamation-triangle" aria-hidden="true"></i>
      {{ message.error }}
    </p>

    <ul v-if="message.citations?.length" class="message__sources" aria-label="Sources">
      <li v-for="source in message.citations" :key="source.url">
        <a :href="source.url" target="_blank" rel="noopener">{{ source.title }}</a>
      </li>
    </ul>

    <section v-if="confirmation" class="message__confirm" :class="{ 'message__confirm--open': awaitingAnswer }" aria-label="Confirmation">
      <p class="message__confirm-title">
        <i class="bi bi-shield-exclamation" aria-hidden="true"></i>
        {{ confirmation.label }}{{ confirmation.target ? `: ${confirmation.target}` : '' }}
      </p>
      <div v-if="awaitingAnswer" class="message__confirm-actions">
        <button class="btn btn-danger" type="button" :disabled="busy" @click="emit('confirm', 'approve')">Confirm</button>
        <button class="btn btn-outline-secondary" type="button" :disabled="busy" @click="emit('confirm', 'decline')">Cancel</button>
      </div>
      <p v-else class="message__confirm-detail">{{ CONFIRMATION_OUTCOMES[confirmation.status] }}</p>
    </section>

    <AssistantProposalCard v-if="message.proposal" :busy="busy" :proposal="message.proposal" @resolve="emit('resolve-proposal', $event)" />

    <AssistantChangesCard v-if="message.changes?.records?.length && !live" :busy="busy" :changes="message.changes" :undoing="undoing" @undo="emit('undo', message.id)" />

    <p v-if="status" class="message__status" role="status">
      <AssistantTypingDots />
      <span>{{ status.label }}</span>
      <span v-if="status.elapsed" class="message__elapsed" aria-hidden="true">{{ status.elapsed }}</span>
    </p>

    <div v-if="message.content && !live" class="message__tools-row">
      <button class="message__icon" type="button" :aria-label="copied ? 'Copied' : 'Copy reply'" :title="copied ? 'Copied' : 'Copy reply'" @click="copyReply">
        <i class="bi" :class="copied ? 'bi-check2' : 'bi-copy'" aria-hidden="true"></i>
      </button>
    </div>
  </article>
</template>

<style scoped>
.message {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  max-width: 100%;
}

.message--user {
  align-items: flex-end;
}

.message__bubble {
  background: var(--accent-deep);
  border-radius: 1rem 1rem 0.25rem 1rem;
  color: #fff;
  max-width: min(85%, 40rem);
  padding: 0.6rem 0.9rem;
}

.message__text {
  font-size: 1rem;
  margin: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.message__files {
  display: flex;
  flex-wrap: wrap;
  font-size: 0.8rem;
  gap: 0.5rem;
  list-style: none;
  margin: 0.4rem 0 0;
  opacity: 0.9;
  padding: 0;
}

.message__toggle {
  align-items: center;
  background: none;
  border: 0;
  border-radius: 0.5rem;
  color: var(--muted);
  display: inline-flex;
  font-size: 0.85rem;
  gap: 0.45rem;
  min-height: 2.75rem;
  padding: 0 0.4rem;
}

.message__toggle:hover {
  background: var(--surface-tint);
  color: var(--ink);
}

.message__status {
  align-items: center;
  color: var(--ink-soft);
  display: flex;
  font-size: 0.875rem;
  gap: 0.6rem;
  margin: 0;
  min-height: 2.75rem;
  padding: 0 0.4rem;
}

.message__elapsed {
  color: var(--muted);
  font-size: 0.8rem;
  font-variant-numeric: tabular-nums;
}

.message__steps,
.message__tools {
  display: flex;
  flex-direction: column;
  font-size: 0.85rem;
  gap: 0.3rem;
  list-style: none;
  margin: 0 0 0 0.4rem;
  padding: 0.25rem 0 0.25rem 0.75rem;
  border-left: 2px solid var(--line);
}

/* The icon is the bullet: wrapped lines and the error line up with the text, not under it. */
.message__step,
.message__tools li {
  align-items: baseline;
  color: var(--ink-soft);
  display: grid;
  gap: 0.1rem 0.5rem;
  grid-template-columns: 1rem minmax(0, 1fr);
}

.message__step--done {
  color: var(--muted);
  text-decoration: line-through;
}

.message__step--done .bi {
  color: var(--success);
}

.message__step--in_progress {
  color: var(--ink);
  font-weight: 600;
}

.message__tool--failed {
  color: var(--danger) !important;
}

.message__tool-error {
  color: var(--muted);
  font-size: 0.8rem;
  grid-column: 2;
}

.message__content {
  color: var(--ink);
  font-size: 1rem;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.message__markdown :deep(> :first-child) {
  margin-top: 0;
}

.message__content > :last-child,
.message__markdown:last-child :deep(> :last-child) {
  margin-bottom: 0;
}

.message__markdown :deep(h1),
.message__markdown :deep(h2),
.message__markdown :deep(h3),
.message__markdown :deep(h4) {
  color: var(--ink);
  border: 0;
  font-family: var(--font-sans);
  font-weight: 700;
  letter-spacing: normal;
  line-height: 1.3;
  margin: 1.1rem 0 0.4rem;
  padding: 0;
  text-transform: none;
}

/* The legacy stylesheet sizes h3-h5 with !important; keep reply headings in proportion. */
.message__markdown :deep(h1) { font-size: 1.25rem !important; }
.message__markdown :deep(h2) { font-size: 1.12rem !important; }
.message__markdown :deep(h3) { font-size: 1.02rem !important; }
.message__markdown :deep(h4) { font-size: 0.95rem !important; }

.message__markdown :deep(p),
.message__markdown :deep(ul),
.message__markdown :deep(ol),
.message__markdown :deep(blockquote),
.message__markdown :deep(pre),
.message__markdown :deep(table) {
  margin: 0 0 0.7rem;
}

.message__markdown :deep(ul),
.message__markdown :deep(ol) {
  padding-left: 1.4rem;
}

.message__markdown :deep(li + li) {
  margin-top: 0.2rem;
}

.message__markdown :deep(a) {
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.message__markdown :deep(code) {
  background: var(--surface-tint);
  border-radius: 0.3rem;
  color: var(--ink-soft);
  font-family: var(--font-mono);
  font-size: 0.85em;
  padding: 0.05rem 0.3rem;
}

/* .rich-copy pre is light text on a dark panel; replies use the soft surface, so set the ink too. */
.message__markdown :deep(pre) {
  background: var(--surface-soft);
  border: 1px solid var(--line);
  border-radius: 0.6rem;
  color: var(--ink);
  overflow-x: auto;
  padding: 0.75rem;
}

.message__markdown :deep(pre code) {
  background: none;
  color: inherit;
  padding: 0;
}

.message__markdown :deep(table) {
  border-collapse: collapse;
  display: block;
  font-size: 0.9rem;
  max-width: 100%;
  overflow-x: auto;
}

.message__markdown :deep(th),
.message__markdown :deep(td) {
  border: 1px solid var(--line);
  padding: 0.35rem 0.6rem;
  text-align: left;
  vertical-align: top;
}

.message__markdown :deep(th) {
  background: var(--surface-soft);
  font-weight: 600;
}

.message__markdown :deep(blockquote) {
  border-left: 3px solid var(--line-strong);
  color: var(--ink-soft);
  padding-left: 0.75rem;
}

.message__error {
  align-items: flex-start;
  background: color-mix(in srgb, var(--danger) 10%, transparent);
  border-radius: 0.6rem;
  color: var(--danger);
  display: flex;
  font-size: 0.9rem;
  gap: 0.5rem;
  margin: 0;
  padding: 0.6rem 0.8rem;
}

.message__sources {
  border-top: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  font-size: 0.82rem;
  gap: 0.2rem;
  list-style: none;
  margin: 0;
  padding: 0.5rem 0 0;
}

.message__sources a {
  color: var(--accent);
}

.message__confirm {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 0.75rem;
  padding: 0.75rem 0.9rem;
}

.message__confirm--open {
  border-color: var(--danger);
  border-left-width: 3px;
}

.message__confirm-title {
  align-items: center;
  color: var(--ink);
  display: flex;
  font-weight: 600;
  gap: 0.5rem;
  margin: 0;
}

.message__confirm-detail {
  color: var(--muted);
  font-size: 0.85rem;
  margin: 0.3rem 0 0;
}

.message__confirm-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.6rem;
}

.message__confirm-actions .btn {
  min-height: 2.75rem;
  min-width: 6rem;
}

.message__tools-row {
  display: flex;
}

.message__icon {
  background: none;
  border: 0;
  border-radius: 0.5rem;
  color: var(--muted);
  min-height: 2.75rem;
  min-width: 2.75rem;
}

.message__icon:hover {
  background: var(--surface-tint);
  color: var(--ink);
}
</style>
