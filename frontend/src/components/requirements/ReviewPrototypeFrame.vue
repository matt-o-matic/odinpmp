<script setup>
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch } from 'vue';

import {
  FRAME_SANDBOX,
  captureCommand,
  createRequestTracker,
  fitScale,
  frameSrc,
  gotoStateCommand,
  hintCommand,
  matchDeclaredState,
  nextRequestId,
  parseBridgeMessage,
  pingCommand,
} from '../../lib/requirements/review-bridge.js';

// A prototype screen from a review package, running in a sandboxed frame on the review
// origin (plan.md, Hosting and isolation). The frame renders at the manifest's viewport
// size and is scaled down to fit. The bridge inside reports state; this component sends
// it commands. Every message is checked against this frame and treated as untrusted data.
//
// Exposed: capture(options) and hint(x, y) return promises that always resolve, with
// `{ ok: false, reason }` on failure or timeout; gotoState(key); ping(); state; ready.
// The team preview uses Browse only; the stakeholder portal adds Annotate on top. The
// `overlay` slot draws over the frame at its shown size and gets the frame's `scale`.

const props = defineProps({
  // Defaults to this window's origin; the review origin only answers allowed app origins.
  appOrigin: { default: '', type: String },
  captureTimeoutMs: { default: 25_000, type: Number },
  entryUrl: { default: '', type: String },
  hintTimeoutMs: { default: 4_000, type: Number },
  readyTimeoutMs: { default: 10_000, type: Number },
  showStates: { default: true, type: Boolean },
  // Manifest `states`: [{ key, label }]
  states: { default: () => [], type: Array },
  title: { required: true, type: String },
  // Manifest `viewport`: { width, height }
  viewport: { required: true, type: Object },
});

const emit = defineEmits(['ready', 'scroll', 'state', 'status', 'viewport']);

const statesLabelId = useId();
const box = ref(null);
const frame = ref(null);
const availableWidth = ref(0);
const status = ref('connecting');
const state = shallowRef(null);
const frameViewport = shallowRef(null);
const announcement = ref('');
const tracker = createRequestTracker();
let resizeObserver = null;
let readyTimer = null;

const width = computed(() => Math.max(1, Math.round(Number(props.viewport?.width) || 1280)));
const height = computed(() => Math.max(1, Math.round(Number(props.viewport?.height) || 800)));
const scale = computed(() => fitScale(width.value, availableWidth.value || width.value));
const origin = computed(() => props.appOrigin || (typeof window !== 'undefined' ? window.location.origin : ''));
const src = computed(() => frameSrc(props.entryUrl, origin.value));
const ready = computed(() => status.value === 'ready');
const declaredStates = computed(() => (Array.isArray(props.states) ? props.states : [])
  .filter((entry) => entry && typeof entry.key === 'string')
  .map((entry) => ({ key: entry.key, label: String(entry.label ?? entry.key) })));
const currentStateKey = computed(() => matchDeclaredState(state.value, declaredStates.value));
const currentStateLabel = computed(() => {
  const declared = declaredStates.value.find((entry) => entry.key === currentStateKey.value);
  if (declared) return declared.label;
  return state.value?.key ?? '';
});
const statusText = computed(() => {
  if (!src.value) return 'Prototype unavailable';
  if (status.value === 'ready') return currentStateLabel.value ? `Showing ${currentStateLabel.value}` : 'Ready';
  if (status.value === 'unresponsive') return 'Not responding';
  return 'Loading…';
});

function setStatus(next) {
  if (status.value === next) return;
  status.value = next;
  emit('status', next);
}

function clearReadyTimer() {
  if (readyTimer) clearTimeout(readyTimer);
  readyTimer = null;
}

function armReadyTimer() {
  clearReadyTimer();
  if (!src.value) return;
  readyTimer = setTimeout(() => {
    readyTimer = null;
    if (status.value !== 'ready') {
      setStatus('unresponsive');
      announcement.value = 'The prototype has not answered. Its states and snapshots are unavailable until it does.';
    }
  }, props.readyTimeoutMs);
}

