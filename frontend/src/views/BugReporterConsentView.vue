<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { apiClient, authSession } from '../lib/auth/index.js';
const route = useRoute(); const router = useRouter();
const info = ref(null); const error = ref(''); const busy = ref(false);
const parameters = computed(() => {
  const q = route.query;
  if (Object.values(q).some(v => typeof v !== 'string')) throw new Error('Invalid authorization request.');
  if (q.scope !== 'projects.read' || q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge ?? '') || !q.state || q.state.length < 8) throw new Error('Invalid authorization request.');
  return { approved: true, clientId: q.client_id, redirectUri: q.redirect_uri, scope: q.scope, state: q.state, codeChallenge: q.code_challenge, codeChallengeMethod: 'S256' };
});
onMounted(async () => {
  try { const p = parameters.value; info.value = await apiClient.getBugReporterConsent({ client_id: p.clientId, redirect_uri: p.redirectUri }, authSession.state.token); }
  catch (e) { error.value = e.message; }
});
async function approve() {
  busy.value = true; error.value = '';
  try { const result = await apiClient.blocking.authorizeBugReporter(parameters.value, authSession.state.token); const target = new URL(result.redirectTo); const expected = new URL(parameters.value.redirectUri); if (target.origin !== expected.origin || target.pathname !== expected.pathname) throw new Error('Invalid authorization response.'); window.location.assign(target.href); }
  catch (e) { error.value = e.message; busy.value = false; }
}
</script>
<template>
  <main class="consent">
    <h1>Connect to {{ info?.name || 'Bug Reporter' }}</h1>
    <p v-if="error" role="alert">{{ error }}</p>
    <template v-if="info">
      <p>Allow this application to use your identity and project membership?</p>
      <ul><li v-for="project in info.projects" :key="project.id">{{ project.name }}</li></ul>
      <p class="destination">Return to {{ info.redirectOrigin }}</p>
      <div class="actions"><button :disabled="busy" @click="router.push('/')">Cancel</button><button :disabled="busy" @click="approve">{{ busy ? 'Connecting…' : 'Connect' }}</button></div>
    </template>
    <p v-else-if="!error" role="status">Loading request…</p>
  </main>
</template>
<style scoped>
.consent{max-width:38rem;margin:3rem auto;padding:1.5rem;font-size:.875rem}h1{font-size:1.375rem}.actions{display:flex;gap:.75rem}.actions button{min-height:2.75rem;padding:.5rem 1rem}.destination{overflow-wrap:anywhere;color:var(--bs-secondary-color)}button:focus-visible{outline:3px solid var(--bs-primary);outline-offset:3px}
</style>
