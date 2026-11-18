<script setup>
import { nextTick, ref } from 'vue';

import { readAttachment } from '../../lib/assistant/assistant-format.js';

// Where the user writes: Enter sends, Shift+Enter adds a line, files can be attached or dropped,
// and Stop ends a turn in progress.
const props = defineProps({
  allowWebResearch: { default: true, type: Boolean },
  disabled: { default: false, type: Boolean },
  placeholder: { default: 'Ask about this project, or tell the assistant what to do…', type: String },
  working: { default: false, type: Boolean },
});
const emit = defineEmits(['send', 'stop', 'toggle-web']);

const text = ref('');
const attachments = ref([]);
const attachError = ref('');
const dragging = ref(false);
const input = ref(null);
const fileInput = ref(null);

function resize() {
  const element = input.value;
  if (!element) return;
  element.style.height = 'auto';
  element.style.height = `${Math.min(element.scrollHeight, 240)}px`;
}

async function addFiles(files) {
  attachError.value = '';
  for (const file of [...files].slice(0, 6 - attachments.value.length)) {
    try {
      attachments.value = [...attachments.value, await readAttachment(file)];
    } catch (error) {
      attachError.value = error.message;
    }
  }
}

function send() {
  if (props.disabled || props.working || !text.value.trim()) return;
  emit('send', { attachments: attachments.value, message: text.value.trim() });
  text.value = '';
  attachments.value = [];
  attachError.value = '';
  nextTick(resize);
}

function handleKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    send();
  }
}

function handleDrop(event) {
  dragging.value = false;
  if (event.dataTransfer?.files?.length) void addFiles(event.dataTransfer.files);
}

defineExpose({
  focus: () => input.value?.focus(),
  fill(value) {
    text.value = value;
    nextTick(() => { resize(); input.value?.focus(); });
  },
});
</script>

<template>
  <form
    class="composer"
    :class="{ 'composer--dragging': dragging }"
    @submit.prevent="send"
    @dragover.prevent="dragging = true"
    @dragleave.prevent="dragging = false"
    @drop.prevent="handleDrop"
  >
    <ul v-if="attachments.length" class="composer__files" aria-label="Attached files">
      <li v-for="(file, index) in attachments" :key="`${file.name}-${index}`" class="composer__file">
        <i class="bi" :class="file.dataUrl ? 'bi-image' : 'bi-file-earmark-text'" aria-hidden="true"></i>
        <span>{{ file.name }}</span>
        <button type="button" class="composer__file-remove" :aria-label="`Remove ${file.name}`" @click="attachments = attachments.filter((_, position) => position !== index)">
          <i class="bi bi-x" aria-hidden="true"></i>
        </button>
      </li>
    </ul>
    <p v-if="attachError" class="composer__error" role="alert">{{ attachError }}</p>
    <label class="visually-hidden" for="assistant-composer-input">Message the assistant</label>
    <textarea
      id="assistant-composer-input"
      ref="input"
      v-model="text"
      class="composer__input"
      rows="1"
      :placeholder="placeholder"
      :disabled="disabled"
      @input="resize"
      @keydown="handleKeydown"
    ></textarea>
    <div class="composer__bar">
      <div class="composer__options">
        <input ref="fileInput" class="visually-hidden" type="file" multiple accept="image/*,.txt,.md,.markdown,.csv,.tsv,.json,.xml,.yaml,.yml,.log" tabindex="-1" aria-hidden="true" @change="addFiles($event.target.files); $event.target.value = ''" />
        <button class="composer__chip" type="button" :disabled="disabled || attachments.length >= 6" aria-label="Attach files" title="Attach text files or images" @click="fileInput?.click()">
          <i class="bi bi-paperclip" aria-hidden="true"></i>
        </button>
        <button class="composer__chip" :class="{ 'composer__chip--on': allowWebResearch }" type="button" aria-label="Web research" :aria-pressed="allowWebResearch" :disabled="disabled" @click="emit('toggle-web', !allowWebResearch)">
          <i class="bi bi-globe2" aria-hidden="true"></i>
          <span>Web research</span>
        </button>
      </div>
      <button v-if="working" class="btn btn-outline-danger composer__send" type="button" @click="emit('stop')">
        <i class="bi bi-stop-fill" aria-hidden="true"></i> Stop
      </button>
      <button v-else class="btn btn-primary composer__send" type="submit" :disabled="disabled || !text.trim()" aria-label="Send">
        <i class="bi bi-arrow-up" aria-hidden="true"></i>
        <span class="composer__send-label">Send</span>
      </button>
    </div>
  </form>
</template>

<style scoped>
.composer {
  background: var(--surface);
  border: 1px solid var(--line-strong);
  border-radius: 1rem;
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding: 0.6rem 0.6rem 0.5rem 0.9rem;
}

.composer:focus-within {
  border-color: var(--accent);
}

.composer--dragging {
  border-style: dashed;
  border-color: var(--accent);
}

.composer__input {
  background: transparent;
  border: 0;
  color: var(--ink);
  font-size: 1rem;
  line-height: 1.5;
  max-height: 240px;
  min-height: 2.75rem;
  outline: none;
  padding: 0.4rem 0;
  resize: none;
}

.composer__bar {
  align-items: center;
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
}

.composer__options {
  display: flex;
  gap: 0.35rem;
}

.composer__chip {
  align-items: center;
  background: none;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--muted);
  display: inline-flex;
  font-size: 0.82rem;
  gap: 0.35rem;
  min-height: 2.75rem;
  min-width: 2.75rem;
  justify-content: center;
  padding: 0 0.75rem;
}

.composer__chip--on {
  background: var(--surface-tint);
  border-color: var(--accent);
  color: var(--accent);
}

.composer__send {
  align-items: center;
  border-radius: 999px;
  display: inline-flex;
  gap: 0.35rem;
  min-height: 2.75rem;
  min-width: 2.75rem;
  justify-content: center;
}

.composer__files {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  list-style: none;
  margin: 0;
  padding: 0;
}

.composer__file {
  align-items: center;
  background: var(--surface-tint);
  border-radius: 999px;
  color: var(--ink);
  display: inline-flex;
  font-size: 0.8rem;
  gap: 0.35rem;
  padding: 0 0 0 0.6rem;
}

.composer__file-remove {
  background: none;
  border: 0;
  color: var(--muted);
  min-height: 2.25rem;
  min-width: 2.25rem;
}

.composer__error {
  color: var(--danger);
  font-size: 0.8rem;
  margin: 0;
}

@media (max-width: 575.98px) {
  .composer__chip span,
  .composer__send-label {
    display: none;
  }
}
</style>
