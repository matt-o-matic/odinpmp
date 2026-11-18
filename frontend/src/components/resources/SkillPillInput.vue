<script setup>
import { computed, ref, useId } from 'vue';

import { SKILL_LEVELS, skillLevelLabel } from '../../lib/resources/resources.js';

// Skills as pills, each with a level picked from a fixed scale (Learning to Expert). Type a
// skill (suggestions come from the workspace, then the catalog), pick a level and add it.

const props = defineProps({
  disabled: { default: false, type: Boolean },
  inputId: { default: '', type: String },
  modelValue: { default: () => [], type: Array },
  suggestions: { default: () => [], type: Array },
});
const emit = defineEmits(['update:modelValue']);

const fallbackId = `skill-input-${useId()}`;
const id = computed(() => props.inputId || fallbackId);
const draft = ref('');
const draftLevel = ref(3);
const chosen = computed(() => new Set(props.modelValue.map((skill) => skill.name.toLowerCase())));
const options = computed(() => props.suggestions.filter((value) => !chosen.value.has(value.toLowerCase())).slice(0, 200));

function add() {
  const text = draft.value.trim();
  if (!text) return;
  const name = (props.suggestions.find((value) => value.toLowerCase() === text.toLowerCase()) ?? text).slice(0, 120);
  const existing = props.modelValue.findIndex((skill) => skill.name.toLowerCase() === name.toLowerCase());
  const next = [...props.modelValue];
  if (existing >= 0) next.splice(existing, 1, { ...next[existing], level: draftLevel.value });
  else next.push({ level: draftLevel.value, name });
  draft.value = '';
  emit('update:modelValue', next);
}

function setLevel(index, level) {
  emit('update:modelValue', props.modelValue.map((skill, position) => (position === index ? { ...skill, level: Number(level) } : skill)));
}

function remove(index) {
  emit('update:modelValue', props.modelValue.filter((_, position) => position !== index));
}
</script>

<template>
  <div class="skill-input">
    <ul v-if="modelValue.length" class="skill-input__pills" aria-label="Skills added">
      <li v-for="(skill, index) in modelValue" :key="skill.name" class="skill-input__pill" :data-level="skill.level">
        <span class="skill-input__name">{{ skill.name }}</span>
        <select
          class="skill-input__level"
          :aria-label="`${skill.name} level`"
          :disabled="disabled"
          :value="skill.level"
          @change="setLevel(index, $event.target.value)"
        >
          <option v-for="level in SKILL_LEVELS" :key="level.value" :value="level.value">{{ level.label }}</option>
        </select>
        <button type="button" class="skill-input__remove" :aria-label="`Remove ${skill.name}`" :disabled="disabled" @click="remove(index)">
          <i class="bi bi-x" aria-hidden="true"></i>
        </button>
      </li>
    </ul>
    <div class="skill-input__add">
      <input
        :id="id"
        v-model="draft"
        class="form-control"
        autocomplete="off"
        :disabled="disabled"
        :list="`${id}-options`"
        placeholder="Add a skill"
        type="text"
        @keydown.enter.prevent="add"
      />
      <select v-model.number="draftLevel" class="form-select" aria-label="Level for the new skill" :disabled="disabled">
        <option v-for="level in SKILL_LEVELS" :key="level.value" :value="level.value">{{ level.label }}</option>
      </select>
      <button type="button" class="ghost-button" :disabled="disabled || !draft.trim()" @click="add">
        <i class="bi bi-plus-lg" aria-hidden="true"></i> Add
      </button>
    </div>
    <datalist :id="`${id}-options`">
      <option v-for="option in options" :key="option" :value="option"></option>
    </datalist>
    <p class="visually-hidden" aria-live="polite">{{ modelValue.map((skill) => `${skill.name}, ${skillLevelLabel(skill.level)}`).join('; ') }}</p>
  </div>
</template>

<style scoped>
.skill-input { display: grid; gap: 0.5rem; }
.skill-input__pills { display: flex; flex-wrap: wrap; gap: 0.25rem; margin: 0; padding: 0; list-style: none; }
.skill-input__pill {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding-left: 0.6rem;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface-soft);
  color: var(--ink);
  font-size: 0.8125rem;
  line-height: 1.25;
}
.skill-input__pill[data-level='4'], .skill-input__pill[data-level='5'] { border-color: color-mix(in srgb, var(--ink-soft) 45%, var(--line)); font-weight: 600; }
.skill-input__level {
  max-width: 7.5rem;
  padding: 0.1rem 0.25rem;
  border: 0;
  border-left: 1px solid var(--line);
  background: transparent;
  color: var(--ink-soft);
  font-size: 0.75rem;
}
.skill-input__level:focus-visible, .skill-input__remove:focus-visible { outline: 0.15rem solid var(--accent); outline-offset: 0.05rem; }
.skill-input__remove { display: inline-grid; place-items: center; width: 2rem; height: 2rem; border: 0; border-radius: 999px; background: transparent; color: var(--ink-soft); }
.skill-input__remove:hover { background: var(--line); }
.skill-input__add { display: grid; grid-template-columns: minmax(0, 1fr) 8.5rem auto; gap: 0.5rem; }
@media (max-width: 30rem) { .skill-input__add { grid-template-columns: 1fr 1fr; } .skill-input__add input { grid-column: 1 / -1; } }
@media (pointer: coarse) { .skill-input__remove { width: 2.75rem; height: 2.75rem; } }
</style>
