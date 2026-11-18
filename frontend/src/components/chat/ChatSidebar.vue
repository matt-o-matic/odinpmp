<script setup>
import { computed, ref } from 'vue';

import { countsLabel, readCollapsed, unreadLabel, writeCollapsed } from '../../lib/chat/chat.js';
import OdinAvatar from './OdinAvatar.vue';

// Odin Chat's sidebar: Mentions and Threads, direct messages with Odin pinned first, then
// each project or engagement with its channels. Unread entries are bold with a count, and a
// tag shows as "@" with its count, so neither relies on colour alone. Sections collapse, and
// stay as the person left them on this device.
//
// The guest view shows the same sidebar with channels only: it passes no direct messages and
// turns off Mentions, Threads and Odin.
const props = defineProps({
  // 'mentions', 'threads', 'odin', 'dm:<id>' or 'channel:<id>'.
  active: { default: '', type: String },
  channelRouteFor: { required: true, type: Function },
  // Null hides the direct messages section (guests).
  directMessages: { default: null, type: Array },
  directRouteFor: { default: null, type: Function },
  error: { default: '', type: String },
  groups: { default: () => [], type: Array },
  loaded: { default: false, type: Boolean },
  mentionTotal: { default: 0, type: Number },
  showLists: { default: true, type: Boolean },
  showOdin: { default: true, type: Boolean },
  storageKey: { default: 'odin.chat.collapsed', type: String },
});

const emit = defineEmits(['new-message', 'retry']);

const storage = typeof localStorage !== 'undefined' ? localStorage : null;
const collapsed = ref(new Set(readCollapsed(storage, props.storageKey)));
// A lost engagement starts collapsed until the person opens it.
const isCollapsed = (key, fallback = false) => (collapsed.value.has(key) ? true : collapsed.value.has(`open:${key}`) ? false : fallback);

function toggle(key, fallback = false) {
  const next = new Set(collapsed.value);
  const closed = isCollapsed(key, fallback);
  next.delete(key);
  next.delete(`open:${key}`);
  if (!closed) next.add(key);
  else if (fallback) next.add(`open:${key}`);
  collapsed.value = next;
  writeCollapsed(storage, props.storageKey, next);
}

const directOpen = computed(() => !isCollapsed('direct'));
const sectionId = (key) => `chat-sidebar-${key.replace(/[^a-z0-9-]/gi, '-')}`;
</script>

