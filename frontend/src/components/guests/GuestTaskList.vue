<script setup>
import { computed, reactive, ref, watch } from 'vue';

import { guestApi } from '../../lib/guests/guest-client.js';
import { guestStatusOptions, guestTaskErrorMessage, guestTaskMeta, sortGuestTasks } from '../../lib/guests/guest-tasks.js';
import { sendLargeUpload } from '../../lib/projects/large-upload.js';
import { formatDateTime } from '../../lib/requirements/requirements-time.js';
import { sanitizeClientRichHtml } from '../../lib/rich-content/html.js';

// A guest's pursuit tasks on one engagement (guest-tasks.js on the server). One task opens at a
// time; on their own task the guest changes its status, comments and attaches files. With
// "Guests see the whole board" on, other people's tasks show too, read-only.
const props = defineProps({
  projectId: { required: true, type: String },
  readOnly: { default: false, type: Boolean },
  statuses: { default: () => [], type: Array },
  tasks: { default: () => [], type: Array },
  wholeBoard: { default: false, type: Boolean },
});
const emit = defineEmits(['changed']);

const sorted = computed(() => sortGuestTasks(props.tasks));
const openId = ref('');
const open = computed(() => props.tasks.find((task) => task.id === openId.value) ?? null);
const detail = reactive({ comments: [], error: '', files: [], loading: false, message: '', status: '' });
const comment = reactive({ busy: false, text: '' });
const saving = ref(false);
const uploading = ref('');
let sequence = 0;

const canUpdate = computed(() => Boolean(open.value?.canUpdate) && !props.readOnly);
const canComment = computed(() => Boolean(open.value?.canComment) && !props.readOnly);
const canAttach = computed(() => Boolean(open.value?.canAttach) && !props.readOnly);

async function loadDetail() {
  const task = open.value;
  if (!task) return;
  const current = ++sequence;
  detail.loading = true;
  try {
    const [comments, files] = await Promise.all([guestApi.listTaskComments(props.projectId, task.id), guestApi.listTaskFiles(props.projectId, task.id)]);
    if (current !== sequence) return;
    detail.comments = comments.comments ?? [];
    detail.files = files.files ?? [];
    detail.error = '';
  } catch (error) {
    if (current === sequence) detail.error = guestTaskErrorMessage(error, 'This task could not load.');
  } finally {
    if (current === sequence) detail.loading = false;
  }
}

function toggle(task) {
  openId.value = openId.value === task.id ? '' : task.id;
  Object.assign(detail, { comments: [], error: '', files: [], message: '', status: open.value?.status ?? '' });
  comment.text = '';
  void loadDetail();
}

// The list reloads after each change; keep the open task's status in step with it.
watch(open, (task) => { if (task && !saving.value) detail.status = task.status; });

async function saveStatus() {
  if (!open.value || detail.status === open.value.status) return;
  saving.value = true;
  detail.error = '';
  try {
    await guestApi.updateTask(props.projectId, open.value.id, { status: detail.status });
    detail.message = 'Status saved.';
    emit('changed');
  } catch (error) {
    detail.error = guestTaskErrorMessage(error, 'The status could not be saved.');
  } finally {
    saving.value = false;
  }
}

async function postComment() {
  const text = comment.text.trim();
  if (!text || !open.value) return;
  comment.busy = true;
  detail.error = '';
  try {
    await guestApi.addTaskComment(props.projectId, open.value.id, text);
    comment.text = '';
    detail.message = 'Comment posted.';
    await loadDetail();
  } catch (error) {
    detail.error = guestTaskErrorMessage(error, 'The comment could not be posted.');
  } finally {
    comment.busy = false;
  }
}

