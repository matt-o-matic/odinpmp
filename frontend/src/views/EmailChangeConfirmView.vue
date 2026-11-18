<script setup>
import { ref } from 'vue';
import { RouterLink, useRoute } from 'vue-router';

import { apiClient, authSession } from '../lib/auth/index.js';

const route = useRoute();
// The token is in the fragment, which browsers never send to the server.
const token = route.hash.replace(/^#/, '');
const busy = ref(false);
const errorMessage = ref('');
const confirmedEmail = ref('');

// Waits for a click instead of running on load: mail scanners open links, and a link that
// confirmed itself would change the address without the person ever seeing this page.
async function confirm() {
  if (busy.value) return;
  busy.value = true;
  errorMessage.value = '';
  try {
    const result = await apiClient.confirmEmailChange(token);
    confirmedEmail.value = result.email ?? 'your new address';
    if (authSession.state.currentUser) authSession.state.currentUser = { ...authSession.state.currentUser, email: confirmedEmail.value };
  } catch (error) {
    errorMessage.value = error.message ?? 'We couldn’t confirm this link.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="email-confirm" aria-labelledby="email-confirm-title">
    <h1 id="email-confirm-title">Confirm your new email address</h1>
    <template v-if="confirmedEmail">
      <p role="status">Done. Your account now uses <strong>{{ confirmedEmail }}</strong>. Use it the next time you sign in.</p>
      <RouterLink v-if="authSession.state.isAuthenticated" class="btn btn-outline-primary" :to="{ name: 'user' }">Open your profile</RouterLink>
      <RouterLink v-else class="btn btn-outline-primary" :to="{ name: 'login' }">Sign in</RouterLink>
    </template>
    <template v-else-if="token">
      <p>Confirming moves your OdinPMP account to the address this link was sent to.</p>
      <div v-if="errorMessage" class="alert alert-danger" role="alert">{{ errorMessage }}</div>
      <button v-if="!errorMessage" class="btn btn-primary" type="button" :disabled="busy" @click="confirm">
        {{ busy ? 'Confirming…' : 'Confirm my new email' }}
      </button>
    </template>
    <p v-else>This link is incomplete. Open it again from the email, or change your email in your profile again to get a new one.</p>
  </section>
</template>

<style scoped>
.email-confirm { width: min(34rem, calc(100% - 2rem)); margin: 2rem auto; padding: 1rem; border: 1px solid var(--line); border-radius: .5rem; background: var(--bs-body-bg); color: var(--bs-body-color); font-size: .875rem; overflow-wrap: anywhere; }
h1 { font-size: 1.375rem; }
.btn { display: inline-flex; align-items: center; min-height: 2.75rem; }
:focus-visible { outline: 3px solid var(--bs-primary); outline-offset: 2px; }
</style>
