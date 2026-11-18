<script setup>
import { computed, reactive, ref, useId, watch } from 'vue';

import AccessStatusChip from './AccessStatusChip.vue';
import RequirementsConfirmDialog from '../requirements/RequirementsConfirmDialog.vue';
import RequirementsDialog from '../requirements/RequirementsDialog.vue';
import { apiClient } from '../../lib/auth/index.js';
import { formatAgo, formatDateTime } from '../../lib/requirements/requirements-time.js';
import { renderRichTextToHtml, sanitizeClientRichHtml } from '../../lib/rich-content/html.js';
import {
  buildTaskUpdate,
  buildTimeEntry,
  canDeleteTimeEntry,
  describeAccessWriteError,
  dueText,
  formatDay,
  formatHours,
  itemParent,
  itemTypeText,
  statusChoices,
  statusLabel,
  taskUpdateForm,
  timeEntryForm,
  timeEntryStatusLabel,
} from '../../lib/task-access/access-view.js';

// One epic, story or task from the access link (`task`, as the routes call all three).
// Everything shows read-only; on an item assigned to the person the dialog also has one form
// at a time: status and remaining hours (Details), a comment (Comments), or a time entry (Your
// time). Other people's work shows its comments only.
const props = defineProps({
  columns: { default: () => [], type: Array },
  open: { default: false, type: Boolean },
  projectId: { required: true, type: String },
  // Changes on each timed page refresh; the open item reloads its comments and time.
  refreshKey: { default: 0, type: Number },
  sprintName: { default: '', type: String },
  task: { default: null, type: Object },
  token: { required: true, type: String },
});

const emit = defineEmits(['close', 'problem', 'saved']);

// Guests can't load the app's file links, so rich text shows without images.
const TEXT_TAGS = new Set(['A', 'BLOCKQUOTE', 'BR', 'CODE', 'EM', 'H1', 'H2', 'H3', 'H4', 'HR', 'LI', 'OL', 'P', 'PRE', 'S', 'SPAN', 'STRONG', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'U', 'UL']);

const uid = useId();
const fieldId = (name) => `access-task-${uid}-${name}`;

const tab = ref('details');
const busy = ref(false);
const notice = ref(null);
const form = reactive(taskUpdateForm(null));
const formErrors = ref({});
// Set after a version conflict: the next version from the server replaces the form.
let resetOnNextVersion = false;
const comments = reactive({ error: '', items: [], loaded: false });
const commentText = ref('');
const commentError = ref('');
const time = reactive({ entries: [], error: '', loaded: false });
const timeForm = reactive(timeEntryForm());
const timeErrors = ref({});
const removal = reactive({ busy: false, entry: null, error: '', open: false });
// Kept from the last item shown, so the words still fit once the item has gone.
const itemType = ref('');

const kind = computed(() => itemTypeText(itemType.value));
const parent = computed(() => itemParent(props.task));
const mine = computed(() => Boolean(props.task?.mine));
const statuses = computed(() => statusChoices(props.columns, props.task?.status));
const update = computed(() => buildTaskUpdate(form));
const formDirty = computed(() => Boolean(update.value.payload) || Object.keys(update.value.errors).length > 0);
const descriptionHtml = computed(() => sanitizeClientRichHtml(renderRichTextToHtml(props.task?.description ?? ''), { allowedTags: TEXT_TAGS }));
const due = computed(() => dueText(props.task));
const tabs = computed(() => [
  { id: 'details', label: 'Details' },
  { id: 'comments', label: comments.loaded ? `Comments · ${comments.items.length}` : 'Comments' },
  ...(mine.value ? [{ id: 'time', label: 'Your time' }] : []),
]);
const submitLabel = computed(() => {
  if (!mine.value || !props.task) return '';
  return { comments: 'Post comment', details: 'Save changes', time: 'Log time' }[tab.value] ?? '';
});
const submitDisabled = computed(() => {
  if (tab.value === 'details') return !formDirty.value;
  if (tab.value === 'comments') return !commentText.value.trim();
  return false;
});

function resetForm() {
  Object.assign(form, taskUpdateForm(props.task));
  formErrors.value = {};
  resetOnNextVersion = false;
}

