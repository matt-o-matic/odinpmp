<script setup>
import { computed, ref } from 'vue';

// What a reply changed in Odin, with an undo. Undo asks once inline, then shows what each change
// became: undone, kept because it was edited since, or not something undo can reverse. `undoing`
// is this card's own undo; `busy` only holds the buttons while the assistant is working.
// `allowUndo` is off for a reader who didn't make the changes (Odin's replies in channels).
const props = defineProps({
  allowUndo: { default: true, type: Boolean },
  busy: { default: false, type: Boolean },
  changes: { required: true, type: Object },
  undoing: { default: false, type: Boolean },
});
const emit = defineEmits(['undo']);

const open = ref(false);
const confirming = ref(false);

const records = computed(() => props.changes.records ?? []);
const undoable = computed(() => records.value.filter((record) => record.undoable && record.status === 'applied').length);
const canUndo = computed(() => props.allowUndo && props.changes.status === 'applied' && undoable.value > 0);
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const summary = computed(() => {
  const total = records.value.length;
  const undone = records.value.filter((record) => record.status === 'undone' || record.status === 'gone').length;
  if (props.changes.status === 'undone') return `Undid ${total === 1 ? 'this change' : `these ${total} changes`}`;
  if (props.changes.status === 'partly_undone') return `Undid ${undone} of ${plural(total, 'change')}`;
  if (props.changes.status === 'undo_failed') return 'Could not undo these changes';
  return `Made ${plural(total, 'change')} in Odin`;
});
const STATUS = {
  applied: { icon: 'bi-check2', text: '' },
  failed: { icon: 'bi-x-circle', text: 'Not undone' },
  gone: { icon: 'bi-arrow-counterclockwise', text: 'Undone' },
  kept: { icon: 'bi-dash-circle', text: 'Kept' },
  not_undoable: { icon: 'bi-lock', text: 'Not undoable' },
  undone: { icon: 'bi-arrow-counterclockwise', text: 'Undone' },
};

function undo() {
  confirming.value = false;
  open.value = true;
  emit('undo');
}
</script>

<template>
  <section class="changes" aria-label="Changes in Odin">
    <div class="changes__head">
      <button class="changes__toggle" type="button" :aria-expanded="open" @click="open = !open">
        <i class="bi bi-pencil-square" aria-hidden="true"></i>
        <span>{{ summary }}</span>
        <i class="bi" :class="open ? 'bi-chevron-up' : 'bi-chevron-down'" aria-hidden="true"></i>
      </button>
      <button v-if="canUndo && !confirming && !undoing" class="changes__undo" type="button" :disabled="busy" @click="confirming = true">
        <i class="bi bi-arrow-counterclockwise" aria-hidden="true"></i> Undo
      </button>
    </div>
    <div v-if="confirming" class="changes__confirm" role="group" aria-label="Undo these changes">
      <p>Undo {{ undoable === 1 ? 'this change' : `these ${undoable} changes` }}? Anything edited since stays as it is.</p>
      <div class="changes__confirm-actions">
        <button class="btn btn-sm btn-danger" type="button" :disabled="busy" @click="undo">Undo changes</button>
        <button class="btn btn-sm btn-outline-secondary changes__keep" type="button" :disabled="busy" @click="confirming = false">Keep them</button>
      </div>
    </div>
    <p v-if="undoing" class="changes__busy" role="status">
      <span class="spinner-border spinner-border-sm" aria-hidden="true"></span> Undoing…
    </p>
    <ul v-if="open" class="changes__list">
      <li v-for="record in records" :key="record.id" :class="`changes__item--${record.status}`">
        <i class="bi" :class="STATUS[record.status]?.icon ?? 'bi-check2'" aria-hidden="true"></i>
        <span class="changes__label">{{ record.label }}</span>
        <span v-if="STATUS[record.status]?.text" class="changes__state">{{ STATUS[record.status].text }}</span>
        <span v-if="record.note && record.status !== 'applied'" class="changes__note">{{ record.note }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.changes {
  border: 1px solid var(--line);
  border-radius: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.15rem 0.35rem;
}

.changes__head {
  align-items: center;
  display: flex;
  justify-content: space-between;
}

.changes__toggle,
.changes__undo {
  align-items: center;
  background: none;
  border: 0;
  border-radius: 0.5rem;
  color: var(--ink-soft);
  display: inline-flex;
  font-size: 0.85rem;
  gap: 0.45rem;
  min-height: 2.75rem;
  padding: 0 0.5rem;
}

.changes__undo {
  color: var(--accent);
}

.changes__toggle:hover,
.changes__undo:hover:not(:disabled) {
  background: var(--surface-tint);
}

.changes__confirm {
  background: var(--surface-soft);
  border-radius: 0.6rem;
  padding: 0.6rem 0.75rem;
}

.changes__confirm p {
  color: var(--ink);
  font-size: 0.875rem;
  margin: 0 0 0.5rem;
}

.changes__confirm-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.changes__confirm-actions .btn {
  min-height: 2.75rem;
}

.changes__keep {
  border-color: var(--line-strong);
  color: var(--ink);
}

.changes__busy {
  align-items: center;
  color: var(--ink-soft);
  display: flex;
  font-size: 0.85rem;
  gap: 0.5rem;
  margin: 0;
  padding: 0 0.5rem 0.4rem;
}

.changes__list {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  list-style: none;
  margin: 0;
  padding: 0 0.5rem 0.5rem;
}

.changes__list li {
  align-items: baseline;
  color: var(--ink);
  display: flex;
  flex-wrap: wrap;
  font-size: 0.85rem;
  gap: 0.25rem 0.5rem;
}

.changes__state {
  color: var(--ink-soft);
  font-size: 0.78rem;
  font-weight: 600;
}

.changes__note {
  color: var(--ink-soft);
  flex-basis: 100%;
  font-size: 0.8rem;
  padding-left: 1.4rem;
}

.changes__item--failed .bi,
.changes__item--failed .changes__state {
  color: var(--danger, #b42318);
}
</style>
