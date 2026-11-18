<script setup>
import { computed, nextTick, onMounted, reactive, ref } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { Tab } from 'bootstrap';

import DeletedProjectsPanel from '../components/admin/DeletedProjectsPanel.vue';
import WorkspaceModulesPanel from '../components/admin/WorkspaceModulesPanel.vue';
import RequirementsConfirmDialog from '../components/requirements/RequirementsConfirmDialog.vue';
import WorkspaceJoinRequestsPanel from '../components/admin/WorkspaceJoinRequestsPanel.vue';
import { apiClient, authSession } from '../lib/auth/index.js';
import {
  AI_PROJECT_HELPER_CAPABILITY_DEFINITIONS,
  AI_REASONING_EFFORTS,
  AI_TOOL_LABELS,
  AI_WORKSPACE_CAPABILITY_DEFINITIONS,
  createDefaultAiConfig,
  normalizeAiCapabilityConfig,
} from '../lib/assistant/assistant-capabilities.js';

const route = useRoute();
// Emails about a request to join link to ?section=user-management&tab=requests.
const section = ref(['user-management', 'modules'].includes(route.query.section) ? route.query.section : 'tenant-settings');
const busy = ref(false);
const loading = ref(false);
const errorMessage = ref('');
const successMessage = ref('');
const userMgmtLoading = ref(false);
const auditLoading = ref(false);
const auditExporting = ref(false);
const auditLogs = ref([]);
const auditStartDate = ref('');
const auditEndDate = ref('');
const auditSearchText = ref('');
const backupBusy = ref(false);
const restoreBusy = ref(false);
const restoreFileInput = ref(null);
const restoreBase64 = ref('');
const restoreFilename = ref('');

const existingUsers = ref([]);
// Resource profiles, so each login can be linked to the person's profile (rates, skills, capacity).
const resourceProfiles = ref([]);
const resourceByUser = computed(() => new Map(resourceProfiles.value.filter((resource) => resource.userId).map((resource) => [resource.userId, resource])));
const linkableResources = (userId) => resourceProfiles.value
  .filter((resource) => !resource.userId || resource.userId === userId)
  .sort((left, right) => left.name.localeCompare(right.name));
const resourceLink = reactive({ busy: false, error: '', open: false, resource: null, current: null, user: null });
const joinRequestCount = ref(0);
const invites = ref([]);

const inviteForm = reactive({
  email: '',
  role: 'user',
});

const tenantForm = reactive({
  domains: [''],
  tenant_name: '',
});

const openAiBusy = ref(false);
const openAiConfig = reactive(createDefaultAiConfig());
const aiProjectHelperCapabilityDefinitions = AI_PROJECT_HELPER_CAPABILITY_DEFINITIONS;
const aiReasoningEfforts = AI_REASONING_EFFORTS;
const aiToolLabels = AI_TOOL_LABELS;
const aiWorkspaceCapabilityDefinitions = AI_WORKSPACE_CAPABILITY_DEFINITIONS;

const openAiCatalogNote = computed(() => {
  const defaultModel = String(openAiConfig.default_model ?? '').trim() || 'gpt-6-luna';
  if (openAiConfig.uses_tenant_openai_key) {
    return `Using a tenant API key. Fetch Models refreshes the full model catalog for that key. Default model: ${defaultModel}.`;
  }

  return `Using the shared backend configuration. Model choices are limited to the curated platform list, and defaults follow the backend OPENAI_MODEL setting or ${defaultModel}. Add a tenant API key to fetch the full model catalog.`;
});

const canAdmin = computed(() => authSession.state.currentUser?.role === 'admin');

const customizationsLoading = ref(false);
const statuses = ref([]);
const taskTypes = ref([]);
const newStatusName = ref('');
const newTaskTypeName = ref('');

function isoDateOnly(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return '';
  }
  return date.toISOString().slice(0, 10);
}

function ensureAuditDateDefaults() {
  if (auditStartDate.value && auditEndDate.value) {
    return;
  }

  const now = new Date();
  const end = auditEndDate.value || isoDateOnly(now);
  const startDate = new Date(now.valueOf());
  startDate.setUTCDate(startDate.getUTCDate() - 30);
  const start = auditStartDate.value || isoDateOnly(startDate);

  auditStartDate.value = start;
  auditEndDate.value = end;
}

function downloadBase64File({ base64, filename, mimeType }) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

const filteredAuditLogs = computed(() => {
  const query = String(auditSearchText.value ?? '').trim().toLowerCase();
  if (!query) return auditLogs.value;

  return auditLogs.value.filter((log) => {
    return [
      log?.user_full_name,
      log?.project_name,
      log?.action,
      log?.result,
      log?.detail,
      log?.date_time,
    ]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
  });
});

function normalizeDomains(domains) {
  const normalized = (domains ?? [])
    .map((domain) => String(domain ?? '').trim())
    .filter(Boolean);
  return normalized.length ? normalized : [''];
}

async function loadTenantSettings() {
  if (!authSession.state.token || !canAdmin.value) return;
  loading.value = true;
  errorMessage.value = '';

  try {
    const result = await apiClient.getTenantSettings(authSession.state.token);
    tenantForm.tenant_name = result.tenant_name ?? '';
    tenantForm.domains = normalizeDomains(result.domains);
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to load tenant settings.';
  } finally {
    loading.value = false;
  }
}

function addDomain() {
  tenantForm.domains.push('');
}

function removeDomain(index) {
  tenantForm.domains.splice(index, 1);
  if (tenantForm.domains.length === 0) tenantForm.domains.push('');
}

async function saveTenantSettings() {
  if (!authSession.state.token || !canAdmin.value) return;
  busy.value = true;
  errorMessage.value = '';
  successMessage.value = '';

  try {
    const payload = {
      tenant_name: tenantForm.tenant_name,
      domains: normalizeDomains(tenantForm.domains),
    };
    const result = await apiClient.updateTenantSettings(payload, authSession.state.token);
    successMessage.value = result.message ?? 'Saved.';
    await loadTenantSettings();
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to save tenant settings.';
  } finally {
    busy.value = false;
  }
}

