<script setup>
import { computed } from 'vue';

import RichContentEditor from '../rich-content/RichContentEditor.vue';
import { hydrateRichHtml } from '../../lib/rich-content/html.js';

defineOptions({
  name: 'CommentThreadItem',
});

const props = defineProps({
  apiBaseUrl: {
    required: true,
    type: String,
  },
  canModerate: {
    default: false,
    type: Boolean,
  },
  comment: {
    required: true,
    type: Object,
  },
  currentUserId: {
    default: '',
    type: String,
  },
  editDraft: {
    default: '',
    type: String,
  },
  editingId: {
    default: '',
    type: String,
  },
  projectId: {
    default: '',
    type: String,
  },
  replyDraft: {
    default: '',
    type: String,
  },
  replyingToId: {
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

const emit = defineEmits([
  'begin-edit',
  'begin-reply',
  'cancel-edit',
  'cancel-reply',
  'delete-comment',
  'save-edit',
  'save-reply',
  'vote',
  'update:edit-draft',
  'update:reply-draft',
]);

const isEditing = computed(() => props.editingId === props.comment.id);
const isReplying = computed(() => props.replyingToId === props.comment.id);
const canEdit = computed(() => props.comment.userId === props.currentUserId);
const canDelete = computed(() => props.canModerate || canEdit.value);
const renderedComment = computed(() => hydrateRichHtml(props.comment.comment, props.apiBaseUrl));

const editModel = computed({
  get() {
    return props.editDraft;
  },
  set(value) {
    emit('update:edit-draft', value);
  },
});

const replyModel = computed({
  get() {
    return props.replyDraft;
  },
  set(value) {
    emit('update:reply-draft', value);
  },
});
</script>

<template>
  <article class="comment-thread__item">
    <header class="comment-thread__header">
      <div>
        <strong>{{ comment.author.name }}</strong>
        <p class="field-note">{{ new Date(comment.updatedAt || comment.createdAt).toLocaleString() }}</p>
      </div>
      <div class="actions-row">
        <button class="ghost-button ghost-button--compact" type="button" title="Upvote" @click="$emit('vote', { commentId: comment.id, vote: 'up' })">
          <i class="bi bi-hand-thumbs-up"></i>
          {{ comment.upvotes ?? 0 }}
        </button>
        <button class="ghost-button ghost-button--compact" type="button" title="Downvote" @click="$emit('vote', { commentId: comment.id, vote: 'down' })">
          <i class="bi bi-hand-thumbs-down"></i>
          {{ comment.downvotes ?? 0 }}
        </button>
        <button class="ghost-button ghost-button--compact" type="button" @click="$emit('begin-reply', comment.id)">
          Reply
        </button>
        <button v-if="canEdit" class="ghost-button ghost-button--compact" type="button" @click="$emit('begin-edit', comment)">
          Edit
        </button>
        <button v-if="canDelete" class="ghost-button ghost-button--compact ghost-button--danger" type="button" @click="$emit('delete-comment', comment.id)">
          Delete
        </button>
      </div>
    </header>

    <div v-if="isEditing" class="stack">
      <RichContentEditor
        v-model="editModel"
        compact
        min-height="7rem"
        :project-id="projectId"
        :target-id="targetId"
        :target-type="targetType"
        :token="token"
      />

      <div class="actions-row">
        <button class="secondary-button secondary-button--compact" type="button" @click="$emit('save-edit', comment.id)">Save edit</button>
        <button class="ghost-button ghost-button--compact" type="button" @click="$emit('cancel-edit')">Cancel</button>
      </div>
    </div>
    <div v-else class="comment-thread__body rich-copy" v-html="renderedComment"></div>

    <div v-if="isReplying" class="comment-thread__reply stack">
      <RichContentEditor
        v-model="replyModel"
        compact
        min-height="7rem"
        placeholder="Write a reply..."
        :project-id="projectId"
        :target-id="targetId"
        :target-type="targetType"
        :token="token"
      />

      <div class="actions-row">
        <button class="secondary-button secondary-button--compact" type="button" @click="$emit('save-reply', comment.id)">Post reply</button>
        <button class="ghost-button ghost-button--compact" type="button" @click="$emit('cancel-reply')">Cancel</button>
      </div>
    </div>

    <div v-if="comment.children?.length" class="comment-thread__children">
      <CommentThreadItem
        v-for="child in comment.children"
        :key="child.id"
        :api-base-url="apiBaseUrl"
        :can-moderate="canModerate"
        :comment="child"
        :current-user-id="currentUserId"
        :edit-draft="editDraft"
        :editing-id="editingId"
        :project-id="projectId"
        :reply-draft="replyDraft"
        :replying-to-id="replyingToId"
        :target-id="targetId"
        :target-type="targetType"
        :token="token"
        @begin-edit="$emit('begin-edit', $event)"
        @begin-reply="$emit('begin-reply', $event)"
        @cancel-edit="$emit('cancel-edit')"
        @cancel-reply="$emit('cancel-reply')"
        @delete-comment="$emit('delete-comment', $event)"
        @save-edit="$emit('save-edit', $event)"
        @save-reply="$emit('save-reply', $event)"
        @vote="$emit('vote', $event)"
        @update:edit-draft="$emit('update:edit-draft', $event)"
        @update:reply-draft="$emit('update:reply-draft', $event)"
      />
    </div>
  </article>
</template>
