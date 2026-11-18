<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import { apiClient, authSession } from '../lib/auth/index.js';
import { createSignupCaptcha } from '../lib/auth/recaptcha.js';

const route = useRoute();
const router = useRouter();
const availability = ref(null);
const errorMessage = ref('');
const infoMessage = ref('');
const loading = ref(false);
const checking = ref(false);
const pendingEmail = ref('');
const captcha = createSignupCaptcha(apiClient);
const form = reactive({
  authMethod: route.query.auth === 'google' ? 'google' : 'basic',
  createTenant: true,
  email: typeof route.query.email === 'string' ? route.query.email : '',
  name: typeof route.query.name === 'string' ? route.query.name : '',
  password: '',
  tenantName: '',
  website: '',
});

onMounted(() => captcha.load());
// Only a verified Google email can join its domain's workspace without an invitation.
const needsInvitation = computed(() => form.authMethod === 'basic' && availability.value?.tenant?.status === 'claimed');
const redirectTarget = typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/')
  ? route.query.redirect
  : '/';

async function checkAvailability() {
  if (!form.email.includes('@')) {
    return;
  }

  checking.value = true;
  errorMessage.value = '';
  infoMessage.value = '';

  try {
    const result = await authSession.checkAvailability({
      email: form.email,
      tenantName: form.tenantName,
    });

    availability.value = result.availability;

    if (!result.availability.emailAvailable) {
      infoMessage.value = 'That email already has an account in OdinPMP.';
      return;
    }

    if (result.availability.tenant.status === 'claimed') {
      form.createTenant = false;
      form.tenantName = result.availability.tenant.name;
      infoMessage.value = form.authMethod === 'google'
        ? `${result.availability.tenant.name} already uses ${result.availability.domain}. This registration will join it.`
        : `${result.availability.tenant.name} already uses ${result.availability.domain}. Ask one of its admins for an invitation, or sign in with Google using this email to join.`;
      return;
    }

    if (!form.tenantName) {
      form.tenantName = result.availability.tenant.name
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, (character) => character.toUpperCase());
    }

    form.createTenant = true;
    infoMessage.value = 'This domain does not map to an existing tenant. The registration will create a new workspace.';
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to check registration availability.';
  } finally {
    checking.value = false;
  }
}

async function handleRegister() {
  if (loading.value || needsInvitation.value) return;
  loading.value = true;
  errorMessage.value = '';

  try {
    const recaptchaToken = await captcha.token();
    const result = await authSession.register({
      ...form,
      password: form.authMethod === 'google' ? '' : form.password,
      recaptchaToken,
    });
    if (result.verificationRequired) {
      pendingEmail.value = result.email;
      return;
    }
    router.push(redirectTarget);
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to create the account.';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <section class="page-panel">
    <div class="panel-column">
      <p class="section-eyebrow">Onboarding</p>
      <h2 class="hero-title">Create your workspace.</h2>
      <p class="panel-copy">We’ll create a new workspace, or add you to your domain’s workspace if you sign up with Google.</p>
      <p class="panel-copy">
        Joining a colleague’s workspace instead? Ask one of its admins for an invitation. Once you have an account, you can also choose
        <strong>Request workspace access</strong> from your account menu; one of that workspace’s admins approves the request.
      </p>
      <div class="summary-card" style="margin-top: 1.5rem">
        <p class="card-eyebrow">Sign-in mode</p>
        <h3>{{ form.authMethod === 'google' ? 'Google OAuth registration' : 'Basic account registration' }}</h3>
        <p>
          {{ form.authMethod === 'google' ? 'If this email already has an account, Google can sign you into it. Otherwise, we’ll create a Google-authenticated account.' : 'Basic accounts receive a local password plus the same 2FA options after setup.' }}
        </p>
      </div>
    </div>

    <div v-if="pendingEmail" class="panel-form stack" role="status">
      <h3>Check your email</h3>
      <p>We sent a link to <strong>{{ pendingEmail }}</strong>. Open it within 24 hours to finish creating {{ form.tenantName }}.</p>
      <p>If it doesn’t arrive, check your spam folder, or sign up again to get a new link.</p>
      <div class="link-row">
        <RouterLink class="pill-link" :to="{ name: 'login', query: { email: pendingEmail } }">Back to sign in</RouterLink>
      </div>
    </div>

    <form v-else class="panel-form stack" @submit.prevent="handleRegister">
      <div v-if="errorMessage" class="error-banner">{{ errorMessage }}</div>
      <div v-if="infoMessage" class="info-banner">{{ infoMessage }}</div>

      <div class="field-group">
        <label for="register-name">Full name</label>
        <input id="register-name" v-model="form.name" autocomplete="name" required />
      </div>

      <div class="field-group">
        <label for="register-email">Work email</label>
        <input id="register-email" v-model="form.email" autocomplete="email" type="email" required @blur="checkAvailability" />
      </div>

      <div v-if="form.authMethod === 'basic'" class="field-group">
        <label for="register-password">Password</label>
        <input id="register-password" v-model="form.password" autocomplete="new-password" type="password" minlength="8" required />
      </div>

      <div class="field-group">
        <label for="tenant-name">Tenant name</label>
        <input id="tenant-name" v-model="form.tenantName" :disabled="!form.createTenant && availability?.tenant?.status === 'claimed'" required @blur="checkAvailability" />
      </div>

      <!-- Honeypot: hidden from people, so only bots fill it in. -->
      <div class="signup-trap" aria-hidden="true">
        <label for="register-website">Website</label>
        <input id="register-website" v-model="form.website" name="website" type="text" tabindex="-1" autocomplete="off" />
      </div>

      <div class="actions-row">
        <button class="primary-button" type="submit" :disabled="loading || needsInvitation">
          {{ loading ? 'Creating account...' : 'Create account' }}
        </button>
        <button class="secondary-button" type="button" :disabled="checking || loading" @click="checkAvailability">
          {{ checking ? 'Checking...' : 'Check domain and tenant' }}
        </button>
      </div>

      <div class="link-row">
        <RouterLink class="pill-link" :to="{ name: 'login', query: { email: form.email } }">Back to sign in</RouterLink>
      </div>
    </form>
  </section>
</template>

<style scoped>
.signup-trap { position: absolute; left: -10000px; width: 1px; height: 1px; overflow: hidden; }
</style>
