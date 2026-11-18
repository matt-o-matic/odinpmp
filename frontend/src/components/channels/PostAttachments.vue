<script setup>
import { computed, inject, nextTick, onBeforeUnmount, onMounted, reactive, ref, useId, watch } from 'vue';

import { useChannelApi } from '../../lib/channels/channel-api.js';
import { POST_FILES_KEY, SCAN_RETRY_MS, attachmentIcon, attachmentKind, isStillScanning, previewStillValid } from '../../lib/channels/attachments.js';
import { onProjectRefresh } from '../../lib/live/live-refresh.js';
import { fileErrorMessage, fileSizeLabel } from '../../lib/projects/project-files.js';
import FilePreviewDialog from '../projects/FilePreviewDialog.vue';
import AttachmentLightbox from './AttachmentLightbox.vue';

// The files on one message. Images and videos show inline as soon as the message scrolls into
// view, and a press opens them full screen. Every other file is a card that opens the preview
// dialog. Each file's ⋯ menu has Open, Download and, in a channel, Show in files (the library,
// through 'open-file'). A file still in its virus scan shows "Checking the file…" until it passes.
const props = defineProps({
  files: { default: () => [], type: Array },
});

const emit = defineEmits(['open-file']);

const api = useChannelApi();
// The conversation's project, session and live counter. Without it (a file's comments), files
// are cards that open the library.
const context = inject(POST_FILES_KEY, null);
const inline = Boolean(context);
const libraryLink = computed(() => !context || context.libraryLink());
const uid = useId();

const root = ref(null);
const tiles = new Map();
const previews = reactive({});
const errorMessage = ref('');
const lightboxIndex = ref(-1);
const preview = reactive({ busy: false, file: null, mounted: false, open: false });
const timers = new Map();
let observer = null;
let visible = false;

const visuals = computed(() => (inline ? props.files.filter((file) => attachmentKind(file) !== 'file') : []));
const cards = computed(() => (inline ? props.files.filter((file) => attachmentKind(file) === 'file') : props.files));
const lightboxItems = computed(() => visuals.value.map((file) => ({ file, kind: attachmentKind(file), url: previews[file.id]?.state === 'ready' ? previews[file.id].url : '' })));
const stateOf = (file) => previews[file.id]?.state ?? 'idle';

function setTile(id, element) {
  if (element) tiles.set(id, element);
  else tiles.delete(id);
}

async function loadPreview(file, { retry = false } = {}) {
  if (!previews[file.id]) previews[file.id] = { expiresAt: null, state: 'idle', tries: 0, url: '' };
  const entry = previews[file.id];
  if (entry.state === 'loading') return entry.pending;
  clearTimeout(timers.get(file.id));
  entry.state = 'loading';
  entry.pending = (async () => {
    try {
      const result = await api.passive.getFilePreviewUrl(context.projectId(), file.id, { version: file.version }, context.token());
      if (['image', 'video'].includes(result?.kind) && result.url) {
        Object.assign(entry, { expiresAt: result.expiresAt ?? null, state: 'ready', url: api.resolveTransferUrl(result.url) });
      } else {
        entry.state = 'failed';
      }
    } catch (error) {
      if (!isStillScanning(error)) {
        entry.state = 'failed';
        return;
      }
      entry.state = 'scanning';
      // A few tries, further apart each time. After that the live refresh looks again.
      const wait = retry ? 0 : SCAN_RETRY_MS[entry.tries];
      entry.tries += 1;
      if (wait) timers.set(file.id, setTimeout(() => loadPreview(file), wait));
    }
  })();
  return entry.pending;
}

function loadAll() {
  for (const file of visuals.value) if (stateOf(file) === 'idle') void loadPreview(file);
}

// Someone else's change, or the scan finishing: look again at files that were still scanning.
function lookAgain() {
  for (const file of visuals.value) if (stateOf(file) === 'scanning') void loadPreview(file, { retry: true });
}
onProjectRefresh(lookAgain);
if (context) watch(() => context.liveVersion(), lookAgain);

