<script setup>
import { computed, reactive, ref, useId, watch } from 'vue';

import { useChannelApi } from '../../lib/channels/channel-api.js';
import { channelErrorMessage, childFolders, folderMoveTargets, folderTrail } from '../../lib/channels/channels.js';
import ProjectFilesPanel from '../projects/ProjectFilesPanel.vue';
import RequirementsConfirmDialog from '../requirements/RequirementsConfirmDialog.vue';
import RequirementsDialog from '../requirements/RequirementsDialog.vue';

// The app's API for members; the guest view provides the guest API (lib/channels/channel-api.js).
const api = useChannelApi();

// A channel's library: one folder at a time, with the way back up, its folders, and its files
// (ProjectFilesPanel, which uploads into the folder shown). The folder open is kept in the address.
const props = defineProps({
  channel: { required: true, type: Object },
  focusFileId: { default: '', type: String },
  folderId: { default: '', type: String },
  // Moves when someone else changed this library.
  liveVersion: { default: 0, type: Number },
  projectId: { required: true, type: String },
  // In the project's files (ProjectFileTree.vue): the project's name, shown first in the trail,
  // and the channel shown as #name instead of Library.
  rootLabel: { default: '', type: String },
  token: { default: '', type: String },
});

// root: the project crumb was chosen. changed: folders or files here changed.
const emit = defineEmits(['changed', 'root', 'update:folderId']);

const uid = useId();
const folders = ref([]);
const canManage = ref(false);
const error = ref('');
const notice = ref('');
const dialog = reactive({ busy: false, error: '', kind: '', name: '', parentId: '' });
const removal = reactive({ busy: false, error: '', open: false });

const current = computed(() => folders.value.find((folder) => folder.id === props.folderId) ?? null);
const currentId = computed(() => current.value?.id ?? null);
const trail = computed(() => folderTrail(folders.value, currentId.value));
const children = computed(() => childFolders(folders.value, currentId.value));
const moveTargets = computed(() => folderMoveTargets(folders.value, current.value));
const dialogTitle = computed(() => ({ create: 'New folder', move: `Move ${current.value?.name ?? 'folder'}`, rename: 'Rename folder' }[dialog.kind] ?? 'Folder'));

async function load({ quiet = false } = {}) {
  try {
    const result = await (quiet ? api.passive : api).listChannelFolders(props.projectId, props.channel.id, props.token);
    folders.value = result.folders ?? [];
    canManage.value = result.canManage === true;
    if (!quiet) error.value = '';
    // A folder someone else deleted: back to the top.
    if (props.folderId && !folders.value.some((folder) => folder.id === props.folderId)) emit('update:folderId', '');
  } catch (failure) {
    if (!quiet) error.value = channelErrorMessage(failure, 'Folders could not load.');
  }
}

function open(folderId) {
  notice.value = '';
  emit('update:folderId', folderId ?? '');
}

function openDialog(kind) {
  Object.assign(dialog, { busy: false, error: '', kind, name: kind === 'rename' ? current.value?.name ?? '' : '', parentId: kind === 'move' ? current.value?.parentId ?? '' : '' });
}

async function submitDialog() {
  if (dialog.busy) return;
  const name = dialog.name.trim();
  if (dialog.kind !== 'move' && !name) {
    dialog.error = 'Enter a folder name.';
    return;
  }
  dialog.busy = true;
  dialog.error = '';
  try {
    if (dialog.kind === 'create') {
      const result = await api.createChannelFolder(props.projectId, props.channel.id, { name, parentId: currentId.value }, props.token);
      await load();
      notice.value = `Folder ${result.folder.name} added.`;
      emit('changed');
    } else if (dialog.kind === 'rename') {
      await api.updateFolder(props.projectId, currentId.value, { name }, props.token);
      await load();
      notice.value = `Renamed to ${name}.`;
      emit('changed');
    } else {
      await api.updateFolder(props.projectId, currentId.value, { parentId: dialog.parentId || null }, props.token);
      await load();
      notice.value = 'Folder moved.';
      emit('changed');
    }
    dialog.kind = '';
  } catch (failure) {
    dialog.error = channelErrorMessage(failure, 'That could not be saved.');
  } finally {
    dialog.busy = false;
  }
}

