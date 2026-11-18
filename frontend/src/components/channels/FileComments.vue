<script setup>
import { computed, reactive, ref, useId, watch } from 'vue';

import { useChannelApi } from '../../lib/channels/channel-api.js';
import { channelErrorMessage, upsertPost } from '../../lib/channels/channels.js';
import { toggledReactions, withReactions } from '../../lib/channels/reactions.js';
import RequirementsCommentEditor from '../requirements/RequirementsCommentEditor.vue';
import RequirementsConfirmDialog from '../requirements/RequirementsConfirmDialog.vue';
import ChannelPost from './ChannelPost.vue';

// The app's API for members; the guest view provides the guest API (lib/channels/channel-api.js).
const api = useChannelApi();

// A file's one discussion: comments oldest first, each showing the version it was made
// on, with replies one level deep and the same tags as channel messages.
const props = defineProps({
  file: { required: true, type: Object },
  // Moves when someone else changed this file or its comments.
  liveVersion: { default: 0, type: Number },
  projectId: { required: true, type: String },
  token: { default: '', type: String },
});

const uid = useId();
const comments = ref([]);
const canComment = ref(false);
const currentVersion = ref(1);
const loading = ref(false);
const error = ref('');
const draft = ref('');
const posting = ref(false);
const replyingToId = ref('');
const replyQuoteId = ref('');
const editingId = ref('');
const busyId = ref('');
const removal = reactive({ busy: false, error: '', post: null });
const composerOpen = computed(() => canComment.value && !replyingToId.value && !editingId.value);
const mentionables = async () => (await api.passive.listFileMentionables(props.projectId, props.file.id, props.token)).people ?? [];
let run = 0;

// comments are oldest first here; upsertPost works newest first.
const merge = (post) => { comments.value = [...upsertPost([...comments.value].reverse(), post)].reverse(); };

async function load({ quiet = false } = {}) {
  const current = ++run;
  if (!quiet) loading.value = true;
  try {
    const result = await (quiet ? api.passive : api).listFileComments(props.projectId, props.file.id, props.token);
    if (current !== run) return;
    comments.value = result.comments ?? [];
    canComment.value = result.canComment === true;
    currentVersion.value = result.currentVersion ?? props.file.version ?? 1;
    error.value = '';
  } catch (failure) {
    if (current === run && !quiet) error.value = channelErrorMessage(failure, 'Comments could not load.');
  } finally {
    if (current === run) loading.value = false;
  }
}

async function post() {
  if (posting.value || !draft.value.trim()) return;
  posting.value = true;
  error.value = '';
  try {
    merge((await api.createFileComment(props.projectId, props.file.id, { body: draft.value }, props.token)).comment);
    draft.value = '';
  } catch (failure) {
    error.value = channelErrorMessage(failure, 'The comment could not be saved.');
  } finally {
    posting.value = false;
  }
}

async function runInline(action, id, fallback) {
  busyId.value = id;
  error.value = '';
  try {
    await action();
    replyingToId.value = '';
    replyQuoteId.value = '';
    editingId.value = '';
  } catch (failure) {
    error.value = channelErrorMessage(failure, fallback);
  } finally {
    busyId.value = '';
  }
}

const submitReply = ({ body, post: parent, replyToId = null }) => runInline(async () => merge((await api.createFileComment(props.projectId, props.file.id, { body, parentId: parent.id, ...(replyToId ? { replyToId } : {}) }, props.token)).comment), parent.id, 'The reply could not be saved.');

// Reactions on comments, as in a conversation: shown at once, settled by the server.
async function react({ emoji, post: comment, reacted }) {
  const before = comment.reactions ?? [];
  comments.value = withReactions(comments.value, comment.id, toggledReactions(before, emoji, reacted));
  try {
    comments.value = withReactions(comments.value, comment.id, (await api.setPostReaction(props.projectId, comment.id, { emoji, reacted }, props.token)).reactions ?? []);
  } catch (failure) {
    comments.value = withReactions(comments.value, comment.id, before);
    error.value = channelErrorMessage(failure, 'The reaction could not be saved.');
  }
}
const submitEdit = ({ body, post: comment }) => runInline(async () => merge((await api.updatePost(props.projectId, comment.id, { body }, props.token)).post), comment.id, 'The edit could not be saved.');

