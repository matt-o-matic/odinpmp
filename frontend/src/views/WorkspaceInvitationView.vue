<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { apiClient, authSession } from '../lib/auth/index.js';
import { createSignupCaptcha } from '../lib/auth/recaptcha.js';

const route = useRoute();
const router = useRouter();
const invitation = ref(null);
const loading = ref(true);
const busy = ref(false);
const errorMessage = ref('');
const form = reactive({ name: '', password: '', website: '' });
const captcha = createSignupCaptcha(apiClient);
onMounted(() => captcha.load());
const user = computed(() => authSession.state.currentUser);
const matchingAccount = computed(() => user.value?.email?.toLowerCase() === invitation.value?.email?.toLowerCase());
const loginTarget = computed(() => ({ name: 'login', query: { email: invitation.value?.email, redirect: route.fullPath } }));

watch(() => route.params.inviteToken, async (inviteToken) => {
  invitation.value = null;
  loading.value = true;
  errorMessage.value = '';
  try {
    invitation.value = (await apiClient.getWorkspaceInvitation(inviteToken)).invitation;
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to load this invitation.';
  } finally {
    loading.value = false;
  }
}, { immediate: true });

async function accept() {
  if (busy.value) return;
  busy.value = true;
  errorMessage.value = '';
  try {
    // A new account sends a reCAPTCHA token; a signed-in member doesn't need one.
    const recaptchaToken = user.value ? '' : await captcha.token();
    await authSession.acceptWorkspaceInvitation(route.params.inviteToken, user.value ? null : { ...form, name: form.name.trim(), recaptchaToken });
    // Reload tenant-scoped stores after joining or switching workspaces.
    window.location.assign(import.meta.env.BASE_URL);
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to accept the invitation.';
    busy.value = false;
  }
}
async function switchAccount() {
  const target = loginTarget.value;
  const { cancelled } = await authSession.logout();
  if (!cancelled) {
    await router.push(target);
  }
}
</script>

<template>
  <section class="workspace-invitation" aria-labelledby="invitation-title">
    <h1 id="invitation-title">Workspace invitation</h1>
    <p v-if="loading" role="status">Loading invitation…</p>
    <div v-if="errorMessage" class="alert alert-danger" role="alert">{{ errorMessage }}</div>
    <template v-if="invitation">
      <h2>Join {{ invitation.workspaceName }}</h2>
      <p><strong>{{ invitation.email }}</strong> has been invited as {{ invitation.role }}.</p>
      <template v-if="user">
        <p v-if="!matchingAccount">You’re signed in as {{ user.email }}. Use the invited email address to join.</p>
        <button v-if="matchingAccount" class="btn btn-primary" type="button" :disabled="busy" @click="accept()">{{ busy ? 'Joining…' : 'Accept invitation' }}</button>
        <button v-else class="btn btn-outline-primary" type="button" @click="switchAccount">Sign in with the invited email</button>
      </template>
      <template v-else-if="invitation.accountExists">
        <p>Sign in to accept this invitation.</p>
        <RouterLink class="btn btn-primary" :to="loginTarget">Sign in to join</RouterLink>
      </template>
      <form v-else @submit.prevent="accept()">
        <label for="invite-name">Full name<input id="invite-name" v-model="form.name" class="form-control" autocomplete="name" maxlength="120" required /></label>
        <label for="invite-password">Password<input id="invite-password" v-model="form.password" class="form-control" autocomplete="new-password" type="password" minlength="8" maxlength="200" required /></label>
        <!-- Honeypot: hidden from people, so only bots fill it in. -->
        <div class="signup-trap" aria-hidden="true">
          <label for="invite-website">Website<input id="invite-website" v-model="form.website" name="website" type="text" tabindex="-1" autocomplete="off" /></label>
        </div>
        <button class="btn btn-primary" type="submit" :disabled="busy">{{ busy ? 'Joining…' : 'Create account and join' }}</button>
        <RouterLink :to="loginTarget">Already have an account? Sign in</RouterLink>
      </form>
    </template>
    <RouterLink v-else-if="!loading" :to="{ name: 'login' }">Go to sign in</RouterLink>
  </section>
</template>

<style scoped>
.workspace-invitation { width: min(34rem, calc(100% - 2rem)); margin: 2rem auto; padding: 1rem; border: 1px solid var(--line); border-radius: .5rem; background: var(--bs-body-bg); color: var(--bs-body-color); font-size: .875rem; overflow-wrap: anywhere; }
h1 { font-size: 1.375rem; } h2 { font-size: 1.125rem; }
form, label { display: grid; gap: .5rem; } form { gap: .75rem; }
input, .btn { min-height: 2.75rem; }
:focus-visible { outline: 3px solid var(--bs-primary); outline-offset: 2px; }
.signup-trap { position: absolute; left: -10000px; width: 1px; height: 1px; overflow: hidden; }
</style>
