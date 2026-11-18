<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import './plans.css';
import PlanDecisions from './PlanDecisions.vue';
import PlanDocument from './PlanDocument.vue';
import PlanEditor from './PlanEditor.vue';
import PlanHistory from './PlanHistory.vue';
import PlanProposedWork from './PlanProposedWork.vue';
import RequirementsAvatar from '../RequirementsAvatar.vue';
import RequirementsDialog from '../RequirementsDialog.vue';
import { apiClient } from '../../../lib/auth/index.js';
import { useRequirementsWorkspace } from '../../../lib/requirements/requirements-context.js';
import { describeRequirementsError } from '../../../lib/requirements/requirements-errors.js';
import { batchTouchesPlans } from '../../../lib/requirements/requirements-live-updates.js';
import {
  decisionLabelMap,
  describeApproveError,
  describeDraftError,
  describeEditError,
  describeProposeError,
  droppedNote,
  latestPlan,
  ownerLine,
  planActions,
  planEditPayload,
  planHeading,
  planStatusChip,
  planTitle,
  selectPlan,
  sortPlans,
} from '../../../lib/requirements/requirements-plans.js';
import { avatarColor, chipToneClass, initials } from '../../../lib/requirements/requirements-topics.js';
import { plural, trackLabel } from '../../../lib/requirements/requirements-tracks.js';

// Plan & work. Left: the decisions the plan builds on. Right: the plan version with its
// owner, then proposed work and versions. People with project.plan.edit draft, edit, and
// propose work; only admins and managers approve, and the approver owns the plan. Editing
// replaces the read view, so there is one form at a time.
const props = defineProps({
  track: { required: true, type: String },
});

const route = useRoute();
const router = useRouter();
const workspace = useRequirementsWorkspace();

const plans = ref([]);
const plansLoaded = ref(false);
const plansError = ref('');
const detail = ref(null);
const decisions = ref([]);
const decisionsLoaded = ref(false);
const decisionsError = ref('');
const drafting = ref(false);
const draftFeedback = ref(null);
const dropped = ref('');
const editing = ref(false);
const saving = ref(false);
const edit = ref({ error: '', issues: [], reapply: null, initialForm: null });
const approve = ref({ busy: false, error: '', open: false });
const proposing = ref(false);
const proposeFeedback = ref(null);
const heading = ref(null);

const projectId = computed(() => workspace.projectId.value);
const abilities = computed(() => workspace.abilities.value);
const sorted = computed(() => sortPlans(plans.value));
const listed = computed(() => selectPlan(sorted.value, String(route.query.plan ?? '')));
// The list carries everything but proposed work; the detail adds it.
const plan = computed(() => (detail.value && detail.value.id === listed.value?.id ? detail.value : listed.value));
const latest = computed(() => latestPlan(sorted.value));
const labels = computed(() => decisionLabelMap(decisions.value));
const actions = computed(() => planActions({ abilities: abilities.value, plan: plan.value, plans: sorted.value }));
const owner = computed(() => (plan.value ? ownerLine(plan.value) : { approvedText: '', name: '', text: '' }));
const ownerPerson = computed(() => (owner.value.name ? { color: avatarColor(`user:${plan.value?.owner?.id}`), initials: initials(owner.value.name), name: owner.value.name } : null));
const statusChip = computed(() => planStatusChip(plan.value?.status));
const viewingOld = computed(() => Boolean(plan.value && latest.value && plan.value.id !== latest.value.id));
const panelHeading = computed(() => (plan.value ? planHeading(plan.value) : `${trackLabel(props.track)} plan`));

function token() {
  return workspace.token();
}

let plansSequence = 0;
async function loadPlans({ passive = true } = {}) {
  if (!projectId.value) return;
  const current = ++plansSequence;
  const client = passive ? apiClient.passive : apiClient;
  try {
    const result = await client.listRequirementsPlans(projectId.value, props.track, token());
    if (current !== plansSequence) return;
    plans.value = (result.plans ?? []).filter((entry) => !entry.track || entry.track === props.track);
    plansError.value = '';
  } catch (error) {
    if (current !== plansSequence) return;
    plansError.value = describeRequirementsError(error, 'Unable to load the plan.').message;
  } finally {
    if (current === plansSequence) plansLoaded.value = true;
  }
}

