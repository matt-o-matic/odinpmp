<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';

import RequirementsComment from '../RequirementsComment.vue';
import RequirementsConfirmDialog from '../RequirementsConfirmDialog.vue';
import RequirementsCommentEditor from '../RequirementsCommentEditor.vue';
import RequirementsSummaryPanel from '../RequirementsSummaryPanel.vue';
import { apiClient } from '../../../lib/auth/index.js';
import { focusForNow } from '../../../lib/ui/focus-origin.js';
import { usePortal } from '../../../lib/requirements/portal-context.js';
import { decisionLine, isLinkProblem, questionStateLabel } from '../../../lib/requirements/portal-view.js';
import { describeRequirementsError, QUESTION_REMOVED_MESSAGE, requirementsErrorCode } from '../../../lib/requirements/requirements-errors.js';
import { batchTouchesQuestion } from '../../../lib/requirements/review-live.js';
import { discussionStats, numberComments } from '../../../lib/requirements/requirements-sources.js';
import { plural, trackChipClass, trackLabel } from '../../../lib/requirements/requirements-tracks.js';
import RequirementsDecisionStatement from '../RequirementsDecisionStatement.vue';

// One question in the portal: the prompt, the discussion with numbered sources, the Odin
// summary (names only), and the decision once recorded. Stakeholders comment, reply, vote,
// and edit or delete their own comments. They never change a question's status (Q-04).
const route = useRoute();
const { liveBatch, reportProblem, token } = usePortal();

const topic = ref(null);
const loading = ref(true);
const notFound = ref(false);
// The team deleted or dismissed this question, before the page opened or while it was open.
const removed = ref(false);
const loadError = ref('');
const composer = ref('');
const composerField = ref(null);
const posting = ref(false);
const composerError = ref('');
const replyingToId = ref('');
const editingId = ref('');
const busyCommentId = ref('');
const commentError = ref('');
const threadStatus = ref('');
const removeCommentId = ref('');
const removing = ref(false);
const removeError = ref('');
const activeJump = ref('');

const topicId = computed(() => String(route.params.topicId ?? ''));
const numbering = computed(() => numberComments(topic.value?.comments ?? []));
const people = computed(() => ({ comments: topic.value?.comments ?? [], stakeholders: [], users: [] }));
const commentsOpen = computed(() => Boolean(topic.value?.commentsOpen));
const stats = computed(() => discussionStats(topic.value?.comments ?? []));
const decision = computed(() => topic.value?.decision ?? null);
const stateLabel = computed(() => questionStateLabel(topic.value));
const homeLink = computed(() => ({ name: 'requirements-portal', params: { token: token.value } }));

let sequence = 0;
async function load({ passive = false } = {}) {
  const current = ++sequence;
  if (!passive) loading.value = true;
  try {
    const client = passive ? apiClient.passive : apiClient;
    const result = await client.getRequirementsPortalTopic(token.value, topicId.value);
    if (current !== sequence) return;
    topic.value = result.topic ?? null;
    notFound.value = false;
    removed.value = false;
    loadError.value = '';
  } catch (error) {
    if (current !== sequence) return;
    if (isLinkProblem(error)) reportProblem(error);
    else if (isRemoved(error)) markRemoved();
    else if (Number(error?.status) === 404) notFound.value = true;
    else if (!passive) loadError.value = describeRequirementsError(error, 'Unable to load this question.').message;
  } finally {
    if (current === sequence) loading.value = false;
  }
}

function isRemoved(error) {
  return requirementsErrorCode(error) === 'question_removed';
}

function markRemoved() {
  topic.value = null;
  removed.value = true;
  removeCommentId.value = '';
}

watch(topicId, () => {
  topic.value = null;
  removed.value = false;
  composer.value = '';
  replyingToId.value = '';
  editingId.value = '';
  load();
}, { immediate: true });

watch(liveBatch, (batch) => {
  if (batchTouchesQuestion(batch, topicId.value)) load({ passive: true });
});

function apply(result) {
  if (result?.topic) topic.value = result.topic;
}

function handleError(error, fallback) {
  if (isLinkProblem(error)) {
    reportProblem(error);
    return '';
  }
  if (isRemoved(error)) {
    markRemoved();
    return '';
  }
  return describeRequirementsError(error, fallback).message;
}

/** People on this question the stakeholder may tag. */
async function loadMentionables() {
  const result = await apiClient.listRequirementsPortalTopicMentionables(token.value, topicId.value);
  return result.people ?? [];
}

async function postComment() {
  const body = composer.value.trim();
  if (!body || posting.value) return;
  posting.value = true;
  composerError.value = '';
  try {
    apply(await apiClient.commentRequirementsPortalTopic(token.value, topicId.value, { body, parentCommentId: '' }));
    composer.value = '';
    threadStatus.value = 'Comment posted.';
  } catch (error) {
    composerError.value = handleError(error, 'Your comment didn’t post. Try again.');
  } finally {
    posting.value = false;
  }
}

