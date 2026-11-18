<script setup>
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';

import { useAttachmentTray } from '../../lib/channels/attachment-tray.js';
import { dragHasFiles } from '../../lib/channels/attachments.js';
import { odinConfirmationNote, postTimeLabel, replyTagFor, threadOdinReplying } from '../../lib/channels/channels.js';
import { quoteFor } from '../../lib/channels/reactions.js';
import AssistantChangesCard from '../assistant/AssistantChangesCard.vue';
import OdinAvatar from '../chat/OdinAvatar.vue';
import RequirementsCommentEditor from '../requirements/RequirementsCommentEditor.vue';
import AttachmentTray from './AttachmentTray.vue';
import ChannelPostBody from './ChannelPostBody.vue';
import PostAttachments from './PostAttachments.vue';
import PostPoll from './PostPoll.vue';
import PostReactions from './PostReactions.vue';

defineOptions({ name: 'ChannelPost' });

// One message in a channel, or one comment on a file, with its replies (one level). Reply and
// edit drafts live here; the list decides which message has one open, so only one is active.
// Odin's replies carry a confirmation and the changes it made; their buttons show only for the
// person who tagged Odin (post.odinReply.*.canResolve, canUndo).
const props = defineProps({
  busyId: { default: '', type: String },
  editingId: { default: '', type: String },
  focusId: { default: '', type: String },
  // The largest file a reply can carry. 0 (file comments) means a reply carries no files.
  maxFileBytes: { default: 0, type: Number },
  // Loads the people this viewer may tag: async () => [{ ref, name, detail, kind }].
  mentionables: { default: null, type: Function },
  post: { required: true, type: Object },
  // A reply that answers another reply: what it quotes (lib/channels/reactions.js quoteFor).
  quoted: { default: null, type: Object },
  // What the reply being sent is doing ("Uploading shot.png · 40%"), while it uploads files.
  progress: { default: '', type: String },
  replyingToId: { default: '', type: String },
  // The reply the open reply form answers, when it answers one (replyToId).
  replyQuoteId: { default: '', type: String },
  // File comments say which version each was made on.
  showVersion: { default: false, type: Boolean },
  // "Ana is typing…" for this thread's reply box, from others (lib/channels/typing.js).
  typingLabel: { default: '', type: String },
});

// begin-reply: (threadId, replyToId?). A reply's Reply answers it in the same thread, so its
// thread re-sends the event with its own id and the reply's.
// reply-typing: ({ parentId, text }) as this thread's reply box changes, for typing signals.
const emit = defineEmits(['begin-edit', 'begin-reply', 'cancel', 'focus-post', 'odin-confirm', 'odin-undo', 'open-file', 'poll-update', 'react', 'remove', 'reply-typing', 'submit-edit', 'submit-reply']);
// A poll post whose text is only its question shows the poll alone.
const bodyShown = computed(() => Boolean(props.post.body) && !(props.post.poll && props.post.body.trim() === props.post.poll.question));

const replyDraft = ref('');
const uid = useId();
// Files waiting in the reply box: pasted, dropped or picked, sent with the reply.
const replyFileError = ref('');
const replyFiles = useAttachmentTray({ maxBytes: () => props.maxFileBytes, onError: (message) => { replyFileError.value = message; } });
const replyDropping = ref(false);
const filesAllowed = computed(() => props.maxFileBytes > 0);
const canSendReply = computed(() => Boolean(replyDraft.value.trim() || replyFiles.entries.value.length));
const editDraft = ref('');
const replyField = ref(null);
const editField = ref(null);
const busy = computed(() => props.busyId === props.post.id);
const replying = computed(() => props.replyingToId === props.post.id);
const replyQuote = computed(() => (replying.value && props.replyQuoteId ? quoteFor({ replyToId: props.replyQuoteId }, props.post.replies ?? []) : null));
const reactionsBar = ref(null);
const editing = computed(() => props.editingId === props.post.id);
const author = computed(() => props.post.author?.name || 'Former member');
const isOdin = computed(() => props.post.author?.type === 'odin');
const confirmation = computed(() => props.post.odinReply?.confirmation ?? null);
const odinChanges = computed(() => props.post.odinReply?.changes ?? null);
// A thread's first post shows "Odin is replying" under its replies while Odin works on a tag in it.
const odinReplying = computed(() => !props.post.parentId && threadOdinReplying(props.post));
const initials = computed(() => author.value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('') || '?');

