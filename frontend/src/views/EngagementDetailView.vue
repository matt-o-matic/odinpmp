<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import ChannelsWorkspace from '../components/channels/ChannelsWorkspace.vue';
import ProjectFileTree from '../components/projects/ProjectFileTree.vue';
import ProjectResourcesWorkspace from '../components/projects/ProjectResourcesWorkspace.vue';
import RequirementsConfirmDialog from '../components/requirements/RequirementsConfirmDialog.vue';
import RequirementsDialog from '../components/requirements/RequirementsDialog.vue';
import PursuitBoardPanel from '../components/pursuit/PursuitBoardPanel.vue';
import PursuitInsightsPanel from '../components/pursuit/PursuitInsightsPanel.vue';
import PursuitSettingsPanel from '../components/pursuit/PursuitSettingsPanel.vue';
import { createProjectLiveUpdates } from '../lib/projects/project-live-updates.js';
import { apiClient, authSession } from '../lib/auth/index.js';
import {
  ENGAGEMENT_SECTIONS,
  engagementErrorMessage,
  engagementStatusIcon,
  engagementStatusLabel,
  normalizeEngagementSection,
} from '../lib/engagements/engagements.js';
import { projectStore } from '../lib/projects/index.js';
import { formatHours } from '../lib/projects/project-billing.js';

// One engagement: only the sections an engagement has (Channels, Board, Insights, Files, People,
// Settings). Board is the pursuit board and Insights the pursuit insights. Settings holds the
// board and Odin settings, the customer and owner, and Convert, Mark lost and Reopen for people
// with decision rights.
const route = useRoute();
const router = useRouter();

const project = ref(null);
const permissions = ref({});
const loadError = ref('');
const notice = ref('');
const members = ref([]);
const tenantUsers = ref([]);
const projectId = computed(() => String(route.params.projectId ?? ''));
const section = computed(() => normalizeEngagementSection(route.params.section));
const lost = computed(() => project.value?.engagementStatus === 'lost');
const canDecide = computed(() => Boolean(permissions.value?.canManage));
// The SOW invoice-gen linked to this engagement (invoice-gen plan, step 2). Billing data, so only
// people with decision rights (the finance-visible ones) load it.
const sow = ref(null);
const sowSigned = computed(() => sow.value?.status === 'executed');
async function loadSow() {
  sow.value = null;
  if (!canDecide.value) return;
  try {
    sow.value = (await apiClient.passive.getProjectBilling(projectId.value, authSession.state.token))?.link?.agreement ?? null;
  } catch {
    sow.value = null;
  }
}
const ownerName = computed(() => {
  const ownerId = project.value?.engagementOwnerId;
  return [...members.value, ...tenantUsers.value].find((user) => user.id === ownerId)?.name ?? '';
});

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '' : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

async function loadPeople() {
  try {
    const result = await apiClient.passive.getProjectValidUsers(projectId.value, authSession.state.token);
    members.value = Array.isArray(result?.project_users) ? result.project_users : [];
    tenantUsers.value = Array.isArray(result?.tenant_users) ? result.tenant_users : [];
  } catch {
    members.value = [];
    tenantUsers.value = [];
  }
}

async function load() {
  loadError.value = '';
  try {
    const result = await apiClient.getProject(projectId.value, authSession.state.token);
    // A converted engagement is a delivery project: its own page has the full workspace.
    if (result.project?.kind !== 'engagement') {
      await router.replace({ name: 'project-detail', params: { projectId: projectId.value } });
      return;
    }
    project.value = result.project;
    permissions.value = result.permissions ?? {};
    await Promise.all([loadPeople(), loadSow()]);
  } catch (error) {
    project.value = null;
    loadError.value = error?.status === 404 ? 'This engagement was not found, or you are not a member of it.' : engagementErrorMessage(error, 'The engagement could not load.');
  }
}

watch(projectId, (value) => { if (value) void load(); }, { immediate: true });

