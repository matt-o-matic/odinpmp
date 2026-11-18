<script setup>
import { computed, reactive, ref } from 'vue';
import { useRoute, useRouter, RouterLink } from 'vue-router';

import { apiClient, authSession } from '../lib/auth/index.js';
import { markLanding } from '../lib/chat/chat.js';

const route = useRoute();
const router = useRouter();
const credentials = reactive({
  email: typeof route.query.email === 'string' ? route.query.email : '',
  password: '',
});
const twoFactorCode = ref('');
const emergencyMode = ref(false);
const emergencyReason = ref('');
const emergencyTenantId = ref('');
const errorMessage = ref(
  route.query.error === 'google_mismatch'
    ? 'This account is already using a different sign-in method.'
    : route.query.error === 'google_unavailable'
      ? 'Google sign-in is not configured for this environment.'
      : route.query.error === 'google_callback_failed'
        ? `Google sign-in could not be completed${typeof route.query.stage === 'string' && route.query.stage
          ? ` (${route.query.stage}${typeof route.query.providerError === 'string' && route.query.providerError
            ? `: ${route.query.providerError}`
            : ''})`
          : ''}. Try again.`
    : '',
);
const loading = ref(false);
const needsRegistration = ref(false);

const showingEmergencyFactor = computed(() => Boolean(authSession.state.pendingBreakGlassChallenge));
const showingTwoFactor = computed(() => Boolean(authSession.state.pendingTwoFactorChallenge || authSession.state.pendingBreakGlassChallenge));
const redirectTarget = computed(() => (typeof route.query.redirect === 'string' ? route.query.redirect : '/'));
const registerQuery = computed(() => ({
  email: credentials.email,
}));

function goAfterAuth() {
  markLanding();
  router.push(redirectTarget.value);
}

async function handleLogin() {
  loading.value = true;
  errorMessage.value = '';
  needsRegistration.value = false;

  try {
    if (emergencyMode.value) {
      await authSession.startBreakGlass({ email: credentials.email, password: credentials.password, reason: emergencyReason.value, ...(emergencyTenantId.value ? { tenantId: emergencyTenantId.value } : {}) });
      return;
    }
    const result = await authSession.login({
      email: credentials.email,
      password: credentials.password,
    });

    if (result.requiresTwoFactor) {
      return;
    }

    goAfterAuth();
  } catch (error) {
    if (error?.data?.code === 'needs_registration') {
      needsRegistration.value = true;
      errorMessage.value = 'No account exists for this email yet. Continue with registration.';
    } else {
      errorMessage.value = error.message ?? 'Unable to sign in.';
    }
  } finally {
    loading.value = false;
  }
}

async function handleTwoFactor() {
  loading.value = true;
  errorMessage.value = '';

  try {
    if (showingEmergencyFactor.value) await authSession.verifyBreakGlass({ code: twoFactorCode.value });
    else await authSession.verifyTwoFactor({ code: twoFactorCode.value });
    goAfterAuth();
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to verify the two-factor code.';
  } finally {
    loading.value = false;
  }
}

function resetFlow() {
  authSession.cancelBreakGlass();
  void authSession.logout();
  twoFactorCode.value = '';
}

function startGoogleSignIn() {
  const url = new URL('/api/auth/google/start', `${authSession.state.apiBaseUrl}/`);
  if (typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/')) {
    url.searchParams.set('redirect', route.query.redirect);
  }
  window.location.href = url.toString();
}

async function startEnterpriseSignIn() {
  errorMessage.value = '';
  if (!credentials.email) { errorMessage.value = 'Enter your work email to discover enterprise SSO.'; return; }
  loading.value = true;
  try {
    const discovery = await apiClient.blocking.discoverEnterpriseSso(credentials.email);
    if (!discovery.configured || !['oidc', 'saml'].includes(discovery.mode)) throw new Error('Enterprise SSO is not configured for this email domain.');
    const url = new URL(`/api/auth/sso/${discovery.mode}/start`, `${authSession.state.apiBaseUrl}/`);
    url.searchParams.set('tenantId', discovery.tenantId);
    if (redirectTarget.value.startsWith('/')) url.searchParams.set('redirect', redirectTarget.value);
    window.location.href = url.toString();
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to start enterprise SSO.';
    loading.value = false;
  }
}
</script>