let detailSequence = 0;
async function loadDetail() {
  const id = listed.value?.id;
  const current = ++detailSequence;
  if (!id) {
    detail.value = null;
    return;
  }
  try {
    const result = await apiClient.passive.getRequirementsPlan(projectId.value, id, token());
    if (current === detailSequence) detail.value = result.plan ?? null;
  } catch {
    // The list already shows the plan; only proposed work is missing.
    if (current === detailSequence) detail.value = null;
  }
}

let decisionsSequence = 0;
async function loadDecisions({ passive = true } = {}) {
  if (!projectId.value) return;
  const current = ++decisionsSequence;
  const client = passive ? apiClient.passive : apiClient;
  try {
    const result = await client.listRequirementsDecisions(projectId.value, props.track, {}, token());
    if (current !== decisionsSequence) return;
    decisions.value = result.decisions ?? [];
    decisionsError.value = '';
  } catch (error) {
    if (current !== decisionsSequence) return;
    decisionsError.value = describeRequirementsError(error, 'Unable to load decisions.').message;
  } finally {
    if (current === decisionsSequence) decisionsLoaded.value = true;
  }
}

async function reloadAll({ passive = true } = {}) {
  await Promise.all([loadPlans({ passive }), loadDecisions({ passive })]);
  await loadDetail();
}

watch(
  () => [projectId.value, props.track],
  () => {
    plans.value = [];
    plansLoaded.value = false;
    plansError.value = '';
    decisions.value = [];
    decisionsLoaded.value = false;
    detail.value = null;
    editing.value = false;
    draftFeedback.value = null;
    dropped.value = '';
    proposeFeedback.value = null;
    reloadAll({ passive: false });
  },
  { immediate: true },
);

watch(() => listed.value?.id, (id, previous) => {
  if (id !== previous) loadDetail();
});

watch(workspace.liveBatch, (batch) => {
  if (!batchTouchesPlans(batch, props.track) || editing.value) return;
  reloadAll();
});

async function focusHeading() {
  await nextTick();
  heading.value?.focus?.();
}

async function showPlan(id) {
  const query = { ...route.query };
  if (!id || id === latest.value?.id) delete query.plan;
  else query.plan = id;
  await router.replace({ query });
}

// ---------------------------------------------------------------------------
// Draft and redraft
// ---------------------------------------------------------------------------

