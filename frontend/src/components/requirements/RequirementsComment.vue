<script setup>
import { computed, nextTick, ref, watch } from 'vue';

import RequirementsCommentBody from './RequirementsCommentBody.vue';
import RequirementsCommentEditor from './RequirementsCommentEditor.vue';
import { commentSourceChip } from '../../lib/requirements/requirements-sources.js';
import { formatDateTime } from '../../lib/requirements/requirements-time.js';

defineOptions({ name: 'RequirementsComment' });

// One comment in a topic thread, with its source number (C1, C2, ...) and replies. Reply
// and edit drafts live here; the topic page decides which comment is open for either.
const props = defineProps({
  busyId: { default: '', type: String },
  canComment: { default: false, type: Boolean },
  canVote: { default: false, type: Boolean },
  comment: { required: true, type: Object },
  commentsOpen: { default: true, type: Boolean },
  editingId: { default: '', type: String },
  labels: { required: true, type: Map },
  // Loads the people this viewer may tag: async () => [{ ref, name, detail, kind }].
  mentionables: { default: null, type: Function },
  replyingToId: { default: '', type: String },
});

const emit = defineEmits(['begin-edit', 'begin-reply', 'cancel', 'remove', 'submit-edit', 'submit-reply', 'vote']);

const replyDraft = ref('');
const editDraft = ref('');
const replyField = ref(null);
const editField = ref(null);

const label = computed(() => props.labels.get(props.comment.id) ?? '');
const removed = computed(() => Boolean(props.comment.isDeleted || props.comment.deletedAt));
const fromOdin = computed(() => props.comment.actorType === 'assistant');
const author = computed(() => (fromOdin.value ? 'Odin' : props.comment.authorName || (props.comment.actorType === 'stakeholder' ? 'Stakeholder' : 'Team member')));
const source = computed(() => commentSourceChip(props.comment.source));
const busy = computed(() => props.busyId === props.comment.id);
const replying = computed(() => props.replyingToId === props.comment.id);
const editing = computed(() => props.editingId === props.comment.id);
const canManage = computed(() => props.canComment && props.commentsOpen && props.comment.isMine && !removed.value);
const showVotes = computed(() => !fromOdin.value && (props.canVote || Number(props.comment.upvotes) > 0 || Number(props.comment.downvotes) > 0));
const describedLabel = computed(() => (label.value ? `${label.value}, ${author.value}` : author.value));

watch(replying, async (open) => {
  if (!open) return;
  replyDraft.value = '';
  await nextTick();
  replyField.value?.focus();
});

watch(editing, async (open) => {
  if (!open) return;
  editDraft.value = props.comment.body ?? '';
  await nextTick();
  editField.value?.focus();
});
</script>

