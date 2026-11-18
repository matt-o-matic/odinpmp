<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';

import ComplianceAttestationsPanel from '../components/admin/compliance/ComplianceAttestationsPanel.vue';
import ComplianceExportsPanel from '../components/admin/compliance/ComplianceExportsPanel.vue';
import ComplianceLegalHoldsPanel from '../components/admin/compliance/ComplianceLegalHoldsPanel.vue';
import CompliancePolicyPanel from '../components/admin/compliance/CompliancePolicyPanel.vue';
import CompliancePrivacyPanel from '../components/admin/compliance/CompliancePrivacyPanel.vue';
import '../components/admin/admin-screens.css';
import { COMPLIANCE_SECTIONS, complianceErrorMessage } from '../lib/admin/compliance.js';
import { apiClient, authSession } from '../lib/auth/index.js';

const route = useRoute();
const token = computed(() => authSession.state.token);
const currentUserId = computed(() => authSession.state.currentUser?.id ?? '');
const section = computed(() => (COMPLIANCE_SECTIONS.some((item) => item.key === route.params.section) ? route.params.section : 'policy'));

const workspace = ref(null);
const users = ref([]);
const projects = ref([]);
const loading = ref(true);
const errorMessage = ref('');
const notice = ref('');

const userNames = computed(() => new Map(users.value.map((user) => [user.id, user.name || user.email || user.id])));
const projectNames = computed(() => new Map(projects.value.map((project) => [project.id, project.name])));
const deletedProjects = ref([]);
const deletedProjectNames = computed(() => new Map(deletedProjects.value.map((project) => [project.id, project.name])));

// Erased people leave the tenant, so their ids stop resolving; say so instead of showing a raw id.
function userLabel(id) {
  if (!id) return '—';
  if (id === currentUserId.value) return `${userNames.value.get(id) ?? 'You'} (you)`;
  return userNames.value.get(id) ?? `Former member (${String(id).slice(0, 8)})`;
}

// Holds outlive project soft-deletion, so a held project that was deleted keeps its name.
function projectLabel(id) {
  if (projectNames.value.has(id)) return projectNames.value.get(id);
  if (deletedProjectNames.value.has(id)) return `${deletedProjectNames.value.get(id)} (deleted)`;
  return `Project ${String(id).slice(0, 8)} (deleted or unavailable)`;
}

async function load({ quiet = false } = {}) {
  loading.value = !quiet && !workspace.value;
  errorMessage.value = '';
  try {
    const [result, userList, projectList, deletedList] = await Promise.all([
      apiClient.getComplianceWorkspace(token.value),
      apiClient.getTenantExistingUsers(token.value).catch(() => ({ users: [] })),
      apiClient.getProjects(token.value).catch(() => ({ projects: [] })),
      apiClient.listDeletedProjects(token.value).catch(() => ({ projects: [] })),
    ]);
    workspace.value = result;
    deletedProjects.value = deletedList?.projects ?? [];
    users.value = [...(userList?.users ?? [])].sort((left, right) => String(left.name).localeCompare(String(right.name)));
    projects.value = (projectList?.projects ?? []).filter((project) => !project.deletedAt).sort((left, right) => String(left.name).localeCompare(String(right.name)));
  } catch (error) {
    errorMessage.value = complianceErrorMessage(error, 'Unable to load compliance controls.');
  } finally {
    loading.value = false;
  }
}

function handleChanged(message) {
  notice.value = message;
  load({ quiet: true });
}

watch(section, () => {
  notice.value = '';
});

onMounted(load);
</script>

<template>
  <div class="adm-page compliance-page">
    <header class="adm-header">
      <div>
        <h1>Compliance</h1>
        <p>Retention and residency policy, tamper-evident audit exports, legal holds, control attestations, and privacy erasure.</p>
      </div>
      <div class="adm-header-actions">
        <button class="btn btn-sm btn-outline-secondary" type="button" :disabled="loading" @click="load()">
          <i class="bi bi-arrow-clockwise" aria-hidden="true"></i> Refresh
        </button>
      </div>
    </header>

    <nav class="adm-tabs" aria-label="Compliance sections">
      <RouterLink
        v-for="item in COMPLIANCE_SECTIONS"
        :key="item.key"
        :aria-current="section === item.key ? 'page' : undefined"
        :class="{ active: section === item.key }"
        :to="{ name: 'compliance-admin', params: { section: item.key === 'policy' ? undefined : item.key } }"
      >
        <i :class="['bi', item.icon]" aria-hidden="true"></i>{{ item.label }}
      </RouterLink>
    </nav>

    <div v-if="errorMessage" class="alert alert-danger" role="alert">{{ errorMessage }}</div>
    <p v-if="notice" class="alert alert-success py-2" role="status">{{ notice }}</p>
    <p v-if="loading" class="adm-empty" role="status">Loading compliance controls…</p>

    <template v-else-if="workspace">
      <CompliancePolicyPanel
        v-if="section === 'policy'"
        :policy="workspace.policy"
        :user-label="userLabel"
        @changed="handleChanged"
        @reload="load({ quiet: true })"
      />
      <ComplianceExportsPanel
        v-else-if="section === 'exports'"
        :exports="workspace.exports ?? []"
        :policy="workspace.policy"
        :user-label="userLabel"
        @changed="handleChanged"
      />
      <ComplianceLegalHoldsPanel
        v-else-if="section === 'legal-holds'"
        :exports="workspace.exports ?? []"
        :holds="workspace.legalHolds ?? []"
        :project-label="projectLabel"
        :projects="projects"
        :user-label="userLabel"
        :users="users"
        @changed="handleChanged"
        @reload="load({ quiet: true })"
      />
      <ComplianceAttestationsPanel
        v-else-if="section === 'attestations'"
        :attestations="workspace.controlAttestations ?? []"
        :user-label="userLabel"
        @changed="handleChanged"
      />
      <CompliancePrivacyPanel
        v-else-if="section === 'privacy'"
        :current-user-id="currentUserId"
        :requests="workspace.privacyRequests ?? []"
        :user-label="userLabel"
        :users="users"
        @changed="handleChanged"
        @reload="load({ quiet: true })"
      />
    </template>
  </div>
</template>
