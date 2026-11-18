<script setup>
import { computed, reactive, ref, useId, watch } from 'vue';

import RequirementsDialog from '../requirements/RequirementsDialog.vue';
import { apiClient } from '../../lib/auth/index.js';
import { buildNewTask, describeAccessWriteError, newTaskForm } from '../../lib/task-access/access-view.js';

// Adds a task under a story from the access link. The server assigns it to the person, puts
// it in the first column's default status and the story's sprint, so the form only asks
// for the name, an optional description and an optional estimate.
const props = defineProps({
  open: { default: false, type: Boolean },
  projectId: { required: true, type: String },
  storyId: { default: '', type: String },
  stories: { default: () => [], type: Array },
  token: { required: true, type: String },
});

const emit = defineEmits(['close', 'created', 'problem', 'refresh']);

const uid = useId();
const fieldId = (name) => `access-add-${uid}-${name}`;
const form = reactive(newTaskForm());
const errors = ref({});
const formError = ref('');
const busy = ref(false);

const chosenStory = computed(() => props.stories.find((story) => story.id === form.storyId) ?? null);
// Opened from a story's own "Add task", the story is already chosen.
const storyFixed = computed(() => Boolean(props.storyId) && props.stories.some((story) => story.id === props.storyId));

watch(() => props.open, (open) => {
  if (!open) return;
  Object.assign(form, newTaskForm(props.storyId || (props.stories.length === 1 ? props.stories[0].id : '')));
  errors.value = {};
  formError.value = '';
}, { immediate: true });

function close() {
  if (!busy.value) emit('close');
}

async function submit() {
  if (busy.value) return;
  formError.value = '';
  const { errors: found, payload } = buildNewTask(form, props.stories);
  errors.value = found;
  if (!payload) return;
  busy.value = true;
  try {
    const result = await apiClient.createAccessTask(props.token, props.projectId, form.storyId, payload);
    emit('created', result?.task ?? null);
  } catch (error) {
    const described = describeAccessWriteError(error, { itemType: 'task' });
    if (described.problem) {
      emit('problem', described.problem);
      return;
    }
    formError.value = described.message;
    // The story list is out of date; reload it behind the dialog.
    if (described.reload) emit('refresh');
  } finally {
    busy.value = false;
  }
}

function describedBy(name, hint = '') {
  return [hint, errors.value[name] ? `${fieldId(name)}-error` : ''].filter(Boolean).join(' ') || undefined;
}
</script>

<template>
  <RequirementsDialog :busy="busy" :open="open" title="Add a task" @close="close" @submit="submit">
    <div class="rq-stack" data-testid="access-add-task">
      <p v-if="storyFixed && chosenStory" class="rq-small mb-0">In <strong>{{ chosenStory.name }}</strong>. It’s assigned to you.</p>
      <div v-else class="rq-field">
        <label :for="fieldId('storyId')">Story</label>
        <select
          :id="fieldId('storyId')"
          v-model="form.storyId"
          class="form-select"
          :aria-invalid="errors.storyId ? 'true' : 'false'"
          :aria-describedby="describedBy('storyId', fieldId('story-hint'))"
        >
          <option value="" disabled>Choose a story</option>
          <option v-for="story in stories" :key="story.id" :value="story.id">{{ story.name }}{{ story.epicName ? ` · ${story.epicName}` : '' }}</option>
        </select>
        <p :id="fieldId('story-hint')" class="rq-field__hint">The task is assigned to you and joins the story’s sprint.</p>
        <p v-if="errors.storyId" :id="`${fieldId('storyId')}-error`" class="access-field-error">{{ errors.storyId }}</p>
      </div>

      <div class="rq-field">
        <label :for="fieldId('name')">Name</label>
        <input
          :id="fieldId('name')"
          v-model="form.name"
          class="form-control"
          maxlength="200"
          autocomplete="off"
          data-autofocus
          :aria-invalid="errors.name ? 'true' : 'false'"
          :aria-describedby="describedBy('name')"
        />
        <p v-if="errors.name" :id="`${fieldId('name')}-error`" class="access-field-error">{{ errors.name }}</p>
      </div>

      <div class="rq-field">
        <label :for="fieldId('description')">Description <span class="rq-muted">(optional)</span></label>
        <textarea
          :id="fieldId('description')"
          v-model="form.description"
          class="form-control"
          rows="3"
          maxlength="5000"
          :aria-invalid="errors.description ? 'true' : 'false'"
          :aria-describedby="describedBy('description')"
        ></textarea>
        <p v-if="errors.description" :id="`${fieldId('description')}-error`" class="access-field-error">{{ errors.description }}</p>
      </div>

      <div class="rq-field access-add__estimate">
        <label :for="fieldId('estimate')">Estimate in hours <span class="rq-muted">(optional)</span></label>
        <input
          :id="fieldId('estimate')"
          v-model="form.estimate"
          class="form-control"
          inputmode="numeric"
          :aria-invalid="errors.estimate ? 'true' : 'false'"
          :aria-describedby="describedBy('estimate')"
        />
        <p v-if="errors.estimate" :id="`${fieldId('estimate')}-error`" class="access-field-error">{{ errors.estimate }}</p>
      </div>

      <p v-if="formError" class="error-banner mb-0" role="alert">{{ formError }}</p>
    </div>
    <template #footer>
      <button class="ghost-button" type="button" :disabled="busy" @click="close">Cancel</button>
      <button class="primary-button" type="submit" :disabled="busy">{{ busy ? 'Adding…' : 'Add task' }}</button>
    </template>
  </RequirementsDialog>
</template>