async function runCommentAction(commentId, action, fallback) {
  busyCommentId.value = commentId;
  commentError.value = '';
  try {
    apply(await action());
    return true;
  } catch (error) {
    commentError.value = handleError(error, fallback);
    return false;
  } finally {
    busyCommentId.value = '';
  }
}

async function submitReply({ body, commentId }) {
  const ok = await runCommentAction(commentId, () => apiClient.commentRequirementsPortalTopic(token.value, topicId.value, { body: body.trim(), parentCommentId: commentId }), 'Your reply didn’t post.');
  if (ok) {
    replyingToId.value = '';
    threadStatus.value = 'Reply posted.';
  }
}

async function submitEdit({ body, commentId }) {
  const ok = await runCommentAction(commentId, () => apiClient.updateRequirementsPortalComment(token.value, topicId.value, commentId, { body: body.trim() }), 'Your edit didn’t save.');
  if (ok) {
    editingId.value = '';
    threadStatus.value = 'Comment updated.';
  }
}

function vote({ commentId, vote: value }) {
  runCommentAction(commentId, () => apiClient.voteRequirementsPortalComment(token.value, topicId.value, commentId, { vote: value }), 'Your vote didn’t save.');
}

async function confirmRemove() {
  if (removing.value || !removeCommentId.value) return;
  removing.value = true;
  removeError.value = '';
  try {
    apply(await apiClient.deleteRequirementsPortalComment(token.value, topicId.value, removeCommentId.value));
    removeCommentId.value = '';
    threadStatus.value = 'Comment deleted.';
  } catch (error) {
    removeError.value = handleError(error, 'Your comment wasn’t deleted. Try again.');
  } finally {
    removing.value = false;
  }
}

function focusComment(commentId) {
  const element = commentId ? document.getElementById(`rq-comment-${commentId}`) : null;
  if (!element) return;
  focusForNow(element, { preventScroll: true });
  element.scrollIntoView({ block: 'center' });
}

async function askGroup(question) {
  composer.value = String(question ?? '');
  await nextTick();
  composerField.value?.focus();
}

function jumpTo(section) {
  activeJump.value = section;
  document.getElementById(`rq-portal-${section}-heading`)?.focus({ preventScroll: true });
  document.getElementById(`rq-portal-${section}`)?.scrollIntoView({ block: 'start' });
}
</script>

