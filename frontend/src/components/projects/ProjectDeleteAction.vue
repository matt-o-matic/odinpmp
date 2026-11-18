<script setup>
import { computed, ref } from 'vue';

import RequirementsConfirmDialog from '../requirements/RequirementsConfirmDialog.vue';
import { projectStore } from '../../lib/projects/index.js';
import { describeProjectDeleteError, projectNameConfirmed } from '../../lib/projects/project-deletion.js';

// The project settings drawer's danger action: a soft delete confirmed by typing the name.
const props = defineProps({
  project: { required: true, type: Object },
});

const emit = defineEmits(['deleted']);

const open = ref(false);
const typedName = ref('');
const busy = ref(false);
const error = ref('');
const inputId = `project-delete-name-${Math.random().toString(36).slice(2, 10)}`;
const confirmed = computed(() => projectNameConfirmed(typedName.value, props.project?.name));

function openDialog() {
  typedName.value = '';
  error.value = '';
  open.value = true;
}

function close() {
  if (busy.value) return;
  open.value = false;
}

async function confirmDelete() {
  if (!props.project?.id || !confirmed.value || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const deleted = await projectStore.deleteProject(props.project.id);
    open.value = false;
    emit('deleted', deleted ?? props.project);
  } catch (caught) {
    error.value = describeProjectDeleteError(caught);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="project-delete-action">
    <button class="project-delete-action__button" type="button" @click="openDialog">
      <i class="bi bi-trash3" aria-hidden="true"></i>
      Delete project
    </button>

    <RequirementsConfirmDialog
      :busy="busy"
      :confirm-disabled="!confirmed"
      confirm-label="Delete project"
      :error="error"
      :open="open"
      title="Delete this project?"
      @close="close"
      @confirm="confirmDelete"
    >
      <div class="project-delete-action__body">
        <p class="mb-0">
          <strong>{{ project.name }}</strong> and its work items, tickets, comments and files will disappear for everyone,
          including search, reports and the AI Workspace.
        </p>
        <p class="mb-0 rq-muted">Nothing is erased. A tenant admin can restore the project from Tenant Admin, Deleted Projects.</p>
        <div v-if="!error" class="rq-field">
          <label :for="inputId">Type the project name to confirm</label>
          <input
            :id="inputId"
            v-model="typedName"
            autocomplete="off"
            class="form-control"
            :disabled="busy"
            spellcheck="false"
            type="text"
          />
        </div>
      </div>
    </RequirementsConfirmDialog>
  </div>
</template>

<style scoped>
.project-delete-action {
  margin-top: auto;
  padding-top: 0.75rem;
  border-top: 1px solid var(--line-strong);
}

.project-delete-action__button {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  width: 100%;
  min-height: 2.75rem;
  padding: 0.55rem 0.75rem;
  border: 1px solid rgba(180, 35, 24, 0.35);
  border-radius: 0.375rem;
  /* Opaque so the drawer footer, which can run under the rail on narrow screens, cannot show through. */
  background: var(--surface);
  color: #b42318;
  font-size: 0.875rem;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}

.project-delete-action__button:hover {
  border-color: #b42318;
  box-shadow: inset 0 0 0 100vmax rgba(180, 35, 24, 0.08);
}

.project-delete-action__button:focus-visible {
  outline: 2px solid #b42318;
  outline-offset: 2px;
}

:root.dark .project-delete-action__button {
  border-color: rgba(255, 138, 128, 0.45);
  color: #ff8a80;
}

:root.dark .project-delete-action__button:hover {
  border-color: #ff8a80;
  box-shadow: inset 0 0 0 100vmax rgba(255, 138, 128, 0.12);
}

.project-delete-action__body {
  display: grid;
  gap: 0.75rem;
}

.project-delete-action__body .form-control {
  min-height: 2.75rem;
}
</style>