function reset() {
  tab.value = 'details';
  notice.value = null;
  resetForm();
  Object.assign(comments, { error: '', items: [], loaded: false });
  commentText.value = '';
  commentError.value = '';
  Object.assign(time, { entries: [], error: '', loaded: false });
  Object.assign(timeForm, timeEntryForm());
  timeErrors.value = {};
}

watch(() => props.task?.itemType, (value) => {
  if (value) itemType.value = value;
}, { immediate: true });

watch(() => [props.open, props.task?.id], ([open, taskId], previous = []) => {
  if (!open || !taskId) return;
  if (open === previous[0] && taskId === previous[1]) return;
  reset();
  loadComments();
  if (props.task?.mine) loadTime();
}, { immediate: true });

watch(() => props.refreshKey, () => {
  if (!props.open || !props.task?.id || busy.value) return;
  loadComments();
  if (props.task.mine) loadTime();
});

// An item reassigned away while open loses its Your time view.
watch(mine, (value) => {
  if (!value && tab.value === 'time') tab.value = 'details';
});

// A refresh brings a newer version: follow it unless the person has unsaved edits.
watch(() => props.task?.version, (version, previous) => {
  if (!props.open || version == null || version === previous) return;
  if (resetOnNextVersion || !formDirty.value) resetForm();
});

function handleError(error, { target = 'notice' } = {}) {
  const described = describeAccessWriteError(error, { itemType: itemType.value });
  if (described.problem) {
    emit('problem', described.problem);
    return described;
  }
  // A version conflict replaces the form with the newer item; other out-of-date answers (the
  // item or entry is gone, the board changed) just read the board again. Workflow refusals, a
  // story with someone else's open tasks and closed periods change nothing, so nothing reloads.
  if (described.conflict) resetOnNextVersion = true;
  if (described.reload) emit('saved', null);
  if (described.code === 'time_entry_not_found') loadTime();
  if (target === 'notice') notice.value = { text: described.message, tone: described.conflict ? 'info' : 'error' };
  return described;
}

async function loadComments() {
  const taskId = props.task?.id;
  if (!taskId) return;
  try {
    const result = await apiClient.passive.listAccessTaskComments(props.token, props.projectId, taskId);
    if (taskId !== props.task?.id) return;
    Object.assign(comments, { error: '', items: result.comments ?? [], loaded: true });
  } catch (error) {
    const described = describeAccessWriteError(error, { itemType: itemType.value });
    if (described.problem) emit('problem', described.problem);
    else comments.error = `Comments didn’t load. Close and open the ${kind.value.noun} to try again.`;
  }
}

async function loadTime() {
  const taskId = props.task?.id;
  if (!taskId) return;
  try {
    const result = await apiClient.passive.listAccessTaskTime(props.token, props.projectId, taskId);
    if (taskId !== props.task?.id) return;
    Object.assign(time, { entries: result.entries ?? [], error: '', loaded: true });
  } catch (error) {
    const described = describeAccessWriteError(error, { itemType: itemType.value });
    if (described.problem) emit('problem', described.problem);
    else time.error = `Your time entries didn’t load. Close and open the ${kind.value.noun} to try again.`;
  }
}

async function saveDetails() {
  const { errors, payload } = update.value;
  formErrors.value = errors;
  if (Object.keys(errors).length || !payload) return;
  busy.value = true;
  notice.value = null;
  try {
    const result = await apiClient.updateAccessTask(props.token, props.projectId, props.task.id, payload);
    if (result?.task) Object.assign(form, taskUpdateForm(result.task));
    notice.value = { text: 'Saved.', tone: 'ok' };
    emit('saved', result?.task ?? null);
  } catch (error) {
    handleError(error);
  } finally {
    busy.value = false;
  }
}

async function postComment() {
  const text = commentText.value.trim();
  commentError.value = '';
  if (!text) {
    commentError.value = 'Write a comment first.';
    return;
  }
  busy.value = true;
  notice.value = null;
  try {
    await apiClient.addAccessTaskComment(props.token, props.projectId, props.task.id, { text });
    commentText.value = '';
    notice.value = { text: 'Comment posted.', tone: 'ok' };
    await loadComments();
  } catch (error) {
    // An empty comment is the field's error, shown under the box.
    if (handleError(error).code === 'comment_empty') {
      notice.value = null;
      commentError.value = 'Write a comment first.';
    }
  } finally {
    busy.value = false;
  }
}

