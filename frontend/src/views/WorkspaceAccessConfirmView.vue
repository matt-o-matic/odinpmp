<script setup>
import { ref } from 'vue';
import { RouterLink, useRoute } from 'vue-router';

import { apiClient, authSession } from '../lib/auth/index.js';

const route = useRoute();
// The token is in the fragment, which browsers never send to the server.
const token = route.hash.replace(/^#/, '');
const busy = ref(false);
const errorMessage = ref('');
const confirmedWorkspace = ref('');

// Waits for a click instead of running on load: mail scanners open links, and a link that
// confirmed itself would show the request to admins without the person ever seeing this page.
async function confirm() {
  if (busy.value) return;
  busy.value = true;
  errorMessage.value = '';
  try {
    const result = await apiClient.confirmWorkspaceAccessEmail(token);
    confirmedWorkspace.value = result.workspaceName ?? 'the workspace';
  } catch (error) {
    errorMessage.value = error.message ?? 'We couldn’t confirm this link.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="access-confirm" aria-labelledby="access-confirm-title">
    <h1 id="access-confirm-title">Confirm your request to join a workspace</h1>
    <template v-if="confirmedWorkspace">
      <p role="status">Thanks. The admins of <strong>{{ confirmedWorkspace }}</strong> can now see your request. We’ll email you when one of them decides.</p>
      <RouterLink v-if="authSession.state.isAuthenticated" class="btn btn-outline-primary" :to="{ name: 'workspace-access' }">See your requests</RouterLink>
      <RouterLink v-else class="btn btn-outline-primary" :to="{ name: 'login' }">Sign in</RouterLink>
    </template>
    <template v-else-if="token">
      <p>Confirming shows your request to that workspace’s admins. It doesn’t give you access; an admin still has to approve it.</p>
      <div v-if="errorMessage" class="alert alert-danger" role="alert">{{ errorMessage }}</div>
      <button v-if="!errorMessage" class="btn btn-primary" type="button" :disabled="busy" @click="confirm">
        {{ busy ? 'Confirming…' : 'Confirm my email' }}
      </button>
      <p v-else>
        <RouterLink :to="{ name: 'workspace-access' }">Open your requests</RouterLink> to send a new link.
      </p>
    </template>
    <p v-else>This link is incomplete. Open it again from the email, or <RouterLink :to="{ name: 'workspace-access' }">open your requests</RouterLink> to send a new one.</p>
  </section>
</template>

<style scoped>
.access-confirm { width: min(34rem, calc(100% - 2rem)); margin: 2rem auto; padding: 1rem; border: 1px solid var(--line); border-radius: .5rem; background: var(--bs-body-bg); color: var(--bs-body-color); font-size: .875rem; overflow-wrap: anywhere; }
h1 { font-size: 1.375rem; }
.btn { display: inline-flex; align-items: center; min-height: 2.75rem; }
:focus-visible { outline: 3px solid var(--bs-primary); outline-offset: 2px; }
</style>