async function confirmDelete() {
  removal.busy = true;
  removal.error = '';
  try {
    const parentId = current.value?.parentId ?? '';
    const name = current.value?.name ?? '';
    await api.deleteFolder(props.projectId, currentId.value, props.token);
    removal.open = false;
    emit('update:folderId', parentId);
    await load();
    notice.value = `Folder ${name} deleted.`;
    emit('changed');
  } catch (failure) {
    removal.error = channelErrorMessage(failure, 'The folder could not be deleted.');
  } finally {
    removal.busy = false;
  }
}

watch(() => `${props.projectId}|${props.channel.id}|${props.token}`, () => load(), { immediate: true });
watch(() => props.liveVersion, () => load({ quiet: true }));
</script>

<template>
  <section class="channel-library" :aria-labelledby="`${uid}-heading`">
    <h3 :id="`${uid}-heading`" class="visually-hidden">Files in {{ channel.name }}</h3>
    <div class="channel-library__bar">
      <nav class="channel-library__trail" aria-label="Folder">
        <ol>
          <li v-if="rootLabel">
            <button class="channel-library__crumb" type="button" @click="emit('root')">
              <i class="bi bi-briefcase" aria-hidden="true"></i> {{ rootLabel }}
            </button>
          </li>
          <li>
            <i v-if="rootLabel" class="bi bi-chevron-right channel-library__sep" aria-hidden="true"></i>
            <button v-if="currentId" class="channel-library__crumb" type="button" @click="open('')">
              <i :class="['bi', rootLabel ? 'bi-hash' : 'bi-house']" aria-hidden="true"></i> {{ rootLabel ? channel.name : 'Library' }}
            </button>
            <span v-else class="channel-library__crumb channel-library__crumb--here" aria-current="location"><i :class="['bi', rootLabel ? 'bi-hash' : 'bi-house']" aria-hidden="true"></i> {{ rootLabel ? channel.name : 'Library' }}</span>
          </li>
          <li v-for="folder in trail" :key="folder.id">
            <i class="bi bi-chevron-right channel-library__sep" aria-hidden="true"></i>
            <button v-if="folder.id !== currentId" class="channel-library__crumb" type="button" @click="open(folder.id)">{{ folder.name }}</button>
            <span v-else class="channel-library__crumb channel-library__crumb--here" aria-current="location">{{ folder.name }}</span>
          </li>
        </ol>
      </nav>
      <div v-if="canManage" class="channel-library__actions">
        <template v-if="current">
          <button class="ghost-button ghost-button--compact" type="button" @click="openDialog('rename')">Rename</button>
          <button class="ghost-button ghost-button--compact" type="button" @click="openDialog('move')">Move</button>
          <button class="ghost-button ghost-button--compact" type="button" @click="removal.open = true; removal.error = ''">Delete</button>
        </template>
        <button class="ghost-button ghost-button--compact" type="button" @click="openDialog('create')">
          <i class="bi bi-folder-plus" aria-hidden="true"></i> New folder
        </button>
      </div>
    </div>
    <p v-if="error" class="error-banner mb-0" role="alert">{{ error }}</p>
    <p class="channel-library__notice" role="status">{{ notice }}</p>

    <ul v-if="children.length" class="channel-library__folders" aria-label="Folders">
      <li v-for="folder in children" :key="folder.id">
        <button class="channel-library__folder" type="button" @click="open(folder.id)">
          <i class="bi bi-folder2" aria-hidden="true"></i>
          <span>{{ folder.name }}</span>
          <span class="channel-library__folder-count">{{ childFolders(folders, folder.id).length ? `${childFolders(folders, folder.id).length} folders` : '' }}</span>
        </button>
      </li>
    </ul>

    <ProjectFilesPanel
      :focus-file-id="focusFileId"
      :folder-id="currentId"
      :live-version="liveVersion"
      :project-id="projectId"
      :target-id="channel.id"
      target-type="channel"
      :token="token"
      @changed="emit('changed')"
    />

    <RequirementsDialog :busy="dialog.busy" :open="Boolean(dialog.kind)" :title="dialogTitle" @close="dialog.kind = ''" @submit="submitDialog">
      <div v-if="dialog.kind !== 'move'" class="rq-field">
        <label :for="`${uid}-folder-name`">Name</label>
        <input :id="`${uid}-folder-name`" v-model="dialog.name" class="form-control" maxlength="240" autocomplete="off" data-autofocus />
        <p v-if="dialog.kind === 'create'" class="rq-field__hint mb-0">In {{ current ? current.name : 'the library’s top level' }}.</p>
      </div>
      <div v-else class="rq-field">
        <label :for="`${uid}-folder-parent`">Move into</label>
        <select :id="`${uid}-folder-parent`" v-model="dialog.parentId" class="form-select" data-autofocus>
          <option value="">The library’s top level</option>
          <option v-for="target in moveTargets" :key="target.id" :value="target.id">{{ target.label }}</option>
        </select>
      </div>
      <p v-if="dialog.error" class="error-banner mb-0" role="alert">{{ dialog.error }}</p>
      <template #footer>
        <button class="ghost-button" type="button" :disabled="dialog.busy" @click="dialog.kind = ''">Cancel</button>
        <button class="primary-button" type="submit" :disabled="dialog.busy">{{ dialog.busy ? 'Saving…' : dialog.kind === 'create' ? 'Add folder' : dialog.kind === 'move' ? 'Move' : 'Save' }}</button>
      </template>
    </RequirementsDialog>

    <RequirementsConfirmDialog
      :busy="removal.busy"
      confirm-label="Delete folder"
      :error="removal.error"
      :open="removal.open"
      title="Delete this folder?"
      @close="removal.open = false"
      @confirm="confirmDelete"
    >
      <p class="mb-0">Only an empty folder can be deleted. Move or delete what is in {{ current?.name }} first.</p>
    </RequirementsConfirmDialog>
  </section>
