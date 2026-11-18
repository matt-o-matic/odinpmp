<script setup>
import { computed, ref, watch } from 'vue';

import { apiClient } from '../../lib/auth/index.js';
import { useOverlayScrollLock } from '../../lib/ui/overlay-scroll-lock.js';

const props = defineProps({
  open: {
    default: false,
    type: Boolean,
  },
  projectId: {
    required: true,
    type: String,
  },
  sprints: {
    default: () => [],
    type: Array,
  },
  story: {
    default: null,
    type: Object,
  },
  token: {
    default: '',
    type: String,
  },
});

const emit = defineEmits(['close', 'split']);

const selectedTaskIds = ref([]);
const formState = ref({
  assigneeId: null,
  description: '',
  name: '',
  points: null,
  priority: 4,
  sprintId: null,
  status: 'Not Started',
  targetEndDate: null,
  targetHourEstimate: null,
  targetStartDate: null,
});
const saving = ref(false);
const errorMessage = ref('');

const tasks = computed(() => props.story?.tasks ?? []);

useOverlayScrollLock(() => props.open);

watch(
  () => [props.open, props.story?.id ?? ''],
  () => {
    if (!props.open || !props.story) {
      return;
    }

    selectedTaskIds.value = tasks.value.map((task) => task.id);
    formState.value = {
      assigneeId: props.story.assigneeId ?? null,
      description: props.story.description ?? '',
      name: `${props.story.name} - Follow Up`,
      points: null,
      priority: props.story.priority ?? 4,
      sprintId: props.story.sprintId ?? null,
      status: 'Not Started',
      targetEndDate: props.story.targetEndDate ?? null,
      targetHourEstimate: null,
      targetStartDate: props.story.targetStartDate ?? null,
    };
    errorMessage.value = '';
  },
  { immediate: true },
);

function toggleTask(taskId) {
  if (selectedTaskIds.value.includes(taskId)) {
    selectedTaskIds.value = selectedTaskIds.value.filter((id) => id !== taskId);
    return;
  }

  selectedTaskIds.value = [...selectedTaskIds.value, taskId];
}

async function submitSplit() {
  if (!props.projectId || !props.story?.id || !props.token) {
    return;
  }

  if (selectedTaskIds.value.length === 0) {
    errorMessage.value = 'Select at least one task to move into the new story.';
    return;
  }

  saving.value = true;
  errorMessage.value = '';

  try {
    const result = await apiClient.splitStory(
      props.projectId,
      props.story.id,
      {
        ...formState.value,
        taskIds: selectedTaskIds.value,
      },
      props.token,
    );

    emit('split', result);
    emit('close');
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to split the story.';
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div v-if="open" class="modal fade show" tabindex="-1" aria-modal="true" role="dialog" style="display: block;">
    <div class="modal-dialog modal-dialog-centered modal-dialog-scrollable modal-lg">
      <div class="modal-content">
        <div class="modal-header">
          <h5 class="modal-title">Split Story</h5>
          <button class="btn-close" type="button" aria-label="Close" @click="$emit('close')"></button>
        </div>
        <div class="modal-body planning-modal-body">
          <p class="muted-copy">
            Move selected tasks from <strong>{{ story?.name }}</strong> into a new follow-on story.
          </p>

          <div class="field-group">
            <label>New story name</label>
            <input v-model="formState.name" />
          </div>

          <div class="editor-grid editor-grid--wide">
            <div class="field-group">
              <label>Status</label>
              <input v-model="formState.status" />
            </div>
            <div class="field-group">
              <label>Sprint</label>
              <select v-model="formState.sprintId">
                <option :value="null">Backlog</option>
                <option v-for="sprint in sprints" :key="sprint.id" :value="sprint.id">{{ sprint.name }}</option>
              </select>
            </div>
            <div class="field-group">
              <label>Points</label>
              <input v-model.number="formState.points" min="0" step="1" type="number" />
            </div>
            <div class="field-group">
              <label>Hours</label>
              <input v-model.number="formState.targetHourEstimate" min="0" step="1" type="number" />
            </div>
          </div>

          <div class="field-group">
            <label>Description</label>
            <textarea v-model="formState.description" rows="5"></textarea>
          </div>

          <div class="field-row">
            <div class="field-group">
              <label>Start date</label>
              <input v-model="formState.targetStartDate" type="date" />
            </div>
            <div class="field-group">
              <label>End date</label>
              <input v-model="formState.targetEndDate" type="date" />
            </div>
          </div>

          <div class="planning-list-card">
            <div class="planning-list-card__header">
              <div>
                <p class="card-eyebrow">Tasks</p>
                <h6 class="workbench-card__title">Move into the new story</h6>
              </div>
              <span class="muted-copy">{{ selectedTaskIds.length }} selected</span>
            </div>

            <label
              v-for="task in tasks"
              :key="task.id"
              class="planning-check-row"
            >
              <input
                :checked="selectedTaskIds.includes(task.id)"
                type="checkbox"
                @change="toggleTask(task.id)"
              />
              <span>
                <strong>{{ task.name }}</strong>
                <small>{{ task.status }} | {{ task.assigneeName || 'Unassigned' }}</small>
              </span>
            </label>
          </div>

          <p v-if="errorMessage" class="rich-editor__error">{{ errorMessage }}</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary btn-sm" type="button" @click="$emit('close')">Cancel</button>
          <button class="btn btn-primary btn-sm" type="button" :disabled="saving" @click="submitSplit">
            {{ saving ? 'Splitting...' : 'Split story' }}
          </button>
        </div>
      </div>
    </div>
  </div>
  <div v-if="open" class="modal-backdrop fade show"></div>
</template>
