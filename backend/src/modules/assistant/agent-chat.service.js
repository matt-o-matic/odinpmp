import { createHash, randomUUID } from 'node:crypto';
import OpenAI from 'openai';

import { HttpError } from '../../lib/errors/http-error.js';
import { LIVE_EVENT_CHANNELS } from '../../lib/events/live-event-bus.js';
import { getTenantMembership, PROJECT_CAPABILITIES, requireProjectCapability } from '../../lib/auth/project-capabilities.js';
import { createDefaultAiConfig, normalizeAiCapabilityConfig, resolveAiCapabilitySettings } from '../../lib/ai/ai-capability-config.js';
import { createOdinApiClient, OdinApiError } from '../../mcp/api-client.js';
import { buildProjectOverview, compactItem, flattenProjectItems } from '../../mcp/project-overview.js';
import { createAgentToolbox } from '../../lib/agent/agent-tools.js';
import { buildAgentInstructions, buildTurnContext } from '../../lib/agent/agent-prompt.js';
import { normalizeAgentMarkdown } from '../../lib/agent/agent-markdown.js';
import { createAgentDecisions, decisionEvidence, triageTurn } from '../../lib/agent/agent-decisions.js';
import { createTurnState, runAgentTurn } from '../../lib/agent/odin-agent.js';
import { compactTranscript, emptyTranscript, estimateTokens, keptItems, planCompaction, reconcileTranscript, transcriptInput } from '../../lib/agent/agent-transcript.js';
import { withoutMedia } from '../../lib/agent/agent-media.js';
import { createChangeRecorder, presentChanges, snapshotVersions, undoChanges, undoSummary } from '../../lib/agent/agent-changes.js';
import { generateChatTitle } from '../../lib/agent/agent-chat-title.js';
import { applyRecoveryActions } from './assistant-recovery-actions.js';

const ATTACHMENT_TEXT_LIMIT = 60000;

const nowIso = () => new Date().toISOString();

export function primaryTenantId(user) {
  const tenantId = user?.memberships?.[0]?.tenantId ?? null;
  if (!tenantId) throw new HttpError(403, 'This account is not assigned to a tenant.');
  return tenantId;
}

function clip(value = '', max = 160) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function titleFromMessage(message = '') {
  const text = clip(message, 60).replace(/[.?!]+$/, '');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'New chat';
}

function friendlyModelError(error) {
  const status = error?.status ?? error?.response?.status;
  if (status === 401) return 'The AI provider rejected the workspace API key. An admin can update it under Tenant Admin → Integrations → AI Integrations.';
  if (status === 429) return 'The AI provider is rate limiting this workspace right now. Wait a moment and try again.';
  if (status === 400) return `The AI provider rejected the request: ${clip(error?.message, 240)}`;
  if (error?.assistantTurnTimeout) return 'This took too long and was stopped. Try a narrower request.';
  return `Something went wrong while answering: ${clip(error?.message, 240) || 'unknown error'}.`;
}

export function createAgentModelResolver({ defaultApiKey = '', defaultModel = '', openAiFactory = null, tenantsRepository = null }) {
  const clients = new Map();
  return async function resolve(tenantId) {
    const config = tenantsRepository?.getOpenAiConfig
      ? normalizeAiCapabilityConfig(await tenantsRepository.getOpenAiConfig({ defaults: createDefaultAiConfig(defaultModel), tenantId }), { defaultModel })
      : normalizeAiCapabilityConfig({}, { defaultModel });
    const apiKey = config?.valid_config && config?.openai_key ? config.openai_key : defaultApiKey;
    // Only the model comes from the workspace setting. Each turn picks its own reasoning effort
    // (DEFAULT_AGENT_CONFIG reasoningSimple and reasoningComplex), as the admin screen says.
    const settings = resolveAiCapabilitySettings(config, 'intakeDialogue', { defaultModel });
    const model = String(settings.model ?? defaultModel ?? '').trim();
    if (!apiKey || !model) throw new HttpError(503, 'The assistant is not configured. An admin can add an OpenAI key under Tenant Admin → Integrations → AI Integrations.');
    if (!clients.has(apiKey)) clients.set(apiKey, openAiFactory ? openAiFactory(apiKey) : new OpenAI({ apiKey }));
    return { client: clients.get(apiKey), model };
  };
}

// Each turn's tool calls run through Odin's REST routes as the user, with a short-lived session
// of their own that is revoked when the turn ends.
export function createAgentSessionOpener({ apiOrigin, sessionsRepository, tokenService }) {
  return async function open({ tenantId, user }) {
    const sessionId = randomUUID();
    const token = tokenService.signSessionToken({ email: user.email, id: user.id, name: user.name, preferences: {}, role: null, scopes: [], tenantId }, { channel: 'assistant', sessionId });
    await sessionsRepository.createSession({ expiryDate: new Date(Date.now() + 60 * 60 * 1000), id: sessionId, ipAddr: '127.0.0.1', locationName: 'Odin assistant', token, userAgent: 'Odin assistant', userId: user.id });
    return {
      api: createOdinApiClient({ baseUrl: typeof apiOrigin === 'function' ? apiOrigin() : apiOrigin, timeoutMs: 30000, token }),
      close: () => sessionsRepository.revokeToken({ token }).catch(() => {}),
    };
  };
}

// A read-only turn's client sends reads only, so even a tool wrongly labelled as a read cannot
// change anything.
export function readOnlyApi(api) {
  return {
    ...api,
    async request(method, pathname, options) {
      if (String(method).toUpperCase() !== 'GET') throw new OdinApiError(403, 'read_only', 'Not run: this is a monitor check, which can only read.');
      return api.request(method, pathname, options);
    },
  };
}

// A turn still marked running that no process is running: the server stopped or restarted
// during it (a deploy, or PM2's memory limit), and nothing will finish it.
const INTERRUPTED = 'This answer was interrupted when Odin restarted. Send your message again.';
const interruptedReply = (run) => ({ content: '', createdAt: run.startedAt ?? nowIso(), error: INTERRUPTED, id: `${run.id}-interrupted`, role: 'assistant' });

