<script setup>
import { computed, nextTick, onMounted, ref, useId, watch } from 'vue';
import { RouterLink } from 'vue-router';

import RequirementsCommentBody from '../RequirementsCommentBody.vue';
import RequirementsCommentEditor from '../RequirementsCommentEditor.vue';
import { categoryLabel } from '../../../lib/requirements/annotation-layers.js';
import { annotationStatusLabel, elementHintLabel, isEditableAnnotation, personColor, threadTree } from '../../../lib/requirements/review-annotations.js';
import { describeRequirementsError } from '../../../lib/requirements/requirements-errors.js';
import { formatDateTime } from '../../../lib/requirements/requirements-time.js';
import { useMarksLink, useReviewSession } from '../../../lib/requirements/review-session.js';

// The thread on one mark: its comments and replies, the reviewer's own category, and the
// status actions the server allows (resolve, reopen, carry forward, close). It sits in the
// mark's popover on wide screens, below the canvas on phones, and beside the mark's picture
// in the team's Marks and comments view (`page`), where comments show the labels Odin's
// summaries cite them by.
const props = defineProps({
  annotation: { required: true, type: Object },
  // Comment id -> label (C1, C2, ...).
  commentLabels: { default: () => ({}), type: Object },
  // A mark the reviewer just drew: the composer opens, and Cancel removes the mark.
  fresh: { default: false, type: Boolean },
  // A comment to point out, such as one an Odin summary cites.
  highlightId: { default: '', type: String },
  number: { default: null, type: Number },
  variant: { default: 'popover', type: String },
});

const emit = defineEmits(['close', 'discard']);

const session = useReviewSession();
const marksLink = useMarksLink();
const root = ref(null);
const composerField = ref(null);
const draft = ref('');
const replyTo = ref('');
const editingId = ref('');
const editDraft = ref('');
const busy = ref('');
const error = ref('');
const status = ref('');
const ids = useId();

const readOnly = computed(() => session.readOnly());
const dimensions = computed(() => session.state.content?.dimensions ?? []);
const labels = computed(() => Object.fromEntries(dimensions.value.map((dimension) => [dimension.key, dimension.label])));
const editable = computed(() => isEditableAnnotation(props.annotation, { readOnly: readOnly.value }));
const actions = computed(() => (readOnly.value ? {} : props.annotation.actions ?? {}));
const canComment = computed(() => !readOnly.value && (props.annotation.localOnly || actions.value.comment));
const tree = computed(() => threadTree(props.annotation.thread ?? []));
const empty = computed(() => !(props.annotation.thread ?? []).length);
const author = computed(() => (props.annotation.isMine ? 'You' : props.annotation.authorName || 'Reviewer'));
const statusLabel = computed(() => annotationStatusLabel(props.annotation.status));
const hint = computed(() => elementHintLabel(props.annotation.elementHint));
const color = computed(() => props.annotation.color || props.annotation.shapes?.[0]?.style?.color || personColor(props.annotation.authorRef));
const versionLine = computed(() => {
  const parts = [];
  if (props.annotation.packageVersion) parts.push(`v${props.annotation.packageVersion}`);
  if (props.annotation.createdAt) parts.push(formatDateTime(props.annotation.createdAt));
  return parts.join(' · ');
});
const heading = computed(() => (empty.value && editable.value ? 'New comment' : `Mark ${props.number ?? props.annotation.number ?? ''}`.trim()));
const composerLabel = computed(() => (replyTo.value ? 'Reply' : empty.value ? 'Comment on this mark' : 'Reply to this thread'));

function focusFirst() {
  nextTick(() => {
    // Below the screen on a phone, the thread scrolls clear of the pinned verdict sheet first.
    if (props.variant === 'panel') root.value?.scrollIntoView?.({ block: 'center' });
    if (composerField.value && (props.fresh || props.variant === 'popover')) composerField.value.focus({ preventScroll: true });
    else root.value?.focus({ preventScroll: true });
  });
}

defineExpose({ focus: focusFirst });

onMounted(() => {
  if (props.fresh) focusFirst();
});

/** People this reviewer may tag in the thread, for the comment boxes' @ picker. */
function loadMentionables() {
  return session.mentionables(props.annotation.id);
}

watch(() => props.annotation.id, () => {
  draft.value = '';
  replyTo.value = '';
  editingId.value = '';
  error.value = '';
});

async function run(name, action, done) {
  if (busy.value) return;
  busy.value = name;
  error.value = '';
  try {
    await action();
    if (done) status.value = done;
  } catch (caught) {
    error.value = describeRequirementsError(caught, 'That didn’t save. Try again.').message;
  } finally {
    busy.value = '';
  }
}