// A reply starts by tagging the person it answers. The draft holds only that tag until the writer
// types, so answering someone else in the same open form swaps the tag; a draft with more in it
// is kept as it is.
let tagOnlyDraft = null;
async function tagPersonAnswered() {
  const answered = props.replyQuoteId ? (props.post.replies ?? []).find((reply) => reply.id === props.replyQuoteId) : props.post;
  if (!answered || answered.deleted || !props.mentionables) return;
  const quoteId = props.replyQuoteId;
  const people = await Promise.resolve(props.mentionables()).catch(() => []);
  if (!replying.value || props.replyQuoteId !== quoteId) return;
  const tag = replyTagFor(answered.author, people);
  const draft = replyDraft.value.trim();
  if (!tag || (draft && draft !== tagOnlyDraft)) return;
  if (draft) {
    replyDraft.value = '';
    await nextTick();
  }
  if (replyField.value?.insertMention(tag)) {
    await nextTick();
    tagOnlyDraft = replyDraft.value.trim();
  }
}

watch(() => [replying.value, props.replyQuoteId], async ([open], [wasOpen] = []) => {
  if (!open) return;
  if (wasOpen) {
    // Another reply to answer in the same open form: keep the draft, go back to the box.
    await nextTick();
    replyField.value?.focus();
    void tagPersonAnswered();
    return;
  }
  replyDraft.value = '';
  replyFiles.clear();
  replyFileError.value = '';
  tagOnlyDraft = null;
  await nextTick();
  replyField.value?.focus();
  void tagPersonAnswered();
});

watch(replying, (open) => {
  if (!open) {
    replyFiles.clear();
    replyFileError.value = '';
    replyDropping.value = false;
  }
});
onBeforeUnmount(() => replyFiles.clear());

function sendReply() {
  if (busy.value || !canSendReply.value) return;
  emit('submit-reply', { body: replyDraft.value, files: replyFiles.entries.value, post: props.post, replyToId: props.replyQuoteId || null });
}

function onReplyPaste(event) {
  if (!filesAllowed.value || busy.value) return;
  replyFileError.value = '';
  replyFiles.takePaste(event);
}

function onReplyDragOver(event) {
  if (!filesAllowed.value || busy.value || !dragHasFiles(event.dataTransfer)) return;
  event.preventDefault();
  replyDropping.value = true;
}

function onReplyDrop(event) {
  replyDropping.value = false;
  if (!filesAllowed.value || busy.value) return;
  replyFileError.value = '';
  replyFiles.takeDrop(event);
}

function pickReplyFiles(event) {
  const picked = [...(event.target.files ?? [])];
  event.target.value = '';
  replyFileError.value = '';
  replyFiles.add(picked);
}

watch(replyDraft, (text) => {
  if (replying.value) emit('reply-typing', { parentId: props.post.id, text });
});

watch(editing, async (open) => {
  if (!open) return;
  editDraft.value = props.post.body ?? '';
  await nextTick();
  editField.value?.focus();
});
</script>

