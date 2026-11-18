<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Sortable from 'sortablejs';

import { formatDateRange } from '../../lib/projects/project-editor.js';
import { htmlToPlainText } from '../../lib/rich-content/html.js';

const props = defineProps({
  activeTaskId: {
    default: '',
    type: String,
  },
  story: {
    default: null,
    type: Object,
  },
  taskGenerationBusy: {
    default: false,
    type: Boolean,
  },
});

defineEmits(['add-task', 'generate-tasks', 'remove-task', 'select-task']);

const tbodyRef = ref(null);
let sortable = null;

function destroySortable() {
  if (sortable) {
    sortable.destroy();
    sortable = null;
  }
}

function ensureSortable() {
  destroySortable();

  if (!tbodyRef.value || !props.story?.tasks || props.story.tasks.length < 2) {
    return;
  }

  sortable = Sortable.create(tbodyRef.value, {
    animation: 150,
    draggable: 'tr.task-table__row',
    handle: '.task-table__drag-handle',
    onEnd: (event) => {
      const tasks = props.story?.tasks;
      if (!tasks || !Number.isFinite(event?.oldIndex) || !Number.isFinite(event?.newIndex)) {
        return;
      }

      if (event.oldIndex === event.newIndex) {
        return;
      }

      const from = Math.max(0, Math.min(event.oldIndex, tasks.length - 1));
      const to = Math.max(0, Math.min(event.newIndex, tasks.length - 1));
      const [moved] = tasks.splice(from, 1);
      tasks.splice(to, 0, moved);
    },
  });
}

onMounted(() => {
  nextTick(ensureSortable);
});

watch(
  () => (props.story?.tasks ?? []).length,
  () => {
    nextTick(ensureSortable);
  },
);

onBeforeUnmount(() => {
  destroySortable();
});
</script>

<template>
  <section class="workbench-card">
    <div class="workbench-card__header">
      <div>
        <p class="card-eyebrow">Tasks</p>
        <h4 class="workbench-card__title">Execution table</h4>
      </div>
      <div class="btn-group action-dropdown" role="group" aria-label="Task actions">
        <button class="secondary-button secondary-button--compact" type="button" @click="$emit('add-task')">
          <i class="bi bi-plus-square" aria-hidden="true"></i>
          <span>Add task</span>
        </button>
        <button
          class="secondary-button secondary-button--compact dropdown-toggle dropdown-toggle-split action-dropdown__toggle"
          type="button"
          data-bs-toggle="dropdown"
          aria-expanded="false"
          aria-label="More task actions"
        ></button>
        <ul class="dropdown-menu dropdown-menu-end action-dropdown__menu">
          <li>
            <button class="dropdown-item action-dropdown__item" type="button" :disabled="taskGenerationBusy" @click="$emit('generate-tasks')">
              <i :class="taskGenerationBusy ? 'bi bi-arrow-repeat' : 'bi bi-stars'" aria-hidden="true"></i>
              <span>{{ taskGenerationBusy ? 'Working...' : 'Generate tasks' }}</span>
            </button>
          </li>
        </ul>
      </div>
    </div>

    <div class="task-table-wrap">
      <table class="task-table">
        <thead>
          <tr>
            <th class="task-table__drag" aria-hidden="true"></th>
            <th>Task</th>
            <th>Status</th>
            <th>Assignee</th>
            <th>Priority</th>
            <th>Points</th>
            <th>Hours</th>
            <th>Dates</th>
            <th class="task-table__actions">Actions</th>
          </tr>
        </thead>
        <tbody ref="tbodyRef">
          <tr
            v-for="task in story?.tasks ?? []"
            :key="task.id"
            class="task-table__row"
            :class="{ 'task-table__row--active': activeTaskId === task.id }"
          >
            <td class="task-table__drag">
              <span class="task-table__drag-handle" aria-hidden="true">
                <i class="bi bi-grip-vertical"></i>
              </span>
            </td>
            <td>
              <button class="task-table__link" type="button" @click="$emit('select-task', task.id)">
                {{ task.name }}
              </button>
              <p v-if="htmlToPlainText(task.description)" class="task-table__description">
                {{ htmlToPlainText(task.description) }}
              </p>
            </td>
            <td>
              <span class="tree-badge">{{ task.status }}</span>
            </td>
            <td>{{ task.assigneeName || '—' }}</td>
            <td>P{{ task.priority ?? 4 }}</td>
            <td>{{ task.points ?? '—' }}</td>
            <td>{{ task.targetHourEstimate ?? '—' }}</td>
            <td>{{ formatDateRange(task.targetStartDate, task.targetEndDate) }}</td>
            <td class="task-table__actions">
              <div class="btn-group action-dropdown" role="group" aria-label="Task row actions">
                <button class="ghost-button ghost-button--compact" type="button" @click="$emit('select-task', task.id)">
                  <i class="bi bi-pencil-square" aria-hidden="true"></i>
                  <span>Edit task</span>
                </button>
                <button
                  class="ghost-button ghost-button--compact dropdown-toggle dropdown-toggle-split action-dropdown__toggle"
                  type="button"
                  data-bs-toggle="dropdown"
                  aria-expanded="false"
                  aria-label="More task row actions"
                ></button>
                <ul class="dropdown-menu dropdown-menu-end action-dropdown__menu">
                  <li>
                    <button class="dropdown-item action-dropdown__item action-dropdown__item--danger" type="button" @click="$emit('remove-task', task.id)">
                      <i class="bi bi-trash3" aria-hidden="true"></i>
                      <span>Remove task</span>
                    </button>
                  </li>
                </ul>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