<template>
  <nav class="chat-sidebar" aria-label="Conversations">
    <ul v-if="showLists" class="chat-sidebar__items chat-sidebar__lists">
      <li>
        <RouterLink class="chat-sidebar__item" :class="{ 'chat-sidebar__item--active': active === 'mentions' }" :to="{ name: 'chat-mentions' }" :aria-current="active === 'mentions' ? 'page' : undefined">
          <i class="bi bi-at" aria-hidden="true"></i>
          <span class="chat-sidebar__name">Mentions<span v-if="mentionTotal > 0" class="visually-hidden">, {{ countsLabel({ mentionCount: mentionTotal }) }}</span></span>
          <span v-if="mentionTotal > 0" class="chat-sidebar__mention" aria-hidden="true">@{{ unreadLabel(mentionTotal) }}</span>
        </RouterLink>
      </li>
      <li>
        <RouterLink class="chat-sidebar__item" :class="{ 'chat-sidebar__item--active': active === 'threads' }" :to="{ name: 'chat-threads' }" :aria-current="active === 'threads' ? 'page' : undefined">
          <i class="bi bi-chat-left-text" aria-hidden="true"></i>
          <span class="chat-sidebar__name">Threads</span>
        </RouterLink>
      </li>
    </ul>

    <p v-if="error" class="error-banner mb-0" role="alert">
      {{ error }}
      <button class="ghost-button ghost-button--compact ms-2" type="button" @click="emit('retry')">Try again</button>
    </p>
    <p v-else-if="!loaded" class="chat-sidebar__note" role="status">Loading…</p>

    <section v-if="directMessages" class="chat-sidebar__section" :aria-labelledby="`${sectionId('direct')}-label`">
      <div class="chat-sidebar__head">
        <button
          :id="`${sectionId('direct')}-label`"
          class="chat-sidebar__toggle"
          type="button"
          :aria-expanded="directOpen"
          :aria-controls="sectionId('direct')"
          @click="toggle('direct')"
        >
          <i :class="['bi', directOpen ? 'bi-chevron-down' : 'bi-chevron-right']" aria-hidden="true"></i>
          Direct messages
        </button>
        <button class="chat-sidebar__add" type="button" aria-label="New message" data-testid="chat-new-message" @click="emit('new-message')">
          <i class="bi bi-pencil-square" aria-hidden="true"></i>
        </button>
      </div>
      <ul v-show="directOpen" :id="sectionId('direct')" class="chat-sidebar__items">
        <li v-if="showOdin">
          <RouterLink class="chat-sidebar__item" :class="{ 'chat-sidebar__item--active': active === 'odin' }" :to="{ name: 'chat-odin' }" :aria-current="active === 'odin' ? 'page' : undefined">
            <OdinAvatar :interactive="false" :size="22" />
            <span class="chat-sidebar__name">Odin</span>
          </RouterLink>
        </li>
        <li v-for="conversation in directMessages" :key="conversation.id">
          <RouterLink
            class="chat-sidebar__item"
            :class="{ 'chat-sidebar__item--active': active === `dm:${conversation.id}`, 'chat-sidebar__item--unread': conversation.unreadCount > 0 }"
            :to="directRouteFor(conversation)"
            :aria-current="active === `dm:${conversation.id}` ? 'page' : undefined"
          >
            <i :class="['bi', conversation.isGroup ? 'bi-people' : 'bi-person']" aria-hidden="true"></i>
            <span class="chat-sidebar__name">{{ conversation.title }}<span v-if="conversation.unreadCount > 0 || conversation.mentionCount > 0" class="visually-hidden">, {{ countsLabel(conversation) }}</span></span>
            <span v-if="conversation.mentionCount > 0" class="chat-sidebar__mention" aria-hidden="true">@{{ unreadLabel(conversation.mentionCount) }}</span>
            <span v-if="conversation.unreadCount > 0" class="chat-sidebar__badge" aria-hidden="true">{{ unreadLabel(conversation.unreadCount) }}</span>
          </RouterLink>
        </li>
      </ul>
    </section>

    <section v-for="group in groups" :key="group.id" class="chat-sidebar__section" :aria-labelledby="`${sectionId(group.id)}-label`" data-testid="chat-sidebar-group">
      <div class="chat-sidebar__head">
        <button
          :id="`${sectionId(group.id)}-label`"
          class="chat-sidebar__toggle"
          :class="{ 'chat-sidebar__toggle--unread': isCollapsed(group.id, group.readOnly) && group.unreadCount > 0 }"
          type="button"
          :aria-expanded="!isCollapsed(group.id, group.readOnly)"
          :aria-controls="sectionId(group.id)"
          @click="toggle(group.id, group.readOnly)"
        >
          <i :class="['bi', isCollapsed(group.id, group.readOnly) ? 'bi-chevron-right' : 'bi-chevron-down']" aria-hidden="true"></i>
          <span class="chat-sidebar__group-name">{{ group.name }}<span v-if="isCollapsed(group.id, group.readOnly) && group.unreadCount > 0" class="visually-hidden">, {{ countsLabel(group) }}</span></span>
          <span v-if="group.kind === 'engagement'" class="chat-sidebar__kind">{{ group.readOnly ? 'Lost' : 'Engagement' }}</span>
        </button>
      </div>
      <ul v-show="!isCollapsed(group.id, group.readOnly)" :id="sectionId(group.id)" class="chat-sidebar__items">
        <li v-for="channel in group.channels" :key="channel.id">
          <RouterLink
            class="chat-sidebar__item"
            :class="{ 'chat-sidebar__item--active': active === `channel:${channel.id}`, 'chat-sidebar__item--unread': channel.unreadCount > 0 }"
            :to="channelRouteFor(group, channel)"
            :aria-current="active === `channel:${channel.id}` ? 'page' : undefined"
            data-testid="chat-sidebar-channel"
          >
            <i :class="['bi', channel.archivedAt ? 'bi-archive' : 'bi-hash']" aria-hidden="true"></i>
            <span class="chat-sidebar__name">{{ channel.name }}<span v-if="channel.unreadCount > 0 || channel.mentionCount > 0" class="visually-hidden">, {{ countsLabel(channel) }}</span></span>
            <span v-if="channel.mentionCount > 0" class="chat-sidebar__mention" aria-hidden="true">@{{ unreadLabel(channel.mentionCount) }}</span>
            <span v-if="channel.unreadCount > 0" class="chat-sidebar__badge" aria-hidden="true">{{ unreadLabel(channel.unreadCount) }}</span>
          </RouterLink>
        </li>
      </ul>
    </section>
    <p v-if="loaded && !error && !groups.length && !directMessages" class="chat-sidebar__note">You are not in any channel right now.</p>
  </nav>
