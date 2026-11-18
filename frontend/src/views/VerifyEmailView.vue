<script setup>
import { ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import { authSession } from '../lib/auth/index.js';

const route = useRoute();
const router = useRouter();
// The token is in the fragment, which browsers never send to the server.
const token = route.hash.replace(/^#/, '');
const busy = ref(false);
const errorMessage = ref('');

// Waits for a click instead of running on load: mail scanners open links, and a link
// that confirmed itself would be used up before the person who signed up got there.
async function confirm() {
  if (busy.value) return;
  busy.value = true;
  errorMessage.value = '';
  try {
    await authSession.verifyRegistration(token);
    await router.push('/');
  } catch (error) {
    errorMessage.value = error.message ?? 'We couldn’t confirm this link.';
    busy.value = false;
  }
}
</script>

<template>
  <section class="verify-email" aria-labelledby="verify-email-title">
    <h1 id="verify-email-title">Finish creating your workspace</h1>
    <template v-if="token">
      <p>Your email is confirmed once you continue. We’ll create your account and workspace and sign you in.</p>
      <div v-if="errorMessage" class="alert alert-danger" role="alert">{{ errorMessage }}</div>
      <button v-if="!errorMessage" class="btn btn-primary" type="button" :disabled="busy" @click="confirm">
        {{ busy ? 'Creating workspace…' : 'Create my workspace' }}
      </button>
      <p v-else>
        <RouterLink :to="{ name: 'login' }">Sign in</RouterLink> if you already finished, or
        <RouterLink :to="{ name: 'register' }">sign up again</RouterLink> for a new link.
      </p>
    </template>
    <template v-else>
      <p>This link is incomplete. Open it again from the email, or <RouterLink :to="{ name: 'register' }">sign up again</RouterLink> for a new link.</p>
    </template>
  </section>
</template>

<style scoped>
.verify-email { width: min(34rem, calc(100% - 2rem)); margin: 2rem auto; padding: 1rem; border: 1px solid var(--line); border-radius: .5rem; background: var(--bs-body-bg); color: var(--bs-body-color); font-size: .875rem; overflow-wrap: anywhere; }
h1 { font-size: 1.375rem; }
.btn { min-height: 2.75rem; }
:focus-visible { outline: 3px solid var(--bs-primary); outline-offset: 2px; }
</style>
