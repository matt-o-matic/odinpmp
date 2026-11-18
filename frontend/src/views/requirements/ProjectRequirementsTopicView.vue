<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import RequirementsAvatar from '../../components/requirements/RequirementsAvatar.vue';
import RequirementsComment from '../../components/requirements/RequirementsComment.vue';
import RequirementsConfirmDialog from '../../components/requirements/RequirementsConfirmDialog.vue';
import RequirementsDecisionBox from '../../components/requirements/RequirementsDecisionBox.vue';
import RequirementsCommentEditor from '../../components/requirements/RequirementsCommentEditor.vue';
import RequirementsSourceChips from '../../components/requirements/RequirementsSourceChips.vue';
import RequirementsSummaryPanel from '../../components/requirements/RequirementsSummaryPanel.vue';
import RequirementsTopicFormDialog from '../../components/requirements/RequirementsTopicFormDialog.vue';
import { apiClient } from '../../lib/auth/index.js';
import { canPreviewFile, openFile as showFile, saveBlob } from '../../lib/projects/project-files.js';
import { focusForNow } from '../../lib/ui/focus-origin.js';
import { useRequirementsWorkspace } from '../../lib/requirements/requirements-context.js';
import { describeRequirementsError } from '../../lib/requirements/requirements-errors.js';
import { batchTouchesTopic } from '../../lib/requirements/requirements-live-updates.js';
import { showDecisionForm } from '../../lib/requirements/requirements-permissions.js';
import { blockingOutstandingCount, discussionStats, numberComments } from '../../lib/requirements/requirements-sources.js';
import { describeSummaryRefreshError, describeSummaryRefreshOutcome } from '../../lib/requirements/requirements-summary-status.js';
import { formatShortDate } from '../../lib/requirements/requirements-time.js';
import {
  activeTopicDecision,
  chipToneClass,
  decisionChip,
  mergeTopicUpdate,
  topicPeople,
  topicSettled,
  topicStateChip,
} from '../../lib/requirements/requirements-topics.js';
import { briefRefLabel, plural, REQUIREMENTS_TRACKS, trackChipClass, trackIcon, trackLabel } from '../../lib/requirements/requirements-tracks.js';
import RequirementsDecisionStatement from '../../components/requirements/RequirementsDecisionStatement.vue';

const route = useRoute();
const router = useRouter();
const workspace = useRequirementsWorkspace();

const topicId = computed(() => String(route.params.topicId ?? ''));
const topic = ref(null);
const loading = ref(true);
const loadError = ref('');
const notFound = ref(false);

const composer = ref('');
const composerField = ref(null);
const posting = ref(false);
const composerError = ref('');
const threadStatus = ref('');
const replyingToId = ref('');
const editingId = ref('');
const busyCommentId = ref('');
const commentError = ref('');

const editOpen = ref(false);
// Which tab the Edit dialog opens on: 'details' or 'people'.
const editTab = ref('details');
const deleteOpen = ref(false);
const deleting = ref(false);
const deleteError = ref('');
const moveOpen = ref(false);
const moving = ref(false);
const moveError = ref('');
const openingFileId = ref('');
const fileError = ref('');
const removeCommentId = ref('');
const removingComment = ref(false);
const removeError = ref('');
const replacing = ref(false);
const decisionNotice = ref('');
const statusBusy = ref(false);
const activeJump = ref('');
const decisionBox = ref(null);
const refreshingSummary = ref(false);
const summaryRefreshResult = ref(null);

const abilities = computed(() => workspace.abilities.value);
const projectId = computed(() => workspace.projectId.value);
const numbering = computed(() => numberComments(topic.value?.comments ?? []));
const people = computed(() => ({
  comments: topic.value?.comments ?? [],
  stakeholders: workspace.stakeholders.value,
  users: workspace.validUsers.value,
}));
const stats = computed(() => discussionStats(topic.value?.comments ?? []));
const assignees = computed(() => (topic.value ? topicPeople(topic.value) : { others: [], owner: null }));
const stateChip = computed(() => topicStateChip(topic.value ?? {}, { long: true }));
const activeDecision = computed(() => activeTopicDecision(topic.value?.decisions ?? []));
const activeDecisionChip = computed(() => (activeDecision.value ? decisionChip(activeDecision.value) : null));
const decisionFormVisible = computed(() => showDecisionForm({
  abilities: abilities.value,
  activeDecision: activeDecision.value,
  replacing: replacing.value,
  topic: topic.value,
}));
// Once decided, the summary's open items no longer hold the decision up, so the Decision link drops its badge.
const blocking = computed(() => (topicSettled(topic.value)
  ? 0
  : blockingOutstandingCount(topic.value?.summary?.output ?? null)));
