<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';

import NotificationBell from '../notifications/NotificationBell.vue';
import { guestApi } from '../../lib/guests/guest-client.js';
import { guestNotificationsStore } from '../../lib/guests/guest-notifications.js';
import { odinMarkUrl } from '../../lib/requirements/portal-context.js';
import { useDarkMode } from '../../lib/ui/theme.js';

// The guest view's own header: the Odin mark, the workspace, who is signed in, and Sign out.
// Odin's navigation never shows to a guest (route meta `portal`).
defineProps({
  guestName: { default: '', type: String },
  workspaceName: { default: '', type: String },
});

const router = useRouter();
const mark = odinMarkUrl(import.meta.env.BASE_URL);
const theme = useDarkMode();
const leaving = ref(false);

async function signOut() {
  if (leaving.value) return;
  leaving.value = true;
  try {
    await guestApi.signOut();
  } catch {
    // Signed out on this device either way: the cookie is cleared by the server or expires.
  }
  await router.replace({ name: 'guest-sign-in', query: { notice: 'signed-out' } });
}
</script>

<template>
  <header class="guest-head">
    <RouterLink class="guest-head__brand" :to="{ name: 'guest-home' }">
      <img :src="mark" alt="" width="32" height="32" />
      <span class="guest-head__workspace">{{ workspaceName || 'OdinPMP' }}</span>
    </RouterLink>
    <div class="guest-head__side">
      <span v-if="guestName" class="guest-head__name">{{ guestName }}</span>
      <!-- Mentions and replies in the guest's channels, across every engagement they are in. -->
      <NotificationBell :store="guestNotificationsStore" :settings-to="null" />
      <button
        v-if="theme"
        class="theme-toggle"
        type="button"
        :aria-label="theme.darkMode.value ? 'Switch to light mode' : 'Switch to dark mode'"
        @click="theme.toggleDarkMode()"
      >
        <i :class="['bi', theme.darkMode.value ? 'bi-sun' : 'bi-moon']" aria-hidden="true"></i>
      </button>
      <button class="ghost-button ghost-button--compact guest-head__out" type="button" :disabled="leaving" data-testid="guest-sign-out" @click="signOut">Sign out</button>
    </div>
  </header>
</template>

<style scoped>
.guest-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0.5rem 1rem; border-bottom: 1px solid var(--line); background: var(--surface); }
.guest-head__brand { display: inline-flex; align-items: center; gap: 0.5rem; min-height: 2.75rem; color: var(--ink); font-weight: 700; text-decoration: none; }
.guest-head__workspace { font-family: var(--font-display); }
.guest-head__side { display: flex; align-items: center; gap: 0.5rem; }
.guest-head__name { color: var(--muted); font-size: 0.875rem; }
.guest-head__out { min-height: 2.75rem; }
@media (max-width: 479.98px) { .guest-head__name { display: none; } }
</style>
