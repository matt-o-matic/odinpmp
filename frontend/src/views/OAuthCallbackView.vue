<script setup>
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { authSession } from '../lib/auth/index.js';
import { markLanding } from '../lib/chat/chat.js';

const route = useRoute();
const router = useRouter();
const message = ref('Completing the Google sign-in flow...');

onMounted(async () => {
  try {
    const result = await authSession.consumeOAuthCallback(route.query);
    const redirectTarget = typeof result.redirect === 'string' && result.redirect.startsWith('/')
      ? result.redirect
      : '/';

    if (result.authenticated) {
      markLanding();
      router.replace(redirectTarget);
      return;
    }

    if (result.requiresTwoFactor) {
      router.replace({
        name: 'login',
        query: {
          from: 'google',
          ...(redirectTarget !== '/' ? { redirect: redirectTarget } : {}),
        },
      });
      return;
    }
  } catch (error) {
    message.value = error.message ?? 'Unable to complete the OAuth callback.';
  }
});
</script>

<template>
  <section class="dashboard-panel">
    <p class="section-eyebrow">Sign In</p>
    <h2 class="hero-title">Signing you in…</h2>
    <p class="panel-copy">{{ message }}</p>
  </section>
</template>