async function attach(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file || !open.value) return;
  detail.error = '';
  uploading.value = `Uploading ${file.name}…`;
  try {
    const upload = await sendLargeUpload({
      api: guestApi,
      file,
      onProgress: ({ sentBytes, totalBytes }) => { uploading.value = `Uploading ${file.name} · ${totalBytes ? Math.floor((sentBytes / totalBytes) * 100) : 0}%`; },
      projectId: props.projectId,
      resolveUrl: (url) => guestApi.resolveTransferUrl(url),
      start: { targetId: open.value.id, targetType: 'task' },
    });
    await guestApi.completeFileUpload(props.projectId, upload.id, {});
    detail.message = `${file.name} attached. It can be downloaded once its virus scan passes.`;
    await loadDetail();
  } catch (error) {
    detail.error = guestTaskErrorMessage(error, `${file.name} could not be attached.`);
  } finally {
    uploading.value = '';
  }
}

async function download(file) {
  detail.error = '';
  try {
    const link = await guestApi.getFileDownloadUrl(props.projectId, file.id);
    window.location.assign(guestApi.resolveTransferUrl(link.url));
  } catch (error) {
    detail.error = error?.status === 409 ? `${file.fileName} is still being scanned. Try again in a minute.` : guestTaskErrorMessage(error, `${file.fileName} could not be downloaded.`);
  }
}
</script>

<template>
  <div class="guest-tasks" data-testid="guest-tasks">
    <h3 class="guest-tasks__title">{{ wholeBoard ? 'Tasks' : 'Your tasks' }}</h3>
    <ul class="guest-tasks__list">
      <li v-for="task in sorted" :key="task.id" class="guest-tasks__item">
        <button
          class="guest-tasks__row"
          type="button"
          :aria-expanded="openId === task.id ? 'true' : 'false'"
          :aria-controls="`guest-task-${task.id}`"
          @click="toggle(task)"
        >
          <span class="guest-tasks__name">{{ task.name }}<span v-if="task.assignedToMe && wholeBoard" class="rq-chip rq-chip--neutral ms-2">Yours</span></span>
          <span class="rq-small rq-muted">{{ guestTaskMeta(task) }}</span>
          <i :class="['bi', openId === task.id ? 'bi-chevron-up' : 'bi-chevron-down']" aria-hidden="true"></i>
        </button>

        <div v-if="openId === task.id" :id="`guest-task-${task.id}`" class="guest-tasks__detail">
          <p v-if="detail.error" class="error-banner mb-0" role="alert">{{ detail.error }}</p>
          <p v-else-if="detail.message" class="success-banner mb-0" role="status">{{ detail.message }}</p>

          <form v-if="canUpdate" class="guest-tasks__status" @submit.prevent="saveStatus">
            <label :for="`guest-task-status-${task.id}`">Status</label>
            <select :id="`guest-task-status-${task.id}`" v-model="detail.status">
              <option v-for="status in guestStatusOptions(statuses, task.status)" :key="status" :value="status">{{ status }}</option>
            </select>
            <button class="primary-button primary-button--compact" type="submit" :disabled="saving || detail.status === task.status">{{ saving ? 'Saving…' : 'Save status' }}</button>
          </form>
          <p v-else-if="!task.assignedToMe" class="rq-small rq-muted mb-0">Assigned to {{ task.assigneeName || 'nobody yet' }}. Only they can change it.</p>

          <section class="guest-tasks__section" :aria-label="`Comments on ${task.name}`">
            <h4 class="guest-tasks__subtitle">Comments</h4>
            <p v-if="detail.loading" class="rq-small rq-muted mb-0" role="status">Loading…</p>
            <p v-else-if="!detail.comments.length" class="rq-small rq-muted mb-0">No comments yet.</p>
            <ul v-else class="guest-tasks__comments">
              <li v-for="entry in detail.comments" :key="entry.id">
                <span class="rq-small"><strong>{{ entry.authorName || 'Someone' }}</strong> · {{ formatDateTime(entry.createdAt) }}</span>
                <!-- Sanitised on the server (LINK_COMMENT_HTML) and again here. -->
                <div class="guest-tasks__comment-body" v-html="sanitizeClientRichHtml(entry.html)"></div>
              </li>
            </ul>
            <form v-if="canComment" class="guest-tasks__comment-form" @submit.prevent="postComment">
              <label class="visually-hidden" :for="`guest-task-comment-${task.id}`">Comment on {{ task.name }}</label>
              <textarea :id="`guest-task-comment-${task.id}`" v-model="comment.text" rows="2" maxlength="10000" placeholder="Write a comment"></textarea>
              <button class="secondary-button secondary-button--compact" type="submit" :disabled="comment.busy || !comment.text.trim()">{{ comment.busy ? 'Posting…' : 'Post comment' }}</button>
            </form>
          </section>

          <section class="guest-tasks__section" :aria-label="`Files on ${task.name}`">
            <h4 class="guest-tasks__subtitle">Files</h4>
            <p v-if="!detail.loading && !detail.files.length" class="rq-small rq-muted mb-0">No files yet.</p>
            <ul v-else class="guest-tasks__files">
              <li v-for="file in detail.files" :key="file.id">
                <button class="ghost-button ghost-button--compact" type="button" @click="download(file)">
                  <i class="bi bi-download" aria-hidden="true"></i> {{ file.fileName }}
                </button>
                <span v-if="file.scanStatus && file.scanStatus !== 'clean'" class="rq-small rq-muted">Scanning</span>
              </li>
            </ul>
            <label v-if="canAttach" class="secondary-button secondary-button--compact guest-tasks__attach">
              <i class="bi bi-paperclip" aria-hidden="true"></i> Attach a file
              <input class="visually-hidden" type="file" :disabled="Boolean(uploading)" @change="attach" />
            </label>
            <p v-if="uploading" class="rq-small rq-muted mb-0" role="status">{{ uploading }}</p>
          </section>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.guest-tasks { display: grid; gap: 0.35rem; padding-top: 0.5rem; border-top: 1px solid var(--line); }
