<script setup>
import { computed, ref, useId } from 'vue';

import { reopenLabel } from '../../lib/projects/ticket-board.js';

// Compact count of how often a reporter reopened a ticket. Pressing it (click, tap, Enter or
// Space) shows the explanation in the flow of the card or row, so it never covers the next
// ticket or gets clipped by a scrolling board. Pressing it again or Escape hides it.
const props = defineProps({
  count: {
    required: true,
    type: Number,
  },
  lastReopenedAt: {
    default: null,
    type: String,
  },
});

const noteId = `ticket-reopen-note-${useId()}`;
const open = ref(false);

const label = computed(() => reopenLabel(props.count));
const lastReopened = computed(() => {
  const date = props.lastReopenedAt ? new Date(props.lastReopenedAt) : null;
  return date && !Number.isNaN(date.valueOf())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
    : '';
});

function toggle() {
  open.value = !open.value;
}

function closeOnEscape(event) {
  if (!open.value) return;
  event.stopPropagation();
  open.value = false;
}
</script>

<template>
  <button
    class="ticket-reopen"
    type="button"
    :aria-controls="noteId"
    :aria-expanded="open ? 'true' : 'false'"
    :aria-label="label"
    @click.stop="toggle"
    @keydown.esc="closeOnEscape"
  >
    <i class="bi bi-arrow-counterclockwise" aria-hidden="true"></i>
    <span aria-hidden="true">{{ count }}</span>
  </button>
  <span v-show="open" :id="noteId" class="ticket-reopen-note" @click.stop>
    <strong>{{ label }}</strong>
    <span>The reporter sent it back after it was resolved or closed. Each reopen returned it to New.</span>
    <span v-if="lastReopened">Last reopened {{ lastReopened }}</span>
  </span>
</template>

<style scoped>
.ticket-reopen {
  position: relative;
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 0.25rem;
  min-height: 1.5rem;
  padding: 0 0.4rem;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: var(--surface-tint);
  color: var(--ink);
  font-size: 0.75rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1.25;
  cursor: pointer;
}

.ticket-reopen[aria-expanded='true'] {
  border-color: var(--accent);
}

.ticket-reopen .bi {
  color: var(--accent);
}

/* Widens the tap area to 2.75rem without changing the badge's size in the layout. */
.ticket-reopen::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: max(100%, 2.75rem);
  height: 2.75rem;
  transform: translate(-50%, -50%);
}

.ticket-reopen:focus-visible {
  outline: 0.18rem solid var(--bs-primary);
  outline-offset: 0.1rem;
}

/*
 * Takes a line of its own below the badge inside the wrapping card and row layouts that hold
 * it. Inline-size containment keeps its text from widening a table column; it wraps to the
 * width of the cell or card instead.
 */
.ticket-reopen-note {
  contain: inline-size;
  display: grid;
  flex: 1 0 100%;
  gap: 0.2rem;
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--line-strong);
  border-radius: 0.375rem;
  background: var(--surface);
  color: var(--ink);
  font-size: 0.8125rem;
  font-weight: 400;
  line-height: 1.3;
  text-align: start;
  white-space: normal;
}

.ticket-reopen-note span {
  color: var(--muted);
  font-size: 0.75rem;
}
</style>