</template>

<style scoped>
.channel-library { display: grid; gap: 0.5rem; }
.channel-library__bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem; }
.channel-library__trail ol { display: flex; flex-wrap: wrap; align-items: center; gap: 0.15rem; margin: 0; padding: 0; list-style: none; }
.channel-library__trail li { display: inline-flex; align-items: center; gap: 0.15rem; min-width: 0; }
.channel-library__crumb { display: inline-flex; align-items: center; gap: 0.3rem; min-height: 2.75rem; padding: 0 0.45rem; border: 0; border-radius: 0.35rem; background: transparent; color: var(--accent); font-weight: 600; overflow-wrap: anywhere; }
.channel-library__crumb--here { color: var(--ink); }
button.channel-library__crumb:hover { background: var(--surface-soft); }
.channel-library__sep { color: var(--muted); font-size: 0.7rem; }
.channel-library__actions { display: flex; flex-wrap: wrap; gap: 0.35rem; }
.channel-library__actions button { min-height: 2.75rem; }
.channel-library__notice { margin: 0; color: var(--ink-soft); }
.channel-library__notice:empty { display: none; }
.channel-library__folders { display: grid; grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr)); gap: 0.4rem; margin: 0; padding: 0; list-style: none; }
.channel-library__folder { display: flex; align-items: center; gap: 0.5rem; width: 100%; min-height: 2.75rem; padding: 0.4rem 0.75rem; border: 1px solid var(--line); border-radius: 0.4rem; background: var(--surface); color: var(--ink); text-align: left; }
.channel-library__folder:hover { background: var(--surface-soft); }
.channel-library__folder span:first-of-type { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; font-weight: 600; }
.channel-library__folder-count { color: var(--muted); font-size: 0.75rem; white-space: nowrap; }
.channel-library__crumb:focus-visible,
.channel-library__folder:focus-visible { outline: 0.18rem solid var(--accent); outline-offset: 0.1rem; }
</style>
