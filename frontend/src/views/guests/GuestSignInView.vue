<script setup>
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { guestApi } from '../../lib/guests/guest-client.js';
import { guestNotice, resendCountdown, safeGuestNext, signInErrorMessage } from '../../lib/guests/guest-view.js';
import { odinMarkUrl } from '../../lib/requirements/portal-context.js';

// Guest sign-in: the guest enters their email, Odin emails a 6-digit code, and the code starts
// a 30-day session that renews with use. Every address gets the same answer, so this page
// never says whether someone is invited.
const route = useRoute();
const router = useRouter();
const uid = useId();
const mark = odinMarkUrl(import.meta.env.BASE_URL);

const step = ref('email');
const email = ref('');
const code = ref('');
const sentTo = ref('');
const busy = ref(false);
const error = ref('');
const resendAt = ref(0);
const now = ref(Date.now());
let ticker = null;

const workspace = computed(() => String(route.query.workspace ?? ''));
const next = computed(() => safeGuestNext(route.query.next));
const notice = computed(() => guestNotice(route.query.notice));
const countdown = computed(() => resendCountdown(resendAt.value, now.value));

async function askForCode() {
  if (busy.value) return;
  if (!email.value.trim()) {
    error.value = 'Enter your email address.';
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    const result = await guestApi.requestSignInCode(email.value.trim(), workspace.value);
    sentTo.value = result.sentTo || email.value.trim();
    resendAt.value = Date.now() + Number(result.resendAfterSeconds ?? 60) * 1000;
    code.value = '';
    step.value = 'code';
  } catch (failure) {
    error.value = signInErrorMessage(failure);
    // Asked again too soon: the code already sent still works.
    if (failure?.data?.details?.code === 'code_recently_sent') step.value = 'code';
  } finally {
    busy.value = false;
  }
}

async function enterCode() {
  if (busy.value) return;
  const value = code.value.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(value)) {
    error.value = 'Enter the 6-digit code from the email.';
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    await guestApi.signIn(email.value.trim(), value, workspace.value);
    await router.replace(next.value);
  } catch (failure) {
    error.value = signInErrorMessage(failure);
  } finally {
    busy.value = false;
  }
}

function changeEmail() {
  step.value = 'email';
  error.value = '';
  code.value = '';
}

onMounted(async () => {
  ticker = setInterval(() => { now.value = Date.now(); }, 1000);
  if (typeof document !== 'undefined') document.title = 'Sign in · OdinPMP';
  // Already signed in: straight on.
  try {
    await guestApi.getSession();
    await router.replace(next.value);
  } catch {
    // Not signed in; stay here.
  }
});
onBeforeUnmount(() => clearInterval(ticker));
</script>

<template>
  <div class="rq-workspace rq-portal guest-sign-in">
    <main class="guest-sign-in__card rq-panel" :aria-labelledby="`${uid}-title`">
      <img :src="mark" alt="OdinPMP" width="40" height="40" />
      <h1 :id="`${uid}-title`" class="guest-sign-in__title">Sign in</h1>
      <p v-if="notice" class="guest-sign-in__notice" role="status">{{ notice }}</p>

      <form v-if="step === 'email'" class="rq-stack rq-stack--sm" novalidate @submit.prevent="askForCode">
        <p class="rq-small rq-muted mb-0">Enter the email address your invitation went to. We email you a code. No password is needed.</p>
        <div class="rq-field">
          <label :for="`${uid}-email`">Email</label>
          <input :id="`${uid}-email`" v-model="email" class="form-control" type="email" inputmode="email" autocomplete="email" autocapitalize="off" spellcheck="false" maxlength="255" required data-testid="guest-email" />
        </div>
        <p v-if="error" class="error-banner mb-0" role="alert">{{ error }}</p>
        <button class="primary-button guest-sign-in__submit" type="submit" :disabled="busy">{{ busy ? 'Sending…' : 'Email me a code' }}</button>
      </form>

      <form v-else class="rq-stack rq-stack--sm" novalidate @submit.prevent="enterCode">
        <p class="rq-small mb-0" role="status">If {{ sentTo }} is invited, a code is on its way. It works for 15 minutes.</p>
        <div class="rq-field">
          <label :for="`${uid}-code`">Code</label>
          <input
            :id="`${uid}-code`"
            v-model="code"
            class="form-control guest-sign-in__code"
            type="text"
            inputmode="numeric"
            autocomplete="one-time-code"
            pattern="[0-9]*"
            maxlength="6"
            required
            data-autofocus
            data-testid="guest-code"
          />
        </div>
        <p v-if="error" class="error-banner mb-0" role="alert">{{ error }}</p>
        <button class="primary-button guest-sign-in__submit" type="submit" :disabled="busy">{{ busy ? 'Signing in…' : 'Sign in' }}</button>
        <div class="guest-sign-in__links">
          <button class="rq-text-action" type="button" :disabled="busy || Boolean(countdown)" @click="askForCode">
            {{ countdown ? `Send a new code in ${countdown}` : 'Send a new code' }}
          </button>
          <button class="rq-text-action" type="button" :disabled="busy" @click="changeEmail">Use another email</button>
        </div>
      </form>
    </main>
  </div>
</template>

<style scoped>
.guest-sign-in { display: grid; min-height: 100vh; min-height: 100dvh; place-items: start center; padding: 2.5rem 1rem; }
.guest-sign-in__card { display: grid; gap: 0.85rem; width: min(100%, 26rem); padding: 1.5rem; }
.guest-sign-in__title { margin: 0; font-family: var(--font-display); font-size: 1.4rem; }
.guest-sign-in__notice { margin: 0; padding: 0.5rem 0.75rem; border: 1px solid var(--line); border-radius: 0.4rem; background: var(--surface-soft); }
/* 16px keeps iOS Safari from zooming into the field. */
.guest-sign-in .form-control { min-height: 2.75rem; font-size: 1rem; }
.guest-sign-in__code { font-size: 1.4rem !important; letter-spacing: 0.4em; text-align: center; }
.guest-sign-in__submit { min-height: 2.75rem; width: 100%; justify-content: center; }
.guest-sign-in__links { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0.5rem; }
.guest-sign-in__links .rq-text-action { min-height: 2.75rem; }
</style>
