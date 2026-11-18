<script setup>
import { computed } from 'vue';

import { useOverlayScrollLock } from '../../lib/ui/overlay-scroll-lock.js';
import ProjectWorkbenchEditor from './ProjectWorkbenchEditor.vue';

const props = defineProps({
  activeDetail: {
    default: null,
    type: Object,
  },
  apiBaseUrl: {
    required: true,
    type: String,
  },
  currentUserId: {
    default: '',
    type: String,
  },
  currentUserRole: {
    default: 'user',
    type: String,
  },
  open: {
    default: false,
    type: Boolean,
  },
  projectId: {
    required: true,
    type: String,
  },
  projectStatusOptions: {
    required: true,
    type: Array,
  },
  projectSnapshot: {
    default: null,
    type: Object,
  },
  saving: {
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
  workStatusOptions: {
    required: true,
    type: Array,
  },
});

const emit = defineEmits(['add-story', 'add-task', 'close', 'remove-item', 'reassign-story', 'save', 'select', 'split-story']);

const modalTitle = computed(() => {
  const type = String(props.activeDetail?.type ?? 'item').trim();
  const itemName = String(props.activeDetail?.item?.name ?? '').trim();
  if (!itemName) {
    return 'Edit planning item';
  }

  if (!type || type === 'project') {
    return itemName;
  }

  return `${itemName} · ${type}`;
});

useOverlayScrollLock(() => props.open);
</script>

<template>
  <div v-if="open" class="modal fade show" tabindex="-1" aria-modal="true" role="dialog" style="display: block;">
    <div class="modal-dialog modal-dialog-centered modal-dialog-scrollable modal-xl">
      <div class="modal-content planning-editor-modal">
        <div class="modal-header">
          <div>
            <p class="card-eyebrow mb-1">Kanban Editor</p>
            <h5 class="modal-title">{{ modalTitle }}</h5>
          </div>
          <button class="planning-editor-modal__dismiss" type="button" aria-label="Close editor" @click="$emit('close')">
            <i class="bi bi-x-lg" aria-hidden="true"></i>
          </button>
        </div>
        <div class="modal-body planning-editor-modal__body">
          <ProjectWorkbenchEditor
            v-if="activeDetail?.item"
            :active-detail="activeDetail"
            :api-base-url="apiBaseUrl"
            :current-user-id="currentUserId"
            :current-user-role="currentUserRole"
            :project-id="projectId"
            :project-status-options="projectStatusOptions"
            :project-snapshot="projectSnapshot"
            :token="token"
            :valid-users="validUsers"
            :work-status-options="workStatusOptions"
            @add-story="$emit('add-story', $event)"
            @add-task="$emit('add-task', $event)"
            @remove-item="$emit('remove-item', $event)"
            @reassign-story="$emit('reassign-story', $event)"
            @select="$emit('select', $event)"
            @split-story="$emit('split-story', $event)"
          />
          <div v-else class="planning-editor-modal__empty">
            Select a planning item to edit.
          </div>
        </div>
        <div class="modal-footer planning-editor-modal__footer">
          <button class="ghost-button" type="button" :disabled="saving" @click="$emit('close')">
            <i class="bi bi-x-circle" aria-hidden="true"></i>
            <span>Cancel</span>
          </button>
          <button class="primary-button" type="button" :disabled="saving || !activeDetail?.item" @click="$emit('save')">
            <i :class="saving ? 'bi bi-arrow-repeat' : 'bi bi-check2-circle'" aria-hidden="true"></i>
            <span>{{ saving ? 'Saving...' : 'OK' }}</span>
          </button>
        </div>
      </div>
    </div>
  </div>
  <div v-if="open" class="modal-backdrop fade show" @click="$emit('close')"></div>
</template>

<style scoped>
.planning-editor-modal {
  position: relative;
  min-height: min(90vh, 58rem);
}

.modal-header {
  position: relative;
  padding-right: 4.5rem;
}

.planning-editor-modal__dismiss {
  position: absolute;
  top: 1rem;
  right: 1rem;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.35rem;
  height: 2.35rem;
  padding: 0;
  border: 1px solid var(--line-strong);
  border-radius: 0.55rem;
  background: color-mix(in srgb, var(--surface) 88%, transparent);
  color: var(--ink);
  box-shadow: 0 10px 22px rgba(15, 23, 42, 0.14);
  transition: border-color 160ms ease, color 160ms ease, background 160ms ease, transform 160ms ease;
}

.planning-editor-modal__dismiss:hover {
  border-color: var(--accent);
  color: var(--accent);
  transform: translateY(-1px);
}

.planning-editor-modal__dismiss:focus-visible {
  outline: 2px solid rgba(87, 166, 255, 0.35);
  outline-offset: 2px;
}

.planning-editor-modal__dismiss i {
  font-size: 0.8rem;
}

.planning-editor-modal__body {
  padding: 0;
  overscroll-behavior: contain;
}

.planning-editor-modal__empty {
  padding: 1rem 1.25rem;
  color: var(--muted);
}

.planning-editor-modal__footer {
  position: sticky;
  bottom: 0;
  z-index: 2;
  justify-content: flex-end;
  gap: 0.5rem;
  border-top: 1px solid var(--line);
  background: var(--surface);
}

.planning-editor-modal__footer .bi-arrow-repeat {
  animation: planning-editor-modal-spin 900ms linear infinite;
}

.planning-editor-modal :deep(.workbench-pane--editor) {
  min-height: 100%;
  border: 0;
  box-shadow: none;
  border-radius: 0;
}

.planning-editor-modal :deep(.workbench-card:first-child) {
  border-top-left-radius: 0;
  border-top-right-radius: 0;
}

.planning-editor-modal :deep(.workbench-card--hero) {
  top: 0;
}

@keyframes planning-editor-modal-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