<template>
  <section class="page-panel">
    <div class="panel-column">
      <p class="section-eyebrow">Sign In</p>
      <h2 class="hero-title">Continue where you left off.</h2>
    </div>

    <div class="panel-form">
      <p class="section-eyebrow">{{ showingEmergencyFactor ? 'Emergency access' : showingTwoFactor ? 'Two-Factor Check' : emergencyMode ? 'Emergency access' : 'Sign In' }}</p>
      <h2 class="panel-title">{{ showingTwoFactor ? 'Verify your code' : emergencyMode ? 'Use a designated break-glass account' : 'Enter your credentials' }}</h2>

      <div v-if="errorMessage" class="error-banner" style="margin-top: 1rem">
        {{ errorMessage }}
      </div>

      <form v-if="!showingTwoFactor" class="stack" style="margin-top: 1.25rem" @submit.prevent="handleLogin">
        <div class="field-group">
          <label for="login-email">Work email</label>
          <input id="login-email" v-model="credentials.email" autocomplete="email" type="email" required />
        </div>
        <div class="field-group">
          <label for="login-password">Password</label>
          <input id="login-password" v-model="credentials.password" autocomplete="current-password" type="password" required />
        </div>
        <div v-if="emergencyMode" class="field-group">
          <label for="break-glass-reason">Incident reason</label>
          <textarea id="break-glass-reason" v-model="emergencyReason" minlength="20" maxlength="2000" required></textarea>
          <span class="field-note">Emergency sessions require a designated local administrator, MFA, and an audited justification.</span>
        </div>
        <div v-if="emergencyMode" class="field-group">
          <label for="break-glass-tenant">Workspace ID <span class="field-note">Only required when the account has emergency access to multiple workspaces</span></label>
          <input id="break-glass-tenant" v-model="emergencyTenantId" autocomplete="off" />
        </div>
        <div class="actions-row">
          <button class="primary-button" type="submit" :disabled="loading">
            {{ loading ? 'Checking...' : emergencyMode ? 'Request emergency access' : 'Sign in' }}
          </button>
          <button v-if="!emergencyMode" class="secondary-button" type="button" :disabled="loading" @click="startGoogleSignIn">
            Continue with Google
          </button>
          <button v-if="!emergencyMode" class="secondary-button" type="button" :disabled="loading" @click="startEnterpriseSignIn">
            Continue with enterprise SSO
          </button>
          <button v-else class="secondary-button" type="button" :disabled="loading" @click="emergencyMode = false">Return to normal sign in</button>
        </div>
      </form>

      <form v-else class="stack" style="margin-top: 1.25rem" @submit.prevent="handleTwoFactor">
        <div class="field-group">
          <label for="two-factor-code">Authenticator or backup code</label>
          <input id="two-factor-code" v-model="twoFactorCode" autocomplete="one-time-code" required />
        </div>
        <div class="actions-row">
          <button class="primary-button" type="submit" :disabled="loading">
            {{ loading ? 'Verifying...' : 'Verify code' }}
          </button>
          <button class="ghost-button" type="button" :disabled="loading" @click="resetFlow">
            Reset flow
          </button>
        </div>
      </form>

      <div class="section-divider"></div>
      <div class="link-row">
        <RouterLink class="pill-link" :to="{ name: 'register', query: registerQuery }">Create an account</RouterLink>
        <button v-if="!emergencyMode && !showingTwoFactor" class="pill-link" type="button" @click="emergencyMode = true">Emergency access</button>
        <span v-if="needsRegistration" class="field-note">Registration is the next step for this email.</span>
      </div>
    </div>
  </section>
</template>
