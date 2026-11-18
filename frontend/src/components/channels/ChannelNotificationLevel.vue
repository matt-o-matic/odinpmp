<script setup>
import { computed, ref, useId } from 'vue';

import { apiClient } from '../../lib/auth/index.js';
import { NOTIFICATION_LEVEL_OPTIONS, levelOption } from '../../lib/notifications/levels.js';

// A channel's notification level for the signed-in person, from the channel header: all new
// posts, mentions only, or off. The choice applies at once.
const props = defineProps({
  channel: { required: true, type: Object },
  projectId: { required: true, type: String },
  token: { default: '', type: String },
});
const emit = defineEmits(['update']);
const uid = useId();
const busy = ref(false);
const error = ref('');

const current = computed(() => props.channel.notificationLevel ?? { isDefault: true, level: 'mentions' });
const shown = computed(() => levelOption(current.value.level));

async function choose(level) {
  if (busy.value || level === current.value.level) return;
  busy.value = true;
  error.value = '';
  try {
    const result = await apiClient.setChannelNotificationLevel(props.projectId, props.channel.id, level, props.token);
    emit('update', { defaultLevel: result.defaultLevel, isDefault: result.isDefault, level: result.level });
  } catch {
    error.value = 'The notification level could not be saved. Try again.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="dropdown channel-level">
    <button
      :id="`${uid}-toggle`"
      class="ghost-button ghost-button--compact channel-level__toggle"
      type="button"
      data-bs-toggle="dropdown"
      aria-expanded="false"
      :aria-label="`Notifications for #${channel.name}: ${shown.short}`"
      :disabled="busy"
    >
      <i :class="['bi', shown.icon]" aria-hidden="true"></i> {{ shown.short }}
    </button>
    <ul class="dropdown-menu dropdown-menu-end channel-level__menu" role="menu" :aria-labelledby="`${uid}-toggle`">
      <li v-for="option in NOTIFICATION_LEVEL_OPTIONS" :key="option.level" role="none">
        <button class="dropdown-item channel-level__option" type="button" role="menuitemradio" :aria-checked="option.level === current.level ? 'true' : 'false'" @click="choose(option.level)">
          <i :class="['bi', option.level === current.level ? 'bi-check-lg' : 'bi-dot', 'channel-level__check']" aria-hidden="true"></i>
          <span>
            <span class="channel-level__label">{{ option.label }}</span>
            <span class="channel-level__help">{{ option.help }}</span>
          </span>
        </button>
      </li>
    </ul>
    <p v-if="error" class="error-banner mb-0 mt-1" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.channel-level__toggle {
  min-height: 2.75rem;
}

.channel-level__menu {
  width: min(19rem, calc(100vw - 1rem));
}

.channel-level__option {
  display: flex;
  gap: 0.5rem;
  min-height: 2.75rem;
  white-space: normal;
}

.channel-level__label {
  display: block;
  font-weight: 600;
}

.channel-level__help {
  display: block;
  color: var(--muted);
  font-size: 0.8rem;
}

.channel-level__check {
  margin-top: 0.15rem;
}
</style>
