<script setup>
import { computed, nextTick, ref, watch } from 'vue';

import { useOverlayScrollLock } from '../../lib/ui/overlay-scroll-lock.js';
import WorkItemTemplatePicker from '../workflows/WorkItemTemplatePicker.vue';
import {
  applyKanbanCardTemplate,
  buildKanbanCardCreatePayload,
  changeKanbanCardType,
  createKanbanCardForm,
  kanbanCardParentOptions,
  validateKanbanCardForm,
} from '../../lib/projects/kanban-card-create.js';

const props = defineProps({
  errorMessage: {
    default: '',
    type: String,
  },
  open: {
    default: false,
    type: Boolean,
  },
  project: {
    default: null,
    type: Object,
  },
  saving: {
    default: false,
    type: Boolean,
  },
  sprints: {
    default: () => [],
    type: Array,
  },
  statusOptions: {
    default: () => [],
    type: Array,
  },
  // The pursuit board's form: a task under the board's one story, with a due date, and no type,
  // story, sprint or points to choose.
  taskOnly: {
    default: false,
    type: Boolean,
  },
  token: {
    default: '',
    type: String,
  },
  validUsers: {
    default: () => [],
    type: Array,
  },
});

const emit = defineEmits(['close', 'submit']);

const form = ref(createKanbanCardForm(props.project, props.statusOptions, { taskOnly: props.taskOnly }));
const errors = ref({});
const submitted = ref(false);
const nameInputRef = ref(null);

const storyParents = computed(() => kanbanCardParentOptions(props.project, 'story'));
const taskParents = computed(() => kanbanCardParentOptions(props.project, 'task'));
const parentOptions = computed(() => (form.value.issueType === 'task' ? taskParents.value : storyParents.value));
const parentLabel = computed(() => (form.value.issueType === 'task' ? 'Story' : 'Epic'));
const noParents = computed(() => storyParents.value.length === 0 && taskParents.value.length === 0);

useOverlayScrollLock(() => props.open);

watch(
  () => props.open,
  async (open) => {
    if (!open) {
      return;
    }

    // Each opening starts from a clean form, so a cancelled card leaves nothing behind.
    form.value = createKanbanCardForm(props.project, props.statusOptions, { taskOnly: props.taskOnly });
    errors.value = {};
    submitted.value = false;
    await nextTick();
    nameInputRef.value?.focus();
  },
  { immediate: true },
);

watch(
  form,
  () => {
    // Re-check as the user fixes fields, but only once they have tried to save.
    if (submitted.value) {
      errors.value = validateKanbanCardForm(form.value, { project: props.project, statusOptions: props.statusOptions });
    }
  },
  { deep: true },
);

function changeType(issueType) {
  form.value = changeKanbanCardType(form.value, props.project, issueType);
}

function applyTemplate(template) {
  form.value = applyKanbanCardTemplate(form.value, template);
}

function requestClose() {
  if (props.saving) {
    return;
  }
  emit('close');
}

function submit() {
  if (props.saving) {
    return;
  }

  submitted.value = true;
  errors.value = validateKanbanCardForm(form.value, { project: props.project, statusOptions: props.statusOptions });
  if (Object.keys(errors.value).length > 0) {
    return;
  }

  emit('submit', buildKanbanCardCreatePayload(form.value, { validUsers: props.validUsers }));
}
</script>

