<script setup>
import { computed, nextTick, onBeforeUnmount, provide, reactive, ref, shallowRef, useId, watch } from 'vue';

import { useAttachmentTray } from '../../lib/channels/attachment-tray.js';
import { POST_FILES_KEY, dragHasFiles } from '../../lib/channels/attachments.js';
import { useChannelApi } from '../../lib/channels/channel-api.js';
import { appendOlder, channelErrorMessage, hasPost, loadUntilPost, threadOdinReplying, upsertPost } from '../../lib/channels/channels.js';
import { END_THRESHOLD_PX, distanceFromEnd, nextFollow } from '../../lib/channels/follow-end.js';
import { toggledReactions, withReactions } from '../../lib/channels/reactions.js';
import { createTypingLiveUpdates, createTypingSender, createTypingTracker, supportsTyping, typingLabelFor } from '../../lib/channels/typing.js';
import { fileToBase64, MAX_FILE_BYTES } from '../../lib/projects/project-files.js';
import { sendLargeUpload } from '../../lib/projects/large-upload.js';
import RequirementsCommentEditor from '../requirements/RequirementsCommentEditor.vue';
import RequirementsConfirmDialog from '../requirements/RequirementsConfirmDialog.vue';
import AttachmentTray from './AttachmentTray.vue';
import ChannelPost from './ChannelPost.vue';
import PollComposerDialog from './PollComposerDialog.vue';

// The app's API for members; the guest view provides the guest API (lib/channels/channel-api.js).
const api = useChannelApi();

// A channel's conversation: messages oldest at the top, newest at the bottom, with earlier ones
// a page at a time, and the box to write one. Files attached to a message upload into the
// channel's library first. Someone else's message arrives through `liveVersion`; this tab's own
// show from the reply to the save, never twice. Odin's answers to @odin arrive the same way.
const props = defineProps({
  channel: { required: true, type: Object },
  // Odin Chat: fill the height it is given, messages scrolling above a box pinned to the bottom.
  fill: { default: false, type: Boolean },
  focusPostId: { default: '', type: String },
  // 'conversation' for a direct message in Odin Chat: the same screen, worded for one.
  kind: { default: 'channel', type: String },
  // Moves when someone else changed this channel's posts.
  liveVersion: { default: 0, type: Number },
  projectId: { required: true, type: String },
  // Text to start the box with, such as "@Odin add a task: " from the Tasks tab.
  seedDraft: { default: '', type: String },
  token: { default: '', type: String },
});

const emit = defineEmits(['open-file', 'read']);

const PAGE = 30;
const uid = useId();
const posts = ref([]);
const nextCursor = ref(null);
const loading = ref(false);
const loadingOlder = ref(false);
const loadError = ref('');
const actionError = ref('');
const draft = ref('');
const sending = ref(false);
const sendProgress = ref('');
const replyingToId = ref('');
// The reply the open reply form answers (replyToId), and a message briefly marked after its quote
// was pressed.
const replyQuoteId = ref('');
const flashId = ref('');
let flashTimer = 0;
const editingId = ref('');
const busyId = ref('');
const scroller = ref(null);
const composer = ref(null);
const fileInput = ref(null);
const removal = reactive({ busy: false, error: '', post: null });
// What the server allows for uploads: in parts up to maxUploadBytes, or base64 up to 15 MB.
const uploads = reactive({ loaded: false, maxBytes: MAX_FILE_BYTES, parts: false });
const maxFileBytes = () => (uploads.parts ? uploads.maxBytes : MAX_FILE_BYTES);
const tray = useAttachmentTray({ maxBytes: maxFileBytes, onError: (message) => { actionError.value = message; } });
const attachments = tray.entries;

