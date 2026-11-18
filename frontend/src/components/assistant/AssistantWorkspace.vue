<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import { apiClient } from '../../lib/auth/index.js';
import { assistantStore } from '../../lib/assistant/index.js';
import { pageContextFor, suggestedPrompts } from '../../lib/assistant/assistant-format.js';
import { useOverlayScrollLock } from '../../lib/ui/overlay-scroll-lock.js';
import RequirementsConfirmDialog from '../requirements/RequirementsConfirmDialog.vue';
import AssistantChatList from './AssistantChatList.vue';
import AssistantComposer from './AssistantComposer.vue';
import AssistantMessage from './AssistantMessage.vue';
import AssistantTypingDots from './AssistantTypingDots.vue';

// The assistant: a chat-first workspace. It opens as a window over the page, maximized, or docked
// beside the page so Odin stays usable while you chat. The list of chats sits in a rail on the
// left; the open chat streams its replies, tool activity and plan as the assistant works.
// `embedded` puts it in a page instead: Odin's direct message in Odin Chat shows the same chats,
// store and agent there, without the window controls (docs/odin-chat/plan.md, Odin Chat).
const props = defineProps({
  embedded: { default: false, type: Boolean },
});
const emit = defineEmits(['dismiss']);
const route = useRoute();
const router = useRouter();
const state = assistantStore.state;

const layout = computed(() => (props.embedded ? 'embedded' : state.layout));
const docked = computed(() => layout.value === 'docked');
// A docked panel leaves the page scrollable and usable, as a page of its own does.
useOverlayScrollLock(() => !docked.value && !props.embedded);

const apiBaseUrl = computed(() => apiClient.baseUrl);
const railOpen = ref(false);
const thread = ref(null);
const composer = ref(null);
const titleEditing = ref(false);
const titleDraft = ref('');
const deleting = ref({ busy: false, chat: null, error: '', open: false });
const resolving = ref(false);

const chat = computed(() => state.chat);
const messages = computed(() => chat.value?.messages ?? []);
const working = computed(() => Boolean(state.live) || chat.value?.run?.status === 'running');
const routeProjectId = computed(() => (route.params.projectId ? String(route.params.projectId) : null));
// An open chat's project is its own, even none; with no chat open, the page's.
const projectId = computed(() => (chat.value ? chat.value.projectId ?? null : routeProjectId.value));
// A draft carries no name of its own, so it comes from the chat list.
const projectName = computed(() => chat.value?.projectName
  || state.list.projects.find((group) => group.projectId === projectId.value)?.projectName
  || state.list.projectsAvailable.find((project) => project.id === projectId.value)?.name
  || '');
const pageContext = computed(() => (chat.value?.projectId && String(route.params.projectId ?? '') !== chat.value.projectId ? null : pageContextFor(route)));
const prompts = computed(() => suggestedPrompts({ projectName: projectName.value, view: pageContext.value?.view ?? '' }));
// A new chat's project can be chosen until its first message.
const choosingProject = computed(() => !chat.value?.id && !state.chatLoading);
const memoryRoute = computed(() => ({ name: 'agent-memory', query: projectId.value ? { project: projectId.value } : {} }));
const liveMessage = computed(() => (state.live ? { activity: state.live.activity, content: state.live.text, id: 'live', plan: state.live.plan, role: 'assistant' } : null));

function close() {
  emit('dismiss');
}

const shell = ref(null);

function handleKeydown(event) {
  if (props.embedded || event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open]')) return;
  // Docked beside the page, Escape only closes the panel when you are in it.
  if (docked.value && !shell.value?.contains(document.activeElement)) return;
  close();
}

function toggleDocked() {
  assistantStore.setLayout(docked.value ? 'window' : 'docked');
}

function toggleMaximized() {
  assistantStore.setLayout(layout.value === 'maximized' ? 'window' : 'maximized');
}

