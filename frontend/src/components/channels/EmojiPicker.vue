<script setup>
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';

import { EMOJI_GROUPS, QUICK_REACTIONS, loadEmojiCatalog, searchEmoji } from '../../lib/channels/reactions.js';

// The emoji picker: the quick row, a search, and every emoji by group. Reactions use it, and so
// does the editor's emoji button, which inserts one. It sits on the page, not in the
// conversation, so the scrolling list never cuts it off; on a phone it is a sheet along the
// bottom. The emoji list downloads the first time a picker opens.
const props = defineProps({
  // The button that opened it: the picker sits next to it, and focus goes back to it.
  anchor: { default: null, type: Object },
  // Whether closing puts focus back on the button. The editor puts it back in the text instead.
  focusAnchor: { default: true, type: Boolean },
  label: { default: 'Add a reaction', type: String },
  // What a press does, for each emoji's name: "React with Thumbs up", "Insert Thumbs up".
  verb: { default: 'React with', type: String },
  quickLabel: { default: 'Quick reactions', type: String },
  open: { default: false, type: Boolean },
});

const emit = defineEmits(['close', 'pick']);

const uid = useId();
const panel = ref(null);
const search = ref(null);
const grid = ref(null);
const query = ref('');
const groups = ref([]);
const groupId = ref(EMOJI_GROUPS[0].id);
const loading = ref(false);
const loadError = ref('');
const position = ref({});
const sheet = ref(false);

const shown = computed(() => (query.value.trim() ? searchEmoji(groups.value, query.value) : groups.value.find((group) => group.id === groupId.value)?.emoji ?? []));
const COLUMNS = 8;

async function loadCatalog() {
  if (groups.value.length || loading.value) return;
  loading.value = true;
  loadError.value = '';
  try {
    groups.value = await loadEmojiCatalog();
  } catch {
    loadError.value = 'The emoji list could not load. The ones above still work.';
  } finally {
    loading.value = false;
  }
}

function place() {
  const anchor = props.anchor;
  const viewport = { height: globalThis.innerHeight ?? 800, width: globalThis.innerWidth ?? 1200 };
  sheet.value = viewport.width < 576;
  if (sheet.value || !anchor?.getBoundingClientRect) {
    position.value = {};
    return;
  }
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(352, viewport.width - 16);
  const height = Math.min(420, viewport.height - 16);
  const left = Math.min(Math.max(8, rect.left), viewport.width - width - 8);
  const below = viewport.height - rect.bottom - 8;
  const top = below >= height || rect.top < height ? Math.min(rect.bottom + 6, viewport.height - height - 8) : Math.max(8, rect.top - height - 6);
  position.value = { left: `${left}px`, maxHeight: `${height}px`, top: `${Math.max(8, top)}px`, width: `${width}px` };
}

let frame = 0;
const reposition = () => {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(place);
};

function onPointerDown(event) {
  if (panel.value?.contains(event.target) || props.anchor?.contains?.(event.target)) return;
  close({ returnFocus: false });
}

function listen(on) {
  const method = on ? 'addEventListener' : 'removeEventListener';
  globalThis.document?.[method]('pointerdown', onPointerDown, true);
  globalThis[method]?.('resize', reposition);
  globalThis[method]?.('scroll', reposition, true);
}

// close: ({ returnFocus }), false when a press outside closed it, so focus stays where it went.
function close({ returnFocus = true } = {}) {
  emit('close', { returnFocus });
  if (returnFocus && props.focusAnchor) nextTick(() => props.anchor?.focus?.());
}

function pick(emoji) {
  emit('pick', emoji);
  close();
}

// Arrow keys move through the grid, eight to a row.
function onGridKey(event) {
  const buttons = [...(grid.value?.querySelectorAll('button') ?? [])];
  const index = buttons.indexOf(globalThis.document?.activeElement);
  if (index < 0) return;
  const step = { ArrowDown: COLUMNS, ArrowLeft: -1, ArrowRight: 1, ArrowUp: -COLUMNS }[event.key];
  if (!step) return;
  event.preventDefault();
  buttons[Math.min(buttons.length - 1, Math.max(0, index + step))]?.focus();
}

watch(() => props.open, async (open) => {
  listen(false);
  if (!open) return;
  query.value = '';
  place();
  listen(true);
  void loadCatalog();
  await nextTick();
  search.value?.focus();
}, { immediate: true });

onBeforeUnmount(() => {
  listen(false);
  cancelAnimationFrame(frame);
});
</script>