const canComment = computed(() => abilities.value.comment && Boolean(topic.value?.commentsOpen));
const track = computed(() => topic.value?.track ?? '');
const trackLocation = computed(() => ({
  name: 'project-requirements-track',
  params: { projectId: projectId.value, stage: 'discuss', track: track.value || 'experience' },
}));
const otherTrack = computed(() => REQUIREMENTS_TRACKS.find((item) => item !== track.value) ?? '');
const settlesLine = computed(() => {
  const parts = [];
  if (topic.value?.settles) parts.push(`Settles: ${topic.value.settles}`);
  const label = briefRefLabel(topic.value?.sourceRef);
  if (label) parts.push(`from brief ${label.charAt(0).toLowerCase()}${label.slice(1)}`);
  return parts.join(' · ');
});
const addedBy = computed(() => {
  const creator = topic.value?.createdBy;
  if (!creator) return '';
  if (creator.name) return creator.name;
  return workspace.validUsers.value.find((user) => String(user.id) === String(creator.id))?.name ?? '';
});
const discussionLine = computed(() => {
  const parts = [plural(stats.value.contributions, 'contribution'), plural(stats.value.people, 'person', 'people')];
  if (stats.value.contributions > 0) parts.push('sources numbered for citations');
  return parts.join(' · ');
});

let loadSequence = 0;
async function load({ passive = false } = {}) {
  const id = topicId.value;
  if (!id || !projectId.value) return;
  const current = ++loadSequence;
  if (!passive) loading.value = true;
  try {
    const client = passive ? apiClient.passive : apiClient;
    const result = await client.getRequirementsTopic(projectId.value, id, workspace.token());
    if (current !== loadSequence) return;
    topic.value = result.topic ?? null;
    loadError.value = '';
    notFound.value = false;
  } catch (error) {
    if (current !== loadSequence) return;
    if (error?.status === 404) notFound.value = true;
    else loadError.value = describeRequirementsError(error, 'Unable to load this topic.').message;
  } finally {
    if (current === loadSequence) loading.value = false;
  }
}

function applyUpdate(updated) {
  const { stale, topic: merged } = mergeTopicUpdate(topic.value, updated);
  topic.value = merged;
  if (stale) load({ passive: true });
}

async function applyFocusIntent() {
  const focus = String(route.query.focus ?? '');
  if (!focus || !topic.value) return;
  await nextTick();
  if (focus === 'decision') {
    if (decisionFormVisible.value) decisionBox.value?.focusStatement();
    else document.getElementById('rq-decision-heading')?.focus();
  } else if (focus === 'reply' && canComment.value) {
    composerField.value?.focus();
  }
}

watch(
  topicId,
  async () => {
    topic.value = null;
    notFound.value = false;
    loadError.value = '';
    composer.value = '';
    replyingToId.value = '';
    editingId.value = '';
    replacing.value = false;
    decisionNotice.value = '';
    activeJump.value = '';
    summaryRefreshResult.value = null;
    await load();
    await applyFocusIntent();
  },
  { immediate: true },
);

watch(workspace.liveBatch, (batch) => {
  if (batchTouchesTopic(batch, topicId.value)) load({ passive: true });
});

function token() {
  return workspace.token();
}

// Runs the Odin summary now. A failed run keeps the previous summary; the response says
// which happened, and the topic takes the summary and status it returns.
async function refreshSummary() {
  if (refreshingSummary.value || !topic.value) return;
  const id = topicId.value;
  refreshingSummary.value = true;
  summaryRefreshResult.value = null;
  try {
    const result = await apiClient.refreshRequirementsTopicSummary(projectId.value, id, token());
    if (id !== topicId.value || !topic.value) return;
    topic.value = {
      ...topic.value,
      summary: result.summary === undefined ? topic.value.summary : result.summary,
      summaryStatus: result.summaryStatus ?? topic.value.summaryStatus,
    };
    summaryRefreshResult.value = describeSummaryRefreshOutcome(result);
    if (result.outcome === 'ok') workspace.refreshShared();
  } catch (error) {
    if (id === topicId.value) summaryRefreshResult.value = describeSummaryRefreshError(error);
  } finally {
    refreshingSummary.value = false;
  }
}

