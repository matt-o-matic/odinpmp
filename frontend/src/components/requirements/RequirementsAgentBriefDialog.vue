<script setup>
import { nextTick, reactive, ref, watch } from 'vue';

import RequirementsDialog from './RequirementsDialog.vue';
import { apiClient } from '../../lib/auth/index.js';
import { copyText } from '../../lib/clipboard.js';
import { describeRequirementsError } from '../../lib/requirements/requirements-errors.js';
import { trackLabel } from '../../lib/requirements/requirements-tracks.js';

// The track's agent instructions. The text loads when the dialog opens, so Copy writes it
// in the same click, and it stays on screen to select by hand where copying is blocked.
const props = defineProps({
  getToken: { required: true, type: Function },
  open: { default: false, type: Boolean },
  projectId: { required: true, type: String },
  track: { required: true, type: String },
});

const emit = defineEmits(['close']);

const state = reactive({ error: '', loading: false, markdown: '', status: '' });
const textArea = ref(null);

watch(() => props.open, async (open) => {
  if (!open) return;
  Object.assign(state, { error: '', loading: true, markdown: '', status: '' });
  try {
    const result = await apiClient.getRequirementsAgentBrief(props.projectId, props.track, props.getToken());
    state.markdown = result.markdown ?? '';
  } catch (error) {
    state.error = describeRequirementsError(error, 'Unable to load the agent instructions.').message;
  } finally {
    state.loading = false;
  }
});

async function copy() {
  if (!state.markdown) return;
  if (await copyText(state.markdown)) {
    state.status = 'Copied. Paste it into the coding agent, and give it the package kit too.';
    return;
  }
  state.status = 'Copying is blocked in this browser. The text is selected: press Ctrl+C (⌘C on a Mac).';
  await nextTick();
  textArea.value?.focus();
  textArea.value?.select();
}
</script>

<template>
  <RequirementsDialog :open="open" :title="`Agent instructions: ${trackLabel(track)}`" @close="emit('close')" @submit="copy">
    <p class="rq-small mb-0">
      Paste this into the coding agent that builds the package, along with the package kit. It has this project’s ids, the round to build on, the topics questions can link to, and the rules that reject a package.
    </p>
    <p v-if="state.loading" class="rq-small rq-muted mb-0">Loading…</p>
    <p v-else-if="state.error" class="error-banner mb-0" role="alert">{{ state.error }}</p>
    <template v-else>
      <label class="visually-hidden" for="rq-agent-brief">Agent instructions</label>
      <textarea
        id="rq-agent-brief"
        ref="textArea"
        class="form-control rq-agent-brief"
        readonly
        rows="14"
        :value="state.markdown"
        @focus="$event.target.select()"
      ></textarea>
    </template>
    <p class="rq-xs rq-muted mb-0" role="status">{{ state.status }}</p>
    <template #footer>
      <button class="ghost-button" type="button" @click="emit('close')">Close</button>
      <button class="primary-button" type="submit" data-autofocus :disabled="!state.markdown">Copy instructions</button>
    </template>
  </RequirementsDialog>
</template>

<style scoped>
.rq-agent-brief {
  font-family: var(--font-mono);
  font-size: 0.8rem;
  white-space: pre;
}
</style>
