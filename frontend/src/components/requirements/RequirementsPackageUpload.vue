<script setup>
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue';

import RequirementsPackageProblems from './RequirementsPackageProblems.vue';
import { apiClient } from '../../lib/auth/index.js';
import { describeRequirementsError } from '../../lib/requirements/requirements-errors.js';
import {
  PACKAGE_MAX_BYTES,
  checkPackageFile,
  describeUploadRejection,
  formatBytes,
  uploadPercent,
} from '../../lib/requirements/requirements-packages.js';
import { trackLabel } from '../../lib/requirements/requirements-tracks.js';

// Drop a review package zip, or choose one. The file is checked here first (type and the
// 50 MB limit), then sent as the raw body. A rejected package lists every problem; nothing
// is stored. An accepted one becomes the track's next draft version. With `replaces` (a
// draft's id and version), an accepted zip also withdraws that draft. `reconcile` asks the
// parent to reload the draft: after a 409 (it was published, withdrawn, or replaced first),
// and after a cancel, because the server may already have the zip and finish the replacement.
const props = defineProps({
  getToken: { required: true, type: Function },
  projectId: { required: true, type: String },
  replaces: { default: null, type: Object },
  track: { required: true, type: String },
});

const emit = defineEmits(['busy', 'reconcile', 'uploaded']);

const inputId = useId();
const hintId = useId();
const input = ref(null);
const dragging = ref(false);
const fileName = ref('');
const fileSize = ref(0);
const uploading = ref(false);
const progress = ref({ loaded: 0, total: 0 });
const rejection = ref(null);
const failure = ref('');
let controller = null;
let dragDepth = 0;

const percent = computed(() => uploadPercent(progress.value.loaded, progress.value.total || fileSize.value));
watch(uploading, (value) => emit('busy', value));

const progressText = computed(() => {
  if (percent.value == null) return 'Uploading…';
  if (percent.value >= 100) return 'Checking the package…';
  return `Uploading… ${percent.value}%`;
});

function reset() {
  rejection.value = null;
  failure.value = '';
}

function pick() {
  input.value?.click();
}

function onInputChange(event) {
  const [file] = event.target.files ?? [];
  event.target.value = '';
  if (file) start(file);
}

function onDragEnter(event) {
  if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return;
  dragDepth += 1;
  dragging.value = true;
}

function onDragLeave() {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dragging.value = false;
}

function onDrop(event) {
  dragDepth = 0;
  dragging.value = false;
  if (uploading.value) return;
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (files.length === 0) return;
  start(files[0], { extra: files.length - 1 });
}

async function start(file, { extra = 0 } = {}) {
  if (uploading.value) return;
  reset();
  fileName.value = file.name ?? 'package.zip';
  fileSize.value = Number(file.size) || 0;
  const check = checkPackageFile(file, { maxBytes: PACKAGE_MAX_BYTES });
  if (!check.ok) {
    failure.value = check.message;
    return;
  }

  uploading.value = true;
  progress.value = { loaded: 0, total: fileSize.value };
  controller = new AbortController();
  try {
    // Passive: this view shows its own progress, so the app's Working dialog stays away.
    const options = { onProgress: (next) => { progress.value = next; }, signal: controller.signal };
    const result = props.replaces
      ? await apiClient.passive.replaceRequirementsPackage(props.projectId, props.replaces.id, file, props.getToken(), options)
      : await apiClient.passive.uploadRequirementsPackage(props.projectId, props.track, file, props.getToken(), options);
    emit('uploaded', { extraFiles: extra, fileName: fileName.value, package: result.package ?? null, replaced: result.replaced ?? null });
  } catch (error) {
    if (error?.name === 'AbortError' && props.replaces) {
      failure.value = `Upload cancelled. If Odin had already received the zip, it may still have replaced version ${props.replaces.version}. The package below shows its current state.`;
      emit('reconcile');
    } else if (error?.name === 'AbortError') {
      failure.value = 'Upload cancelled. Nothing was stored.';
    } else if (error?.status === 422 && Array.isArray(error?.data?.errors)) {
      rejection.value = describeUploadRejection(error.data, { fileName: fileName.value });
    } else if (error?.status === 409 && props.replaces) {
      failure.value = describeRequirementsError(error, `Version ${props.replaces.version} can no longer be replaced. Nothing was stored.`).message;
      emit('reconcile');
    } else if (error?.status === 415) {
      failure.value = `${fileName.value} was not sent as a zip. Choose a .zip file.`;
    } else if (error?.status === 400) {
      failure.value = describeRequirementsError(error, 'Choose the Experience or Functional track, then upload again.').message;
    } else {
      failure.value = describeRequirementsError(error, `${fileName.value} could not be uploaded. Nothing was stored. Try again.`).message;
    }
  } finally {
    uploading.value = false;
    controller = null;
  }
}

