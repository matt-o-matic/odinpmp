<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';

// The images and videos of one post, full screen over a dark backdrop. Escape, Close, or a press
// on the backdrop closes it. The arrow keys and the side buttons step through the post's images
// and videos. The post loads each one's signed URL (`url`, empty while it loads) and puts focus
// back on the thumbnail when this closes.
const props = defineProps({
  index: { default: -1, type: Number },
  // [{ file, kind: 'image' | 'video', url }]
  items: { default: () => [], type: Array },
  libraryLink: { default: false, type: Boolean },
});

const emit = defineEmits(['close', 'download', 'show-in-files', 'update:index']);

const dialog = ref(null);
const closeButton = ref(null);
const open = computed(() => props.index >= 0 && props.index < props.items.length);
const current = computed(() => (open.value ? props.items[props.index] : null));
const several = computed(() => props.items.length > 1);
const name = computed(() => current.value?.file.fileName ?? '');

watch(open, async (value) => {
  await nextTick();
  const element = dialog.value;
  if (!element) return;
  if (value && !element.open) {
    element.showModal?.();
    closeButton.value?.focus();
  } else if (!value && element.open) {
    element.close();
  }
}, { immediate: true });

onBeforeUnmount(() => { if (dialog.value?.open) dialog.value.close(); });

// Closed here, before the post puts focus back on the thumbnail: closing a dialog returns focus
// to what had it before, which in Safari (a press does not focus a button) is the page.
function close() {
  if (dialog.value?.open) dialog.value.close();
  emit('close');
}

function step(by) {
  if (!several.value) return;
  emit('update:index', (props.index + by + props.items.length) % props.items.length);
}

function onKeydown(event) {
  // A focused video seeks with the arrow keys.
  if (event.target instanceof HTMLVideoElement) return;
  if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1); }
  if (event.key === 'ArrowRight') { event.preventDefault(); step(1); }
}

// The dialog fills the screen, so a press on it, or on the stage around the picture, is a press
// on the backdrop.
function onBackdrop(event) {
  if (event.target === dialog.value || event.target === event.currentTarget) close();
}
</script>

<template>
  <dialog ref="dialog" class="attachment-lightbox" :aria-label="name || 'Attachment'" @cancel.prevent="close" @click="onBackdrop" @keydown="onKeydown">
    <template v-if="current">
      <header class="attachment-lightbox__bar">
        <p class="attachment-lightbox__name">
          <span class="attachment-lightbox__file">{{ name }}</span>
          <span v-if="several" class="attachment-lightbox__count">{{ index + 1 }} of {{ items.length }}</span>
        </p>
        <button class="attachment-lightbox__button" type="button" :aria-label="`Download ${name}`" @click="emit('download', current.file)">
          <i class="bi bi-download" aria-hidden="true"></i><span class="attachment-lightbox__label">Download</span>
        </button>
        <button v-if="libraryLink" class="attachment-lightbox__button" type="button" :aria-label="`Show ${name} in files`" @click="emit('show-in-files', current.file)">
          <i class="bi bi-folder2-open" aria-hidden="true"></i><span class="attachment-lightbox__label">Show in files</span>
        </button>
        <button ref="closeButton" class="attachment-lightbox__button" type="button" aria-label="Close" @click="close">
          <i class="bi bi-x-lg" aria-hidden="true"></i>
        </button>
      </header>
      <div class="attachment-lightbox__stage" @click="onBackdrop">
        <button v-if="several" class="attachment-lightbox__step attachment-lightbox__step--back" type="button" aria-label="Previous" @click="step(-1)">
          <i class="bi bi-chevron-left" aria-hidden="true"></i>
        </button>
        <p v-if="!current.url" class="attachment-lightbox__loading" role="status">Loading…</p>
        <img v-else-if="current.kind === 'image'" :key="current.url" class="attachment-lightbox__media" :src="current.url" :alt="name" />
        <video v-else :key="current.url" class="attachment-lightbox__media" :src="current.url" controls playsinline preload="metadata" :aria-label="name"></video>
        <button v-if="several" class="attachment-lightbox__step attachment-lightbox__step--next" type="button" aria-label="Next" @click="step(1)">
          <i class="bi bi-chevron-right" aria-hidden="true"></i>
        </button>
      </div>
    </template>
  </dialog>
</template>

<style scoped>
/* Dark in both themes: a picture reads best on black. */
.attachment-lightbox { width: 100vw; max-width: 100vw; height: 100dvh; max-height: 100dvh; margin: 0; padding: 0; border: 0; background: rgba(5, 8, 15, 0.94); color: #f8fafc; }
.attachment-lightbox[open] { display: grid; grid-template-rows: auto minmax(0, 1fr); }
.attachment-lightbox::backdrop { background: rgba(5, 8, 15, 0.94); }
.attachment-lightbox__bar { display: flex; align-items: center; gap: 0.25rem; padding: 0.4rem max(0.5rem, env(safe-area-inset-right)) 0.4rem max(1rem, env(safe-area-inset-left)); }
.attachment-lightbox__name { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 0.6rem; flex: 1 1 auto; min-width: 0; margin: 0; font-weight: 600; }
.attachment-lightbox__file { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.attachment-lightbox__count { color: #cbd5e1; font-size: 0.8rem; font-weight: 400; }
.attachment-lightbox__button,
.attachment-lightbox__step { display: inline-flex; align-items: center; justify-content: center; gap: 0.4rem; min-width: 2.75rem; min-height: 2.75rem; padding: 0 0.6rem; border: 0; border-radius: 0.4rem; background: transparent; color: #f8fafc; }
.attachment-lightbox__button:hover,
.attachment-lightbox__step:hover { background: rgba(255, 255, 255, 0.14); }
.attachment-lightbox__button:focus-visible,
.attachment-lightbox__step:focus-visible { outline: 0.18rem solid #93c5fd; outline-offset: 0.1rem; }
.attachment-lightbox__stage { position: relative; display: grid; place-items: center; min-height: 0; padding: 0 3.5rem 1rem; }
.attachment-lightbox__media { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 0.25rem; }
video.attachment-lightbox__media { background: #000; }
.attachment-lightbox__loading { margin: 0; color: #cbd5e1; }
.attachment-lightbox__step { position: absolute; top: 50%; width: 2.75rem; padding: 0; border-radius: 50%; background: rgba(15, 23, 42, 0.7); font-size: 1.25rem; transform: translateY(-50%); }
.attachment-lightbox__step--back { left: 0.4rem; }
.attachment-lightbox__step--next { right: 0.4rem; }
@media (max-width: 575.98px) {
  .attachment-lightbox__label { display: none; }
  .attachment-lightbox__stage { padding: 0 0.25rem 0.5rem; }
  .attachment-lightbox__step { top: auto; bottom: 1rem; transform: none; }
}
</style>
