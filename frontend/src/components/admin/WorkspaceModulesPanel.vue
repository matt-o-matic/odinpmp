<script setup>
import { computed, onMounted, reactive, ref } from 'vue';

import RequirementsConfirmDialog from '../requirements/RequirementsConfirmDialog.vue';
import { apiClient, authSession } from '../../lib/auth/index.js';
import { workspaceModules } from '../../lib/workspace/index.js';

// Tenant admin: the optional modules this workspace has on. Read-only until an admin chooses
// to switch one, which asks first and says what the switch hides.
const DESCRIPTIONS = {
  consulting: 'Engagements for sales pursuits, kept out of delivery views until they convert to projects.',
};

const modules = ref([]);
const loading = ref(false);
const loadError = ref('');
const notice = ref('');
const pending = reactive({ busy: false, error: '', module: null });
const pendingEnable = computed(() => !pending.module?.enabled);

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

async function load() {
  loading.value = true;
  loadError.value = '';
  try {
    const result = await apiClient.getWorkspaceModules(authSession.state.token);
    modules.value = Array.isArray(result?.modules) ? result.modules : [];
  } catch (error) {
    loadError.value = error.message ?? 'Modules could not load.';
  } finally {
    loading.value = false;
  }
}

function openSwitch(module) {
  notice.value = '';
  Object.assign(pending, { busy: false, error: '', module });
}

async function confirmSwitch() {
  const module = pending.module;
  if (!module || pending.busy) return;
  pending.busy = true;
  pending.error = '';
  try {
    const result = await apiClient.updateWorkspaceModule({ enabled: !module.enabled, expectedVersion: module.version, key: module.key }, authSession.state.token);
    modules.value = modules.value.map((entry) => (entry.key === module.key ? result.module : entry));
    workspaceModules.apply(modules.value);
    notice.value = `${result.module.label} is ${result.module.enabled ? 'on' : 'off'}.`;
    pending.module = null;
  } catch (error) {
    pending.error = error?.data?.details?.code === 'module_version_conflict'
      ? 'Someone else changed this module. Close this and check its current state.'
      : error.message ?? 'The module could not be switched.';
    if (error?.data?.details?.code === 'module_version_conflict') void load();
  } finally {
    pending.busy = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="card mb-3 workspace-modules" aria-labelledby="workspace-modules-heading">
    <h4 id="workspace-modules-heading" class="visually-hidden">Modules</h4>
    <div class="card-body">
      <div v-if="notice" class="success-banner d-flex align-items-start justify-content-between gap-2 mb-3" role="status">
        <span>{{ notice }}</span>
        <button class="btn-close flex-shrink-0" type="button" aria-label="Dismiss message" @click="notice = ''"></button>
      </div>
      <div v-if="loadError" class="error-banner mb-3" role="alert">{{ loadError }}</div>
      <p v-if="loading && !modules.length" class="workspace-modules__muted">Loading modules…</p>

      <ul v-if="modules.length" class="workspace-modules__list" aria-label="Modules">
        <li v-for="module in modules" :key="module.key" class="workspace-modules__row">
          <div class="workspace-modules__info">
            <strong>{{ module.label }}</strong>
            <span class="workspace-modules__state" :class="{ 'workspace-modules__state--on': module.enabled }">
              <i class="bi" :class="module.enabled ? 'bi-toggle-on' : 'bi-toggle-off'" aria-hidden="true"></i>
              {{ module.enabled ? 'On' : 'Off' }}
            </span>
            <span class="workspace-modules__muted">{{ DESCRIPTIONS[module.key] }}</span>
            <span v-if="module.updatedAt" class="workspace-modules__muted">Last switched {{ formatDate(module.updatedAt) }}</span>
          </div>
          <button class="btn btn-outline-primary workspace-modules__switch" type="button" :aria-label="`${module.enabled ? 'Switch off' : 'Switch on'} ${module.label}`" @click="openSwitch(module)">
            {{ module.enabled ? 'Switch off' : 'Switch on' }}
          </button>
        </li>
      </ul>
    </div>

    <RequirementsConfirmDialog
      :busy="pending.busy"
      :confirm-label="pendingEnable ? 'Switch on' : 'Switch off'"
      :error="pending.error"
      :open="Boolean(pending.module)"
      :title="`${pendingEnable ? 'Switch on' : 'Switch off'} ${pending.module?.label ?? ''}?`"
      @close="pending.module = null"
      @confirm="confirmSwitch"
    >
      <p v-if="pendingEnable" class="mb-0">Everyone in the workspace gets Engagements in the navigation. Engagements stay out of delivery views until they convert.</p>
      <template v-else>
        <p class="mb-2">
          <strong>{{ pending.module?.impact?.openEngagements ?? 0 }} open {{ pending.module?.impact?.openEngagements === 1 ? 'engagement' : 'engagements' }}</strong>
          will be hidden, with every lost one. Their links stop working.
        </p>
        <p class="mb-0">Nothing is deleted: switching the module on again brings them back as they were.</p>
      </template>
    </RequirementsConfirmDialog>
  </section>
</template>

<style scoped>
.workspace-modules {
  font-size: 0.875rem;
}

.workspace-modules__list {
  display: grid;
  gap: 0.5rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.workspace-modules__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.workspace-modules__info {
  display: grid;
  gap: 0.25rem;
}

.workspace-modules__state {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}

.workspace-modules__state--on {
  font-weight: 600;
}

.workspace-modules__muted {
  color: var(--bs-secondary-color);
}

.workspace-modules__switch {
  min-height: 2.75rem;
}
</style>
