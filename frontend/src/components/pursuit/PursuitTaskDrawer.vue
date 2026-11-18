<script setup>
import { computed, nextTick, ref, watch } from 'vue';

import ProjectCommentsPanel from '../projects/ProjectCommentsPanel.vue';
import ProjectFilesPanel from '../projects/ProjectFilesPanel.vue';
import { apiClient, authSession } from '../../lib/auth/index.js';
import {
  PURSUIT_PRIORITY_OPTIONS,
  PURSUIT_STATUS_OPTIONS,
  pursuitTaskForm,
  pursuitTaskPatch,
  validatePursuitTaskForm,
} from '../../lib/pursuit/pursuit.js';
import { useOverlayScrollLock } from '../../lib/ui/overlay-scroll-lock.js';

// One pursuit task: its fields, its comments and its attachments, beside the board. People who
// can't edit the plan read the fields and still comment and attach, as on any task.

const props = defineProps({
  canEdit: { default: false, type: Boolean },
  people: { default: () => [], type: Array },
  projectId: { required: true, type: String },
  task: { default: null, type: Object },
});

const emit = defineEmits(['close', 'saved']);

const form = ref(pursuitTaskForm(null));
const errors = ref({});
const saving = ref(false);
const saveError = ref('');
const nameInput = ref(null);
const open = computed(() => Boolean(props.task));
const titleId = 'pursuit-task-drawer-title';

useOverlayScrollLock(open);

watch(
  () => props.task?.id,
  async (id) => {
    if (!id) return;
    form.value = pursuitTaskForm(props.task);
    errors.value = {};
    saveError.value = '';
    await nextTick();
    nameInput.value?.focus();
  },
  { immediate: true },
);

// Who an assignee is, after their name: no login, a channel guest, or another stakeholder.
function assigneeSuffix(person) {
  if (person.resourceOnly) return ' (no login)';
  if (person.outside) return person.guest ? ' (guest)' : ' (stakeholder)';
  return '';
}

function close() {
  if (!saving.value) emit('close');
}

async function save() {
  errors.value = validatePursuitTaskForm(form.value);
  if (Object.keys(errors.value).length) return;
  const patch = pursuitTaskPatch(props.task, form.value, props.people);
  if (!Object.keys(patch).length) {
    emit('close');
    return;
  }
  saving.value = true;
  saveError.value = '';
  try {
    const result = await apiClient.updateProjectItem(props.projectId, props.task.id, { expectedVersion: props.task.version, patch }, authSession.state.token);
    emit('saved', result);
  } catch (error) {
    saveError.value = error?.status === 409
      ? 'Someone else changed this task. Close it and open it again to see their version.'
      : error?.message || 'The task could not be saved.';
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <template v-if="open">
    <div class="kanban-drawer-backdrop" @click="close"></div>
    <aside class="kanban-drawer kanban-drawer--right pursuit-task-drawer" role="dialog" aria-modal="true" :aria-labelledby="titleId" @keydown.esc="close">
      <header class="kanban-drawer__header">
        <div>
          <p class="card-eyebrow">Task</p>
          <h3 :id="titleId" class="workbench-card__title">{{ task.name }}</h3>
        </div>
        <button class="kanban-drawer__close" type="button" aria-label="Close task" :disabled="saving" @click="close">x</button>
      </header>
      <div class="kanban-drawer__body">
        <form id="pursuit-task-form" class="pursuit-task-drawer__form" novalidate @submit.prevent="save">
          <fieldset :disabled="!canEdit || saving">
            <div class="field-group">
              <label for="pursuit-task-name">Name</label>
              <input id="pursuit-task-name" ref="nameInput" v-model="form.name" maxlength="200" :aria-invalid="Boolean(errors.name)" :aria-describedby="errors.name ? 'pursuit-task-name-error' : undefined" />
              <p v-if="errors.name" id="pursuit-task-name-error" class="rich-editor__error">{{ errors.name }}</p>
            </div>
            <div class="editor-grid editor-grid--wide">
              <div class="field-group">
                <label for="pursuit-task-status">Status</label>
                <select id="pursuit-task-status" v-model="form.status">
                  <option v-for="status in [...new Set([...PURSUIT_STATUS_OPTIONS, task.status])]" :key="status" :value="status">{{ status }}</option>
                </select>
              </div>
              <div class="field-group">
                <label for="pursuit-task-assignee">Assignee</label>
                <select id="pursuit-task-assignee" v-model="form.assigneeId">
                  <option value="">Unassigned</option>
                  <option v-for="person in people" :key="person.id" :value="person.id">{{ person.name }}{{ assigneeSuffix(person) }}</option>
                </select>
              </div>
              <div class="field-group">
                <label for="pursuit-task-due">Due date</label>
                <input id="pursuit-task-due" v-model="form.dueDate" type="date" :aria-invalid="Boolean(errors.dueDate)" />
                <p v-if="errors.dueDate" class="rich-editor__error">{{ errors.dueDate }}</p>
              </div>
              <div class="field-group">
                <label for="pursuit-task-priority">Priority</label>
                <select id="pursuit-task-priority" v-model.number="form.priority">
                  <option v-for="option in PURSUIT_PRIORITY_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
                </select>
              </div>
            </div>
            <div class="field-group">
              <label for="pursuit-task-description">Description</label>
              <textarea id="pursuit-task-description" v-model="form.description" maxlength="5000" rows="4"></textarea>
            </div>
          </fieldset>
          <p v-if="saveError" class="rich-editor__error" role="alert">{{ saveError }}</p>
        </form>

        <section class="pursuit-task-drawer__section" aria-label="Comments">
          <ProjectCommentsPanel
            :api-base-url="authSession.state.apiBaseUrl"
            :current-user-id="authSession.state.currentUser?.id ?? ''"
            :current-user-role="authSession.state.currentUser?.role ?? 'user'"
            :project-id="projectId"
            :target-id="task.id"
            target-type="task"
            :token="authSession.state.token"
          />
        </section>
        <section class="pursuit-task-drawer__section" aria-label="Attachments">
          <ProjectFilesPanel :project-id="projectId" :target-id="task.id" target-type="task" :token="authSession.state.token" />
        </section>
      </div>
      <footer class="kanban-drawer__footer">
        <button class="secondary-button" type="button" :disabled="saving" @click="close">{{ canEdit ? 'Cancel' : 'Close' }}</button>
        <button v-if="canEdit" class="primary-button" type="submit" form="pursuit-task-form" :disabled="saving">{{ saving ? 'Saving…' : 'Save' }}</button>
      </footer>
    </aside>
  </template>
</template>

<style scoped>
.pursuit-task-drawer {
  width: min(34rem, calc(100vw - 1rem));
}

.pursuit-task-drawer__form fieldset {
  display: grid;
  gap: 0.75rem;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}

.pursuit-task-drawer__section {
  min-width: 0;
  padding-top: 0.75rem;
  border-top: 1px solid var(--line);
}
</style>