async function confirmRemove() {
  removal.busy = true;
  removal.error = '';
  try {
    merge((await api.deletePost(props.projectId, removal.post.id, props.token)).post);
    removal.post = null;
  } catch (failure) {
    removal.error = channelErrorMessage(failure, 'The comment could not be deleted.');
  } finally {
    removal.busy = false;
  }
}

// By ids: the file object is replaced whenever its list reloads.
watch(() => `${props.projectId}|${props.file.id}|${props.token}`, () => {
  comments.value = [];
  draft.value = '';
  void load();
}, { immediate: true });
watch(() => `${props.liveVersion}|${props.file.version}`, () => load({ quiet: true }));
</script>

<template>
  <section class="file-comments" :aria-labelledby="`${uid}-heading`">
    <h4 :id="`${uid}-heading`" class="file-comments__label">Comments<span v-if="comments.length" class="file-comments__count"> · {{ comments.length }}</span></h4>
    <p v-if="loading && !comments.length" class="file-comments__note" role="status">Loading comments…</p>
    <p v-else-if="!comments.length && !error" class="file-comments__note">No comments yet.</p>
    <ol v-if="comments.length" class="file-comments__list" :aria-label="`Comments on ${file.fileName}`">
      <ChannelPost
        v-for="comment in comments"
        :key="comment.id"
        :busy-id="busyId"
        :editing-id="editingId"
        :mentionables="mentionables"
        :post="comment"
        :replying-to-id="replyingToId"
        :reply-quote-id="replyQuoteId"
        show-version
        @begin-edit="(id) => { replyingToId = ''; editingId = id; }"
        @begin-reply="(id, quoteId) => { editingId = ''; replyingToId = id; replyQuoteId = quoteId ?? ''; }"
        @cancel="replyingToId = ''; replyQuoteId = ''; editingId = ''"
        @react="react"
        @remove="(entry) => { removal.post = entry; removal.error = ''; }"
        @submit-edit="submitEdit"
        @submit-reply="submitReply"
      />
    </ol>
    <p v-if="error" class="error-banner mb-0" role="alert">{{ error }}</p>
    <form v-if="composerOpen" class="file-comments__form" @submit.prevent="post">
      <span :id="`${uid}-box`" class="visually-hidden">Comment on {{ file.fileName }}</span>
      <RequirementsCommentEditor
        class="rich-editor--tools-float"
        v-model="draft"
        :labelled-by="`${uid}-box`"
        :mentionables="mentionables"
        :placeholder="`Comment on version ${currentVersion}. Type @ to tag someone.`"
        @submit="post"
      />
      <div class="file-comments__actions">
        <button class="primary-button primary-button--compact" type="submit" :disabled="posting || !draft.trim()">{{ posting ? 'Posting…' : 'Post comment' }}</button>
      </div>
    </form>

    <RequirementsConfirmDialog
      :busy="removal.busy"
      confirm-label="Delete comment"
      :error="removal.error"
      :open="Boolean(removal.post)"
      title="Delete this comment?"
      @close="removal.post = null"
      @confirm="confirmRemove"
    >
      <p class="mb-0">It shows as "Message deleted". Replies to it stay.</p>
    </RequirementsConfirmDialog>
  </section>
</template>

<style scoped>
.file-comments { display: grid; gap: 0.35rem; }
.file-comments__label { margin: 0; padding: 0; color: var(--muted); font-size: 0.75rem !important; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
.file-comments__count { font-weight: 400; }
.file-comments__note { margin: 0; color: var(--muted); }
.file-comments__list { display: grid; gap: 0.25rem; margin: 0; padding: 0; }
.file-comments__form { display: grid; gap: 0.35rem; }
.file-comments__actions { display: flex; justify-content: flex-end; }
</style>