// The page makes room for the docked panel.
watch(docked, (value) => document.documentElement.classList.toggle('assistant-docked', value), { immediate: true });
onBeforeUnmount(() => document.documentElement.classList.remove('assistant-docked'));

async function scrollToEnd({ force = false } = {}) {
  await nextTick();
  const element = thread.value;
  if (!element) return;
  const nearEnd = element.scrollHeight - element.scrollTop - element.clientHeight < 160;
  if (force || nearEnd) element.scrollTop = element.scrollHeight;
}

watch(() => [messages.value.length, chat.value?.id], () => scrollToEnd({ force: true }));
watch(() => [state.live?.text, state.live?.activity.length, state.live?.plan], () => scrollToEnd());

async function send({ attachments, message }) {
  try {
    await assistantStore.send({ attachments, message, pageContext: pageContext.value });
    await scrollToEnd({ force: true });
  } catch {
    // The store shows the error.
  }
}

// From the header: a new chat on the page's project, which the chat's project picker can change.
// From a folder in the chat list: a new chat in that project (null: not tied to one).
function newChat(folderProjectId) {
  railOpen.value = false;
  assistantStore.startDraft({ projectId: folderProjectId === undefined ? routeProjectId.value : folderProjectId });
  nextTick(() => composer.value?.focus());
}

function chooseProject(value) {
  assistantStore.setDraftProject(value || null);
  nextTick(() => composer.value?.focus());
}

async function openChat(chatId) {
  railOpen.value = false;
  await assistantStore.openChat(chatId).catch(() => null);
  nextTick(() => composer.value?.focus());
}

async function confirm(decision) {
  await assistantStore.confirm(decision, pageContext.value).catch(() => null);
}

// The replies whose undo is running; each card shows only its own.
const undoing = reactive(new Set());

async function undoChanges(messageId) {
  undoing.add(messageId);
  try {
    await assistantStore.undoChanges(messageId);
  } catch {
    // The store shows the error.
  } finally {
    undoing.delete(messageId);
  }
}

async function resolveProposal(payload) {
  resolving.value = true;
  try {
    await assistantStore.resolveProposal(payload);
  } catch {
    // The store shows the error.
  } finally {
    resolving.value = false;
  }
}

// A link opens the item in the page; docked, the chat stays open beside it.
function openLink(target) {
  if (target.kind !== 'project' && !chat.value?.projectId) return;
  if (!docked.value && !props.embedded) close();
  if (target.kind === 'project') router.push({ name: 'project-detail', params: { projectId: target.id } });
  else router.push({ name: 'project-detail', params: { projectId: chat.value.projectId }, query: { item: target.id } });
}

function startTitleEdit() {
  if (!chat.value?.id) return;
  titleDraft.value = chat.value.title;
  titleEditing.value = true;
  nextTick(() => document.getElementById('assistant-title-input')?.select());
}

async function saveTitle() {
  if (!titleEditing.value) return;
  titleEditing.value = false;
  if (titleDraft.value.trim() && titleDraft.value.trim() !== chat.value?.title) await assistantStore.rename(titleDraft.value).catch(() => null);
}

function askDelete(entry) {
  deleting.value = { busy: false, chat: entry, error: '', open: true };
}

async function confirmDelete() {
  deleting.value.busy = true;
  try {
    await assistantStore.remove(deleting.value.chat.id);
    deleting.value.open = false;
  } catch (error) {
    deleting.value.error = error.message ?? 'Unable to delete this chat.';
  } finally {
    deleting.value.busy = false;
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown);
  nextTick(() => composer.value?.focus());
  scrollToEnd({ force: true });
});
onBeforeUnmount(() => document.removeEventListener('keydown', handleKeydown));
</script>

