<script setup>
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';

import { authSession } from '../../lib/auth/index.js';
import { useDarkMode } from '../../lib/ui/theme.js';
import NotificationBell from '../notifications/NotificationBell.vue';
import ChatJumpBox from './ChatJumpBox.vue';

// Odin Chat's slim header (docs/odin-chat/plan.md, layout B): the Odin Chat mark, search and jump,
// the notifications bell, the way to Odin proper, and the account menu.
defineProps({
  people: { default: () => [], type: Array },
  sidebar: { default: null, type: Object },
});

const emit = defineEmits(['choose', 'need-people']);

const router = useRouter();
const theme = useDarkMode();
const jump = ref(null);
const currentUser = computed(() => authSession.state.currentUser);
const initials = computed(() => String(currentUser.value?.name ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '?');

async function signOut() {
  const { cancelled } = await authSession.logout();
  if (!cancelled) router.push({ name: 'login' });
}

defineExpose({ focusSearch: () => jump.value?.focus() });
const chatIcon = `${import.meta.env.BASE_URL}brand/odin-chat-192.png`;
</script>

<template>
  <div class="chat-head">
    <RouterLink class="chat-head__brand" :to="{ name: 'chat-home' }" aria-label="Odin Chat home">
      <img :src="chatIcon" alt="" width="32" height="32" />
      <span class="chat-head__name">Odin Chat</span>
    </RouterLink>
    <div class="chat-head__search">
      <ChatJumpBox ref="jump" :people="people" :sidebar="sidebar" @choose="emit('choose', $event)" @need-people="emit('need-people')" />
    </div>
    <div class="chat-head__side">
      <!-- The notifications bell (docs/odin-chat/plan.md, layout B), the same one Odin proper has. -->
      <div class="chat-head__bell" data-slot="notifications-bell"><NotificationBell /></div>
      <RouterLink class="chat-head__odin" :to="{ name: 'home' }" aria-label="Open Odin" data-testid="chat-open-odin">
        <i class="bi bi-grid-3x3-gap" aria-hidden="true"></i>
        <span class="chat-head__odin-label">Open Odin</span>
      </RouterLink>
      <div class="dropdown">
        <button class="chat-head__account" type="button" data-bs-toggle="dropdown" aria-expanded="false" aria-label="Account menu">
          <span aria-hidden="true">{{ initials }}</span>
        </button>
        <ul class="dropdown-menu dropdown-menu-end">
          <li><RouterLink class="dropdown-item" :to="{ name: 'user' }">{{ currentUser?.name }}</RouterLink></li>
          <li v-if="theme">
            <button class="dropdown-item" type="button" @click="theme.toggleDarkMode()">
              {{ theme.darkMode.value ? 'Light mode' : 'Dark mode' }}
            </button>
          </li>
          <li><hr class="dropdown-divider" /></li>
          <li><button class="dropdown-item" type="button" @click="signOut">Logout</button></li>
        </ul>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-head { display: flex; align-items: center; gap: 0.75rem; min-height: 3.5rem; padding: 0.35rem 0.75rem; }
.chat-head__brand { display: inline-flex; flex: none; align-items: center; gap: 0.5rem; min-height: 2.75rem; color: var(--ink); font-weight: 700; text-decoration: none; }
.chat-head__brand img { border-radius: 0.45rem; }
.chat-head__name { font-family: var(--font-display); }
.chat-head__search { flex: 1 1 auto; max-width: 40rem; min-width: 0; margin: 0 auto; }
.chat-head__side { display: flex; flex: none; align-items: center; gap: 0.35rem; }
.chat-head__bell:empty { display: none; }
.chat-head__odin { display: inline-flex; align-items: center; gap: 0.35rem; min-height: 2.75rem; padding: 0 0.6rem; border-radius: 0.4rem; color: var(--ink-soft); font-weight: 600; text-decoration: none; }
.chat-head__odin:hover { background: var(--surface-soft); color: var(--ink); }
.chat-head__account { display: inline-grid; place-items: center; width: 2.75rem; height: 2.75rem; border: 1px solid var(--line); border-radius: 999px; background: var(--surface-soft); color: var(--ink); font-size: 0.8rem; font-weight: 700; }
.chat-head__brand:focus-visible,
.chat-head__odin:focus-visible,
.chat-head__account:focus-visible { outline: 0.18rem solid var(--accent); outline-offset: 0.1rem; }

@media (max-width: 767.98px) {
  .chat-head__name,
  .chat-head__odin-label,
  .chat-head__search { display: none; }
  .chat-head__side { margin-left: auto; }
}
</style>
