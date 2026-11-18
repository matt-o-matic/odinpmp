<script setup>
// Three pulsing dots: the assistant is working.
defineProps({ small: { default: false, type: Boolean } });
</script>

<template>
  <span class="typing-dots" :class="{ 'typing-dots--small': small }" aria-hidden="true"><span></span><span></span><span></span></span>
</template>

<style scoped>
.typing-dots {
  align-items: center;
  display: inline-flex;
  gap: 0.25rem;
  height: 1rem;
}

.typing-dots span {
  animation: typing-dot 1.2s infinite ease-in-out;
  background: var(--accent);
  border-radius: 50%;
  height: 0.45rem;
  opacity: 0.3;
  width: 0.45rem;
}

.typing-dots span:nth-child(2) {
  animation-delay: 0.15s;
}

.typing-dots span:nth-child(3) {
  animation-delay: 0.3s;
}

.typing-dots--small {
  gap: 0.18rem;
}

.typing-dots--small span {
  height: 0.32rem;
  width: 0.32rem;
}

@keyframes typing-dot {
  0%,
  80%,
  100% {
    opacity: 0.3;
    transform: translateY(0);
  }

  40% {
    opacity: 1;
    transform: translateY(-0.2rem);
  }
}

@media (prefers-reduced-motion: reduce) {
  .typing-dots span {
    animation: typing-dot-fade 1.6s infinite ease-in-out;
  }

  @keyframes typing-dot-fade {
    0%,
    100% {
      opacity: 0.35;
    }

    50% {
      opacity: 0.9;
    }
  }
}
</style>
