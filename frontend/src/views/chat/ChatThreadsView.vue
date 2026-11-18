<script setup>
import { computed, onMounted, ref, watch } from 'vue';

import ChatPaneHeader from '../../components/chat/ChatPaneHeader.vue';
import { apiClient, authSession } from '../../lib/auth/index.js';
import { channelErrorMessage, postTimeLabel } from '../../lib/channels/channels.js';
import { placeLabel, placeRoute } from '../../lib/chat/chat.js';
import { useChatShell } from '../../lib/chat/chat-shell.js';

// Threads (docs/odin-chat/plan.md, Odin Chat; AC-N08): threads the person started or replied in,
// latest reply first, with how many replies are new since they last read there.
const shell = useChatShell();
const token = computed(() => authSession.state.token);
const threads = ref([]);
const loaded = ref(false);
const error = ref('');

async function load({ quiet = false } = {}) {
  try {
    threads.value = (await (quiet ? apiClient.passive : apiClient).listChatThreads(token.value)).threads ?? [];
    error.value = '';
  } catch (failure) {
    if (!quiet) error.value = channelErrorMessage(failure, 'Threads could not load.');
  } finally {
    loaded.value = true;
  }
}

onMounted(() => {
  if (typeof document !== 'undefined') document.title = 'Threads · Odin Chat';
  void load();
});
// The sidebar refetches when anything changes; the list follows it.
watch(() => shell?.sidebar, (_now, before) => {
  if (before) void load({ quiet: true });
});
const replies = (count) => `${count} ${count === 1 ? 'reply' : 'replies'}`;
</script>

<template>
  <section class="chat-list">
    <ChatPaneHeader title="Threads" />
    <div class="chat-list__body">
      <p v-if="error" class="error-banner mb-0" role="alert">
        {{ error }}
        <button class="ghost-button ghost-button--compact ms-2" type="button" @click="load()">Try again</button>
      </p>
      <p v-else-if="!loaded" class="chat-list__note" role="status">Loading…</p>
      <p v-else-if="!threads.length" class="chat-list__note">Threads you start or reply in show here.</p>
      <ol v-if="threads.length" class="chat-list__items" aria-label="Your threads">
        <li v-for="thread in threads" :key="thread.root.id">
          <RouterLink class="chat-list__item" :class="{ 'chat-list__item--new': thread.newReplyCount > 0 }" :to="placeRoute(thread.place, thread.root)" data-testid="chat-thread">
            <span class="chat-list__meta">
              <strong>{{ thread.root.author.name }}</strong>
              <span>{{ placeLabel(thread.place) }}</span>
              <span>{{ replies(thread.replyCount) }}</span>
            </span>
            <span class="chat-list__excerpt">{{ thread.root.deleted ? 'Message deleted' : thread.root.excerpt }}</span>
            <span v-if="thread.lastReply" class="chat-list__reply">
              {{ thread.lastReply.author.name }}: {{ thread.lastReply.excerpt }} · <time :datetime="thread.lastReply.createdAt">{{ postTimeLabel(thread.lastReply.createdAt) }}</time>
            </span>
            <span v-if="thread.newReplyCount > 0" class="chat-list__badge">{{ thread.newReplyCount }} new</span>
          </RouterLink>
        </li>
      </ol>
    </div>
  </section>
</template>

<style scoped src="./chat-list.css"></style>
