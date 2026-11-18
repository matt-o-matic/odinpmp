<script setup>
import { computed, nextTick, onMounted, reactive, ref } from 'vue';

import { apiClient, authSession } from '../../lib/auth/index.js';

const emptyWorkspace = () => ({ catalog: [], conflicts: [], connections: [], events: [], health: [], mappings: [], runs: [] });
const workspace = ref(emptyWorkspace());
const loading = ref(true);
const errorMessage = ref('');
const query = ref('');
const dialog = ref(null);
const editor = reactive({ kind: '', values: {} });
const oneTimeSecret = ref('');
const token = computed(() => authSession.state.token);
const catalogMap = computed(() => new Map(workspace.value.catalog.map((item) => [item.key, item])));
const healthMap = computed(() => new Map(workspace.value.health.map((item) => [item.connectionId, item])));
const filteredConnections = computed(() => {
  const needle = query.value.trim().toLowerCase();
  if (!needle) return workspace.value.connections;
  return workspace.value.connections.filter((item) => JSON.stringify(item).toLowerCase().includes(needle));
});

function csv(value) {
  return String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

function dateTime(value) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
}

async function load() {
  loading.value = true;
  errorMessage.value = '';
  try {
    workspace.value = await apiClient.getConnectorWorkspace({ limit: 200 }, token.value);
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to load connectors.';
  } finally {
    loading.value = false;
  }
}

async function openEditor(kind, connection = null) {
  editor.kind = kind;
  oneTimeSecret.value = '';
  if (kind === 'connection') {
    editor.values = {
      authType: 'webhook',
      conflictPolicy: 'manual',
      name: '',
      projectIdsText: '',
      provider: workspace.value.catalog[0]?.key ?? 'jira',
      scopesText: '',
      secretReference: '',
      status: 'draft',
      syncDirection: 'bidirectional',
    };
  } else {
    editor.values = {
      connectionId: connection?.id ?? workspace.value.connections[0]?.id ?? '',
      externalId: '',
      objectType: 'issue',
      odinId: '',
      projectId: connection?.projectIds?.[0] ?? '',
    };
  }
  await nextTick();
  dialog.value?.showModal();
}

function closeEditor() {
  dialog.value?.close();
}

async function saveEditor() {
  errorMessage.value = '';
  try {
    if (editor.kind === 'connection') {
      const value = editor.values;
      const result = await apiClient.createConnectorConnection({
        authType: value.authType,
        conflictPolicy: value.conflictPolicy,
        name: value.name,
        projectIds: csv(value.projectIdsText),
        provider: value.provider,
        scopes: csv(value.scopesText),
        secretReference: value.secretReference,
        status: value.status,
        syncDirection: value.syncDirection,
      }, token.value);
      oneTimeSecret.value = result.inboundSecret;
    } else {
      await apiClient.createConnectorMapping({ ...editor.values }, token.value);
    }
    await load();
    if (!oneTimeSecret.value) closeEditor();
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to save connector configuration.';
  }
}

async function toggleConnection(item) {
  try {
    await apiClient.updateConnectorConnection(item.id, {
      expectedVersion: item.version,
      status: item.status === 'active' ? 'paused' : 'active',
    }, token.value);
    await load();
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to update connector.';
  }
}

async function syncConnection(item) {
  try {
    await apiClient.createConnectorSyncRun(item.id, {
      direction: item.syncDirection === 'outbound' ? 'outbound' : 'inbound',
      idempotencyKey: `${item.id}:${new Date().toISOString()}`,
    }, token.value);
    await load();
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to queue connector sync.';
  }
}

async function resolveConflict(item, resolution) {
  try {
    await apiClient.resolveConnectorConflict(item.id, {
      expectedVersion: item.version,
      note: `Resolved from the connector administration workspace using ${resolution}.`,
      resolution,
    }, token.value);
    await load();
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to resolve connector conflict.';
  }
}