const shown = computed(() => [...posts.value].reverse());
const canPost = computed(() => Boolean(props.channel?.canPost));
const isConversation = computed(() => props.kind === 'conversation');
// The files in posts preview and download through this conversation (PostAttachments.vue).
provide(POST_FILES_KEY, {
  libraryLink: () => !isConversation.value,
  liveVersion: () => props.liveVersion,
  projectId: () => props.projectId,
  token: () => props.token,
});
const placeholder = computed(() => (isConversation.value ? `Message ${props.channel.name}. Type @ to tag someone.` : `Message #${props.channel.name}. Type @ to tag someone.`));
// One form at a time: the box at the bottom steps aside while a reply or an edit is open.
const composerOpen = computed(() => canPost.value && !replyingToId.value && !editingId.value);
// A new function when the channel's Odin switch changes, so the boxes ask who to offer again.
const mentionables = computed(() => {
  const channelId = props.channel.id;
  void props.channel.odinEnabled;
  // Asked once per channel: each reply box, and the tag a reply starts with, use the same list.
  let people = null;
  return () => {
    people ??= api.passive.listChannelMentionables(props.projectId, channelId, props.token)
      .then((result) => result.people ?? [])
      .catch((error) => { people = null; throw error; });
    return people;
  };
});
let loadRun = 0;

// While the reader is at the newest message, the list follows it, also while that message
// finishes laying out (images, link previews, polls, diagrams, fonts): the ResizeObserver moves
// the list again each time the content grows. Only scrolling up to read stops it
// (lib/channels/follow-end.js says why a scroll event alone is not enough).
const list = ref(null);
const stickToEnd = ref(true);
// The scroll position after the last scroll event or the last move to the end.
let lastTop = 0;
const atEnd = (element) => distanceFromEnd(element) <= END_THRESHOLD_PX;
const followEnd = () => {
  const element = scroller.value;
  if (!stickToEnd.value || !element) return;
  element.scrollTop = element.scrollHeight;
  lastTop = element.scrollTop;
};
const resizes = typeof ResizeObserver === 'function' ? new ResizeObserver(followEnd) : null;
watch(list, (element, previous) => {
  if (previous) resizes?.unobserve(previous);
  if (element) resizes?.observe(element);
});
watch(scroller, (element, previous) => {
  if (previous) resizes?.unobserve(previous);
  if (element) resizes?.observe(element);
});
onBeforeUnmount(() => resizes?.disconnect());

function onScroll() {
  const element = scroller.value;
  if (!element) return;
  stickToEnd.value = nextFollow({ clientHeight: element.clientHeight, follow: stickToEnd.value, previousTop: lastTop, scrollHeight: element.scrollHeight, scrollTop: element.scrollTop });
  lastTop = element.scrollTop;
}

function scrollToEnd() {
  stickToEnd.value = true;
  nextTick(followEnd);
}

async function focusPost(postId) {
  stickToEnd.value = false;
  await nextTick();
  globalThis.document?.getElementById(`channel-post-${postId}`)?.scrollIntoView?.({ block: 'center' });
}

// A link to a message (?post=) opens on it. One older than the loaded pages loads them first.
const REVEAL_PAGE = 100;
async function revealPost(postId) {
  const channelId = props.channel.id;
  if (!hasPost(posts.value, postId) && nextCursor.value && !loadingOlder.value) {
    loadingOlder.value = true;
    try {
      const fetchOlder = (before) => api.passive.listChannelPosts(props.projectId, channelId, { before, limit: REVEAL_PAGE }, props.token);
      const result = await loadUntilPost({ cursor: nextCursor.value, fetchOlder, postId, posts: posts.value });
      if (channelId !== props.channel.id) return;
      posts.value = appendOlder(posts.value, result.posts);
      nextCursor.value = result.nextCursor;
    } catch {
      // The newest messages stay, and "Show earlier messages" still works.
    } finally {
      loadingOlder.value = false;
    }
  }
  await focusPost(postId);
}

// Only a conversation in front of the reader reads it. A background tab, or a window behind another
// app, keeps its notifications and the "(1)" in the title until the reader comes back to it.
let readPending = false;
function inFront() {
  const doc = globalThis.document;
  return !doc || (!doc.hidden && (typeof doc.hasFocus !== 'function' || doc.hasFocus()));
}
function readOnReturn() {
  if (readPending) void markRead();
}
globalThis.window?.addEventListener('focus', readOnReturn);
globalThis.document?.addEventListener('visibilitychange', readOnReturn);
onBeforeUnmount(() => {
  globalThis.window?.removeEventListener('focus', readOnReturn);
  globalThis.document?.removeEventListener('visibilitychange', readOnReturn);
});