/** People this member may tag on the topic, for the comment boxes' @ picker. */
async function loadMentionables() {
  const result = await apiClient.listRequirementsTopicMentionables(projectId.value, topicId.value, token());
  return result.people ?? [];
}

async function postComment() {
  const body = composer.value.trim();
  if (!body || posting.value) return;
  posting.value = true;
  composerError.value = '';
  try {
    const result = await apiClient.commentRequirementsTopic(projectId.value, topicId.value, { body }, token());
    applyUpdate(result.topic);
    composer.value = '';
    threadStatus.value = 'Comment posted.';
    workspace.refreshShared();
  } catch (error) {
    composerError.value = describeRequirementsError(error, 'Unable to post the comment.').message;
  } finally {
    posting.value = false;
  }
}

async function runCommentAction(commentId, action, fallback) {
  busyCommentId.value = commentId;
  commentError.value = '';
  try {
    const result = await action();
    applyUpdate(result.topic);
    return true;
  } catch (error) {
    commentError.value = describeRequirementsError(error, fallback).message;
    return false;
  } finally {
    busyCommentId.value = '';
  }
}

async function submitReply({ body, commentId }) {
  const ok = await runCommentAction(
    commentId,
    () => apiClient.commentRequirementsTopic(projectId.value, topicId.value, { body: body.trim(), parentCommentId: commentId }, token()),
    'Unable to post the reply.',
  );
  if (ok) {
    replyingToId.value = '';
    threadStatus.value = 'Reply posted.';
  }
}

async function submitEdit({ body, commentId }) {
  const ok = await runCommentAction(
    commentId,
    () => apiClient.updateRequirementsTopicComment(projectId.value, topicId.value, commentId, { body: body.trim() }, token()),
    'Unable to save the edit.',
  );
  if (ok) {
    editingId.value = '';
    threadStatus.value = 'Comment updated.';
  }
}

function vote({ commentId, vote: value }) {
  runCommentAction(
    commentId,
    () => apiClient.voteRequirementsTopicComment(projectId.value, topicId.value, commentId, { vote: value }, token()),
    'Unable to record your vote.',
  );
}

function beginReply(commentId) {
  editingId.value = '';
  replyingToId.value = commentId;
}

function beginEdit(commentId) {
  replyingToId.value = '';
  editingId.value = commentId;
}

function cancelInline() {
  replyingToId.value = '';
  editingId.value = '';
}

function askRemoveComment(commentId) {
  removeError.value = '';
  removeCommentId.value = commentId;
}

async function confirmRemoveComment() {
  if (removingComment.value || !removeCommentId.value) return;
  removingComment.value = true;
  removeError.value = '';
  try {
    const result = await apiClient.deleteRequirementsTopicComment(projectId.value, topicId.value, removeCommentId.value, token());
    applyUpdate(result.topic);
    removeCommentId.value = '';
    threadStatus.value = 'Comment removed.';
  } catch (error) {
    removeError.value = describeRequirementsError(error, 'Unable to remove the comment.').message;
  } finally {
    removingComment.value = false;
  }
}

async function confirmDeleteTopic() {
  if (deleting.value) return;
  deleting.value = true;
  deleteError.value = '';
  try {
    await apiClient.deleteRequirementsTopic(projectId.value, topicId.value, token());
    const destination = trackLocation.value;
    deleteOpen.value = false;
    workspace.showMessage('Topic deleted.', 'success', { survivesNavigation: true });
    workspace.refreshShared();
    await router.push(destination);
  } catch (error) {
    deleteError.value = describeRequirementsError(error, 'Unable to delete the topic.').message;
  } finally {
    deleting.value = false;
  }
}

async function confirmMoveTopic() {
  if (moving.value || !otherTrack.value) return;
  moving.value = true;
  moveError.value = '';
  try {
    const result = await apiClient.moveRequirementsTopic(projectId.value, topicId.value, otherTrack.value, token());
    applyUpdate(result.topic);
    moveOpen.value = false;
    workspace.showMessage(`Topic moved to ${trackLabel(result.topic?.track ?? otherTrack.value)}.`);
    workspace.refreshShared();
  } catch (error) {
    moveError.value = describeRequirementsError(error, 'Unable to move the topic.').message;
  } finally {
    moving.value = false;
  }
}

