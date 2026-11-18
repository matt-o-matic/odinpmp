<script setup>
import { computed, ref, useId, watch } from 'vue';

import { apiClient, authSession } from '../../lib/auth/index.js';
import { onProjectRefresh } from '../../lib/live/live-refresh.js';
import {
  RELATION_CHOICES,
  flattenProjectItems,
  groupRelations,
  itemTypeMeta,
  relatedItemRoute,
  relationCandidates,
  relationCreateRequest,
} from '../../lib/projects/work-item-relations.js';
import RequirementsConfirmDialog from '../requirements/RequirementsConfirmDialog.vue';
import RequirementsDialog from '../requirements/RequirementsDialog.vue';

// Typed links (blocks, caused by, affects, duplicate of) between this item and others in
// the same project. The list API says whether the reader may add or remove them.
const props = defineProps({
  itemId: { required: true, type: String },
  itemName: { default: '', type: String },
  projectId: { required: true, type: String },
});

const CANDIDATE_LIMIT = 50;
const uid = useId();
const headingId = `${uid}-relations`;
const choiceId = `${uid}-relation-choice`;
const searchId = `${uid}-relation-search`;

const relations = ref([]);
const canEdit = ref(false);
const loading = ref(false);
const loadError = ref('');

const addOpen = ref(false);
const choiceKey = ref(RELATION_CHOICES[0].key);
const query = ref('');
const selectedId = ref('');
const projectItems = ref([]);
const itemsLoading = ref(false);
const saving = ref(false);
const addError = ref('');

const removal = ref(null);
const removing = ref(false);
const removeError = ref('');

const token = () => authSession.state.token;
const groups = computed(() => groupRelations(relations.value));
const itemSaved = computed(() => projectItems.value.some((item) => item.id === props.itemId));
const candidates = computed(() => relationCandidates({
  choiceKey: choiceKey.value,
  itemId: props.itemId,
  items: projectItems.value,
  query: query.value,
  relations: relations.value,
}));
const shownCandidates = computed(() => candidates.value.slice(0, CANDIDATE_LIMIT));
const choiceLabel = computed(() => RELATION_CHOICES.find((choice) => choice.key === choiceKey.value)?.label ?? '');

// `quiet` reloads after someone else's change: in the background, keeping the list on failure,
// and dropped if the panel has moved to another item meanwhile.
async function loadRelations({ quiet = false } = {}) {
  if (!props.projectId || !props.itemId) return;
  if (!quiet) {
    loading.value = true;
    loadError.value = '';
  }
  const { itemId, projectId } = props;
  try {
    const result = await (quiet ? apiClient.passive : apiClient).listWorkItemRelations(projectId, itemId, token());
    if (quiet && (itemId !== props.itemId || projectId !== props.projectId)) return;
    relations.value = result.relations ?? [];
    canEdit.value = result.canEdit === true;
  } catch (error) {
    if (quiet) return;
    relations.value = [];
    canEdit.value = false;
    loadError.value = error.message ?? 'Unable to load related work.';
  } finally {
    if (!quiet) loading.value = false;
  }
}

async function openAdd() {
  choiceKey.value = RELATION_CHOICES[0].key;
  query.value = '';
  selectedId.value = '';
  addError.value = '';
  addOpen.value = true;
  itemsLoading.value = true;
  try {
    // Read the saved project, not a local draft: only saved items can be linked.
    const result = await apiClient.getProject(props.projectId, token());
    projectItems.value = flattenProjectItems(result.project);
  } catch (error) {
    projectItems.value = [];
    addError.value = error.message ?? 'Unable to load this project\'s items.';
  } finally {
    itemsLoading.value = false;
  }
}

function closeAdd() {
  if (!saving.value) addOpen.value = false;
}

async function submitAdd() {
  if (saving.value) return;
  if (!selectedId.value) {
    addError.value = 'Choose the related item.';
    return;
  }
  saving.value = true;
  addError.value = '';
  try {
    const request = relationCreateRequest({ choiceKey: choiceKey.value, itemId: props.itemId, otherItemId: selectedId.value });
    await apiClient.createWorkItemRelation(props.projectId, request.fromItemId, request.payload, token());
    addOpen.value = false;
    await loadRelations();
  } catch (error) {
    addError.value = error.message ?? 'Unable to add the relation.';
  } finally {
    saving.value = false;
  }
}

