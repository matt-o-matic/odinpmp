<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import RequirementsAgentBriefDialog from './RequirementsAgentBriefDialog.vue';
import RequirementsPackageUpload from './RequirementsPackageUpload.vue';
import RequirementsUploadUrlDialog from './RequirementsUploadUrlDialog.vue';
import RoundsPanel from './rounds/RoundsPanel.vue';
import { apiClient } from '../../lib/auth/index.js';
import { useRequirementsWorkspace } from '../../lib/requirements/requirements-context.js';
import { describeRequirementsError } from '../../lib/requirements/requirements-errors.js';
import { batchTouchesPackages, batchTouchesRounds } from '../../lib/requirements/requirements-live-updates.js';
import {
  packageMetaLine,
  packageStatusChip,
  packageWarningText,
  sortPackages,
} from '../../lib/requirements/requirements-packages.js';
import { formatShortDate } from '../../lib/requirements/requirements-time.js';
import { chipToneClass } from '../../lib/requirements/requirements-topics.js';

// The project's Review tab: its review packages (drafts first, each draft with a Publish
// action), the upload, an upload URL for a coding agent, and the rounds with the open one
// first. Review is project-wide, so `track` is the track packages are stored on.
// `?round=<id>` (the member invitation email) opens that round; `?upload=1` (Upload vN
// from a round) moves focus to the upload.
const props = defineProps({
  stages: { default: null, type: Object },
  track: { required: true, type: String },
});

const route = useRoute();
const router = useRouter();
const workspace = useRequirementsWorkspace();

const packages = ref([]);
const loaded = ref(false);
const error = ref('');
const uploadUrlOpen = ref(false);
const agentBriefOpen = ref(false);
const agentHelpBusy = ref('');
const agentHelpStatus = ref('');
const rounds = ref([]);
const roundsLoaded = ref(false);
const roundsError = ref('');
const packagesPanel = ref(null);

const abilities = computed(() => workspace.abilities.value);
const projectId = computed(() => workspace.projectId.value);
const rows = computed(() => sortPackages(packages.value));
const draftCount = computed(() => packages.value.filter((pkg) => pkg.status === 'draft').length);
const roundByPackage = computed(() => new Map(rounds.value.map((round) => [round.packageId, round])));