async function loadAuditLogs() {
  if (!authSession.state.token || !canAdmin.value) return;
  ensureAuditDateDefaults();
  auditLoading.value = true;
  errorMessage.value = '';

  try {
    const result = await apiClient.getTenantAuditLogs(
      {
        end_date: auditEndDate.value,
        output_type: 'json',
        search_text: '',
        start_date: auditStartDate.value,
      },
      authSession.state.token,
    );
    auditLogs.value = result.logs ?? [];
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to load audit logs.';
  } finally {
    auditLoading.value = false;
  }
}

async function exportAuditLogs() {
  if (!authSession.state.token || !canAdmin.value) return;
  ensureAuditDateDefaults();
  auditExporting.value = true;
  errorMessage.value = '';

  try {
    const result = await apiClient.getTenantAuditLogs(
      {
        end_date: auditEndDate.value,
        output_type: 'xlsx',
        search_text: auditSearchText.value,
        start_date: auditStartDate.value,
      },
      authSession.state.token,
    );

    if (result.xlsxBase64 && result.filename) {
      downloadBase64File({
        base64: result.xlsxBase64,
        filename: result.filename,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      successMessage.value = 'Export downloaded.';
    } else {
      throw new Error('No export data returned.');
    }
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to export audit logs.';
  } finally {
    auditExporting.value = false;
  }
}

async function triggerTenantBackup() {
  if (!authSession.state.token || !canAdmin.value) return;
  backupBusy.value = true;
  errorMessage.value = '';

  try {
    const result = await apiClient.backupTenant(authSession.state.token);
    if (result.base64Odin && result.filename) {
      downloadBase64File({
        base64: result.base64Odin,
        filename: result.filename,
        mimeType: 'application/zip',
      });
      successMessage.value = 'Backup downloaded.';
    } else {
      throw new Error('No backup data returned.');
    }
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to generate backup.';
  } finally {
    backupBusy.value = false;
  }
}

function triggerRestorePick() {
  restoreFileInput.value?.click();
}

async function handleRestoreFileSelected(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  restoreFilename.value = file.name;
  restoreBusy.value = true;
  errorMessage.value = '';

  try {
    const buffer = await file.arrayBuffer();
    restoreBase64.value = arrayBufferToBase64(buffer);
    successMessage.value = 'Backup file loaded.';
  } catch (error) {
    restoreBase64.value = '';
    restoreFilename.value = '';
    errorMessage.value = error.message ?? 'Unable to read backup file.';
  } finally {
    restoreBusy.value = false;
    event.target.value = '';
  }
}

async function restoreTenantFromBackup() {
  if (!authSession.state.token || !canAdmin.value) return;
  if (!restoreBase64.value) return;

  restoreBusy.value = true;
  errorMessage.value = '';
  successMessage.value = '';

  try {
    // A restore replaces the whole tenant's data, so block the page until it finishes.
    const result = await apiClient.blocking.restoreTenant(
      {
        base64Odin: restoreBase64.value,
      },
      authSession.state.token,
    );
    successMessage.value = result.message ?? 'Tenant restored.';
    restoreBase64.value = '';
    restoreFilename.value = '';
    auditLogs.value = [];
    await loadTenantSettings();
    await loadUserManagement();
    await loadCustomizations();
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to restore tenant.';
  } finally {
    restoreBusy.value = false;
  }
}

async function loadOpenAiConfig() {
  if (!authSession.state.token || !canAdmin.value) return;
  openAiBusy.value = true;
  errorMessage.value = '';

  try {
    const result = await apiClient.getTenantOpenAiConfig(authSession.state.token);
    applyOpenAiConfig(result.openai_config ?? {});
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to load OpenAI configuration.';
  } finally {
    openAiBusy.value = false;
  }
}

async function fetchModels() {
  if (!authSession.state.token || !canAdmin.value) return;
  openAiBusy.value = true;
  errorMessage.value = '';
  successMessage.value = '';

  try {
    const result = await apiClient.fetchTenantOpenAiModels(
      { openai_key: openAiConfig.openai_key },
      authSession.state.token,
    );
    applyOpenAiConfig({
      ...openAiConfig,
      ...(result.openai_config ?? {}),
      capabilities: openAiConfig.capabilities,
    });
    successMessage.value = 'Models fetched.';
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to fetch models.';
  } finally {
    openAiBusy.value = false;
  }
}

async function saveOpenAiConfig() {
  if (!authSession.state.token || !canAdmin.value) return;
  openAiBusy.value = true;
  errorMessage.value = '';
  successMessage.value = '';

  try {
    const normalized = normalizeAiCapabilityConfig(openAiConfig);
    const payload = {
      openai_config: {
        available_models: normalized.available_models,
        capabilities: normalized.capabilities,
        model_to_function: normalized.model_to_function,
        openai_key: normalized.openai_key,
        valid_config: true,
      },
    };
    const result = await apiClient.saveTenantOpenAiConfig(payload, authSession.state.token);
    successMessage.value = result.message ?? 'Saved.';
    await loadOpenAiConfig();
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to save OpenAI configuration.';
  } finally {
    openAiBusy.value = false;
  }
}

function applyOpenAiConfig(config = {}) {
  const normalized = normalizeAiCapabilityConfig(config);
  Object.assign(openAiConfig, normalized);
}

function toggleCapabilityTool(capabilityId, toolId, enabled) {
  const current = openAiConfig.capabilities?.[capabilityId];
  if (!current) {
    return;
  }

  const nextTools = new Set(current.enabledTools ?? []);
  if (enabled) {
    nextTools.add(toolId);
  } else {
    nextTools.delete(toolId);
  }

  openAiConfig.capabilities[capabilityId] = {
    ...current,
    enabledTools: [...nextTools],
  };
}

async function resetOpenAiConfig() {
  if (!authSession.state.token || !canAdmin.value) return;
  openAiBusy.value = true;
  errorMessage.value = '';
  successMessage.value = '';

  try {
    const result = await apiClient.deleteTenantOpenAiConfig(authSession.state.token);
    successMessage.value = result.message ?? 'Reset.';
    await loadOpenAiConfig();
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to reset OpenAI configuration.';
  } finally {
    openAiBusy.value = false;
  }
}

async function loadUserManagement() {
  if (!authSession.state.token || !canAdmin.value) return;

  userMgmtLoading.value = true;

  try {
    const [usersResult, invitesResult, resourcesResult] = await Promise.all([
      apiClient.getTenantExistingUsers(authSession.state.token),
      apiClient.getTenantInvites(authSession.state.token),
      apiClient.getResourceFinanceWorkspace({ limit: 200 }, authSession.state.token).catch(() => ({ resources: [] })),
    ]);

    existingUsers.value = usersResult.users ?? [];
    resourceProfiles.value = resourcesResult.resources ?? [];
    invites.value = invitesResult.invites ?? [];
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to load user management data.';
  } finally {
    userMgmtLoading.value = false;
  }
}

async function changeResourceLink(user, value, select) {
  const current = resourceByUser.value.get(user.id) ?? null;
  if ((current?.id ?? '') === value) return;
  if (value && value !== '__new' && current) {
    // Linking a second profile merges the current one into it, so confirm first.
    Object.assign(resourceLink, { busy: false, current, error: '', open: true, resource: resourceProfiles.value.find((entry) => entry.id === value), user });
    if (select) select.value = current.id;
    return;
  }
  await applyResourceLink(user, value, current);
}

async function applyResourceLink(user, value, current) {
  busy.value = true;
  errorMessage.value = '';
  successMessage.value = '';
  try {
    if (value === '__new') {
      await apiClient.createEnterpriseResource({ name: user.name || user.email, userId: user.id }, authSession.state.token);
      successMessage.value = `Created a resource profile for ${user.name}.`;
    } else if (!value && current) {
      await apiClient.updateEnterpriseResource(current.id, { expectedVersion: current.version, userId: null }, authSession.state.token);
      successMessage.value = `${current.name} is no longer linked to ${user.name}.`;
    } else if (value) {
      const resource = resourceProfiles.value.find((entry) => entry.id === value);
      await apiClient.updateEnterpriseResource(value, { expectedVersion: resource.version, userId: user.id }, authSession.state.token);
      successMessage.value = `${resource.name} is now linked to ${user.name}. Work the profile owned is theirs.`;
    }
    await loadUserManagement();
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to change the resource profile.';
  } finally {
    busy.value = false;
  }
}

async function confirmResourceMerge() {
  resourceLink.busy = true;
  await applyResourceLink(resourceLink.user, resourceLink.resource.id, resourceLink.current);
  resourceLink.busy = false;
  resourceLink.open = false;
}

async function changeRole(email, role) {
  if (!authSession.state.token) return;
  busy.value = true;
  errorMessage.value = '';
  successMessage.value = '';

  try {
    await apiClient.updateTenantUsers(
      { change_role: [{ email, role }] },
      authSession.state.token,
    );
    await loadUserManagement();
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to update role.';
  } finally {
    busy.value = false;
  }
}

async function removeUser(userId) {
  if (!authSession.state.token) return;
  busy.value = true;
  errorMessage.value = '';
  successMessage.value = '';

  try {
    await apiClient.removeTenantExistingUser({ userId }, authSession.state.token);
    await loadUserManagement();
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to remove user.';
  } finally {
    busy.value = false;
  }
}

async function sendInvite() {
  if (!authSession.state.token) return;
  if (!inviteForm.email.trim()) return;

  busy.value = true;
  errorMessage.value = '';
  successMessage.value = '';

  try {
    const result = await apiClient.inviteTenantUser(
      { email: inviteForm.email.trim(), role: inviteForm.role },
      authSession.state.token,
    );
    successMessage.value = result.message ?? 'Invitation email queued.';
    inviteForm.email = '';
    inviteForm.role = 'user';
    await loadUserManagement();
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to send invite.';
    await loadUserManagement();
  } finally {
    busy.value = false;
  }
}

function inviteDeliveryLabel(status) {
  return ({ not_queued: 'Not queued', pending: 'Queued', processing: 'Sending', sent: 'Sent', failed: 'Failed' })[status] ?? 'Unknown';
}
async function resendInvite(invite) {
  busy.value = true;
  errorMessage.value = '';
  successMessage.value = '';
  try {
    const result = await apiClient.resendTenantInvite({ invite_token: invite.invite_token }, authSession.state.token);
    successMessage.value = result.message ?? 'Invitation email queued.';
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to resend the invitation.';
  } finally {
    await loadUserManagement();
    busy.value = false;
  }
}

async function revokeInvite(inviteToken) {
  if (!authSession.state.token) return;
  busy.value = true;
  errorMessage.value = '';
  successMessage.value = '';

  try {
    await apiClient.revokeTenantInvite({ invite_token: inviteToken }, authSession.state.token);
    await loadUserManagement();
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to revoke invite.';
  } finally {
    busy.value = false;
  }
}

async function loadCustomizations() {
  if (!authSession.state.token || !canAdmin.value) return;

  customizationsLoading.value = true;
  errorMessage.value = '';

  try {
    const [statusResult, taskTypeResult] = await Promise.all([
      apiClient.getTenantStatusDefinitions(authSession.state.token),
      apiClient.getTenantTaskTypeDefinitions(authSession.state.token),
    ]);

    statuses.value = statusResult.statuses ?? [];
    taskTypes.value = taskTypeResult.task_types ?? [];
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to load customizations.';
  } finally {
    customizationsLoading.value = false;
  }
}

function nextSortOrder(items) {
  const max = (items ?? []).reduce((acc, item) => Math.max(acc, Number(item.sort_order ?? 0)), 0);
  return max + 10;
}

function addStatus() {
  const name = newStatusName.value.trim();
  if (!name) return;
  statuses.value = [
    ...statuses.value,
    { id: '', is_default: false, name, sort_order: nextSortOrder(statuses.value) },
  ];
  newStatusName.value = '';
}

function removeStatus(index) {
  const item = statuses.value[index];
  if (item?.is_default) return;
  const next = [...statuses.value];
  next.splice(index, 1);
  statuses.value = next;
}

async function saveStatuses() {
  if (!authSession.state.token) return;
  busy.value = true;
  errorMessage.value = '';
  successMessage.value = '';

  try {
    const result = await apiClient.saveTenantStatusDefinitions({ statuses: statuses.value }, authSession.state.token);
    successMessage.value = result.message ?? 'Saved.';
    await loadCustomizations();
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to save statuses.';
  } finally {
    busy.value = false;
  }
}

async function resetStatuses() {
  if (!authSession.state.token) return;
  busy.value = true;
  errorMessage.value = '';
  successMessage.value = '';

  try {
    const result = await apiClient.resetTenantStatusDefinitions(authSession.state.token);
    successMessage.value = result.message ?? 'Reset.';
    await loadCustomizations();
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to reset statuses.';
  } finally {
    busy.value = false;
  }
}

function addTaskType() {
  const name = newTaskTypeName.value.trim();
  if (!name) return;
  taskTypes.value = [
    ...taskTypes.value,
    { id: '', is_default: false, name, sort_order: nextSortOrder(taskTypes.value) },
  ];
  newTaskTypeName.value = '';
}

function removeTaskType(index) {
  const item = taskTypes.value[index];
  if (item?.is_default) return;
  const next = [...taskTypes.value];
  next.splice(index, 1);
  taskTypes.value = next;
}

async function saveTaskTypes() {
  if (!authSession.state.token) return;
  busy.value = true;
  errorMessage.value = '';
  successMessage.value = '';

  try {
    const result = await apiClient.saveTenantTaskTypeDefinitions({ task_types: taskTypes.value }, authSession.state.token);
    successMessage.value = result.message ?? 'Saved.';
    await loadCustomizations();
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to save task types.';
  } finally {
    busy.value = false;
  }
}

async function resetTaskTypes() {
  if (!authSession.state.token) return;
  busy.value = true;
  errorMessage.value = '';
  successMessage.value = '';

  try {
    const result = await apiClient.resetTenantTaskTypeDefinitions(authSession.state.token);
    successMessage.value = result.message ?? 'Reset.';
    await loadCustomizations();
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to reset task types.';
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  if (section.value === 'user-management' && route.query.tab === 'requests') {
    await nextTick();
    const requestsTab = document.getElementById('user-requests-tab');
    if (requestsTab) Tab.getOrCreateInstance(requestsTab).show();
  }
  await loadTenantSettings();
  await loadOpenAiConfig();
  await loadUserManagement();
  await loadCustomizations();
});
</script>

<template>
  <div class="container-fluid" style="padding-bottom: 60px">
    <div class="d-flex" style="align-items: flex-start">
      <div class="sidebar p-3">
        <nav class="nav flex-column">
          <a
            class="nav-link sidebar-link"
            :class="{ active: section === 'tenant-settings' }"
            href="#"
            @click.prevent="section = 'tenant-settings'"
          >
            <i class="bi bi-gear-fill"></i> Tenant Settings
          </a>
          <a
            class="nav-link sidebar-link"
            :class="{ active: section === 'user-management' }"
            href="#"
            @click.prevent="section = 'user-management'"
          >
            <i class="bi bi-people-fill"></i> User Management
          </a>
          <a
            class="nav-link sidebar-link"
            :class="{ active: section === 'customizations' }"
            href="#"
            @click.prevent="section = 'customizations'"
          >
            <i class="bi bi-brush-fill"></i> Customizations
          </a>
          <a
            class="nav-link sidebar-link"
            :class="{ active: section === 'audit-logs' }"
            href="#"
            @click.prevent="section = 'audit-logs'; loadAuditLogs()"
          >
            <i class="bi bi-file-earmark-text"></i> Audit Logs
          </a>
          <a
            class="nav-link sidebar-link"
            :class="{ active: section === 'integrations' }"
            href="#"
            @click.prevent="section = 'integrations'"
          >
            <i class="bi bi-puzzle-fill"></i> Integrations
          </a>
          <a
            class="nav-link sidebar-link"
            :class="{ active: section === 'modules' }"
            href="#"
            @click.prevent="section = 'modules'"
          >
            <i class="bi bi-toggles"></i> Modules
          </a>
          <a
            class="nav-link sidebar-link"
            :class="{ active: section === 'deleted-projects' }"
            href="#"
            @click.prevent="section = 'deleted-projects'"
          >
            <i class="bi bi-trash3"></i> Deleted Projects
          </a>
        </nav>
      </div>

      <div class="main-content flex-grow-1">
        <h3 v-if="section === 'tenant-settings'" class="mb-4"><i class="bi bi-gear-fill me-2"></i> Tenant Settings</h3>
        <h3 v-else-if="section === 'user-management'" class="mb-4"><i class="bi bi-people-fill me-2"></i> User Management</h3>
        <h3 v-else-if="section === 'customizations'" class="mb-4"><i class="bi bi-brush-fill me-2"></i> Customizations</h3>
        <h3 v-else-if="section === 'audit-logs'" class="mb-4"><i class="bi bi-file-earmark-text me-2"></i> Audit Logs</h3>
        <h3 v-else-if="section === 'integrations'" class="mb-4"><i class="bi bi-puzzle-fill me-2"></i> Integrations</h3>
        <h3 v-else-if="section === 'deleted-projects'" class="mb-4"><i class="bi bi-trash3 me-2"></i> Deleted Projects</h3>
        <h3 v-else-if="section === 'modules'" class="mb-4"><i class="bi bi-toggles me-2"></i> Modules</h3>
        <h3 v-else class="mb-4"><i class="bi bi-gear-fill me-2"></i> Tenant Settings</h3>

        <div v-if="errorMessage" class="alert alert-danger">{{ errorMessage }}</div>
        <div v-if="successMessage" class="alert alert-success save-alert">{{ successMessage }}</div>

        <div v-if="section === 'tenant-settings'">
          <div class="card mb-3">
            <div class="card-header">Basic Information</div>
            <div class="card-body">
              <div class="mb-3">
                <label for="tenantName" class="form-label">Tenant Name</label>
                <input id="tenantName" v-model="tenantForm.tenant_name" class="form-control" type="text" />
              </div>

              <div class="mb-3">
                <label class="form-label">Auto-Associated Domains</label>
                <div id="domains-container">
                  <div
                    v-for="(domain, index) in tenantForm.domains"
                    :key="index"
                    class="input-group domain-input-group"
                  >
                    <input v-model="tenantForm.domains[index]" class="form-control form-control-sm" type="text" placeholder="example.com" />
                    <button class="btn btn-sm btn-outline-danger" type="button" @click="removeDomain(index)">Remove</button>
                  </div>
                </div>
                <button class="btn btn-sm btn-outline-primary" type="button" @click="addDomain">Add Domain</button>
              </div>

              <button class="btn btn-primary" type="button" :disabled="busy" @click="saveTenantSettings">
                {{ busy ? 'Saving…' : 'Save Settings' }}
              </button>
            </div>
          </div>

          <div class="card mb-3">
            <div class="card-header">
              Backup and Restore
            </div>
            <div class="card-body">
              <div class="d-flex flex-wrap align-items-center gap-2">
                <button class="btn btn-sm btn-secondary" type="button" :disabled="backupBusy" @click="triggerTenantBackup">
                  <i class="bi bi-download"></i> {{ backupBusy ? 'Working…' : 'Trigger Backup' }}
                </button>

                <button class="btn btn-sm btn-outline-primary" type="button" :disabled="restoreBusy" @click="triggerRestorePick">
                  <i class="bi bi-upload"></i> Choose Backup File
                </button>

                <span class="text-muted small" style="max-width: 28rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                  {{ restoreFilename || 'No backup selected' }}
                </span>

                <button
                  class="btn btn-sm btn-warning"
                  type="button"
                  :disabled="restoreBusy || !restoreBase64"
                  @click="restoreTenantFromBackup"
                >
                  <i class="bi bi-arrow-clockwise"></i> {{ restoreBusy ? 'Restoring…' : 'Restore from Backup' }}
                </button>
              </div>

              <input ref="restoreFileInput" accept=".odin" hidden type="file" @change="handleRestoreFileSelected" />
            </div>
          </div>
        </div>

        <div v-else-if="section === 'user-management'">
          <div class="card mb-3">
            <div class="card-header">User Management</div>
            <div class="card-body">
              <ul class="nav nav-tabs" role="tablist">
                <li class="nav-item" role="presentation">
                  <button class="nav-link active" data-bs-toggle="tab" data-bs-target="#existing-users" type="button" role="tab">Existing Users</button>
                </li>
                <li class="nav-item" role="presentation">
                  <button id="user-requests-tab" class="nav-link" data-bs-toggle="tab" data-bs-target="#user-requests" type="button" role="tab">
                    Requests to Join
                    <span class="badge bg-warning text-dark ms-1">{{ joinRequestCount }}<span class="visually-hidden"> waiting</span></span>
                  </button>
                </li>
                <li class="nav-item" role="presentation">
                  <button class="nav-link" data-bs-toggle="tab" data-bs-target="#invites" type="button" role="tab">Invites</button>
                </li>
              </ul>

              <div class="tab-content p-3 border border-top-0">
                <div id="existing-users" class="tab-pane fade show active" role="tabpanel">
                  <div v-if="userMgmtLoading" class="d-flex justify-content-center py-3">
                    <div class="spinner-border spinner-border-sm" role="status" aria-label="Loading"></div>
                  </div>

                  <div v-else class="table-responsive">
                    <table class="table table-sm align-middle table-hover">
                      <thead class="table-light">
                        <tr>
                          <th>User</th>
                          <th>Email</th>
                          <th>Role</th>
                          <th>Resource profile</th>
                          <th>Auth</th>
                          <th>2FA</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="user in existingUsers" :key="user.id">
                          <td class="fw-semibold">{{ user.name }}</td>
                          <td>{{ user.email }}</td>
                          <td style="max-width: 11rem">
                            <select
                              class="form-select form-select-sm"
                              :value="user.role"
                              :disabled="busy"
                              @change="changeRole(user.email, $event.target.value)"
                            >
                              <option value="user">user</option>
                              <option value="manager">manager</option>
                              <option value="admin">admin</option>
                            </select>
                          </td>
                          <td style="min-width: 13rem">
                            <div class="d-flex align-items-center gap-1">
                              <select
                                class="form-select form-select-sm"
                                :aria-label="`Resource profile for ${user.name}`"
                                :value="resourceByUser.get(user.id)?.id ?? ''"
                                :disabled="busy"
                                @change="changeResourceLink(user, $event.target.value, $event.target)"
                              >
                                <option value="">No profile</option>
                                <option v-for="resource in linkableResources(user.id)" :key="resource.id" :value="resource.id">
                                  {{ resource.name }}{{ resource.userId ? '' : ' (unlinked)' }}
                                </option>
                                <option v-if="!resourceByUser.get(user.id)" value="__new">Create a profile for {{ user.name }}</option>
                              </select>
                              <RouterLink
                                v-if="resourceByUser.get(user.id)"
                                class="btn btn-sm btn-outline-secondary"
                                :to="{ name: 'resources', query: { resource: resourceByUser.get(user.id).id } }"
                                :aria-label="`Edit ${user.name}'s resource profile`"
                              ><i class="bi bi-pencil" aria-hidden="true"></i></RouterLink>
                            </div>
                          </td>
                          <td>{{ user.authMethod }}</td>
                          <td>
                            <span class="badge" :class="user.twoFA ? 'bg-success' : 'bg-secondary'">
                              {{ user.twoFA ? 'On' : 'Off' }}
                            </span>
                          </td>
                          <td class="text-end">
                            <button class="btn btn-sm btn-outline-danger" type="button" :disabled="busy" @click="removeUser(user.id)">
                              Remove
                            </button>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>

                <div id="user-requests" class="tab-pane fade" role="tabpanel" aria-labelledby="user-requests-tab">
                  <WorkspaceJoinRequestsPanel @count="joinRequestCount = $event" />
                </div>

                <div id="invites" class="tab-pane fade" role="tabpanel">
                  <form class="row g-2 align-items-end" @submit.prevent="sendInvite">
                    <div class="col-md-6">
                      <label for="invite-email" class="form-label">Invite Email</label>
                      <input id="invite-email" v-model="inviteForm.email" class="form-control form-control-sm" type="email" />
                    </div>
                    <div class="col-md-3">
                      <label for="invite-role" class="form-label">Role</label>
                      <select id="invite-role" v-model="inviteForm.role" class="form-select form-select-sm">
                        <option value="user">user</option>
                        <option value="manager">manager</option>
                        <option value="admin">admin</option>
                      </select>
                    </div>
                    <div class="col-md-3">
                      <button class="btn btn-sm btn-primary w-100" type="submit" :disabled="busy || !inviteForm.email.trim()">
                        Send Invite
                      </button>
                    </div>
                  </form>

                  <div v-if="userMgmtLoading" class="d-flex justify-content-center py-3">
                    <div class="spinner-border spinner-border-sm" role="status" aria-label="Loading"></div>
                  </div>

                  <div v-else class="table-responsive mt-3">
                    <table class="table table-sm align-middle table-hover">
                      <thead class="table-light">
                        <tr>
                          <th>Email</th>
                          <th>Role</th>
                          <th>Invited</th>
                          <th>Status</th>
                          <th>Email</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="invite in invites" :key="invite.invite_token">
                          <td>{{ invite.email }}</td>
                          <td>{{ invite.role }}</td>
                          <td>{{ invite.sentOn }}</td>
                          <td>{{ invite.status }}</td>
                          <td>{{ inviteDeliveryLabel(invite.deliveryStatus) }}</td>
                          <td class="text-end">
                            <button v-if="invite.status !== 'Accepted'" class="btn btn-sm btn-outline-primary me-2" type="button" :disabled="busy" @click="resendInvite(invite)">Resend</button>
                            <button v-if="invite.status !== 'Accepted'" class="btn btn-sm btn-outline-danger" type="button" :disabled="busy" @click="revokeInvite(invite.invite_token)">
                              Revoke
                            </button>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div v-else-if="section === 'customizations'">
          <div class="row">
            <div class="col-md-6 mb-3">
              <div class="card">
                <div class="card-header">Project Status Definitions</div>
                <div class="card-body">
                  <div v-if="customizationsLoading" class="d-flex justify-content-center py-3">
                    <div class="spinner-border spinner-border-sm" role="status" aria-label="Loading"></div>
                  </div>

                  <ul v-else class="list-group mb-3">
                    <li
                      v-for="(status, index) in statuses"
                      :key="`${status.id || 'new'}:${index}`"
                      class="list-group-item d-flex align-items-center gap-2"
                    >
                      <input
                        v-model="statuses[index].name"
                        class="form-control form-control-sm"
                        type="text"
                        :disabled="status.is_default || busy"
                      />
                      <input
                        v-model.number="statuses[index].sort_order"
                        class="form-control form-control-sm"
                        type="number"
                        style="width: 6.5rem"
                        :disabled="status.is_default || busy"
                      />
                      <button
                        class="btn btn-sm btn-outline-danger"
                        type="button"
                        :disabled="status.is_default || busy"
                        @click="removeStatus(index)"
                      >
                        Remove
                      </button>
                    </li>
                  </ul>

                  <div class="input-group mb-3">
                    <input v-model="newStatusName" class="form-control form-control-sm" type="text" placeholder="New Status Name" />
                    <button class="btn btn-sm btn-outline-primary" type="button" :disabled="busy || !newStatusName.trim()" @click="addStatus">Add</button>
                  </div>

                  <button class="btn btn-secondary btn-sm me-2" type="button" :disabled="busy" @click="resetStatuses">Reset to Defaults</button>
                  <button class="btn btn-primary btn-sm" type="button" :disabled="busy" @click="saveStatuses">Save Statuses</button>
                </div>
              </div>
            </div>

            <div class="col-md-6 mb-3">
              <div class="card">
                <div class="card-header">Task Type Definitions</div>
                <div class="card-body">
                  <div v-if="customizationsLoading" class="d-flex justify-content-center py-3">
                    <div class="spinner-border spinner-border-sm" role="status" aria-label="Loading"></div>
                  </div>

                  <ul v-else class="list-group mb-3">
                    <li
                      v-for="(type, index) in taskTypes"
                      :key="`${type.id || 'new'}:${index}`"
                      class="list-group-item d-flex align-items-center gap-2"
                    >
                      <input
                        v-model="taskTypes[index].name"
                        class="form-control form-control-sm"
                        type="text"
                        :disabled="type.is_default || busy"
                      />
                      <input
                        v-model.number="taskTypes[index].sort_order"
                        class="form-control form-control-sm"
                        type="number"
                        style="width: 6.5rem"
                        :disabled="type.is_default || busy"
                      />
                      <button
                        class="btn btn-sm btn-outline-danger"
                        type="button"
                        :disabled="type.is_default || busy"
                        @click="removeTaskType(index)"
                      >
                        Remove
                      </button>
                    </li>
                  </ul>

                  <div class="input-group mb-3">
                    <input v-model="newTaskTypeName" class="form-control form-control-sm" type="text" placeholder="New Task Type" />
                    <button class="btn btn-sm btn-outline-primary" type="button" :disabled="busy || !newTaskTypeName.trim()" @click="addTaskType">Add</button>
                  </div>

                  <button class="btn btn-secondary btn-sm me-2" type="button" :disabled="busy" @click="resetTaskTypes">Reset to Defaults</button>
                  <button class="btn btn-primary btn-sm" type="button" :disabled="busy" @click="saveTaskTypes">Save Task Types</button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div v-else-if="section === 'audit-logs'">
          <div class="card mb-3">
            <div class="card-header">
              Audit Logs
            </div>
            <div class="card-body">
              <div class="row g-2 align-items-end mb-3">
                <div class="col-sm-6 col-md-3">
                  <label class="form-label">Start date</label>
                  <input v-model="auditStartDate" class="form-control form-control-sm" type="date" :disabled="auditLoading || auditExporting" />
                </div>
                <div class="col-sm-6 col-md-3">
                  <label class="form-label">End date</label>
                  <input v-model="auditEndDate" class="form-control form-control-sm" type="date" :disabled="auditLoading || auditExporting" />
                </div>
                <div class="col-md-6">
                  <label class="form-label">Search</label>
                  <input v-model="auditSearchText" class="form-control form-control-sm" type="text" placeholder="Search audit log entries..." :disabled="auditLoading || auditExporting" />
                </div>
              </div>

              <div class="d-flex flex-wrap gap-2 mb-3">
                <button class="btn btn-sm btn-outline-primary" type="button" :disabled="auditLoading" @click="loadAuditLogs">
                  <i class="bi bi-arrow-repeat"></i> {{ auditLoading ? 'Loading…' : 'Load Logs' }}
                </button>
                <button class="btn btn-sm btn-secondary" type="button" :disabled="auditExporting" @click="exportAuditLogs">
                  <i class="bi bi-download"></i> {{ auditExporting ? 'Exporting…' : 'Export XLSX' }}
                </button>
              </div>

              <div class="table-responsive">
                <table class="table table-sm align-middle table-hover">
                  <thead class="table-light">
                    <tr>
                      <th style="min-width: 10.5rem;">Date/Time</th>
                      <th style="min-width: 10rem;">User</th>
                      <th style="min-width: 10rem;">Project</th>
                      <th style="min-width: 12rem;">Action</th>
                      <th style="min-width: 7rem;">Result</th>
                      <th style="min-width: 16rem;">Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-if="auditLoading">
                      <td colspan="6" class="text-muted">Loading…</td>
                    </tr>
                    <tr v-else-if="!filteredAuditLogs.length">
                      <td colspan="6" class="text-muted">No results.</td>
                    </tr>
                    <tr v-for="log in filteredAuditLogs" :key="`${log.dt_stamp}-${log.user_id}-${log.action}`">
                      <td>{{ log.date_time }}</td>
                      <td>{{ log.user_full_name }}</td>
                      <td>{{ log.project_name || 'n/a' }}</td>
                      <td>{{ log.action }}</td>
                      <td>{{ log.result }}</td>
                      <td>{{ log.detail }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        <DeletedProjectsPanel v-else-if="section === 'deleted-projects'" />

        <WorkspaceModulesPanel v-else-if="section === 'modules'" />

        <div v-else-if="section === 'integrations'">
          <div class="card mb-3">
            <div class="card-header">
              AI Integrations
            </div>
            <div class="card-body">
              <div class="d-flex flex-wrap justify-content-between align-items-start gap-3 mb-4">
                <div>
                  <h5 class="mb-1">Model Configuration</h5>
                  <p class="text-muted mb-0">
                    The AI Workspace now runs as a single planning agent. Most tenants only need the workspace runtime settings below.
                  </p>
                </div>
                <span class="badge" :class="openAiConfig.valid_config ? 'text-bg-success' : 'text-bg-secondary'">
                  {{ openAiConfig.valid_config ? 'Configured' : 'Not validated' }}
                </span>
              </div>

              <div class="ai-config-toolbar mb-4">
                <div class="ai-config-toolbar__key">
                  <label for="openAIKey" class="form-label">OpenAI API Key</label>
                  <input id="openAIKey" v-model="openAiConfig.openai_key" class="form-control form-control-sm" type="text" placeholder="sk-..." />
                </div>
                <div class="ai-config-toolbar__actions">
                  <button class="btn btn-sm btn-outline-primary" type="button" :disabled="openAiBusy || !openAiConfig.openai_key" @click="fetchModels">
                    <i class="bi bi-cloud-arrow-down"></i> Fetch Models
                  </button>
                </div>
              </div>
              <p class="text-muted small mb-4">{{ openAiCatalogNote }}</p>

              <section class="ai-config-group mb-4">
                <div class="ai-config-group__header">
                  <div>
                    <h6 class="mb-1">AI Workspace Runtime</h6>
                    <p class="text-muted small mb-0">
                      The model behind the AI Workspace assistant.
                    </p>
                  </div>
                </div>

                <div class="row g-3">
                  <div v-for="capability in aiWorkspaceCapabilityDefinitions" :key="capability.id" class="col-12 col-xxl-6">
                    <article class="ai-capability-card h-100">
                      <div class="d-flex justify-content-between align-items-start gap-3 mb-3">
                        <div>
                          <h6 class="mb-1">{{ capability.label }}</h6>
                          <p class="text-muted small mb-0">{{ capability.description }}</p>
                        </div>
                        <span class="badge text-bg-light border">{{ capability.id }}</span>
                      </div>

                      <div class="row g-2">
                        <div class="col-md-7">
                          <label class="form-label fw-bold" :for="`${capability.id}-model`">Model</label>
                          <select
                            :id="`${capability.id}-model`"
                            v-model="openAiConfig.capabilities[capability.id].model"
                            class="form-select form-select-sm"
                          >
                            <option value=""></option>
                            <option v-for="model in openAiConfig.available_models" :key="model" :value="model">{{ model }}</option>
                          </select>
                        </div>

                        <div v-if="capability.modelOnly" class="col-md-5">
                          <p class="form-label fw-bold mb-1">Reasoning</p>
                          <p class="text-muted small mb-0">High for simple questions, max otherwise. Set on the server.</p>
                        </div>
                        <div v-else class="col-md-5">
                          <label class="form-label fw-bold" :for="`${capability.id}-reasoning`">Reasoning</label>
                          <select
                            :id="`${capability.id}-reasoning`"
                            v-model="openAiConfig.capabilities[capability.id].reasoningEffort"
                            class="form-select form-select-sm"
                          >
                            <option v-for="effort in aiReasoningEfforts" :key="effort" :value="effort">{{ effort }}</option>
                          </select>
                        </div>
                      </div>

                      <div v-if="!capability.modelOnly" class="mt-3">
                        <label class="form-label fw-bold d-block mb-2">Allowed tools</label>
                        <div class="d-flex flex-wrap gap-2">
                          <label
                            v-for="toolId in capability.tools"
                            :key="`${capability.id}-${toolId}`"
                            class="btn btn-sm btn-outline-secondary ai-capability-card__tool"
                            :class="{ active: openAiConfig.capabilities[capability.id].enabledTools.includes(toolId) }"
                          >
                            <input
                              class="form-check-input mt-0"
                              type="checkbox"
                              :checked="openAiConfig.capabilities[capability.id].enabledTools.includes(toolId)"
                              @change="toggleCapabilityTool(capability.id, toolId, $event.target.checked)"
                            />
                            {{ aiToolLabels[toolId] ?? toolId }}
                          </label>
                        </div>
                      </div>
                    </article>
                  </div>
                </div>
              </section>

              <details class="ai-config-group ai-config-group--advanced">
                <summary class="ai-config-group__summary">
                  <div>
                    <h6 class="mb-1">Advanced Project Helper Models</h6>
                    <p class="text-muted small mb-0">
                      Models for the project editor’s AI actions and for requirements questions, summaries and plans. The assistant doesn’t use them.
                    </p>
                  </div>
                  <span class="badge text-bg-light border">Optional</span>
                </summary>

                <div class="row g-3 mt-1">
                  <div v-for="capability in aiProjectHelperCapabilityDefinitions" :key="capability.id" class="col-12 col-xxl-6">
                    <article class="ai-capability-card h-100">
                      <div class="d-flex justify-content-between align-items-start gap-3 mb-3">
                        <div>
                          <h6 class="mb-1">{{ capability.label }}</h6>
                          <p class="text-muted small mb-0">{{ capability.description }}</p>
                        </div>
                        <span class="badge text-bg-light border">{{ capability.id }}</span>
                      </div>

                      <div class="row g-2">
                        <div class="col-md-7">
                          <label class="form-label fw-bold" :for="`${capability.id}-model`">Model</label>
                          <select
                            :id="`${capability.id}-model`"
                            v-model="openAiConfig.capabilities[capability.id].model"
                            class="form-select form-select-sm"
                          >
                            <option value=""></option>
                            <option v-for="model in openAiConfig.available_models" :key="model" :value="model">{{ model }}</option>
                          </select>
                        </div>

                        <div class="col-md-5">
                          <label class="form-label fw-bold" :for="`${capability.id}-reasoning`">Reasoning</label>
                          <select
                            :id="`${capability.id}-reasoning`"
                            v-model="openAiConfig.capabilities[capability.id].reasoningEffort"
                            class="form-select form-select-sm"
                          >
                            <option v-for="effort in aiReasoningEfforts" :key="effort" :value="effort">{{ effort }}</option>
                          </select>
                        </div>
                      </div>

                      <div class="mt-3">
                        <label class="form-label fw-bold d-block mb-2">Allowed tools</label>
                        <div class="d-flex flex-wrap gap-2">
                          <label
                            v-for="toolId in capability.tools"
                            :key="`${capability.id}-${toolId}`"
                            class="btn btn-sm btn-outline-secondary ai-capability-card__tool"
                            :class="{ active: openAiConfig.capabilities[capability.id].enabledTools.includes(toolId) }"
                          >
                            <input
                              class="form-check-input mt-0"
                              type="checkbox"
                              :checked="openAiConfig.capabilities[capability.id].enabledTools.includes(toolId)"
                              @change="toggleCapabilityTool(capability.id, toolId, $event.target.checked)"
                            />
                            {{ aiToolLabels[toolId] ?? toolId }}
                          </label>
                        </div>
                      </div>
                    </article>
                  </div>
                </div>
              </details>

              <div class="mt-4">
                <button class="btn btn-sm btn-primary" type="button" :disabled="openAiBusy" @click="saveOpenAiConfig">
                  <i class="bi bi-save"></i> Save AI Settings
                </button>
                <button class="btn btn-sm btn-outline-danger ms-2" type="button" :disabled="openAiBusy" @click="resetOpenAiConfig">
                  <i class="bi bi-trash"></i> Reset to Defaults
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <RequirementsConfirmDialog
    :busy="resourceLink.busy"
    confirm-label="Link and merge"
    :open="resourceLink.open"
    :title="`Link ${resourceLink.resource?.name ?? ''} to ${resourceLink.user?.name ?? ''}?`"
    @close="resourceLink.open = false"
    @confirm="confirmResourceMerge"
  >
    <p class="mb-0">
      {{ resourceLink.user?.name }} already has the profile “{{ resourceLink.current?.name }}”. Linking
      “{{ resourceLink.resource?.name }}” merges them: allocations, time off, time and rate history move to
      “{{ resourceLink.resource?.name }}”, and “{{ resourceLink.current?.name }}” is removed. Work either profile owned becomes theirs.
    </p>
  </RequirementsConfirmDialog>
</template>

<style scoped src="../assets/legacy/tenants.css"></style>
<style scoped>
.ai-config-toolbar {
  align-items: end;
  display: grid;
  gap: 0.9rem;
  grid-template-columns: minmax(0, 1fr) auto;
}

.ai-config-toolbar__key {
  min-width: 0;
}

.ai-config-group {
  background: var(--surface-soft);
  border: 1px solid var(--line);
  border-radius: 1rem;
  padding: 1rem;
}

.ai-config-group__header {
  margin-bottom: 1rem;
}

.ai-config-group--advanced {
  background: var(--surface);
}

.ai-config-group__summary {
  align-items: start;
  cursor: pointer;
  display: flex;
  gap: 1rem;
  justify-content: space-between;
  list-style: none;
}

.ai-config-group__summary::-webkit-details-marker {
  display: none;
}

.ai-config-group__summary::after {
  color: var(--muted);
  content: '\F282';
  font-family: bootstrap-icons;
  font-size: 0.95rem;
  line-height: 1;
  margin-top: 0.2rem;
  transition: transform 0.18s ease;
}

.ai-config-group--advanced[open] .ai-config-group__summary::after {
  transform: rotate(180deg);
}

.ai-capability-card {
  padding: 1rem;
  border: 1px solid var(--line);
  border-radius: 0.95rem;
  background: var(--surface);
}

.ai-capability-card__tool {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
}

@media (max-width: 767.98px) {
  .ai-config-toolbar {
    grid-template-columns: 1fr;
  }
}
</style>
