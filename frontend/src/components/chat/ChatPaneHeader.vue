<script setup>
// The top of a screen in Odin Chat: its title, an optional line of context, and on a phone the way
// back to the sidebar (docs/odin-chat/plan.md, Odin Chat: phones).
defineProps({
  backTo: { default: () => ({ name: 'chat-home' }), type: [Object, String] },
  // Shown above the title, linking to `contextTo` when given.
  context: { default: '', type: String },
  contextTo: { default: null, type: [Object, String] },
  // A screen whose own component names it (a channel) keeps the title for screen readers only.
  hideTitle: { default: false, type: Boolean },
  title: { required: true, type: String },
});
</script>

<template>
  <header class="chat-pane-head" :class="{ 'chat-pane-head--quiet': hideTitle }">
    <RouterLink class="chat-pane-head__back" :to="backTo">
      <i class="bi bi-chevron-left" aria-hidden="true"></i> Back
    </RouterLink>
    <div class="chat-pane-head__text">
      <p v-if="context" class="chat-pane-head__context">
        <RouterLink v-if="contextTo" :to="contextTo">{{ context }}</RouterLink>
        <template v-else>{{ context }}</template>
      </p>
      <h1 class="chat-pane-head__title" :class="{ 'visually-hidden': hideTitle }">{{ title }}</h1>
      <slot />
    </div>
    <div v-if="$slots.actions" class="chat-pane-head__actions"><slot name="actions" /></div>
  </header>
</template>

<style scoped>
.chat-pane-head { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 0.75rem; padding: 0.75rem 1rem 0.5rem; }
.chat-pane-head__back { display: none; align-items: center; gap: 0.25rem; min-height: 2.75rem; padding-right: 0.5rem; color: var(--accent); font-weight: 600; text-decoration: none; }
.chat-pane-head__text { flex: 1 1 12rem; min-width: 0; }
.chat-pane-head__context { margin: 0; color: var(--muted); font-size: 0.75rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
.chat-pane-head__context a { display: inline-flex; align-items: center; min-height: 2.75rem; color: inherit; }
/* The legacy stylesheet sizes and underlines every h1 with !important. */
.chat-pane-head__title { margin: 0; padding: 0; border-bottom: 0; font-family: var(--font-display); font-size: 1.2rem !important; overflow-wrap: anywhere; }
.chat-pane-head__actions { display: flex; flex-wrap: wrap; gap: 0.35rem; }
.chat-pane-head--quiet { padding-bottom: 0; }
.chat-pane-head__back:focus-visible,
.chat-pane-head__context a:focus-visible { outline: 0.18rem solid var(--accent); outline-offset: 0.1rem; }

@media (max-width: 767.98px) {
  .chat-pane-head__back { display: inline-flex; flex-basis: 100%; }
}
</style>
