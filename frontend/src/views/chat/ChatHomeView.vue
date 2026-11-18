<script setup>
import { useChatShell } from '../../lib/chat/chat-shell.js';

// Odin Chat with nothing open. On a phone the sidebar is this screen (ChatLayout hides it).
const shell = useChatShell();
</script>

<template>
  <section class="chat-home" aria-labelledby="chat-home-title">
    <h1 id="chat-home-title" class="visually-hidden">Odin Chat</h1>
    <p class="chat-home__note">Choose a channel or a conversation.</p>
    <button class="ghost-button" type="button" @click="shell?.openNewMessage()">
      <i class="bi bi-pencil-square" aria-hidden="true"></i> New message
    </button>
  </section>
</template>

<style scoped>
.chat-home { display: grid; justify-items: center; align-content: center; gap: 0.75rem; min-height: 60vh; padding: 2rem 1rem; }
.chat-home__note { margin: 0; color: var(--muted); }
.chat-home .ghost-button { min-height: 2.75rem; }
</style>