<template>
  <Teleport to="body" :disabled="embedded">
    <div class="assistant-overlay" :class="`assistant-overlay--${layout}`" role="presentation" @click.self="layout === 'window' && close()">
      <section
        ref="shell"
        class="assistant-shell"
        :class="`assistant-shell--${layout}`"
        :role="embedded ? 'region' : docked ? 'complementary' : 'dialog'"
        :aria-modal="docked || embedded ? undefined : 'true'"
        aria-label="AI Workspace"
      >
        <button v-if="railOpen" class="assistant-scrim" type="button" aria-label="Hide chats" @click="railOpen = false"></button>
        <aside class="assistant-rail" :class="{ 'assistant-rail--open': railOpen }">
          <AssistantChatList
            :active-chat-id="chat?.id ?? null"
            :current-project-id="routeProjectId"
            :list="state.list"
            :loading="state.listLoading"
            :working-chat-id="working ? chat?.id ?? null : null"
            @delete-chat="askDelete"
            @new-chat="newChat"
            @open-chat="openChat"
            @rename-chat="({ chatId, title }) => assistantStore.rename(title, chatId).catch(() => null)"
          />
        </aside>

        <div class="assistant-main">
          <header class="assistant-header">
            <button class="assistant-icon assistant-rail-toggle" type="button" aria-label="Show chats" @click="railOpen = true">
              <i class="bi bi-layout-sidebar" aria-hidden="true"></i>
            </button>
            <div class="assistant-header__title">
              <p class="assistant-header__context">
                <i class="bi" :class="projectName ? 'bi-kanban' : 'bi-stars'" aria-hidden="true"></i>
                {{ projectName || 'Odin assistant' }}
              </p>
              <input
                v-if="titleEditing"
                id="assistant-title-input"
                v-model="titleDraft"
                class="assistant-header__input"
                aria-label="Chat title"
                maxlength="120"
                @blur="saveTitle"
                @keydown.enter.prevent="saveTitle"
                @keydown.esc.stop.prevent="titleEditing = false"
              />
              <h2 v-else id="assistant-title" class="assistant-header__name">
                <button class="assistant-header__rename" type="button" :disabled="!chat?.id" :title="chat?.id ? 'Rename chat' : undefined" @click="startTitleEdit">
                  {{ chat?.title || 'New chat' }}
                </button>
              </h2>
            </div>
            <div class="assistant-header__actions">
              <span v-if="working" class="assistant-header__working" aria-hidden="true">
                <AssistantTypingDots small /> Working
              </span>
              <button class="assistant-header__new" type="button" aria-label="New chat" @click="newChat()">
                <i class="bi bi-plus-lg" aria-hidden="true"></i><span v-if="!docked"> New chat</span>
              </button>
              <RouterLink class="assistant-icon" :to="memoryRoute" aria-label="What the assistant remembers" title="What the assistant remembers">
                <i class="bi bi-journal-bookmark" aria-hidden="true"></i>
              </RouterLink>
              <button
                v-if="!embedded"
                class="assistant-icon assistant-layout-toggle"
                type="button"
                :aria-label="docked ? 'Undock to a window' : 'Dock beside the page'"
                :title="docked ? 'Undock to a window' : 'Dock beside the page'"
                @click="toggleDocked"
              >
                <i class="bi" :class="docked ? 'bi-window' : 'bi-layout-sidebar-inset-reverse'" aria-hidden="true"></i>
              </button>
              <button
                v-if="!embedded"
                class="assistant-icon assistant-layout-toggle"
                type="button"
                :aria-label="layout === 'maximized' ? 'Restore the window size' : 'Maximize'"
                :title="layout === 'maximized' ? 'Restore the window size' : 'Maximize'"
                @click="toggleMaximized"
              >
                <i class="bi" :class="layout === 'maximized' ? 'bi-fullscreen-exit' : 'bi-fullscreen'" aria-hidden="true"></i>
              </button>
              <button v-if="!embedded" class="assistant-icon" type="button" aria-label="Close assistant" title="Close" @click="close">
                <i class="bi bi-x-lg" aria-hidden="true"></i>
              </button>
            </div>
          </header>

          <div ref="thread" class="assistant-thread">
            <div class="assistant-thread__inner">
              <div v-if="state.chatLoading && !messages.length" class="assistant-empty">
                <span class="spinner-border spinner-border-sm" aria-hidden="true"></span> Loading the chat…
              </div>
              <div v-else-if="!messages.length && !liveMessage" class="assistant-empty">
                <div v-if="choosingProject" class="assistant-empty__project">
                  <label for="assistant-project">Project</label>
                  <select id="assistant-project" class="form-select form-select-sm" :value="projectId ?? ''" @change="chooseProject($event.target.value)">
                    <option value="">No project</option>
                    <option v-for="project in state.list.projectsAvailable" :key="project.id" :value="project.id">{{ project.name }}</option>
                  </select>
                </div>
                <h3 class="assistant-empty__title">{{ projectName ? `What do you need on ${projectName}?` : 'What can I help with?' }}</h3>
                <p class="assistant-empty__hint">Ask a question, or tell me what to change. I work with your permissions; deletes and emails ask you first.</p>
                <div class="assistant-empty__prompts">
                  <button v-for="prompt in prompts" :key="prompt" class="assistant-prompt" type="button" @click="composer?.fill(prompt)">{{ prompt }}</button>
                </div>
              </div>
              <AssistantMessage
                v-for="message in messages"
                :key="message.id"
                :api-base-url="apiBaseUrl"
                :busy="resolving || state.sending || working"
                :message="message"
                :pending-call-id="chat?.pending?.callId ?? null"
                @confirm="confirm"
                @open-link="openLink"
                :undoing="undoing.has(message.id)"
                @resolve-proposal="resolveProposal"
                @undo="undoChanges"
              />
              <AssistantMessage v-if="liveMessage" live :api-base-url="apiBaseUrl" :live-state="state.live" :message="liveMessage" @open-link="openLink" />
              <p v-if="state.errorMessage" class="assistant-error" role="alert">
                <i class="bi bi-exclamation-triangle" aria-hidden="true"></i>
                <span>{{ state.errorMessage }}</span>
                <button class="assistant-icon" type="button" aria-label="Dismiss the error" @click="assistantStore.clearError()"><i class="bi bi-x" aria-hidden="true"></i></button>
              </p>
            </div>
          </div>

          <footer class="assistant-footer">
            <AssistantComposer
              ref="composer"
              :allow-web-research="chat?.settings?.allowWebResearch !== false"
              :disabled="state.chatLoading"
              :placeholder="projectName ? 'Ask a question or say what to change…' : 'Ask about your work, or start a new project…'"
              :working="working"
              @send="send"
              @stop="assistantStore.cancel().catch(() => null)"
              @toggle-web="assistantStore.setWebResearch($event)"
            />
          </footer>
        </div>
      </section>

      <RequirementsConfirmDialog
        :busy="deleting.busy"
        confirm-label="Delete chat"
        :error="deleting.error"
        :open="deleting.open"
        :title="`Delete “${deleting.chat?.title ?? ''}”?`"
        @close="deleting.open = false"
        @confirm="confirmDelete"
      >
        <p class="mb-0">The conversation is removed for you. Changes the assistant made in Odin stay as they are.</p>
      </RequirementsConfirmDialog>
    </div>
  </Teleport>
