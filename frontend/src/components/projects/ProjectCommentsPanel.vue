<script setup>
import { computed, ref, watch } from 'vue';

import { apiClient } from '../../lib/auth/index.js';
import { onProjectRefresh } from '../../lib/live/live-refresh.js';
import CommentThreadItem from './CommentThreadItem.vue';
import RichContentEditor from '../rich-content/RichContentEditor.vue';

const props = defineProps({
  apiBaseUrl: {
    required: true,
    type: String,
  },
  currentUserId: {
    default: '',
    type: String,
  },
  currentUserRole: {
    default: 'user',
    type: String,
  },
  projectId: {
    default: '',
    type: String,
  },
  targetId: {
    default: '',
    type: String,
  },
  targetType: {
    default: 'project',
    type: String,
  },
  token: {
    default: '',
    type: String,
  },
});

const comments = ref([]);
const composerHtml = ref('');
const editDraft = ref('');
const editingId = ref('');
const errorMessage = ref('');
const loading = ref(false);
const replyDraft = ref('');
const replyingToId = ref('');
const saving = ref(false);

const canUseComments = computed(() => Boolean(props.projectId && props.targetId && props.token));
const canModerate = computed(() => props.currentUserRole === 'admin' || props.currentUserRole === 'manager');

function countComments(nodes) {
  return nodes.reduce((total, node) => total + 1 + countComments(node.children ?? []), 0);
}

const commentCount = computed(() => countComments(comments.value));

// `quiet` reloads after someone else's change: in the background, keeping the thread on failure,
// and dropped if the panel has moved to another item meanwhile.
async function loadComments({ quiet = false } = {}) {
  if (!canUseComments.value) {
    comments.value = [];
    return;
  }

  if (!quiet) {
    loading.value = true;
    errorMessage.value = '';
  }

  const target = `${props.projectId}:${props.targetType}:${props.targetId}`;
  try {
    const result = await (quiet ? apiClient.passive : apiClient).getComments(
      props.projectId,
      {
        targetId: props.targetId,
        targetType: props.targetType,
      },
      props.token,
    );
    if (quiet && target !== `${props.projectId}:${props.targetType}:${props.targetId}`) return;
    comments.value = result.comments;
  } catch (error) {
    if (!quiet) errorMessage.value = error.message ?? 'Unable to load comments.';
  } finally {
    if (!quiet) loading.value = false;
  }
}

onProjectRefresh(() => loadComments({ quiet: true }));

watch(
  () => [props.projectId, props.targetId, props.targetType, props.token],
  () => {
    composerHtml.value = '';
    editDraft.value = '';
    editingId.value = '';
    replyDraft.value = '';
    replyingToId.value = '';
    loadComments();
  },
  { immediate: true },
);

async function handleCreateComment() {
  if (!composerHtml.value.trim()) {
    return;
  }

  saving.value = true;
  errorMessage.value = '';

  try {
    await apiClient.addComment(
      props.projectId,
      {
        comment: composerHtml.value,
        targetId: props.targetId,
        targetType: props.targetType,
      },
      props.token,
    );
    composerHtml.value = '';
    await loadComments();
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to create the comment.';
  } finally {
    saving.value = false;
  }
}

function beginReply(commentId) {
  replyingToId.value = commentId;
  replyDraft.value = '';
  editingId.value = '';
  editDraft.value = '';
}

async function saveReply(parentId) {
  if (!replyDraft.value.trim()) {
    return;
  }

  saving.value = true;
  errorMessage.value = '';

  try {
    await apiClient.addComment(
      props.projectId,
      {
        comment: replyDraft.value,
        parentId,
        targetId: props.targetId,
        targetType: props.targetType,
      },
      props.token,
    );
    replyDraft.value = '';
    replyingToId.value = '';
    await loadComments();
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to save the reply.';
  } finally {
    saving.value = false;
  }
}

function beginEdit(comment) {
  editingId.value = comment.id;
  editDraft.value = comment.comment;
  replyingToId.value = '';
  replyDraft.value = '';
}

async function saveEdit(commentId) {
  if (!editDraft.value.trim()) {
    return;
  }

  saving.value = true;
  errorMessage.value = '';

  try {
    await apiClient.updateComment(
      props.projectId,
      commentId,
      {
        comment: editDraft.value,
      },
      props.token,
    );
    editingId.value = '';
    editDraft.value = '';
    await loadComments();
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to update the comment.';
  } finally {
    saving.value = false;
  }
}

async function deleteComment(commentId) {
  saving.value = true;
  errorMessage.value = '';

  try {
    await apiClient.deleteComment(props.projectId, commentId, props.token);
    await loadComments();
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to delete the comment.';
  } finally {
    saving.value = false;
  }
}

async function voteComment({ commentId, vote }) {
  if (!commentId || !vote) {
    return;
  }

  saving.value = true;
  errorMessage.value = '';

  try {
    await apiClient.voteComment(props.projectId, commentId, { vote }, props.token);
    await loadComments();
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to vote on the comment.';
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section class="workbench-card">
    <div class="workbench-card__header">
      <div>
        <p class="card-eyebrow">Comments</p>
        <h3 class="workbench-card__title">Discussion</h3>
      </div>
      <span class="muted-copy">{{ commentCount }} entries</span>
    </div>

    <div v-if="errorMessage" class="error-banner" style="margin-top: 0.85rem">{{ errorMessage }}</div>

    <div class="stack" style="margin-top: 1rem">
      <RichContentEditor
        v-model="composerHtml"
        compact
        min-height="8rem"
        placeholder="Write a comment..."
        :project-id="projectId"
        :target-id="targetId"
        :target-type="targetType"
        :token="token"
      />

      <div class="actions-row">
        <button class="secondary-button secondary-button--compact" :disabled="saving || !composerHtml.trim()" type="button" @click="handleCreateComment">
          {{ saving ? 'Saving...' : 'Post comment' }}
        </button>
      </div>
    </div>

    <div v-if="loading" class="d-flex justify-content-center" style="margin-top: 1rem">
      <div class="spinner-border spinner-border-sm" role="status" aria-label="Loading"></div>
    </div>

    <div v-else class="comment-thread" style="margin-top: 1rem">
      <CommentThreadItem
        v-for="comment in comments"
        :key="comment.id"
        :api-base-url="apiBaseUrl"
        :can-moderate="canModerate"
        :comment="comment"
        :current-user-id="currentUserId"
        :edit-draft="editDraft"
        :editing-id="editingId"
        :project-id="projectId"
        :reply-draft="replyDraft"
        :replying-to-id="replyingToId"
        :target-id="targetId"
        :target-type="targetType"
        :token="token"
        @begin-edit="beginEdit"
        @begin-reply="beginReply"
        @cancel-edit="editingId = ''; editDraft = ''"
        @cancel-reply="replyingToId = ''; replyDraft = ''"
        @delete-comment="deleteComment"
        @save-edit="saveEdit"
        @save-reply="saveReply"
        @vote="voteComment"
        @update:edit-draft="editDraft = $event"
        @update:reply-draft="replyDraft = $event"
      />
    </div>
  </section>
</template>
