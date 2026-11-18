<script setup>
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import RequirementsBriefStage from '../../components/requirements/RequirementsBriefStage.vue';
import RequirementsDecideStage from '../../components/requirements/RequirementsDecideStage.vue';
import RequirementsDraftFeedback from '../../components/requirements/RequirementsDraftFeedback.vue';
import RequirementsRegister from '../../components/requirements/RequirementsRegister.vue';
import RequirementsStageTabs from '../../components/requirements/RequirementsStageTabs.vue';
import RequirementsPlanStage from '../../components/requirements/plans/RequirementsPlanStage.vue';
import { apiClient } from '../../lib/auth/index.js';
import { useRequirementsWorkspace } from '../../lib/requirements/requirements-context.js';
import { describeRequirementsError } from '../../lib/requirements/requirements-errors.js';
import { batchTouchesTopicList } from '../../lib/requirements/requirements-live-updates.js';
import { bulkResultMessage, draftQuestionsSummary } from '../../lib/requirements/requirements-topics.js';
import { REQUIREMENTS_STAGES, normalizeStage, trackLabel } from '../../lib/requirements/requirements-tracks.js';

const route = useRoute();
const workspace = useRequirementsWorkspace();

const track = computed(() => String(route.params.track ?? 'experience'));
const stage = computed(() => normalizeStage(route.params.stage));
const stageLabel = computed(() => REQUIREMENTS_STAGES.find((item) => item.id === stage.value)?.label ?? '');
const stages = computed(() => workspace.overview.value?.tracks?.[track.value]?.stages ?? null);
const briefLines = computed(() => stages.value?.brief?.lines ?? []);

const topics = ref([]);
const topicsLoaded = ref(false);
const topicsError = ref('');
const refreshKey = ref(0);
const drafting = ref(false);
const draftFeedback = ref(null);
const highlightIds = ref([]);

let topicsSequence = 0;
async function loadTopics({ passive = true } = {}) {
  const projectId = workspace.projectId.value;
  if (!projectId) return;
  const current = ++topicsSequence;
  const requestedTrack = track.value;
  const client = passive ? apiClient.passive : apiClient;
  try {
    const result = await client.listRequirementsTopics(projectId, requestedTrack, { include: 'summaries', view: 'every' }, workspace.token());
    if (current !== topicsSequence) return;
    topics.value = result.topics ?? [];
    topicsError.value = '';
  } catch (error) {
    if (current !== topicsSequence) return;
    topicsError.value = describeRequirementsError(error, 'Unable to load topics.').message;
  } finally {
    if (current === topicsSequence) topicsLoaded.value = true;
  }
}

watch(
  () => [workspace.projectId.value, track.value],
  () => {
    topics.value = [];
    topicsLoaded.value = false;
    topicsError.value = '';
    draftFeedback.value = null;
    highlightIds.value = [];
    loadTopics({ passive: false });
  },
  { immediate: true },
);

watch(workspace.liveBatch, (batch) => {
  if (!batchTouchesTopicList(batch, track.value)) return;
  loadTopics();
  refreshKey.value += 1;
});

async function runDraft() {
  if (drafting.value) return;
  drafting.value = true;
  draftFeedback.value = null;
  try {
    const result = await apiClient.draftRequirementsQuestions(workspace.projectId.value, track.value, workspace.token());
    const created = Array.isArray(result.created) ? result.created : [];
    if (created.length > 0) {
      const known = new Set(topics.value.map((row) => row.id));
      topics.value = [...topics.value, ...created.filter((row) => !known.has(row.id))];
    }
    highlightIds.value = created.map((row) => row.id);
    draftFeedback.value = {
      message: draftQuestionsSummary(result),
      showRegisterLink: stage.value !== 'discuss' && created.length > 0,
      tone: 'success',
    };
    await Promise.all([loadTopics(), workspace.refreshShared()]);
  } catch (error) {
    draftFeedback.value = { tone: 'error', ...describeRequirementsError(error, 'Odin could not draft questions, so nothing was added. Try again.') };
  } finally {
    drafting.value = false;
  }
}

function handleCreated(topic) {
  if (topic?.id) {
    topics.value = [...topics.value.filter((row) => row.id !== topic.id), topic];
    highlightIds.value = [topic.id];
  }
  workspace.showMessage('Topic added.');
  loadTopics();
  workspace.refreshShared();
}

function handleBulkDone(result) {
  const message = bulkResultMessage(result);
  workspace.showMessage(message.text, message.tone === 'error' ? 'error' : undefined);
  loadTopics();
  workspace.refreshShared();
}

function handleDecideChanged() {
  loadTopics();
  workspace.refreshShared();
}
</script>

<template>
  <div class="rq-stack">
    <h2 class="visually-hidden" tabindex="-1" data-rq-focus>{{ trackLabel(track) }}, {{ stageLabel }}</h2>

    <RequirementsStageTabs :project-id="workspace.projectId.value" :stage="stage" :stages="stages" :track="track" />

    <p v-if="workspace.overviewError.value && !stages" class="error-banner mb-0" role="alert">{{ workspace.overviewError.value }}</p>

    <RequirementsDraftFeedback
      v-if="draftFeedback"
      :busy="drafting"
      :feedback="draftFeedback"
      :project-id="workspace.projectId.value"
      :track="track"
      @dismiss="draftFeedback = null"
      @retry="runDraft"
    />

    <RequirementsBriefStage
      v-if="stage === 'brief'"
      :abilities="workspace.abilities.value"
      :brief="stages?.brief ?? null"
      :drafting="drafting"
      :project-id="workspace.projectId.value"
      :track="track"
      @draft="runDraft"
    />

    <RequirementsRegister
      v-else-if="stage === 'discuss'"
      :abilities="workspace.abilities.value"
      :brief-lines="briefLines"
      :drafting="drafting"
      :error="topicsError"
      :highlight-ids="highlightIds"
      :loaded="topicsLoaded"
      :project-id="workspace.projectId.value"
      :rows="topics"
      :stakeholders="workspace.stakeholders.value"
      :track="track"
      :users="workspace.validUsers.value"
      @bulk-done="handleBulkDone"
      @created="handleCreated"
      @draft="runDraft"
      @reload="loadTopics({ passive: false })"
    />

    <RequirementsDecideStage
      v-else-if="stage === 'decide'"
      :abilities="workspace.abilities.value"
      :project-id="workspace.projectId.value"
      :refresh-key="refreshKey"
      :topics="topics"
      :track="track"
      @changed="handleDecideChanged"
      @message="workspace.showMessage($event)"
    />


    <RequirementsPlanStage v-else :track="track" />
  </div>
</template>
