import { reactive } from 'vue';

// The assistant's state: the chat list, the open chat, and the live turn while the assistant
// works. A turn streams over the chat's event channel: text deltas, tool activity, the plan, a
// confirmation request, then the finished chat.

const RECONNECT_MS = 3000;
// How the workspace sits on screen: a centered window, maximized, or docked beside the page.
export const ASSISTANT_LAYOUTS = Object.freeze(['window', 'maximized', 'docked']);
const LAYOUT_KEY = 'odin.assistant.layout';

function storedLayout(storage) {
  try {
    const value = storage?.getItem(LAYOUT_KEY);
    return ASSISTANT_LAYOUTS.includes(value) ? value : 'window';
  } catch {
    return 'window';
  }
}

// `phase` is what the assistant is doing right now (thinking, using a tool, writing), for the
// working indicator; `phaseAt` is when that started.
function emptyLive(now = Date.now()) {
  return { activity: [], budget: null, intent: null, pending: null, phase: 'thinking', phaseAt: now, plan: null, startedAt: new Date(now).toISOString(), text: '' };
}

const PHASE_BY_EVENT = {
  'assistant.delta': 'writing',
  'assistant.reset': 'thinking',
  'plan.updated': 'thinking',
  'tool.completed': 'thinking',
  'tool.started': 'tool',
};

export function applyLiveEvent(live, type, data = {}, now = Date.now()) {
  const next = live ?? emptyLive(now);
  if (PHASE_BY_EVENT[type]) {
    next.phase = PHASE_BY_EVENT[type];
    next.phaseAt = now;
  }
  switch (type) {
    case 'intent.identified':
      next.intent = data;
      break;
    case 'assistant.delta':
      next.text += data.delta ?? '';
      break;
    case 'assistant.reset':
      next.text = '';
      break;
    case 'tool.started': {
      const existing = next.activity.find((entry) => entry.callId === data.callId);
      if (existing) Object.assign(existing, { label: data.label, status: 'running' });
      else next.activity.push({ callId: data.callId, label: data.label, name: data.name, ok: true, status: 'running' });
      break;
    }
    case 'tool.completed': {
      const existing = next.activity.find((entry) => entry.callId === data.callId);
      const entry = { callId: data.callId, error: data.error ?? '', label: data.label, name: data.name, ok: data.ok !== false, status: 'done' };
      if (existing) Object.assign(existing, entry);
      else if (data.name !== 'update_plan') next.activity.push(entry);
      // Other tools from the same step may still be running.
      if (next.activity.some((item) => item.status === 'running')) next.phase = 'tool';
      break;
    }
    case 'plan.updated':
      next.plan = data.steps ?? null;
      next.budget = data.budget ?? null;
      break;
    case 'confirm.requested':
      next.pending = data;
      break;
    default:
      break;
  }
  return next;
}