<template>
  <Teleport to="body">
    <div v-if="open && sheet" class="emoji-picker__backdrop" aria-hidden="true"></div>
    <div
      v-if="open"
      ref="panel"
      class="emoji-picker"
      :class="{ 'emoji-picker--sheet': sheet }"
      role="dialog"
      :aria-label="label"
      :style="position"
      @keydown.esc.stop.prevent="close()"
    >
      <div class="emoji-picker__quick" role="group" :aria-label="quickLabel">
        <button v-for="entry in QUICK_REACTIONS" :key="entry.emoji" class="emoji-picker__emoji" type="button" :aria-label="`${verb} ${entry.label}`" :title="entry.label" @click="pick(entry.emoji)">{{ entry.emoji }}</button>
      </div>
      <label class="visually-hidden" :for="`${uid}-search`">Search emoji</label>
      <input :id="`${uid}-search`" ref="search" v-model="query" class="form-control emoji-picker__search" type="search" autocomplete="off" placeholder="Search emoji" />
      <div v-if="!query.trim()" class="emoji-picker__groups" role="group" aria-label="Emoji groups">
        <button
          v-for="group in EMOJI_GROUPS"
          :key="group.id"
          class="emoji-picker__group"
          :class="{ 'emoji-picker__group--active': group.id === groupId }"
          type="button"
          :aria-label="group.label"
          :aria-pressed="group.id === groupId"
          :title="group.label"
          @click="groupId = group.id"
        >{{ group.icon }}</button>
      </div>
      <p v-if="loading" class="emoji-picker__note" role="status">Loading emoji…</p>
      <p v-else-if="loadError" class="emoji-picker__note" role="alert">{{ loadError }}</p>
      <p v-else-if="query.trim() && !shown.length" class="emoji-picker__note" role="status">No emoji match “{{ query.trim() }}”.</p>
      <div v-else ref="grid" class="emoji-picker__grid" role="group" :aria-label="query.trim() ? 'Matching emoji' : EMOJI_GROUPS.find((group) => group.id === groupId)?.label" @keydown="onGridKey">
        <button v-for="entry in shown" :key="entry.emoji" class="emoji-picker__emoji" type="button" :aria-label="`${verb} ${entry.label}`" :title="entry.label" @click="pick(entry.emoji)">{{ entry.emoji }}</button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.emoji-picker { position: fixed; z-index: 1080; display: grid; grid-template-rows: auto auto auto minmax(0, 1fr); gap: 0.4rem; padding: 0.5rem; overflow: hidden; border: 1px solid var(--line-strong); border-radius: 0.6rem; background: var(--surface); color: var(--ink); box-shadow: 0 0.6rem 1.6rem rgba(15, 23, 42, 0.22); }
.emoji-picker--sheet { right: 0; bottom: 0; left: 0; max-height: min(70dvh, 28rem); border-radius: 0.8rem 0.8rem 0 0; padding-bottom: calc(0.5rem + env(safe-area-inset-bottom)); }
.emoji-picker__backdrop { position: fixed; inset: 0; z-index: 1079; background: rgba(15, 23, 42, 0.35); }
.emoji-picker__quick { display: grid; grid-template-columns: repeat(8, minmax(0, 1fr)); gap: 0.1rem; padding-bottom: 0.35rem; border-bottom: 1px solid var(--line); }
.emoji-picker__search { min-height: 2.75rem; }
.emoji-picker__groups { display: grid; grid-template-columns: repeat(9, minmax(0, 1fr)); gap: 0.1rem; }
.emoji-picker__group { min-height: 2.25rem; border: 0; border-bottom: 2px solid transparent; background: transparent; font-size: 1.05rem; opacity: 0.65; }
.emoji-picker__group--active { border-bottom-color: var(--accent); opacity: 1; }
.emoji-picker__grid { display: grid; grid-template-columns: repeat(8, minmax(0, 1fr)); align-content: start; gap: 0.1rem; min-height: 8rem; overflow-y: auto; }
.emoji-picker__emoji { display: grid; place-items: center; min-width: 0; height: 2.5rem; padding: 0; border: 0; border-radius: 0.35rem; background: transparent; font-size: 1.35rem; line-height: 1; }
.emoji-picker__emoji:hover,
.emoji-picker__group:hover { background: var(--surface-soft); }
.emoji-picker__emoji:focus-visible,
.emoji-picker__group:focus-visible { outline: 0.18rem solid var(--accent); outline-offset: -0.1rem; }
.emoji-picker__note { margin: 0; padding: 1rem 0.25rem; color: var(--muted); font-size: 0.85rem; text-align: center; }
@media (pointer: coarse) {
  .emoji-picker__emoji { height: 2.75rem; }
  .emoji-picker__group { min-height: 2.75rem; }
}
</style>
