<script setup>
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue';

import { apiClient, authSession } from '../../lib/auth/index.js';
import { jumpTargets } from '../../lib/chat/chat.js';
import { createSearchSuggestions, signedInKey, suggestionIcon, suggestionOption } from '../../lib/search/search-suggestions.js';

// Odin Chat's search and jump box: type to find a channel, a direct message, a person or Odin,
// and press Enter to open it. After a pause, the best few matches from workspace search
// follow, by meaning or by words, and the last option opens every result. A combobox: arrows
// move, Enter opens, Escape clears.
const props = defineProps({
  // Opens the list on its own page (the phone's Search tab).
  inline: { default: false, type: Boolean },
  people: { default: () => [], type: Array },
  sidebar: { default: null, type: Object },
});

const emit = defineEmits(['choose', 'need-people']);

const uid = useId();
const input = ref(null);
const query = ref('');
const focused = ref(false);
// The option the person moved to, by key, so results arriving later don't change what Enter opens.
const activeKey = ref('');

const suggestions = createSearchSuggestions({
  search: (filters) => (apiClient.passive ?? apiClient).searchEnterprise(filters, authSession.state.token),
});
watch(query, (text) => suggestions.update(text));
watch(() => signedInKey(authSession.state.currentUser), () => {
  query.value = '';
  suggestions.clear();
});
onBeforeUnmount(() => suggestions.clear());

const options = computed(() => {
  const found = jumpTargets({ people: props.people, query: query.value, sidebar: props.sidebar });
  const text = query.value.trim();
  if (!text) return [];
  const results = suggestions.state.query === text ? suggestions.state.results.map(suggestionOption) : [];
  return [...found, ...results, { detail: 'Odin search', key: 'search', kind: 'search', label: `See all results for “${text}”`, to: { name: 'search', query: { q: text } } }];
});
// Until the person moves, Enter opens the best place or person it matched, or else the search
// page: never a result that happened to arrive first.
const activeIndex = computed(() => {
  const chosen = options.value.findIndex((option) => option.key === activeKey.value);
  if (chosen >= 0) return chosen;
  return options.value[0]?.kind === 'result' ? options.value.findIndex((option) => option.kind === 'search') : 0;
});
const moveTo = (index) => { activeKey.value = options.value[index]?.key ?? ''; };
const expanded = computed(() => (props.inline || focused.value) && options.value.length > 0);
const optionId = (index) => `${uid}-option-${index}`;
const icons = { channel: 'bi-hash', dm: 'bi-person', odin: 'bi-stars', person: 'bi-person-plus', search: 'bi-search' };
const iconFor = (option) => (option.kind === 'result' ? suggestionIcon(option.documentType) : icons[option.kind]);

function onFocus() {
  focused.value = true;
  emit('need-people');
}

// A click on an option lands before the blur closes the list.
function onBlur() {
  setTimeout(() => { focused.value = false; }, 150);
}

function choose(option) {
  if (!option) return;
  emit('choose', option);
  query.value = '';
  activeKey.value = '';
  input.value?.blur();
}

function onKeydown(event) {
  const count = options.value.length;
  if (event.key === 'ArrowDown' && count) {
    event.preventDefault();
    moveTo((activeIndex.value + 1) % count);
  } else if (event.key === 'ArrowUp' && count) {
    event.preventDefault();
    moveTo((activeIndex.value - 1 + count) % count);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    choose(options.value[Math.min(activeIndex.value, count - 1)]);
  } else if (event.key === 'Escape' && query.value) {
    event.preventDefault();
    query.value = '';
  }
}

defineExpose({ focus: () => input.value?.focus() });
</script>

<template>
  <div class="chat-jump" :class="{ 'chat-jump--inline': inline }">
    <label :for="`${uid}-input`" class="visually-hidden">Search or jump to</label>
    <div class="chat-jump__field">
      <i class="bi bi-search chat-jump__icon" aria-hidden="true"></i>
      <input
        :id="`${uid}-input`"
        ref="input"
        v-model="query"
        class="form-control chat-jump__input"
        type="search"
        role="combobox"
        autocomplete="off"
        maxlength="200"
        placeholder="Search or jump to…"
        aria-autocomplete="list"
        :aria-expanded="expanded"
        :aria-controls="`${uid}-list`"
        :aria-activedescendant="expanded ? optionId(activeIndex) : undefined"
        data-testid="chat-jump"
        @blur="onBlur"
        @focus="onFocus"
        @input="activeKey = ''"
        @keydown="onKeydown"
      />
      <kbd v-if="!inline" class="chat-jump__key" aria-hidden="true">Ctrl K</kbd>
    </div>
    <ul v-show="expanded" :id="`${uid}-list`" class="chat-jump__list" role="listbox" aria-label="Places, people and results">
      <li
        v-for="(option, index) in options"
        :id="optionId(index)"
        :key="option.key"
        class="chat-jump__option"
        :class="{ 'chat-jump__option--active': index === activeIndex }"
        role="option"
        :aria-selected="index === activeIndex"
        @mousedown.prevent="choose(option)"
        @mouseenter="moveTo(index)"
      >
        <i :class="['bi', iconFor(option)]" aria-hidden="true"></i>
        <span class="chat-jump__label">{{ option.label }}</span>
        <span class="chat-jump__detail">{{ option.detail }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.chat-jump { position: relative; width: 100%; }
.chat-jump__field { position: relative; display: flex; align-items: center; }
.chat-jump__icon { position: absolute; top: 50%; left: 0.7rem; color: var(--muted); line-height: 1; pointer-events: none; transform: translateY(-50%); }
.chat-jump__input { min-height: 2.75rem; padding-left: 2.1rem; padding-right: 3.75rem; }
.chat-jump--inline .chat-jump__input { padding-right: 0.75rem; }
.chat-jump__key { position: absolute; right: 0.5rem; padding: 0.1rem 0.35rem; border: 1px solid var(--line); border-radius: 0.3rem; background: var(--surface-soft); color: var(--muted); font-size: 0.7rem; }
.chat-jump__list { position: absolute; z-index: 30; top: calc(100% + 0.25rem); right: 0; left: 0; display: grid; gap: 0.1rem; max-height: 22rem; margin: 0; padding: 0.3rem; overflow-y: auto; border: 1px solid var(--line); border-radius: 0.5rem; background: var(--surface); box-shadow: var(--shadow-strong, 0 12px 32px rgba(8, 12, 22, 0.18)); list-style: none; }
.chat-jump--inline .chat-jump__list { position: static; box-shadow: none; }
.chat-jump__option { display: flex; align-items: center; gap: 0.5rem; min-height: 2.75rem; padding: 0.25rem 0.6rem; border-radius: 0.35rem; color: var(--ink-soft); cursor: pointer; }
.chat-jump__option--active { background: var(--surface-soft); color: var(--ink); box-shadow: inset 0.2rem 0 0 var(--accent); }
.chat-jump__label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.chat-jump__detail { flex: none; color: var(--muted); font-size: 0.75rem; }
</style>