<template>
  <div
    v-if="open"
    class="modal fade show"
    tabindex="-1"
    aria-modal="true"
    aria-labelledby="kanban-card-create-title"
    role="dialog"
    style="display: block;"
    @keydown.esc="requestClose"
  >
    <div class="modal-dialog modal-dialog-centered modal-dialog-scrollable">
      <form class="modal-content" novalidate @submit.prevent="submit">
        <div class="modal-header">
          <h5 id="kanban-card-create-title" class="modal-title">{{ taskOnly ? 'New task' : 'New card' }}</h5>
          <button class="btn-close" type="button" aria-label="Close" :disabled="saving" @click="requestClose"></button>
        </div>
        <div class="modal-body planning-modal-body">
          <p v-if="noParents" class="muted-copy">Add an epic to this project before creating cards.</p>

          <div v-if="!taskOnly" class="field-group">
            <label for="kanban-card-create-type">Type</label>
            <select
              id="kanban-card-create-type"
              :value="form.issueType"
              :disabled="saving"
              @change="changeType($event.target.value)"
            >
              <option value="story" :disabled="storyParents.length === 0">Story</option>
              <option value="task" :disabled="taskParents.length === 0">Task</option>
            </select>
          </div>

          <WorkItemTemplatePicker
            v-model="form.templateId"
            input-id="kanban-card-create-template"
            :disabled="saving"
            :item-type="form.issueType"
            :token="token"
            @apply="applyTemplate"
          />

          <div class="field-group">
            <label for="kanban-card-create-name">Name</label>
            <input
              id="kanban-card-create-name"
              ref="nameInputRef"
              v-model="form.name"
              :aria-invalid="Boolean(errors.name)"
              :aria-describedby="errors.name ? 'kanban-card-create-name-error' : undefined"
              :disabled="saving"
              maxlength="200"
              required
            />
            <p v-if="errors.name" id="kanban-card-create-name-error" class="rich-editor__error">{{ errors.name }}</p>
          </div>

          <div v-if="!taskOnly" class="field-group">
            <label for="kanban-card-create-parent">{{ parentLabel }}</label>
            <select
              id="kanban-card-create-parent"
              v-model="form.parentId"
              :aria-invalid="Boolean(errors.parentId)"
              :aria-describedby="errors.parentId ? 'kanban-card-create-parent-error' : undefined"
              :disabled="saving"
              required
            >
              <option value="" disabled>Choose {{ parentLabel.toLowerCase() }}</option>
              <option v-for="parent in parentOptions" :key="parent.id" :value="parent.id">{{ parent.label }}</option>
            </select>
            <p v-if="errors.parentId" id="kanban-card-create-parent-error" class="rich-editor__error">{{ errors.parentId }}</p>
          </div>

          <div class="editor-grid editor-grid--wide">
            <div class="field-group">
              <label for="kanban-card-create-status">Status</label>
              <select
                id="kanban-card-create-status"
                v-model="form.status"
                :aria-invalid="Boolean(errors.status)"
                :aria-describedby="errors.status ? 'kanban-card-create-status-error' : undefined"
                :disabled="saving"
                required
              >
                <option v-for="status in statusOptions" :key="status" :value="status">{{ status }}</option>
              </select>
              <p v-if="errors.status" id="kanban-card-create-status-error" class="rich-editor__error">{{ errors.status }}</p>
            </div>
            <div v-if="taskOnly" class="field-group">
              <label for="kanban-card-create-due">Due date</label>
              <input
                id="kanban-card-create-due"
                v-model="form.dueDate"
                :aria-invalid="Boolean(errors.dueDate)"
                :aria-describedby="errors.dueDate ? 'kanban-card-create-due-error' : undefined"
                :disabled="saving"
                type="date"
              />
              <p v-if="errors.dueDate" id="kanban-card-create-due-error" class="rich-editor__error">{{ errors.dueDate }}</p>
            </div>
            <div v-if="!taskOnly" class="field-group">
              <label for="kanban-card-create-sprint">Sprint</label>
              <select id="kanban-card-create-sprint" v-model="form.sprintId" :disabled="saving">
                <option value="">Backlog</option>
                <option v-for="sprint in sprints" :key="sprint.id" :value="sprint.id">{{ sprint.name }}</option>
              </select>
            </div>
            <div class="field-group">
              <label for="kanban-card-create-assignee">Assignee</label>
              <select id="kanban-card-create-assignee" v-model="form.assigneeId" :disabled="saving">
                <option value="">Unassigned</option>
                <option v-for="user in validUsers" :key="user.id" :value="user.id">{{ user.name }}{{ user.resourceOnly ? ' (no login)' : user.outside ? (user.guest ? ' (guest)' : ' (stakeholder)') : '' }}</option>
              </select>
            </div>
            <div v-if="!taskOnly" class="field-group">
              <label for="kanban-card-create-points">Points</label>
              <input
                id="kanban-card-create-points"
                v-model="form.points"
                :aria-invalid="Boolean(errors.points)"
                :aria-describedby="errors.points ? 'kanban-card-create-points-error' : undefined"
                :disabled="saving"
                inputmode="numeric"
                min="0"
                max="999"
                step="1"
                type="number"
              />
              <p v-if="errors.points" id="kanban-card-create-points-error" class="rich-editor__error">{{ errors.points }}</p>
            </div>
          </div>

          <div class="field-group">
            <label for="kanban-card-create-description">Description</label>
            <textarea id="kanban-card-create-description" v-model="form.description" :disabled="saving" maxlength="5000" rows="3"></textarea>
          </div>

          <p v-if="errorMessage" class="rich-editor__error" role="alert">{{ errorMessage }}</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary btn-sm" type="button" :disabled="saving" @click="requestClose">Cancel</button>
          <button class="btn btn-primary btn-sm" type="submit" :disabled="saving || noParents">
            {{ saving ? 'Creating...' : taskOnly ? 'Create task' : 'Create card' }}
          </button>
        </div>
      </form>
    </div>
  </div>
  <div v-if="open" class="modal-backdrop fade show"></div>
</template>