// The Board and Insights tabs refetch when someone else changes the engagement.
const refreshVersion = ref(0);
let stopLiveUpdates = null;
watch(projectId, (value) => {
  stopLiveUpdates?.();
  stopLiveUpdates = value
    ? createProjectLiveUpdates({ apiClient, getToken: () => authSession.state.token, onChange: () => { refreshVersion.value += 1; }, projectId: value })
    : null;
}, { immediate: true });
onBeforeUnmount(() => stopLiveUpdates?.());

// ---- Rename ----
const renaming = reactive({ busy: false, error: '', name: '', open: false });
function openRename() {
  Object.assign(renaming, { busy: false, error: '', name: project.value?.name ?? '', open: true });
}
async function submitRename() {
  const name = renaming.name.trim();
  if (!name) { renaming.error = 'Enter a name.'; return; }
  renaming.busy = true;
  renaming.error = '';
  try {
    const current = project.value;
    const result = await apiClient.updateProject(current.id, {
      description: current.description ?? '', endDate: current.endDate ?? null, expectedUpdatedAt: current.updatedAt,
      name, startDate: current.startDate ?? null, status: current.status,
    }, authSession.state.token);
    project.value = { ...current, ...result.project };
    renaming.open = false;
  } catch (error) {
    renaming.error = engagementErrorMessage(error, 'The engagement could not be renamed.');
  } finally {
    renaming.busy = false;
  }
}

// ---- Customer and owner ----
const details = reactive({ busy: false, customer: '', error: '', open: false, ownerId: '' });
function openDetails() {
  Object.assign(details, { busy: false, customer: project.value?.engagementCustomer ?? '', error: '', open: true, ownerId: project.value?.engagementOwnerId ?? '' });
}
async function submitDetails() {
  const customer = details.customer.trim();
  if (!customer) { details.error = 'Enter the customer.'; return; }
  details.busy = true;
  details.error = '';
  try {
    const result = await apiClient.updateEngagement(project.value.id, { customer, ...(details.ownerId ? { ownerId: details.ownerId } : {}) }, authSession.state.token);
    project.value = { ...project.value, ...result.project };
    details.open = false;
    notice.value = 'Saved.';
  } catch (error) {
    details.error = engagementErrorMessage(error, 'The engagement could not be saved.');
  } finally {
    details.busy = false;
  }
}

// ---- Convert ----
const converting = reactive({ busy: false, error: '', moveOpenPursuitTasks: false, open: false, templateId: '', templates: [], templatesLoaded: false });
async function openConvert() {
  Object.assign(converting, { busy: false, error: '', moveOpenPursuitTasks: false, open: true, templateId: '' });
  if (converting.templatesLoaded) return;
  try {
    const result = await apiClient.passive.listWorkflowTemplates({ kind: 'project', status: 'active' }, authSession.state.token);
    converting.templates = (result?.templates ?? []).filter((template) => template.payloadStatus !== 'needs_update');
  } catch {
    converting.templates = [];
  } finally {
    converting.templatesLoaded = true;
  }
}
async function submitConvert() {
  if (converting.busy) return;
  converting.busy = true;
  converting.error = '';
  try {
    await apiClient.convertEngagement(project.value.id, { moveOpenPursuitTasks: converting.moveOpenPursuitTasks, templateId: converting.templateId || null }, authSession.state.token);
    converting.open = false;
    projectStore.loadProjects({ background: true }).catch(() => null);
    await router.push({ name: 'project-detail', params: { projectId: project.value.id } });
  } catch (error) {
    converting.error = engagementErrorMessage(error, 'The engagement could not be converted. Nothing was changed.');
  } finally {
    converting.busy = false;
  }
}

// ---- Mark lost and reopen ----
const closing = reactive({ busy: false, error: '', open: false });
async function confirmClose() {
  closing.busy = true;
  closing.error = '';
  try {
    project.value = { ...project.value, ...(await apiClient.closeEngagement(project.value.id, authSession.state.token)).project };
    closing.open = false;
    notice.value = 'Marked lost. The engagement is read-only until it is reopened.';
  } catch (error) {
    closing.error = engagementErrorMessage(error, 'The engagement could not be marked lost.');
  } finally {
    closing.busy = false;
  }
}

