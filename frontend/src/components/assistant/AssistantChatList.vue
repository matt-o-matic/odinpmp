<script setup>
import { computed, nextTick, ref } from 'vue';

import { chatListTime } from '../../lib/assistant/assistant-format.js';
import AssistantTypingDots from './AssistantTypingDots.vue';

const props = defineProps({
  activeChatId: { default: null, type: String },
  currentProjectId: { default: null, type: String },
  list: { required: true, type: Object },
  loading: { default: false, type: Boolean },
  // The chat whose turn is running right now, so its row shows it even before the list refreshes.
  workingChatId: { default: null, type: String },
});
const emit = defineEmits(['new-chat', 'open-chat', 'delete-chat', 'rename-chat']);

// One folder per project with chats, the current project's first (shown even before its first
// chat, so it can be started here), then chats not tied to a project. Each folder starts a new
// chat in itself.
const groups = computed(() => {
  const projects = [...(props.list.projects ?? [])];
  const current = props.currentProjectId;
  if (current && !projects.some((group) => group.projectId === current)) {
    const available = (props.list.projectsAvailable ?? []).find((project) => project.id === current);
    if (available) projects.push({ chats: [], projectId: current, projectName: available.name });
  }
  projects.sort((left, right) => (left.projectId === current ? -1 : right.projectId === current ? 1 : 0));
  return [
    ...projects.map((group) => ({ chats: group.chats, key: group.projectId, label: group.projectName, projectId: group.projectId })),
    { chats: props.list.general ?? [], key: 'general', label: 'Not tied to a project', projectId: null },
  ];
});
const hasChats = computed(() => groups.value.some((group) => group.chats.length));

// Renaming in place: Enter or leaving the field saves, Escape puts the title back.
const editing = ref(null);
const renameInput = ref(null);

function startRename(chat) {
  editing.value = { chatId: chat.id, original: chat.title, title: chat.title };
  nextTick(() => {
    const input = Array.isArray(renameInput.value) ? renameInput.value[0] : renameInput.value;
    input?.focus();
    input?.select();
  });
}

function saveRename() {
  if (!editing.value) return;
  const { chatId, original, title } = editing.value;
  editing.value = null;
  if (title.trim() && title.trim() !== original) emit('rename-chat', { chatId, title: title.trim() });
}
</script>

<template>
  <nav class="chat-list" aria-label="Chats">
    <div class="chat-list__head">
      <h2 class="chat-list__title">Chats</h2>
    </div>
    <p v-if="loading && !hasChats" class="chat-list__empty">Loading…</p>
    <section v-for="group in groups" :key="group.key" class="chat-list__group">
      <div class="chat-list__group-head">
        <h3 class="chat-list__group-title">{{ group.label }}</h3>
        <button
          class="chat-list__add"
          type="button"
          :aria-label="group.projectId ? `New chat in ${group.label}` : 'New chat not tied to a project'"
          @click="emit('new-chat', group.projectId)"
        >
          <i class="bi bi-plus-lg" aria-hidden="true"></i>
        </button>
      </div>
      <p v-if="!group.chats.length" class="chat-list__none">No chats yet.</p>
      <ul v-else class="chat-list__items">
        <li v-for="chat in group.chats" :key="chat.id" class="chat-list__item" :class="{ 'chat-list__item--active': chat.id === activeChatId }">
          <form v-if="editing?.chatId === chat.id" class="chat-list__row chat-list__edit" @submit.prevent="saveRename">
            <input
              ref="renameInput"
              v-model="editing.title"
              class="chat-list__input"
              aria-label="Chat title"
              maxlength="120"
              @blur="saveRename"
              @keydown.esc.stop.prevent="editing = null"
            />
            <span class="chat-list__meta">Last active {{ chatListTime(chat.updatedAt) }}</span>
            <span v-if="chat.createdAt" class="chat-list__meta">Opened {{ chatListTime(chat.createdAt) }}</span>
          </form>
          <template v-else>
            <button class="chat-list__row chat-list__open" type="button" :aria-current="chat.id === activeChatId ? 'true' : undefined" @click="emit('open-chat', chat.id)">
              <span class="chat-list__name">{{ chat.title }}</span>
              <span class="chat-list__meta">
                <span v-if="chat.status === 'running' || chat.id === workingChatId" class="chat-list__working"><AssistantTypingDots small /> Working</span>
                <span v-else-if="chat.pendingProposalCount" class="chat-list__badge">{{ chat.pendingProposalCount }} to review</span>
                <span v-else-if="chat.status === 'failed'" class="chat-list__badge chat-list__badge--quiet">Didn't finish</span>
                <span>Last active {{ chatListTime(chat.updatedAt) }}</span>
              </span>
              <span v-if="chat.createdAt" class="chat-list__meta">Opened {{ chatListTime(chat.createdAt) }}</span>
            </button>
            <div class="chat-list__actions">
              <button class="chat-list__action chat-list__action--rename" type="button" :aria-label="`Rename ${chat.title}`" @click="startRename(chat)">
                <i class="bi bi-pencil" aria-hidden="true"></i>
              </button>
              <button class="chat-list__action chat-list__action--delete" type="button" :aria-label="`Delete ${chat.title}`" @click="emit('delete-chat', chat)">
                <i class="bi bi-trash3" aria-hidden="true"></i>
              </button>
            </div>
          </template>
        </li>
      </ul>
    </section>
  </nav>
