<script setup>
import { computed, ref, useId, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { apiClient } from '../../lib/auth/index.js';
import { onProjectRefresh } from '../../lib/live/live-refresh.js';
import { FILE_TREE_QUERY, fileTreeQuery, treeChannel, treeChannels } from '../../lib/projects/file-tree.js';
import { fileErrorMessage } from '../../lib/projects/project-files.js';
import ChannelLibrary from '../channels/ChannelLibrary.vue';
import ProjectFilesPanel from './ProjectFilesPanel.vue';

// The project's files as folders (docs/engagements/plan.md, Files). The project is the top
// folder: in it, one folder per channel and the project's own files. Inside a channel are the
// folders people made there (ChannelLibrary.vue). The folder shown is kept in the address
// (?filesChannel=&filesFolder=), so links and Back work.
const props = defineProps({
  focusFileId: { default: '', type: String },
  focusSigningId: { default: '', type: String },
  projectId: { required: true, type: String },
  token: { default: '', type: String },
});

const emit = defineEmits(['navigate']);

const route = useRoute();
const router = useRouter();
const uid = useId();
const tree = ref(null);
const loadError = ref('');
const loading = ref(false);
// Moves when someone else changed the project, so the open channel's library reloads too.
const liveVersion = ref(0);

const channelId = computed(() => String(route.query[FILE_TREE_QUERY.channel] ?? ''));
const folderId = computed(() => String(route.query[FILE_TREE_QUERY.folder] ?? ''));
const channels = computed(() => treeChannels(tree.value));
const openChannel = computed(() => (channelId.value ? treeChannel(tree.value, channelId.value) : null));
const projectName = computed(() => tree.value?.project?.name || 'Project files');

let loadRun = 0;
async function loadTree({ quiet = false } = {}) {
  if (!props.projectId || !props.token) return;
  const run = ++loadRun;
  if (!quiet) {
    loading.value = true;
    loadError.value = '';
  }
  try {
    const result = await (quiet ? apiClient.passive : apiClient).getProjectFileTree(props.projectId, props.token);
    if (run !== loadRun) return;
    tree.value = result;
    loadError.value = '';
  } catch (error) {
    if (run === loadRun && !quiet) loadError.value = fileErrorMessage(error, 'The project\'s folders could not load.');
  } finally {
    if (run === loadRun) loading.value = false;
  }
}

function go(location) {
  router.push({ query: fileTreeQuery(route.query, location) }).catch(() => null);
}

const fileCountLabel = (count) => (count === 1 ? '1 file' : `${count ?? 0} files`);
const folderCountLabel = (channel) => {
  const count = (channel.folders ?? []).length;
  return count ? (count === 1 ? '1 folder' : `${count} folders`) : '';
};

watch(() => `${props.projectId}|${props.token}`, () => loadTree(), { immediate: true });
onProjectRefresh(() => {
  liveVersion.value += 1;
  loadTree({ quiet: true });
});
// A channel that is gone (deleted, or no longer visible): back to the project.
watch([tree, channelId], () => {
  if (tree.value && channelId.value && !openChannel.value) router.replace({ query: fileTreeQuery(route.query, {}) }).catch(() => null);
});
</script>

<template>
  <section class="file-tree" :aria-labelledby="`${uid}-title`">
    <h2 :id="`${uid}-title`" class="visually-hidden">Files in {{ projectName }}</h2>
    <p v-if="loadError" class="error-banner mb-0" role="alert">
      {{ loadError }}
      <button class="ghost-button ghost-button--compact ms-2" type="button" @click="loadTree()">Try again</button>
    </p>

    <ChannelLibrary
      v-if="openChannel"
      :key="openChannel.id"
      :channel="openChannel"
      :focus-file-id="focusFileId"
      :folder-id="folderId"
      :live-version="liveVersion"
      :project-id="projectId"
      :root-label="projectName"
      :token="token"
      @changed="loadTree({ quiet: true })"
      @root="go({})"
      @update:folder-id="(id) => go({ channelId: openChannel.id, folderId: id })"
    />

    <template v-else>
      <nav class="file-tree__trail" aria-label="Folder">
        <span class="file-tree__crumb" aria-current="location"><i class="bi bi-briefcase" aria-hidden="true"></i> {{ projectName }}</span>
      </nav>
      <p v-if="loading && !tree" class="file-tree__note" role="status">Loading folders…</p>
      <ul v-if="channels.length" class="file-tree__channels" aria-label="Channel folders">
        <li v-for="channel in channels" :key="channel.id">
          <button
            class="file-tree__channel"
            :class="{ 'file-tree__channel--archived': channel.archived }"
            type="button"
            @click="go({ channelId: channel.id })"
          >
            <i :class="['bi', channel.archived ? 'bi-archive' : 'bi-folder2']" aria-hidden="true"></i>
            <span class="file-tree__channel-name">#{{ channel.name }}</span>
            <span class="file-tree__channel-meta">
              <span>{{ fileCountLabel(channel.totalFileCount ?? channel.fileCount) }}</span>
              <span v-if="folderCountLabel(channel)">· {{ folderCountLabel(channel) }}</span>
              <span v-if="channel.archived">· Archived</span>
            </span>
            <span v-if="channel.guestCount" class="file-tree__guests">
              <i class="bi bi-person-badge" aria-hidden="true"></i>
              {{ channel.guestCount }} {{ channel.guestCount === 1 ? 'guest' : 'guests' }}
            </span>
          </button>
        </li>
      </ul>

      <ProjectFilesPanel
        :focus-file-id="focusFileId"
        :focus-signing-id="focusSigningId"
        :project-id="projectId"
        :target-id="projectId"
        target-type="project"
        top-level
        :token="token"
        @changed="loadTree({ quiet: true })"
        @navigate="emit('navigate')"
      />
    </template>
  </section>
</template>

<style scoped>
.file-tree { display: grid; gap: 0.6rem; min-width: 0; }
.file-tree__trail { display: flex; align-items: center; }
.file-tree__crumb { display: inline-flex; align-items: center; gap: 0.35rem; min-height: 2.75rem; padding: 0 0.45rem; color: var(--ink); font-weight: 600; overflow-wrap: anywhere; }
.file-tree__note { margin: 0; color: var(--muted); }
.file-tree__channels { display: grid; grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr)); gap: 0.4rem; margin: 0; padding: 0; list-style: none; }
.file-tree__channel { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 0.1rem 0.55rem; width: 100%; min-height: 3.25rem; padding: 0.45rem 0.75rem; border: 1px solid var(--line); border-radius: 0.45rem; background: var(--surface); color: var(--ink); text-align: left; }
.file-tree__channel:hover { background: var(--surface-soft); }
.file-tree__channel:focus-visible { outline: 0.18rem solid var(--accent); outline-offset: 0.1rem; }
.file-tree__channel > .bi { grid-row: span 2; color: var(--accent); font-size: 1.15rem; }
.file-tree__channel-name { min-width: 0; font-weight: 600; overflow-wrap: anywhere; }
.file-tree__channel-meta { display: flex; flex-wrap: wrap; gap: 0.25rem; color: var(--ink-soft); font-size: 0.75rem; }
.file-tree__guests { grid-column: 2; justify-self: start; display: inline-flex; align-items: center; gap: 0.25rem; padding: 0.05rem 0.45rem; border-radius: 999px; background: var(--surface-soft); color: var(--ink-soft); font-size: 0.72rem; }
.file-tree__channel--archived { border-style: dashed; color: var(--ink-soft); }
.file-tree__channel--archived > .bi { color: var(--muted); }
</style>
