<script setup>
// Odin Chat's frame (docs/odin-chat/plan.md, layout B): a slim header, the sidebar, and the open
// conversation beside it. On a phone the sidebar is the first screen; opening something
// (`paneOpen`) puts it in the sidebar's place, and the bottom bar stays. Members' Odin Chat and
// the guest view both use it. A conversation passes `fill`: the pane is then exactly the space
// left, and the conversation scrolls inside it above its message box.
defineProps({
  fill: { default: false, type: Boolean },
  paneOpen: { default: false, type: Boolean },
});
</script>

<template>
  <div class="chat-layout" :class="{ 'chat-layout--fill': fill, 'chat-layout--pane-open': paneOpen }">
    <header class="chat-layout__header">
      <slot name="header" />
    </header>
    <div class="chat-layout__body">
      <aside class="chat-layout__sidebar" aria-label="Chat sidebar">
        <slot name="sidebar" />
      </aside>
      <main id="main-content" class="chat-layout__main" tabindex="-1">
        <slot />
      </main>
    </div>
    <nav v-if="$slots.bottom" class="chat-layout__bottom" aria-label="Chat">
      <slot name="bottom" />
    </nav>
  </div>
</template>

<style scoped>
.chat-layout { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; height: 100vh; height: 100dvh; background: var(--page); color: var(--ink); }
.chat-layout__header { min-width: 0; border-bottom: 1px solid var(--line); background: var(--surface); }
.chat-layout__body { display: grid; grid-template-columns: minmax(14rem, 18rem) minmax(0, 1fr); min-height: 0; }
.chat-layout__sidebar { min-height: 0; overflow-y: auto; overscroll-behavior: contain; border-right: 1px solid var(--line); background: var(--surface); }
.chat-layout__main { display: grid; min-width: 0; min-height: 0; overflow-y: auto; outline: none; }
.chat-layout__bottom { display: none; }
.chat-layout--fill .chat-layout__main { grid-template-rows: minmax(0, 1fr); overflow: hidden; }

@media (max-width: 767.98px) {
  .chat-layout__body { grid-template-columns: minmax(0, 1fr); }
  .chat-layout__sidebar { border-right: 0; }
  .chat-layout--pane-open .chat-layout__sidebar { display: none; }
  .chat-layout:not(.chat-layout--pane-open) .chat-layout__main { display: none; }
  .chat-layout__bottom { display: grid; grid-auto-columns: minmax(0, 1fr); grid-auto-flow: column; border-top: 1px solid var(--line); background: var(--surface); padding-bottom: env(safe-area-inset-bottom, 0); }
}
</style>
