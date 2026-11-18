<script setup>
import { computed, reactive, ref, watch } from 'vue';

import { authSession } from '../../lib/auth/index.js';
import RequirementsConfirmDialog from '../requirements/RequirementsConfirmDialog.vue';
import RequirementsDialog from '../requirements/RequirementsDialog.vue';

// Two-factor status for the profile's Security tab. Setup, backup codes and turning it off each
// open their own dialog so none of them competes with the profile form behind it.

const enabled = computed(() => Boolean(authSession.state.currentUser?.preferences?.twoFactorEnabled));
const backupCodes = computed(() => authSession.state.lastBackupCodes ?? []);

const setup = reactive({ busy: false, code: '', error: '', open: false, step: 'start' });
const codes = reactive({ busy: false, error: '', open: false });
const disable = reactive({ busy: false, error: '', open: false });
const notice = ref('');

// The dialog only focuses its first field when it opens, so move focus when the step changes.
// The blocking API indicator hands focus back to the pressed button on a zero-delay timer
// after the call, so focus the code field after that.
watch(() => [setup.step, setup.busy], ([step, busy]) => {
  if (step === 'verify' && !busy) setTimeout(() => document.getElementById('two-factor-code')?.focus(), 0);
}, { flush: 'post' });

const setupTitle = computed(() => (setup.step === 'done' ? 'Save your backup codes' : 'Set up two-factor authentication'));

function openSetup() {
  Object.assign(setup, { busy: false, code: '', error: '', open: true, step: 'start' });
  notice.value = '';
}

function closeSetup() {
  if (setup.busy) return;
  setup.open = false;
  authSession.state.twoFactorSetupQrCode = '';
}

async function submitSetup() {
  if (setup.step === 'done') {
    setup.open = false;
    return;
  }
  setup.busy = true;
  setup.error = '';
  try {
    if (setup.step === 'start') {
      await authSession.initTwoFactor();
      setup.step = 'verify';
    } else {
      const code = setup.code.trim();
      if (!code) {
        setup.error = 'Enter the 6-digit code from your authenticator app.';
        return;
      }
      await authSession.enableTwoFactor(code);
      setup.code = '';
      setup.step = 'done';
      notice.value = 'Two-factor authentication is on.';
    }
  } catch (error) {
    setup.error = error?.message ?? 'Two-factor setup failed. Try again.';
  } finally {
    setup.busy = false;
  }
}

async function openCodes() {
  Object.assign(codes, { busy: true, error: '', open: true });
  notice.value = '';
  try {
    await authSession.loadBackupCodes();
  } catch (error) {
    codes.error = error?.message ?? 'Backup codes could not be loaded.';
  } finally {
    codes.busy = false;
  }
}

function openDisable() {
  Object.assign(disable, { busy: false, error: '', open: true });
  notice.value = '';
}

async function confirmDisable() {
  disable.busy = true;
  disable.error = '';
  try {
    await authSession.disableTwoFactor();
    disable.open = false;
    notice.value = 'Two-factor authentication is off.';
  } catch (error) {
    disable.error = error?.message ?? 'Two-factor authentication could not be turned off.';
  } finally {
    disable.busy = false;
  }
}
</script>