function post(command) {
  const target = frame.value?.contentWindow;
  if (!target || !command) return false;
  // The frame's origin is opaque, so no target origin can name it. Commands carry no data
  // the prototype could not already see.
  target.postMessage(command, '*');
  return true;
}

function handleMessage(event) {
  const message = parseBridgeMessage(event, frame.value?.contentWindow ?? null);
  if (!message) return;
  switch (message.type) {
    case 'ready': {
      clearReadyTimer();
      state.value = message.state;
      frameViewport.value = message.viewport;
      const wasReady = status.value === 'ready';
      setStatus('ready');
      if (!wasReady) announcement.value = `Prototype ready${currentStateLabel.value ? `, showing ${currentStateLabel.value}` : ''}.`;
      emit('ready', { scroll: message.scroll, state: message.state, viewport: message.viewport });
      break;
    }
    case 'state':
      state.value = message.state;
      announcement.value = currentStateLabel.value ? `Showing ${currentStateLabel.value}.` : '';
      emit('state', message.state);
      break;
    case 'scroll':
      emit('scroll', message.scroll);
      break;
    case 'viewport':
      frameViewport.value = message.viewport;
      emit('viewport', { scroll: message.scroll, viewport: message.viewport });
      break;
    case 'capture':
      tracker.settle(message.requestId, {
        dataUrl: message.dataUrl,
        height: message.height,
        ok: true,
        scroll: message.scroll,
        stateKey: message.stateKey,
        width: message.width,
      });
      break;
    case 'capture-failed':
      tracker.settle(message.requestId, { ok: false, reason: message.reason });
      break;
    case 'hint':
      tracker.settle(message.requestId, { hint: message.hint, ok: true, x: message.x, y: message.y });
      break;
    default:
      break;
  }
}

function resetFrameState(reason) {
  clearReadyTimer();
  state.value = null;
  frameViewport.value = null;
  tracker.cancelAll((kind) => (kind === 'hint' ? { hint: null, ok: false, reason } : { ok: false, reason }));
  setStatus('connecting');
}

function onFrameLoad() {
  // The bridge sends `ready` once the document is parsed; ask again in case it went out
  // before this frame was listening, or after a navigation inside the prototype.
  if (status.value !== 'ready') post(pingCommand());
}

/** Asks the bridge for a PNG of the visible frame. Resolves `{ ok, dataUrl, width, height, stateKey, scroll }` or `{ ok: false, reason }`. */
function capture({ scale: captureScale = 1 } = {}) {
  if (!ready.value) return Promise.resolve({ ok: false, reason: 'The prototype is not ready yet.' });
  const requestId = nextRequestId('capture');
  const result = tracker.start(requestId, {
    kind: 'capture',
    onTimeout: () => ({ ok: false, reason: 'The snapshot took too long.' }),
    timeoutMs: props.captureTimeoutMs,
  });
  if (!post(captureCommand({ requestId, scale: captureScale }))) tracker.settle(requestId, { ok: false, reason: 'The prototype is not loaded.' });
  return result;
}

/** Asks which element sits at (x, y) in frame CSS pixels. Resolves `{ ok, hint, x, y }` or `{ ok: false, hint: null, reason }`. */
function hint(x, y) {
  if (!ready.value) return Promise.resolve({ hint: null, ok: false, reason: 'The prototype is not ready yet.' });
  const requestId = nextRequestId('hint');
  const result = tracker.start(requestId, {
    kind: 'hint',
    onTimeout: () => ({ hint: null, ok: false, reason: 'The prototype did not answer in time.' }),
    timeoutMs: props.hintTimeoutMs,
  });
  if (!post(hintCommand({ requestId, x, y }))) tracker.settle(requestId, { hint: null, ok: false, reason: 'The prototype is not loaded.' });
  return result;
}

