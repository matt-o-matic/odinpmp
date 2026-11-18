<script setup>
import { computed, nextTick, reactive, ref, watch } from 'vue';

import RequirementsDialog from './RequirementsDialog.vue';
import { apiClient } from '../../lib/auth/index.js';
import { copyText } from '../../lib/clipboard.js';
import { describeRequirementsError } from '../../lib/requirements/requirements-errors.js';
import { agentBriefWithUploadUrl, uploadUrlCommand } from '../../lib/requirements/requirements-packages.js';
import { formatDateTime } from '../../lib/requirements/requirements-time.js';
import { trackLabel } from '../../lib/requirements/requirements-tracks.js';

// A single-use upload URL for a developer's coding agent. The URL is the credential, so it
// is shown once, in this dialog, and never stored by the app.
const props = defineProps({
  getToken: { required: true, type: Function },
  open: { default: false, type: Boolean },
  projectId: { required: true, type: String },
  track: { required: true, type: String },
});

const emit = defineEmits(['close']);

const state = reactive({ brief: '', copyStatus: '', error: '', manualText: '', result: null, saving: false });
const copyButton = ref(null);
const manualField = ref(null);

const expiresText = computed(() => {
  const expiresAt = state.result?.expiresAt;
  if (!expiresAt) return '';
  const minutes = Math.max(0, Math.round((Date.parse(expiresAt) - Date.now()) / 60000));
  const at = formatDateTime(expiresAt);
  return minutes > 0 ? `Expires ${at}, in about ${minutes} min.` : `Expires ${at}.`;
});
const command = computed(() => (state.result?.url ? uploadUrlCommand(state.result.url) : ''));

watch(() => props.open, (open) => {
  if (open) Object.assign(state, { brief: '', copyStatus: '', error: '', manualText: '', result: null, saving: false });
  else state.result = null;
});

async function submit() {
  if (state.result) {
    close();
    return;
  }
  if (state.saving) return;
  state.saving = true;
  state.error = '';
  try {
    state.result = await apiClient.createRequirementsPackageUploadUrl(props.projectId, props.track, props.getToken());
    loadBrief();
    // The Create button is gone; keep keyboard focus inside the dialog, on Copy.
    await nextTick();
    copyButton.value?.focus();
  } catch (error) {
    state.error = describeRequirementsError(error, 'Unable to create an upload URL. Try again.').message;
  } finally {
    state.saving = false;
  }
}

async function copy(text, label) {
  if (!text) return;
  state.manualText = '';
  if (await copyText(text)) {
    state.copyStatus = `${label} copied.`;
    return;
  }
  // Copying is blocked: show the text, selected, to copy by hand.
  state.manualText = text;
  state.copyStatus = 'Copying is blocked in this browser. The text below is selected: press Ctrl+C (⌘C on a Mac).';
  await nextTick();
  manualField.value?.focus();
  manualField.value?.select();
}

// The track's agent instructions, loaded as soon as the URL exists so the Copy click
// writes them straight away.
async function loadBrief() {
  try {
    const { markdown } = await apiClient.getRequirementsAgentBrief(props.projectId, props.track, props.getToken());
    if (state.result) state.brief = markdown ?? '';
  } catch (error) {
    state.copyStatus = describeRequirementsError(error, 'Unable to load the agent instructions. Copy the URL instead.').message;
  }
}

// The instructions with this URL added: one paste gives the agent everything.
function copyInstructions() {
  if (!state.result?.url || !state.brief) return;
  copy(agentBriefWithUploadUrl(state.brief, { expiresAt: state.result.expiresAt, url: state.result.url }), 'Instructions');
}

function close() {
  state.result = null;
  emit('close');
}
</script>

<template>
  <RequirementsDialog
    :busy="state.saving"
    :open="open"
    :title="state.result ? 'Upload URL created' : 'Upload URL for a coding agent'"
    @close="close"
    @submit="submit"
  >
    <template v-if="!state.result">
      <p class="rq-small mb-0">
        Creates a private address a developer’s coding agent can send one {{ trackLabel(track) }} package zip to. The package lands here as the next draft, checked the same way as an upload in Odin.
      </p>
      <p class="rq-xs rq-muted mb-0">The URL works once and expires after 10 minutes. Anyone holding it can upload to this project until then.</p>
      <p v-if="state.error" class="error-banner mb-0" role="alert">{{ state.error }}</p>
    </template>
    <template v-else>
      <p class="rq-small mb-0">This is the only time the URL is shown. Give it to the coding agent now. {{ expiresText }}</p>
      <code class="rq-secret" data-testid="rq-upload-url">{{ state.result.url }}</code>
      <div class="rq-row rq-row--tight rq-row--wrap">
        <button class="ghost-button ghost-button--compact" type="button" :disabled="!state.brief" @click="copyInstructions">
          <i class="bi bi-robot" aria-hidden="true"></i>{{ state.brief ? 'Copy agent instructions' : 'Loading instructions…' }}
        </button>
        <button ref="copyButton" class="ghost-button ghost-button--compact" type="button" @click="copy(state.result.url, 'URL')">
          <i class="bi bi-clipboard" aria-hidden="true"></i>Copy URL
        </button>
        <button class="ghost-button ghost-button--compact" type="button" @click="copy(command, 'Command')">
          <i class="bi bi-terminal" aria-hidden="true"></i>Copy command
        </button>
        <span class="rq-xs rq-muted" role="status">{{ state.copyStatus }}</span>
      </div>
      <template v-if="state.manualText">
        <label class="visually-hidden" for="rq-upload-manual-copy">Text to copy</label>
        <textarea
          id="rq-upload-manual-copy"
          ref="manualField"
          class="form-control rq-upload-manual-copy"
          readonly
          rows="8"
          :value="state.manualText"
          @focus="$event.target.select()"
        ></textarea>
      </template>
      <p class="rq-xs rq-muted mb-0">"Copy agent instructions" includes this URL with the project's ids, topics, and package rules. The agent sends the zip with <code>PUT</code> and <code>Content-Type: application/zip</code>. A rejected upload spends the URL; the agent asks for a new one.</p>
    </template>
    <template #footer>
      <template v-if="!state.result">
        <button class="ghost-button" type="button" :disabled="state.saving" @click="close">Cancel</button>
        <button class="primary-button" type="submit" :disabled="state.saving">{{ state.saving ? 'Creating…' : 'Create upload URL' }}</button>
      </template>
      <button v-else class="primary-button" type="submit">Done</button>
    </template>
  </RequirementsDialog>
</template>

<style scoped>
.rq-upload-manual-copy {
  font-family: var(--font-mono);
  font-size: 0.8rem;
}
</style>
