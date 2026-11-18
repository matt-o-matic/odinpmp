<script setup>
import { onBeforeUnmount, ref, useId } from 'vue';

// Odin's avatar with a small sparkle at the bottom right. The sparkle is the only sign that Odin is
// AI: no label next to its name. Hover, focus or a tap (iPad has no hover) shows a short hint.
// Inside a link, pass `interactive: false`: the avatar is then plain decoration and the hint is a
// native title, so the link stays the only control.
const props = defineProps({
  interactive: { default: true, type: Boolean },
  // Rendered width and height in px.
  size: { default: 32, type: Number },
});

const hint = 'Odin is an AI assistant';
const src = `${String(import.meta.env.BASE_URL || '/').replace(/\/?$/, '/')}brand/odin-mark-192.png`;
const tipId = `odin-avatar-tip-${useId()}`;
const open = ref(false);
const root = ref(null);

function onDocumentPointer(event) {
  if (root.value && !root.value.contains(event.target)) setOpen(false);
}

function setOpen(value) {
  if (!props.interactive || open.value === value) return;
  open.value = value;
  if (value) document.addEventListener('pointerdown', onDocumentPointer, true);
  else document.removeEventListener('pointerdown', onDocumentPointer, true);
}

onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocumentPointer, true));
</script>

<template>
  <button
    v-if="interactive"
    ref="root"
    class="odin-avatar odin-avatar--interactive"
    type="button"
    :style="{ '--odin-avatar-size': `${size}px` }"
    :aria-label="hint"
    :aria-describedby="open ? tipId : undefined"
    @blur="setOpen(false)"
    @click="setOpen(!open)"
    @focus="setOpen(true)"
    @keydown.esc="setOpen(false)"
    @mouseenter="setOpen(true)"
    @mouseleave="setOpen(false)"
  >
    <img class="odin-avatar__mark" :src="src" alt="" :width="size" :height="size" />
    <span class="odin-avatar__spark" aria-hidden="true">✨</span>
    <span v-if="open" :id="tipId" class="odin-avatar__tip" role="tooltip">{{ hint }}</span>
  </button>
  <span v-else class="odin-avatar" :style="{ '--odin-avatar-size': `${size}px` }" :title="hint" aria-hidden="true">
    <img class="odin-avatar__mark" :src="src" alt="" :width="size" :height="size" />
    <span class="odin-avatar__spark">✨</span>
  </span>
</template>

<style scoped>
.odin-avatar { position: relative; display: inline-grid; flex: none; place-items: center; width: var(--odin-avatar-size); height: var(--odin-avatar-size); padding: 0; border: 0; border-radius: 50%; background: var(--surface-soft); }
.odin-avatar--interactive { cursor: help; }
/* Widen the tap target past the 32px avatar without moving the layout. */
.odin-avatar--interactive::before { position: absolute; inset: -0.375rem; content: ''; }
.odin-avatar--interactive:focus-visible { outline: 0.18rem solid var(--accent); outline-offset: 0.1rem; }
.odin-avatar__mark { width: 100%; height: 100%; padding: 12%; object-fit: contain; }
.odin-avatar__spark { position: absolute; right: -12%; bottom: -12%; display: grid; place-items: center; width: 55%; height: 55%; border: 1px solid var(--line); border-radius: 50%; background: var(--surface); font-size: calc(var(--odin-avatar-size) * 0.3); line-height: 1; }
/* Above the avatar, so it never covers the name and time beside it. */
.odin-avatar__tip { position: absolute; bottom: calc(100% + 0.45rem); left: 0; z-index: 20; padding: 0.3rem 0.55rem; border-radius: 0.35rem; background: var(--ink); color: var(--surface); font-size: 0.75rem; font-weight: 600; white-space: nowrap; pointer-events: none; }
</style>
