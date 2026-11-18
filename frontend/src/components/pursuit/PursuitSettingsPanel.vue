<script setup>
import { computed, reactive, watch } from 'vue';

import { apiClient, authSession } from '../../lib/auth/index.js';

// The pursuit board's setting. Everyone on the project sees it;
// people with decision rights change it. "Let Odin answer when tagged" is each channel's
// own, in Channel settings (ChannelsWorkspace.vue).

const props = defineProps({
  projectId: { required: true, type: String },
  readOnly: { default: false, type: Boolean },
});

const state = reactive({ busy: '', canManage: false, error: '', loaded: false, notice: '', settings: null });
const editable = computed(() => state.canManage && !props.readOnly);

const SETTINGS = Object.freeze([
  { hint: 'Off: guests see only the tasks assigned to them. On: they see every task and still change only their own.', key: 'guestsSeeBoard', label: 'Guests see the whole board' },
]);

async function load() {
  try {
    const result = await apiClient.passive.getProjectSettings(props.projectId, authSession.state.token);
    Object.assign(state, { canManage: Boolean(result.canManage), error: '', loaded: true, settings: result.settings });
  } catch (error) {
    Object.assign(state, { error: error?.message || 'Settings could not load.', loaded: true });
  }
}

watch(() => props.projectId, load, { immediate: true });

async function toggle(key) {
  if (!editable.value || state.busy || !state.settings) return;
  state.busy = key;
  state.error = '';
  state.notice = '';
  try {
    const result = await apiClient.saveProjectSettings(props.projectId, { expectedVersion: state.settings.version, [key]: !state.settings[key] }, authSession.state.token);
    state.settings = result.settings;
    state.notice = 'Saved.';
  } catch (error) {
    const code = error?.data?.details?.code ?? error?.details?.code;
    state.error = code === 'settings_version_conflict' ? 'Someone else changed these settings. They are reloaded; try again.' : error?.message || 'The setting could not be saved.';
    if (code === 'settings_version_conflict') await load();
  } finally {
    state.busy = '';
  }
}
</script>

<template>
  <section class="pursuit-settings" aria-labelledby="pursuit-settings-heading">
    <h3 id="pursuit-settings-heading" class="pursuit-settings__heading">Pursuit board</h3>
    <p v-if="!state.loaded" class="muted-copy mb-0" role="status">Loading settings…</p>
    <template v-else-if="state.settings">
      <div v-for="setting in SETTINGS" :key="setting.key" class="form-check form-switch pursuit-settings__row">
        <input
          :id="`pursuit-setting-${setting.key}`"
          class="form-check-input"
          type="checkbox"
          role="switch"
          :aria-describedby="`pursuit-setting-${setting.key}-hint`"
          :checked="state.settings[setting.key]"
          :disabled="!editable || Boolean(state.busy)"
          @change="toggle(setting.key)"
        />
        <label class="form-check-label" :for="`pursuit-setting-${setting.key}`">{{ setting.label }}</label>
        <p :id="`pursuit-setting-${setting.key}-hint`" class="pursuit-settings__hint">{{ setting.hint }}</p>
      </div>
      <p v-if="!state.canManage" class="pursuit-settings__hint mb-0">Project admins and managers change this.</p>
    </template>
    <p v-if="state.notice" class="pursuit-settings__hint mb-0" role="status">{{ state.notice }}</p>
    <p v-if="state.error" class="error-banner mb-0" role="alert">{{ state.error }}</p>
  </section>
</template>

<style scoped>
.pursuit-settings {
  display: grid;
  gap: 0.5rem;
}

.pursuit-settings__heading {
  margin: 0;
  font-size: 0.9375rem;
  font-weight: 600;
}

.pursuit-settings__row {
  min-height: 2.75rem;
  margin: 0;
}

.pursuit-settings__row .form-check-input {
  width: 2.5rem;
  height: 1.35rem;
  margin-top: 0.1rem;
}

.pursuit-settings__row .form-check-label {
  padding-left: 0.4rem;
}

.pursuit-settings__hint {
  margin: 0.1rem 0 0;
  color: var(--bs-secondary-color);
  font-size: 0.8125rem;
}
</style>