const reopenError = ref('');
const reopenBusy = ref(false);
async function reopen() {
  reopenBusy.value = true;
  reopenError.value = '';
  try {
    project.value = { ...project.value, ...(await apiClient.reopenEngagement(project.value.id, authSession.state.token)).project };
    notice.value = 'Reopened.';
  } catch (error) {
    reopenError.value = engagementErrorMessage(error, 'The engagement could not be reopened.');
  } finally {
    reopenBusy.value = false;
  }
}
</script>

<template>
  <section class="dashboard-panel engagement-page">
    <div v-if="loadError" class="error-banner" role="alert">{{ loadError }}</div>

    <template v-if="project">
      <header class="engagement-head">
        <div class="engagement-head__identity">
          <h1 class="engagement-head__title">{{ project.name }}</h1>
          <p class="engagement-head__meta">
            {{ project.engagementCustomer }}<template v-if="ownerName"> · Owner {{ ownerName }}</template>
            ·
            <span class="engagement-status">
              <i class="bi" :class="engagementStatusIcon(project.engagementStatus)" aria-hidden="true"></i>{{ engagementStatusLabel(project.engagementStatus) }}
            </span>
            <template v-if="sowSigned">
              ·
              <span class="engagement-status" data-testid="engagement-sow-signed">
                <i class="bi bi-file-earmark-check-fill" aria-hidden="true"></i>
                <a v-if="sow.url" :href="sow.url" target="_blank" rel="noopener noreferrer">SOW signed<span class="visually-hidden"> (opens invoice-gen)</span></a>
                <template v-else>SOW signed</template>
              </span>
            </template>
          </p>
        </div>
        <RouterLink class="pill-link" :to="{ name: 'engagements' }">Back to engagements</RouterLink>
      </header>

      <div v-if="lost" class="engagement-lost" role="status">
        <i class="bi bi-lock" aria-hidden="true"></i>
        <span>Marked lost<template v-if="project.closedAt"> on {{ formatDate(project.closedAt) }}</template>. Files and people are read-only.</span>
        <button v-if="canDecide" class="ghost-button ghost-button--compact" type="button" :disabled="reopenBusy" @click="reopen">
          {{ reopenBusy ? 'Reopening…' : 'Reopen' }}
        </button>
      </div>
      <p v-if="reopenError" class="error-banner" role="alert">{{ reopenError }}</p>
      <div v-if="notice" class="success-banner d-flex align-items-start justify-content-between gap-2" role="status">
        <span>{{ notice }}</span>
        <button class="btn-close flex-shrink-0" type="button" aria-label="Dismiss message" @click="notice = ''"></button>
      </div>

      <div class="project-detail-tabs-bar">
        <nav class="project-detail-tabs" aria-label="Engagement sections">
          <RouterLink
            v-for="entry in ENGAGEMENT_SECTIONS"
            :key="entry.id"
            class="project-detail-tabs__item"
            :class="{ 'project-detail-tabs__item--active': section === entry.id }"
            :aria-current="section === entry.id ? 'page' : undefined"
            :to="{ name: 'engagement-detail', params: { projectId: project.id, section: entry.id === 'channels' ? undefined : entry.id } }"
          >
            {{ entry.label }}
          </RouterLink>
        </nav>
      </div>

      <ChannelsWorkspace v-if="section === 'channels'" :key="`channels-${project.engagementStatus}`" :project-id="project.id" />

      <PursuitBoardPanel
        v-else-if="section === 'board'"
        :key="`board-${project.engagementStatus}`"
        :project-id="project.id"
        :read-only="lost"
        :refresh-version="refreshVersion"
      />

      <PursuitInsightsPanel v-else-if="section === 'insights'" :project-id="project.id" :refresh-version="refreshVersion" />

      <ProjectFileTree
        v-else-if="section === 'files'"
        :key="`files-${project.engagementStatus}`"
        :focus-file-id="String(route.query.file ?? '')"
        :project-id="project.id"
        :token="authSession.state.token"
      />

      <ProjectResourcesWorkspace
        v-else-if="section === 'people'"
        :can-manage-access="Boolean(permissions.canManageMembers) && !lost"
        :members="members"
        :project="project"
        :tenant-users="tenantUsers"
        @changed="loadPeople"
      />

      <section v-else-if="section === 'settings'" class="engagement-settings" aria-labelledby="engagement-settings-heading">
        <h2 id="engagement-settings-heading" class="visually-hidden">Settings</h2>
        <dl class="engagement-facts">
          <div><dt>Name</dt><dd>{{ project.name }}</dd></div>
          <div><dt>Customer</dt><dd>{{ project.engagementCustomer }}</dd></div>
          <div><dt>Owner</dt><dd>{{ ownerName || '—' }}</dd></div>
          <div><dt>Created</dt><dd>{{ formatDate(project.createdAt) }}</dd></div>
        </dl>
        <PursuitSettingsPanel :key="`settings-${project.engagementStatus}`" :project-id="project.id" :read-only="lost" />
        <div v-if="canDecide && !lost" class="engagement-actions">
          <button class="ghost-button" type="button" @click="openRename"><i class="bi bi-pencil" aria-hidden="true"></i> Rename</button>
          <button class="ghost-button" type="button" @click="openDetails"><i class="bi bi-person-badge" aria-hidden="true"></i> Customer and owner</button>
          <button class="primary-button" type="button" @click="openConvert"><i class="bi bi-arrow-right-circle" aria-hidden="true"></i> Convert to project</button>
          <button class="ghost-button engagement-actions__lost" type="button" @click="closing.open = true; closing.error = ''">
            <i class="bi bi-x-circle" aria-hidden="true"></i> Mark lost
          </button>
        </div>
      </section>
    </template>

    <RequirementsDialog :busy="renaming.busy" :open="renaming.open" title="Rename engagement" @close="renaming.open = false" @submit="submitRename">
      <div class="rq-field">
        <label for="engagement-rename">Name</label>
        <input id="engagement-rename" v-model="renaming.name" class="form-control" maxlength="160" autocomplete="off" />
      </div>
      <p v-if="renaming.error" class="error-banner mb-0" role="alert">{{ renaming.error }}</p>
      <template #footer>
        <button class="ghost-button" type="button" :disabled="renaming.busy" @click="renaming.open = false">Cancel</button>
        <button class="primary-button" type="submit" :disabled="renaming.busy">{{ renaming.busy ? 'Saving…' : 'Save' }}</button>
      </template>
    </RequirementsDialog>

    <RequirementsDialog :busy="details.busy" :open="details.open" title="Customer and owner" @close="details.open = false" @submit="submitDetails">
      <div class="rq-field">
        <label for="engagement-customer-edit">Customer</label>
        <input id="engagement-customer-edit" v-model="details.customer" class="form-control" maxlength="255" autocomplete="off" />
      </div>
      <div class="rq-field">
        <label for="engagement-owner-edit">Owner</label>
        <select id="engagement-owner-edit" v-model="details.ownerId" class="form-select">
          <option v-for="member in members" :key="member.id" :value="member.id">{{ member.name || member.email }}</option>
        </select>
        <p class="rq-field__hint mb-0">The owner is one of the engagement's members. Add people under People.</p>
      </div>
      <p v-if="details.error" class="error-banner mb-0" role="alert">{{ details.error }}</p>
      <template #footer>
        <button class="ghost-button" type="button" :disabled="details.busy" @click="details.open = false">Cancel</button>
        <button class="primary-button" type="submit" :disabled="details.busy">{{ details.busy ? 'Saving…' : 'Save' }}</button>
      </template>
    </RequirementsDialog>

    <RequirementsDialog :busy="converting.busy" :open="converting.open" title="Convert to project" @close="converting.open = false" @submit="submitConvert">
      <p class="mb-0">
        <strong>{{ project?.name }}</strong> becomes a delivery project with the same files and people.
        It then appears in the projects list, boards and reports.
      </p>
      <!-- invoice-gen step 2: the linked SOW and its milestones. -->
      <div v-if="sow" class="engagement-sow" data-testid="convert-sow">
        <p class="mb-1">
          <strong>SOW:</strong>
          <a v-if="sow.url" :href="sow.url" target="_blank" rel="noopener noreferrer">{{ sow.title || 'SOW' }}<span class="visually-hidden"> (opens invoice-gen)</span></a>
          <template v-else>{{ sow.title || 'SOW' }}</template>
          · {{ sowSigned ? 'Signed' : sow.status }}
        </p>
        <ul v-if="sow.milestones?.length" class="engagement-sow__milestones">
          <li v-for="milestone in sow.milestones" :key="milestone.id">{{ milestone.name }} <span class="engagement-sow__hours">{{ formatHours(milestone.hours) }}</span></li>
        </ul>
        <p class="rq-field__hint mb-0">The project stays linked to this SOW. Converting creates no work from it: assign stories to its milestones afterwards, on the project's Billing tab.</p>
      </div>
      <div class="rq-field">
        <label for="engagement-template">Project template</label>
        <select id="engagement-template" v-model="converting.templateId" class="form-select" :disabled="!converting.templatesLoaded">
          <option value="">No template</option>
          <option v-for="template in converting.templates" :key="template.id" :value="template.id">{{ template.name }}</option>
        </select>
        <p class="rq-field__hint">A template adds its workflows, custom fields and starter outline. If any of it fails, nothing changes.</p>
      </div>
      <div class="rq-field">
        <label class="planning-check-row" for="engagement-move-pursuit">
          <input id="engagement-move-pursuit" v-model="converting.moveOpenPursuitTasks" type="checkbox" aria-describedby="engagement-move-pursuit-hint" />
          <span>Move open pursuit tasks to the project board</span>
        </label>
        <p id="engagement-move-pursuit-hint" class="rq-field__hint">Off: every pursuit task stays on the project's Pursuit tab, where you can move tasks later.</p>
      </div>
      <p v-if="converting.error" class="error-banner mb-0" role="alert">{{ converting.error }}</p>
      <template #footer>
        <button class="ghost-button" type="button" :disabled="converting.busy" @click="converting.open = false">Cancel</button>
        <button class="primary-button" type="submit" :disabled="converting.busy">{{ converting.busy ? 'Converting…' : 'Convert' }}</button>
      </template>
    </RequirementsDialog>

    <RequirementsConfirmDialog
      :busy="closing.busy"
      confirm-label="Mark lost"
      :error="closing.error"
      :open="closing.open"
      title="Mark this engagement lost?"
      @close="closing.open = false"
      @confirm="confirmClose"
    >
      <p class="mb-0"><strong>{{ project?.name }}</strong> becomes read-only and moves to Lost. You can reopen it later.</p>
    </RequirementsConfirmDialog>
  </section>
</template>

<style scoped>
.engagement-sow {
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border-color, #c9d1db);
  border-radius: 0.5rem;
}

.engagement-sow__milestones {
  margin: 0 0 0.5rem;
  padding-left: 1.25rem;
}

.engagement-sow__hours {
  color: var(--text-muted, #5f6b7a);
}

.engagement-page {
  display: grid;
  gap: 0.75rem;
  font-size: 0.875rem;
}

.engagement-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.5rem;
}

.engagement-head__title {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 600;
  line-height: 1.2;
}

.engagement-head__meta {
  margin: 0.25rem 0 0;
  color: var(--bs-secondary-color);
}

.engagement-status {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
}

.engagement-lost {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--bs-border-color);
  border-radius: 0.5rem;
  background: var(--bs-tertiary-bg);
}

.engagement-settings {
  display: grid;
  gap: 1rem;
}

.engagement-facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
  gap: 0.75rem;
  margin: 0;
}

.engagement-facts dt {
  color: var(--bs-secondary-color);
  font-weight: 500;
}

.engagement-facts dd {
  margin: 0.25rem 0 0;
}

.engagement-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.engagement-actions button {
  min-height: 2.75rem;
}
</style>