<template>
  <div class="rq-portal-page rq-stack rq-topic">
    <nav v-if="topic" class="rq-jumpbar" aria-label="Jump to section">
      <a
        v-for="link in [
          { id: 'discussion', icon: 'bi-chat-left-text', label: 'Discussion' },
          { id: 'summary', icon: 'bi-list-check', label: 'Summary' },
          { id: 'decision', icon: 'bi-check2-square', label: 'Decision' },
        ]"
        :key="link.id"
        class="rq-jump"
        :class="{ 'rq-jump--on': activeJump === link.id }"
        :href="`#rq-portal-${link.id}`"
        @click.prevent="jumpTo(link.id)"
      ><i class="bi" :class="link.icon" aria-hidden="true"></i>{{ link.label }}</a>
    </nav>

    <RouterLink class="rq-portal-back" :to="homeLink"><i class="bi bi-arrow-left" aria-hidden="true"></i>All your questions and reviews</RouterLink>

    <div v-if="removed" class="rq-empty">
      <h1 class="rq-title rq-title--md" tabindex="-1">{{ QUESTION_REMOVED_MESSAGE }}</h1>
    </div>
    <div v-else-if="notFound" class="rq-empty">
      <h1 class="rq-title rq-title--md" tabindex="-1">This question isn’t available</h1>
      <p class="rq-small">It may have been removed, or it’s no longer shared with you.</p>
    </div>
    <div v-else-if="loadError && !topic" class="error-banner rq-row rq-row--between" role="alert">
      <span>{{ loadError }}</span>
      <button class="ghost-button ghost-button--compact" type="button" @click="load()">Try again</button>
    </div>
    <p v-else-if="loading && !topic" class="rq-small rq-muted" role="status">Loading the question…</p>

    <template v-if="topic">
      <header class="rq-topic-head__main">
        <div class="rq-row rq-row--tight rq-row--wrap">
          <span class="rq-chip" :class="trackChipClass(topic.track)">{{ trackLabel(topic.track) }}</span>
          <span class="rq-chip" :class="decision ? 'rq-chip--ok' : 'rq-chip--neutral'">{{ stateLabel }}</span>
          <span v-if="topic.isAssignedToMe" class="rq-xs rq-muted">{{ topic.assignmentRole === 'primary' ? 'You own this question' : topic.assignmentRole === 'required' ? 'Your answer is required' : 'Assigned to you' }}</span>
        </div>
        <h1 class="rq-title rq-title--lg" tabindex="-1">{{ topic.prompt }}</h1>
        <p v-if="topic.rationale" class="rq-small rq-muted mb-0">{{ topic.rationale }}</p>
        <p v-if="topic.settles" class="rq-xs rq-muted mb-0">Settles: {{ topic.settles }}</p>
      </header>

      <div class="rq-topic-grid">
        <section id="rq-portal-discussion" class="rq-panel rq-stack rq-section" aria-labelledby="rq-portal-discussion-heading">
          <div class="rq-row rq-row--between rq-row--wrap">
            <h2 id="rq-portal-discussion-heading" class="rq-eyebrow rq-section-heading" tabindex="-1">Discussion</h2>
            <span class="rq-xs rq-muted">{{ plural(stats.contributions, 'comment') }} · {{ plural(stats.people, 'person', 'people') }}</span>
          </div>
          <p v-if="!topic.comments?.length" class="rq-small rq-muted mb-0">No comments yet. Yours can be the first.</p>
          <ul v-else class="rq-thread">
            <RequirementsComment
              v-for="comment in topic.comments"
              :key="comment.id"
              :busy-id="busyCommentId"
              :can-comment="commentsOpen"
              :can-vote="true"
              :comment="comment"
              :comments-open="commentsOpen"
              :editing-id="editingId"
              :labels="numbering.labelById"
              :mentionables="loadMentionables"
              :replying-to-id="replyingToId"
              @begin-edit="editingId = $event; replyingToId = ''"
              @begin-reply="replyingToId = $event; editingId = ''"
              @cancel="replyingToId = ''; editingId = ''"
              @remove="removeCommentId = $event; removeError = ''"
              @submit-edit="submitEdit"
              @submit-reply="submitReply"
              @vote="vote"
            />
          </ul>
          <p v-if="commentError" class="error-banner mb-0" role="alert">{{ commentError }}</p>
          <p class="visually-hidden" role="status">{{ threadStatus }}</p>

          <form v-if="commentsOpen" class="rq-stack rq-stack--sm" novalidate @submit.prevent="postComment">
            <span id="rq-portal-composer-label" class="rq-xs rq-muted">Add to the discussion</span>
            <RequirementsCommentEditor ref="composerField" v-model="composer" labelled-by="rq-portal-composer-label" :mentionables="loadMentionables" @submit="postComment" />
            <p v-if="composerError" class="error-banner mb-0" role="alert">{{ composerError }}</p>
            <div class="d-flex justify-content-end">
              <button class="primary-button primary-button--compact" type="submit" :disabled="posting || !composer.trim()">
                <i class="bi bi-send-fill me-1" aria-hidden="true"></i>{{ posting ? 'Posting…' : 'Post comment' }}
              </button>
            </div>
          </form>
          <p v-else class="rq-small rq-muted mb-0">Comments are closed for this question.</p>
        </section>

        <aside class="rq-topic-rail" aria-label="Summary and decision">
          <section id="rq-portal-summary" class="rq-panel rq-section" aria-labelledby="rq-portal-summary-heading">
            <RequirementsSummaryPanel
              :can-ask="commentsOpen"
              heading-id="rq-portal-summary-heading"
              :numbering="numbering"
              :people="people"
              :status="topic.summaryStatus ?? null"
              :summary="topic.summary ?? null"
              @ask="askGroup"
              @cite="focusComment"
            />
          </section>
          <section id="rq-portal-decision" class="rq-panel rq-section rq-stack rq-stack--sm" aria-labelledby="rq-portal-decision-heading">
            <h2 id="rq-portal-decision-heading" class="rq-eyebrow rq-section-heading" tabindex="-1">Decision</h2>
            <template v-if="decision">
              <RequirementsDecisionStatement class="rq-small" :statement="decision.statement" />
              <p class="rq-xs rq-muted mb-0">{{ decisionLine(decision) }}</p>
              <p v-if="commentsOpen" class="rq-xs mb-0">Disagree? Say so in the discussion. The team sees every comment.</p>
            </template>
            <p v-else class="rq-small rq-muted mb-0">No decision yet. The project team records it once the discussion is ready.</p>
          </section>
        </aside>
      </div>
    </template>

    <RequirementsConfirmDialog
      :busy="removing"
      confirm-label="Delete comment"
      :error="removeError"
      :open="Boolean(removeCommentId)"
      title="Delete this comment?"
      @close="removeCommentId = ''"
      @confirm="confirmRemove"
    >
      <p class="mb-0">Your comment is removed from the discussion for everyone.</p>
    </RequirementsConfirmDialog>
  </div>
</template>
