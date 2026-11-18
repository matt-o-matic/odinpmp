<script setup>
import { Dropdown } from 'bootstrap';
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue';
import { useRouter } from 'vue-router';

import { readCollapsed, writeCollapsed } from '../../lib/chat/chat.js';
import { notificationsStore } from '../../lib/notifications/index.js';
import { badgeLabel, groupByProject, notificationTimeLabel } from '../../lib/notifications/notifications.js';

// The bell: the unread count, and a menu with the person's notifications grouped by project or
// engagement (direct messages apart, System last), newest first. Each group collapses and stays as
// the person left it on this device, showing its unread count while closed. Titles leave the
// project out, since the group names it. Opening one reads it and goes to it. The menu also marks
// everything read, turns device notifications on or off when the server offers push, and links to
// the notification settings. Odin proper's top bar has it now; Odin Chat's header can place the
// same component.
const props = defineProps({
  // The member's store by default; the guest view passes its own (lib/guests/guest-notifications.js).
  store: { default: () => notificationsStore, type: Object },
  // Where "Notification settings" goes; guests have none, so they pass null.
  settingsTo: { default: () => ({ path: '/user', query: { tab: 'notifications' } }), type: [Object, null] },
});

const router = useRouter();
const uid = useId();
const toggle = ref(null);
const notifications = props.store;
const state = notifications.state;

const unread = computed(() => state.unreadCount);
const sections = computed(() => groupByProject(state.notifications));
const COLLAPSED_KEY = 'odin.notifications.collapsed';
const storage = typeof localStorage !== 'undefined' ? localStorage : null;
const collapsed = ref(new Set(readCollapsed(storage, COLLAPSED_KEY)));
const sectionDomId = (id) => `${uid}-${id.replace(/[^a-z0-9-]/gi, '-')}`;

function toggleSection(id) {
  const next = new Set(collapsed.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsed.value = next;
  writeCollapsed(storage, COLLAPSED_KEY, next);
}
const buttonLabel = computed(() => (unread.value ? `Notifications, ${unread.value} unread` : 'Notifications'));
const showPush = computed(() => state.push.available && state.push.supported);

const kindIcon = {
  channel_post: 'bi-chat-left-text',
  direct_message: 'bi-envelope',
  mention: 'bi-at',
  odin_reply: 'bi-stars',
  task_assigned: 'bi-check2-square',
  thread_reply: 'bi-reply',
};

function close() {
  if (toggle.value) Dropdown.getOrCreateInstance(toggle.value).hide();
}

async function open(notification) {
  close();
  if (!notification.readAt) void notifications.markRead([notification.id]);
  await router.push(notification.path).catch(() => null);
}

// The button disables itself once nothing is unread; focus goes back to the bell so the keyboard
// keeps its place and Escape still closes the menu.
async function markAllRead() {
  await notifications.markAllRead();
  toggle.value?.focus();
}

function onShow() {
  // Catch up if the stream missed anything while the menu was closed.
  void notifications.load();
}

onMounted(() => {
  notifications.start();
  toggle.value?.addEventListener('show.bs.dropdown', onShow);
});
onBeforeUnmount(() => {
  toggle.value?.removeEventListener('show.bs.dropdown', onShow);
  notifications.stop();
});
</script>

<template>
  <div class="dropdown notification-bell">
    <button
      :id="`${uid}-toggle`"
      ref="toggle"
      class="theme-toggle notification-bell__button"
      type="button"
      data-bs-toggle="dropdown"
      data-bs-auto-close="outside"
      aria-expanded="false"
      :aria-label="buttonLabel"
    >
      <i :class="['bi', unread ? 'bi-bell-fill' : 'bi-bell']" aria-hidden="true"></i>
      <span v-if="unread" class="notification-bell__badge" aria-hidden="true">{{ badgeLabel(unread) }}</span>
    </button>
    <div class="dropdown-menu dropdown-menu-end notification-bell__menu" :aria-labelledby="`${uid}-toggle`">
      <div class="notification-bell__head">
        <h2 class="notification-bell__title">Notifications</h2>
        <button class="ghost-button ghost-button--compact" type="button" :disabled="!unread" @click="markAllRead">Mark all read</button>
      </div>
      <p v-if="state.error" class="notification-bell__note notification-bell__note--error" role="alert">{{ state.error }}</p>
      <p v-else-if="!state.loaded" class="notification-bell__note" role="status">Loading…</p>
      <p v-else-if="!state.notifications.length" class="notification-bell__note">Nothing yet. Mentions, replies, watched channels and tasks assigned to you show here.</p>
      <div v-else class="notification-bell__list">
        <section v-for="section in sections" :key="section.id" :aria-labelledby="`${sectionDomId(section.id)}-label`" data-testid="notification-group">
          <h3 class="notification-bell__group">
            <button
              :id="`${sectionDomId(section.id)}-label`"
              class="notification-bell__group-toggle"
              type="button"
              :aria-expanded="!collapsed.has(section.id)"
              :aria-controls="sectionDomId(section.id)"
              @click="toggleSection(section.id)"
            >
              <i :class="['bi', collapsed.has(section.id) ? 'bi-chevron-right' : 'bi-chevron-down']" aria-hidden="true"></i>
              <span class="notification-bell__group-name">{{ section.label }}</span>
              <span v-if="section.unreadCount" class="notification-bell__group-count">{{ section.unreadCount }}<span class="visually-hidden"> unread</span></span>
            </button>
          </h3>
          <ul v-show="!collapsed.has(section.id)" :id="sectionDomId(section.id)" class="notification-bell__items">
            <li v-for="entry in section.entries" :key="entry.id">
              <button class="notification-bell__item" :class="{ 'notification-bell__item--unread': !entry.readAt }" type="button" @click="open(entry)">
                <i :class="['bi', kindIcon[entry.kind] ?? 'bi-bell', 'notification-bell__icon']" aria-hidden="true"></i>
                <span class="notification-bell__text">
                  <span class="notification-bell__item-title">{{ entry.title }}</span>
                  <span v-if="entry.excerpt" class="notification-bell__excerpt">{{ entry.excerpt }}</span>
                  <span class="notification-bell__meta">{{ notificationTimeLabel(entry.updatedAt) }}</span>
                </span>
                <span v-if="!entry.readAt" class="notification-bell__dot" aria-hidden="true"></span>
                <span v-if="!entry.readAt" class="visually-hidden">, unread</span>
              </button>
            </li>
          </ul>
        </section>
      </div>
      <div class="notification-bell__foot">
        <template v-if="showPush">
          <button class="ghost-button ghost-button--compact" type="button" :disabled="state.push.busy" @click="state.push.enabled ? notifications.disablePush() : notifications.enablePush()">
            <i :class="['bi', state.push.enabled ? 'bi-bell-slash' : 'bi-phone-vibrate']" aria-hidden="true"></i>
            {{ state.push.enabled ? 'Turn off on this device' : 'Notify me on this device' }}
          </button>
          <p v-if="state.push.error" class="notification-bell__note notification-bell__note--error" role="alert">{{ state.push.error }}</p>
        </template>
        <RouterLink v-if="settingsTo" class="notification-bell__settings" :to="settingsTo" @click="close">Notification settings</RouterLink>
      </div>
    </div>
  </div>
</template>

<style scoped>
.notification-bell {
  position: relative;
}

.notification-bell__button {
  position: relative;
}

.notification-bell__badge {
  position: absolute;
  top: -0.2rem;
  right: -0.25rem;
  min-width: 1.25rem;
  height: 1.25rem;
  padding: 0 0.3rem;
  border-radius: 999px;
  background: #b42318;
  color: #fff;
  font-size: 0.7rem;
  font-weight: 700;
  line-height: 1.25rem;
  text-align: center;
}

.notification-bell__menu {
  width: min(24rem, calc(100vw - 1rem));
  padding: 0;
  overflow: hidden;
}

.notification-bell__head,
.notification-bell__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.6rem 0.85rem;
}