async function markRead() {
  if (!inFront()) {
    readPending = true;
    return;
  }
  readPending = false;
  try {
    await api.passive.markChannelRead(props.projectId, props.channel.id, props.token);
    emit('read', props.channel.id);
  } catch {
    // The count stays until the next visit.
  }
}

// `quiet` reloads after someone else's change: every loaded message again, keeping the list on failure.
async function load({ quiet = false } = {}) {
  const run = ++loadRun;
  if (!quiet) {
    loading.value = true;
    loadError.value = '';
  }
  // Following, not only "near the end now": the newest message may still be growing.
  const wasAtEnd = stickToEnd.value || !scroller.value || atEnd(scroller.value);
  try {
    const client = quiet ? api.passive : api;
    const result = await client.listChannelPosts(props.projectId, props.channel.id, { limit: Math.min(200, Math.max(PAGE, posts.value.length)) }, props.token);
    if (run !== loadRun) return;
    posts.value = result.posts ?? [];
    nextCursor.value = result.nextCursor ?? null;
    // A link to a message opens on it; otherwise the newest message shows.
    if (!quiet && props.focusPostId) void revealPost(props.focusPostId);
    else if (!quiet || wasAtEnd) scrollToEnd();
    void markRead();
  } catch (error) {
    if (run === loadRun && !quiet) loadError.value = channelErrorMessage(error, 'The conversation could not load.');
  } finally {
    if (run === loadRun) loading.value = false;
  }
}

async function loadOlder() {
  if (!nextCursor.value || loadingOlder.value) return;
  loadingOlder.value = true;
  const element = scroller.value;
  const fromBottom = element ? element.scrollHeight - element.scrollTop : 0;
  try {
    const result = await api.listChannelPosts(props.projectId, props.channel.id, { before: nextCursor.value }, props.token);
    posts.value = appendOlder(posts.value, result.posts ?? []);
    nextCursor.value = result.nextCursor ?? null;
    // Keep the reader where they were.
    await nextTick();
    if (element) element.scrollTop = element.scrollHeight - fromBottom;
  } catch (error) {
    actionError.value = channelErrorMessage(error, 'Earlier messages could not load.');
  } finally {
    loadingOlder.value = false;
  }
}

async function loadUploadLimits() {
  if (uploads.loaded) return;
  try {
    const storage = await api.passive.getFileStorage(props.projectId, props.token);
    Object.assign(uploads, { loaded: true, maxBytes: Number(storage.maxUploadBytes ?? MAX_FILE_BYTES), parts: storage.uploadsByParts === true });
  } catch {
    uploads.loaded = true;
  }
}

function pickFiles(event) {
  const picked = [...(event.target.files ?? [])];
  event.target.value = '';
  addFiles(picked);
}

function addFiles(picked) {
  actionError.value = '';
  tray.add(picked);
}

function onPaste(event) {
  if (sending.value) return;
  actionError.value = '';
  tray.takePaste(event);
}

const dropping = ref(false);
function onDragOver(event) {
  if (!dragHasFiles(event.dataTransfer) || sending.value) return;
  event.preventDefault();
  dropping.value = true;
}

function onDrop(event) {
  dropping.value = false;
  if (sending.value) return;
  actionError.value = '';
  tray.takeDrop(event);
}
onBeforeUnmount(() => tray.clear());

// Uploads one attached file into the channel library's top level and returns its id.
async function uploadAttachment(file) {
  const target = { targetId: props.channel.id, targetType: 'channel' };
  if (uploads.parts && file.size > 0) {
    const upload = await sendLargeUpload({
      api: api,
      file,
      onProgress: ({ sentBytes, totalBytes }) => { sendProgress.value = `Uploading ${file.name} · ${totalBytes ? Math.floor((sentBytes / totalBytes) * 100) : 0}%`; },
      projectId: props.projectId,
      resolveUrl: (url) => api.resolveTransferUrl(url),
      start: target,
      token: props.token,
    });
    return (await api.completeFileUpload(props.projectId, upload.id, {}, props.token)).file.id;
  }
  sendProgress.value = `Uploading ${file.name}`;
  const result = await api.uploadProjectFile(props.projectId, {
    fileContentsBase64: await fileToBase64(file),
    fileDescription: '',
    fileName: file.name,
    fileType: file.type || 'application/octet-stream',
    inlineImage: false,
    ...target,
  }, props.token);
  return result.file.id;
}