watch(visuals, () => { if (visible) loadAll(); });

onMounted(() => {
  if (!inline) return;
  if (typeof IntersectionObserver === 'undefined') {
    visible = true;
    loadAll();
    return;
  }
  observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    visible = true;
    loadAll();
    observer?.disconnect();
    observer = null;
  }, { rootMargin: '200px 0px' });
  if (root.value) observer.observe(root.value);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  for (const timer of timers.values()) clearTimeout(timer);
});

// A signed URL lasts 5 minutes: one that is about to end is signed again before it is shown.
async function ensureFresh(file) {
  const entry = previews[file.id];
  if (entry?.state === 'ready' && previewStillValid(entry.expiresAt)) return true;
  if (entry?.state === 'ready') entry.state = 'idle';
  await loadPreview(file);
  return previews[file.id]?.state === 'ready';
}

async function openVisual(file) {
  if (!(await ensureFresh(file))) {
    // Still scanning, or no inline preview after all: the preview dialog says why.
    openPreview(file);
    return;
  }
  lightboxIndex.value = visuals.value.findIndex((entry) => entry.id === file.id);
}

function stepLightbox(index) {
  lightboxIndex.value = index;
  const file = visuals.value[index];
  if (file) void ensureFresh(file);
}

async function closeLightbox() {
  const file = visuals.value[lightboxIndex.value];
  lightboxIndex.value = -1;
  await nextTick();
  if (file) tiles.get(file.id)?.focus();
}

function openPreview(file) {
  Object.assign(preview, { file, mounted: true, open: true });
}

function open(file) {
  if (!inline) {
    emit('open-file', file);
    return;
  }
  // From the ⋯ menu: the file's own button is where focus goes back to.
  tiles.get(file.id)?.focus();
  if (attachmentKind(file) === 'file') openPreview(file);
  else void openVisual(file);
}

async function download(file) {
  if (!file || preview.busy) return;
  preview.busy = true;
  errorMessage.value = '';
  try {
    const result = await api.getFileDownloadUrl(context?.projectId() ?? '', file.id, {}, context?.token() ?? '');
    globalThis.location?.assign(api.resolveTransferUrl(result.url));
  } catch (error) {
    errorMessage.value = fileErrorMessage(error, 'The file could not download.');
  } finally {
    preview.busy = false;
  }
}

function showInFiles(file) {
  lightboxIndex.value = -1;
  preview.open = false;
  emit('open-file', file);
}
</script>

