<script setup>
import { computed, reactive, watch } from 'vue';

import RequirementsDialog from '../requirements/RequirementsDialog.vue';
import { apiClient, authSession } from '../../lib/auth/index.js';
import { deliveryStoryOptions, pursuitMovePayload, pursuitTasks } from '../../lib/pursuit/pursuit.js';

// Moves pursuit tasks to the project plan, under a story the person chooses. One task or
// several; all of them move or none do.

const props = defineProps({
  open: { default: false, type: Boolean },
  projectId: { required: true, type: String },
  pursuitProject: { default: null, type: Object },
});

const emit = defineEmits(['close', 'moved']);

const state = reactive({ busy: false, error: '', loadingStories: false, stories: [], storyId: '', taskIds: [] });
const tasks = computed(() => pursuitTasks(props.pursuitProject));

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    Object.assign(state, { busy: false, error: '', storyId: '', taskIds: [] });
    state.loadingStories = true;
    try {
      const plan = await apiClient.passive.getProject(props.projectId, authSession.state.token);
      state.stories = deliveryStoryOptions(plan.project);
      if (state.stories.length === 1) state.storyId = state.stories[0].id;
    } catch {
      state.stories = [];
    } finally {
      state.loadingStories = false;
    }
  },
);

function toggle(taskId) {
  state.taskIds = state.taskIds.includes(taskId) ? state.taskIds.filter((id) => id !== taskId) : [...state.taskIds, taskId];
}

async function submit() {
  if (state.busy) return;
  if (!state.taskIds.length) { state.error = 'Choose at least one task.'; return; }
  if (!state.storyId) { state.error = 'Choose the story they go under.'; return; }
  state.busy = true;
  state.error = '';
  try {
    const result = await apiClient.movePursuitTasks(props.projectId, pursuitMovePayload({ project: props.pursuitProject, storyId: state.storyId, taskIds: state.taskIds }), authSession.state.token);
    emit('moved', result);
  } catch (error) {
    const code = error?.data?.details?.code ?? error?.details?.code;
    state.error = code === 'project_item_version_conflict'
      ? 'A task changed while you were choosing. Close this and try again.'
      : error?.message || 'The tasks could not be moved. Nothing was changed.';
  } finally {
    state.busy = false;
  }
}
</script>

<template>
  <RequirementsDialog :busy="state.busy" :open="open" title="Move tasks to the project" @close="emit('close')" @submit="submit">
    <fieldset class="rq-field pursuit-move__tasks">
      <legend>Tasks</legend>
      <label v-for="task in tasks" :key="task.id" class="planning-check-row">
        <input type="checkbox" :checked="state.taskIds.includes(task.id)" :disabled="state.busy" @change="toggle(task.id)" />
        <span>{{ task.name }} <small class="text-body-secondary">{{ task.status }}</small></span>
      </label>
    </fieldset>
    <div class="rq-field">
      <label for="pursuit-move-story">Story</label>
      <select id="pursuit-move-story" v-model="state.storyId" class="form-select" :disabled="state.busy || state.loadingStories">
        <option value="" disabled>{{ state.loadingStories ? 'Loading stories…' : 'Choose a story' }}</option>
        <option v-for="story in state.stories" :key="story.id" :value="story.id">{{ story.label }}</option>
      </select>
      <p v-if="!state.loadingStories && !state.stories.length" class="rq-field__hint">Add a story to the plan first.</p>
    </div>
    <p v-if="state.error" class="error-banner mb-0" role="alert">{{ state.error }}</p>
    <template #footer>
      <button class="ghost-button" type="button" :disabled="state.busy" @click="emit('close')">Cancel</button>
      <button class="primary-button" type="submit" :disabled="state.busy || !state.stories.length">{{ state.busy ? 'Moving…' : 'Move' }}</button>
    </template>
  </RequirementsDialog>
</template>

<style scoped>
.pursuit-move__tasks {
  display: grid;
  gap: 0.35rem;
  max-height: 16rem;
  margin: 0;
  overflow-y: auto;
  border: 0;
  padding: 0;
}

.pursuit-move__tasks legend {
  font-size: inherit;
  font-weight: 500;
}
</style>
