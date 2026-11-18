<script setup>
import { computed, ref } from 'vue';

import './rounds.css';
import RequirementsAvatar from '../RequirementsAvatar.vue';

// Choose reviewers and mark which ones are required. Every candidate is a row with a
// checkbox; picking one enables its "required" box. External stakeholders are labeled
// "external · link". Long lists get a name filter.
const props = defineProps({
  candidates: { default: () => [], type: Array },
  // Keys (`user:<id>`, `stakeholder:<id>`) to leave out, such as current reviewers.
  exclude: { default: () => [], type: Array },
  // Selected reviewers: [{ key, actorId, actorType, required }].
  modelValue: { default: () => [], type: Array },
  name: { default: 'reviewers', type: String },
});

const emit = defineEmits(['update:modelValue']);

const filter = ref('');
const excluded = computed(() => new Set(props.exclude));
const available = computed(() => props.candidates.filter((candidate) => !excluded.value.has(candidate.key)));
const visible = computed(() => {
  const query = filter.value.trim().toLowerCase();
  if (!query) return available.value;
  return available.value.filter((candidate) => `${candidate.name} ${candidate.email} ${candidate.kindLabel}`.toLowerCase().includes(query));
});
const selectedByKey = computed(() => new Map(props.modelValue.map((entry) => [entry.key, entry])));

function toggle(candidate, checked) {
  if (checked) {
    if (selectedByKey.value.has(candidate.key)) return;
    emit('update:modelValue', [...props.modelValue, { actorId: candidate.actorId, actorType: candidate.actorType, key: candidate.key, required: false }]);
  } else {
    emit('update:modelValue', props.modelValue.filter((entry) => entry.key !== candidate.key));
  }
}

function setRequired(candidate, required) {
  emit('update:modelValue', props.modelValue.map((entry) => (entry.key === candidate.key ? { ...entry, required } : entry)));
}
</script>

<template>
  <div class="rq-stack rq-stack--sm">
    <div v-if="available.length > 8" class="rq-field">
      <label :for="`rq-${name}-filter`">Find a person</label>
      <input :id="`rq-${name}-filter`" v-model="filter" class="form-control form-control-sm" type="search" autocomplete="off" />
    </div>
    <p v-if="available.length === 0" class="rq-small rq-muted mb-0">Everyone who can review is already on this round.</p>
    <p v-else-if="visible.length === 0" class="rq-small rq-muted mb-0">Nobody matches “{{ filter }}”.</p>
    <ul v-else class="rq-candidates">
      <li
        v-for="candidate in visible"
        :key="candidate.key"
        class="rq-candidate"
        :class="{ 'rq-candidate--off': !selectedByKey.has(candidate.key) }"
      >
        <RequirementsAvatar :person="candidate.person" />
        <label class="rq-candidate__pick">
          <input
            type="checkbox"
            :checked="selectedByKey.has(candidate.key)"
            :aria-describedby="candidate.linkRevoked ? `rq-${name}-${candidate.key}-warn` : undefined"
            @change="toggle(candidate, $event.target.checked)"
          />
          <span class="rq-candidate__name">
            {{ candidate.name }} <span class="rq-xs rq-muted">· {{ candidate.kindLabel }}</span>
            <span v-if="candidate.linkRevoked" :id="`rq-${name}-${candidate.key}-warn`" class="rq-candidate__warn d-block">
              <i class="bi bi-exclamation-triangle" aria-hidden="true"></i> Link revoked, so no invitation will be sent
            </span>
          </span>
        </label>
        <label class="rq-candidate__required">
          <input
            type="checkbox"
            :checked="Boolean(selectedByKey.get(candidate.key)?.required)"
            :disabled="!selectedByKey.has(candidate.key)"
            :aria-label="`${candidate.name} is required`"
            @change="setRequired(candidate, $event.target.checked)"
          />
          <span aria-hidden="true">required</span>
        </label>
      </li>
    </ul>
  </div>
</template>