/* The legacy stylesheet sizes and underlines every h3/h4 with !important. */
.guest-tasks__title, .guest-tasks__subtitle { margin: 0; padding: 0; border-bottom: 0; color: var(--muted); font-size: 0.75rem !important; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
.guest-tasks__list, .guest-tasks__comments, .guest-tasks__files { display: grid; gap: 0.25rem; margin: 0; padding: 0; list-style: none; }
.guest-tasks__row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 0.5rem; width: 100%; min-height: 2.75rem; padding: 0.25rem 0.5rem; border: 0; border-radius: 0.35rem; background: transparent; color: var(--ink); text-align: left; }
.guest-tasks__row:hover { background: var(--surface-soft); }
.guest-tasks__row:focus-visible { outline: 0.18rem solid var(--accent); outline-offset: 0.1rem; }
.guest-tasks__row .bi { margin-left: auto; color: var(--muted); }
.guest-tasks__name { flex: 1 1 12rem; min-width: 0; overflow-wrap: anywhere; }
.guest-tasks__detail { display: grid; gap: 0.75rem; padding: 0.5rem 0.5rem 0.75rem; border-left: 2px solid var(--line); margin-left: 0.5rem; }
.guest-tasks__status { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
.guest-tasks__status select { min-height: 2.5rem; }
.guest-tasks__section { display: grid; gap: 0.35rem; }
.guest-tasks__comment-body { overflow-wrap: anywhere; }
.guest-tasks__comment-body :deep(p) { margin: 0.15rem 0 0; }
.guest-tasks__comment-form { display: grid; gap: 0.35rem; justify-items: start; }
.guest-tasks__comment-form textarea { width: 100%; }
.guest-tasks__files li { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
/* A file name keeps its own case. */
.guest-tasks__files .ghost-button { letter-spacing: normal; text-transform: none; }
.guest-tasks__attach { justify-self: start; cursor: pointer; }
.guest-tasks__attach:focus-within { outline: 0.18rem solid var(--accent); outline-offset: 0.1rem; }
</style>
