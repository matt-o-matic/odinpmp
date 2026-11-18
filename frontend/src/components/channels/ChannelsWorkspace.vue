<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, useId, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { apiClient, authSession } from '../../lib/auth/index.js';
import { CHANNEL_TABS, channelErrorMessage, createChannelLiveUpdates, normalizeChannelTab, pickChannel, unreadLabel } from '../../lib/channels/channels.js';
import { deferWhileHidden } from '../../lib/live/live-updates.js';
import RequirementsConfirmDialog from '../requirements/RequirementsConfirmDialog.vue';
import RequirementsDialog from '../requirements/RequirementsDialog.vue';
import ChannelTasks from '../chat/ChannelTasks.vue';
import ChannelConversation from './ChannelConversation.vue';
import ChannelGuestsDialog from './ChannelGuestsDialog.vue';
import ChannelLibrary from './ChannelLibrary.vue';
import ChannelNotificationLevel from './ChannelNotificationLevel.vue';

// The Channels tab of a project or an engagement. The channel list with unread counts sits beside
// the open channel; on a phone the list and the channel take turns. The open channel, its tab
// (Conversation or Files), and the folder and file open in its library are kept in the address,
// so links and Back work. Changes others make arrive as channel.updated events and refetch only
// what they touched. Odin Chat shows one channel at a time with its own sidebar: given
// `channelId`, this shows that channel alone, without the list.
const props = defineProps({
  channelId: { default: '', type: String },
  projectId: { required: true, type: String },
  // Odin Chat's Tasks tab shows an engagement's pursuit board, else the project's board.
  projectKind: { default: 'delivery', type: String },
});

const emit = defineEmits(['read']);
const embedded = computed(() => Boolean(props.channelId));

const route = useRoute();
const router = useRouter();
const uid = useId();
const token = computed(() => authSession.state.token);

const channels = ref([]);
const permissions = ref({});
// Whether Odin can answer in this project at all. Each channel's own "Let Odin answer when
// tagged" is in Channel settings: everyone sees it; decision rights switch it.
const odin = ref({ available: false });
const loaded = ref(false);
const loadError = ref('');
const showArchived = ref(false);
// Counters the open channel's panes watch: they move when someone else changes that area.
const live = reactive({ files: 0, posts: 0 });

const phone = ref(false);
let media = null;
const onMedia = () => { phone.value = Boolean(media?.matches); };

const wanted = computed(() => String(route.query.channel ?? ''));
// Odin Chat adds a Tasks tab: the project's work beside the conversation. The project's own
// Channels tab has the full board one tab over, so it keeps Conversation and Files.
const TASKS_TAB = Object.freeze({ id: 'tasks', label: 'Tasks' });
const tabs = computed(() => (embedded.value ? [...CHANNEL_TABS, TASKS_TAB] : CHANNEL_TABS));
const tab = computed(() => (embedded.value && route.query.tab === 'tasks' ? 'tasks' : normalizeChannelTab(String(route.query.tab ?? ''))));
// "Ask Odin" on the Tasks tab starts a message to Odin in the conversation.
const seedDraft = ref('');
async function askOdin() {
  seedDraft.value = '';
  go({ file: undefined, folder: undefined, tab: undefined, tasks: undefined, view: undefined });
  await nextTick();
  seedDraft.value = '@[Odin](odin:odin) add a task: ';
}
const openChannels = computed(() => channels.value.filter((channel) => !channel.archivedAt));
const archivedChannels = computed(() => channels.value.filter((channel) => channel.archivedAt));
const selected = computed(() => {
  if (embedded.value) return channels.value.find((channel) => channel.id === props.channelId) ?? null;
  return phone.value && !wanted.value ? null : pickChannel(channels.value, wanted.value);
});
// On a phone, the list shows until a channel is chosen.
const showList = computed(() => !embedded.value && (!phone.value || !selected.value));
const showPane = computed(() => Boolean(selected.value));

function go(query) {
  router.replace({ query: { ...route.query, ...query } }).catch(() => null);
}

function choose(channel) {
  go({ channel: channel.id, file: undefined, folder: undefined, post: undefined, tab: undefined });
}

function backToList() {
  router.replace({ query: { ...route.query, channel: undefined, file: undefined, folder: undefined, post: undefined, tab: undefined } }).catch(() => null);
}

