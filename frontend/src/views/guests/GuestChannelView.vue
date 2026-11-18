<script setup>
import { computed, provide, reactive, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import ChannelConversation from '../../components/channels/ChannelConversation.vue';
import ChannelLibrary from '../../components/channels/ChannelLibrary.vue';
import GuestChatFrame from '../../components/guests/GuestChatFrame.vue';
import { CHANNEL_API_KEY, CHANNEL_VIEWER_KEY } from '../../lib/channels/channel-api.js';
import { CHANNEL_TABS, normalizeChannelTab } from '../../lib/channels/channels.js';
import { GUEST_SESSION_MARKER } from '../../lib/guests/guest-api.js';
import { guestApi } from '../../lib/guests/guest-client.js';
import { needsSignIn, signInNoticeFor, signInRouteFor } from '../../lib/guests/guest-view.js';

// One of a guest's channels (docs/engagements/plan.md, Guests), in Odin Chat's layout with their
// channels beside it (docs/odin-chat/plan.md, Landing): the same conversation, library, file
// comments and viewer members use, calling the guest API (lib/channels/channel-api.js). The tab,
// folder, file and post are kept in the address, as on the members' Channels tab.
const route = useRoute();
const router = useRouter();

const frame = ref(null);
const session = shallowRef(null);
const channel = shallowRef(null);
const project = shallowRef(null);
const loadError = ref('');
const live = reactive({ files: 0, posts: 0 });
const viewer = reactive({ fileActorId: '', guest: true, name: '' });

provide(CHANNEL_API_KEY, guestApi);
provide(CHANNEL_VIEWER_KEY, viewer);

const channelId = computed(() => String(route.params.channelId ?? ''));
const tab = computed(() => normalizeChannelTab(String(route.query.tab ?? '')));

function go(query) {
  router.replace({ query: { ...route.query, ...query } }).catch(() => null);
}

// The frame and the channel both find a signed-out guest; the first to go keeps the way back.
async function toSignIn(notice) {
  if (route.name === 'guest-sign-in') return;
  await router.replace(signInRouteFor(route.fullPath, { notice, workspace: String(route.query.workspace ?? '') }));
}

async function load({ quiet = false } = {}) {
  try {
    const [who, opened] = await Promise.all([session.value ?? guestApi.getSession(), guestApi.getChannel(channelId.value)]);
    session.value = who;
    Object.assign(viewer, { fileActorId: who.guest?.fileActorId ?? '', name: who.guest?.name ?? '' });
    channel.value = opened.channel;
    project.value = opened.project;
    loadError.value = '';
    if (typeof document !== 'undefined') document.title = `#${opened.channel.name} · ${opened.project.name}`;
  } catch (failure) {
    if (needsSignIn(failure)) {
      await toSignIn(signInNoticeFor(failure));
      return;
    }
    if (failure?.status === 404) {
      await router.replace({ name: 'guest-home', query: { notice: 'ended' } });
      return;
    }
    if (!quiet) loadError.value = 'This channel could not load. Check your connection and try again.';
  }
}

function markRead() {
  if (channel.value) channel.value = { ...channel.value, unreadCount: 0 };
  frame.value?.markRead(channelId.value);
}

function openFile(file) {
  go({ file: file.id, folder: file.folderId ?? undefined, tab: 'files' });
}

// The frame's one live stream: this channel's posts and files, and its name or state.
function onLive(batch) {
  const details = batch.details ?? [];
  const here = (area) => batch.reconnected || details.some((event) => event.channelId === channelId.value && event.area === area);
  if (here('posts')) live.posts += 1;
  if (here('files')) live.files += 1;
  if (here('members')) load({ quiet: true });
}

watch(channelId, () => {
  channel.value = null;
  load();
}, { immediate: true });
</script>

<template>
  <GuestChatFrame ref="frame" :active-channel-id="channelId" fill pane-open @access-changed="load({ quiet: true })" @live="onLive">
    <div class="guest-channel">
      <RouterLink class="guest-channel__back" :to="{ name: 'guest-home' }">
        <i class="bi bi-chevron-left" aria-hidden="true"></i> Your channels
      </RouterLink>
      <p v-if="loadError" class="error-banner mb-0" role="alert">
        {{ loadError }}
        <button class="ghost-button ghost-button--compact ms-2" type="button" @click="load()">Try again</button>
      </p>
      <p v-else-if="!channel" class="rq-muted" role="status">Loading…</p>
      <section v-else class="guest-channel__pane" aria-labelledby="guest-channel-name">
        <header class="guest-channel__head">
          <p class="guest-channel__project">{{ project?.name }}</p>
          <h1 id="guest-channel-name" class="guest-channel__name"><i class="bi bi-hash" aria-hidden="true"></i>{{ channel.name }}</h1>
          <p v-if="channel.description" class="guest-channel__description">{{ channel.description }}</p>
        </header>
        <div v-if="channel.archivedAt || project?.readOnly" class="guest-channel__readonly" role="status">
          <i class="bi bi-archive" aria-hidden="true"></i>
          <span>{{ channel.archivedAt ? 'Archived. Messages and files are read-only.' : 'This engagement is closed. Messages and files are read-only.' }}</span>
        </div>
        <nav class="guest-channel__tabs" :aria-label="`${channel.name} sections`">
          <button
            v-for="entry in CHANNEL_TABS"
            :key="entry.id"
            class="guest-channel__tab"
            :class="{ 'guest-channel__tab--active': tab === entry.id }"
            type="button"
            :aria-current="tab === entry.id ? 'page' : undefined"
            @click="go({ file: undefined, folder: undefined, tab: entry.id === 'conversation' ? undefined : entry.id })"
          >
            {{ entry.label }}
          </button>
        </nav>
        <ChannelConversation
          v-if="tab === 'conversation'"
          fill
          :key="`conversation-${channel.id}`"
          :channel="channel"
          :focus-post-id="String(route.query.post ?? '')"
          :live-version="live.posts"
          :project-id="project?.id ?? ''"
          :token="GUEST_SESSION_MARKER"
          @open-file="openFile"
          @read="markRead"
        />
        <ChannelLibrary
          v-else
          class="guest-channel__library"
          :key="`library-${channel.id}`"
          :channel="channel"
          :focus-file-id="String(route.query.file ?? '')"
          :folder-id="String(route.query.folder ?? '')"
          :live-version="live.files"
          :project-id="project?.id ?? ''"
          :token="GUEST_SESSION_MARKER"
          @update:folder-id="(folderId) => go({ file: undefined, folder: folderId || undefined })"
        />
      </section>
    </div>
  </GuestChatFrame>
</template>

<style scoped>
/* The channel fills the pane: its messages or files scroll inside, the message box stays at the bottom. */
.guest-channel { display: flex; flex-direction: column; gap: 0.6rem; min-width: 0; min-height: 0; padding: 0.75rem 1rem; font-size: 0.875rem; }
/* The sidebar is the way back on wide screens; on a phone it is this link. */
.guest-channel__back { display: none; align-items: center; gap: 0.25rem; align-self: flex-start; min-height: 2.75rem; color: var(--accent); font-weight: 600; text-decoration: none; }
.guest-channel__back:focus-visible,
.guest-channel__tab:focus-visible { outline: 0.18rem solid var(--accent); outline-offset: 0.1rem; }
.guest-channel__pane { display: flex; flex: 1 1 auto; flex-direction: column; gap: 0.6rem; min-width: 0; min-height: 0; }
.guest-channel__library { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
.guest-channel__head { min-width: 0; }
.guest-channel__project { margin: 0; color: var(--muted); font-size: 0.75rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
/* The legacy stylesheet sizes and underlines every h1 with !important. */
.guest-channel__name { display: flex; align-items: center; gap: 0.2rem; margin: 0; padding: 0; border-bottom: 0; font-family: var(--font-display); font-size: 1.2rem !important; overflow-wrap: anywhere; }
.guest-channel__description { margin: 0.15rem 0 0; color: var(--muted); overflow-wrap: anywhere; }
.guest-channel__readonly { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; padding: 0.4rem 0.75rem; border: 1px solid var(--line); border-radius: 0.4rem; background: var(--surface-soft); }
.guest-channel__tabs { display: flex; gap: 0.25rem; border-bottom: 1px solid var(--line); }
.guest-channel__tab { min-height: 2.75rem; padding: 0 0.75rem; border: 0; border-bottom: 0.18rem solid transparent; background: transparent; color: var(--ink-soft); font-weight: 600; }
.guest-channel__tab--active { border-bottom-color: var(--accent); color: var(--ink); }

@media (max-width: 767.98px) {
  .guest-channel__back { display: inline-flex; }
}
</style>