function send() {
  return sendPost();
}

// A message, or a poll (PollComposerDialog), with what is in the box above it and its files.
async function sendPost(poll = null) {
  if (sending.value || (!poll && !draft.value.trim() && !attachments.value.length)) return;
  sending.value = true;
  actionError.value = '';
  pollComposer.error = '';
  try {
    const fileIds = [];
    for (const entry of attachments.value) fileIds.push(entry.fileId ?? (entry.fileId = await uploadAttachment(entry.file)));
    sendProgress.value = '';
    const result = await api.createChannelPost(props.projectId, props.channel.id, { body: draft.value, fileIds, ...(poll ? { poll } : {}) }, props.token);
    posts.value = upsertPost(posts.value, result.post);
    draft.value = '';
    tray.clear();
    pollComposer.open = false;
    scrollToEnd();
    emit('read', props.channel.id);
  } catch (error) {
    if (poll) pollComposer.error = channelErrorMessage(error, 'The poll could not be posted.');
    else actionError.value = channelErrorMessage(error, 'The message could not be sent. It is still in the box.');
  } finally {
    sending.value = false;
    sendProgress.value = '';
  }
}

// Polls (docs/engagements/plan.md, Polls): the dialog, and a vote or close shown at once.
const pollComposer = reactive({ error: '', open: false });

function openPollComposer() {
  pollComposer.error = '';
  pollComposer.open = true;
}

function updatePoll({ poll, post }) {
  const current = posts.value.find((entry) => entry.id === post.id);
  if (current) posts.value = upsertPost(posts.value, { ...current, poll });
}

// Reactions show at once and settle to what the server says; a failure puts them back.
async function react({ emoji, post, reacted }) {
  const before = post.reactions ?? [];
  posts.value = withReactions(posts.value, post.id, toggledReactions(before, emoji, reacted));
  actionError.value = '';
  try {
    const result = await api.setPostReaction(props.projectId, post.id, { emoji, reacted }, props.token);
    posts.value = withReactions(posts.value, post.id, result.reactions ?? []);
  } catch (error) {
    posts.value = withReactions(posts.value, post.id, before);
    actionError.value = channelErrorMessage(error, 'The reaction could not be saved.');
  }
}

// A quote pressed: the quoted message comes into view, marked for a moment.
function flashPost(postId) {
  clearTimeout(flashTimer);
  flashId.value = postId;
  void focusPost(postId);
  flashTimer = setTimeout(() => { flashId.value = ''; }, 2500);
}
onBeforeUnmount(() => clearTimeout(flashTimer));

function cancelInline() {
  replyingToId.value = '';
  replyQuoteId.value = '';
  editingId.value = '';
}

// A reply's files (its box's tray entries) upload as a new message's do. Each entry keeps its
// fileId, so a reply that fails and is sent again does not upload them twice.
async function submitReply({ body, files = [], post, replyToId = null }) {
  busyId.value = post.id;
  actionError.value = '';
  try {
    const fileIds = [];
    for (const entry of files) fileIds.push(entry.fileId ?? (entry.fileId = await uploadAttachment(entry.file)));
    sendProgress.value = '';
    const result = await api.createChannelPost(props.projectId, props.channel.id, { body, fileIds, parentId: post.id, ...(replyToId ? { replyToId } : {}) }, props.token);
    posts.value = upsertPost(posts.value, result.post);
    replyingToId.value = '';
    replyQuoteId.value = '';
  } catch (error) {
    actionError.value = channelErrorMessage(error, 'The reply could not be sent.');
  } finally {
    busyId.value = '';
    sendProgress.value = '';
  }
}

async function submitEdit({ body, post }) {
  busyId.value = post.id;
  actionError.value = '';
  try {
    const result = await api.updatePost(props.projectId, post.id, { body }, props.token);
    posts.value = upsertPost(posts.value, result.post);
    editingId.value = '';
  } catch (error) {
    actionError.value = channelErrorMessage(error, 'The edit could not be saved.');
  } finally {
    busyId.value = '';
  }
}

