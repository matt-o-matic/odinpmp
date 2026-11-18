<script setup>
import { computed, onBeforeUnmount, onMounted, provide, reactive, ref, shallowRef } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import ChatHeader from '../../components/chat/ChatHeader.vue';
import ChatLayout from '../../components/chat/ChatLayout.vue';
import ChatNewMessageDialog from '../../components/chat/ChatNewMessageDialog.vue';
import ChatSidebar from '../../components/chat/ChatSidebar.vue';
import { apiClient, authSession } from '../../lib/auth/index.js';
import { channelErrorMessage } from '../../lib/channels/channels.js';
import { channelRoute, directRoute } from '../../lib/chat/chat.js';
import { CHAT_SHELL_KEY, linkChatInstall } from '../../lib/chat/chat-shell.js';
import { chatUnread } from '../../lib/chat/chat-unread.js';
import { createWorkspaceLiveUpdates, deferWhileHidden } from '../../lib/live/live-updates.js';

// Odin Chat: its own front door at /app/chat, with a slim header, the sidebar and the open
// conversation, and no Odin top bar. The screens inside it (child routes) read the sidebar's data
// from here. Channel and direct message changes anywhere in the workspace refetch the sidebar,
// which carries only what this person may see.
const route = useRoute();
const router = useRouter();
const token = computed(() => authSession.state.token);

const sidebar = shallowRef(null);
const loaded = ref(false);
const loadError = ref('');
const people = ref([]);
const peopleLoaded = ref(false);
const header = ref(null);
const newMessage = reactive({ busy: false, error: '', loading: false, open: false });

const active = computed(() => {
  if (route.name === 'chat-channel') return `channel:${route.params.channelId}`;
  if (route.name === 'chat-direct') return `dm:${route.params.conversationId}`;
  return { 'chat-mentions': 'mentions', 'chat-odin': 'odin', 'chat-threads': 'threads' }[route.name] ?? '';
});
const paneOpen = computed(() => route.name !== 'chat-home');
// A channel or a direct message fills the pane, its box pinned to the bottom.
const fillPane = computed(() => route.name === 'chat-channel' || route.name === 'chat-direct');
// The phone's bottom bar: Chat stays lit inside a channel or conversation.
const bottomActive = computed(() => (['chat-mentions', 'chat-search'].includes(route.name) ? route.name : 'chat-home'));

async function load({ quiet = false } = {}) {
  if (!token.value) return;
  try {
    const result = await (quiet ? apiClient.passive : apiClient).getChatSidebar(token.value);
    sidebar.value = result;
    loadError.value = '';
    chatUnread.apply(result.totals);
  } catch (error) {
    if (!quiet) loadError.value = channelErrorMessage(error, 'Your channels could not load.');
  } finally {
    loaded.value = true;
  }
}

async function loadPeople() {
  if (peopleLoaded.value || newMessage.loading) return;
  newMessage.loading = true;
  try {
    people.value = (await apiClient.passive.listDirectMessagePeople(token.value)).people ?? [];
    peopleLoaded.value = true;
  } catch {
    // The picker says nobody matches; opening it again tries again.
  } finally {
    newMessage.loading = false;
  }
}

/** Opens the conversation with these people, starting it if needed. */
async function startDirect(memberIds) {
  const result = await apiClient.startDirectConversation(memberIds, token.value);
  await load({ quiet: true });
  await router.push(directRoute(result.conversation.id));
  return result.conversation;
}

function openNewMessage() {
  Object.assign(newMessage, { busy: false, error: '', open: true });
  void loadPeople();
}

async function submitNewMessage(memberIds) {
  newMessage.busy = true;
  newMessage.error = '';
  try {
    await startDirect(memberIds);
    newMessage.open = false;
  } catch (error) {
    newMessage.error = channelErrorMessage(error, 'The conversation could not open.');
  } finally {
    newMessage.busy = false;
  }
}

async function chooseJump(option) {
  if (option.kind === 'person') {
    try {
      await startDirect([option.personId]);
    } catch (error) {
      loadError.value = channelErrorMessage(error, 'The conversation could not open.');
    }
    return;
  }
  await router.push(option.to);
}

provide(CHAT_SHELL_KEY, reactive({
  chooseJump,
  loadPeople,
  openNewMessage,
  people,
  refresh: () => load({ quiet: true }),
  sidebar,
}));

// Ctrl+K (Cmd+K on a Mac) goes to search and jump, as in Odin.
function onKeydown(event) {
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k' || event.altKey || event.shiftKey) return;
  event.preventDefault();
  if (globalThis.matchMedia?.('(max-width: 767.98px)').matches) router.push({ name: 'chat-search' });
  else header.value?.focusSearch();
}

