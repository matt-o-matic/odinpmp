// The files waiting in a message box until Send: the channel's box and a thread's reply box.
// A file is picked, pasted or dropped; an image shows as a thumbnail from the file itself, before
// it is uploaded. An entry keeps its fileId once uploaded, so a send that fails and is tried again
// does not upload it twice.
import { ref } from 'vue';

import { fileSizeLabel } from '../projects/project-files.js';
import { pastedFiles, showsLocalThumbnail } from './attachments.js';

export const MAX_MESSAGE_FILES = 10;

/**
 * `maxBytes` returns the largest file the server takes now. `onError` gets the message for a file
 * that is too large or one too many.
 */
export function useAttachmentTray({ maxBytes, onError }) {
  const entries = ref([]);

  function add(files) {
    const limit = maxBytes();
    for (const file of files) {
      if (file.size > limit) {
        onError(`${file.name} is ${fileSizeLabel(file.size)}. Files can be up to ${fileSizeLabel(limit)}.`);
        continue;
      }
      if (entries.value.length >= MAX_MESSAGE_FILES) {
        onError(`A message can carry up to ${MAX_MESSAGE_FILES} files.`);
        break;
      }
      const thumbnail = showsLocalThumbnail(file) && typeof URL !== 'undefined' && URL.createObjectURL ? URL.createObjectURL(file) : '';
      entries.value = [...entries.value, { file, fileId: null, key: `${file.name}-${file.size}-${file.lastModified}-${entries.value.length}`, thumbnail }];
    }
  }

  function release(list) {
    for (const entry of list) if (entry.thumbnail) URL.revokeObjectURL(entry.thumbnail);
  }

  function remove(key) {
    release(entries.value.filter((entry) => entry.key === key));
    entries.value = entries.value.filter((entry) => entry.key !== key);
  }

  function clear() {
    release(entries.value);
    entries.value = [];
  }

  // A screenshot or an image pasted into the box is attached. Text, with or without a picture of
  // it beside (as Word and Excel copy), pastes as text. Returns whether the paste was taken.
  function takePaste(event) {
    const files = pastedFiles(event.clipboardData);
    if (!files.length) return false;
    event.preventDefault();
    event.stopPropagation();
    add(files);
    return true;
  }

  function takeDrop(event) {
    const files = [...(event.dataTransfer?.files ?? [])];
    if (!files.length) return false;
    event.preventDefault();
    event.stopPropagation();
    add(files);
    return true;
  }

  return { add, clear, entries, remove, takeDrop, takePaste };
}
