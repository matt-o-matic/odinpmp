<script setup>
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import ChatLayout from '../chat/ChatLayout.vue';
import ChatSidebar from '../chat/ChatSidebar.vue';
import { createGuestLiveUpdates } from '../../lib/guests/guest-live.js';
import { guestApi } from '../../lib/guests/guest-client.js';
import { needsSignIn, signInNoticeFor, signInRouteFor } from '../../lib/guests/guest-view.js';
import GuestHeader from './GuestHeader.vue';

// The guest view in Odin Chat's layout: guests land in the Chat
// layout, with their engagements' channels in the sidebar, and never see Odin proper. The guest
// header stays; there are no direct messages, Mentions, Threads or Odin for guests. One live
// stream serves the sidebar and the open channel: each batch is passed on as `live`.
defineProps({
  // The open channel's id, for the sidebar.
  activeChannelId: { default: '', type: String },
  // A channel fills the pane, its box pinned to the bottom (ChatLayout).
  fill: { default: false, type: Boolean },
  paneOpen: { default: false, type: Boolean },
});

const emit = defineEmits(['access-changed', 'live', 'loaded']);

const route = useRoute();
const router = useRouter();
const session = shallowRef(null);
const projects = ref([]);
const loaded = ref(false);
const error = ref('');

// The sidebar's groups: each engagement or project with the guest's channels in it.
const groups = computed(() => projects.value.map((project) => ({
  channels: (project.channels ?? []).map((channel) => ({ ...channel, mentionCount: 0 })),
  customer: project.customer ?? '',
  id: project.id,
  kind: 'engagement',
  name: project.name,
  readOnly: Boolean(project.readOnly),
  unreadCount: (project.channels ?? []).reduce((sum, channel) => sum + Number(channel.unreadCount ?? 0), 0),
})));

// The frame and the channel both find a signed-out guest; the first to go keeps the way back.
async function toSignIn(notice) {
  if (route.name === 'guest-sign-in') return;
  await router.replace(signInRouteFor(route.fullPath, { notice, workspace: String(route.query.workspace ?? '') }));
}

async function load({ quiet = false } = {}) {
  try {
    const [who, listed] = await Promise.all([session.value ?? guestApi.getSession(), guestApi.listEngagements()]);
    session.value = who;
    projects.value = listed.projects ?? [];
    error.value = '';
    emit('loaded', { projects: projects.value, session: who });
  } catch (failure) {
    if (needsSignIn(failure)) {
      await toSignIn(signInNoticeFor(failure));
      return;
    }
    if (!quiet) error.value = 'Your channels could not load. Check your connection and try again.';
  } finally {
    loaded.value = true;
  }
}

function markRead(channelId) {
  projects.value = projects.value.map((project) => ({ ...project, channels: (project.channels ?? []).map((channel) => (channel.id === channelId ? { ...channel, unreadCount: 0 } : channel)) }));
}

let stopLive = null;
onMounted(() => {
  void load();
  stopLive = createGuestLiveUpdates({
    api: guestApi,
    onAccessChanged: () => {
      void load({ quiet: true });
      emit('access-changed');
    },
    onChange(batch) {
      void load({ quiet: true });
      emit('live', batch);
    },
    onEnded: (failure) => toSignIn(signInNoticeFor(failure) || 'ended'),
  });
});
onBeforeUnmount(() => stopLive?.());

defineExpose({ markRead, reload: () => load({ quiet: true }) });
</script>

<template>
  <ChatLayout class="rq-workspace rq-portal guest-chat" :fill="fill" :pane-open="paneOpen">
    <template #header>
      <GuestHeader :guest-name="session?.guest?.name ?? ''" :workspace-name="session?.workspace?.name ?? ''" />
    </template>
    <template #sidebar>
      <slot name="before-sidebar" />
      <ChatSidebar
        :active="activeChannelId ? `channel:${activeChannelId}` : ''"
        :channel-route-for="(_group, channel) => ({ name: 'guest-channel', params: { channelId: channel.id } })"
        :error="error"
        :groups="groups"
        :loaded="loaded"
        :show-lists="false"
        :show-odin="false"
        storage-key="odin.guest.chat.collapsed"
        @retry="load()"
      />
      <slot name="below-sidebar" :projects="projects" />
    </template>
    <slot :projects="projects" :session="session" />
  </ChatLayout>
</template>

<style scoped>
/* The guest header is a full-width bar of its own inside the chat header. */
.guest-chat :deep(.guest-head) { border-bottom: 0; }
</style>