async function applyEvent(item) {
  try { await apiClient.applyConnectorEvent(item.id, item.version, token.value); await load(); }
  catch (error) { errorMessage.value = error.message ?? 'Unable to apply connector event.'; }
}

onMounted(load);
</script>

<template>
  <section class="connector-panel" aria-labelledby="connector-title">
    <div class="connector-heading">
      <div>
        <h2 id="connector-title">Enterprise connectors</h2>
        <p>Govern credentials, project scope, mappings, conflicts, inbound events, and sync health.</p>
      </div>
      <div class="connector-actions">
        <button class="btn btn-sm btn-outline-secondary" type="button" @click="load">Refresh</button>
        <button class="btn btn-sm btn-primary" type="button" @click="openEditor('connection')">Add connector</button>
      </div>
    </div>
    <div v-if="errorMessage" class="alert alert-danger" role="alert">{{ errorMessage }}</div>
    <p v-if="loading" role="status">Loading enterprise connectors…</p>
    <template v-else>
      <div class="catalog" aria-label="Available connector providers">
        <span v-for="provider in workspace.catalog" :key="provider.key" :title="provider.capabilities.join(', ')">{{ provider.name }}</span>
      </div>
      <label class="connector-search">Search connectors<input v-model="query" type="search" placeholder="Provider, project, scope, or name" /></label>
      <div class="table-responsive" role="region" aria-label="Connector connections table" tabindex="0">
        <table>
          <thead><tr><th>Name</th><th>Provider</th><th>Projects</th><th>Direction</th><th>Health</th><th>Activity</th><th>Actions</th></tr></thead>
          <tbody>
            <tr v-for="item in filteredConnections" :key="item.id">
              <td><strong>{{ item.name }}</strong><small>{{ item.authType }} · {{ item.conflictPolicy }}</small></td>
              <td>{{ catalogMap.get(item.provider)?.name ?? item.provider }}</td>
              <td>{{ item.projectIds.join(', ') || 'Tenant-wide' }}</td>
              <td>{{ item.syncDirection }}</td>
              <td><span class="connector-status">{{ healthMap.get(item.id)?.status ?? item.status }}</span></td>
              <td>{{ healthMap.get(item.id)?.pending ?? 0 }} pending · {{ healthMap.get(item.id)?.failures ?? 0 }} failed</td>
              <td><div class="connector-actions"><button class="btn btn-sm btn-outline-secondary" type="button" @click="syncConnection(item)">Queue sync</button><button class="btn btn-sm btn-outline-secondary" type="button" @click="openEditor('mapping', item)">Add mapping</button><button class="btn btn-sm btn-outline-secondary" type="button" @click="toggleConnection(item)">{{ item.status === 'active' ? 'Pause' : 'Activate' }}</button></div></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="!filteredConnections.length" class="connector-empty">No connectors match this search.</p>

      <div class="connector-details">
        <section aria-labelledby="connector-mappings-title"><h3 id="connector-mappings-title">Mappings <span>{{ workspace.mappings.length }}</span></h3><ul><li v-for="item in workspace.mappings" :key="item.id"><code>{{ item.objectType }}:{{ item.externalId }}</code><span aria-hidden="true">→</span><code>{{ item.odinId }}</code><small>{{ item.projectId }}</small></li></ul><p v-if="!workspace.mappings.length">No object mappings.</p></section>
        <section aria-labelledby="connector-conflicts-title"><h3 id="connector-conflicts-title">Open conflicts <span>{{ workspace.conflicts.filter((item) => item.status === 'open').length }}</span></h3><div v-for="item in workspace.conflicts.filter((record) => record.status === 'open')" :key="item.id" class="conflict"><strong>{{ item.objectType }}</strong><p>{{ item.note || 'Both systems changed this object.' }}</p><div class="connector-actions"><button class="btn btn-sm btn-outline-secondary" type="button" @click="resolveConflict(item, 'source_wins')">Keep source</button><button class="btn btn-sm btn-outline-secondary" type="button" @click="resolveConflict(item, 'odin_wins')">Keep Odin</button></div></div><p v-if="!workspace.conflicts.some((item) => item.status === 'open')">No unresolved conflicts.</p></section>
        <section aria-labelledby="connector-activity-title"><h3 id="connector-activity-title">Recent activity <span>{{ workspace.events.length + workspace.runs.length }}</span></h3><ul><li v-for="item in [...workspace.events, ...workspace.runs].slice(-10).reverse()" :key="item.id"><span class="connector-status">{{ item.status }}</span><code>{{ item.eventType ?? item.direction }}</code><small>{{ dateTime(item.updatedAt) }}</small><button v-if="item.status === 'pending' && item.payload?.kind === 'journal_entry'" class="btn btn-sm btn-outline-primary" type="button" @click="applyEvent(item)">Review into draft ledger</button></li></ul><p v-if="!workspace.events.length && !workspace.runs.length">No inbound events or sync runs.</p></section>
      </div>
    </template>

    <dialog ref="dialog" aria-labelledby="connector-editor-title" @cancel.prevent="closeEditor">
      <form @submit.prevent="saveEditor">
        <header><h2 id="connector-editor-title">{{ oneTimeSecret ? 'Copy inbound secret now' : editor.kind === 'connection' ? 'Add connector' : 'Add object mapping' }}</h2><button class="connector-close" aria-label="Close connector editor" type="button" @click="closeEditor"><i class="bi bi-x-lg" aria-hidden="true"></i></button></header>
        <div v-if="oneTimeSecret" class="connector-secret"><strong>Shown once</strong><code>{{ oneTimeSecret }}</code><p>Store this value in an approved secrets manager. It cannot be retrieved again.</p></div>
        <template v-else-if="editor.kind === 'connection'">
          <label>Name<input v-model.trim="editor.values.name" required maxlength="160" /></label>
          <label>Provider<select v-model="editor.values.provider"><option v-for="provider in workspace.catalog" :key="provider.key" :value="provider.key">{{ provider.name }}</option></select></label>
          <div class="connector-form-grid"><label>Authentication<select v-model="editor.values.authType"><option value="oauth2">OAuth 2.0</option><option value="pat">Personal access token</option><option value="webhook">Webhook</option></select></label><label>Status<select v-model="editor.values.status"><option value="draft">Draft</option><option value="active">Active</option><option value="paused">Paused</option></select></label></div>
          <div class="connector-form-grid"><label>Sync direction<select v-model="editor.values.syncDirection"><option value="bidirectional">Bidirectional</option><option value="inbound">Inbound</option><option value="outbound">Outbound</option></select></label><label>Conflict policy<select v-model="editor.values.conflictPolicy"><option value="manual">Manual review</option><option value="odin_wins">Odin wins</option><option value="source_wins">Source wins</option></select></label></div>
          <label>Project IDs <small>Comma separated</small><textarea v-model="editor.values.projectIdsText" rows="2"></textarea></label>
          <label>Scopes <small>Comma separated</small><input v-model="editor.values.scopesText" /></label>
          <label>Credential reference <small>Store the secret outside Odin</small><input v-model.trim="editor.values.secretReference" placeholder="vault://connectors/provider" /></label>
        </template>
        <template v-else>
          <label>Connection<select v-model="editor.values.connectionId" required><option v-for="item in workspace.connections" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
          <label>Project ID<input v-model.trim="editor.values.projectId" required maxlength="128" /></label>
          <label>Object type<input v-model.trim="editor.values.objectType" required maxlength="120" /></label>
          <label>External ID<input v-model.trim="editor.values.externalId" required maxlength="255" /></label>
          <label>Odin ID<input v-model.trim="editor.values.odinId" required maxlength="255" /></label>
        </template>
        <footer><button class="btn btn-sm btn-outline-secondary" type="button" @click="closeEditor">Close</button><button v-if="!oneTimeSecret" class="btn btn-sm btn-primary" type="submit">Save</button></footer>
      </form>
    </dialog>
  </section>
