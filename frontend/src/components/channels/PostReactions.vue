<script setup>
import { onBeforeUnmount, ref, useId } from 'vue';

import { reactionButtonLabel, whoReacted } from '../../lib/channels/reactions.js';
import EmojiPicker from './EmojiPicker.vue';

// The reactions under a message (docs/engagements/plan.md, Reactions): each emoji with its count,
// marked when one is yours; pressing one adds or takes back yours. Hovering, focusing or a long
// press shows who reacted. "Add reaction" here, or React in the message's actions (openPicker),
// opens the picker.
const props = defineProps({
  canReact: { default: false, type: Boolean },
  // Whose message, for the picker's name.
  label: { default: '', type: String },
  reactions: { default: () => [], type: Array },
});

const emit = defineEmits(['toggle']);

const uid = useId();
const picker = ref({ anchor: null, open: false });
const showing = ref('');
let pressTimer = 0;
let pressed = false;

function openPicker(anchor) {
  picker.value = { anchor, open: true };
}

function toggle(reaction) {
  if (pressed) {
    pressed = false;
    return;
  }
  if (props.canReact) emit('toggle', { emoji: reaction.emoji, reacted: !reaction.mine });
}

function pick(emoji) {
  const found = props.reactions.find((reaction) => reaction.emoji === emoji);
  // Picking one you already added leaves it, as a second press would not.
  if (!found?.mine) emit('toggle', { emoji, reacted: true });
}

// A long press on a touch screen shows who reacted instead of toggling.
function pressStart(reaction, event) {
  if (event.pointerType !== 'touch') return;
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    pressed = true;
    showing.value = reaction.emoji;
  }, 500);
}

function pressEnd() {
  clearTimeout(pressTimer);
}

onBeforeUnmount(() => clearTimeout(pressTimer));

defineExpose({ openPicker });
</script>

<template>
  <div v-if="reactions.length" class="post-reactions" role="group" aria-label="Reactions">
    <span v-for="(reaction, index) in reactions" :key="reaction.emoji" class="post-reactions__item" @mouseenter="showing = reaction.emoji" @mouseleave="showing = ''">
      <button
        class="post-reactions__chip"
        :class="{ 'post-reactions__chip--mine': reaction.mine }"
        type="button"
        :aria-pressed="reaction.mine"
        :aria-label="reactionButtonLabel(reaction)"
        :aria-describedby="showing === reaction.emoji ? `${uid}-who-${index}` : undefined"
        :disabled="!canReact"
        @blur="showing = ''"
        @click="toggle(reaction)"
        @focus="showing = reaction.emoji"
        @pointercancel="pressEnd"
        @pointerdown="pressStart(reaction, $event)"
        @pointerup="pressEnd"
        @contextmenu.prevent
      >
        <span class="post-reactions__emoji" aria-hidden="true">{{ reaction.emoji }}</span>
        <span class="post-reactions__count" aria-hidden="true">{{ reaction.count }}</span>
      </button>
      <span v-if="showing === reaction.emoji" :id="`${uid}-who-${index}`" class="post-reactions__who" role="tooltip">{{ whoReacted(reaction) }} reacted with {{ reaction.emoji }}</span>
    </span>
    <button v-if="canReact" class="post-reactions__chip post-reactions__add" type="button" :aria-label="`Add a reaction to ${label ? `${label}'s` : 'this'} message`" title="Add reaction" @click="openPicker($event.currentTarget)">
      <i class="bi bi-emoji-smile" aria-hidden="true"></i><span aria-hidden="true">+</span>
    </button>
  </div>
  <EmojiPicker :anchor="picker.anchor" :label="`React to ${label ? `${label}'s` : 'this'} message`" :open="picker.open" @close="picker = { anchor: picker.anchor, open: false }" @pick="pick" />
</template>

<style scoped>
.post-reactions { display: flex; flex-wrap: wrap; gap: 0.3rem; }
.post-reactions__item { position: relative; display: inline-flex; }
.post-reactions__chip { display: inline-flex; align-items: center; gap: 0.3rem; min-height: 1.9rem; padding: 0 0.55rem; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); color: var(--ink-soft); font-size: 0.8rem; font-weight: 600; line-height: 1; }
.post-reactions__chip:hover:not(:disabled) { border-color: var(--line-strong); background: var(--surface-soft); }
.post-reactions__chip:disabled { cursor: default; opacity: 1; }
.post-reactions__chip--mine { border-color: color-mix(in srgb, var(--accent) 60%, var(--line)); background: color-mix(in srgb, var(--accent) 12%, var(--surface)); color: var(--ink); }
.post-reactions__chip:focus-visible { outline: 0.18rem solid var(--accent); outline-offset: 0.1rem; }
.post-reactions__emoji { font-size: 1rem; }
.post-reactions__add { color: var(--muted); }
.post-reactions__who { position: absolute; bottom: calc(100% + 0.35rem); left: 0; z-index: 5; width: max-content; max-width: 16rem; padding: 0.35rem 0.55rem; border-radius: 0.35rem; background: var(--ink); color: var(--surface); font-size: 0.75rem; font-weight: 500; line-height: 1.35; pointer-events: none; box-shadow: 0 0.3rem 0.8rem rgba(15, 23, 42, 0.2); }
@media (pointer: coarse) {
  .post-reactions__chip { min-height: 2.75rem; padding: 0 0.7rem; }
}
</style>