async function load({ quiet = false } = {}) {
  if (!props.projectId || !token.value) return;
  try {
    const result = await (quiet ? apiClient.passive : apiClient).listChannels(props.projectId, token.value);
    channels.value = result.channels ?? [];
    permissions.value = result.permissions ?? {};
    odin.value = result.odin ?? { available: false };
    loadError.value = '';
  } catch (error) {
    if (!quiet) loadError.value = channelErrorMessage(error, 'Channels could not load.');
  } finally {
    loaded.value = true;
  }
}

function setLevel(channelId, notificationLevel) {
  channels.value = channels.value.map((channel) => (channel.id === channelId ? { ...channel, notificationLevel } : channel));
}

function markRead(channelId) {
  channels.value = channels.value.map((channel) => (channel.id === channelId ? { ...channel, unreadCount: 0 } : channel));
  emit('read', channelId);
}

function openFile(file) {
  go({ file: file.id, folder: file.folderId ?? undefined, tab: 'files' });
}

// ---- Live updates ----
let stopLive = null;
function startLive() {
  stopLive?.();
  stopLive = null;
  if (!props.projectId || !token.value) return;
  const deferred = deferWhileHidden((batch) => {
    const details = batch.details ?? [];
    const current = selected.value?.id;
    // Unread counts, names and archived states: the list again.
    if (batch.reconnected || details.some((event) => event.area === 'members' || event.area === 'posts')) void load({ quiet: true });
    if (batch.reconnected || details.some((event) => event.channelId === current && event.area === 'posts')) live.posts += 1;
    if (batch.reconnected || details.some((event) => event.channelId === current && event.area === 'files')) live.files += 1;
  });
  const stopUpdates = createChannelLiveUpdates({ apiClient, getToken: () => authSession.state.token, onChange: deferred.run, projectId: props.projectId });
  stopLive = () => {
    stopUpdates();
    deferred.stop();
  };
}

// ---- New channel and settings ----
const creating = reactive({ busy: false, description: '', error: '', name: '', open: false });
function openCreate() {
  Object.assign(creating, { busy: false, description: '', error: '', name: '', open: true });
}
async function submitCreate() {
  if (creating.busy) return;
  if (!creating.name.trim()) { creating.error = 'Enter a channel name.'; return; }
  creating.busy = true;
  creating.error = '';
  try {
    const result = await apiClient.createChannel(props.projectId, { description: creating.description.trim(), name: creating.name.trim() }, token.value);
    creating.open = false;
    await load();
    choose(result.channel);
  } catch (error) {
    creating.error = channelErrorMessage(error, 'The channel could not be added.');
  } finally {
    creating.busy = false;
  }
}

const settings = reactive({ busy: false, description: '', error: '', name: '', odinEnabled: true, open: false });
const archiving = reactive({ busy: false, error: '', open: false });
function openSettings() {
  const channel = selected.value;
  Object.assign(settings, { busy: false, description: channel?.description ?? '', error: '', name: channel?.name ?? '', odinEnabled: channel?.odinEnabled !== false, open: true });
}
async function submitSettings() {
  if (settings.busy || !selected.value) return;
  const channel = selected.value;
  if (channel.canRename && !settings.name.trim()) { settings.error = 'Enter a channel name.'; return; }
  settings.busy = true;
  settings.error = '';
  try {
    await apiClient.updateChannel(props.projectId, channel.id, {
      ...(channel.canEdit ? { description: settings.description.trim() } : {}),
      ...(channel.canRename ? { name: settings.name.trim() } : {}),
      ...(channel.canSwitchOdin && odin.value.available && settings.odinEnabled !== (channel.odinEnabled !== false) ? { odinEnabled: settings.odinEnabled } : {}),
    }, token.value);
    settings.open = false;
    await load();
  } catch (error) {
    settings.error = channelErrorMessage(error, 'The channel could not be saved.');
  } finally {
    settings.busy = false;
  }
}
async function confirmArchive() {
  archiving.busy = true;
  archiving.error = '';
  try {
    await apiClient.archiveChannel(props.projectId, selected.value.id, token.value);
    archiving.open = false;
    settings.open = false;
    await load();
  } catch (error) {
    archiving.error = channelErrorMessage(error, 'The channel could not be archived.');
  } finally {
    archiving.busy = false;
  }
}
// The channel's guests (ChannelGuestsDialog.vue): every member sees them; decision rights manage them.
const guestsOpen = ref(false);
function openGuests() {
  settings.open = false;
  guestsOpen.value = true;
}