/** Jumps to a declared state. Returns false for a key the bridge would ignore. */
function gotoState(key) {
  const command = gotoStateCommand(key);
  if (!command || !ready.value) return false;
  return post(command);
}

function ping() {
  return post(pingCommand());
}

function measure() {
  availableWidth.value = box.value?.clientWidth ?? 0;
}

onMounted(() => {
  window.addEventListener('message', handleMessage);
  measure();
  if (typeof ResizeObserver !== 'undefined' && box.value) {
    resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(box.value);
  }
  armReadyTimer();
});

onBeforeUnmount(() => {
  window.removeEventListener('message', handleMessage);
  resizeObserver?.disconnect();
  resizeObserver = null;
  resetFrameState('The prototype closed.');
});

watch(src, () => {
  resetFrameState('The prototype reloaded.');
  armReadyTimer();
});

defineExpose({ capture, frameViewport, gotoState, hint, ping, ready, state });
</script>

<template>
  <div class="rq-proto">
    <div v-if="showStates && declaredStates.length" class="rq-proto__bar">
      <span :id="statesLabelId" class="rq-xs rq-muted">States</span>
      <div class="rq-proto__states" role="group" :aria-labelledby="statesLabelId">
        <button
          v-for="entry in declaredStates"
          :key="entry.key"
          class="rq-proto__state"
          :class="{ 'rq-proto__state--on': currentStateKey === entry.key }"
          type="button"
          :aria-pressed="currentStateKey === entry.key ? 'true' : 'false'"
          :disabled="!ready"
          @click="gotoState(entry.key)"
        >
          <i v-if="currentStateKey === entry.key" class="bi bi-check2" aria-hidden="true"></i>{{ entry.label }}
        </button>
      </div>
    </div>

    <div class="rq-proto__window">
      <div class="rq-proto__chrome">
        <i class="bi bi-shield-lock" aria-hidden="true"></i>
        <span class="rq-proto__label">Sandboxed prototype</span>
        <span class="rq-grow"></span>
        <span class="rq-proto__status" :class="`rq-proto__status--${src ? status : 'unavailable'}`" data-testid="rq-proto-status">{{ statusText }}</span>
        <span class="rq-proto__size"><span aria-hidden="true">· </span>{{ width }} × {{ height }}</span>
      </div>
      <div ref="box" class="rq-proto__box" :style="{ height: `${Math.round(height * scale)}px` }">
        <div class="rq-proto__viewport" :style="{ width: `${width}px`, height: `${height}px`, transform: `scale(${scale})` }">
          <iframe
            v-if="src"
            ref="frame"
            :key="src"
            class="rq-proto__frame"
            :height="height"
            referrerpolicy="no-referrer"
            :sandbox="FRAME_SANDBOX"
            :src="src"
            :title="title"
            :width="width"
            @load="onFrameLoad"
          ></iframe>
          <div v-else class="rq-proto__unavailable">
            <p class="mb-0"><strong>Prototype unavailable</strong></p>
          </div>
        </div>
        <!-- Drawn over the frame at its shown size, for example the marks on the current state. -->
        <div v-if="$slots.overlay" class="rq-proto__overlay" :style="{ width: `${width * scale}px`, height: `${height * scale}px` }">
          <slot name="overlay" :scale="scale"></slot>
        </div>
      </div>
    </div>
    <!-- Prototype scripts can still reach other hosts over WebRTC (plan.md, "Hosting and isolation"). -->
    <p v-if="src" class="rq-proto__notice" data-testid="rq-proto-notice">
      <i class="bi bi-info-circle" aria-hidden="true"></i>
      <span>This is a mockup. Don't type real personal or payment details into it.</span>
    </p>
    <p class="visually-hidden" role="status">{{ announcement }}</p>
  </div>
</template>