<template>
  <li class="channel-post" :class="{ 'channel-post--reply': post.parentId, 'channel-post--focused': post.id === focusId }">
    <article :id="`channel-post-${post.id}`" class="channel-post__card" :aria-label="post.deleted ? 'Message deleted' : `${author}, ${postTimeLabel(post.createdAt)}`">
      <OdinAvatar v-if="isOdin && !post.deleted" />
      <span v-else class="channel-post__avatar" aria-hidden="true">{{ post.deleted ? '' : initials }}</span>
      <div class="channel-post__main">
        <p v-if="post.deleted" class="channel-post__deleted"><i class="bi bi-slash-circle" aria-hidden="true"></i> Message deleted</p>
        <template v-else>
          <div class="channel-post__meta">
            <strong>{{ author }}</strong>
            <span v-if="post.author?.type === 'stakeholder'" class="channel-post__chip">Guest</span>
            <time :datetime="post.createdAt">{{ postTimeLabel(post.createdAt) }}</time>
            <span v-if="showVersion && post.fileVersion" class="channel-post__chip">On version {{ post.fileVersion }}</span>
            <span v-if="post.editedAt">Edited</span>
          </div>
          <button v-if="quoted" class="channel-post__quote" type="button" :disabled="quoted.missing" :aria-label="quoted.deleted ? 'In reply to a deleted message' : quoted.missing ? 'In reply to an earlier message' : `In reply to ${quoted.author}: ${quoted.text}. Show that message`" @click="emit('focus-post', quoted.id)">
            <span class="channel-post__quote-mark" aria-hidden="true">↩</span>
            <span v-if="quoted.deleted" class="channel-post__quote-text">Deleted message</span>
            <span v-else-if="quoted.missing" class="channel-post__quote-text">Earlier message</span>
            <span v-else class="channel-post__quote-text"><strong>{{ quoted.author }}:</strong> {{ quoted.text }}</span>
          </button>
          <ChannelPostBody v-if="bodyShown && !editing" class="channel-post__body" :body="post.body" />
          <PostPoll v-if="post.poll && !post.deleted && !editing" :poll="post.poll" :post-id="post.id" @update="(poll) => emit('poll-update', { poll, post })" />
          <PostAttachments v-if="post.attachments?.length && !editing" :files="post.attachments" @open-file="emit('open-file', $event)" />
          <section v-if="confirmation" class="channel-post__confirm" :class="{ 'channel-post__confirm--open': confirmation.canResolve }" aria-label="Odin is asking to confirm">
            <p class="channel-post__confirm-title">
              <i class="bi bi-shield-exclamation" aria-hidden="true"></i>
              {{ confirmation.label }}{{ confirmation.target ? `: ${confirmation.target}` : '' }}
            </p>
            <div v-if="confirmation.canResolve" class="channel-post__confirm-actions">
              <button class="btn btn-danger" type="button" :disabled="busy" @click="emit('odin-confirm', { decision: 'approve', post })">Confirm</button>
              <button class="btn btn-outline-secondary" type="button" :disabled="busy" @click="emit('odin-confirm', { decision: 'decline', post })">Cancel</button>
            </div>
            <p v-else class="channel-post__confirm-note">{{ odinConfirmationNote(confirmation) }}</p>
          </section>
          <AssistantChangesCard v-if="odinChanges?.records?.length" :allow-undo="odinChanges.canUndo" :busy="busy" :changes="odinChanges" :undoing="busy" @undo="emit('odin-undo', post)" />
          <PostReactions v-if="!editing" ref="reactionsBar" :can-react="Boolean(post.canReact)" :label="author" :reactions="post.reactions ?? []" @toggle="(change) => emit('react', { ...change, post })" />
          <div v-if="!editing && (post.canReply || post.canEdit || post.canDelete || post.canReact)" class="channel-post__actions">
            <button v-if="post.canReact" class="channel-post__action" type="button" :aria-label="`React to ${author}'s message`" @click="reactionsBar?.openPicker($event.currentTarget)"><i class="bi bi-emoji-smile" aria-hidden="true"></i> React</button>
            <button v-if="post.canReply" class="channel-post__action" type="button" :aria-label="`Reply to ${author}`" @click="emit('begin-reply', post.id)">Reply</button>
            <button v-if="post.canEdit" class="channel-post__action" type="button" :aria-label="`Edit your message from ${postTimeLabel(post.createdAt)}`" @click="emit('begin-edit', post.id)">Edit</button>
            <button v-if="post.canDelete" class="channel-post__action channel-post__action--danger" type="button" :aria-label="`Delete the message from ${author}`" @click="emit('remove', post)">Delete</button>
          </div>
          <div v-if="editing" class="channel-post__form">
            <span :id="`channel-edit-label-${post.id}`" class="visually-hidden">Edit message</span>
            <RequirementsCommentEditor
              class="rich-editor--tools-float"
              ref="editField"
              v-model="editDraft"
              :labelled-by="`channel-edit-label-${post.id}`"
              :mentionables="mentionables"
              @submit="!busy && emit('submit-edit', { body: editDraft, post })"
            />
            <div class="channel-post__form-actions">
              <button class="ghost-button ghost-button--compact" type="button" :disabled="busy" @click="emit('cancel')">Cancel</button>
              <button class="primary-button primary-button--compact" type="button" :disabled="busy || (!editDraft.trim() && !post.attachments?.length)" @click="emit('submit-edit', { body: editDraft, post })">
                {{ busy ? 'Saving…' : 'Save' }}
              </button>
            </div>
          </div>
        </template>
      </div>
    </article>

    <ul v-if="post.replies?.length || replying || odinReplying || typingLabel" class="channel-post__replies">
      <ChannelPost
        v-for="reply in post.replies ?? []"
        :key="reply.id"
        :busy-id="busyId"
        :editing-id="editingId"
        :focus-id="focusId"
        :mentionables="mentionables"
        :post="reply"
        :quoted="quoteFor(reply, post.replies)"
        :show-version="showVersion"
        @begin-edit="emit('begin-edit', $event)"
        @begin-reply="(replyId) => emit('begin-reply', post.id, replyId)"
        @cancel="emit('cancel')"
        @focus-post="emit('focus-post', $event)"
        @odin-confirm="emit('odin-confirm', $event)"
        @odin-undo="emit('odin-undo', $event)"
        @open-file="emit('open-file', $event)"
        @react="emit('react', $event)"
        @remove="emit('remove', $event)"
        @submit-edit="emit('submit-edit', $event)"
      />
      <li v-if="typingLabel" class="channel-post channel-post--reply channel-post__typing" role="status">{{ typingLabel }}</li>
      <li v-if="odinReplying" class="channel-post channel-post--reply channel-post__odin-working" role="status">
        <OdinAvatar :interactive="false" />
        <span><span class="channel-post__dots" aria-hidden="true"></span> Odin is replying…</span>
      </li>
      <li v-if="replying" class="channel-post channel-post--reply">
        <div
          class="channel-post__form"
          :class="{ 'channel-post__form--drop': replyDropping }"
          @dragleave="replyDropping = false"
          @dragover="onReplyDragOver"
          @drop.capture="onReplyDrop"
          @paste.capture="onReplyPaste"
        >
          <span :id="`channel-reply-label-${post.id}`" class="visually-hidden">{{ replyQuote?.author ? `Reply to ${replyQuote.author}` : `Reply to ${author}` }}</span>
          <RequirementsCommentEditor
            class="rich-editor--tools-float"
            ref="replyField"
            v-model="replyDraft"
            :labelled-by="`channel-reply-label-${post.id}`"
            :mentionables="mentionables"
            placeholder="Write a reply. Type @ to tag someone."
            @submit="sendReply"
          />
          <AttachmentTray v-if="filesAllowed" :disabled="busy" :entries="replyFiles.entries.value" @remove="replyFiles.remove" />
          <p v-if="replyFileError" class="channel-post__file-error" role="alert">{{ replyFileError }}</p>
          <div class="channel-post__form-actions">
            <!-- What this reply answers, by its buttons: the formatting tools float over what is above the box. -->
            <p v-if="replyQuote" class="channel-post__replying-to">
              <span class="channel-post__quote-mark" aria-hidden="true">↩</span>
              <span class="channel-post__quote-text">
                <template v-if="replyQuote.author"><strong>{{ replyQuote.author }}:</strong> {{ replyQuote.text }}</template>
                <template v-else>Earlier message</template>
              </span>
              <button class="channel-post__quote-clear" type="button" aria-label="Reply to the thread instead" title="Reply to the thread instead" @click="emit('begin-reply', post.id)">
                <i class="bi bi-x-lg" aria-hidden="true"></i>
              </button>
            </p>
            <template v-if="filesAllowed">
              <input :id="`${uid}-reply-files`" class="visually-hidden" type="file" multiple :disabled="busy" @change="pickReplyFiles" />
              <label class="channel-post__attach" :for="`${uid}-reply-files`" title="Attach files">
                <i class="bi bi-paperclip" aria-hidden="true"></i><span class="visually-hidden">Attach files</span>
              </label>
            </template>
            <span v-if="busy && progress" class="channel-post__progress" role="status">{{ progress }}</span>
            <button class="ghost-button ghost-button--compact" type="button" :disabled="busy" @click="emit('cancel')">Cancel</button>
            <button class="primary-button primary-button--compact" type="button" :disabled="busy || !canSendReply" @click="sendReply">
              {{ busy ? 'Posting…' : 'Post reply' }}
            </button>
          </div>
        </div>
      </li>
    </ul>
  </li>
