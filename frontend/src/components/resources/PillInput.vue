<script setup>
import { computed, ref, useId } from 'vue';

// A list of short values shown as removable pills. Type to see suggestions (what the workspace
// already uses, then the shipped catalog); Enter, Tab with text, or a comma adds the value.

const props = defineProps({
  disabled: { default: false, type: Boolean },
  inputId: { default: '', type: String },
  label: { required: true, type: String },
  modelValue: { default: () => [], type: Array },
  placeholder: { default: 'Type and press Enter', type: String },
  suggestions: { default: () => [], type: Array },
});
const emit = defineEmits(['update:modelValue']);

const fallbackId = `pill-input-${useId()}`;
const id = computed(() => props.inputId || fallbackId);
const listId = computed(() => `${id.value}-options`);
const draft = ref('');
const chosen = computed(() => new Set(props.modelValue.map((value) => String(value).toLowerCase())));
const options = computed(() => props.suggestions.filter((value) => !chosen.value.has(String(value).toLowerCase())).slice(0, 200));

function add(raw = draft.value) {
  const parts = String(raw ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  const next = [...props.modelValue];
  for (const part of parts) {
    const known = props.suggestions.find((value) => value.toLowerCase() === part.toLowerCase()) ?? part;
    if (!next.some((value) => value.toLowerCase() === known.toLowerCase())) next.push(known.slice(0, 120));
  }
  draft.value = '';
  if (next.length !== props.modelValue.length) emit('update:modelValue', next);
}

function remove(index) {
  emit('update:modelValue', props.modelValue.filter((_, position) => position !== index));
}

function onKeydown(event) {
  if (event.key === 'Enter' || event.key === ',') {
    event.preventDefault();
    add();
  } else if (event.key === 'Tab' && draft.value.trim()) {
    add();
  } else if (event.key === 'Backspace' && !draft.value && props.modelValue.length) {
    remove(props.modelValue.length - 1);
  }
}

function onInput(event) {
  // Picking a datalist option fires input with the whole value; add it straight away.
  if (event.inputType === 'insertReplacementText' || (event.inputType === undefined && props.suggestions.includes(draft.value))) add();
}
</script>

<template>
  <div class="pill-input" :class="{ 'pill-input--disabled': disabled }">
    <ul v-if="modelValue.length" class="pill-input__pills" :aria-label="`${label} added`">
      <li v-for="(value, index) in modelValue" :key="value" class="pill-input__pill">
        <span>{{ value }}</span>
        <button type="button" class="pill-input__remove" :aria-label="`Remove ${value}`" :disabled="disabled" @click="remove(index)">
          <i class="bi bi-x" aria-hidden="true"></i>
        </button>
      </li>
    </ul>
    <input
      :id="id"
      v-model="draft"
      class="form-control"
      autocomplete="off"
      :disabled="disabled"
      :list="listId"
      :placeholder="placeholder"
      type="text"
      @blur="add()"
      @input="onInput"
      @keydown="onKeydown"
    />
    <datalist :id="listId">
      <option v-for="option in options" :key="option" :value="option"></option>
    </datalist>
  </div>
</template>

<style scoped>
.pill-input { display: grid; gap: 0.5rem; }
.pill-input__pills { display: flex; flex-wrap: wrap; gap: 0.25rem; margin: 0; padding: 0; list-style: none; }
.pill-input__pill {
  display: inline-flex;
  align-items: center;
  gap: 0.15rem;
  padding: 0 0 0 0.6rem;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface-soft);
  color: var(--ink);
  font-size: 0.8125rem;
  line-height: 1.25;
}
.pill-input__remove {
  display: inline-grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--ink-soft);
}
.pill-input__remove:hover { background: var(--line); }
.pill-input__remove:focus-visible { outline: 0.15rem solid var(--accent); outline-offset: 0.05rem; }
@media (pointer: coarse) { .pill-input__remove { width: 2.75rem; height: 2.75rem; } }
</style>
