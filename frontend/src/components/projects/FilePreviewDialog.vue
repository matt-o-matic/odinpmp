<script setup>
import { computed, ref, watch } from 'vue';

import { useChannelApi } from '../../lib/channels/channel-api.js';
import { onProjectRefresh } from '../../lib/live/live-refresh.js';
import { loadPreviewText, previewNotice } from '../../lib/projects/file-preview.js';
import { fileErrorMessage } from '../../lib/projects/project-files.js';
import RequirementsDialog from '../requirements/RequirementsDialog.vue';
import RequirementsMarkdown from '../requirements/RequirementsMarkdown.vue';

// The app's API for members; the guest view provides the guest API (lib/channels/channel-api.js).
const api = useChannelApi();

// One file's current version, shown in a dialog: a PDF (or an Office file's converted PDF), an
// image, a video, text, or Markdown through the app's sanitized renderer. Office files show
// "Preparing preview" until the preview worker is done, and the project's live refresh brings the
// preview in. Download is the dialog's one action; the panel does it.
const props = defineProps({
  busy: { default: false, type: Boolean },
  file: { default: null, type: Object },
  open: { default: false, type: Boolean },
  projectId: { default: '', type: String },
  token: { default: '', type: String },
});

const emit = defineEmits(['close', 'download']);

const preview = ref(null);
const text = ref('');
const loading = ref(false);
const errorMessage = ref('');
// A signed URL lasts 5 minutes: a video that stops loading after that gets a new one, once.
let renewedVideo = false;
let loadToken = 0;

const kind = computed(() => preview.value?.kind ?? '');
const shows = computed(() => ['image', 'markdown', 'pdf', 'text', 'video'].includes(kind.value));
const notice = computed(() => (preview.value && !shows.value ? previewNotice(preview.value) : null));
const url = computed(() => (preview.value?.url ? api.resolveTransferUrl(preview.value.url) : ''));
const title = computed(() => props.file?.fileName ?? 'Preview');

async function load({ quiet = false } = {}) {
  const run = ++loadToken;
  const file = props.file;
  if (!props.open || !file) return;
  if (!quiet) {
    loading.value = true;
    preview.value = null;
    text.value = '';
  }
  errorMessage.value = '';
  try {
    const client = quiet ? api.passive : api;
    const result = await client.getFilePreviewUrl(props.projectId, file.id, { version: file.version }, props.token);
    const body = result.kind === 'text' || result.kind === 'markdown' ? await loadPreviewText(api.resolveTransferUrl(result.url)) : '';
    if (run !== loadToken) return;
    preview.value = result;
    text.value = body;
  } catch (error) {
    if (run === loadToken && !quiet) errorMessage.value = fileErrorMessage(error, 'Unable to load the preview.');
  } finally {
    if (run === loadToken) loading.value = false;
  }
}

async function videoFailed(event) {
  if (renewedVideo) return;
  renewedVideo = true;
  const at = event.target?.currentTime ?? 0;
  await load({ quiet: true });
  const video = event.target;
  if (video && at) video.addEventListener('loadedmetadata', () => { video.currentTime = at; }, { once: true });
}

watch(() => [props.open, props.file?.id, props.file?.version], ([open]) => {
  renewedVideo = false;
  if (open) load();
  else {
    loadToken += 1;
    preview.value = null;
    text.value = '';
  }
}, { immediate: true });

// Someone else's change, or the preview worker finishing: look again while it is being prepared.
onProjectRefresh(() => {
  if (props.open && kind.value === 'preparing') load({ quiet: true });
});
</script>

<template>
  <RequirementsDialog class="file-preview-dialog" :open="open" :title="title" @close="emit('close')" @submit="emit('download', file)">
    <div class="file-preview" :data-kind="kind || null">
      <p v-if="loading" class="file-preview__note" role="status">Loading preview…</p>
      <p v-else-if="errorMessage" class="error-banner mb-0" role="alert">{{ errorMessage }}</p>
      <template v-else-if="preview">
        <!-- An object, not an iframe: the app's frame-src allows no frames from storage. -->
        <object v-if="kind === 'pdf'" class="file-preview__pdf" :data="url" type="application/pdf" :aria-label="`Preview of ${title}`">
          <p class="file-preview__note">
            This browser does not show PDFs here.
            <a :href="url" target="_blank" rel="noopener noreferrer">Open the PDF in a new tab</a>.
          </p>
        </object>
        <img v-else-if="kind === 'image'" class="file-preview__image" :src="url" :alt="title" />
        <video v-else-if="kind === 'video'" class="file-preview__video" :src="url" controls playsinline preload="metadata" @error="videoFailed">
          <a :href="url" target="_blank" rel="noopener noreferrer">Open the video in a new tab</a>
        </video>
        <pre v-else-if="kind === 'text'" class="file-preview__text" tabindex="0" :aria-label="`Contents of ${title}`">{{ text }}</pre>
        <div v-else-if="kind === 'markdown'" class="file-preview__markdown" tabindex="0" :aria-label="`Contents of ${title}`">
          <RequirementsMarkdown :source="text" />
        </div>
        <div v-else class="file-preview__notice" role="status">
          <i :class="['bi', notice.preparing ? 'bi-hourglass-split' : 'bi-file-earmark-x']" aria-hidden="true"></i>
          <strong>{{ notice.title }}</strong>
          <span>{{ notice.detail }}</span>
        </div>
      </template>
    </div>
    <template #footer>
      <a v-if="kind === 'pdf' && url" class="ghost-button file-preview__tab" :href="url" target="_blank" rel="noopener noreferrer">
        <i class="bi bi-box-arrow-up-right" aria-hidden="true"></i>
        <span>Open in new tab</span>
      </a>
      <button class="primary-button" type="submit" :disabled="busy || !file">
        <i class="bi bi-download" aria-hidden="true"></i>
        <span>Download</span>
      </button>
    </template>
  </RequirementsDialog>
</template>

<style scoped>
.file-preview-dialog { width: min(64rem, calc(100vw - 2rem)); }
.file-preview { display: grid; min-height: 8rem; }
.file-preview__note { margin: 0; color: var(--muted); }
.file-preview__pdf { width: 100%; height: min(70dvh, 52rem); border: 1px solid var(--line); border-radius: 0.4rem; background: var(--surface-soft); }
.file-preview__pdf .file-preview__note { padding: 1rem; }
.file-preview__image { justify-self: center; max-width: 100%; max-height: 70dvh; object-fit: contain; border-radius: 0.4rem; }
.file-preview__video { width: 100%; max-height: 70dvh; border-radius: 0.4rem; background: #000; }
.file-preview__text,
.file-preview__markdown { max-height: 65dvh; margin: 0; padding: 0.75rem; overflow: auto; border: 1px solid var(--line); border-radius: 0.4rem; background: var(--surface-soft); color: var(--ink); }
.file-preview__text { font-size: 0.8125rem; white-space: pre-wrap; overflow-wrap: anywhere; }
.file-preview__notice { display: grid; justify-items: center; gap: 0.35rem; padding: 2rem 1rem; text-align: center; color: var(--ink-soft); }
.file-preview__notice .bi { color: var(--muted); font-size: 1.75rem; }
.file-preview__notice strong { color: var(--ink); }
.file-preview__tab,
.file-preview-dialog .primary-button { display: inline-flex; align-items: center; justify-content: center; gap: 0.35rem; min-height: 2.75rem; }
.file-preview__tab { margin-right: auto; text-decoration: none; }
.file-preview__text:focus-visible,
.file-preview__markdown:focus-visible { outline: 0.18rem solid var(--accent); outline-offset: 0.1rem; }
</style>
