<script setup>
import { computed, ref, watch } from 'vue';

const props = defineProps({
  allowMerge: {
    default: true,
    type: Boolean,
  },
  busy: {
    default: false,
    type: Boolean,
  },
  conflicts: {
    default: () => [],
    type: Array,
  },
  discardLabel: {
    default: 'Discard my edits',
    type: String,
  },
  message: {
    default: '',
    type: String,
  },
  visible: {
    default: false,
    type: Boolean,
  },
});

const emit = defineEmits(['discard', 'merge']);

const reviewing = ref(false);
const choices = ref({});

const conflictCount = computed(() => props.conflicts.length);

watch(
  () => props.conflicts.map((conflict) => conflict.key).join('|'),
  () => {
    const next = {};
    for (const conflict of props.conflicts) {
      next[conflict.key] = choices.value[conflict.key] ?? 'mine';
    }
    choices.value = next;
  },
  { immediate: true },
);

watch(
  () => props.visible,
  (visible) => {
    if (!visible) reviewing.value = false;
  },
);

function formatValue(value) {
  if (value == null || value === '') return '(empty)';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const plain = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return plain.length > 160 ? `${plain.slice(0, 157)}...` : plain;
}

function handleMerge() {
  if (conflictCount.value > 0 && !reviewing.value) {
    reviewing.value = true;
    return;
  }

  emit('merge', { ...choices.value });
}

function chooseAll(side) {
  choices.value = Object.fromEntries(props.conflicts.map((conflict) => [conflict.key, side]));
}
</script>

<template>
  <div v-if="visible" class="live-update-notice" role="alert" aria-live="assertive">
    <div class="live-update-notice__summary">
      <i class="bi bi-arrow-repeat live-update-notice__icon" aria-hidden="true"></i>
      <div class="live-update-notice__copy">
        <strong>{{ message }}</strong>
        <span v-if="!allowMerge">Your unsaved edits can't be applied to it.</span>
        <span v-else-if="conflictCount > 0">
          {{ conflictCount }} {{ conflictCount === 1 ? 'change conflicts' : 'changes conflict' }} with your edits. Everything else merges automatically.
        </span>
        <span v-else>Their changes don't touch anything you edited, so they merge cleanly.</span>
      </div>
      <div v-if="!reviewing" class="actions-row live-update-notice__actions">
        <button class="ghost-button" type="button" :disabled="busy" @click="emit('discard')">{{ discardLabel }}</button>
        <button v-if="allowMerge" class="primary-button" type="button" :disabled="busy" @click="handleMerge">
          {{ conflictCount > 0 ? 'Review & merge' : 'Merge changes' }}
        </button>
      </div>
    </div>

    <div v-if="reviewing" class="live-update-notice__conflicts">
      <div class="actions-row actions-row--spaced">
        <p class="card-eyebrow">Choose which version to keep</p>
        <div class="actions-row">
          <button class="ghost-button ghost-button--compact" type="button" @click="chooseAll('mine')">Keep all mine</button>
          <button class="ghost-button ghost-button--compact" type="button" @click="chooseAll('theirs')">Take all theirs</button>
        </div>
      </div>
      <ul class="live-update-notice__list">
        <li v-for="conflict in conflicts" :key="conflict.key" class="live-update-notice__conflict">
          <p class="live-update-notice__conflict-title">
            <strong>{{ conflict.label }}</strong>
            <span>{{ conflict.fieldLabel }}</span>
          </p>
          <label class="live-update-notice__choice">
            <input v-model="choices[conflict.key]" type="radio" :name="`live-merge-${conflict.key}`" value="mine" />
            <span><small>Mine</small>{{ formatValue(conflict.mine) }}</span>
          </label>
          <label class="live-update-notice__choice">
            <input v-model="choices[conflict.key]" type="radio" :name="`live-merge-${conflict.key}`" value="theirs" />
            <span><small>Theirs</small>{{ formatValue(conflict.theirs) }}</span>
          </label>
        </li>
      </ul>
      <div class="actions-row live-update-notice__actions">
        <button class="ghost-button" type="button" :disabled="busy" @click="emit('discard')">{{ discardLabel }}</button>
        <button class="secondary-button" type="button" :disabled="busy" @click="reviewing = false">Back</button>
        <button class="primary-button" type="button" :disabled="busy" @click="handleMerge">Apply merge</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.live-update-notice {
  position: fixed;
  top: 1rem;
  left: 50%;
  z-index: 1090;
  display: grid;
  gap: 0.75rem;
  width: min(44rem, calc(100vw - 2rem));
  max-height: calc(100vh - 2rem);
  overflow-y: auto;
  padding: 0.9rem 1rem;
  border: 1px solid rgba(13, 110, 253, 0.35);
  border-radius: 0.5rem;
  background: var(--surface, #fff);
  color: var(--ink, #1d2733);
  box-shadow: 0 12px 32px rgba(15, 30, 45, 0.18);
  transform: translateX(-50%);
}

.live-update-notice__summary {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  align-items: center;
}

.live-update-notice__icon {
  color: #0d6efd;
  font-size: 1.25rem;
}

.live-update-notice__copy {
  display: grid;
  flex: 1 1 18rem;
  gap: 0.15rem;
}

.live-update-notice__copy span {
  color: var(--muted, #5c6b7a);
}

.live-update-notice__actions {
  justify-content: flex-end;
}

.live-update-notice__conflicts {
  display: grid;
  gap: 0.6rem;
  padding-top: 0.6rem;
  border-top: 1px solid var(--line, #dde3ea);
}

.live-update-notice__list {
  display: grid;
  gap: 0.5rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.live-update-notice__conflict {
  display: grid;
  gap: 0.35rem;
  padding: 0.6rem;
  border: 1px solid var(--line, #dde3ea);
  border-radius: 0.4rem;
}

.live-update-notice__conflict-title {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin: 0;
}

.live-update-notice__conflict-title span {
  color: var(--muted, #5c6b7a);
}

.live-update-notice__choice {
  display: flex;
  gap: 0.5rem;
  align-items: flex-start;
  cursor: pointer;
}

.live-update-notice__choice span {
  display: grid;
  gap: 0.1rem;
  min-width: 0;
  overflow-wrap: anywhere;
}

.live-update-notice__choice small {
  color: var(--muted, #5c6b7a);
  font-size: 0.7rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
</style>
