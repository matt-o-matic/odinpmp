<script setup>
import { ref } from 'vue';

import RichContentEditor from '../rich-content/RichContentEditor.vue';

// The comment box for Requirements topic discussions and annotation threads: the shared rich
// text editor with the comment tools (shown while typing), Markdown storage with inline
// tags, and @ to tag the people `mentionables` returns. Mod+Enter submits.
const text = defineModel({ default: '', type: String });

defineProps({
  // Id of the visible or visually hidden label that names the box.
  labelledBy: { required: true, type: String },
  mentionables: { default: null, type: Function },
  minHeight: { default: '', type: String },
  placeholder: { default: 'Write a comment. Type @ to tag someone.', type: String },
  submitOnEnter: { default: false, type: Boolean },
});

const emit = defineEmits(['submit']);
const editor = ref(null);

defineExpose({
  focus: (options) => editor.value?.focus(options),
  insertMention: (mention) => editor.value?.insertMention(mention) ?? false,
  scrollIntoView: (options) => editor.value?.scrollIntoView(options),
});
</script>

<template>
  <RichContentEditor
    ref="editor"
    v-model="text"
    compact
    :labelled-by="labelledBy"
    :mentionables="mentionables"
    :min-height="minHeight"
    :placeholder="placeholder"
    storage-format="comment"
    :submit-on-enter="submitOnEnter"
    toolbar-mode="focus"
    toolset="comment"
    @submit="emit('submit')"
  />
</template>