const restoreError = ref('');
async function restore() {
  restoreError.value = '';
  try {
    await apiClient.restoreChannel(props.projectId, selected.value.id, token.value);
    await load();
  } catch (error) {
    restoreError.value = channelErrorMessage(error, 'The channel could not be restored.');
  }
}

onMounted(() => {
  media = globalThis.matchMedia?.('(max-width: 767.98px)') ?? null;
  onMedia();
  media?.addEventListener?.('change', onMedia);
});
onBeforeUnmount(() => {
  media?.removeEventListener?.('change', onMedia);
  stopLive?.();
});

watch(() => `${props.projectId}|${token.value}`, () => {
  channels.value = [];
  loaded.value = false;
  void load();
  startLive();
}, { immediate: true });
// An archived channel someone opens by link shows in the list.
watch(selected, (channel) => { if (channel?.archivedAt) showArchived.value = true; });
</script>

<template>
  <section class="channels" :class="{ 'channels--phone': phone, 'channels--embedded': embedded }" :aria-labelledby="`${uid}-heading`">
    <h2 :id="`${uid}-heading`" class="visually-hidden">Channels</h2>

    <aside v-if="showList" class="channels__list" aria-label="Channel list">
      <div class="channels__list-head">
        <span class="channels__list-title">Channels</span>
        <button v-if="permissions.canCreate" class="ghost-button ghost-button--compact channels__new" type="button" @click="openCreate">
          <i class="bi bi-plus-lg" aria-hidden="true"></i> New channel
        </button>
      </div>
      <p v-if="loadError" class="error-banner mb-0" role="alert">
        {{ loadError }}
        <button class="ghost-button ghost-button--compact ms-2" type="button" @click="load()">Try again</button>
      </p>
      <p v-else-if="!loaded" class="channels__note" role="status">Loading channels…</p>
      <ul class="channels__items">
        <li v-for="channel in openChannels" :key="channel.id">
          <button
            class="channels__item"
            :class="{ 'channels__item--active': selected?.id === channel.id, 'channels__item--unread': channel.unreadCount > 0 }"
            type="button"
            :aria-current="selected?.id === channel.id ? 'true' : undefined"
            @click="choose(channel)"
          >
            <i class="bi bi-hash" aria-hidden="true"></i>
            <span class="channels__item-name">{{ channel.name }}</span>
            <span v-if="channel.unreadCount > 0" class="channels__badge" aria-hidden="true">{{ unreadLabel(channel.unreadCount) }}</span>
            <span v-if="channel.unreadCount > 0" class="visually-hidden">, {{ channel.unreadCount }} unread</span>
          </button>
        </li>
      </ul>
      <template v-if="archivedChannels.length">
        <button class="channels__archived-toggle" type="button" :aria-expanded="showArchived" @click="showArchived = !showArchived">
          <i :class="['bi', showArchived ? 'bi-chevron-down' : 'bi-chevron-right']" aria-hidden="true"></i>
          Archived ({{ archivedChannels.length }})
        </button>
        <ul v-if="showArchived" class="channels__items">
          <li v-for="channel in archivedChannels" :key="channel.id">
            <button class="channels__item channels__item--archived" :class="{ 'channels__item--active': selected?.id === channel.id }" type="button" :aria-current="selected?.id === channel.id ? 'true' : undefined" @click="choose(channel)">
              <i class="bi bi-archive" aria-hidden="true"></i>
              <span class="channels__item-name">{{ channel.name }}</span>
            </button>
          </li>
        </ul>
      </template>
    </aside>

    <div v-if="showPane" class="channels__pane">
      <header class="channels__pane-head">
        <button v-if="phone && !embedded" class="channels__back" type="button" @click="backToList">
          <i class="bi bi-chevron-left" aria-hidden="true"></i> Channels
        </button>
        <div class="channels__identity">
          <h3 class="channels__name"><i class="bi bi-hash" aria-hidden="true"></i>{{ selected.name }}</h3>
          <p v-if="selected.description" class="channels__description">{{ selected.description }}</p>
        </div>
        <ChannelNotificationLevel v-if="!selected.archivedAt" :channel="selected" :project-id="projectId" :token="token" @update="(level) => setLevel(selected.id, level)" />
        <button class="ghost-button ghost-button--compact channels__settings" type="button" data-testid="channel-guests-open" @click="openGuests">
          <i class="bi bi-person-plus" aria-hidden="true"></i> Guests
        </button>
        <button v-if="selected.canEdit || selected.canArchive || selected.canSwitchOdin" class="ghost-button ghost-button--compact channels__settings" type="button" @click="openSettings">
          <i class="bi bi-gear" aria-hidden="true"></i> Channel settings
        </button>
      </header>

      <div v-if="selected.archivedAt" class="channels__archived" role="status">
        <i class="bi bi-archive" aria-hidden="true"></i>
        <span>Archived. Messages and files are read-only.</span>
        <button v-if="selected.canRestore" class="ghost-button ghost-button--compact" type="button" @click="restore">Restore</button>
      </div>
      <p v-if="restoreError" class="error-banner mb-0" role="alert">{{ restoreError }}</p>

      <nav class="channels__tabs" :aria-label="`${selected.name} sections`">
        <button
          v-for="entry in tabs"
          :key="entry.id"
          class="channels__tab"
          :class="{ 'channels__tab--active': tab === entry.id }"
          type="button"
          :aria-current="tab === entry.id ? 'page' : undefined"
          @click="go({ file: undefined, folder: undefined, tab: entry.id === 'conversation' ? undefined : entry.id, tasks: undefined, view: undefined })"
        >
          {{ entry.label }}
        </button>
      </nav>

      <ChannelConversation
        v-if="tab === 'conversation'"
        :key="`conversation-${selected.id}`"
        :channel="selected"
        :fill="embedded"
        :focus-post-id="String(route.query.post ?? '')"
        :live-version="live.posts"
        :project-id="projectId"
        :seed-draft="seedDraft"
        :token="token"
        @open-file="openFile"
        @read="markRead"
      />
      <ChannelTasks
        v-else-if="tab === 'tasks'"
        :key="`tasks-${projectId}`"
        :can-ask-odin="!selected.archivedAt && selected.canPost !== false && selected.odinEnabled !== false && odin.available"
        :kind="projectKind"
        :project-id="projectId"
        @ask-odin="askOdin"
      />
      <ChannelLibrary
        v-else
        :key="`library-${selected.id}`"
        class="channels__library"
        :channel="selected"
        :focus-file-id="String(route.query.file ?? '')"
        :folder-id="String(route.query.folder ?? '')"
        :live-version="live.files"
        :project-id="projectId"
        :token="token"
        @update:folder-id="(folderId) => go({ file: undefined, folder: folderId || undefined })"
      />
    </div>
    <p v-else-if="loaded && embedded && !loadError" class="channels__note" role="status">This channel is not here any more.</p>
    <p v-else-if="loaded && !phone && !channels.length && !loadError" class="channels__note">No channels yet.</p>
    <p v-if="embedded && loadError" class="error-banner mb-0" role="alert">
      {{ loadError }}
      <button class="ghost-button ghost-button--compact ms-2" type="button" @click="load()">Try again</button>
    </p>

    <RequirementsDialog :busy="creating.busy" :open="creating.open" title="New channel" @close="creating.open = false" @submit="submitCreate">
      <div class="rq-field">
        <label :for="`${uid}-new-name`">Name</label>
        <input :id="`${uid}-new-name`" v-model="creating.name" class="form-control" maxlength="80" autocomplete="off" data-autofocus />
      </div>
      <div class="rq-field">
        <label :for="`${uid}-new-description`">Description (optional)</label>
        <input :id="`${uid}-new-description`" v-model="creating.description" class="form-control" maxlength="1000" autocomplete="off" />
      </div>
      <p class="rq-field__hint mb-0">Everyone in the project can see every channel.</p>
      <p v-if="creating.error" class="error-banner mb-0" role="alert">{{ creating.error }}</p>
      <template #footer>
        <button class="ghost-button" type="button" :disabled="creating.busy" @click="creating.open = false">Cancel</button>
        <button class="primary-button" type="submit" :disabled="creating.busy">{{ creating.busy ? 'Adding…' : 'Add channel' }}</button>
      </template>
    </RequirementsDialog>

    <RequirementsDialog :busy="settings.busy" :open="settings.open" title="Channel settings" @close="settings.open = false" @submit="submitSettings">
      <div class="rq-field">
        <label :for="`${uid}-settings-name`">Name</label>
        <input :id="`${uid}-settings-name`" v-model="settings.name" class="form-control" maxlength="80" autocomplete="off" :disabled="!selected?.canRename" />
        <p v-if="selected?.isGeneral" class="rq-field__hint mb-0">General keeps its name, and cannot be archived.</p>
      </div>
      <div class="rq-field">
        <label :for="`${uid}-settings-description`">Description</label>
        <input :id="`${uid}-settings-description`" v-model="settings.description" class="form-control" maxlength="1000" autocomplete="off" :disabled="!selected?.canEdit" />
      </div>
      <div v-if="odin.available" class="channels__odin">
        <div class="form-check form-switch mb-0">
          <input :id="`${uid}-odin`" v-model="settings.odinEnabled" class="form-check-input" type="checkbox" role="switch" :aria-describedby="`${uid}-odin-hint`" :disabled="!selected?.canSwitchOdin" />
          <label class="form-check-label" :for="`${uid}-odin`">Let Odin answer when tagged</label>
        </div>
        <p :id="`${uid}-odin-hint`" class="rq-field__hint mb-0">{{ selected?.canSwitchOdin ? 'For this channel only. Off: @Odin is plain text here.' : 'Only a project admin or manager can change this.' }}</p>
      </div>
      <div class="channels__guests-section">
        <p class="mb-0">Guests from outside the workspace see only the channels they are invited to.</p>
        <button class="ghost-button ghost-button--compact" type="button" @click="openGuests">
          <i class="bi bi-person-plus" aria-hidden="true"></i> Manage guests
        </button>
      </div>
      <div v-if="selected?.canArchive" class="channels__danger">
        <p class="mb-0">Archiving makes the channel read-only. Its messages and files stay, and it can be restored.</p>
        <button class="ghost-button ghost-button--compact" type="button" @click="archiving.open = true; archiving.error = ''">
          <i class="bi bi-archive" aria-hidden="true"></i> Archive channel
        </button>
      </div>
      <p v-if="settings.error" class="error-banner mb-0" role="alert">{{ settings.error }}</p>
      <template #footer>
        <button class="ghost-button" type="button" :disabled="settings.busy" @click="settings.open = false">Cancel</button>
        <button v-if="selected?.canEdit || selected?.canSwitchOdin" class="primary-button" type="submit" :disabled="settings.busy">{{ settings.busy ? 'Saving…' : 'Save' }}</button>
      </template>
    </RequirementsDialog>

    <ChannelGuestsDialog :channel="selected" :open="guestsOpen" :project-id="projectId" :token="token" @close="guestsOpen = false" />

    <RequirementsConfirmDialog
      :busy="archiving.busy"
      confirm-label="Archive channel"
      :error="archiving.error"
      :open="archiving.open"
      title="Archive this channel?"
      @close="archiving.open = false"
      @confirm="confirmArchive"
    >
      <p class="mb-0"><strong>#{{ selected?.name }}</strong> becomes read-only. A project admin or manager can restore it.</p>
    </RequirementsConfirmDialog>
  </section>