async function logTime() {
  const { errors, payload } = buildTimeEntry(timeForm);
  timeErrors.value = errors;
  if (!payload) return;
  busy.value = true;
  notice.value = null;
  try {
    const result = await apiClient.logAccessTaskTime(props.token, props.projectId, props.task.id, payload);
    Object.assign(timeForm, timeEntryForm());
    notice.value = { text: `${formatHours(payload.hours)} logged.`, tone: 'ok' };
    emit('saved', result?.task ?? null);
    await loadTime();
  } catch (error) {
    handleError(error);
  } finally {
    busy.value = false;
  }
}

function submit() {
  if (busy.value || !mine.value || !props.task) return;
  if (tab.value === 'details') saveDetails();
  else if (tab.value === 'comments') postComment();
  else if (tab.value === 'time') logTime();
}

function askRemove(entry) {
  Object.assign(removal, { busy: false, entry, error: '', open: true });
}

async function confirmRemove() {
  const entry = removal.entry;
  if (!entry || removal.busy) return;
  removal.busy = true;
  removal.error = '';
  try {
    await apiClient.deleteAccessTimeEntry(props.token, props.projectId, entry.id, entry.version);
    removal.open = false;
    notice.value = { text: 'Time entry deleted.', tone: 'ok' };
    emit('saved', null);
    await loadTime();
  } catch (error) {
    const described = handleError(error, { target: 'confirm' });
    if (!described.problem) {
      removal.error = described.message;
      if (described.conflict) loadTime();
    } else {
      removal.open = false;
    }
  } finally {
    removal.busy = false;
  }
}

function commentHtml(html) {
  return sanitizeClientRichHtml(String(html ?? ''), { allowedTags: TEXT_TAGS });
}

function fieldErrorId(name) {
  return `${fieldId(name)}-error`;
}
</script>