function askRemove(relation, label) {
  removeError.value = '';
  removal.value = { label, name: relation.relatedItem?.name || 'this item', relation };
}

function closeRemove() {
  if (!removing.value) removal.value = null;
}

async function confirmRemove() {
  if (!removal.value || removing.value) return;
  removing.value = true;
  removeError.value = '';
  try {
    await apiClient.deleteWorkItemRelation(props.projectId, removal.value.relation.id, token());
    removal.value = null;
    await loadRelations();
  } catch (error) {
    removeError.value = error.message ?? 'Unable to remove the relation.';
  } finally {
    removing.value = false;
  }
}

watch(choiceKey, () => {
  if (selectedId.value && !candidates.value.some((item) => item.id === selectedId.value)) selectedId.value = '';
});
watch(() => [props.projectId, props.itemId], () => {
  relations.value = [];
  canEdit.value = false;
  loadRelations();
}, { immediate: true });
onProjectRefresh(() => loadRelations({ quiet: true }));
</script>

<template>
  <section class="item-relations" :aria-labelledby="headingId">
    <header class="item-relations__head">
      <div>
        <p class="card-eyebrow">Relations</p>
        <h3 :id="headingId" class="item-relations__title">Related work</h3>
      </div>
      <button v-if="canEdit" class="ghost-button item-relations__add" type="button" @click="openAdd">
        <i class="bi bi-link-45deg" aria-hidden="true"></i>
        <span>Add relation</span>
      </button>
    </header>

    <p v-if="loading && relations.length === 0" class="item-relations__note" role="status">Loading related work…</p>
    <p v-else-if="loadError" class="error-banner mb-0" role="alert">{{ loadError }}</p>
    <p v-else-if="relations.length === 0" class="item-relations__note">No related work yet.</p>
    <div v-else class="item-relations__groups">
      <section v-for="group in groups" :key="group.key" class="item-relations__group">
        <h4 class="item-relations__label">{{ group.label }}</h4>
        <ul class="item-relations__list">
          <li v-for="relation in group.relations" :key="relation.id" class="item-relations__row">
            <span class="item-relations__item">
              <span class="item-relations__type">
                <i :class="['bi', itemTypeMeta(relation.relatedItem.itemType).icon]" aria-hidden="true"></i>
                {{ itemTypeMeta(relation.relatedItem.itemType).label }}
              </span>
              <RouterLink
                v-if="relation.relatedItem.available"
                class="item-relations__link"
                :to="relatedItemRoute(projectId, relation.relatedItem)"
              >{{ relation.relatedItem.name || 'Untitled item' }}</RouterLink>
              <span v-else class="item-relations__missing">Item no longer available</span>
              <span v-if="relation.relatedItem.status" class="item-relations__status">{{ relation.relatedItem.status }}</span>
            </span>
            <button
              v-if="canEdit"
              class="item-relations__remove"
              type="button"
              :aria-label="`Remove relation: ${group.label} ${relation.relatedItem.name || 'item'}`"
              @click="askRemove(relation, group.label)"
            >
              <i class="bi bi-x-lg" aria-hidden="true"></i>
            </button>
          </li>
        </ul>
      </section>
    </div>

    <RequirementsDialog :busy="saving" :open="addOpen" title="Add relation" @close="closeAdd" @submit="submitAdd">
      <p v-if="itemName" class="rq-field__hint mb-0">Linking “{{ itemName }}” to another item in this project.</p>
      <div class="rq-field">
        <label :for="choiceId">This item</label>
        <select :id="choiceId" v-model="choiceKey" class="form-select" data-autofocus>
          <option v-for="choice in RELATION_CHOICES" :key="choice.key" :value="choice.key">{{ choice.label }}</option>
        </select>
      </div>
      <div class="rq-field">
        <label :for="searchId">Find the related item</label>
        <input :id="searchId" v-model="query" autocomplete="off" class="form-control" placeholder="Search by name or type" type="search" />
      </div>
      <p v-if="itemsLoading" class="rq-field__hint" role="status">Loading items…</p>
      <p v-else-if="projectItems.length && !itemSaved" class="rq-field__hint">Save this item before linking it.</p>
      <fieldset v-else-if="projectItems.length" class="rq-field">
        <legend>Related item ({{ choiceLabel }})</legend>
        <ul v-if="shownCandidates.length" class="rq-checklist item-relations__candidates">
          <li v-for="item in shownCandidates" :key="item.id">
            <label>
              <input v-model="selectedId" class="form-check-input mt-0" name="related-item" type="radio" :value="item.id" />
              <i :class="['bi', itemTypeMeta(item.itemType).icon]" aria-hidden="true"></i>
              <span class="item-relations__candidate-name">{{ item.name || 'Untitled item' }}</span>
              <span class="item-relations__candidate-meta">{{ itemTypeMeta(item.itemType).label }}<template v-if="item.status"> · {{ item.status }}</template></span>
            </label>
          </li>
        </ul>
        <p v-else class="rq-field__hint">No matching items in this project.</p>
        <p v-if="candidates.length > shownCandidates.length" class="rq-field__hint">
          Showing the first {{ shownCandidates.length }} of {{ candidates.length }} matches. Refine the search to find more.
        </p>
      </fieldset>
      <p v-if="addError" class="error-banner mb-0" role="alert">{{ addError }}</p>
      <template #footer>
        <button class="ghost-button" type="button" :disabled="saving" @click="closeAdd">Cancel</button>
        <button class="primary-button" type="submit" :disabled="saving || itemsLoading || !itemSaved">{{ saving ? 'Adding…' : 'Add relation' }}</button>
      </template>
    </RequirementsDialog>

    <RequirementsConfirmDialog
      :busy="removing"
      confirm-label="Remove relation"
      :error="removeError"
      :open="Boolean(removal)"
      title="Remove relation?"
      @close="closeRemove"
      @confirm="confirmRemove"
    >
      <p v-if="removal" class="mb-0">
        Remove “{{ removal.label }} {{ removal.name }}”? Both items stay as they are; only the link is removed.
      </p>
    </RequirementsConfirmDialog>
  </section>