function post() {
  const body = draft.value.trim();
  if (!body) return;
  const parentCommentId = replyTo.value;
  run('post', async () => {
    await session.addComment(props.annotation.id, { body, parentCommentId });
    draft.value = '';
    replyTo.value = '';
  }, parentCommentId ? 'Reply posted.' : 'Comment posted.');
}

function startReply(commentId) {
  replyTo.value = commentId;
  editingId.value = '';
  nextTick(() => composerField.value?.focus());
}

function startEdit(comment) {
  editingId.value = comment.id;
  editDraft.value = comment.body;
  replyTo.value = '';
}

function saveEdit(commentId) {
  const body = editDraft.value.trim();
  if (!body) return;
  run('edit', async () => {
    await session.editComment(props.annotation.id, commentId, { body });
    editingId.value = '';
  }, 'Comment updated.');
}

function removeComment(commentId) {
  run('remove', () => session.deleteComment(props.annotation.id, commentId), 'Comment removed.');
}

function setStatus(next) {
  run('status', () => session.setAnnotationStatus(props.annotation.id, next), next === 'resolved' ? 'Mark resolved.' : 'Mark reopened.');
}

function carry() {
  run('carry', () => session.carryAnnotation(props.annotation.id), 'Carried forward to this version.');
}

function closeOutdated() {
  run('close', () => session.closeAnnotation(props.annotation.id), 'Mark closed.');
}

function removeMark() {
  run('delete', async () => {
    session.deleteAnnotation(props.annotation.id);
    emit('close');
  });
}

function cancel() {
  if (props.fresh && empty.value && editable.value) emit('discard');
  else emit('close');
}

function onKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    emit('close');
  }
}

function setCategory(event) {
  session.setCategory(props.annotation.id, event.target.value);
}

function commentAuthor(comment) {
  return comment.isMine ? 'You' : comment.authorName || 'Reviewer';
}
</script>

