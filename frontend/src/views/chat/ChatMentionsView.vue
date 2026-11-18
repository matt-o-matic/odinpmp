<script setup>
import { computed, onMounted, ref, watch } from 'vue';

import ChatPaneHeader from '../../components/chat/ChatPaneHeader.vue';
import { apiClient, authSession } from '../../lib/auth/index.js';
import { channelErrorMessage, postTimeLabel } from '../../lib/channels/channels.js';
import { placeLabel, placeRoute } from '../../lib/chat/chat.js';
import { useChatShell } from '../../lib/chat/chat-shell.js';

// Mentions: every post and reply that tags the person, newest first, in the channels and
// conversations they are in. Each opens its thread.
const shell = useChatShell();
const token = computed(() => authSession.state.token);
const mentions = ref([]);
const nextCursor = ref(null);
const loaded = ref(false);
const loadingMore = ref(false);
const error = ref('');

async function load({ quiet = false } = {}) {
  try {
    const result = await (quiet ? apiClient.passive : apiClient).listChatMentions({}, token.value);
    mentions.value = result.mentions ?? [];
    nextCursor.value = result.nextCursor ?? null;
    error.value = '';
  } catch (failure) {
    if (!quiet) error.value = channelErrorMessage(failure, 'Mentions could not load.');
  } finally {
    loaded.value = true;
  }
}

async function loadMore() {
  if (!nextCursor.value || loadingMore.value) return;
  loadingMore.value = true;
  try {
    const result = await apiClient.listChatMentions({ before: nextCursor.value }, token.value);
    const known = new Set(mentions.value.map((entry) => entry.post.id));
    mentions.value = [...mentions.value, ...(result.mentions ?? []).filter((entry) => !known.has(entry.post.id))];
    nextCursor.value = result.nextCursor ?? null;
  } catch (failure) {
    error.value = channelErrorMessage(failure, 'Earlier mentions could not load.');
  } finally {
    loadingMore.value = false;
  }
}

onMounted(() => {
  if (typeof document !== 'undefined') document.title = 'Mentions · Odin Chat';
  void load();
});
// A new tag shows in the sidebar's counts first; the list follows.
watch(() => shell?.sidebar?.totals?.mentions, (now, before) => {
  if (before !== undefined && now !== before) void load({ quiet: true });
});
</script>

<template>
  <section class="chat-list">
    <ChatPaneHeader title="Mentions" />
    <div class="chat-list__body">
      <p v-if="error" class="error-banner mb-0" role="alert">
        {{ error }}
        <button class="ghost-button ghost-button--compact ms-2" type="button" @click="load()">Try again</button>
      </p>
      <p v-else-if="!loaded" class="chat-list__note" role="status">Loading…</p>
      <p v-else-if="!mentions.length" class="chat-list__note">Nobody has tagged you yet.</p>
      <ol v-if="mentions.length" class="chat-list__items" aria-label="Posts that tag you">
        <li v-for="entry in mentions" :key="entry.post.id">
          <RouterLink class="chat-list__item" :to="placeRoute(entry.place, entry.post)" data-testid="chat-mention">
            <span class="chat-list__meta">
              <strong>{{ entry.post.author.name }}</strong>
              <span>{{ placeLabel(entry.place) }}</span>
              <time :datetime="entry.post.createdAt">{{ postTimeLabel(entry.post.createdAt) }}</time>
            </span>
            <span class="chat-list__excerpt">{{ entry.post.excerpt }}</span>
            <span v-if="entry.post.parentId" class="chat-list__tag">In a thread</span>
          </RouterLink>
        </li>
      </ol>
      <button v-if="nextCursor" class="ghost-button chat-list__more" type="button" :disabled="loadingMore" @click="loadMore">
        {{ loadingMore ? 'Loading…' : 'Show earlier mentions' }}
      </button>
    </div>
  </section>
</template>

<style scoped src="./chat-list.css"></style>