async function downloadPackageKit() {
  if (agentHelpBusy.value) return;
  agentHelpBusy.value = 'kit';
  agentHelpStatus.value = '';
  try {
    const result = await apiClient.getRequirementsPackageKit(projectId.value, workspace.token());
    const url = URL.createObjectURL(new Blob([result.blob], { type: 'application/zip' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'odin-review-package-kit.zip';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (caught) {
    agentHelpStatus.value = describeRequirementsError(caught, 'Unable to download the package kit.').message;
  } finally {
    agentHelpBusy.value = '';
  }
}

function packageLocation(pkg) {
  return {
    name: 'project-requirements-package',
    params: { packageId: pkg.id, projectId: projectId.value },
  };
}

function publishLocation(pkg) {
  return {
    name: 'project-requirements-round-publish',
    params: { packageId: pkg.id, projectId: projectId.value },
  };
}

function roundLocation(round) {
  return { name: 'project-requirements-round', params: { projectId: projectId.value, roundId: round.id } };
}

let roundsSequence = 0;
async function loadRounds({ passive = true } = {}) {
  if (!projectId.value) return;
  const current = ++roundsSequence;
  const client = passive ? apiClient.passive : apiClient;
  try {
    // Every round in the project: review is project-wide.
    const result = await client.listRequirementsRounds(projectId.value, '', workspace.token());
    if (current !== roundsSequence) return;
    rounds.value = Array.isArray(result.rounds) ? result.rounds : [];
    roundsError.value = '';
  } catch (caught) {
    if (current !== roundsSequence) return;
    roundsError.value = describeRequirementsError(caught, 'Unable to load the rounds.').message;
  } finally {
    if (current === roundsSequence) roundsLoaded.value = true;
  }
}

let sequence = 0;
async function load({ passive = true } = {}) {
  if (!projectId.value) return;
  const current = ++sequence;
  const client = passive ? apiClient.passive : apiClient;
  try {
    const result = await client.listRequirementsPackages(projectId.value, props.track, workspace.token());
    if (current !== sequence) return;
    packages.value = Array.isArray(result.packages) ? result.packages.filter((pkg) => !pkg.track || pkg.track === props.track) : [];
    error.value = '';
  } catch (caught) {
    if (current !== sequence) return;
    error.value = describeRequirementsError(caught, 'Unable to load the packages.').message;
  } finally {
    if (current === sequence) loaded.value = true;
  }
}

watch(
  () => [projectId.value, props.track],
  () => {
    packages.value = [];
    loaded.value = false;
    error.value = '';
    rounds.value = [];
    roundsLoaded.value = false;
    roundsError.value = '';
    load({ passive: false });
    loadRounds({ passive: false });
  },
  { immediate: true },
);

watch(workspace.liveBatch, (batch) => {
  if (batchTouchesPackages(batch, props.track)) load();
  if (batchTouchesRounds(batch, props.track)) loadRounds();
});

watch(
  () => String(route.query.round ?? ''),
  (roundId) => {
    if (roundId && projectId.value) router.replace({ name: 'project-requirements-round', params: { projectId: projectId.value, roundId } });
  },
  { immediate: true },
);

watch(
  () => [String(route.query.upload ?? ''), loaded.value],
  async ([upload, ready]) => {
    if (!upload || !ready) return;
    await nextTick();
    const panel = packagesPanel.value;
    panel?.scrollIntoView?.({ block: 'start' });
    const target = panel?.querySelector('input[type="file"]') ?? panel?.querySelector('h3');
    target?.focus?.({ preventScroll: true });
  },
  { immediate: true },
);

async function handleUploaded({ package: pkg }) {
  workspace.showMessage(pkg ? `Version ${pkg.version} uploaded as a draft.` : 'Package uploaded as a draft.', 'success', { survivesNavigation: true });
  workspace.refreshShared();
  if (pkg?.id) {
    await router.push(packageLocation(pkg));
    return;
  }
  load();
}
</script>

<template>
  <div class="rq-review-grid">
    <section ref="packagesPanel" class="rq-panel rq-stack" aria-labelledby="rq-packages-heading">
      <div class="rq-row rq-row--between rq-row--wrap">
        <div class="rq-row rq-row--tight">
          <h3 id="rq-packages-heading" class="rq-eyebrow">Review packages</h3>
          <span v-if="draftCount" class="rq-chip rq-chip--exp">{{ draftCount }} {{ draftCount === 1 ? 'draft' : 'drafts' }}</span>
        </div>
        <div class="rq-row rq-row--tight rq-row--wrap">
          <button class="ghost-button ghost-button--compact" type="button" @click="agentBriefOpen = true">
            <i class="bi bi-clipboard" aria-hidden="true"></i>Agent instructions
          </button>
          <button class="ghost-button ghost-button--compact" type="button" :disabled="Boolean(agentHelpBusy)" @click="downloadPackageKit">
            <i class="bi bi-file-earmark-zip" aria-hidden="true"></i>{{ agentHelpBusy === 'kit' ? 'Downloading…' : 'Download package kit' }}
          </button>
          <button
            v-if="abilities.uploadPackages"
            class="ghost-button ghost-button--compact"
            type="button"
            @click="uploadUrlOpen = true"
          >
            <i class="bi bi-robot" aria-hidden="true"></i>Upload URL for a coding agent
          </button>
        </div>
      </div>
      <p v-if="agentHelpStatus" class="rq-xs rq-muted mb-0" role="status">{{ agentHelpStatus }}</p>

      <RequirementsPackageUpload
        v-if="abilities.uploadPackages"
        :get-token="workspace.token"
        :project-id="projectId"
        :track="track"
        @uploaded="handleUploaded"
      />

      <div v-if="error" class="error-banner rq-row rq-row--between" role="alert">
        <span>{{ error }}</span>
        <button class="ghost-button ghost-button--compact" type="button" @click="load({ passive: false })">Try again</button>
      </div>
      <p v-else-if="!loaded" class="rq-small rq-muted mb-0">Loading packages…</p>
      <div v-else-if="rows.length === 0" class="rq-empty">
        <p><strong>No packages yet</strong></p>
        <p class="rq-small">
          A package holds the screens, prototypes, flows, and questions for one review round. To have a coding agent build one, give it the package kit and the agent instructions, then upload the zip here or give the agent an upload URL.
        </p>
      </div>
      <ul v-else class="rq-packages" aria-label="Review packages">
        <li v-for="pkg in rows" :key="pkg.id" class="rq-package-row" :class="{ 'rq-package-row--withdrawn': pkg.status === 'withdrawn' }">
          <span class="rq-package-row__version" aria-hidden="true">v{{ pkg.version }}</span>
          <div class="rq-package-row__main">
            <RouterLink class="rq-package-row__title" :aria-label="`Version ${pkg.version}: ${pkg.title}`" :to="packageLocation(pkg)">{{ pkg.title }}</RouterLink>
            <div class="rq-item__meta">
              <span>{{ packageMetaLine(pkg) }}</span>
              <span v-if="packageWarningText(pkg.warningCount)" class="rq-chip rq-chip--warn">
                <i class="bi bi-exclamation-triangle" aria-hidden="true"></i>{{ packageWarningText(pkg.warningCount) }}
              </span>
            </div>
          </div>
          <span class="rq-chip" :class="chipToneClass(packageStatusChip(pkg.status).tone)">{{ packageStatusChip(pkg.status).label }}</span>
          <span class="rq-item__when">{{ formatShortDate(pkg.createdAt) }}</span>
          <div v-if="(pkg.status === 'draft' && abilities.publishRounds) || roundByPackage.get(pkg.id)" class="rq-package-row__actions">
            <RouterLink
              v-if="pkg.status === 'draft' && abilities.publishRounds"
              class="ghost-button ghost-button--compact"
              :to="publishLocation(pkg)"
              :aria-label="`Publish version ${pkg.version} as a round`"
            >
              <i class="bi bi-send" aria-hidden="true"></i>Publish
            </RouterLink>
            <RouterLink
              v-else-if="roundByPackage.get(pkg.id)"
              class="rq-xs"
              :to="roundLocation(roundByPackage.get(pkg.id))"
            >Round {{ roundByPackage.get(pkg.id).number }} results</RouterLink>
          </div>
        </li>
      </ul>
    </section>

    <div class="rq-review-grid__rounds">
      <RoundsPanel
        :error="roundsError"
        :loaded="roundsLoaded"
        :project-id="projectId"
        :can-manage="Boolean(abilities.manageRounds)"
        :rounds="rounds"
        :stages="stages"
        @retry="loadRounds({ passive: false })"
      />
    </div>

    <RequirementsAgentBriefDialog
      :get-token="workspace.token"
      :open="agentBriefOpen"
      :project-id="projectId"
      :track="track"
      @close="agentBriefOpen = false"
    />
    <RequirementsUploadUrlDialog
      :get-token="workspace.token"
      :open="uploadUrlOpen"
      :project-id="projectId"
      :track="track"
      @close="uploadUrlOpen = false"
    />
  </div>
</template>