// Odin's buttons: the server lets only the person who tagged Odin use them. The answer that
// follows arrives as a live update.
async function resolveOdin({ decision, post }) {
  busyId.value = post.id;
  actionError.value = '';
  try {
    await api.resolveOdinConfirmation(props.projectId, post.id, { callId: post.odinReply.confirmation.callId, decision }, props.token);
    await load({ quiet: true });
  } catch (error) {
    actionError.value = channelErrorMessage(error, 'Odin could not take your answer. Try again.');
  } finally {
    busyId.value = '';
  }
}

async function undoOdin(post) {
  busyId.value = post.id;
  actionError.value = '';
  try {
    await api.undoOdinChanges(props.projectId, post.id, props.token);
    await load({ quiet: true });
  } catch (error) {
    actionError.value = channelErrorMessage(error, 'Those changes could not be undone.');
  } finally {
    busyId.value = '';
  }
}

// While Odin works on a tag, look again now and then in case a live update is missed.
const odinWorking = computed(() => posts.value.some(threadOdinReplying));
let odinTimer = null;
watch(odinWorking, (working) => {
  clearInterval(odinTimer);
  odinTimer = working ? setInterval(() => load({ quiet: true }), 5000) : null;
});
onBeforeUnmount(() => clearInterval(odinTimer));

async function confirmRemove() {
  if (!removal.post) return;
  removal.busy = true;
  removal.error = '';
  try {
    const result = await api.deletePost(props.projectId, removal.post.id, props.token);
    posts.value = upsertPost(posts.value, result.post);
    removal.post = null;
  } catch (error) {
    removal.error = channelErrorMessage(error, 'The message could not be deleted.');
  } finally {
    removal.busy = false;
  }
}

// ---- Typing (lib/channels/typing.js) ----
// Channels only: a direct message's API has no typing route.
const typingOn = computed(() => !isConversation.value && supportsTyping(api));
const typingNow = shallowRef([]);
const typingTracker = createTypingTracker({ onChange: (entries) => { typingNow.value = entries; } });
const channelTyping = computed(() => typingLabelFor(typingNow.value, null));
// Thread id to its label, for the threads someone is replying in.
const threadTyping = computed(() => Object.fromEntries([...new Set(typingNow.value.map((entry) => entry.parentId).filter(Boolean))].map((parentId) => [parentId, typingLabelFor(typingNow.value, parentId)])));
let stopTypingLive = null;
let composerTyping = null;
let replyTyping = null;
let replyTypingParent = '';
// A draft the screen set itself (seedDraft), so not someone typing.
let seededDraft = null;

// Fixed to the channel open now: a stop sent while switching goes to the channel being left.
function typingSend(parentId = null) {
  const { projectId, token } = props;
  const channelId = props.channel.id;
  const client = api.passive ?? api;
  return (typing) => client.sendChannelTyping(projectId, channelId, { ...(parentId ? { parentId } : {}), typing }, token);
}

function stopTypingSenders() {
  composerTyping?.stop();
  replyTyping?.stop();
  replyTyping = null;
  replyTypingParent = '';
}

function startTyping() {
  stopTypingLive?.();
  stopTypingLive = null;
  stopTypingSenders();
  typingTracker.clear();
  composerTyping = null;
  if (!typingOn.value) return;
  composerTyping = createTypingSender({ send: typingSend() });
  stopTypingLive = createTypingLiveUpdates({ api, channelId: props.channel.id, getToken: () => props.token, onEvent: (event) => typingTracker.receive(event), projectId: props.projectId });
}

function onReplyTyping({ parentId, text }) {
  if (!typingOn.value || !parentId) return;
  if (replyTypingParent !== parentId) {
    replyTyping?.stop();
    replyTyping = createTypingSender({ send: typingSend(parentId) });
    replyTypingParent = parentId;
  }
  replyTyping.update(text);
}

watch(draft, (text) => {
  const seeded = seededDraft !== null && text === seededDraft;
  seededDraft = null;
  if (!seeded) composerTyping?.update(text);
});
// The box steps aside for a reply or an edit; a reply box goes when it is sent or cancelled.
watch(composerOpen, (open) => {
  if (!open) composerTyping?.stop();
});
watch(replyingToId, (postId) => {
  if (postId === replyTypingParent) return;
  replyTyping?.stop();
  replyTyping = null;
  replyTypingParent = '';
});
onBeforeUnmount(() => {
  stopTypingSenders();
  stopTypingLive?.();
});