function fileSizeLabel(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function openFile(file) {
  if (openingFileId.value) return;
  openingFileId.value = file.id;
  fileError.value = '';
  try {
    if (canPreviewFile(file)) {
      await showFile(() => apiClient.getFileContent(file.id, token(), { version: file.version }), file);
    } else {
      const result = await apiClient.getFileContent(file.id, token(), { download: true, version: file.version });
      saveBlob(result.blob, file.fileName);
    }
  } catch (error) {
    fileError.value = describeRequirementsError(error, 'Unable to open the file.').message;
  } finally {
    openingFileId.value = '';
  }
}

async function setStatus(status) {
  if (statusBusy.value) return;
  statusBusy.value = true;
  try {
    const result = await apiClient.updateRequirementsTopic(projectId.value, topicId.value, { status }, token());
    applyUpdate(result.topic);
    workspace.showMessage(status === 'dismissed' ? 'Topic dismissed.' : 'Topic reopened.');
    workspace.refreshShared();
  } catch (error) {
    workspace.showMessage(describeRequirementsError(error, 'Unable to change the topic status.').message, 'error');
  } finally {
    statusBusy.value = false;
  }
}

function openEdit(tab = 'details') {
  editTab.value = tab;
  editOpen.value = true;
}

function handleEdited(updated, { peopleChanged = false } = {}) {
  editOpen.value = false;
  applyUpdate(updated);
  workspace.showMessage('Topic updated.');
  if (peopleChanged) workspace.refreshShared();
}

async function handleConflict(message) {
  replacing.value = false;
  decisionNotice.value = message;
  await load({ passive: true });
  await nextTick();
  document.getElementById('rq-decision-heading')?.focus();
}

async function handleRecorded() {
  replacing.value = false;
  decisionNotice.value = '';
  workspace.showMessage('Decision recorded.');
  workspace.refreshShared();
  await load({ passive: true });
  await nextTick();
  document.getElementById('rq-decision-heading')?.focus();
}

async function startReplace() {
  decisionNotice.value = '';
  replacing.value = true;
  await nextTick();
  decisionBox.value?.focusStatement();
}

async function cancelReplace() {
  replacing.value = false;
  await nextTick();
  document.getElementById('rq-decision-heading')?.focus();
}

function focusComment(commentId) {
  const element = commentId ? document.getElementById(`rq-comment-${commentId}`) : null;
  if (!element) return;
  focusForNow(element, { preventScroll: true });
  element.scrollIntoView({ block: 'center' });
  element.classList.remove('rq-comment--flash');
  void element.offsetWidth;
  element.classList.add('rq-comment--flash');
}

async function askGroup(question) {
  composer.value = String(question ?? '');
  await nextTick();
  composerField.value?.focus({ preventScroll: true });
  composerField.value?.scrollIntoView({ block: 'center' });
}

// Focus first, then scroll: focusing during a smooth scroll can cut the scroll short.
function jumpTo(section) {
  activeJump.value = section;
  document.getElementById(`rq-${section}-heading`)?.focus({ preventScroll: true });
  document.getElementById(`rq-${section}`)?.scrollIntoView({ block: 'start' });
}
</script>

<template>
  <article class="rq-stack rq-topic" aria-labelledby="rq-topic-title">
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
        :aria-current="activeJump === link.id ? 'true' : undefined"
        :href="`#rq-${link.id}`"
        @click.prevent="jumpTo(link.id)"
      >
        <i class="bi" :class="link.icon" aria-hidden="true"></i>{{ link.label }}
        <template v-if="link.id === 'decision' && blocking > 0">
          <span class="rq-jump__badge" aria-hidden="true">!</span>
          <span class="visually-hidden">, {{ plural(blocking, 'blocking item') }} open</span>
        </template>
      </a>
    </nav>

    <nav class="rq-breadcrumb" aria-label="Breadcrumb">
      <ol>
        <li><RouterLink :to="{ name: 'project-requirements', params: { projectId } }">Requirements</RouterLink></li>
        <li v-if="track"><RouterLink :to="trackLocation">{{ trackLabel(track) }}</RouterLink></li>
        <li aria-current="page">Topic</li>
      </ol>
    </nav>

    <div v-if="notFound" class="rq-empty">
      <h2 id="rq-topic-title" class="rq-title rq-title--md" tabindex="-1" data-rq-focus>This topic no longer exists</h2>
      <p class="rq-small">It may have been deleted. Topics that are still open are in each track's Discuss stage.</p>
      <RouterLink class="ghost-button ghost-button--compact" :to="{ name: 'project-requirements', params: { projectId } }">Back to Requirements</RouterLink>
    </div>

    <div v-else-if="loadError && !topic" class="rq-stack">
      <h2 id="rq-topic-title" class="visually-hidden" tabindex="-1" data-rq-focus>Topic</h2>
      <div class="error-banner rq-row rq-row--between" role="alert">
        <span>{{ loadError }}</span>
        <button class="ghost-button ghost-button--compact" type="button" @click="load()">Try again</button>
      </div>
    </div>

    <template v-else>
      <header class="rq-topic-head">
        <div class="rq-topic-head__main">
          <div v-if="topic" class="rq-row rq-row--tight rq-row--wrap">
            <span class="rq-chip" :class="trackChipClass(topic.track)">{{ trackLabel(topic.track) }}</span>
            <span class="rq-chip" :class="chipToneClass(stateChip.tone)">{{ stateChip.label }}</span>
            <span v-if="settlesLine" class="rq-xs rq-muted">{{ settlesLine }}</span>
          </div>
          <h2 id="rq-topic-title" class="rq-title rq-title--lg" tabindex="-1" data-rq-focus>{{ topic?.prompt ?? 'Loading topic…' }}</h2>
          <p v-if="topic?.rationale" class="rq-small rq-muted mb-0">{{ topic.rationale }}</p>
          <div v-if="topic" class="rq-row rq-row--wrap rq-small">
            <span class="rq-row rq-row--tight">
              <span class="rq-muted">Owner</span>
              <template v-if="assignees.owner">
                <RequirementsAvatar :person="assignees.owner" />
                <span>{{ assignees.owner.name }}</span>
              </template>
              <span v-else class="rq-muted">none yet<template v-if="topic.suggestedOwnerRole"> · suggested: {{ topic.suggestedOwnerRole }}</template></span>
              <button v-if="abilities.assign" class="rq-text-action" type="button" @click="openEdit('people')">Assign</button>
            </span>
            <span v-if="assignees.others.length" class="rq-row rq-row--tight">
              <span class="rq-muted">With</span>
              <span class="rq-avatars">
                <RequirementsAvatar v-for="person in assignees.others" :key="person.ref" :person="person" standalone />
              </span>
            </span>
            <span v-if="addedBy" class="rq-muted">Added by {{ addedBy }}</span>
          </div>
        </div>

        <div v-if="topic" class="rq-topic-head__actions">
          <button v-if="abilities.editTopics || abilities.assign" class="ghost-button ghost-button--compact" type="button" @click="openEdit(abilities.editTopics ? 'details' : 'people')">
            <i class="bi bi-pencil" aria-hidden="true"></i>Edit
          </button>
          <button
            v-if="abilities.moveTopics && otherTrack"
            class="ghost-button ghost-button--compact"
            type="button"
            @click="moveError = ''; moveOpen = true"
          >
            <i class="bi" :class="trackIcon(otherTrack)" aria-hidden="true"></i>Move to {{ trackLabel(otherTrack) }}
          </button>
          <button
            v-if="abilities.changeStatus && (topic.state === 'open' || topic.state === 'ready')"
            class="ghost-button ghost-button--compact"
            type="button"
            :disabled="statusBusy"
            @click="setStatus('dismissed')"
          >
            <i class="bi bi-archive" aria-hidden="true"></i>Dismiss
          </button>
          <button
            v-if="abilities.changeStatus && topic.state === 'dismissed'"
            class="ghost-button ghost-button--compact"
            type="button"
            :disabled="statusBusy"
            @click="setStatus('open')"
          >
            <i class="bi bi-arrow-counterclockwise" aria-hidden="true"></i>Reopen
          </button>
          <button
            v-if="abilities.deleteTopics"
            class="ghost-button ghost-button--compact ghost-button--danger"
            type="button"
            @click="deleteError = ''; deleteOpen = true"
          >
            <i class="bi bi-trash" aria-hidden="true"></i>Delete
          </button>
        </div>
      </header>

      <p v-if="loading && !topic" class="rq-small rq-muted mb-0">Loading the discussion…</p>

      <div v-if="topic" class="rq-topic-grid">
        <section id="rq-discussion" class="rq-panel rq-stack rq-section" aria-labelledby="rq-discussion-heading">
          <div class="rq-row rq-row--between rq-row--wrap">
            <h2 id="rq-discussion-heading" class="rq-eyebrow rq-section-heading" tabindex="-1">Discussion</h2>
            <span class="rq-xs rq-muted">{{ discussionLine }}</span>
          </div>

          <p v-if="!topic.comments?.length" class="rq-small rq-muted mb-0">No comments yet.</p>
          <ul v-else class="rq-thread">
            <RequirementsComment
              v-for="comment in topic.comments"
              :key="comment.id"
              :busy-id="busyCommentId"
              :can-comment="abilities.comment"
              :can-vote="abilities.vote"
              :comment="comment"
              :comments-open="Boolean(topic.commentsOpen)"
              :editing-id="editingId"
              :labels="numbering.labelById"
              :mentionables="loadMentionables"
              :replying-to-id="replyingToId"
              @begin-edit="beginEdit"
              @begin-reply="beginReply"
              @cancel="cancelInline"
              @remove="askRemoveComment"
              @submit-edit="submitEdit"
              @submit-reply="submitReply"
              @vote="vote"
            />
          </ul>
          <p v-if="commentError" class="error-banner mb-0" role="alert">{{ commentError }}</p>
          <p class="visually-hidden" role="status">{{ threadStatus }}</p>

          <form v-if="canComment" class="rq-stack rq-stack--sm" novalidate @submit.prevent="postComment">
            <span id="rq-composer-label" class="visually-hidden">Add to the discussion</span>
            <RequirementsCommentEditor
              ref="composerField"
              v-model="composer"
              labelled-by="rq-composer-label"
              :mentionables="loadMentionables"
              placeholder="Add a requirement note, concern, or constraint. Type @ to tag someone."
              @submit="postComment"
            />
            <p v-if="composerError" class="error-banner mb-0" role="alert">{{ composerError }}</p>
            <div class="d-flex justify-content-end">
              <button class="btn btn-primary btn-sm rq-post-button" type="submit" :disabled="posting || !composer.trim()">
                <i class="bi bi-send-fill me-1" aria-hidden="true"></i>{{ posting ? 'Posting…' : 'Post comment' }}
              </button>
            </div>
          </form>
          <p v-else-if="!topic.commentsOpen" class="rq-small rq-muted mb-0">Comments are closed for this topic.</p>

          <div v-if="topic.files?.length" class="rq-stack rq-stack--sm">
            <h3 class="rq-eyebrow mb-0">Attachments</h3>
            <ul class="list-unstyled rq-stack rq-stack--sm mb-0">
              <li v-for="file in topic.files" :key="file.id" class="rq-row rq-row--tight rq-row--wrap rq-small">
                <button
                  class="btn btn-link btn-sm p-0 text-start"
                  type="button"
                  :disabled="openingFileId === file.id"
                  @click="openFile(file)"
                >
                  <i class="bi bi-paperclip me-1" aria-hidden="true"></i>{{ file.fileName }}
                </button>
                <span class="rq-xs rq-muted">
                  {{ fileSizeLabel(file.fileSize) }}<template v-if="file.createdAt"> · {{ formatShortDate(file.createdAt) }}</template>
                </span>
              </li>
            </ul>
            <p v-if="fileError" class="error-banner mb-0" role="alert">{{ fileError }}</p>
          </div>
        </section>

        <aside class="rq-topic-rail" aria-label="Summary and decision">
          <section id="rq-summary" class="rq-panel rq-section" aria-labelledby="rq-summary-heading">
            <RequirementsSummaryPanel
              :can-ask="canComment"
              :can-refresh="abilities.refreshSummary && topic.state !== 'dismissed'"
              heading-id="rq-summary-heading"
              :numbering="numbering"
              :people="people"
              :refresh-result="summaryRefreshResult"
              :refreshing="refreshingSummary"
              :status="topic.summaryStatus ?? null"
              :summary="topic.summary ?? null"
              @ask="askGroup"
              @cite="focusComment"
              @refresh="refreshSummary"
            />
          </section>

          <section
            id="rq-decision"
            class="rq-panel rq-section"
            :class="{ 'rq-panel--accent': decisionFormVisible }"
            aria-labelledby="rq-decision-heading"
          >
            <p v-if="decisionNotice" class="error-banner mb-2" role="alert">{{ decisionNotice }}</p>
            <RequirementsDecisionBox
              v-if="decisionFormVisible"
              ref="decisionBox"
              :numbering="numbering"
              :project-id="projectId"
              :summary="topic.summary ?? null"
              :supersedes="replacing ? activeDecision : null"
              :topic="topic"
              @cancel="cancelReplace"
              @conflict="handleConflict"
              @recorded="handleRecorded"
            />
            <div v-else-if="activeDecision" class="rq-stack">
              <div class="rq-row rq-row--between rq-row--wrap">
                <h2 id="rq-decision-heading" class="rq-eyebrow rq-section-heading" tabindex="-1">Decision</h2>
                <span class="rq-chip" :class="chipToneClass(activeDecisionChip.tone)">{{ activeDecisionChip.label }}</span>
              </div>
              <RequirementsDecisionStatement class="rq-small" :statement="activeDecision.statement" />
              <p class="rq-xs rq-muted mb-0">
                Recorded by {{ activeDecision.decidedBy?.name || 'a team member' }} · {{ formatShortDate(activeDecision.decidedAt) }}
              </p>
              <RequirementsSourceChips :numbering="numbering" :sources="activeDecision.sources ?? []" @cite="focusComment" />
              <div v-if="abilities.recordDecisions">
                <button class="ghost-button ghost-button--compact" type="button" @click="startReplace">Replace this decision</button>
              </div>
            </div>
            <div v-else class="rq-stack rq-stack--sm">
              <h2 id="rq-decision-heading" class="rq-eyebrow rq-section-heading" tabindex="-1">Decision</h2>
              <p class="rq-small rq-muted mb-0">
                <template v-if="topic.state === 'dismissed'">This topic was dismissed without a decision.</template>
                <template v-else>No decision yet. A project admin or manager records it when the discussion is ready.</template>
              </p>
            </div>
          </section>
        </aside>
      </div>
    </template>

    <RequirementsTopicFormDialog
      v-if="topic"
      :can-assign="abilities.assign"
      :initial-tab="editTab"
      :open="editOpen"
      :project-id="projectId"
      :stakeholders="workspace.stakeholders.value"
      :topic="topic"
      :track="topic.track"
      :users="workspace.validUsers.value"
      @close="editOpen = false"
      @saved="handleEdited"
    />
    <RequirementsConfirmDialog
      :busy="deleting"
      confirm-label="Delete topic"
      :error="deleteError"
      :open="deleteOpen"
      title="Delete this topic?"
      @close="deleteOpen = false"
      @confirm="confirmDeleteTopic"
    >
      <p class="mb-0">Deleting removes the topic for everyone. Topics with comments, review answers, decisions, stakeholders, or files can't be deleted.</p>
    </RequirementsConfirmDialog>
    <RequirementsConfirmDialog
      :busy="moving"
      :confirm-label="`Move to ${trackLabel(otherTrack)}`"
      :error="moveError"
      :open="moveOpen"
      :title="`Move this topic to ${trackLabel(otherTrack)}?`"
      @close="moveOpen = false"
      @confirm="confirmMoveTopic"
    >
      <p class="mb-0">
        The discussion, people, and summary move with it.
        <template v-if="activeDecision">
          So does its decision. If the {{ trackLabel(track) }} plan cites that decision, the plan will show the citation as stale.
        </template>
      </p>
    </RequirementsConfirmDialog>
    <RequirementsConfirmDialog
      :busy="removingComment"
      confirm-label="Remove comment"
      :error="removeError"
      :open="Boolean(removeCommentId)"
      title="Remove this comment?"
      @close="removeCommentId = ''"
      @confirm="confirmRemoveComment"
    >
      <p class="mb-0">Your comment is removed from the discussion for everyone.</p>
    </RequirementsConfirmDialog>
  </article>
</template>

<style scoped>
.rq-post-button {
  min-height: 2.25rem;
}

@media (pointer: coarse) {
  .rq-post-button {
    min-height: 2.75rem;
  }
}
</style>