<template>
  <li>
    <article
      :id="`rq-comment-${comment.id}`"
      class="rq-comment"
      :class="{ 'rq-comment--odin': fromOdin, 'rq-comment--removed': removed }"
      :aria-label="describedLabel"
    >
      <div class="rq-comment__meta">
        <span v-if="label" class="rq-comment__label">{{ label }}</span>
        <strong>{{ author }}</strong>
        <span v-if="fromOdin">Summary note</span>
        <span v-if="source" class="rq-chip rq-chip--neutral"><i class="bi" :class="source.icon" aria-hidden="true"></i>{{ source.label }}</span>
        <time v-if="comment.createdAt" :datetime="comment.createdAt">{{ formatDateTime(comment.createdAt) }}</time>
        <span v-if="comment.editedAt && !removed">Edited</span>
      </div>

      <p v-if="removed" class="rq-comment__body">Comment removed.</p>
      <RequirementsCommentBody v-else class="rq-comment__body" :body="comment.body" />

      <div v-if="(showVotes || canComment) && !removed && !editing" class="rq-comment__actions">
        <template v-if="showVotes">
          <button
            class="rq-vote"
            :class="{ 'rq-vote--on': comment.currentReaction === 'up' }"
            type="button"
            :aria-pressed="comment.currentReaction === 'up' ? 'true' : 'false'"
            :aria-label="`Agree with ${label || 'this comment'}, ${comment.upvotes ?? 0} so far`"
            :disabled="!canVote || busy"
            @click="emit('vote', { commentId: comment.id, vote: 'up' })"
          >
            <i class="bi bi-hand-thumbs-up" aria-hidden="true"></i>{{ comment.upvotes ?? 0 }}
          </button>
          <button
            class="rq-vote"
            :class="{ 'rq-vote--on': comment.currentReaction === 'down' }"
            type="button"
            :aria-pressed="comment.currentReaction === 'down' ? 'true' : 'false'"
            :aria-label="`Disagree with ${label || 'this comment'}, ${comment.downvotes ?? 0} so far`"
            :disabled="!canVote || busy"
            @click="emit('vote', { commentId: comment.id, vote: 'down' })"
          >
            <i class="bi bi-hand-thumbs-down" aria-hidden="true"></i>{{ comment.downvotes ?? 0 }}
          </button>
        </template>
        <button
          v-if="canComment && commentsOpen && !fromOdin"
          class="rq-text-action"
          type="button"
          :aria-label="`Reply to ${label || author}`"
          @click="emit('begin-reply', comment.id)"
        >
          Reply
        </button>
        <button v-if="canManage" class="rq-text-action" type="button" :aria-label="`Edit ${label}`" @click="emit('begin-edit', comment.id)">Edit</button>
        <button v-if="canManage" class="rq-text-action rq-text-action--danger" type="button" :aria-label="`Remove ${label}`" @click="emit('remove', comment.id)">Remove</button>
      </div>

      <div v-if="replying" class="rq-stack rq-stack--sm mt-2">
        <span :id="`rq-reply-label-${comment.id}`" class="visually-hidden">Reply to {{ label || author }}</span>
        <RequirementsCommentEditor
          ref="replyField"
          v-model="replyDraft"
          :labelled-by="`rq-reply-label-${comment.id}`"
          :mentionables="mentionables"
          @submit="replyDraft.trim() && !busy && emit('submit-reply', { body: replyDraft, commentId: comment.id })"
        />
        <div class="rq-row rq-row--tight" style="justify-content: flex-end">
          <button class="ghost-button ghost-button--compact" type="button" :disabled="busy" @click="emit('cancel')">Cancel</button>
          <button
            class="primary-button primary-button--compact"
            type="button"
            :disabled="busy || !replyDraft.trim()"
            @click="emit('submit-reply', { body: replyDraft, commentId: comment.id })"
          >
            {{ busy ? 'Posting…' : 'Post reply' }}
          </button>
        </div>
      </div>

      <div v-if="editing" class="rq-stack rq-stack--sm mt-2">
        <span :id="`rq-edit-label-${comment.id}`" class="visually-hidden">Edit {{ label }}</span>
        <RequirementsCommentEditor
          ref="editField"
          v-model="editDraft"
          :labelled-by="`rq-edit-label-${comment.id}`"
          :mentionables="mentionables"
          @submit="editDraft.trim() && !busy && emit('submit-edit', { body: editDraft, commentId: comment.id })"
        />
        <div class="rq-row rq-row--tight" style="justify-content: flex-end">
          <button class="ghost-button ghost-button--compact" type="button" :disabled="busy" @click="emit('cancel')">Cancel</button>
          <button
            class="primary-button primary-button--compact"
            type="button"
            :disabled="busy || !editDraft.trim()"
            @click="emit('submit-edit', { body: editDraft, commentId: comment.id })"
          >
            {{ busy ? 'Saving…' : 'Save edit' }}
          </button>
        </div>
      </div>
    </article>

    <ul v-if="comment.children?.length" class="rq-thread">
      <RequirementsComment
        v-for="child in comment.children"
        :key="child.id"
        :busy-id="busyId"
        :can-comment="canComment"
        :can-vote="canVote"
        :comment="child"
        :comments-open="commentsOpen"
        :editing-id="editingId"
        :labels="labels"
        :mentionables="mentionables"
        :replying-to-id="replyingToId"
        @begin-edit="emit('begin-edit', $event)"
        @begin-reply="emit('begin-reply', $event)"
        @cancel="emit('cancel')"
        @remove="emit('remove', $event)"
        @submit-edit="emit('submit-edit', $event)"
        @submit-reply="emit('submit-reply', $event)"
        @vote="emit('vote', $event)"
      />
    </ul>
  </li>
</template>