<template>
  <div ref="root" class="post-files">
    <ul v-if="visuals.length" class="post-files__visuals" :class="{ 'post-files__visuals--single': visuals.length === 1 }" aria-label="Attached images and videos">
      <li v-for="file in visuals" :key="file.id" class="post-files__tile" :class="`post-files__tile--${stateOf(file)}`">
        <button
          :ref="(element) => setTile(file.id, element)"
          class="post-files__thumb"
          type="button"
          :aria-label="`Open ${file.fileName}`"
          @click="stateOf(file) === 'failed' ? openPreview(file) : openVisual(file)"
        >
          <template v-if="stateOf(file) === 'ready'">
            <img v-if="attachmentKind(file) === 'image'" class="post-files__media" :src="previews[file.id].url" :alt="file.fileName" />
            <template v-else>
              <video class="post-files__media" :src="`${previews[file.id].url}#t=0.1`" muted playsinline preload="metadata" tabindex="-1" aria-hidden="true"></video>
              <span class="post-files__play" aria-hidden="true"><i class="bi bi-play-fill"></i></span>
            </template>
          </template>
          <span v-else class="post-files__placeholder">
            <i :class="['bi', stateOf(file) === 'scanning' ? 'bi-hourglass-split' : attachmentIcon(file)]" aria-hidden="true"></i>
            <span class="post-files__placeholder-name">{{ file.fileName }}</span>
            <span v-if="stateOf(file) === 'scanning'" class="post-files__status" role="status">Checking the file…</span>
            <span v-else class="post-files__status">{{ fileSizeLabel(file.fileSize) }}</span>
          </span>
        </button>
        <div class="dropdown post-files__menu post-files__menu--over">
          <button
            :id="`${uid}-more-${file.id}`"
            class="post-files__more post-files__more--over"
            type="button"
            data-bs-toggle="dropdown"
            data-bs-popper-config='{"strategy":"fixed"}'
            aria-expanded="false"
            :aria-label="`More actions for ${file.fileName}`"
          >
            <i class="bi bi-three-dots" aria-hidden="true"></i>
          </button>
          <ul class="dropdown-menu dropdown-menu-end" role="menu" :aria-labelledby="`${uid}-more-${file.id}`">
            <li role="none"><button class="dropdown-item post-files__item" type="button" role="menuitem" @click="open(file)"><i class="bi bi-arrows-fullscreen" aria-hidden="true"></i> Open</button></li>
            <li role="none"><button class="dropdown-item post-files__item" type="button" role="menuitem" @click="download(file)"><i class="bi bi-download" aria-hidden="true"></i> Download</button></li>
            <li v-if="libraryLink" role="none"><button class="dropdown-item post-files__item" type="button" role="menuitem" @click="showInFiles(file)"><i class="bi bi-folder2-open" aria-hidden="true"></i> Show in files</button></li>
          </ul>
        </div>
      </li>
    </ul>

    <ul v-if="cards.length" class="post-files__cards" aria-label="Attached files">
      <li v-for="file in cards" :key="file.id" class="post-files__card">
        <button :ref="(element) => setTile(file.id, element)" class="post-files__open" type="button" :aria-label="`Open ${file.fileName}`" @click="open(file)">
          <i :class="['bi', attachmentIcon(file), 'post-files__icon']" aria-hidden="true"></i>
          <span class="post-files__name">{{ file.fileName }}</span>
          <span class="post-files__size">{{ fileSizeLabel(file.fileSize) }}</span>
        </button>
        <div class="dropdown post-files__menu">
          <button
            :id="`${uid}-more-${file.id}`"
            class="post-files__more"
            type="button"
            data-bs-toggle="dropdown"
            data-bs-popper-config='{"strategy":"fixed"}'
            aria-expanded="false"
            :aria-label="`More actions for ${file.fileName}`"
          >
            <i class="bi bi-three-dots" aria-hidden="true"></i>
          </button>
          <ul class="dropdown-menu dropdown-menu-end" role="menu" :aria-labelledby="`${uid}-more-${file.id}`">
            <li v-if="inline" role="none"><button class="dropdown-item post-files__item" type="button" role="menuitem" @click="open(file)"><i class="bi bi-eye" aria-hidden="true"></i> Preview</button></li>
            <li v-if="inline" role="none"><button class="dropdown-item post-files__item" type="button" role="menuitem" @click="download(file)"><i class="bi bi-download" aria-hidden="true"></i> Download</button></li>
            <li v-if="libraryLink" role="none"><button class="dropdown-item post-files__item" type="button" role="menuitem" @click="showInFiles(file)"><i class="bi bi-folder2-open" aria-hidden="true"></i> Show in files</button></li>
          </ul>
        </div>
      </li>
    </ul>

    <p v-if="errorMessage" class="error-banner mb-0" role="alert">{{ errorMessage }}</p>

    <AttachmentLightbox
      v-if="visuals.length"
      :index="lightboxIndex"
      :items="lightboxItems"
      :library-link="libraryLink"
      @close="closeLightbox"
      @download="download"
      @show-in-files="showInFiles"
      @update:index="stepLightbox"
    />
    <FilePreviewDialog
      v-if="preview.mounted"
      :busy="preview.busy"
      :file="preview.file"
      :open="preview.open"
      :project-id="context?.projectId() ?? ''"
      :token="context?.token() ?? ''"
      @close="preview.open = false"
      @download="download"
    />
  </div>