<template>
  <section
    ref="root"
    class="rq-thread-card"
    :class="`rq-thread-card--${variant}`"
    tabindex="-1"
    :aria-labelledby="`${ids}-heading`"
    data-testid="rq-annotation-thread"
    @keydown="onKeydown"
  >
    <header class="rq-thread-card__head">
      <span class="rq-thread-card__pin" :style="{ '--c': color }" aria-hidden="true"><span>{{ number ?? annotation.number ?? '' }}</span></span>
      <h3 :id="`${ids}-heading`" class="rq-thread-card__title">
        <span class="visually-hidden">{{ heading }}, </span>{{ author }}
      </h3>
      <span v-if="annotation.category && !editable" class="rq-chip rq-chip--neutral">{{ categoryLabel(annotation.category, labels) }}</span>
      <span v-if="statusLabel" class="rq-chip" :class="annotation.status === 'outdated' ? 'rq-chip--warn' : 'rq-chip--neutral'">{{ statusLabel }}</span>
      <span class="rq-grow"></span>
      <span v-if="versionLine" class="rq-xs rq-muted">{{ versionLine }}</span>
      <RouterLink
        v-if="marksLink && !annotation.localOnly"
        class="rq-thread-card__close"
        :to="marksLink(annotation.id)"
        :aria-label="`Open mark ${number ?? annotation.number ?? ''} in Marks and comments`"
        title="Open in Marks and comments"
      >
        <i class="bi bi-box-arrow-up-right" aria-hidden="true"></i>
      </RouterLink>
      <button v-if="variant === 'popover'" class="rq-thread-card__close" type="button" aria-label="Close this thread" @click="emit('close')">
        <i class="bi bi-x-lg" aria-hidden="true"></i>
      </button>
    </header>

    <p v-if="annotation.roundId && annotation.status === 'outdated'" class="rq-xs rq-muted mb-0">
      From round {{ annotation.roundNumber ?? 'before' }}. The screen changed since, so this mark may no longer point at the right place.
    </p>
    <p v-if="hint || annotation.hintPending" class="rq-xs rq-muted mb-0 rq-thread-card__hint">
      <i class="bi bi-bullseye" aria-hidden="true"></i>
      <template v-if="hint">Attached to: {{ hint.name }}<template v-if="hint.odinId"> · <code>{{ hint.odinId }}</code></template></template>
      <template v-else>Finding the element under this mark…</template>
    </p>
    <p v-if="annotation.anchor?.snapshotUnavailable" class="rq-xs rq-muted mb-0">Snapshot unavailable. This mark is on a blank frame of the screen.</p>

    <div v-if="editable" class="rq-thread-card__category">
      <label :for="`${ids}-category`" class="rq-xs rq-muted">Category</label>
      <select :id="`${ids}-category`" class="form-select form-select-sm" :value="annotation.category ?? ''" @change="setCategory">
        <option value="">No category</option>
        <option v-for="dimension in dimensions" :key="dimension.key" :value="dimension.key">{{ dimension.label }}</option>
      </select>
    </div>

    <ul v-if="tree.length" class="rq-thread-card__comments">
      <li v-for="entry in tree" :key="entry.comment.id">
        <article
          class="rq-thread-comment"
          :class="{ 'rq-thread-comment--focus': highlightId === entry.comment.id }"
          :data-comment-id="entry.comment.id"
          tabindex="-1"
          :aria-label="`${commentAuthor(entry.comment)}, comment${commentLabels[entry.comment.id] ? ` ${commentLabels[entry.comment.id]}` : ''}`"
        >
          <div class="rq-comment__meta">
            <span v-if="commentLabels[entry.comment.id]" class="rq-source">{{ commentLabels[entry.comment.id] }}</span>
            <strong>{{ commentAuthor(entry.comment) }}</strong>
            <time v-if="entry.comment.createdAt" :datetime="entry.comment.createdAt">{{ formatDateTime(entry.comment.createdAt) }}</time>
            <span v-if="entry.comment.editedAt && !entry.comment.isDeleted">Edited</span>
          </div>
          <template v-if="editingId === entry.comment.id">
            <span :id="`${ids}-edit-${entry.comment.id}`" class="visually-hidden">Edit your comment</span>
            <RequirementsCommentEditor v-model="editDraft" :labelled-by="`${ids}-edit-${entry.comment.id}`" :mentionables="loadMentionables" min-height="3rem" @submit="saveEdit(entry.comment.id)" />
            <div class="rq-row rq-row--tight rq-thread-card__row-end">
              <button class="ghost-button ghost-button--compact" type="button" @click="editingId = ''">Cancel</button>
              <button class="primary-button primary-button--compact" type="button" :disabled="busy === 'edit' || !editDraft.trim()" @click="saveEdit(entry.comment.id)">Save</button>
            </div>
          </template>
          <p v-else-if="entry.comment.isDeleted" class="rq-thread-comment__body">Comment removed.</p>
          <RequirementsCommentBody v-else class="rq-thread-comment__body" :body="entry.comment.body" />
          <div v-if="!entry.comment.isDeleted && editingId !== entry.comment.id && canComment" class="rq-comment__actions">
            <button class="rq-text-action" type="button" :aria-label="`Reply to ${commentAuthor(entry.comment)}`" @click="startReply(entry.comment.id)">Reply</button>
            <template v-if="entry.comment.isMine">
              <button class="rq-text-action" type="button" aria-label="Edit your comment" @click="startEdit(entry.comment)">Edit</button>
              <button class="rq-text-action rq-text-action--danger" type="button" aria-label="Delete your comment" :disabled="busy === 'remove'" @click="removeComment(entry.comment.id)">Delete</button>
            </template>
          </div>
        </article>
        <ul v-if="entry.replies.length" class="rq-thread-card__replies">
          <li v-for="reply in entry.replies" :key="reply.id">
            <article
              class="rq-thread-comment rq-thread-comment--reply"
              :class="{ 'rq-thread-comment--focus': highlightId === reply.id }"
              :data-comment-id="reply.id"
              tabindex="-1"
              :aria-label="`${commentAuthor(reply)}, reply${commentLabels[reply.id] ? ` ${commentLabels[reply.id]}` : ''}`"
            >
              <div class="rq-comment__meta">
                <span v-if="commentLabels[reply.id]" class="rq-source">{{ commentLabels[reply.id] }}</span>
                <strong>{{ commentAuthor(reply) }}</strong>
                <time v-if="reply.createdAt" :datetime="reply.createdAt">{{ formatDateTime(reply.createdAt) }}</time>
                <span v-if="reply.editedAt && !reply.isDeleted">Edited</span>
              </div>
              <template v-if="editingId === reply.id">
                <span :id="`${ids}-edit-${reply.id}`" class="visually-hidden">Edit your reply</span>
                <RequirementsCommentEditor v-model="editDraft" :labelled-by="`${ids}-edit-${reply.id}`" :mentionables="loadMentionables" min-height="3rem" @submit="saveEdit(reply.id)" />
                <div class="rq-row rq-row--tight rq-thread-card__row-end">
                  <button class="ghost-button ghost-button--compact" type="button" @click="editingId = ''">Cancel</button>
                  <button class="primary-button primary-button--compact" type="button" :disabled="busy === 'edit' || !editDraft.trim()" @click="saveEdit(reply.id)">Save</button>
                </div>
              </template>
              <p v-else-if="reply.isDeleted" class="rq-thread-comment__body">Comment removed.</p>
              <RequirementsCommentBody v-else class="rq-thread-comment__body" :body="reply.body" />
              <div v-if="!reply.isDeleted && reply.isMine && editingId !== reply.id && canComment" class="rq-comment__actions">
                <button class="rq-text-action" type="button" aria-label="Edit your reply" @click="startEdit(reply)">Edit</button>
                <button class="rq-text-action rq-text-action--danger" type="button" aria-label="Delete your reply" :disabled="busy === 'remove'" @click="removeComment(reply.id)">Delete</button>
              </div>
            </article>
          </li>
        </ul>
      </li>
    </ul>
    <p v-else-if="!canComment" class="rq-xs rq-muted mb-0">No comments on this mark.</p>

    <form v-if="canComment" class="rq-thread-card__composer" novalidate @submit.prevent="post">
      <span :id="`${ids}-composer`" class="visually-hidden">{{ composerLabel }}</span>
      <p v-if="replyTo" class="rq-xs rq-muted mb-0">
        Replying in this thread · <button class="rq-text-action" type="button" @click="replyTo = ''">Cancel reply</button>
      </p>
      <div class="rq-thread-card__compose-row">
        <RequirementsCommentEditor
          ref="composerField"
          v-model="draft"
          class="rq-thread-card__input-wrap"
          :labelled-by="`${ids}-composer`"
          :mentionables="loadMentionables"
          min-height="4.5rem"
          :placeholder="empty ? 'What should the team know here? Type @ to tag someone.' : 'Reply… Type @ to tag someone.'"
          submit-on-enter
          @submit="post"
        />
        <button
          class="primary-button primary-button--compact rq-thread-card__send"
          type="submit"
          :disabled="busy === 'post' || !draft.trim()"
          :aria-label="empty ? 'Post comment' : 'Send reply'"
        >
          <i class="bi bi-send-fill" aria-hidden="true"></i>
        </button>
      </div>
      <div v-if="fresh && empty && editable" class="rq-row rq-row--between">
        <button class="ghost-button ghost-button--compact" type="button" @click="cancel">Cancel</button>
        <span class="rq-xs rq-muted">Enter posts · Shift+Enter adds a line</span>
      </div>
    </form>

    <div v-if="actions.changeStatus || actions.carry || actions.close || actions.delete" class="rq-thread-card__actions">
      <button v-if="actions.changeStatus && annotation.status !== 'resolved' && !annotation.localOnly" class="ghost-button ghost-button--compact" type="button" :disabled="Boolean(busy)" @click="setStatus('resolved')">
        <i class="bi bi-check2-circle" aria-hidden="true"></i>Resolve
      </button>
      <button v-if="actions.changeStatus && annotation.status === 'resolved'" class="ghost-button ghost-button--compact" type="button" :disabled="Boolean(busy)" @click="setStatus('open')">
        <i class="bi bi-arrow-counterclockwise" aria-hidden="true"></i>Reopen
      </button>
      <button v-if="actions.carry" class="ghost-button ghost-button--compact" type="button" :disabled="Boolean(busy)" @click="carry">
        <i class="bi bi-arrow-right-circle" aria-hidden="true"></i>Carry forward
      </button>
      <button v-if="actions.close" class="ghost-button ghost-button--compact" type="button" :disabled="Boolean(busy)" @click="closeOutdated">
        <i class="bi bi-x-circle" aria-hidden="true"></i>Close
      </button>
      <button v-if="actions.delete && !annotation.isMine" class="ghost-button ghost-button--compact ghost-button--danger" type="button" :disabled="Boolean(busy)" @click="removeMark">
        <i class="bi bi-trash3" aria-hidden="true"></i>Delete mark
      </button>
      <!-- The phone toolbar has no Delete; the reviewer's own mark is removed here, through the editor so Undo works. -->
      <button v-else-if="variant === 'panel' && editable" class="ghost-button ghost-button--compact ghost-button--danger" type="button" @click="emit('discard')">
        <i class="bi bi-trash3" aria-hidden="true"></i>Delete mark
      </button>
    </div>

    <p v-if="error" class="error-banner mb-0" role="alert">{{ error }}</p>
    <p class="visually-hidden" role="status">{{ status }}</p>
  </section>
</template>