</template>

<style scoped>
.channels { display: grid; grid-template-columns: minmax(12rem, 16rem) minmax(0, 1fr); align-items: start; gap: 1rem; font-size: 0.875rem; }
.channels--phone,
.channels--embedded { grid-template-columns: minmax(0, 1fr); }
.channels--embedded .channels__pane { border: 0; border-radius: 0; padding: 0; background: transparent; }
/* Odin Chat: the open channel fills the pane; its messages or its files scroll inside it. */
.channels--embedded { display: flex; flex: 1 1 auto; flex-direction: column; align-items: stretch; min-height: 0; }
.channels--embedded .channels__pane { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; }
.channels--embedded .channels__library { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
.channels__list { display: grid; gap: 0.35rem; padding: 0.5rem; border: 1px solid var(--line); border-radius: 0.5rem; background: var(--surface); }
.channels__list-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.35rem; padding: 0 0.25rem; }
.channels__list-title { color: var(--muted); font-size: 0.75rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
.channels__new { min-height: 2.75rem; }
.channels__odin { display: grid; gap: 0.25rem; padding: 0.6rem 0.75rem; border: 1px solid var(--line); border-radius: 0.4rem; }
.channels__odin .form-check-input { width: 2.25rem; height: 1.25rem; }
.channels__odin .form-check { display: flex; align-items: center; gap: 0.5rem; min-height: 2.75rem; padding-left: 2.75rem; }
.channels__note { margin: 0; padding: 0 0.25rem; color: var(--muted); }
.channels__items { display: grid; gap: 0.1rem; margin: 0; padding: 0; list-style: none; }
.channels__item { display: flex; align-items: center; gap: 0.4rem; width: 100%; min-height: 2.75rem; padding: 0.25rem 0.5rem; border: 0; border-radius: 0.35rem; background: transparent; color: var(--ink-soft); text-align: left; }
.channels__item:hover { background: var(--surface-soft); color: var(--ink); }
.channels__item--active { background: var(--surface-soft); color: var(--ink); box-shadow: inset 0.2rem 0 0 var(--accent); }
.channels__item--unread { color: var(--ink); font-weight: 700; }
.channels__item--archived { color: var(--muted); }
.channels__item-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.channels__badge { min-width: 1.5rem; padding: 0.05rem 0.45rem; border-radius: 999px; background: var(--accent); color: #fff; font-size: 0.75rem; font-weight: 700; text-align: center; }
.channels__archived-toggle { display: flex; align-items: center; gap: 0.35rem; min-height: 2.75rem; padding: 0 0.5rem; border: 0; background: transparent; color: var(--muted); font-size: 0.8rem; font-weight: 600; }
.channels__pane { display: grid; gap: 0.6rem; min-width: 0; padding: 0.75rem; border: 1px solid var(--line); border-radius: 0.5rem; background: var(--surface); }
.channels__pane-head { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 0.5rem; }
.channels__identity { flex: 1 1 12rem; min-width: 0; }
/* The legacy stylesheet sizes and underlines every h3 with !important. */
.channels__name { display: flex; align-items: center; gap: 0.2rem; margin: 0; padding: 0; border-bottom: 0; font-family: var(--font-display); font-size: 1.1rem !important; overflow-wrap: anywhere; }
.channels__description { margin: 0.15rem 0 0; color: var(--muted); overflow-wrap: anywhere; }
.channels__settings,
.channels__back { min-height: 2.75rem; }
.channels__back { display: inline-flex; align-items: center; gap: 0.25rem; padding: 0 0.5rem 0 0.25rem; border: 0; border-radius: 0.35rem; background: transparent; color: var(--accent); font-weight: 600; flex-basis: 100%; justify-content: flex-start; }
.channels__archived { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; padding: 0.4rem 0.75rem; border: 1px solid var(--line); border-radius: 0.4rem; background: var(--surface-soft); }
.channels__tabs { display: flex; gap: 0.25rem; border-bottom: 1px solid var(--line); }
.channels__tab { min-height: 2.75rem; padding: 0 0.75rem; border: 0; border-bottom: 0.18rem solid transparent; background: transparent; color: var(--ink-soft); font-weight: 600; }
.channels__tab--active { border-bottom-color: var(--accent); color: var(--ink); }
.channels__danger { display: grid; gap: 0.5rem; justify-items: start; padding: 0.6rem 0.75rem; border: 1px solid var(--line); border-radius: 0.4rem; }
.channels__guests-section { display: grid; gap: 0.5rem; justify-items: start; padding: 0.6rem 0.75rem; border: 1px solid var(--line); border-radius: 0.4rem; }
.channels__item:focus-visible,
.channels__tab:focus-visible,
.channels__back:focus-visible,
.channels__archived-toggle:focus-visible { outline: 0.18rem solid var(--accent); outline-offset: 0.1rem; }
html.dark .channels__badge { color: #0b1220; }
</style>
