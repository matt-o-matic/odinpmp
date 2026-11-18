<script setup>
import { computed, onBeforeUnmount, provide, reactive, ref, shallowRef, watch } from 'vue';
import { useRoute } from 'vue-router';

import ChannelConversation from '../../components/channels/ChannelConversation.vue';
import ChatPaneHeader from '../../components/chat/ChatPaneHeader.vue';
import { apiClient, authSession } from '../../lib/auth/index.js';
import { CHANNEL_API_KEY } from '../../lib/channels/channel-api.js';
import { channelErrorMessage } from '../../lib/channels/channels.js';
import { useChatShell } from '../../lib/chat/chat-shell.js';
import { createDirectMessageApi } from '../../lib/chat/direct-message-api.js';
import { createLiveUpdates, deferWhileHidden } from '../../lib/live/live-updates.js';
import { provideProjectRefresh } from '../../lib/live/live-refresh.js';

// A direct message in Odin Chat (docs/odin-chat/plan.md; qna.md Q-02): the channel conversation,
// its posts, replies, tags and attachments, calling the conversation's routes through
// direct-message-api.js. An attached file opens in its post (PostAttachments.vue). Other members' posts arrive
// on the conversation's own live stream.
const route = useRoute();
const shell = useChatShell();
const token = computed(() => authSession.state.token);
const conversationId = computed(() => String(route.params.conversationId ?? ''));

provide(CHANNEL_API_KEY, createDirectMessageApi(apiClient));

const conversation = shallowRef(null);
const loadError = ref('');
const missing = ref(false);
const live = reactive({ files: 0, posts: 0 });
// Attachments still being scanned, and the viewer's "preparing" state, look again when this moves.
provideProjectRefresh(computed(() => live.files));

const others = computed(() => conversation.value?.members?.filter((member) => member.id !== authSession.state.currentUser?.id) ?? []);
const detail = computed(() => (conversation.value?.isGroup ? `${conversation.value.members.length} people` : 'Direct message'));

async function load() {
  loadError.value = '';
  missing.value = false;
  try {
    conversation.value = (await apiClient.getDirectConversation(conversationId.value, token.value)).conversation;
    if (typeof document !== 'undefined') document.title = `${conversation.value.title} · Odin Chat`;
  } catch (error) {
    conversation.value = null;
    if (error?.status === 404) missing.value = true;
    else loadError.value = channelErrorMessage(error, 'This conversation could not load.');
  }
}

let stopLive = null;
function startLive() {
  stopLive?.();
  const deferred = deferWhileHidden((batch) => {
    const details = batch.details ?? [];
    if (batch.reconnected || details.some((event) => event.area === 'posts')) live.posts += 1;
    if (batch.reconnected || details.some((event) => event.area === 'files')) live.files += 1;
  });
  const id = conversationId.value;
  const stopUpdates = createLiveUpdates({
    debounceMs: 150,
    eventType: 'direct-message.updated',
    getToken: () => authSession.state.token,
    keepDetails: true,
    onChange: deferred.run,
    open: (sessionToken, handlers) => apiClient.subscribeToDirectConversationEvents(id, sessionToken, handlers),
    ownClientId: apiClient.clientId,
  });
  stopLive = () => {
    stopUpdates();
    deferred.stop();
  };
}

watch(conversationId, () => {
  conversation.value = null;
  void load();
  startLive();
}, { immediate: true });
onBeforeUnmount(() => stopLive?.());
</script>

<template>
  <section class="chat-direct">
    <ChatPaneHeader :title="conversation?.title ?? (missing ? 'Conversation' : 'Loading…')">
      <p v-if="conversation" class="chat-direct__members">
        {{ detail }}<template v-if="conversation.isGroup">: you, {{ others.map((member) => member.name).join(', ') }}</template>
      </p>
    </ChatPaneHeader>
    <div class="chat-direct__body">
      <p v-if="missing" class="chat-direct__note" role="status">This conversation is not here. It may be one you are not in.</p>
      <p v-else-if="loadError" class="error-banner mb-0" role="alert">
        {{ loadError }}
        <button class="ghost-button ghost-button--compact ms-2" type="button" @click="load()">Try again</button>
      </p>
      <ChannelConversation
        v-else-if="conversation"
        :key="conversation.id"
        :channel="conversation"
        fill
        :focus-post-id="String(route.query.post ?? '')"
        kind="conversation"
        :live-version="live.posts"
        :project-id="conversation.id"
        :token="token"
        @read="shell?.refresh()"
      />
    </div>
  </section>
</template>

<style scoped>
.chat-direct { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.chat-direct__members { margin: 0.1rem 0 0; color: var(--muted); font-size: 0.85rem; }
.chat-direct__body { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; padding: 0 1rem 0.75rem; font-size: 0.875rem; }
.chat-direct__note { margin: 0; color: var(--muted); }
</style>