<template>
  <RequirementsDialog
    :busy="busy"
    focus-title
    :open="open"
    :title="task?.name ?? kind.label"
    @close="emit('close')"
    @submit="submit"
  >
    <div class="access-task" data-testid="access-task-dialog">
      <p v-if="!task" class="mb-0">This {{ kind.noun }} is no longer there, or no longer shared with you.</p>

      <template v-else>
        <div class="access-task__summary">
          <span class="rq-chip rq-chip--neutral"><i class="bi" :class="kind.icon" aria-hidden="true"></i>{{ kind.label }}</span>
          <AccessStatusChip :status="task.status" />
          <span v-if="mine" class="rq-chip rq-chip--solid"><i class="bi bi-person-check" aria-hidden="true"></i>Yours</span>
          <span v-else class="rq-chip rq-chip--neutral"><i class="bi bi-eye" aria-hidden="true"></i>View only</span>
        </div>

        <fieldset class="rq-seg rq-seg--block access-task__tabs">
          <legend class="visually-hidden">Show</legend>
          <label v-for="entry in tabs" :key="entry.id" class="rq-seg__option">
            <input v-model="tab" type="radio" :name="fieldId('tab')" :value="entry.id" />
            <span>{{ entry.label }}</span>
          </label>
        </fieldset>

        <p v-if="notice" :class="notice.tone === 'error' ? 'error-banner' : notice.tone === 'info' ? 'info-banner' : 'success-banner'" class="access-notice mb-0" :role="notice.tone === 'error' ? 'alert' : 'status'">
          {{ notice.text }}
        </p>

        <div v-if="tab === 'details'" class="rq-stack">
          <dl class="access-facts">
            <div v-if="parent"><dt>{{ parent.label }}</dt><dd>{{ parent.name }}<span v-if="parent.epicName" class="rq-muted"> · {{ parent.epicName }}</span></dd></div>
            <div v-if="sprintName || task.itemType !== 'epic'"><dt>Sprint</dt><dd>{{ sprintName || 'No sprint' }}</dd></div>
            <div><dt>Assigned to</dt><dd>{{ mine ? 'You' : task.assigneeName || 'Unassigned' }}</dd></div>
            <div><dt>Start</dt><dd>{{ formatDay(task.targetStartDate) || '—' }}</dd></div>
            <div><dt>Due</dt><dd :class="{ 'access-overdue': due.overdue }">{{ formatDay(task.targetEndDate) || '—' }}<template v-if="due.overdue"> (overdue)</template></dd></div>
            <div><dt>Estimate</dt><dd>{{ formatHours(task.targetHourEstimate) || 'Not set' }}</dd></div>
            <div><dt>Logged</dt><dd>{{ formatHours(task.actualHours) || 'None' }}</dd></div>
            <div><dt>Remaining</dt><dd>{{ formatHours(task.remainingHours) || 'Not set' }}</dd></div>
            <div v-if="task.priority != null"><dt>Priority</dt><dd>{{ task.priority }}</dd></div>
            <div v-if="task.updatedAt"><dt>Updated</dt><dd>{{ formatAgo(task.updatedAt) }}</dd></div>
          </dl>
          <div v-if="descriptionHtml" class="access-rich" v-html="descriptionHtml"></div>

          <fieldset v-if="mine" class="access-task__edit">
            <legend class="rq-field__label">Update your {{ kind.noun }}</legend>
            <div class="access-task__grid">
              <div class="rq-field">
                <label :for="fieldId('status')">Status</label>
                <select :id="fieldId('status')" v-model="form.status" class="form-select">
                  <option v-for="status in statuses" :key="status" :value="status">{{ statusLabel(status) }}</option>
                </select>
              </div>
              <div class="rq-field">
                <label :for="fieldId('remaining')">Remaining hours</label>
                <input
                  :id="fieldId('remaining')"
                  v-model="form.remainingHours"
                  class="form-control"
                  inputmode="decimal"
                  placeholder="Not set"
                  :aria-invalid="formErrors.remainingHours ? 'true' : 'false'"
                  :aria-describedby="formErrors.remainingHours ? fieldErrorId('remaining') : undefined"
                />
                <p v-if="formErrors.remainingHours" :id="fieldErrorId('remaining')" class="access-field-error">{{ formErrors.remainingHours }}</p>
              </div>
            </div>
          </fieldset>
        </div>

        <div v-else-if="tab === 'comments'" class="rq-stack">
          <p v-if="comments.error" class="error-banner mb-0" role="alert">{{ comments.error }}</p>
          <p v-else-if="!comments.loaded" class="rq-small rq-muted mb-0" role="status">Loading comments…</p>
          <p v-else-if="!comments.items.length" class="rq-small rq-muted mb-0">No comments yet.</p>
          <ul v-else class="rq-thread access-comments">
            <li v-for="comment in comments.items" :key="comment.id" class="rq-comment">
              <div class="rq-comment__meta">
                <strong>{{ comment.mine ? 'You' : comment.authorName || 'Someone' }}</strong>
                <span>{{ formatDateTime(comment.createdAt) }}</span>
              </div>
              <div class="access-rich" v-html="commentHtml(comment.html)"></div>
            </li>
          </ul>
          <div v-if="mine" class="rq-field">
            <label :for="fieldId('comment')">Add a comment</label>
            <textarea
              :id="fieldId('comment')"
              v-model="commentText"
              class="form-control"
              rows="3"
              maxlength="5000"
              :aria-invalid="commentError ? 'true' : 'false'"
              :aria-describedby="commentError ? fieldErrorId('comment') : undefined"
            ></textarea>
            <p v-if="commentError" :id="fieldErrorId('comment')" class="access-field-error">{{ commentError }}</p>
          </div>
        </div>

        <div v-else-if="tab === 'time'" class="rq-stack">
          <p v-if="time.error" class="error-banner mb-0" role="alert">{{ time.error }}</p>
          <p v-else-if="!time.loaded" class="rq-small rq-muted mb-0" role="status">Loading your time…</p>
          <p v-else-if="!time.entries.length" class="rq-small rq-muted mb-0">You haven’t logged time on this {{ kind.noun }} yet.</p>
          <ul v-else class="access-time">
            <li v-for="entry in time.entries" :key="entry.id" class="access-time__entry">
              <div class="access-time__main">
                <strong>{{ formatHours(entry.hours) }}</strong>
                <span>{{ formatDay(entry.workDate) }}</span>
                <span class="rq-chip rq-chip--neutral">{{ timeEntryStatusLabel(entry.status) }}</span>
                <span v-if="entry.invoiced" class="rq-chip rq-chip--neutral"><i class="bi bi-lock-fill" aria-hidden="true"></i> Invoiced</span>
                <p v-if="entry.note" class="access-time__note mb-0">{{ entry.note }}</p>
              </div>
              <button
                v-if="canDeleteTimeEntry(entry)"
                class="ghost-button access-time__delete"
                type="button"
                :disabled="busy"
                @click="askRemove(entry)"
              >
                <i class="bi bi-trash" aria-hidden="true"></i>Delete<span class="visually-hidden"> {{ formatHours(entry.hours) }} on {{ formatDay(entry.workDate) }}</span>
              </button>
            </li>
          </ul>

          <fieldset class="access-task__edit">
            <legend class="rq-field__label">Log time</legend>
            <div class="access-task__grid">
              <div class="rq-field">
                <label :for="fieldId('date')">Date</label>
                <input
                  :id="fieldId('date')"
                  v-model="timeForm.workDate"
                  class="form-control"
                  type="date"
                  :aria-invalid="timeErrors.workDate ? 'true' : 'false'"
                  :aria-describedby="timeErrors.workDate ? fieldErrorId('date') : undefined"
                />
                <p v-if="timeErrors.workDate" :id="fieldErrorId('date')" class="access-field-error">{{ timeErrors.workDate }}</p>
              </div>
              <div class="rq-field">
                <label :for="fieldId('hours')">Hours</label>
                <input
                  :id="fieldId('hours')"
                  v-model="timeForm.hours"
                  class="form-control"
                  inputmode="decimal"
                  :aria-invalid="timeErrors.hours ? 'true' : 'false'"
                  :aria-describedby="timeErrors.hours ? fieldErrorId('hours') : undefined"
                />
                <p v-if="timeErrors.hours" :id="fieldErrorId('hours')" class="access-field-error">{{ timeErrors.hours }}</p>
              </div>
            </div>
            <div class="rq-field">
              <label :for="fieldId('note')">Note <span class="rq-muted">(optional)</span></label>
              <input
                :id="fieldId('note')"
                v-model="timeForm.note"
                class="form-control"
                maxlength="2000"
                :aria-invalid="timeErrors.note ? 'true' : 'false'"
                :aria-describedby="timeErrors.note ? fieldErrorId('note') : undefined"
              />
              <p v-if="timeErrors.note" :id="fieldErrorId('note')" class="access-field-error">{{ timeErrors.note }}</p>
            </div>
            <div class="rq-field">
              <label :for="fieldId('after')">Remaining hours after this <span class="rq-muted">(optional)</span></label>
              <input
                :id="fieldId('after')"
                v-model="timeForm.remainingHours"
                class="form-control"
                inputmode="decimal"
                :placeholder="task.remainingHours != null ? `Now ${formatHours(task.remainingHours)}` : 'Not set'"
                :aria-invalid="timeErrors.remainingHours ? 'true' : 'false'"
                :aria-describedby="timeErrors.remainingHours ? fieldErrorId('after') : undefined"
              />
              <p v-if="timeErrors.remainingHours" :id="fieldErrorId('after')" class="access-field-error">{{ timeErrors.remainingHours }}</p>
            </div>
          </fieldset>
        </div>
      </template>
    </div>
    <template #footer>
      <button class="ghost-button" type="button" :disabled="busy" @click="emit('close')">Close</button>
      <button v-if="submitLabel" class="primary-button" type="submit" :disabled="busy || submitDisabled">{{ busy ? 'Saving…' : submitLabel }}</button>
    </template>
  </RequirementsDialog>

  <RequirementsConfirmDialog
    :busy="removal.busy"
    confirm-label="Delete entry"
    :error="removal.error"
    :open="removal.open"
    title="Delete this time entry?"
    @close="removal.open = false"
    @confirm="confirmRemove"
  >
    <p class="mb-0">
      {{ formatHours(removal.entry?.hours) }} on {{ formatDay(removal.entry?.workDate) }} comes off this {{ kind.noun }}’s logged hours.
    </p>
  </RequirementsConfirmDialog>
</template>