</template>

<style scoped>
.connector-panel{border:1px solid var(--bs-border-color);border-radius:.5rem;padding:.75rem}.connector-heading,.connector-actions,.connector-panel dialog header,.connector-panel dialog footer{display:flex;align-items:center;justify-content:space-between;gap:.75rem}.connector-heading{margin-bottom:.75rem}.connector-heading h2{margin:0}.connector-heading p,.connector-panel section p{margin:.25rem 0;color:var(--bs-secondary-color)}.connector-actions{justify-content:flex-start;flex-wrap:wrap}.catalog{display:flex;gap:.375rem;overflow:auto;padding-bottom:.5rem}.catalog span,.connector-status{display:inline-flex;align-items:center;white-space:nowrap;border:1px solid var(--bs-border-color);border-radius:999px;padding:.2rem .5rem}.connector-search,.connector-panel dialog label{display:grid;gap:.25rem;font-weight:600}.connector-search{margin:.25rem 0 .75rem}.connector-search input,.connector-panel dialog input,.connector-panel dialog select,.connector-panel dialog textarea{min-height:2.75rem;border:1px solid var(--bs-border-color);border-radius:.375rem;padding:.5rem;background:var(--bs-body-bg);color:var(--bs-body-color)}.table-responsive{overflow-x:auto}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:.5rem .75rem;border-bottom:1px solid var(--bs-border-color);vertical-align:middle}th{white-space:nowrap}td small{display:block;color:var(--bs-secondary-color);margin-top:.2rem}.connector-empty{text-align:center;padding:1rem}.connector-details{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.75rem;margin-top:.75rem}.connector-details>section{min-width:0;background:var(--bs-tertiary-bg);border-radius:.5rem;padding:.75rem}.connector-details h3{font-size:1rem;display:flex;justify-content:space-between}.connector-details ul{list-style:none;padding:0;margin:.5rem 0 0;display:grid;gap:.5rem}.connector-details li{display:flex;align-items:center;gap:.4rem;flex-wrap:wrap}.connector-details code{overflow-wrap:anywhere}.connector-details small{width:100%;color:var(--bs-secondary-color)}.conflict{padding:.5rem 0;border-bottom:1px solid var(--bs-border-color)}.connector-panel dialog{width:min(42rem,calc(100vw - 2rem));border:1px solid var(--bs-border-color);border-radius:.625rem;padding:0;background:var(--bs-body-bg);color:var(--bs-body-color)}.connector-panel dialog::backdrop{background:rgba(0,0,0,.55)}.connector-panel dialog form{display:grid;gap:.75rem;padding:1rem}.connector-panel dialog header{border-bottom:1px solid var(--bs-border-color);padding-bottom:.75rem}.connector-panel dialog footer{justify-content:flex-end;border-top:1px solid var(--bs-border-color);padding-top:.75rem}.connector-close{width:2.75rem;height:2.75rem;border:0;background:transparent;color:inherit}.connector-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:.75rem}.connector-secret{display:grid;gap:.5rem}.connector-secret code{padding:.75rem;background:var(--bs-tertiary-bg);border-radius:.375rem;overflow-wrap:anywhere;user-select:all}.btn,.connector-close{min-height:2.75rem}:focus-visible{outline:3px solid color-mix(in srgb,var(--bs-primary) 65%,transparent);outline-offset:2px}@media(max-width:64rem){.connector-details{grid-template-columns:1fr}}@media(max-width:42rem){.connector-heading{align-items:flex-start}.connector-form-grid{grid-template-columns:1fr}th,td{min-width:8rem;padding:.5rem}}
.connector-details code{color:var(--bs-body-color);font-weight:600}
</style>
