<script setup>
import { computed, ref, watch } from 'vue';

import { proposalCounts } from '../../lib/assistant/assistant-format.js';

// Staged changes waiting for the user: proposed work from a Requirements plan, or a Home
// recovery proposal. Apply all, apply the selected items, or dismiss.
const props = defineProps({
  busy: { default: false, type: Boolean },
  proposal: { required: true, type: Object },
});
const emit = defineEmits(['resolve']);

const pending = computed(() => props.proposal.items.filter((item) => item.status === 'pending'));
const selected = ref(new Set());
watch(pending, (items) => { selected.value = new Set(items.map((item) => item.id)); }, { immediate: true });
const counts = computed(() => proposalCounts(props.proposal));
const allSelected = computed(() => pending.value.length > 0 && selected.value.size === pending.value.length);
const STATUS_LABELS = { applied: 'Applied', dismissed: 'Dismissed', failed: "Didn't apply", pending: 'Waiting', withdrawn: 'Replaced' };

function toggle(itemId, checked) {
  const next = new Set(selected.value);
  if (checked) next.add(itemId); else next.delete(itemId);
  selected.value = next;
}
function apply() {
  emit('resolve', { decision: 'apply', itemIds: allSelected.value ? [] : [...selected.value], proposalId: props.proposal.id });
}
function dismiss() {
  emit('resolve', { decision: 'dismiss', itemIds: allSelected.value ? [] : [...selected.value], proposalId: props.proposal.id });
}
</script>

<template>
  <section class="proposal" :aria-label="proposal.title || 'Proposed changes'">
    <header class="proposal__head">
      <div>
        <p class="proposal__eyebrow">{{ proposal.source === 'home-recovery' ? 'Recovery proposal' : 'Proposed work' }}</p>
        <h3 class="proposal__title">{{ proposal.title || 'Proposed changes' }}</h3>
      </div>
      <p class="proposal__counts">
        <span v-if="counts.pending">{{ counts.pending }} waiting</span>
        <span v-if="counts.applied">{{ counts.applied }} applied</span>
        <span v-if="counts.dismissed">{{ counts.dismissed }} dismissed</span>
        <span v-if="counts.failed" class="text-danger">{{ counts.failed }} didn't apply</span>
      </p>
    </header>
    <p v-if="proposal.rationale" class="proposal__rationale">{{ proposal.rationale }}</p>
    <ul class="proposal__items">
      <li v-for="item in proposal.items" :key="item.id" class="proposal__item" :class="`proposal__item--${item.status}`">
        <label v-if="item.status === 'pending'" class="proposal__check">
          <input type="checkbox" :checked="selected.has(item.id)" :disabled="busy" @change="toggle(item.id, $event.target.checked)" />
          <span class="visually-hidden">Include {{ item.label }}</span>
        </label>
        <span v-else class="proposal__state" :title="STATUS_LABELS[item.status]">
          <i class="bi" :class="item.status === 'applied' ? 'bi-check-circle-fill' : item.status === 'failed' ? 'bi-exclamation-circle' : 'bi-dash-circle'" aria-hidden="true"></i>
        </span>
        <div class="proposal__body">
          <span class="proposal__label">{{ item.label }}</span>
          <span v-if="item.detail" class="proposal__detail">{{ item.detail }}</span>
          <span v-if="item.error" class="proposal__error">{{ item.error }}</span>
          <ul v-if="item.payload?.node?.stories?.length" class="proposal__children">
            <li v-for="story in item.payload.node.stories" :key="story.id">{{ story.name }}</li>
          </ul>
        </div>
        <span v-if="item.status !== 'pending'" class="proposal__status">{{ STATUS_LABELS[item.status] }}</span>
      </li>
    </ul>
    <footer v-if="pending.length" class="proposal__actions">
      <button class="btn btn-primary" type="button" :disabled="busy || !selected.size" @click="apply">
        {{ allSelected ? (pending.length === 1 ? 'Apply' : `Apply all ${pending.length}`) : `Apply ${selected.size} selected` }}
      </button>
      <button class="btn btn-outline-secondary" type="button" :disabled="busy || !selected.size" @click="dismiss">
        {{ allSelected ? 'Dismiss' : 'Dismiss selected' }}
      </button>
    </footer>
  </section>
</template>

<style scoped>
.proposal {
  background: var(--surface);
  border: 1px solid var(--line);
  border-left: 3px solid var(--accent);
  border-radius: 0.75rem;
  margin-top: 0.75rem;
  padding: 0.9rem 1rem;
}

.proposal__head {
  align-items: flex-start;
  display: flex;
  gap: 1rem;
  justify-content: space-between;
}

.proposal__eyebrow {
  color: var(--muted);
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  margin: 0;
  text-transform: uppercase;
}

.proposal__title {
  border: 0;
  color: var(--ink);
  font-family: var(--font-sans);
  font-size: 1rem !important;
  margin: 0.1rem 0 0;
}

.proposal__counts {
  color: var(--muted);
  display: flex;
  flex-wrap: wrap;
  font-size: 0.8rem;
  gap: 0.6rem;
  margin: 0;
}

.proposal__rationale {
  color: var(--muted);
  font-size: 0.875rem;
  margin: 0.4rem 0 0;
}

.proposal__items {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  list-style: none;
  margin: 0.75rem 0 0;
  padding: 0;
}

.proposal__item {
  align-items: flex-start;
  border-radius: 0.5rem;
  display: flex;
  gap: 0.6rem;
  padding: 0.35rem 0.25rem;
}

.proposal__item--dismissed,
.proposal__item--withdrawn {
  opacity: 0.6;
}

.proposal__check {
  align-items: center;
  display: flex;
  justify-content: center;
  min-height: 2.75rem;
  min-width: 2.75rem;
  margin: -0.6rem -0.5rem -0.6rem -0.6rem;
}

.proposal__check input {
  height: 1.1rem;
  width: 1.1rem;
}

.proposal__state {
  color: var(--muted);
  min-width: 1.6rem;
  text-align: center;
}

.proposal__item--applied .proposal__state {
  color: var(--success);
}

.proposal__item--failed .proposal__state {
  color: var(--danger);
}

.proposal__body {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.proposal__label {
  color: var(--ink);
  font-size: 0.9rem;
  font-weight: 600;
}

.proposal__detail,
.proposal__status {
  color: var(--muted);
  font-size: 0.8rem;
}

.proposal__error {
  color: var(--danger);
  font-size: 0.8rem;
}

.proposal__children {
  color: var(--ink-soft);
  font-size: 0.82rem;
  margin: 0.25rem 0 0;
  padding-left: 1.1rem;
}

.proposal__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.75rem;
}

.proposal__actions .btn {
  min-height: 2.75rem;
}
</style>