</template>

<style scoped>
.assistant-overlay {
  align-items: center;
  backdrop-filter: blur(6px);
  background: rgba(8, 12, 22, 0.5);
  display: flex;
  inset: 0;
  justify-content: center;
  overscroll-behavior: contain;
  padding: 1.25rem;
  position: fixed;
  z-index: 1200;
}

.assistant-shell {
  background: var(--page);
  border: 1px solid var(--line);
  border-radius: 1.25rem;
  box-shadow: 0 32px 100px rgba(8, 12, 22, 0.4);
  display: flex;
  height: min(94vh, 1000px);
  overflow: hidden;
  position: relative;
  width: min(96vw, 1400px);
}

.assistant-rail {
  background: var(--surface);
  border-right: 1px solid var(--line);
  flex-shrink: 0;
  width: 272px;
}

.assistant-main {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.assistant-header {
  align-items: center;
  border-bottom: 1px solid var(--line);
  display: flex;
  gap: 0.75rem;
  padding: 0.6rem 0.9rem 0.6rem 1.25rem;
}

.assistant-header__title {
  flex: 1;
  min-width: 0;
}

.assistant-header__context {
  align-items: center;
  color: var(--muted);
  display: flex;
  font-size: 0.78rem;
  gap: 0.35rem;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.assistant-header__name {
  border: 0;
  font-family: var(--font-sans);
  font-size: 1.05rem;
  margin: 0;
  padding: 0;
}

.assistant-header__rename {
  background: none;
  border: 0;
  border-radius: 0.4rem;
  color: var(--ink);
  font-weight: 700;
  max-width: 100%;
  overflow: hidden;
  padding: 0.1rem 0.25rem;
  margin-left: -0.25rem;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.assistant-header__rename:not(:disabled):hover {
  background: var(--surface-tint);
}

.assistant-header__input {
  background: var(--surface);
  border: 1px solid var(--accent);
  border-radius: 0.4rem;
  color: var(--ink);
  font-size: 1.05rem;
  font-weight: 700;
  padding: 0.1rem 0.4rem;
  width: min(100%, 32rem);
}

.assistant-header__actions {
  align-items: center;
  display: flex;
  gap: 0.35rem;
}

.assistant-header__working {
  align-items: center;
  color: var(--ink-soft);
  display: inline-flex;
  font-size: 0.82rem;
  font-weight: 600;
  gap: 0.4rem;
  margin-right: 0.35rem;
}

.assistant-header__new {
  align-items: center;
  background: var(--surface);
  border: 1px solid var(--line-strong);
  border-radius: 0.6rem;
  color: var(--ink);
  display: inline-flex;
  font-size: 0.875rem;
  font-weight: 600;
  gap: 0.3rem;
  min-height: 2.75rem;
  padding: 0 0.8rem;
}

.assistant-header__new:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.assistant-icon {
  align-items: center;
  background: none;
  border: 0;
  border-radius: 0.6rem;
  color: var(--muted);
  display: inline-flex;
  justify-content: center;
  min-height: 2.75rem;
  min-width: 2.75rem;
}

.assistant-icon:hover {
  background: var(--surface-tint);
  color: var(--ink);
}

.assistant-rail-toggle,
.assistant-scrim {
  display: none;
}

.assistant-thread {
  flex: 1;
  overflow-y: auto;
  padding: 1.5rem 1.25rem 1rem;
}

.assistant-thread__inner {
  display: flex;
  flex-direction: column;
  gap: 1.4rem;
  margin: 0 auto;
  max-width: 48rem;
}

.assistant-empty {
  color: var(--muted);
  margin: auto 0;
  padding: 3rem 0 1rem;
  text-align: center;
}

.assistant-empty__project {
  align-items: center;
  display: flex;
  gap: 0.5rem;
  justify-content: center;
  margin: 0 auto 1rem;
  max-width: 24rem;
}

.assistant-empty__project label {
  color: var(--ink-soft);
  font-size: 0.875rem;
  font-weight: 600;
}

.assistant-empty__project .form-select {
  flex: 1;
  font-size: 0.875rem;
  min-height: 2.75rem;
  min-width: 0;
}

.assistant-empty__title {
  border: 0;
  color: var(--ink);
  font-family: var(--font-sans);
  font-size: 1.35rem !important;
  margin: 0 0 0.4rem;
}

.assistant-empty__hint {
  font-size: 0.9rem;
  margin: 0 auto 1.25rem;
  max-width: 32rem;
}

.assistant-empty__prompts {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  justify-content: center;
}

.assistant-prompt {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--ink);
  font-size: 0.875rem;
  min-height: 2.75rem;
  padding: 0 1rem;
}

.assistant-prompt:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.assistant-error {
  align-items: center;
  background: color-mix(in srgb, var(--danger) 10%, transparent);
  border-radius: 0.6rem;
  color: var(--danger);
  display: flex;
  font-size: 0.9rem;
  gap: 0.5rem;
  margin: 0;
  padding: 0.25rem 0.25rem 0.25rem 0.8rem;
}

.assistant-error span {
  flex: 1;
}

.assistant-footer {
  margin: 0 auto;
  max-width: calc(48rem + 2.5rem);
  padding: 0 1.25rem 1.1rem;
  width: 100%;
}

html.dark .assistant-rail {
  background: #0d1a2c;
}

/* Embedded: fills the page it is in (Odin Chat's Odin conversation). */
.assistant-overlay--embedded {
  backdrop-filter: none;
  background: none;
  height: 100%;
  inset: auto;
  padding: 0;
  position: relative;
  z-index: auto;
}

.assistant-shell--embedded {
  border: 0;
  border-radius: 0;
  box-shadow: none;
  height: 100%;
  width: 100%;
}

/* Maximized: the whole viewport. */
.assistant-overlay--maximized {
  padding: 0;
}

.assistant-shell--maximized {
  border-radius: 0;
  height: 100%;
  width: 100%;
}

/* Docked: a panel on the right; the page beside it stays usable (see html.assistant-docked). */
.assistant-overlay--docked {
  backdrop-filter: none;
  background: none;
  inset: 0 0 0 auto;
  padding: 0;
  width: var(--assistant-dock-width);
}

.assistant-shell--docked {
  border-radius: 0;
  border-width: 0 0 0 1px;
  box-shadow: -12px 0 32px rgba(8, 12, 22, 0.12);
  height: 100%;
  width: 100%;
}

.assistant-shell--docked .assistant-rail {
  bottom: 0;
  left: 0;
  position: absolute;
  top: 0;
  transform: translateX(-100%);
  transition: transform 0.2s ease;
  z-index: 3;
}

.assistant-shell--docked .assistant-rail--open {
  box-shadow: var(--shadow-strong);
  transform: translateX(0);
}

.assistant-shell--docked .assistant-rail-toggle {
  display: inline-flex;
}

.assistant-shell--docked .assistant-scrim {
  background: rgba(8, 12, 22, 0.4);
  border: 0;
  display: block;
  inset: 0;
  position: absolute;
  z-index: 2;
}

.assistant-shell--docked .assistant-header {
  gap: 0.25rem;
  padding: 0.5rem 0.4rem 0.5rem 0.6rem;
}

.assistant-shell--docked .assistant-header__working {
  display: none;
}

.assistant-shell--docked .assistant-header__new {
  min-width: 2.75rem;
  justify-content: center;
  padding: 0;
}

.assistant-shell--docked .assistant-thread {
  padding: 1rem 0.9rem 0.75rem;
}

.assistant-shell--docked .assistant-footer {
  padding: 0 0.75rem 0.75rem;
}

@media (max-width: 991.98px) {
  /* No room to dock: the panel fills the screen instead. */
  .assistant-overlay--docked {
    width: 100%;
  }
}

@media (max-width: 899.98px) {
  .assistant-overlay {
    padding: 0;
  }

  .assistant-shell {
    border-radius: 0;
    height: 100%;
    width: 100%;
  }

  .assistant-rail {
    bottom: 0;
    left: 0;
    position: absolute;
    top: 0;
    transform: translateX(-100%);
    transition: transform 0.2s ease;
    z-index: 3;
  }

  .assistant-rail--open {
    box-shadow: var(--shadow-strong);
    transform: translateX(0);
  }

  .assistant-rail-toggle {
    display: inline-flex;
  }

  .assistant-scrim {
    background: rgba(8, 12, 22, 0.4);
    border: 0;
    display: block;
    inset: 0;
    position: absolute;
    z-index: 2;
  }

  .assistant-header__new span {
    display: none;
  }
}
</style>