<template>
  <section class="two-factor" aria-labelledby="two-factor-title">
    <div class="two-factor__status">
      <div>
        <h2 id="two-factor-title">Two-factor authentication</h2>
        <p>
          <i class="bi" :class="enabled ? 'bi-shield-check text-success' : 'bi-shield-exclamation text-warning'" aria-hidden="true"></i>
          {{ enabled ? 'On. Sign-in asks for a code from your authenticator app.' : 'Off. Add a code from an authenticator app to sign-in.' }}
        </p>
      </div>
      <div class="two-factor__actions">
        <button v-if="!enabled" class="btn btn-sm btn-primary" type="button" @click="openSetup">Set up</button>
        <template v-else>
          <button class="btn btn-sm btn-outline-secondary" type="button" @click="openCodes">Backup codes</button>
          <button class="btn btn-sm btn-outline-danger" type="button" @click="openDisable">Turn off</button>
        </template>
      </div>
    </div>
    <p v-if="notice" class="two-factor__notice" role="status">{{ notice }}</p>

    <RequirementsDialog :busy="setup.busy" :open="setup.open" :title="setupTitle" @close="closeSetup" @submit="submitSetup">
      <p v-if="setup.step === 'start'" class="mb-0">You’ll scan a QR code with an authenticator app, then enter the code it shows to confirm.</p>
      <template v-else-if="setup.step === 'verify'">
        <img v-if="authSession.state.twoFactorSetupQrCode" class="qr-preview two-factor__qr" :src="authSession.state.twoFactorSetupQrCode" alt="QR code for your authenticator app" />
        <div class="rq-field">
          <label for="two-factor-code">Verification code</label>
          <input id="two-factor-code" v-model="setup.code" class="form-control" inputmode="numeric" autocomplete="one-time-code" maxlength="12" data-autofocus />
          <p class="rq-field__hint">Enter the current code from your authenticator app.</p>
        </div>
      </template>
      <template v-else>
        <p class="mb-0">Store these somewhere safe. Each code signs you in once if you lose your authenticator.</p>
        <ul class="code-grid two-factor__codes" aria-label="Backup codes">
          <li v-for="backupCode in backupCodes" :key="backupCode" class="code-pill">{{ backupCode }}</li>
        </ul>
      </template>
      <p v-if="setup.error" class="error-banner mb-0" role="alert">{{ setup.error }}</p>
      <template #footer>
        <button v-if="setup.step !== 'done'" class="ghost-button" type="button" :disabled="setup.busy" @click="closeSetup">Cancel</button>
        <button class="primary-button" type="submit" :disabled="setup.busy">
          {{ setup.busy ? 'Working…' : setup.step === 'start' ? 'Show QR code' : setup.step === 'verify' ? 'Turn on' : 'Done' }}
        </button>
      </template>
    </RequirementsDialog>

    <RequirementsDialog :busy="codes.busy" :open="codes.open" title="Backup codes" @close="codes.open = false" @submit="codes.open = false">
      <p v-if="codes.busy" class="mb-0" role="status">Loading backup codes…</p>
      <p v-else-if="codes.error" class="error-banner mb-0" role="alert">{{ codes.error }}</p>
      <template v-else>
        <p class="mb-0">Each unused code signs you in once if you lose your authenticator.</p>
        <ul v-if="backupCodes.length" class="code-grid two-factor__codes" aria-label="Backup codes">
          <li v-for="backupCode in backupCodes" :key="backupCode" class="code-pill">{{ backupCode }}</li>
        </ul>
        <p v-else class="mb-0">No unused backup codes remain.</p>
      </template>
      <template #footer>
        <button class="primary-button" type="submit" :disabled="codes.busy">Close</button>
      </template>
    </RequirementsDialog>

    <RequirementsConfirmDialog :busy="disable.busy" :error="disable.error" :open="disable.open" title="Turn off two-factor authentication?" confirm-label="Turn off" @close="disable.open = false" @confirm="confirmDisable">
      Sign-in will only ask for your password. Your backup codes stop working.
    </RequirementsConfirmDialog>
  </section>
</template>

<style scoped>
.two-factor { display: grid; gap: 0.5rem; font-size: 0.875rem; line-height: 1.25; }
.two-factor__status { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.75rem; }
.two-factor h2 { font-size: 1rem; line-height: 1.2; margin: 0 0 0.25rem; }
.two-factor__status p, .two-factor__notice { margin: 0; color: var(--bs-secondary-color); }
.two-factor__actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.two-factor__actions .btn { min-height: 2.75rem; }
.two-factor__qr { justify-self: center; }
.two-factor__codes { margin: 0; padding: 0; list-style: none; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.two-factor__codes .code-pill { font-size: 0.875rem; padding: 0.5rem; }
</style>