export function createAssistantStore({ apiClient, authSession, clearTimer = clearTimeout, setTimer = setTimeout, storage = typeof localStorage === 'undefined' ? null : localStorage }) {
  const state = reactive({
    chat: null,
    chatLoading: false,
    errorMessage: '',
    layout: storedLayout(storage),
    list: { general: [], projects: [], projectsAvailable: [] },
    listLoaded: false,
    listLoading: false,
    live: null,
    open: false,
    sending: false,
  });
  let chatStream = null;
  let listStream = null;
  let reconnectTimer = null;
  let listRefresh = null;
  // Runs whose final event already arrived, so a late request response cannot reopen them.
  const finishedRuns = new Set();

  const token = () => authSession.state.token;

  function setChat(chat) {
    state.chat = chat ?? null;
    if (!chat || chat.run?.status !== 'running') state.live = null;
    // Reopening a chat mid-turn: the indicator counts from when the turn began.
    else state.live ??= { ...emptyLive(), startedAt: chat.run?.startedAt ?? new Date().toISOString() };
  }

  async function refreshList() {
    if (listRefresh) return listRefresh;
    state.listLoading = true;
    listRefresh = apiClient.listAssistantChats(token())
      .then((result) => {
        state.list = { general: result.general ?? [], projects: result.projects ?? [], projectsAvailable: result.projectsAvailable ?? [] };
        state.listLoaded = true;
        return state.list;
      })
      .catch((error) => { state.errorMessage = error.message ?? 'Unable to load your chats.'; return state.list; })
      .finally(() => { state.listLoading = false; listRefresh = null; });
    return listRefresh;
  }

  function closeChatStream() {
    chatStream?.();
    chatStream = null;
    if (reconnectTimer) { clearTimer(reconnectTimer); reconnectTimer = null; }
  }

  function openChatStream(chatId) {
    closeChatStream();
    if (!apiClient.subscribeToAssistantChatEvents) return;
    const reconnect = () => {
      if (!state.open || state.chat?.id !== chatId) return;
      reconnectTimer = setTimer(async () => {
        reconnectTimer = null;
        if (!state.open || state.chat?.id !== chatId) return;
        await reloadChat(chatId);
        openChatStream(chatId);
      }, RECONNECT_MS);
    };
    chatStream = apiClient.subscribeToAssistantChatEvents(chatId, token(), {
      onClose: reconnect,
      onError: reconnect,
      onEvent: (event) => handleEvent(chatId, event),
    });
  }

  function openListStream() {
    if (listStream || !apiClient.subscribeToAssistantChatsEvents) return;
    listStream = apiClient.subscribeToAssistantChatsEvents(token(), {
      onClose: () => { listStream = null; },
      onError: () => { listStream = null; },
      onEvent: (event) => { if (event?.type === 'assistant.sessions.invalidated') void refreshList(); },
    });
  }

  async function reloadChat(chatId) {
    try {
      const { chat } = await apiClient.getAssistantChat(chatId, token());
      if (state.chat?.id === chatId || !state.chat) setChat(chat);
      return chat;
    } catch (error) {
      if (state.chat?.id === chatId) state.errorMessage = error.message ?? 'Unable to load this chat.';
      return null;
    }
  }

  function handleEvent(chatId, event = {}) {
    if (state.chat?.id !== chatId) return;
    const { data = {}, type } = event;
    if (type === 'turn.started') {
      state.live = state.live ?? emptyLive();
      if (data.message && !state.chat.messages.some((message) => message.id === data.message.id)) {
        state.chat.messages = [...state.chat.messages.filter((message) => !message.optimistic), data.message];
      }
      return;
    }
    if (['turn.completed', 'turn.failed', 'turn.cancelled'].includes(type)) {
      if (data.chat?.run?.id) finishedRuns.add(data.chat.run.id);
      if (data.chat) setChat(data.chat);
      else void reloadChat(chatId);
      state.live = null;
      state.sending = false;
      void refreshList();
      return;
    }
    if (type === 'assistant.session.invalidated') { void reloadChat(chatId); return; }
    if (type === 'assistant.session.deleted') { setChat(null); return; }
    // Named after its first reply, which may come in after the turn has ended.
    if (type === 'chat.renamed') { if (data.title) state.chat.title = data.title; return; }
    if (state.live || ['assistant.delta', 'tool.started', 'tool.completed', 'plan.updated', 'intent.identified', 'confirm.requested'].includes(type)) {
      state.live = applyLiveEvent(state.live, type, data);
    }
  }

  async function guard(work, fallbackMessage) {
    state.errorMessage = '';
    try {
      return await work();
    } catch (error) {
      state.errorMessage = error.message ?? fallbackMessage;
      throw error;
    }
  }

  return {
    state,
    applyLiveEvent,
    handleEvent,

    show() {
      state.open = true;
      openListStream();
      if (!state.listLoaded) void refreshList();
      if (state.chat) openChatStream(state.chat.id);
    },
    dismiss() {
      state.open = false;
      closeChatStream();
    },
    clearError() { state.errorMessage = ''; },
    setLayout(layout) {
      if (!ASSISTANT_LAYOUTS.includes(layout)) return;
      state.layout = layout;
      try { storage?.setItem(LAYOUT_KEY, layout); } catch { /* the choice just isn't remembered */ }
    },
    refreshList,

    async openChat(chatId) {
      state.chatLoading = true;
      try {
        return await guard(async () => {
          const { chat } = await apiClient.getAssistantChat(chatId, token());
          setChat(chat);
          if (state.open) openChatStream(chat.id);
          return chat;
        }, 'Unable to open this chat.');
      } finally {
        state.chatLoading = false;
      }
    },

    // The latest chat on a project (or a new draft on it), for opening the assistant from a project.
    async openForProject({ fresh = false, projectId = null } = {}) {
      if (!state.listLoaded) await refreshList();
      const latest = projectId
        ? state.list.projects.find((group) => group.projectId === projectId)?.chats?.[0]
        : null;
      if (latest && !fresh) return this.openChat(latest.id);
      this.startDraft({ projectId });
      return state.chat;
    },

    // Starts a blank chat without creating it on the server until the first message.
    startDraft({ projectId = null, projectName = null } = {}) {
      closeChatStream();
      setChat({ draft: true, id: null, messages: [], pending: null, projectId, projectName, run: null, settings: { allowWebResearch: true }, title: 'New chat' });
    },

    // A draft's project can change until its first message creates the chat.
    setDraftProject(projectId = null) {
      if (state.chat?.id) return;
      const settings = state.chat?.settings ?? { allowWebResearch: true };
      this.startDraft({ projectId });
      state.chat.settings = settings;
    },

    async send({ attachments = [], message, pageContext = null }) {
      const text = String(message ?? '').trim();
      if (!text || state.sending) return null;
      state.sending = true;
      return guard(async () => {
        if (!state.chat?.id) {
          const draft = state.chat;
          const { chat } = await apiClient.createAssistantChat({ projectId: draft?.projectId ?? null }, token());
          setChat({ ...chat, settings: { ...chat.settings, allowWebResearch: draft?.settings?.allowWebResearch ?? true } });
          if (state.open) openChatStream(chat.id);
        }
        const chatId = state.chat.id;
        state.chat.messages = [...state.chat.messages, { attachments: attachments.map(({ mimeType, name, size }) => ({ mimeType, name, size })), content: text, createdAt: new Date().toISOString(), id: `optimistic-${Date.now()}`, optimistic: true, role: 'user' }];
        state.live = emptyLive();
        const result = await apiClient.sendAssistantMessage(chatId, {
          allowWebResearch: state.chat.settings?.allowWebResearch !== false,
          attachments,
          message: text,
          ...(pageContext ? { pageContext } : {}),
        }, token());
        if (state.chat?.id === chatId && result.chat && !finishedRuns.has(result.chat.run?.id)) {
          const live = state.live;
          setChat(result.chat);
          if (result.chat.run?.status === 'running') state.live = live ?? emptyLive();
          else state.sending = false;
        }
        void refreshList();
        return result.chat;
      }, 'Unable to send the message.').catch((error) => {
        state.sending = false;
        state.live = null;
        if (state.chat) state.chat.messages = state.chat.messages.filter((entry) => !entry.optimistic);
        throw error;
      });
    },

    async cancel() {
      if (!state.chat?.id) return;
      await guard(() => apiClient.cancelAssistantTurn(state.chat.id, token()), 'Unable to stop the assistant.');
    },

    async confirm(decision, pageContext = null) {
      const chat = state.chat;
      if (!chat?.pending) return;
      state.sending = true;
      await guard(async () => {
        const result = await apiClient.confirmAssistantAction(chat.id, { callId: chat.pending.callId, decision, ...(pageContext ? { pageContext } : {}) }, token());
        if (state.chat?.id === chat.id && result.chat && !finishedRuns.has(result.chat.run?.id)) {
          setChat(result.chat);
          if (result.chat.run?.status === 'running') state.live = state.live ?? emptyLive();
          else state.sending = false;
        }
      }, 'Unable to answer the confirmation.').catch((error) => { state.sending = false; throw error; });
    },

    // Reverses what one reply changed; the chat comes back with each change's outcome and a note.
    async undoChanges(messageId) {
      const chatId = state.chat?.id;
      if (!chatId || !messageId) return null;
      return guard(async () => {
        const result = await apiClient.undoAssistantChanges(chatId, messageId, token());
        if (state.chat?.id === chatId) setChat(result.chat);
        void refreshList();
        return result.chat;
      }, 'Unable to undo those changes.');
    },

    async resolveProposal({ decision, itemIds, proposalId }) {
      const chatId = state.chat?.id;
      if (!chatId) return null;
      return guard(async () => {
        const result = await apiClient.resolveAssistantProposal(chatId, { decision, proposalId, ...(itemIds?.length ? { itemIds } : {}) }, token());
        if (state.chat?.id === chatId) setChat(result.chat);
        void refreshList();
        return result.chat;
      }, 'Unable to update the proposal.');
    },

    // Renames the open chat, or another one from the list.
    async rename(title, chatId = state.chat?.id) {
      if (!chatId || !String(title ?? '').trim()) return;
      // The list shows the new name at once; a failed save reloads it.
      for (const entry of [...state.list.general, ...state.list.projects.flatMap((group) => group.chats)]) {
        if (entry.id === chatId) entry.title = String(title).trim();
      }
      await guard(async () => {
        const { chat } = await apiClient.updateAssistantChat(chatId, { title: String(title).trim() }, token());
        if (state.chat?.id === chatId) state.chat.title = chat.title;
      }, 'Unable to rename this chat.').finally(() => { void refreshList(); });
    },

    async setWebResearch(allow) {
      if (!state.chat) return;
      state.chat.settings = { ...state.chat.settings, allowWebResearch: Boolean(allow) };
      if (state.chat.id) await guard(() => apiClient.updateAssistantChat(state.chat.id, { allowWebResearch: Boolean(allow) }, token()), 'Unable to save the setting.').catch(() => null);
    },

    async remove(chatId) {
      await guard(() => apiClient.deleteAssistantChat(chatId, token()), 'Unable to delete this chat.');
      if (state.chat?.id === chatId) { closeChatStream(); setChat(null); }
      await refreshList();
    },
  };
}