</template>

<style scoped>
.item-relations { display: grid; gap: 0.75rem; font-size: 0.875rem; }
.item-relations__head { display: flex; flex-wrap: wrap; align-items: start; justify-content: space-between; gap: 0.75rem; }
/* The legacy stylesheet sizes and underlines every h3/h4 with !important. */
.item-relations__title { margin: 0; padding: 0; border-bottom: 0; font-family: var(--font-display); font-size: 1.05rem !important; }
.item-relations__add { display: inline-flex; align-items: center; gap: 0.35rem; min-height: 2.75rem; }
.item-relations__note { margin: 0; color: var(--muted); }
.item-relations__groups { display: grid; gap: 0.75rem; }
.item-relations__label { margin: 0 0 0.35rem; padding: 0; color: var(--muted); font-size: 0.75rem !important;font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
.item-relations__list { display: grid; gap: 0.35rem; margin: 0; padding: 0; list-style: none; }
.item-relations__row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 0.5rem; min-height: 2.75rem; padding: 0.25rem 0.25rem 0.25rem 0.6rem; border: 1px solid var(--line); border-radius: 0.4rem; background: var(--surface); color: var(--ink); }
.item-relations__item { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 0.6rem; min-width: 0; padding-block: 0.25rem; }
.item-relations__type { display: inline-flex; align-items: center; gap: 0.3rem; color: var(--muted); font-size: 0.75rem; font-weight: 600; }
.item-relations__link { flex: 1 1 12rem; min-width: 0; color: var(--accent); font-weight: 600; overflow-wrap: anywhere; }
html.dark .item-relations__link { color: var(--accent-bright); }
.item-relations__missing { flex: 1 1 12rem; color: var(--muted); font-style: italic; }
.item-relations__status { padding: 0.1rem 0.45rem; border-radius: 999px; background: var(--surface-soft); color: var(--ink-soft); font-size: 0.75rem; }
.item-relations__remove { display: inline-grid; place-items: center; width: 2.75rem; height: 2.75rem; border: 0; border-radius: 0.375rem; background: transparent; color: var(--muted); }
.item-relations__remove:hover { background: var(--surface-soft); color: var(--danger); }
.item-relations__remove:focus-visible,
.item-relations__add:focus-visible,
.item-relations__link:focus-visible { outline: 0.18rem solid var(--accent); outline-offset: 0.1rem; }
.item-relations__candidates { max-height: 16rem; }
.item-relations__candidates label { min-height: 2.75rem; }
.item-relations__candidates input { flex: 0 0 auto; width: 1rem; height: 1rem; min-height: 0; }
.item-relations__candidate-name { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.item-relations__candidate-meta { color: var(--muted); font-size: 0.75rem; white-space: nowrap; }
</style>
