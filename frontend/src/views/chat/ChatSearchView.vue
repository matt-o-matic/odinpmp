<script setup>
import { onMounted, ref } from 'vue';

import ChatJumpBox from '../../components/chat/ChatJumpBox.vue';
import ChatPaneHeader from '../../components/chat/ChatPaneHeader.vue';
import { useChatShell } from '../../lib/chat/chat-shell.js';

// Search on a phone: the header's search and jump box, on a screen of its own.
const shell = useChatShell();
const box = ref(null);

onMounted(() => {
  if (typeof document !== 'undefined') document.title = 'Search · Odin Chat';
  shell?.loadPeople();
  box.value?.focus();
});
</script>

<template>
  <section class="chat-search">
    <ChatPaneHeader title="Search" />
    <div class="chat-search__body">
      <ChatJumpBox ref="box" inline :people="shell?.people ?? []" :sidebar="shell?.sidebar ?? null" @choose="shell?.chooseJump($event)" />
    </div>
  </section>
</template>

<style scoped>
.chat-search { display: grid; align-content: start; }
.chat-search__body { padding: 0 1rem 1rem; }
</style>