function presentChat(chat, { projectNames = new Map(), running = false } = {}) {
  const interrupted = chat.run?.status === 'running' && !running;
  return {
    createdAt: chat.createdAt,
    id: chat.id,
    messages: [...chat.messages, ...(interrupted ? [interruptedReply(chat.run)] : [])].map(({ attachments, changes, ...message }) => ({
      ...message,
      ...(attachments?.length ? { attachments: attachments.map(({ name, mimeType, size }) => ({ mimeType, name, size })) } : {}),
      ...(changes ? { changes: presentChanges(changes) } : {}),
    })),
    pending: chat.pending ? { args: chat.pending.args, callId: chat.pending.callId, description: chat.pending.description, label: chat.pending.label, name: chat.pending.name, target: chat.pending.target ?? '' } : null,
    projectId: chat.projectId,
    projectName: chat.projectId ? projectNames.get(chat.projectId) ?? null : null,
    run: interrupted ? { ...chat.run, error: INTERRUPTED, status: 'failed' } : chat.run,
    settings: chat.settings,
    title: chat.title || 'New chat',
    updatedAt: chat.updatedAt,
  };
}

// A chat started by another surface adds its own notes after the turn's notes.
function withOriginNotes(chat, notes) {
  return chat.origin?.notes ? `${notes}\n\n${chat.origin.notes}` : notes;
}

function chatSummary(chat, running) {
  const last = [...chat.messages].reverse().find((message) => message.content);
  return {
    createdAt: chat.createdAt,
    id: chat.id,
    lastMessagePreview: clip(last?.content ?? '', 120),
    pendingProposalCount: pendingProposalItemIds(chat).size + (chat.pending ? 1 : 0),
    projectId: chat.projectId,
    status: chat.run?.status === 'running' && !running ? 'failed' : (chat.run?.status ?? 'idle'),
    title: chat.title || 'New chat',
    updatedAt: chat.updatedAt,
  };
}

// About what one image costs the model, for the compaction budget (its data URL would count
// millions of characters).
const IMAGE_TOKENS = 1500;
const imageCount = (item) => (Array.isArray(item?.content) ? item.content.filter((part) => part.type === 'input_image').length : 0);

function currentUserInput(message, attachments = []) {
  let text = message.content;
  for (const file of attachments) {
    if (file.text) text += `\n\nAttached file "${file.name}":\n${file.text.slice(0, ATTACHMENT_TEXT_LIMIT)}`;
  }
  const images = attachments.filter((file) => file.dataUrl && file.mimeType?.startsWith('image/'));
  if (!images.length) return { content: text, role: 'user' };
  return {
    content: [{ text, type: 'input_text' }, ...images.map((file) => ({ detail: 'auto', image_url: file.dataUrl, type: 'input_image' }))],
    role: 'user',
  };
}

// Ids of staged proposal items still waiting for the user in a chat (Requirements plans read
// this to show which proposed work is pending).
export function pendingProposalItemIds(chat) {
  return new Set((chat?.messages ?? []).flatMap((message) => (message.proposal?.items ?? []).filter((item) => item.status === 'pending').map((item) => item.id)));
}

function proposalStatus(items) {
  const pending = items.filter((item) => item.status === 'pending').length;
  if (pending === items.length) return 'pending';
  if (pending) return 'partial';
  if (items.every((item) => item.status === 'dismissed' || item.status === 'withdrawn')) return 'dismissed';
  return items.some((item) => item.status === 'failed') ? 'partial' : 'applied';
}

// Requests from one user share a cache key, so they reach the machines holding that user's cached
// prompt prefix (the fixed instructions and tools, then each chat's conversation).
function promptCacheKeyFor(chat) {
  return `odin-${createHash('sha256').update(`${chat.tenantId}:${chat.userId}`).digest('hex').slice(0, 32)}`;
}

export const DEFAULT_AGENT_CONFIG = Object.freeze({
  // Each chat is named once its first reply is in, from the request and the reply.
  chatTitles: true,
  chatTitleModel: 'gpt-6-luna',
  chatTitleReasoning: 'low',
  // The conversation grows until a request would pass this many tokens, then older turns are
  // condensed into a summary.
  compactAtTokens: 120000,
  decisionsEnabled: true,
  decisionsModel: 'gpt-6-luna',
  decisionsTimeoutMs: 4000,
  maxOutputTokens: 32000,
  maxToolCalls: 420,
  // Some models (gpt-6-luna among them) only cache for 24 hours; a model that rejects it gets
  // the request again without it.
  promptCacheRetention: '24h',
  reasoningComplex: 'max',
  reasoningSimple: 'high',
  toolCallsPerTask: 40,
  writeCheckThreshold: 0.3,
  writeCheckThresholdOnChange: 0.1,
});