.notification-bell__head {
  border-bottom: 1px solid var(--line);
}

.notification-bell__foot {
  flex-wrap: wrap;
  border-top: 1px solid var(--line);
}

.notification-bell__title {
  margin: 0;
  font-size: 1rem;
  font-weight: 700;
}

.notification-bell__list {
  max-height: min(28rem, 60vh);
  overflow-y: auto;
}

/* The legacy stylesheet sizes and underlines every h3 with !important. */
.notification-bell__group {
  margin: 0 !important;
  padding: 0 !important;
  border-bottom: 0 !important;
  font-family: inherit !important;
  font-size: 0.8rem !important;
}

.notification-bell__group-toggle {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  width: 100%;
  min-height: 2.75rem;
  padding: 0.25rem 0.85rem;
  border: 0;
  border-top: 1px solid var(--line);
  background: var(--surface-soft);
  color: var(--ink);
  font-weight: 700;
  text-align: left;
}

.notification-bell__group:first-child .notification-bell__group-toggle {
  border-top: 0;
}

.notification-bell__group-toggle:focus-visible {
  outline: 2px solid var(--accent, #285ec6);
  outline-offset: -2px;
}

.notification-bell__group-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.notification-bell__group-count {
  min-width: 1.4rem;
  padding: 0 0.4rem;
  border-radius: 999px;
  background: var(--accent, #285ec6);
  color: #fff;
  font-size: 0.72rem;
  text-align: center;
}

.notification-bell__items {
  margin: 0;
  padding: 0;
  list-style: none;
}

.notification-bell__item {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  width: 100%;
  min-height: 2.75rem;
  padding: 0.55rem 0.85rem;
  border: 0;
  background: transparent;
  color: var(--ink);
  text-align: left;
}

.notification-bell__item:hover,
.notification-bell__item:focus-visible {
  background: var(--surface-soft);
}

.notification-bell__item:focus-visible {
  outline: 2px solid var(--accent, #285ec6);
  outline-offset: -2px;
}

.notification-bell__item--unread .notification-bell__item-title {
  font-weight: 700;
}

.notification-bell__icon {
  margin-top: 0.15rem;
  color: var(--muted);
}

.notification-bell__text {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.notification-bell__excerpt {
  display: -webkit-box;
  overflow: hidden;
  color: var(--ink-soft, var(--ink));
  font-size: 0.85rem;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.notification-bell__meta {
  color: var(--muted);
  font-size: 0.75rem;
}

.notification-bell__dot {
  flex: none;
  width: 0.55rem;
  height: 0.55rem;
  margin-top: 0.45rem;
  border-radius: 999px;
  background: var(--accent, #285ec6);
}

.notification-bell__note {
  margin: 0;
  padding: 0.85rem;
  color: var(--muted);
  font-size: 0.9rem;
}

.notification-bell__note--error {
  color: var(--danger);
}

.notification-bell__settings {
  display: inline-flex;
  align-items: center;
  min-height: 2.75rem;
  margin-left: auto;
  color: var(--accent);
  font-size: 0.9rem;
  font-weight: 600;
}

html.dark .notification-bell__group-count {
  color: #0b1220;
}

/* The collapsed top bar: the menu spans the screen under the bar. */
@media (max-width: 991.98px) {
  .notification-bell__menu {
    position: fixed !important;
    top: 4.75rem !important;
    right: 0.5rem !important;
    left: 0.5rem !important;
    width: auto;
    transform: none !important;
  }
}
</style>
