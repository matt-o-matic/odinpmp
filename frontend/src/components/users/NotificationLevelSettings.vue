<script setup>
import { onMounted, ref, useId } from 'vue';

import { apiClient, authSession } from '../../lib/auth/index.js';
import { NOTIFICATION_LEVEL_OPTIONS, levelOption } from '../../lib/notifications/levels.js';

// The Notifications tab of the profile: each channel in the person's projects and engagements
// with its level. A change applies at once, as it does from the channel header; there is
// nothing to save.
const uid = useId();
const projects = ref([]);
const loaded = ref(false);
const error = ref('');
const saving = ref('');
const savedNote = ref('');

async function load() {
  try {
    projects.value = (await apiClient.listNotificationLevels(authSession.state.token)).projects ?? [];
    error.value = '';
  } catch {
    error.value = 'Your channels could not load.';
  } finally {
    loaded.value = true;
  }
}

async function change(project, channel, value) {
  saving.value = channel.id;
  savedNote.value = '';
  try {
    const level = value === 'default' ? null : value;
    const result = await apiClient.setChannelNotificationLevel(project.id, channel.id, level, authSession.state.token);
    Object.assign(channel, { defaultLevel: result.defaultLevel, isDefault: result.isDefault, level: result.level });
    savedNote.value = `#${channel.name} in ${project.name}: saved.`;
  } catch {
    error.value = `The level for #${channel.name} could not be saved. Try again.`;
  } finally {
    saving.value = '';
  }
}

onMounted(load);
</script>

<template>
  <div class="notification-levels">
    <p class="notification-levels__intro">Choose what each channel tells you about. Mentions and replies in your threads notify you unless a channel is off. Changes apply at once.</p>
    <p v-if="error" class="error-banner" role="alert">{{ error }}</p>
    <p v-else-if="!loaded" role="status">Loading your channels…</p>
    <p v-else-if="!projects.length" class="notification-levels__intro">You are not in any project’s channels yet.</p>
    <section v-for="project in projects" :key="project.id" class="notification-levels__project" :aria-labelledby="`${uid}-${project.id}`">
      <h2 :id="`${uid}-${project.id}`" class="notification-levels__heading">{{ project.name }}<span v-if="project.kind === 'engagement'" class="notification-levels__kind"> · Engagement</span></h2>
      <div v-for="channel in project.channels" :key="channel.id" class="notification-levels__row">
        <label class="notification-levels__name" :for="`${uid}-${channel.id}`">#{{ channel.name }}</label>
        <select :id="`${uid}-${channel.id}`" class="form-select notification-levels__select" :value="channel.isDefault ? 'default' : channel.level" :disabled="saving === channel.id" @change="change(project, channel, $event.target.value)">
          <option value="default">Default ({{ levelOption(channel.defaultLevel).label }})</option>
          <option v-for="option in NOTIFICATION_LEVEL_OPTIONS" :key="option.level" :value="option.level">{{ option.label }}</option>
        </select>
      </div>
    </section>
    <p class="visually-hidden" role="status">{{ savedNote }}</p>
  </div>
</template>

<style scoped>
.notification-levels__intro {
  color: var(--muted);
}

.notification-levels__project + .notification-levels__project {
  margin-top: 1rem;
}

.notification-levels__heading {
  margin: 0 0 0.4rem;
  font-size: 1rem;
  font-weight: 700;
}

.notification-levels__kind {
  color: var(--muted);
  font-weight: 400;
}

.notification-levels__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.35rem 0;
  border-bottom: 1px solid var(--line);
}

.notification-levels__name {
  overflow-wrap: anywhere;
}

.notification-levels__select {
  width: min(16rem, 100%);
  min-height: 2.75rem;
}
</style>
