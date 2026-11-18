<script setup>
defineProps({
  // { name, initials, color }
  person: { required: true, type: Object },
  size: { default: 'sm', type: String },
  // Decorative avatars sit next to the visible name; standalone ones announce it.
  standalone: { default: false, type: Boolean },
});
</script>

<template>
  <span
    class="rq-avatar"
    :class="{ 'rq-avatar--sm': size === 'sm' }"
    :style="{ '--c': person.color }"
    :role="standalone ? 'img' : undefined"
    :aria-label="standalone ? person.name : undefined"
    :aria-hidden="standalone ? undefined : 'true'"
  >{{ person.initials }}</span>
</template>
