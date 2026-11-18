<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Sortable from 'sortablejs';

import AccessStatusChip from './AccessStatusChip.vue';
import { dueText, formatHours, itemParent, itemTypeText } from '../../lib/task-access/access-view.js';

// The guest board: the project's columns with its epics, stories and tasks. Each card names
// its type and what it sits under; screen readers hear the type in the card's button, so the
// visible type is hidden from them. Only the person's own cards drag; dropping one in another
// column asks the page to save the move. The status control in the card's detail does the
// same without dragging, for keyboards and touch.
const props = defineProps({
  columns: { default: () => [], type: Array },
});

const emit = defineEmits(['dragging', 'move', 'open']);

const root = ref(null);
// Without a hold delay, a drag starts on the slight finger movement of a tap, which would
// swallow the tap that opens a card (same settings as the app's board).
const SORTABLE_OPTIONS = {
  animation: 150,
  delay: 220,
  delayOnTouchOnly: true,
  draggable: '.access-card--mine',
  fallbackTolerance: 8,
  group: 'odin-access-board',
  touchStartThreshold: 6,
};
let sortables = [];
let containers = [];
let dragging = false;

function destroySortables() {
  for (const sortable of sortables) sortable.destroy();
  sortables = [];
  containers = [];
}

// Sortable moves DOM nodes that Vue owns. Put the node back and let Vue re-render from the
// page's state, as the app's board does.
function restoreItem({ from, item, oldIndex }) {
  const siblings = [...from.children].filter((child) => child !== item);
  const reference = siblings[oldIndex];
  if (reference) from.insertBefore(item, reference);
  else if (siblings.length) siblings[siblings.length - 1].after(item);
  else from.appendChild(item);
}

function handleEnd(event) {
  restoreItem(event);
  const taskId = String(event.item?.getAttribute('data-task-id') ?? '');
  const columnKey = String(event.to?.getAttribute('data-column-key') ?? '');
  const fromColumnKey = String(event.from?.getAttribute('data-column-key') ?? '');
  if (taskId && columnKey && columnKey !== fromColumnKey) emit('move', { columnKey, fromColumnKey, taskId });
}

async function syncSortables() {
  await nextTick();
  const next = Array.from(root.value?.querySelectorAll('.access-board__cards') ?? []);
  // Rebuilding the handlers mid-drag would drop the drag, so keep them while the same lists show.
  if (dragging || (next.length === containers.length && next.every((element, index) => element === containers[index]))) return;
  destroySortables();
  containers = next;
  for (const container of next) {
    sortables.push(Sortable.create(container, {
      ...SORTABLE_OPTIONS,
      onEnd: (event) => {
        try {
          handleEnd(event);
        } finally {
          dragging = false;
          emit('dragging', false);
          syncSortables();
        }
      },
      onStart: () => {
        dragging = true;
        emit('dragging', true);
      },
    }));
  }
}

watch(() => props.columns, syncSortables, { deep: true });
onMounted(syncSortables);
onBeforeUnmount(destroySortables);
</script>

<template>
  <div ref="root" class="access-board" data-testid="access-board">
    <section
      v-for="column in columns"
      :key="column.key"
      class="access-board__column"
      :aria-labelledby="`access-column-${column.key}`"
    >
      <header class="access-board__head">
        <h2 :id="`access-column-${column.key}`" class="access-board__title">{{ column.name }}</h2>
        <span class="rq-xs rq-muted">{{ column.items.length }}<span class="visually-hidden"> {{ column.items.length === 1 ? 'item' : 'items' }}</span></span>
      </header>
      <p v-if="!column.items.length" class="access-board__empty rq-xs rq-muted mb-0">No items</p>
      <ul class="access-board__cards" :data-column-key="column.key" :aria-labelledby="`access-column-${column.key}`">
        <li
          v-for="item in column.items"
          :key="item.id"
          class="access-card"
          :class="{ 'access-card--mine': item.mine }"
          :data-task-id="item.id"
        >
          <button class="access-card__open" type="button" @click="emit('open', item.id)">
            <span class="access-card__name">{{ item.name }}</span>
            <span class="visually-hidden">, {{ item.mine ? `your ${itemTypeText(item.itemType).noun}` : itemTypeText(item.itemType).noun }}</span>
          </button>
          <p class="access-card__context mb-0">
            <span class="access-card__type" aria-hidden="true"><i class="bi" :class="itemTypeText(item.itemType).icon"></i>{{ itemTypeText(item.itemType).label }}</span>
            <span v-if="itemParent(item)" class="access-card__fact">
              <i class="bi" :class="itemParent(item).icon" aria-hidden="true"></i><span class="visually-hidden">in {{ itemParent(item).noun }} </span>{{ itemParent(item).name }}
            </span>
          </p>
          <div class="access-card__meta">
            <span v-if="item.mine" class="rq-chip rq-chip--solid"><i class="bi bi-person-check" aria-hidden="true"></i>Yours</span>
            <span v-else class="access-card__fact"><i class="bi bi-person" aria-hidden="true"></i>{{ item.assigneeName || 'Unassigned' }}</span>
            <AccessStatusChip v-if="column.statuses.length > 1" :status="item.status" />
            <span v-if="dueText(item).text" class="access-card__fact" :class="{ 'access-overdue': dueText(item).overdue }">
              <i class="bi bi-calendar-event" aria-hidden="true"></i>{{ dueText(item).text }}
            </span>
            <span v-if="item.remainingHours != null" class="access-card__fact">
              <i class="bi bi-hourglass-split" aria-hidden="true"></i>{{ formatHours(item.remainingHours) }} left
            </span>
          </div>
          <i v-if="item.mine" class="bi bi-grip-vertical access-card__grip" aria-hidden="true"></i>
        </li>
      </ul>
    </section>
  </div>
</template>
