<script setup>
import { fileSizeLabel } from '../../lib/projects/project-files.js';

// The files waiting in a message box (lib/channels/attachment-tray.js): a thumbnail or a clip,
// the name and size, and a button to take each one out.
defineProps({
  disabled: { default: false, type: Boolean },
  entries: { required: true, type: Array },
});
const emit = defineEmits(['remove']);
</script>

<template>
  <ul v-if="entries.length" class="attachment-tray" aria-label="Files to attach">
    <li v-for="entry in entries" :key="entry.key" class="attachment-tray__item" :class="{ 'attachment-tray__item--image': entry.thumbnail }">
      <img v-if="entry.thumbnail" class="attachment-tray__thumbnail" :src="entry.thumbnail" :alt="entry.file.name" />
      <i v-else class="bi bi-paperclip" aria-hidden="true"></i>
      <span class="attachment-tray__name">{{ entry.file.name }}</span>
      <span class="attachment-tray__size">{{ fileSizeLabel(entry.file.size) }}</span>
      <button class="attachment-tray__remove" type="button" :aria-label="`Remove ${entry.file.name}`" :disabled="disabled" @click="emit('remove', entry.key)">
        <i class="bi bi-x-lg" aria-hidden="true"></i>
      </button>
    </li>
  </ul>
</template>

<style scoped>
.attachment-tray { display: flex; flex-wrap: wrap; gap: 0.35rem; margin: 0; padding: 0; list-style: none; }
.attachment-tray__item { display: inline-flex; align-items: center; gap: 0.35rem; max-width: 100%; padding-left: 0.6rem; border: 1px solid var(--line); border-radius: 0.4rem; background: var(--surface); }
.attachment-tray__item--image { padding-left: 0.25rem; }
.attachment-tray__thumbnail { width: 3rem; height: 3rem; border-radius: 0.3rem; object-fit: cover; }
.attachment-tray__name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.attachment-tray__size { color: var(--muted); font-size: 0.75rem; white-space: nowrap; }
.attachment-tray__remove { display: inline-grid; place-items: center; width: 2.75rem; height: 2.75rem; border: 0; border-radius: 0.3rem; background: transparent; color: var(--ink-soft); }
.attachment-tray__remove:hover:not(:disabled) { color: var(--ink); }
.attachment-tray__remove:focus-visible { outline: 0.18rem solid var(--accent); outline-offset: 0.1rem; }
</style>