</template>

<style scoped>
.chat-sidebar { display: grid; align-content: start; gap: 0.75rem; padding: 0.75rem 0.5rem 1rem; font-size: 0.875rem; }
.chat-sidebar__note { margin: 0; padding: 0 0.5rem; color: var(--muted); }
.chat-sidebar__section { display: grid; gap: 0.1rem; }
.chat-sidebar__head { display: flex; align-items: center; gap: 0.25rem; }
.chat-sidebar__toggle { display: flex; flex: 1 1 auto; align-items: center; gap: 0.35rem; min-width: 0; min-height: 2.75rem; padding: 0 0.5rem; border: 0; border-radius: 0.35rem; background: transparent; color: var(--muted); font-size: 0.75rem; font-weight: 700; letter-spacing: 0.04em; text-align: left; text-transform: uppercase; }
.chat-sidebar__toggle:hover { color: var(--ink); }
.chat-sidebar__toggle--unread { color: var(--ink); }
.chat-sidebar__group-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-sidebar__kind { flex: none; padding: 0 0.4rem; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); font-size: 0.65rem; font-weight: 600; letter-spacing: 0; text-transform: none; }
.chat-sidebar__add { display: inline-grid; flex: none; place-items: center; width: 2.75rem; height: 2.75rem; border: 0; border-radius: 0.35rem; background: transparent; color: var(--ink-soft); }
.chat-sidebar__add:hover { background: var(--surface-soft); color: var(--ink); }
.chat-sidebar__items { display: grid; gap: 0.1rem; margin: 0; padding: 0; list-style: none; }
.chat-sidebar__lists { padding-bottom: 0.25rem; border-bottom: 1px solid var(--line); }
.chat-sidebar__item { display: flex; align-items: center; gap: 0.45rem; min-height: 2.75rem; padding: 0.25rem 0.6rem; border-radius: 0.35rem; color: var(--ink-soft); text-decoration: none; }
.chat-sidebar__item:hover { background: var(--surface-soft); color: var(--ink); }
.chat-sidebar__item--active { background: var(--surface-soft); color: var(--ink); box-shadow: inset 0.2rem 0 0 var(--accent); }
.chat-sidebar__item--unread { color: var(--ink); font-weight: 700; }
.chat-sidebar__name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-sidebar__badge { min-width: 1.5rem; padding: 0.05rem 0.45rem; border-radius: 999px; background: var(--accent); color: #fff; font-size: 0.75rem; font-weight: 700; text-align: center; }
.chat-sidebar__mention { padding: 0.05rem 0.4rem; border: 1px solid var(--accent); border-radius: 999px; color: var(--accent); font-size: 0.72rem; font-weight: 700; }
.chat-sidebar__item:focus-visible,
.chat-sidebar__toggle:focus-visible,
.chat-sidebar__add:focus-visible { outline: 0.18rem solid var(--accent); outline-offset: 0.05rem; }
html.dark .chat-sidebar__badge { color: #0b1220; }
</style>