async function runDraft() {
  if (drafting.value) return;
  drafting.value = true;
  draftFeedback.value = null;
  dropped.value = '';
  try {
    const result = await apiClient.draftRequirementsPlan(projectId.value, props.track, token());
    const created = result.plan ?? null;
    dropped.value = droppedNote(result.dropped);
    if (created) plans.value = [created, ...plans.value.filter((entry) => entry.id !== created.id)];
    await showPlan(created?.id ?? '');
    workspace.showMessage(created ? `Drafted ${planTitle(created)} from the track’s decisions.` : 'Plan drafted.');
    workspace.refreshShared();
    await reloadAll();
    focusHeading();
  } catch (error) {
    const described = describeDraftError(error);
    draftFeedback.value = described;
    if (described.reload) reloadAll();
  } finally {
    drafting.value = false;
  }
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

async function startEdit(initialForm = null) {
  edit.value = { error: '', initialForm, issues: [], reapply: null };
  editing.value = true;
  draftFeedback.value = null;
  proposeFeedback.value = null;
  await nextTick();
  document.getElementById('rq-plan-objective')?.focus();
}

function cancelEdit() {
  editing.value = false;
  edit.value = { error: '', initialForm: null, issues: [], reapply: null };
  focusHeading();
}

async function saveEdit(form) {
  if (saving.value || !plan.value) return;
  saving.value = true;
  const base = plan.value;
  try {
    const result = await apiClient.updateRequirementsPlan(projectId.value, base.id, planEditPayload(form), token());
    const saved = result.plan ?? null;
    editing.value = false;
    edit.value = { error: '', initialForm: null, issues: [], reapply: null };
    if (saved) plans.value = [saved, ...plans.value.filter((entry) => entry.id !== saved.id)];
    if (result.createdVersion && saved) {
      workspace.showMessage(`Saved as draft v${saved.version}. v${base.version} stays approved until someone approves v${saved.version}.`);
    } else {
      workspace.showMessage(`Draft v${base.version} saved.`);
    }
    await showPlan(saved?.id ?? '');
    workspace.refreshShared();
    await reloadAll();
    focusHeading();
  } catch (error) {
    const described = describeEditError(error);
    if (described.conflict || described.reload) {
      editing.value = false;
      edit.value = { error: '', initialForm: null, issues: [], reapply: described.conflict ? form : null };
      draftFeedback.value = { code: described.code, message: described.message, reapply: described.conflict, retryable: false, tone: 'warn' };
      await reloadAll();
      focusHeading();
    } else {
      edit.value = { ...edit.value, error: described.message, issues: described.issues ?? [] };
    }
  } finally {
    saving.value = false;
  }
}

function reapplyEdits() {
  const form = edit.value.reapply;
  draftFeedback.value = null;
  startEdit(form);
}

// ---------------------------------------------------------------------------
// Approve
// ---------------------------------------------------------------------------

function openApprove() {
  approve.value = { busy: false, error: '', open: true };
}

function closeApprove() {
  if (!approve.value.busy) approve.value = { ...approve.value, open: false };
}

async function confirmApprove() {
  if (approve.value.busy || !plan.value) return;
  approve.value = { ...approve.value, busy: true, error: '' };
  const target = plan.value;
  try {
    const result = await apiClient.approveRequirementsPlan(projectId.value, target.id, { revision: target.revision }, token());
    approve.value = { busy: false, error: '', open: false };
    const superseded = result.supersededPlanIds?.length ?? 0;
    workspace.showMessage(`Approved ${planTitle(result.plan ?? target)}. You are its owner.${superseded ? ` ${plural(superseded, 'earlier version')} superseded.` : ''}`);
    workspace.refreshShared();
    await reloadAll();
    focusHeading();
  } catch (error) {
    const described = describeApproveError(error, { labels: labels.value, plan: target });
    approve.value = { ...approve.value, busy: false, error: described.message };
    if (described.reload) reloadAll();
  }
}

// ---------------------------------------------------------------------------
// Propose work
// ---------------------------------------------------------------------------

async function runPropose() {
  if (proposing.value || !plan.value) return;
  proposing.value = true;
  proposeFeedback.value = null;
  try {
    const result = await apiClient.proposeRequirementsPlanWork(projectId.value, plan.value.id, token());
    const count = result.proposals?.length ?? 0;
    const uncovered = result.uncoveredCriteriaIds?.length ?? 0;
    workspace.showMessage(`Proposed ${plural(count, 'item')} for review in your AI Workspace.${uncovered ? ` ${plural(uncovered, 'criterion', 'criteria')} still ${uncovered === 1 ? 'has' : 'have'} no proposed story.` : ''}`);
    await loadDetail();
  } catch (error) {
    proposeFeedback.value = describeProposeError(error);
  } finally {
    proposing.value = false;
  }
}

const decideLocation = computed(() => ({ name: 'project-requirements-track', params: { projectId: projectId.value, stage: 'decide', track: props.track } }));
</script>

<template>
  <div class="rq-plan-grid">
    <PlanDecisions
      :decisions="decisions"
      :error="decisionsError"
      :loaded="decisionsLoaded"
      :plan="plan"
      :project-id="projectId"
      @retry="loadDecisions({ passive: false })"
    />

    <div class="rq-stack rq-plan-grid__plan">
      <section class="rq-panel rq-stack" aria-labelledby="rq-plan-heading">
        <div class="rq-row rq-row--between rq-row--wrap rq-row--top">
          <div class="rq-stack rq-stack--sm">
            <div class="rq-row rq-row--tight rq-row--wrap">
              <h3 id="rq-plan-heading" ref="heading" class="rq-eyebrow" tabindex="-1">{{ panelHeading }}</h3>
              <span v-if="plan" class="rq-chip" :class="chipToneClass(statusChip.tone)">{{ statusChip.label }}</span>
            </div>
            <span v-if="plan?.basedOn" class="rq-xs rq-muted">Edited from v{{ plan.basedOn.version }}</span>
          </div>
          <span v-if="owner.text" class="rq-plan-owner">
            <RequirementsAvatar v-if="ownerPerson" :person="ownerPerson" />
            <span v-if="owner.name"><strong>Owner: {{ owner.name }}</strong> · {{ owner.approvedText }}</span>
            <span v-else class="rq-muted">{{ owner.text }}</span>
          </span>
        </div>

        <div v-if="!editing && (actions.draft || actions.edit || actions.approve || actions.proposeWork)" class="rq-plan-actions">
          <button
            v-if="actions.edit"
            class="ghost-button ghost-button--compact"
            type="button"
            :aria-describedby="actions.edit.createsVersion ? 'rq-plan-edit-note' : undefined"
            @click="startEdit()"
          >
            <i class="bi bi-pencil" aria-hidden="true"></i>{{ actions.edit.label }}
          </button>
          <button
            v-if="actions.draft && plans.length > 0"
            class="ghost-button ghost-button--compact"
            type="button"
            :disabled="drafting"
            @click="runDraft"
          >
            <i class="bi bi-arrow-repeat" aria-hidden="true"></i>{{ drafting ? 'Drafting…' : actions.draft.label }}
          </button>
          <button
            v-if="actions.proposeWork"
            class="ghost-button ghost-button--compact"
            type="button"
            :disabled="proposing"
            @click="runPropose"
          >
            <i class="bi bi-diagram-2" aria-hidden="true"></i>{{ proposing ? 'Proposing…' : actions.proposeWork.label }}
          </button>
          <button
            v-if="actions.approve"
            class="primary-button primary-button--compact"
            type="button"
            :disabled="actions.approve.disabled"
            :aria-describedby="actions.approve.reason ? 'rq-plan-approve-reason' : undefined"
            @click="openApprove"
          >
            <i class="bi bi-check2-circle" aria-hidden="true"></i>{{ actions.approve.label }}
          </button>
        </div>
        <p v-if="!editing && actions.edit?.createsVersion" id="rq-plan-edit-note" class="rq-xs rq-muted mb-0">
          Editing an approved plan creates draft v{{ actions.edit.createsVersion }}; this version stays approved until that draft is approved.
        </p>
        <p v-if="!editing && actions.approve?.reason" id="rq-plan-approve-reason" class="rq-xs rq-sum__failed mb-0">{{ actions.approve.reason }}</p>

        <div
          v-if="draftFeedback"
          class="rq-row rq-row--between rq-row--wrap"
          :class="draftFeedback.tone === 'warn' ? 'rq-notice' : 'error-banner'"
          role="alert"
        >
          <span>
            {{ draftFeedback.message }}
            <RouterLink v-if="draftFeedback.decideLink" :to="decideLocation">Go to Decide</RouterLink>
          </span>
          <span class="rq-row rq-row--tight">
            <button v-if="draftFeedback.reapply" class="ghost-button ghost-button--compact" type="button" @click="reapplyEdits">Reapply my edits</button>
            <button v-if="draftFeedback.retryable" class="ghost-button ghost-button--compact" type="button" :disabled="drafting" @click="runDraft">Try again</button>
            <button class="rq-dialog__close" type="button" aria-label="Dismiss" @click="draftFeedback = null"><i class="bi bi-x-lg" aria-hidden="true"></i></button>
          </span>
        </div>
        <p v-if="dropped && !editing" class="rq-sum__note rq-small mb-0" role="status">{{ dropped }}</p>
        <p v-if="viewingOld && !editing" class="rq-notice rq-small mb-0" role="note">
          <i class="bi bi-clock-history" aria-hidden="true"></i>
          You’re viewing v{{ plan.version }}. The latest is v{{ latest.version }}.
          <button class="rq-link-button" type="button" @click="showPlan('')">Show v{{ latest.version }}</button>
        </p>

        <div v-if="plansError" class="error-banner rq-row rq-row--between" role="alert">
          <span>{{ plansError }}</span>
          <button class="ghost-button ghost-button--compact" type="button" @click="reloadAll({ passive: false })">Try again</button>
        </div>
        <p v-else-if="!plansLoaded" class="rq-small rq-muted mb-0">Loading the plan…</p>
        <div v-else-if="!plan" class="rq-empty">
          <p><strong>No plan yet</strong></p>
          <p class="rq-small">
            The track plan is drafted from accepted decisions, with acceptance criteria that cite them. After it is approved, it becomes proposed work for review.
          </p>
          <button v-if="actions.draft" class="primary-button primary-button--compact" type="button" :disabled="drafting" @click="runDraft">
            <i class="bi bi-file-earmark-text" aria-hidden="true"></i>{{ drafting ? 'Drafting…' : actions.draft.label }}
          </button>
          <p v-else class="rq-xs rq-muted">People with plan editing rights on this project draft it.</p>
        </div>
        <PlanEditor
          v-else-if="editing"
          :error="edit.error"
          :initial-form="edit.initialForm"
          :issues="edit.issues"
          :labels="labels"
          :plan="plan"
          :saving="saving"
          @cancel="cancelEdit"
          @save="saveEdit"
        />
        <PlanDocument v-else :labels="labels" :plan="plan" />
      </section>

      <div v-if="proposeFeedback" class="error-banner rq-row rq-row--between rq-row--wrap" role="alert">
        <span>{{ proposeFeedback.message }}</span>
        <span class="rq-row rq-row--tight">
          <button v-if="proposeFeedback.retryable" class="ghost-button ghost-button--compact" type="button" :disabled="proposing" @click="runPropose">Try again</button>
          <button class="rq-dialog__close" type="button" aria-label="Dismiss" @click="proposeFeedback = null"><i class="bi bi-x-lg" aria-hidden="true"></i></button>
        </span>
      </div>

      <PlanProposedWork v-if="plan && !editing && (plan.status === 'approved' || plan.proposedWork?.length)" :labels="labels" :plan="plan" />

      <PlanHistory v-if="!editing" :plans="sorted" :selected-id="plan?.id ?? ''" />
    </div>

    <RequirementsDialog :busy="approve.busy" :open="approve.open" :title="plan ? `Approve ${planTitle(plan)}` : 'Approve plan'" @close="closeApprove" @submit="confirmApprove">
      <div class="rq-small rq-stack rq-stack--sm">
        <p class="mb-0">You become this plan’s owner. Its acceptance criteria are what proposed work will implement.</p>
        <p v-if="sorted.some((entry) => entry.status === 'approved' && entry.id !== plan?.id)" class="mb-0">
          The approved v{{ sorted.find((entry) => entry.status === 'approved' && entry.id !== plan?.id)?.version }} becomes superseded.
        </p>
      </div>
      <p v-if="approve.error" class="error-banner mb-0" role="alert">{{ approve.error }}</p>
      <template #footer>
        <button class="ghost-button" type="button" :disabled="approve.busy" @click="closeApprove">{{ approve.error ? 'Close' : 'Cancel' }}</button>
        <button class="primary-button" type="submit" data-autofocus :disabled="approve.busy">{{ approve.busy ? 'Approving…' : `Approve v${plan?.version ?? ''}` }}</button>
      </template>
    </RequirementsDialog>
  </div>
</template>