</template>

<style scoped>
.post-files { display: grid; gap: 0.4rem; min-width: 0; }
.post-files__visuals,
.post-files__cards { display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 0; padding: 0; list-style: none; }
.post-files__tile { position: relative; }
.post-files__thumb { display: grid; place-items: center; width: 8.5rem; height: 8.5rem; padding: 0; overflow: hidden; border: 1px solid var(--line); border-radius: 0.5rem; background: var(--surface-soft); color: var(--ink); cursor: zoom-in; }
.post-files__media { display: block; width: 100%; height: 100%; object-fit: cover; }
/* One picture shows whole, at its own shape, up to a size that keeps the conversation readable. */
.post-files__visuals--single .post-files__tile { max-width: 100%; }
.post-files__visuals--single .post-files__tile--ready .post-files__thumb { width: auto; min-width: 7rem; max-width: min(100%, 22rem); height: auto; min-height: 7rem; }
.post-files__visuals--single .post-files__tile--ready .post-files__media { width: auto; max-width: 100%; height: auto; max-height: 16rem; object-fit: contain; }
.post-files__visuals--single .post-files__thumb { width: min(100%, 16rem); height: 10rem; }
.post-files__tile--failed .post-files__thumb,
.post-files__tile--scanning .post-files__thumb { cursor: pointer; }
.post-files__placeholder { display: grid; justify-items: center; gap: 0.2rem; max-width: 100%; padding: 0.5rem; color: var(--muted); text-align: center; }
.post-files__placeholder .bi { font-size: 1.5rem; }
.post-files__placeholder-name { max-width: 100%; overflow: hidden; color: var(--ink); font-size: 0.8rem; text-overflow: ellipsis; white-space: nowrap; }
.post-files__status { font-size: 0.75rem; }
.post-files__play { position: absolute; top: 50%; left: 50%; display: grid; place-items: center; width: 2.75rem; height: 2.75rem; border-radius: 50%; background: rgba(15, 23, 42, 0.7); color: #fff; font-size: 1.4rem; transform: translate(-50%, -50%); pointer-events: none; }
.post-files__menu--over { position: absolute; top: 0.3rem; right: 0.3rem; }
.post-files__more { display: inline-grid; place-items: center; width: 2.75rem; height: 2.75rem; border: 0; border-radius: 0.35rem; background: transparent; color: var(--ink-soft); }
.post-files__more:hover { background: var(--surface-soft); color: var(--ink); }
.post-files__more--over { border-radius: 50%; background: rgba(15, 23, 42, 0.62); color: #fff; }
.post-files__more--over:hover { background: rgba(15, 23, 42, 0.85); color: #fff; }
.post-files__card { display: inline-flex; align-items: center; max-width: 100%; border: 1px solid var(--line); border-radius: 0.4rem; background: var(--surface); }
.post-files__open { display: inline-flex; align-items: center; gap: 0.4rem; min-width: 0; min-height: 2.75rem; padding: 0.25rem 0.25rem 0.25rem 0.65rem; border: 0; border-radius: 0.4rem 0 0 0.4rem; background: transparent; color: var(--ink); }
.post-files__open:hover { background: var(--surface-soft); }
.post-files__icon { color: var(--accent); font-size: 1.1rem; }
.post-files__name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.post-files__size { color: var(--muted); font-size: 0.75rem; white-space: nowrap; }
.post-files__item { display: flex; align-items: center; gap: 0.5rem; min-height: 2.75rem; }
.post-files__thumb:focus-visible,
.post-files__open:focus-visible,
.post-files__more:focus-visible { outline: 0.18rem solid var(--accent); outline-offset: 0.1rem; }
@media (max-width: 575.98px) {
  .post-files__thumb { width: 7rem; height: 7rem; }
}
</style>