</template>

<style scoped>
.chat-list {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  height: 100%;
  overflow-y: auto;
  padding: 1rem 0.75rem 1.25rem;
}

.chat-list__head {
  align-items: center;
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0 0.25rem;
}

.chat-list__title {
  border: 0;
  color: var(--ink);
  font-family: var(--font-sans);
  font-size: 1rem;
  margin: 0;
}


.chat-list__empty {
  color: var(--muted);
  font-size: 0.875rem;
  margin: 0;
  padding: 0 0.25rem;
}

.chat-list__group-head {
  align-items: center;
  display: flex;
  gap: 0.25rem;
  margin-bottom: 0.15rem;
}

.chat-list__group-title {
  border: 0;
  color: var(--muted);
  flex: 1;
  font-family: var(--font-sans);
  font-size: 0.75rem !important;
  font-weight: 700;
  letter-spacing: 0.06em;
  margin: 0;
  min-width: 0;
  overflow: hidden;
  padding: 0 0.25rem;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}

.chat-list__add {
  align-items: center;
  background: none;
  border: 0;
  border-radius: 0.5rem;
  color: var(--muted);
  display: inline-flex;
  flex-shrink: 0;
  justify-content: center;
  min-height: 2.75rem;
  min-width: 2.75rem;
}

.chat-list__add:hover,
.chat-list__add:focus-visible {
  background: var(--surface-tint);
  color: var(--accent);
}

.chat-list__none {
  color: var(--muted);
  font-size: 0.75rem;
  margin: 0;
  padding: 0 0.25rem 0.25rem;
}

.chat-list__items {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  list-style: none;
  margin: 0;
  padding: 0;
}

.chat-list__item {
  align-items: stretch;
  border-radius: 0.6rem;
  display: flex;
  position: relative;
}

.chat-list__item:hover,
.chat-list__item--active {
  background: var(--surface-tint);
}

.chat-list__row {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 0.1rem;
  min-height: 2.75rem;
  min-width: 0;
  padding: 0.45rem 0.5rem;
}

.chat-list__open {
  background: none;
  border: 0;
  color: var(--ink);
  text-align: left;
}

.chat-list__input {
  background: var(--surface);
  border: 1px solid var(--accent);
  border-radius: 0.4rem;
  color: var(--ink);
  font-size: 0.875rem;
  font-weight: 600;
  margin: -0.15rem -0.3rem 0.05rem;
  padding: 0.1rem 0.3rem;
  width: calc(100% + 0.6rem);
}

.chat-list__input:focus {
  box-shadow: 0 0 0 0.15rem color-mix(in srgb, var(--accent) 30%, transparent);
  outline: none;
}

.chat-list__name {
  font-size: 0.875rem;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  width: 100%;
}

.chat-list__meta {
  align-items: center;
  color: var(--muted);
  display: flex;
  flex-wrap: wrap;
  font-size: 0.75rem;
  gap: 0.1rem 0.4rem;
}

.chat-list__badge {
  background: var(--accent-deep);
  border-radius: 999px;
  color: #fff;
  font-weight: 600;
  padding: 0 0.45rem;
}

.chat-list__item--active .chat-list__meta {
  color: var(--ink-soft);
}

.chat-list__working {
  align-items: center;
  color: var(--ink-soft);
  display: inline-flex;
  font-weight: 600;
  gap: 0.3rem;
}

.chat-list__badge--quiet {
  background: transparent;
  border: 1px solid var(--line-strong);
  color: var(--muted);
}

/* Rename and delete: with a pointer they appear over the row's right side on hover or focus, so
   titles and dates keep the full width otherwise. On touch they keep a column of their own, and
   rename shows on the open chat only. */
.chat-list__actions {
  display: flex;
  flex-shrink: 0;
}

.chat-list__action {
  align-items: center;
  background: none;
  border: 0;
  border-radius: 0.5rem;
  color: var(--muted);
  display: inline-flex;
  justify-content: center;
  min-height: 2.75rem;
  min-width: 2.75rem;
}

.chat-list__action:hover,
.chat-list__action:focus-visible {
  color: var(--accent);
}

.chat-list__action--delete:hover,
.chat-list__action--delete:focus-visible {
  color: var(--danger);
}

@media (hover: hover) {
  .chat-list__actions {
    align-items: center;
    background: linear-gradient(to right, transparent, var(--surface-tint) 1rem);
    border-radius: 0 0.6rem 0.6rem 0;
    bottom: 0;
    opacity: 0;
    padding-left: 1rem;
    pointer-events: none;
    position: absolute;
    right: 0;
    top: 0;
  }

  .chat-list__item:hover .chat-list__actions,
  .chat-list__item:focus-within .chat-list__actions {
    opacity: 1;
    pointer-events: auto;
  }
}

@media (hover: none) {
  .chat-list__item:not(.chat-list__item--active) .chat-list__action--rename {
    display: none;
  }
}
</style>