let stopLive = null;
let restoreInstallLinks = () => {};
onMounted(() => {
  restoreInstallLinks = linkChatInstall();
  if (typeof document !== 'undefined') document.title = 'Odin Chat';
  document.addEventListener('keydown', onKeydown);
  void load();
  const deferred = deferWhileHidden(() => load({ quiet: true }));
  const stopUpdates = createWorkspaceLiveUpdates({ apiClient, areas: ['chat', 'projects'], debounceMs: 300, getToken: () => authSession.state.token, onChange: deferred.run });
  stopLive = () => {
    stopUpdates();
    deferred.stop();
  };
});
onBeforeUnmount(() => {
  stopLive?.();
  restoreInstallLinks();
  document.removeEventListener('keydown', onKeydown);
});

const bottomItems = [
  { icon: 'bi-chat-dots', label: 'Chat', name: 'chat-home' },
  { icon: 'bi-at', label: 'Mentions', name: 'chat-mentions' },
  { icon: 'bi-search', label: 'Search', name: 'chat-search' },
];

async function signOut() {
  const { cancelled } = await authSession.logout();
  if (!cancelled) router.push({ name: 'login' });
}
</script>

<template>
  <ChatLayout :fill="fillPane" :pane-open="paneOpen">
    <template #header>
      <ChatHeader ref="header" :people="people" :sidebar="sidebar" @choose="chooseJump" @need-people="loadPeople" />
    </template>
    <template #sidebar>
      <ChatSidebar
        :active="active"
        :channel-route-for="(group, channel) => channelRoute({ channelId: channel.id, projectId: group.id })"
        :direct-messages="sidebar?.directMessages ?? []"
        :direct-route-for="(conversation) => directRoute(conversation.id)"
        :error="loadError"
        :groups="sidebar?.groups ?? []"
        :loaded="loaded"
        :mention-total="sidebar?.totals?.mentions ?? 0"
        @new-message="openNewMessage"
        @retry="load()"
      />
    </template>

    <RouterView />

    <template #bottom>
      <RouterLink
        v-for="item in bottomItems"
        :key="item.name"
        class="chat-bottom__item"
        :class="{ 'chat-bottom__item--active': bottomActive === item.name }"
        :to="{ name: item.name }"
        :aria-current="bottomActive === item.name ? 'page' : undefined"
      >
        <i :class="['bi', item.icon]" aria-hidden="true"></i>
        <span>{{ item.label }}</span>
      </RouterLink>
      <div class="dropup chat-bottom__more">
        <button class="chat-bottom__item" type="button" data-bs-toggle="dropdown" aria-expanded="false">
          <i class="bi bi-three-dots" aria-hidden="true"></i>
          <span>More</span>
        </button>
        <ul class="dropdown-menu dropdown-menu-end">
          <li><RouterLink class="dropdown-item" :to="{ name: 'chat-threads' }">Threads</RouterLink></li>
          <li><button class="dropdown-item" type="button" @click="openNewMessage">New message</button></li>
          <li><RouterLink class="dropdown-item" :to="{ name: 'chat-odin' }">Odin</RouterLink></li>
          <li><hr class="dropdown-divider" /></li>
          <li><RouterLink class="dropdown-item" :to="{ name: 'home' }">Open Odin</RouterLink></li>
          <li><RouterLink class="dropdown-item" :to="{ name: 'user' }">Profile</RouterLink></li>
          <li><button class="dropdown-item" type="button" @click="signOut">Logout</button></li>
        </ul>
      </div>
    </template>
  </ChatLayout>

  <ChatNewMessageDialog
    :busy="newMessage.busy"
    :error="newMessage.error"
    :loading="newMessage.loading"
    :open="newMessage.open"
    :people="people"
    @close="newMessage.open = false"
    @submit="submitNewMessage"
  />
</template>

<style scoped>
.chat-bottom__item { display: grid; justify-items: center; gap: 0.1rem; width: 100%; min-height: 3.25rem; padding: 0.35rem 0; border: 0; background: transparent; color: var(--ink-soft); font-size: 0.72rem; font-weight: 600; text-decoration: none; }
.chat-bottom__item .bi { font-size: 1.15rem; }
.chat-bottom__item--active { color: var(--accent); }
.chat-bottom__item:focus-visible { outline: 0.18rem solid var(--accent); outline-offset: -0.18rem; }
.chat-bottom__more { display: grid; }
</style>
