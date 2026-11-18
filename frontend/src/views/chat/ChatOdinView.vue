<script setup>
import { onBeforeUnmount, onMounted } from 'vue';

import AssistantWorkspace from '../../components/assistant/AssistantWorkspace.vue';
import ChatPaneHeader from '../../components/chat/ChatPaneHeader.vue';
import { assistantStore } from '../../lib/assistant/index.js';

// Odin as a direct message: the person's AI Workspace, in the page. The same chats, history,
// agent and tools as Odin's AI Workspace; a message here is an AI Workspace turn.
onMounted(() => {
  assistantStore.show();
  if (!assistantStore.state.chat) assistantStore.startDraft({});
  if (typeof document !== 'undefined') document.title = 'Odin · Odin Chat';
});
onBeforeUnmount(() => assistantStore.dismiss());
</script>

<template>
  <section class="chat-odin">
    <ChatPaneHeader hide-title title="Odin" />
    <div class="chat-odin__workspace">
      <AssistantWorkspace embedded />
    </div>
  </section>
</template>

<style scoped>
.chat-odin { display: grid; grid-template-rows: auto minmax(0, 1fr); height: 100%; min-height: 0; }
.chat-odin__workspace { min-height: 20rem; }
</style>