// By ids: the channel object is replaced whenever the list reloads (an unread count changed).
watch(() => `${props.projectId}|${props.channel?.id}|${props.token}`, () => {
  startTyping();
  posts.value = [];
  nextCursor.value = null;
  cancelInline();
  draft.value = '';
  tray.clear();
  actionError.value = '';
  void load();
  void loadUploadLimits();
}, { immediate: true });

watch(() => props.liveVersion, () => load({ quiet: true }));
watch(() => props.focusPostId, (postId) => {
  if (postId) void revealPost(postId);
});

watch(() => props.seedDraft, (text) => {
  if (!text) return;
  seededDraft = text;
  draft.value = text;
  void nextTick(() => composer.value?.focus());
}, { immediate: true });

defineExpose({ focus: () => composer.value?.focus() });
</script>

<template>
  <section class="channel-conversation" :class="{ 'channel-conversation--fill': fill }" :aria-labelledby="`${uid}-heading`">
    <h3 :id="`${uid}-heading`" class="visually-hidden">Conversation in {{ channel.name }}</h3>
    <div ref="scroller" class="channel-conversation__scroller" @scroll.passive="onScroll">
      <button v-if="nextCursor" class="ghost-button ghost-button--compact channel-conversation__older" type="button" :disabled="loadingOlder" @click="loadOlder">
        {{ loadingOlder ? 'Loading…' : 'Show earlier messages' }}
      </button>
      <p v-if="loading && !posts.length" class="channel-conversation__note" role="status">Loading messages…</p>
      <p v-else-if="loadError" class="error-banner mb-0" role="alert">
        {{ loadError }}
        <button class="ghost-button ghost-button--compact ms-2" type="button" @click="load()">Try again</button>
      </p>
      <p v-else-if="!posts.length" class="channel-conversation__note">No messages yet.<template v-if="canPost"> Write the first one below.</template></p>
      <ol v-if="shown.length" ref="list" class="channel-conversation__posts" aria-label="Messages">
        <ChannelPost
          v-for="post in shown"
          :key="post.id"
          :busy-id="busyId"
          :editing-id="editingId"
          :focus-id="flashId || focusPostId"
          :max-file-bytes="maxFileBytes()"
          :mentionables="mentionables"
          :post="post"
          :progress="sendProgress"
          :replying-to-id="replyingToId"
          :reply-quote-id="replyQuoteId"
          :typing-label="threadTyping[post.id] ?? ''"
          @begin-edit="(id) => { replyingToId = ''; editingId = id; }"
          @begin-reply="(id, quoteId) => { editingId = ''; replyingToId = id; replyQuoteId = quoteId ?? ''; }"
          @focus-post="flashPost"
          @poll-update="updatePoll"
          @react="react"
          @reply-typing="onReplyTyping"
          @cancel="cancelInline"
          @odin-confirm="resolveOdin"
          @odin-undo="undoOdin"
          @open-file="emit('open-file', $event)"
          @remove="(post) => { removal.post = post; removal.error = ''; }"
          @submit-edit="submitEdit"
          @submit-reply="submitReply"
        />
      </ol>
    </div>

    <p v-if="actionError" class="error-banner mb-0" role="alert">{{ actionError }}</p>
    <!-- Always in place while typing is on, so the line coming and going does not move the box. -->
    <p v-if="typingOn" class="channel-conversation__typing" role="status">{{ channelTyping }}</p>

    <form
      v-if="composerOpen"
      class="channel-conversation__composer"
      :class="{ 'channel-conversation__composer--drop': dropping }"
      @dragleave="dropping = false"
      @dragover="onDragOver"
      @drop.capture="onDrop"
      @paste.capture="onPaste"
      @submit.prevent="send"
    >
      <span :id="`${uid}-composer-label`" class="visually-hidden">Message {{ channel.name }}</span>
      <RequirementsCommentEditor
        class="rich-editor--tools-float"
        ref="composer"
        v-model="draft"
        :labelled-by="`${uid}-composer-label`"
        :mentionables="mentionables"
        :placeholder="placeholder"
        @submit="send"
      />
      <AttachmentTray :disabled="sending" :entries="attachments" @remove="tray.remove" />
      <div class="channel-conversation__bar">
        <label class="ghost-button ghost-button--compact channel-conversation__attach" :for="`${uid}-files`">
          <i class="bi bi-paperclip" aria-hidden="true"></i> Attach files
        </label>
        <input :id="`${uid}-files`" ref="fileInput" class="visually-hidden" type="file" multiple :disabled="sending" @change="pickFiles" />
        <button class="ghost-button ghost-button--compact channel-conversation__attach" type="button" :disabled="sending" @click="openPollComposer">
          <i class="bi bi-bar-chart-line" aria-hidden="true"></i> Poll
        </button>
        <span class="channel-conversation__progress" role="status">{{ sendProgress }}</span>
        <button class="primary-button" type="submit" :disabled="sending || (!draft.trim() && !attachments.length)">
          <i class="bi bi-send" aria-hidden="true"></i> {{ sending ? 'Sending…' : 'Send' }}
        </button>
      </div>
    </form>
    <p v-else-if="!canPost" class="channel-conversation__note channel-conversation__readonly">
      <i class="bi bi-lock" aria-hidden="true"></i>
      <template v-if="channel.archivedAt">This channel is archived, so it is read-only.</template>
      <template v-else>You can read this channel, but not post in it.</template>
    </p>

    <PollComposerDialog :busy="sending" :error="pollComposer.error" :open="pollComposer.open" @close="pollComposer.open = false" @submit="sendPost" />

    <RequirementsConfirmDialog
      :busy="removal.busy"
      confirm-label="Delete message"
      :error="removal.error"
      :open="Boolean(removal.post)"
      title="Delete this message?"
      @close="removal.post = null"
      @confirm="confirmRemove"
    >
      <p class="mb-0">It shows as "Message deleted" in the conversation. Replies to it stay.<template v-if="!isConversation"> Files it carried stay in the channel's library.</template></p>
    </RequirementsConfirmDialog>
  </section>