export function createAgentChatService({
  agentConfig = {},
  chatsRepository,
  domainEventOutboxRepository = null,
  governanceRepository = null,
  liveEventBus = null,
  modelResolver,
  openSession,
  projectRepository,
  turnQueue,
}) {
  const config = { ...DEFAULT_AGENT_CONFIG, ...agentConfig };
  // Chats that run for another surface (Odin in channels): its hooks hear when each turn starts
  // and settles, and when an undo changes a reply. They are kept out of the chat list.
  const origins = new Map();
  const originOf = (chat) => (chat?.origin?.type ? origins.get(chat.origin.type) ?? null : null);
  const storeFor = (chat) => originOf(chat)?.store?.(chat) ?? chatsRepository;
  async function notifyOrigin(hook, chat) {
    const handlers = originOf(chat);
    if (!handlers?.[hook]) return;
    try {
      await handlers[hook](chat);
    } catch (error) {
      console.error('Assistant origin hook failed.', { chatId: chat.id, error: error?.message, hook, origin: chat.origin?.type });
    }
  }
  const publish = (chatId, type, payload = {}) => liveEventBus?.publish?.(LIVE_EVENT_CHANNELS.session(chatId), { payload: { chatId, ...payload }, type });
  const invalidateList = (chat, reason) => liveEventBus?.publish?.(LIVE_EVENT_CHANNELS.assistantSessions(chat.tenantId, chat.userId), { payload: { reason, sessionId: chat.id }, type: 'assistant.sessions.invalidated' });
  // Best-effort: on any failure the chat keeps the title cut from its first message. The title is
  // set on its own, and only while it is still that automatic one, so it can't undo a rename.
  async function nameChat({ chat, client, request, response }) {
    try {
      const title = await generateChatTitle({ client, model: config.chatTitleModel, reasoningEffort: config.chatTitleReasoning, request, response });
      if (!title) return;
      const saved = await chatsRepository.setGeneratedTitle({ chatId: chat.id, tenantId: chat.tenantId, title, userId: chat.userId });
      if (!saved) return;
      invalidateList(saved, 'chat-named');
      publish(chat.id, 'chat.renamed', { title: saved.title });
    } catch (error) {
      console.warn('Assistant chat title failed.', { chatId: chat.id, error: error?.message });
    }
  }

  async function projectNamesFor(tenantId, user) {
    const projects = await projectRepository.listProjectsForTenant({ tenantId, user }).catch(() => []);
    return { names: new Map((projects ?? []).map((project) => [project.id, project.name])), projects: projects ?? [] };
  }

  async function requireChat(user, chatId) {
    const tenantId = primaryTenantId(user);
    const chat = await chatsRepository.get({ chatId, tenantId, userId: user.id });
    if (!chat) throw new HttpError(404, 'Chat not found.');
    return chat;
  }

  async function requireProjectAccess(user, tenantId, projectId) {
    if (!projectId) return;
    await requireProjectCapability({ capability: PROJECT_CAPABILITIES.READ, projectId, repository: projectRepository, tenantId, user });
  }

  async function present(chat, user) {
    const { names } = await projectNamesFor(chat.tenantId, user);
    return presentChat(chat, { projectNames: names, running: turnQueue.has(chat.id) });
  }

  // What the turn's notes say about the project and the user's standing in it.
  async function loadContext({ api, chat, pageContext, user }) {
    const workspaceRole = getTenantMembership(user, chat.tenantId)?.role ?? null;
    if (!chat.projectId) return { selectedItem: null, snapshot: null, standing: { workspaceRole } };
    const [{ permissions = null, project }, sprints] = await Promise.all([
      api.request('GET', `/api/projects/${encodeURIComponent(chat.projectId)}`),
      api.request('GET', `/api/projects/${encodeURIComponent(chat.projectId)}/sprints`).then((result) => result.sprints ?? []).catch(() => []),
    ]);
    const snapshot = buildProjectOverview(project, sprints);
    const selected = pageContext?.itemId ? flattenProjectItems(project).find((item) => item.id === pageContext.itemId) : null;
    return { selectedItem: selected ? compactItem(selected, { description: true }) : null, snapshot, standing: permissions ?? { workspaceRole } };
  }

  async function executeTurn({ abortSignal, allowWebResearch, attachments = [], chat, decision = null, pageContext = null, readOnly: readOnlyTurn = false, user }) {
    const tenantId = chat.tenantId;
    // An origin may keep its chats elsewhere, give the turn its own API in place of a session, and
    // narrow the tools to a filtered view of the catalog (a guest's turn in a channel). The loop,
    // checks, prompt and catalog are the same whatever started the turn.
    const origin = originOf(chat);
    const store = storeFor(chat);
    const readOnly = readOnlyTurn || Boolean(chat.origin?.readOnly);
    const emit = async (type, payload) => publish(chat.id, type, payload);
    const resuming = Boolean(decision);
    let session = null;
    let recorder = null;
    await notifyOrigin('onStart', chat);
    // What this turn changed, for the reply's undo (read once more for versions when it ends).
    const changesFor = async (records) => (records.length ? { records, status: 'applied', versions: await snapshotVersions({ api: session.api, records }).catch(() => ({})) } : null);
    try {
      const { client, model } = await modelResolver(tenantId);
      session = (await origin?.openSession?.(chat)) ?? await openSession({ tenantId, user });
      if (readOnly) session = { ...session, api: readOnlyApi(session.api) };
      const decisions = createAgentDecisions({ cacheKey: `odin-chat-${chat.id}`, client, enabled: config.decisionsEnabled, model: config.decisionsModel, timeoutMs: config.decisionsTimeoutMs });
      recorder = createChangeRecorder({ api: session.api, records: resuming ? chat.pending?.changes ?? [] : [] });
      // "Undo that" in chat: reverses an earlier reply's changes through this turn's recorder, so
      // the undo can itself be undone.
      const undoTurn = async ({ replyId = null } = {}) => {
        const current = await store.get({ chatId: chat.id, tenantId, userId: user.id });
        // Without a replyId, the latest reply that changed anything: never an older one behind it, which
        // the user didn't mean.
        const target = replyId
          ? current?.messages.find((message) => message.id === replyId && message.changes)
          : [...(current?.messages ?? [])].reverse().find((message) => message.changes?.records?.length);
        if (!target) return { ok: false, error: { code: 'nothing_to_undo', message: 'No earlier reply in this chat changed anything.' } };
        if (target.changes.status === 'undone') return { ok: false, error: { code: 'already_undone', message: 'Those changes were already undone.' } };
        // A partial or failed undo left some changes in place: say which, rather than "already undone".
        if (target.changes.status !== 'applied') return { ok: false, error: { code: 'undo_already_tried', message: `Undoing those changes was already tried: ${undoSummary(target.changes).replace(/\.$/, '')}. What is left can be changed in Odin.` } };
        if (!target.changes.records.some((record) => record.undoable)) {
          const labels = target.changes.records.map((record) => record.label).join('; ');
          return { ok: false, error: { code: 'not_undoable', message: `Nothing that reply changed can be undone here (${labels}). To undo an earlier reply, pass its replyId.` } };
        }
        target.changes = await undoChanges({ api: recorder.api, changes: target.changes });
        await store.save(current);
        return { ok: true, changes: target.changes.records.map(({ label, note, status }) => ({ label, status, ...(note ? { note } : {}) })), summary: undoSummary(target.changes) };
      };
      const toolbox = createAgentToolbox({ allow: origin?.allowedTools?.(chat) ?? null, api: recorder.api, projectId: chat.projectId, recorder, undoTurn });
      const userMessage = resuming ? null : [...chat.messages].reverse().find((message) => message.role === 'user');
      const cache = { key: promptCacheKeyFor(chat), retention: config.promptCacheRetention };
      const instructions = buildAgentInstructions({ allowWebResearch });
      const owner = { chatId: chat.id, tenantId, userId: user.id };
      // The transcript so far: every earlier turn, tool results included, caught up with any
      // messages it has not seen (older chats, failed or superseded turns).
      let transcript = resuming ? null : reconcileTranscript(await store.getTranscript(owner) ?? emptyTranscript(), chat.messages.slice(0, -1));
      // An origin may add images for the model to look at (the images of a channel post that
      // tagged @odin), read for this request and never stored in the chat.
      const originImages = resuming ? [] : await Promise.resolve(origin?.inputImages?.(chat)).catch(() => []) ?? [];
      const current = resuming ? null : currentUserInput(userMessage, [...attachments, ...originImages]);
      const input = resuming ? null : [...transcriptInput(transcript), current];
      const [triage, context] = await Promise.all([
        resuming
          ? Promise.resolve(chat.pending.triage ?? { change: true, multiStep: false, promoted: [], research: false, simple: false, source: 'resume' })
          : triageTurn({ abortSignal, decisions, evidence: decisionEvidence(input, { messages: 8, toolItems: 0 }), message: userMessage.content, toolbox }),
        loadContext({ api: session.api, chat, pageContext, user }),
      ]);
      // Full effort for anything that is not simple or needs several steps. A change right after
      // such a turn ("go ahead" to a proposal, the answer to the assistant's question) carries that
      // work on at the same effort: short, it read as simple, and at the lower effort the model
      // left a launch it had found late where it was.
      const complex = (verdict) => !verdict.simple || Boolean(verdict.multiStep);
      const carriesOn = triage.change && chat.run?.previousTriage && complex(chat.run.previousTriage);
      const reasoningEffort = complex(triage) || carriesOn ? config.reasoningComplex : config.reasoningSimple;
      await emit('intent.identified', { change: triage.change, multiStep: triage.multiStep, reasoningEffort, simple: triage.simple, source: triage.source });

      // The turn's notes go just before the user's message, after the conversation, so the fixed
      // instructions, the fixed tool list and the earlier conversation stay a cached prefix.
      const notes = resuming ? null : {
        content: withOriginNotes(chat, buildTurnContext({
          budget: { perTask: config.toolCallsPerTask, pool: Math.min(config.maxToolCalls, config.toolCallsPerTask) },
          pageContext,
          projectSnapshot: context.snapshot,
          promoted: toolbox.brief(triage.promoted ?? []),
          selectedItem: context.selectedItem,
          standing: context.standing,
          triage,
          user,
        })),
        role: 'developer',
      };
      // Past the compaction budget, older turns are condensed before the turn runs.
      let compaction = null;
      if (!resuming) {
        const fixed = estimateTokens(instructions) + estimateTokens([...toolbox.toolNames(), ...toolbox.localToolNames()].map((name) => toolbox.definition(name)));
        const plan = planCompaction(transcript, { budgetTokens: config.compactAtTokens, reserveTokens: fixed + estimateTokens(notes.content) + estimateTokens(withoutMedia([current])[0]) + IMAGE_TOKENS * imageCount(current) });
        if (plan) {
          const callId = `compact-${randomUUID()}`;
          await emit('tool.started', { callId, label: 'Condensing the earlier conversation', name: 'compact_conversation' });
          try {
            const condensed = await compactTranscript({ abortSignal, cache, client, model, plan, reasoningEffort: config.reasoningSimple, transcript });
            transcript = condensed.transcript;
            compaction = { callId, label: `Condensed ${plan.condense.length} earlier ${plan.condense.length === 1 ? 'turn' : 'turns'} of the conversation`, name: 'compact_conversation', ok: true, usage: condensed.usage };
          } catch (error) {
            if (abortSignal?.aborted) throw error;
            compaction = { callId, error: String(error?.message ?? 'Failed').slice(0, 300), label: 'Could not condense the earlier conversation', name: 'compact_conversation', ok: false };
          }
          await emit('tool.completed', { callId, label: compaction.label, name: compaction.name, ok: compaction.ok });
        }
        // Saved now, so a turn that pauses for confirmation resumes onto an up-to-date transcript.
        await store.saveTranscript({ ...owner, transcript });
      }
      const state = resuming
        ? chat.pending.state
        : { ...createTurnState({ input: [...transcriptInput(transcript), notes, current], maxToolCalls: config.maxToolCalls, toolCallsPerTask: config.toolCallsPerTask, toolNames: toolbox.toolNames() }), turnStart: transcriptInput(transcript).length };
      const result = await runAgentTurn({
        abortSignal,
        allowWebResearch,
        checks: decisions.enabled ? decisions : null,
        client,
        emit,
        instructions,
        logContext: { chatId: chat.id },
        maxOutputTokens: config.maxOutputTokens,
        model,
        promptCacheKey: cache.key,
        promptCacheRetention: cache.retention,
        readOnly,
        reasoningEffort,
        resume: resuming ? { approved: decision === 'approve', args: chat.pending.args, callId: chat.pending.callId, name: chat.pending.name } : null,
        state,
        toolbox,
        // A turn that asks for changes only holds writes that look plainly unrelated.
        writeCheckThreshold: triage.change ? config.writeCheckThresholdOnChange : config.writeCheckThreshold,
      });

      const fresh = await store.get({ chatId: chat.id, tenantId, userId: user.id }) ?? chat;
      const createdProject = result.writes.find((write) => write.name === 'odin_create_project' && write.result?.project?.id)?.result.project;
      if (createdProject && !fresh.projectId) fresh.projectId = createdProject.id;
      if (fresh.titleSource === 'auto' && !resuming && fresh.messages.filter((message) => message.role === 'user').length === 1) {
        fresh.title = titleFromMessage(userMessage.content);
      }
      const replyId = randomUUID();
      fresh.messages.push({
        activity: [...(compaction ? [{ callId: compaction.callId, label: compaction.label, name: compaction.name, ok: compaction.ok, ...(compaction.error ? { error: compaction.error } : {}) }] : []), ...result.activity],
        citations: result.citations,
        confirmation: result.pending ? { args: result.pending.args, callId: result.pending.callId, description: result.pending.description, label: result.pending.label, name: result.pending.name, status: 'pending', target: result.pending.target ?? '' } : null,
        content: normalizeAgentMarkdown(result.text),
        createdAt: nowIso(),
        id: replyId,
        plan: result.plan ?? null,
        role: 'assistant',
        ...(result.pending ? {} : { changes: await changesFor(recorder.records()) }),
      });
      // A finished turn joins the transcript: the user's message, tool calls and results, reply.
      if (!result.pending) {
        const base = resuming ? (await store.getTranscript(owner) ?? emptyTranscript()) : transcript;
        // The turn's notes stay too: dropping them would change the conversation the next turn
        // sends at that point, and lose the cached prefix from there on.
        const [notesItem, ...turnItems] = result.state.input.slice(result.state.turnStart ?? result.state.input.length);
        const items = [...(notesItem?.role === 'developer' ? [{ content: String(notesItem.content), role: 'developer' }] : []), ...keptItems(turnItems)];
        await store.saveTranscript({ ...owner, transcript: { ...base, coveredThrough: replyId, turns: [...base.turns, { id: replyId, items }] } });
      }
      // A paused turn keeps its input to resume from, with images and PDFs as placeholders.
      fresh.pending = result.pending ? { ...result.pending, changes: recorder.records(), state: { ...result.state, input: withoutMedia(result.state.input) }, triage } : null;
      fresh.run = {
        budget: { pool: result.state.budget.pool, used: result.state.budget.used },
        completedAt: nowIso(),
        id: chat.run?.id ?? randomUUID(),
        model,
        reasoningEffort,
        startedAt: chat.run?.startedAt ?? nowIso(),
        status: result.pending ? 'awaiting_confirmation' : 'completed',
        triage: { change: triage.change, multiStep: triage.multiStep, probabilities: triage.probabilities ?? null, promoted: triage.promoted ?? [], simple: triage.simple, source: triage.source, visuals: triage.visuals ?? [] },
        usage: result.usage,
      };
      fresh.updatedAt = nowIso();
      const saved = await store.save(fresh);
      invalidateList(saved, 'turn-completed');
      // The first request has its answer (after a confirmation, if it needed one): name the chat
      // from the two, in the background.
      const requests = saved.messages.filter((message) => message.role === 'user');
      const reply = saved.messages.at(-1);
      if (config.chatTitles && saved.titleSource === 'auto' && !result.pending && requests.length === 1 && reply?.content) {
        void nameChat({ chat: saved, client, request: requests[0].content, response: reply.content });
      }
      console.info('Assistant turn usage.', { cachedTokens: result.usage.cachedTokens, chatId: chat.id, compacted: Boolean(compaction?.ok), inputTokens: result.usage.inputTokens, model, outputTokens: result.usage.outputTokens, steps: result.usage.steps, toolCalls: result.state.budget.used });
      await emit('turn.completed', { chat: presentChat(saved, { projectNames: (await projectNamesFor(tenantId, user)).names, running: true }) });
      await notifyOrigin('onSettled', saved);
      return saved;
    } catch (error) {
      const cancelled = abortSignal?.aborted && !error?.assistantTurnTimeout && !abortSignal.reason?.assistantTurnTimeout;
      const fresh = await store.get({ chatId: chat.id, tenantId, userId: user.id }).catch(() => null) ?? chat;
      const message = friendlyModelError(abortSignal?.reason?.assistantTurnTimeout ? abortSignal.reason : error);
      // Changes made before the failure can still be undone from the error reply.
      const partial = recorder && session ? await changesFor(recorder.records()).catch(() => null) : null;
      if (!cancelled || partial) fresh.messages.push({ content: '', createdAt: nowIso(), error: cancelled ? 'Stopped.' : message, id: randomUUID(), role: 'assistant', ...(partial ? { changes: partial } : {}) });
      fresh.run = { ...(chat.run ?? {}), completedAt: nowIso(), error: cancelled ? null : message, status: cancelled ? 'cancelled' : 'failed' };
      fresh.pending = null;
      fresh.updatedAt = nowIso();
      const saved = await store.save(fresh).catch(() => fresh);
      invalidateList(saved, cancelled ? 'turn-cancelled' : 'turn-failed');
      await emit(cancelled ? 'turn.cancelled' : 'turn.failed', { chat: presentChat(saved, { running: true }), error: cancelled ? null : message });
      if (!cancelled) console.error('Assistant turn failed.', { chatId: chat.id, error: error?.message });
      await notifyOrigin('onSettled', saved);
      return saved;
    } finally {
      await session?.close();
    }
  }

  // Undo, a new message and a confirmation each read the chat, change it and save it. They run one
  // at a time per chat, so two undos (or an undo and a message) can't overwrite each other.
  const chatLocks = new Map();
  function oneAtATime(chatId, work) {
    const run = (chatLocks.get(chatId) ?? Promise.resolve()).then(work);
    const settled = run.catch(() => {});
    chatLocks.set(chatId, settled);
    settled.then(() => { if (chatLocks.get(chatId) === settled) chatLocks.delete(chatId); });
    return run;
  }

  // An origin chat's turns stop after its time limit, as a turn that took too long.
  function withTimeLimit(abortSignal, timeoutMs) {
    if (!(timeoutMs > 0)) return { done: () => {}, signal: abortSignal };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(Object.assign(new Error(`Assistant turn timed out after ${timeoutMs}ms.`), { assistantTurnTimeout: true, code: 'assistant_turn_timeout' })), timeoutMs);
    timer.unref?.();
    return { done: () => clearTimeout(timer), signal: abortSignal ? AbortSignal.any([abortSignal, controller.signal]) : controller.signal };
  }

  function enqueue(chat, work, { durable = null } = {}) {
    if (turnQueue.has(chat.id)) throw new HttpError(409, 'The assistant is already working on this chat.');
    const timeoutMs = Number(chat.origin?.timeoutMs ?? 0);
    const queued = turnQueue.enqueue({
      durable,
      run: async ({ abortSignal }) => {
        const limit = withTimeLimit(abortSignal, timeoutMs);
        try {
          return await work(limit.signal);
        } finally {
          limit.done();
        }
      },
      sessionId: chat.id,
    });
    if (!queued.queued) throw new HttpError(409, 'The assistant is already working on this chat.');
    return queued.job;
  }

  return {
    // Hooks for chats that another surface starts (startOriginTurn): { onStart, onSettled, onChanged }.
    registerOrigin(type, handlers) {
      origins.set(type, handlers);
    },

    // A one-turn chat for another surface, such as a post that tags @odin: the message, the
    // surface's own notes for the turn (origin.notes), an optional time limit (origin.timeoutMs),
    // read-only (origin.readOnly) and an optional durable run, so a restart is noticed. It is
    // kept out of the chat list. Returns the saved chat; the turn runs in the turn queue through
    // executeTurn, as every AI Workspace turn does.
    async startOriginTurn({ chatId = randomUUID(), durable = null, message, origin, projectId, title = '', user }) {
      const tenantId = primaryTenantId(user);
      // A guest has no project role: their turn's API answers only for their own channels.
      if (origin.audience !== 'guest') await requireProjectAccess(user, tenantId, projectId);
      const chat = await storeFor({ origin }).save({
        createdAt: nowIso(), id: chatId, messages: [{ content: message, createdAt: nowIso(), id: randomUUID(), role: 'user' }],
        origin, projectId, run: { id: randomUUID(), startedAt: nowIso(), status: 'running' }, settings: { allowWebResearch: false }, tenantId,
        title: clip(title, 120) || titleFromMessage(message), titleSource: 'user', updatedAt: nowIso(), userId: user.id,
      });
      enqueue(chat, (abortSignal) => executeTurn({ abortSignal, allowWebResearch: false, chat, user }), { durable });
      return chat;
    },

    async getOriginChat({ chatId, tenantId, userId }) {
      return chatsRepository.get({ chatId, tenantId, userId });
    },

    async listChats({ user }) {
      const tenantId = primaryTenantId(user);
      const [chats, { names, projects }] = await Promise.all([chatsRepository.list({ tenantId, userId: user.id }), projectNamesFor(tenantId, user)]);
      const groups = new Map();
      const general = [];
      for (const chat of chats.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))) {
        if (chat.origin?.type) continue;
        const summary = chatSummary(chat, turnQueue.has(chat.id));
        if (!chat.projectId) { general.push(summary); continue; }
        if (!names.has(chat.projectId)) continue;
        const group = groups.get(chat.projectId) ?? { chats: [], projectId: chat.projectId, projectName: names.get(chat.projectId), updatedAt: chat.updatedAt };
        group.chats.push(summary);
        groups.set(chat.projectId, group);
      }
      return {
        general,
        ok: true,
        projects: [...groups.values()].sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt))),
        projectsAvailable: projects.map((project) => ({ id: project.id, name: project.name })).sort((left, right) => left.name.localeCompare(right.name)),
      };
    },

    async getChat({ chatId, user }) {
      return { chat: await present(await requireChat(user, chatId), user), ok: true };
    },

    async createChat({ projectId = null, user }) {
      const tenantId = primaryTenantId(user);
      await requireProjectAccess(user, tenantId, projectId);
      const chat = await chatsRepository.save({ createdAt: nowIso(), id: randomUUID(), messages: [], projectId, tenantId, title: '', titleSource: 'auto', updatedAt: nowIso(), userId: user.id });
      invalidateList(chat, 'chat-created');
      return { chat: await present(chat, user), ok: true };
    },

    async updateChat({ chatId, input, user }) {
      const chat = await requireChat(user, chatId);
      if (input.title !== undefined) { chat.title = clip(input.title, 120); chat.titleSource = 'user'; }
      if (input.allowWebResearch !== undefined) chat.settings = { ...chat.settings, allowWebResearch: Boolean(input.allowWebResearch) };
      chat.updatedAt = nowIso();
      const saved = await chatsRepository.save(chat);
      invalidateList(saved, 'chat-updated');
      return { chat: await present(saved, user), ok: true };
    },

    async deleteChat({ chatId, user }) {
      const chat = await requireChat(user, chatId);
      turnQueue.cancel(chat.id);
      await chatsRepository.remove({ chatId, tenantId: chat.tenantId, userId: user.id });
      invalidateList(chat, 'chat-deleted');
      publish(chat.id, 'assistant.session.deleted', {});
      return { ok: true };
    },

    sendMessage({ chatId, input, user }) {
      return oneAtATime(chatId, async () => {
        const chat = await requireChat(user, chatId);
        if (chat.origin?.type) throw new HttpError(409, 'This conversation belongs to a channel thread. Tag @Odin there to ask again.', { details: { code: 'origin_chat' } });
        if (turnQueue.has(chat.id)) throw new HttpError(409, 'The assistant is already working on this chat.');
        await requireProjectAccess(user, chat.tenantId, chat.projectId);
        if (chat.run?.status === 'running') chat.messages.push(interruptedReply(chat.run));
        // A new message supersedes an action that was waiting for confirmation.
        if (chat.pending) {
          const waiting = chat.messages.find((message) => message.confirmation?.callId === chat.pending.callId);
          if (waiting) waiting.confirmation.status = 'skipped';
          chat.pending = null;
        }
        const attachments = input.attachments ?? [];
        const message = {
          attachments: attachments.map((file) => ({ mimeType: file.mimeType, name: file.name, size: file.size ?? null, ...(file.text ? { text: file.text.slice(0, ATTACHMENT_TEXT_LIMIT) } : {}) })),
          content: input.message,
          createdAt: nowIso(),
          id: randomUUID(),
          role: 'user',
        };
        chat.messages.push(message);
        if (input.allowWebResearch !== undefined) chat.settings = { ...chat.settings, allowWebResearch: Boolean(input.allowWebResearch) };
        const previous = chat.run?.status === 'completed' && chat.run.triage ? { change: Boolean(chat.run.triage.change), multiStep: Boolean(chat.run.triage.multiStep), simple: Boolean(chat.run.triage.simple) } : null;
        chat.run = { id: randomUUID(), startedAt: nowIso(), status: 'running', ...(previous ? { previousTriage: previous } : {}) };
        chat.updatedAt = nowIso();
        const saved = await chatsRepository.save(chat);
        invalidateList(saved, 'turn-started');
        const job = enqueue(saved, (abortSignal) => executeTurn({ abortSignal, allowWebResearch: saved.settings.allowWebResearch, attachments, chat: saved, pageContext: input.pageContext ?? null, user }));
        publish(saved.id, 'turn.started', { message: presentChat(saved).messages.at(-1), runId: saved.run.id });
        return { chat: await present(saved, user), job, ok: true };
      });
    },

    // Reverses what one reply changed in Odin, as the user, leaving anything changed since alone.
    undoChanges({ chatId, messageId, user }) {
      return oneAtATime(chatId, async () => {
        const chat = await requireChat(user, chatId);
        if (turnQueue.has(chat.id)) throw new HttpError(409, 'Wait for the assistant to finish before undoing.');
        const message = chat.messages.find((entry) => entry.id === messageId && entry.changes);
        if (!message) throw new HttpError(404, 'Those changes were not found.');
        if (message.changes.status !== 'applied') throw new HttpError(409, 'Those changes were already undone.');
        const session = await openSession({ tenantId: chat.tenantId, user });
        try {
          message.changes = await undoChanges({ api: session.api, changes: message.changes });
        } finally {
          await session.close();
        }
        const undone = message.changes.records.filter((record) => record.status === 'undone');
        chat.messages.push({ activity: [], content: `${undoSummary(message.changes)}${undone.length ? `\n\n${undone.map((record) => `- ${record.label}`).join('\n')}` : ''}`, createdAt: nowIso(), id: randomUUID(), role: 'assistant', undoOf: messageId });
        chat.updatedAt = nowIso();
        const saved = await chatsRepository.save(chat);
        invalidateList(saved, 'changes-undone');
        await notifyOrigin('onChanged', saved);
        return { chat: await present(saved, user), ok: true };
      });
    },

    resolveConfirmation({ chatId, input, user }) {
      return oneAtATime(chatId, async () => {
        const chat = await requireChat(user, chatId);
        if (!chat.pending || chat.pending.callId !== input.callId) throw new HttpError(409, 'That action is no longer waiting for confirmation.');
        const waiting = chat.messages.find((message) => message.confirmation?.callId === input.callId);
        if (waiting) waiting.confirmation.status = input.decision === 'approve' ? 'approved' : 'declined';
        chat.run = { id: randomUUID(), startedAt: nowIso(), status: 'running' };
        chat.updatedAt = nowIso();
        const saved = await chatsRepository.save(chat);
        const job = enqueue(saved, (abortSignal) => executeTurn({ abortSignal, allowWebResearch: saved.settings.allowWebResearch, chat: saved, decision: input.decision, pageContext: input.pageContext ?? null, user }));
        publish(saved.id, 'turn.started', { resume: true, runId: saved.run.id });
        return { chat: await present(saved, user), job, ok: true };
      });
    },

    async cancelTurn({ chatId, user }) {
      const chat = await requireChat(user, chatId);
      turnQueue.cancel(chat.id);
      return { ok: true };
    },

    // Proposed work from a Requirements plan, staged in a chat for the proposer to apply. New
    // epics apply as a branch with their stories; stories under existing epics apply one by one.
    async stageWorkItems({ chatId = null, epics = [], message = '', projectId, rationale = '', stories = [], title = '', user, withdrawItemIds = [] }) {
      const tenantId = primaryTenantId(user);
      await requireProjectCapability({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectId, repository: projectRepository, tenantId, user });
      let chat = chatId ? await chatsRepository.get({ chatId, tenantId, userId: user.id }) : null;
      if (chat && chat.projectId !== projectId) chat = null;
      chat ??= { createdAt: nowIso(), id: randomUUID(), messages: [], projectId, tenantId, title: clip(title, 120) || 'Proposed work', titleSource: 'auto', userId: user.id };
      const withdrawn = new Set(withdrawItemIds);
      for (const entry of chat.messages) {
        for (const item of entry.proposal?.items ?? []) if (item.status === 'pending' && withdrawn.has(item.id)) item.status = 'withdrawn';
        if (entry.proposal) entry.proposal.status = proposalStatus(entry.proposal.items);
      }
      const items = [
        ...epics.map((epic) => ({ detail: `${(epic.stories ?? []).length} ${(epic.stories ?? []).length === 1 ? 'story' : 'stories'}`, id: randomUUID(), kind: 'epic', label: epic.name, payload: { node: epic }, status: 'pending', targetId: epic.id })),
        ...stories.map(({ node, parentId }) => ({ detail: 'Story under an existing epic', id: randomUUID(), kind: 'story', label: node.name, parentId, payload: { node }, status: 'pending', targetId: node.id })),
      ];
      chat.messages.push({ content: message, createdAt: nowIso(), id: randomUUID(), proposal: { id: randomUUID(), items, rationale, source: 'requirements-plan', status: 'pending', title }, role: 'assistant' });
      chat.updatedAt = nowIso();
      const saved = await chatsRepository.save(chat);
      invalidateList(saved, 'proposal-staged');
      publish(saved.id, 'assistant.session.invalidated', {});
      return { actions: items.map((item) => ({ id: item.id, targetId: item.targetId })), session: { id: saved.id } };
    },

    // A Home recovery proposal, staged once per proposal in a chat on its project.
    async stageRecovery({ action, message = '', projectId, rationale = '', title = '', user }) {
      const tenantId = primaryTenantId(user);
      await requireProjectCapability({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectId, repository: projectRepository, tenantId, user });
      const chats = await chatsRepository.list({ tenantId, userId: user.id });
      const homeProposalId = action.origin?.homeProposalId;
      const existing = chats.find((chat) => chat.projectId === projectId && chat.messages.some((entry) => (entry.proposal?.items ?? []).some((item) => item.status === 'pending' && item.payload?.origin?.homeProposalId === homeProposalId)));
      if (existing) return { chatId: existing.id, reused: true };
      const chat = { createdAt: nowIso(), id: randomUUID(), messages: [], projectId, tenantId, title: clip(title, 120) || 'Recovery proposal', titleSource: 'auto', userId: user.id };
      chat.messages.push({
        content: message,
        createdAt: nowIso(),
        id: randomUUID(),
        proposal: { id: randomUUID(), items: [{ detail: action.rationaleSummary ?? '', id: randomUUID(), kind: 'recovery', label: action.name, payload: { ...action, id: action.id ?? randomUUID() }, status: 'pending' }], rationale, source: 'home-recovery', status: 'pending', title },
        role: 'assistant',
      });
      chat.updatedAt = nowIso();
      const saved = await chatsRepository.save(chat);
      invalidateList(saved, 'proposal-staged');
      return { chatId: saved.id, reused: false };
    },

    async resolveProposal({ chatId, input, user }) {
      const chat = await requireChat(user, chatId);
      const entry = chat.messages.find((message) => message.proposal?.id === input.proposalId);
      if (!entry) throw new HttpError(404, 'Proposal not found.');
      const wanted = input.itemIds?.length ? new Set(input.itemIds) : null;
      const targets = entry.proposal.items.filter((item) => item.status === 'pending' && (!wanted || wanted.has(item.id)));
      if (!targets.length) throw new HttpError(409, 'Nothing in this proposal is waiting to be applied.');
      if (input.decision === 'dismiss') {
        for (const item of targets) item.status = 'dismissed';
      } else {
        await requireProjectCapability({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectId: chat.projectId, repository: projectRepository, tenantId: chat.tenantId, user });
        const session = targets.some((item) => item.kind !== 'recovery') ? await openSession({ tenantId: chat.tenantId, user }) : null;
        try {
          for (const item of targets) {
            try {
              await applyProposalItem({ api: session?.api, chat, item, user });
              item.status = 'applied';
              item.error = null;
            } catch (error) {
              item.status = 'failed';
              item.error = clip(error?.message ?? 'Could not apply.', 300);
            }
          }
        } finally {
          await session?.close();
        }
      }
      entry.proposal.status = proposalStatus(entry.proposal.items);
      chat.updatedAt = nowIso();
      const saved = await chatsRepository.save(chat);
      invalidateList(saved, 'proposal-resolved');
      const presented = await present(saved, user);
      publish(saved.id, 'assistant.session.invalidated', {});
      return { chat: presented, ok: true };
    },

    // A durable goal run: a new chat on the goal's project, one turn with the goal as the message,
    // named for the goal. It runs unattended, so it changes nothing unless readOnly is false, and
    // searches the web only when the goal's owner allowed it.
    async runGoalTurn({ abortSignal = null, allowWebResearch = false, message, projectId = null, readOnly, title = '', user }) {
      const tenantId = primaryTenantId(user);
      const named = clip(title, 120);
      const webResearch = allowWebResearch === true;
      const chat = await chatsRepository.save({
        createdAt: nowIso(), id: randomUUID(), messages: [{ content: message, createdAt: nowIso(), id: randomUUID(), role: 'user' }],
        projectId, run: { id: randomUUID(), startedAt: nowIso(), status: 'running' }, settings: { allowWebResearch: webResearch }, tenantId, title: named || 'Goal run', titleSource: named ? 'user' : 'auto', updatedAt: nowIso(), userId: user.id,
      });
      const saved = await executeTurn({ abortSignal, allowWebResearch: webResearch, chat, readOnly: readOnly !== false, user });
      if (saved.run?.status === 'failed') throw new Error(saved.run.error ?? 'Goal run failed.');
      return { chatId: saved.id, status: saved.run?.status ?? 'completed' };
    },
  };

  async function applyProposalItem({ api, chat, item, user }) {
    const projectPath = `/api/projects/${encodeURIComponent(chat.projectId)}`;
    if (item.kind === 'recovery') {
      await applyRecoveryActions({ actions: [item.payload], domainEventOutboxRepository, governanceRepository, projectId: chat.projectId, projectRepository, tenantId: chat.tenantId, user });
      return;
    }
    const toItem = (node) => ({ description: node.description ?? '', id: node.id, name: node.name, sourceClarificationIds: node.sourceClarificationIds ?? [], status: node.status ?? 'Not Started' });
    if (item.kind === 'epic') {
      const { item: epic } = await api.request('POST', `${projectPath}/items`, { body: { item: toItem(item.payload.node), itemType: 'epic', parentId: null } });
      for (const story of item.payload.node.stories ?? []) {
        await api.request('POST', `${projectPath}/items`, { body: { item: toItem(story), itemType: 'story', parentId: epic.id } });
      }
      return;
    }
    await api.request('POST', `${projectPath}/items`, { body: { item: toItem(item.payload.node), itemType: 'story', parentId: item.parentId } });
  }
}
