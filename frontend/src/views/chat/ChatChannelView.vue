<script setup>
import { computed } from 'vue';
import { useRoute } from 'vue-router';

import ChannelsWorkspace from '../../components/channels/ChannelsWorkspace.vue';
import ChatPaneHeader from '../../components/chat/ChatPaneHeader.vue';
import { useChatShell } from '../../lib/chat/chat-shell.js';

// A channel in Odin Chat: the project's own Channels tab (conversation, files, previews,
// comments) showing this one channel, with the project it is in above it.
const route = useRoute();
const shell = useChatShell();
const projectId = computed(() => String(route.params.projectId ?? ''));
const channelId = computed(() => String(route.params.channelId ?? ''));
const group = computed(() => shell?.sidebar?.groups?.find((entry) => entry.id === projectId.value) ?? null);
const channel = computed(() => group.value?.channels?.find((entry) => entry.id === channelId.value) ?? null);
const projectRoute = computed(() => (group.value?.kind === 'engagement'
  ? { name: 'engagement-detail', params: { projectId: projectId.value, section: 'channels' }, query: { channel: channelId.value } }
  : { name: 'project-channels', params: { projectId: projectId.value }, query: { channel: channelId.value } }));
</script>

<template>
  <section class="chat-channel">
    <ChatPaneHeader :context="group?.name ?? ''" :context-to="group ? projectRoute : null" hide-title :title="channel ? `#${channel.name}` : 'Channel'" />
    <div class="chat-channel__body">
      <ChannelsWorkspace :key="`${projectId}|${channelId}`" :channel-id="channelId" :project-id="projectId" :project-kind="group?.kind === 'engagement' ? 'engagement' : 'delivery'" @read="shell?.refresh()" />
    </div>
  </section>
</template>

<style scoped>
.chat-channel { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.chat-channel__body { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; padding: 0 1rem 0.75rem; }
</style>