</template>

<style scoped>
.channel-post { display: grid; gap: 0.35rem; list-style: none; }
.channel-post__card { display: grid; grid-template-columns: 2rem minmax(0, 1fr); gap: 0.6rem; padding: 0.5rem 0.25rem; border-radius: 0.4rem; }
.channel-post--focused > .channel-post__card { background: var(--surface-soft); box-shadow: inset 0.2rem 0 0 var(--accent); }
.channel-post__avatar { display: inline-grid; place-items: center; width: 2rem; height: 2rem; border-radius: 50%; background: var(--surface-soft); color: var(--ink-soft); font-size: 0.75rem; font-weight: 700; }
.channel-post__main { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0.25rem; min-width: 0; }
.channel-post__meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.25rem 0.5rem; color: var(--muted); font-size: 0.75rem; }
.channel-post__meta strong { color: var(--ink); font-size: 0.875rem; }
.channel-post__chip { padding: 0.05rem 0.45rem; border-radius: 999px; background: var(--surface-soft); color: var(--ink-soft); font-weight: 600; }
.channel-post__body { min-width: 0; overflow-wrap: anywhere; }
.channel-post__body :deep(p) { margin: 0 0 0.35rem; }
.channel-post__body :deep(p:last-child) { margin-bottom: 0; }
.channel-post__deleted { display: flex; align-items: center; gap: 0.35rem; min-height: 2rem; margin: 0; color: var(--muted); font-style: italic; }
.channel-post__actions { display: flex; flex-wrap: wrap; gap: 0.25rem; }
.channel-post__action { min-height: 2.75rem; padding: 0 0.5rem; border: 0; border-radius: 0.35rem; background: transparent; color: var(--ink-soft); font-size: 0.8rem; font-weight: 600; }
.channel-post__action:hover { background: var(--surface-soft); color: var(--ink); }
.channel-post__action--danger:hover { color: var(--danger); }
.channel-post__action:focus-visible { outline: 0.18rem solid var(--accent); outline-offset: 0.1rem; }
.channel-post__form { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0.35rem; min-width: 0; }
.channel-post__form-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 0.5rem; }
.channel-post__form--drop { outline: 0.15rem dashed var(--accent); outline-offset: 0.25rem; border-radius: 0.4rem; }
.channel-post__attach { display: inline-grid; place-items: center; width: 2.75rem; height: 2.75rem; border-radius: 0.35rem; color: var(--ink-soft); cursor: pointer; }
.channel-post__attach:hover { background: var(--surface-soft); color: var(--ink); }
input:focus-visible + .channel-post__attach { outline: 0.18rem solid var(--accent); outline-offset: 0.1rem; }
.channel-post__progress { color: var(--muted); font-size: 0.75rem; }
.channel-post__file-error { margin: 0; color: var(--danger); font-size: 0.8125rem; }
.channel-post__confirm { display: grid; gap: 0.4rem; padding: 0.6rem 0.75rem; border: 1px solid var(--line); border-radius: 0.4rem; background: var(--surface); }
.channel-post__confirm--open { border-color: color-mix(in srgb, var(--danger) 45%, var(--line)); }
.channel-post__confirm-title { display: flex; gap: 0.4rem; align-items: baseline; margin: 0; font-weight: 600; overflow-wrap: anywhere; }
.channel-post__confirm-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.channel-post__confirm-actions .btn { min-height: 2.75rem; }
.channel-post__confirm-note { margin: 0; color: var(--muted); font-size: 0.85rem; }
.channel-post__typing { padding: 0.35rem 0.25rem; color: var(--muted); font-size: 0.8125rem; }
.channel-post__odin-working { display: flex; align-items: center; gap: 0.6rem; padding: 0.35rem 0.25rem; color: var(--muted); font-size: 0.85rem; }
.channel-post__dots { display: inline-block; width: 0.5rem; height: 0.5rem; margin-right: 0.15rem; border-radius: 50%; background: var(--accent); animation: channel-post-pulse 1.2s ease-in-out infinite; }
@keyframes channel-post-pulse { 0%, 100% { opacity: 0.25; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .channel-post__dots { animation: none; } }
.channel-post__quote,
.channel-post__replying-to { display: flex; align-items: baseline; gap: 0.35rem; min-width: 0; max-width: 100%; margin: 0; padding: 0.2rem 0.5rem; border: 0; border-left: 2px solid var(--line-strong); border-radius: 0 0.3rem 0.3rem 0; background: var(--surface-soft); color: var(--ink-soft); font-size: 0.8rem; text-align: left; }
.channel-post__quote { justify-self: start; min-height: 2rem; overflow: hidden; }
.channel-post__quote:hover:not(:disabled) { color: var(--ink); }
.channel-post__quote:focus-visible { outline: 0.18rem solid var(--accent); outline-offset: 0.1rem; }
.channel-post__quote-mark { flex: none; color: var(--muted); }
.channel-post__quote-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.channel-post__quote-text strong { color: var(--ink); font-weight: 600; }
.channel-post__replying-to { flex: 1 1 auto; align-items: center; margin-right: auto; }
.channel-post__quote-clear { flex: none; display: inline-grid; place-items: center; width: 2rem; height: 2rem; margin-left: auto; border: 0; border-radius: 0.3rem; background: transparent; color: var(--muted); }
.channel-post__quote-clear:hover { color: var(--ink); }
.channel-post__quote-clear:focus-visible { outline: 0.18rem solid var(--accent); }
.channel-post--focused > .channel-post__card { transition: background-color 0.4s ease; }
@media (pointer: coarse) {
  .channel-post__quote { min-height: 2.75rem; }
  .channel-post__quote-clear { width: 2.75rem; height: 2.75rem; }
}
.channel-post__replies { display: grid; gap: 0.25rem; margin: 0 0 0 1.25rem; padding: 0 0 0 0.75rem; border-left: 2px solid var(--line); }
</style>