</template>

<style scoped>
.channel-conversation { display: grid; grid-template-rows: minmax(0, 1fr) auto auto; gap: 0.5rem; min-height: 0; }
.channel-conversation__scroller { display: grid; align-content: start; gap: 0.5rem; min-height: 12rem; max-height: min(62vh, 44rem); overflow-y: auto; overscroll-behavior: contain; padding-right: 0.25rem; }
.channel-conversation__older { justify-self: center; min-height: 2.75rem; }
.channel-conversation__note { margin: 0; color: var(--muted); }
.channel-conversation__posts { display: grid; gap: 0.25rem; margin: 0; padding: 0; }
.channel-conversation__composer { display: grid; gap: 0.5rem; padding-top: 0.5rem; border-top: 1px solid var(--line); }
.channel-conversation__bar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
.channel-conversation__bar .primary-button { margin-left: auto; min-height: 2.75rem; }
.channel-conversation__attach { display: inline-flex; align-items: center; gap: 0.35rem; min-height: 2.75rem; cursor: pointer; }
input:focus-visible + .channel-conversation__attach,
.channel-conversation__attach:focus-within { outline: 0.18rem solid var(--accent); outline-offset: 0.1rem; }
.channel-conversation__progress { color: var(--muted); font-size: 0.75rem; }
.channel-conversation__progress:empty { display: none; }
.channel-conversation__composer--drop { outline: 0.15rem dashed var(--accent); outline-offset: 0.25rem; border-radius: 0.4rem; }
.channel-conversation__typing { min-height: 1.25rem; margin: -0.25rem 0; color: var(--muted); font-size: 0.8125rem; line-height: 1.25rem; }
.channel-conversation__readonly { display: flex; align-items: center; gap: 0.35rem; padding: 0.5rem 0.75rem; border: 1px solid var(--line); border-radius: 0.4rem; background: var(--surface-soft); }

@media (max-width: 767.98px) {
  .channel-conversation__scroller { max-height: none; overflow: visible; }
}

/* Filling: the messages take the height left above the box, on every screen size. */
.channel-conversation--fill { flex: 1 1 auto; min-height: 0; }
.channel-conversation--fill .channel-conversation__scroller { min-height: 0; max-height: none; overflow-y: auto; }
</style>
