<script setup>
import { computed } from 'vue';

// Owner and "also involve" fields for a topic, with a Required toggle on each involved
// person. Choices come from peopleOptions(): project members, then the project's
// stakeholders. Values are `user:<id>` / `stakeholder:<id>` keys; `required` is the part of
// `involved` whose answer is required. The owner outranks required people, whose answer
// settles a point unless the owner disputes it.
const props = defineProps({
  idPrefix: { default: 'rq-people', type: String },
  involved: { default: () => [], type: Array },
  options: { default: () => [], type: Array },
  owner: { default: '', type: String },
  required: { default: () => [], type: Array },
});

const emit = defineEmits(['update:involved', 'update:owner', 'update:required']);

const members = computed(() => props.options.filter((option) => option.group === 'members'));
const stakeholders = computed(() => props.options.filter((option) => option.group === 'stakeholders'));
const others = computed(() => props.options.filter((option) => option.key !== props.owner));

function setOwner(key) {
  emit('update:owner', key);
  // The owner is never also listed as involved or required.
  if (props.involved.includes(key)) emit('update:involved', props.involved.filter((entry) => entry !== key));
  if (props.required.includes(key)) emit('update:required', props.required.filter((entry) => entry !== key));
}

function toggle(key, checked) {
  emit('update:involved', checked ? [...props.involved, key] : props.involved.filter((entry) => entry !== key));
  if (!checked && props.required.includes(key)) emit('update:required', props.required.filter((entry) => entry !== key));
}

function toggleRequired(key, checked) {
  emit('update:required', checked ? [...props.required, key] : props.required.filter((entry) => entry !== key));
}
</script>

<template>
  <div class="rq-stack">
    <div class="rq-field">
      <label :for="`${idPrefix}-owner`">Owner</label>
      <select :id="`${idPrefix}-owner`" class="form-select" :value="owner" @change="setOwner($event.target.value)">
        <option value="">No owner</option>
        <optgroup v-if="members.length" label="Project members">
          <option v-for="option in members" :key="option.key" :value="option.key">{{ option.label }}</option>
        </optgroup>
        <optgroup v-if="stakeholders.length" label="Stakeholders">
          <option v-for="option in stakeholders" :key="option.key" :value="option.key">{{ option.label }}</option>
        </optgroup>
      </select>
    </div>
    <fieldset class="rq-field">
      <legend>Also involve</legend>
      <ul v-if="others.length" class="rq-checklist">
        <li v-for="option in others" :key="option.key" class="rq-checklist__row">
          <label>
            <input class="form-check-input mt-0" type="checkbox" :checked="involved.includes(option.key)" @change="toggle(option.key, $event.target.checked)" />
            <span>{{ option.label }} <span v-if="option.detail" class="rq-xs rq-muted">· {{ option.detail }}</span></span>
          </label>
          <label v-if="involved.includes(option.key)" class="rq-checklist__required">
            <input
              class="form-check-input mt-0"
              type="checkbox"
              :aria-label="`${option.label}'s answer is required`"
              :checked="required.includes(option.key)"
              @change="toggleRequired(option.key, $event.target.checked)"
            />
            <span>Required</span>
          </label>
        </li>
      </ul>
      <p v-else class="rq-field__hint">No other project members or stakeholders yet.</p>
      <p v-if="others.length" class="rq-field__hint">A required person's answer settles a point unless the owner disputes it. Admins count the same as required people.</p>
    </fieldset>
    <p class="rq-field__hint">Stakeholders you add get an email with a link to answer.</p>
  </div>
</template>
