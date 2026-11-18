<script setup>
import { computed, ref, onMounted } from 'vue';

const props = defineProps({
  project: {
    default: null,
    type: Object,
  },
  sourceEpicId: {
    default: '',
    type: String,
  },
  storyId: {
    default: '',
    type: String,
  },
  storyName: {
    default: '',
    type: String,
  },
});

const emit = defineEmits(['reassign']);

const modalEl = ref(null);

const destinationEpics = computed(() =>
  (props.project?.epics ?? []).filter((epic) => epic.id && epic.id !== props.sourceEpicId),
);

onMounted(() => {
  // When the modal opens without a selected story, immediately close it.
  modalEl.value?.addEventListener('show.bs.modal', (event) => {
    if (!props.storyId) {
      event.preventDefault();
    }
  });
});
</script>

<template>
  <div
    id="storyReassignModal"
    ref="modalEl"
    class="modal fade"
    tabindex="-1"
    aria-labelledby="storyReassignModalLabel"
    aria-hidden="true"
  >
    <div class="modal-dialog modal-dialog-scrollable">
      <div class="modal-content">
        <div class="modal-header">
          <h5 id="storyReassignModalLabel" class="modal-title">
            Move Story
          </h5>
          <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
        </div>

        <div class="modal-body">
          <p class="muted-copy">
            Choose an epic to move <strong>{{ storyName || 'this story' }}</strong> into.
          </p>

          <div v-if="destinationEpics.length === 0" class="alert alert-secondary">
            There are no other epics available.
          </div>

          <div v-else class="list-group">
            <button
              v-for="epic in destinationEpics"
              :key="epic.id"
              class="list-group-item list-group-item-action d-flex justify-content-between align-items-center"
              type="button"
              data-bs-dismiss="modal"
              @click="emit('reassign', { targetEpicId: epic.id })"
            >
              <span>{{ epic.name }}</span>
              <i class="bi bi-arrow-right"></i>
            </button>
          </div>
        </div>

        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
        </div>
      </div>
    </div>
  </div>
</template>