function cancel() {
  controller?.abort();
}

onBeforeUnmount(() => controller?.abort());

defineExpose({ pick });
</script>

<template>
  <div class="rq-stack rq-stack--sm">
    <div
      class="rq-dropzone"
      :class="{ 'rq-dropzone--over': dragging, 'rq-dropzone--busy': uploading }"
      data-testid="rq-package-dropzone"
      @dragenter.prevent="onDragEnter"
      @dragleave.prevent="onDragLeave"
      @dragover.prevent
      @drop.prevent="onDrop"
    >
      <i class="bi bi-file-earmark-zip rq-dropzone__icon" aria-hidden="true"></i>
      <div v-if="!uploading" class="rq-dropzone__text">
        <p class="mb-0"><strong>Drop a package zip here</strong>, or choose one.</p>
        <p v-if="replaces" :id="hintId" class="rq-xs rq-muted mb-0">
          One .zip up to {{ formatBytes(PACKAGE_MAX_BYTES) }}, with manifest.json at the top level. Odin checks it first. If it passes, it becomes the next {{ trackLabel(track) }} draft and version {{ replaces.version }} is withdrawn. If not, version {{ replaces.version }} stays as it is.
        </p>
        <p v-else :id="hintId" class="rq-xs rq-muted mb-0">
          One .zip up to {{ formatBytes(PACKAGE_MAX_BYTES) }}, with manifest.json at the top level. Odin checks it and keeps it as the next {{ trackLabel(track) }} draft.
        </p>
      </div>
      <div v-else class="rq-dropzone__text rq-stack rq-stack--sm">
        <p class="mb-0 rq-small"><strong>{{ fileName }}</strong> <span class="rq-muted">· {{ formatBytes(fileSize) }}</span></p>
        <label class="rq-xs rq-muted" :for="`${inputId}-progress`">{{ progressText }}</label>
        <progress :id="`${inputId}-progress`" class="rq-progress" max="100" :value="percent ?? undefined">{{ percent ?? 0 }}%</progress>
      </div>
      <div class="rq-dropzone__actions">
        <template v-if="!uploading">
          <input
            :id="inputId"
            ref="input"
            class="rq-file-input visually-hidden"
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            :aria-describedby="hintId"
            @change="onInputChange"
          />
          <label class="primary-button primary-button--compact rq-file-label" :for="inputId">
            <i class="bi bi-upload" aria-hidden="true"></i>{{ replaces ? 'Upload replacement' : 'Upload package' }}
          </label>
        </template>
        <button v-else class="ghost-button ghost-button--compact" type="button" @click="cancel">Cancel upload</button>
      </div>
    </div>

    <p v-if="failure" class="error-banner mb-0" role="alert">{{ failure }}</p>
    <div v-if="rejection" class="rq-panel rq-panel--warn" role="alert" data-testid="rq-package-rejection">
      <RequirementsPackageProblems :errors="rejection.errors" :summary="rejection.summary" :warnings="rejection.warnings" />
    </div>
  </div>
</template>
