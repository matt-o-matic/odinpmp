<script setup>
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { apiClient, authSession } from '../lib/auth/index.js';

const route = useRoute();
const info = ref(null);
const error = ref('');
const busy = ref(false);
let generation = 0;
let displayedRequest;
const parameters = computed(() => {
  if (Object.values(route.query).some(value => typeof value !== 'string')) throw new Error('Invalid connection request.');
  return { ...route.query };
});
const canWrite = computed(() => info.value?.scopes.includes('projects.write'));
const redirectOrigin = computed(() => info.value ? new URL(info.value.redirectUri).origin : '');
// Clients on the person's own computer, such as Claude Code and Codex, return to a loopback address.
const returnsToThisComputer = computed(() => info.value ? ['localhost', '127.0.0.1', '[::1]'].includes(new URL(info.value.redirectUri).hostname) : false);
watch([() => route.fullPath, () => authSession.state.token, () => authSession.state.currentUser?.tenantId, () => authSession.state.currentUser?.id], async () => {
  const current = ++generation;
  info.value = null;
  displayedRequest = undefined;
  error.value = '';
  try {
    const request = parameters.value;
    const value = await apiClient.getMcpConsent(request, authSession.state.token);
    if (current === generation) { displayedRequest = request; info.value = value; }
  } catch {
    if (current === generation) error.value = 'This connection request is unavailable. Check the selected workspace or request a new connection from your client.';
  }
}, { immediate: true });

async function approve() {
  const request = displayedRequest;
  const expectedRedirect = info.value?.redirectUri;
  if (!request || !expectedRedirect) return;
  busy.value = true;
  error.value = '';
  try {
    const result = await apiClient.blocking.authorizeMcp({ ...request, approved: true }, authSession.state.token);
    const target = new URL(result.redirectTo);
    const expected = new URL(expectedRedirect);
    if (target.origin !== expected.origin || target.pathname !== expected.pathname) throw new Error('Invalid connection response.');
    window.location.assign(target.href);
  } catch {
    error.value = 'The connection could not be authorized. Try again or request a new connection from your client.';
    busy.value = false;
  }
}
function cancel() {
  const target = new URL(info.value.redirectUri);
  target.searchParams.set('error', 'access_denied');
  target.searchParams.set('state', displayedRequest.state);
  window.location.assign(target.href);
}
</script>

<template>
  <section class="mcp-consent" aria-labelledby="mcp-consent-heading">
    <h1 id="mcp-consent-heading">Connect {{ info?.name || 'your client' }} to Odin</h1>
    <p v-if="error" role="alert">{{ error }}</p>
    <template v-if="info">
      <p>This client will act as {{ authSession.state.currentUser?.name }} in your selected workspace.</p>
      <ul class="permissions">
        <li>Read project plans, comments, workflows, and boards.</li>
        <li v-if="canWrite">Create and change projects, plan items, comments, and boards within your permissions.</li>
      </ul>
      <p v-if="!info.projectIds.length">Access covers projects available to you in this workspace, including future projects.</p>
      <template v-else>
        <p>Access is limited to these projects and your current permissions:</p>
        <ul><li v-for="project in info.projects" :key="project.id">{{ project.name }}</li></ul>
      </template>
      <p>The connection lasts up to 30 days. An administrator can revoke it earlier.</p>
      <p class="destination">Return to {{ returnsToThisComputer ? `an application on this computer (${redirectOrigin})` : redirectOrigin }}</p>
      <div class="actions">
        <button class="btn btn-outline-secondary" type="button" :disabled="busy" @click="cancel">Cancel</button>
        <button class="btn btn-primary" type="button" :disabled="busy" @click="approve">{{ busy ? 'Connecting…' : 'Connect' }}</button>
      </div>
    </template>
    <p v-else-if="!error" role="status">Loading connection request…</p>
  </section>
</template>

<style scoped>
.mcp-consent { margin: 1.5rem; padding: 1rem; max-width: 70ch; font-size: .875rem; line-height: 1.25; }
h1 { font-size: 1.375rem; line-height: 1.2; margin-bottom: 1rem; overflow-wrap: anywhere; }
p, ul { margin-bottom: .75rem; }
p { overflow-wrap: anywhere; }
li { margin-bottom: .25rem; overflow-wrap: anywhere; }
.actions { display: flex; flex-wrap: wrap; gap: .75rem; margin-top: 1rem; }
.actions button { min-height: 2.75rem; }
.destination { overflow-wrap: anywhere; }
button:focus-visible { outline: .1875rem solid var(--bs-primary); outline-offset: .1875rem; }
@media (max-width: 42rem) { .mcp-consent { margin: .5rem; padding: .75rem; } }
</style>
