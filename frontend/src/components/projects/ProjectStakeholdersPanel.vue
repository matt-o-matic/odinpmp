<script setup>
import { computed, nextTick, reactive, ref, watch } from 'vue';
import { apiClient, authSession } from '../../lib/auth/index.js';

import { projectContacts } from '../../lib/assistant/project-contacts.js';
import { buildProjectStakeholderInvitationSummaries } from '../../lib/assistant/project-stakeholders.js';

const props = defineProps({ projectId: { type: String, required: true } });
const canManage = computed(() => ['admin', 'manager'].includes(authSession.state.currentUser?.role));
const contactDialog = ref(null);
const saving = ref(false);
const contactError = ref('');
const contact = reactive({ name: '', email: '', roleTitle: '' });
// The stakeholder being edited, or null when adding one.
const editing = ref(null);
const emailChanged = computed(() => Boolean(editing.value) && contact.email.trim().toLowerCase() !== editing.value.email.toLowerCase());
async function openContact(stakeholder = null) {
  editing.value = stakeholder ? { email: stakeholder.email, id: stakeholder.id } : null;
  Object.assign(contact, { name: stakeholder?.name ?? '', email: stakeholder?.email ?? '', roleTitle: stakeholder?.roleTitle ?? '' });
  contactError.value = '';
  await nextTick();
  contactDialog.value?.showModal();
}
async function saveContact() {
  if (saving.value) return;
  saving.value = true;
  contactError.value = '';
  const payload = { name: contact.name.trim(), email: contact.email.trim(), roleTitle: contact.roleTitle.trim() };
  try {
    const result = editing.value
      ? await apiClient.updateProjectAssistantStakeholderContact(props.projectId, editing.value.id, payload, authSession.state.token)
      : await apiClient.createProjectAssistantStakeholderContact(props.projectId, payload, authSession.state.token);
    projectContacts.setStakeholders(result.stakeholders ?? result.stakeholderContacts ?? []);
    contactDialog.value?.close();
    successMessage.value = editing.value ? 'Stakeholder updated.' : 'Stakeholder added.';
    // Topic assignments carry the name, so read them again after a rename.
    if (editing.value) void projectContacts.load(props.projectId).catch(() => null);
  } catch (error) {
    contactError.value = error.message ?? (editing.value ? 'Unable to save the stakeholder.' : 'Unable to add the stakeholder.');
  } finally {
    saving.value = false;
  }
}

// Review rounds, for each stakeholder's reviews.
const rounds = ref([]);
async function loadRounds() {
  try {
    rounds.value = (await apiClient.listRequirementsRounds(props.projectId, '', authSession.state.token))?.rounds ?? [];
  } catch {
    rounds.value = [];
  }
}
watch(() => props.projectId, loadRounds, { immediate: true });

const TRACK_LABELS = { architecture: 'Functional', experience: 'Experience' };
function reviewLabel(review) {
  return `${TRACK_LABELS[review.track] ?? 'Review'} round ${review.number ?? ''}`.trim();
}
function reviewState(review) {
  if (review.submittedAt) return `Submitted ${formatDateTime(review.submittedAt)}`;
  if (review.roundStatus !== 'open') return 'Round closed before they submitted';
  return review.dueAt ? `Not submitted · due ${formatDateTime(review.dueAt)}` : 'Not submitted';
}
const successMessage = ref('');
const errorMessage = ref('');

const stakeholderSummaries = computed(() => buildProjectStakeholderInvitationSummaries({
  clarifications: projectContacts.state.clarifications,
  rounds: rounds.value,
  stakeholders: projectContacts.state.stakeholders,
}));

function formatDateTime(value) {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return '';
  }

  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
  }).format(date);
}

function stakeholderDisplayName(stakeholder) {
  return stakeholder?.name || stakeholder?.email || 'Stakeholder';
}

function mailStatusBadgeClass(status) {
  if (status === 'sent') {
    return 'text-bg-success';
  }
  if (status === 'failed') {
    return 'text-bg-danger';
  }
  if (status === 'pending') {
    return 'text-bg-warning';
  }
  return 'text-bg-secondary';
}
</script>

<template>
  <section class="workbench-card">
    <div class="workbench-card__header">
      <div>
        <p class="card-eyebrow">Stakeholders</p>
        <h3 class="workbench-card__title">Project stakeholders</h3>
      </div>
      <div class="d-flex flex-wrap gap-2 align-items-center"><span class="muted-copy">{{ stakeholderSummaries.length }} stakeholders</span><button v-if="canManage" class="btn btn-sm btn-primary" type="button" @click="openContact()">Add stakeholder</button></div>
    </div>

    <div v-if="errorMessage" class="error-banner" role="alert" style="margin-top: 0.85rem">{{ errorMessage }}</div>
    <div v-else-if="successMessage" class="success-banner" role="status" style="margin-top: 0.85rem">{{ successMessage }}</div>

    <div v-if="stakeholderSummaries.length === 0" class="empty-state" style="margin-top: 1rem">
      No project stakeholders have been added yet.
    </div>

    <div v-else class="project-stakeholders-panel__grid">
      <article
        v-for="stakeholder in stakeholderSummaries"
        :key="stakeholder.id"
        class="project-stakeholders-panel__card"
      >
        <header class="project-stakeholders-panel__card-head">
          <div>
            <h4 class="project-stakeholders-panel__card-title">{{ stakeholderDisplayName(stakeholder) }}</h4>
            <p v-if="stakeholder.email" class="field-note mb-0">{{ stakeholder.email }}</p>
            <p v-if="stakeholder.roleTitle" class="field-note mb-0">{{ stakeholder.roleTitle }}</p>
          </div>
          <div class="project-stakeholders-panel__card-actions">
            <span class="badge text-bg-light">{{ stakeholder.assignedClarificationCount }} clarifications</span>
            <span class="badge text-bg-light">{{ stakeholder.reviews.length }} {{ stakeholder.reviews.length === 1 ? 'review' : 'reviews' }}</span>
            <button
              v-if="canManage"
              class="btn btn-sm btn-outline-secondary"
              type="button"
              :aria-label="`Edit ${stakeholderDisplayName(stakeholder)}`"
              @click="openContact(stakeholder)"
            >Edit</button>
          </div>
        </header>

        <div v-if="stakeholder.invitations.length === 0" class="field-note">
          No active clarification invitations for this stakeholder.
        </div>

        <div v-else class="project-stakeholders-panel__invitation-list">
          <article
            v-for="invitation in stakeholder.invitations"
            :key="`${stakeholder.id}:${invitation.clarificationId}`"
            class="project-stakeholders-panel__invitation"
          >
            <p class="project-stakeholders-panel__invitation-prompt">{{ invitation.prompt }}</p>

            <details class="project-stakeholders-panel__details">
              <summary>Reply-by-email details</summary>
              <div class="project-stakeholders-panel__details-body">
                <span
                  v-if="invitation.mailStatus"
                  class="badge"
                  :class="mailStatusBadgeClass(invitation.mailStatus)"
                >
                  {{ invitation.mailStatus }}
                </span>
                <p v-if="invitation.queuedAt" class="field-note mb-0">Queued {{ formatDateTime(invitation.queuedAt) }}</p>
                <p v-if="invitation.sentAt" class="field-note mb-0">Sent {{ formatDateTime(invitation.sentAt) }}</p>
                <p v-if="invitation.lastInboundAt" class="field-note mb-0">Last inbound {{ formatDateTime(invitation.lastInboundAt) }}</p>
              </div>
            </details>
          </article>
        </div>

        <div v-if="stakeholder.reviews.length" class="project-stakeholders-panel__reviews">
          <p class="project-stakeholders-panel__section-label">Reviews</p>
          <ul class="project-stakeholders-panel__review-list">
            <li v-for="review in stakeholder.reviews" :key="review.roundId" class="project-stakeholders-panel__review">
              <RouterLink
                class="project-stakeholders-panel__review-link"
                :to="{ name: 'project-requirements-round', params: { projectId, roundId: review.roundId } }"
              >{{ reviewLabel(review) }}<template v-if="review.title"> · {{ review.title }}</template></RouterLink>
              <span class="field-note">
                {{ reviewState(review) }}<template v-if="review.required"> · required</template><template v-if="review.mailStatus && !review.submittedAt"> · invitation {{ review.mailStatus }}</template>
              </span>
            </li>
          </ul>
        </div>
      </article>
    </div>
    <dialog ref="contactDialog" aria-labelledby="stakeholder-dialog-title" class="stakeholder-dialog">
      <form @submit.prevent="saveContact">
        <h3 id="stakeholder-dialog-title">{{ editing ? 'Edit stakeholder' : 'Add stakeholder' }}</h3>
        <div v-if="contactError" class="alert alert-danger" role="alert">{{ contactError }}</div>
        <label>Name<input v-model="contact.name" class="form-control" required maxlength="255" autofocus /></label>
        <label>Email<input v-model="contact.email" class="form-control" type="email" required maxlength="255" /></label>
        <label>Role or title<input v-model="contact.roleTitle" class="form-control" maxlength="160" /></label>
        <p v-if="emailChanged" class="field-note mb-0">Odin sends their next emails to the new address. Links and reply addresses already sent keep working.</p>
        <footer class="d-flex justify-content-end gap-2">
          <button class="btn btn-outline-secondary" type="button" @click="contactDialog?.close()">Cancel</button>
          <button class="btn btn-primary" type="submit" :disabled="saving">{{ saving ? 'Saving…' : editing ? 'Save changes' : 'Add stakeholder' }}</button>
        </footer>
      </form>
    </dialog>
  </section>
</template>

<style scoped>
.stakeholder-dialog { width: min(30rem, calc(100vw - 2rem)); border: 1px solid var(--line); border-radius: .5rem; background: var(--bs-body-bg); color: var(--bs-body-color); padding: 1rem; }
.stakeholder-dialog::backdrop { background: rgba(0, 0, 0, .5); }
.stakeholder-dialog form, .stakeholder-dialog label { display: grid; gap: .5rem; }
.stakeholder-dialog form { gap: .75rem; }
.stakeholder-dialog h3 { font-size: 1.125rem; }
button, .btn, input { min-height: 2.75rem; }
:focus-visible { outline: 3px solid var(--bs-primary); outline-offset: 2px; }
.project-stakeholders-panel__card { overflow-wrap: anywhere; min-width: 0; }

.project-stakeholders-panel__grid {
  display: grid;
  gap: 1rem;
  margin-top: 1rem;
}

.project-stakeholders-panel__card {
  border: 1px solid var(--line);
  border-radius: 1rem;
  background: var(--surface-soft);
  padding: 1rem;
}

.project-stakeholders-panel__card-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.85rem;
  margin-bottom: 0.9rem;
}

.project-stakeholders-panel__card-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 0.5rem;
}

.project-stakeholders-panel__reviews {
  margin-top: 0.9rem;
}

.project-stakeholders-panel__section-label {
  margin: 0 0 0.4rem;
  color: var(--muted);
  font-size: 0.9rem;
  font-weight: 600;
}

.project-stakeholders-panel__review-list {
  display: grid;
  gap: 0.5rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.project-stakeholders-panel__review {
  display: grid;
  gap: 0.15rem;
}

.project-stakeholders-panel__review-link {
  font-weight: 600;
}

.project-stakeholders-panel__card-title {
  margin: 0;
  font-size: 1rem;
}

.project-stakeholders-panel__invitation-list {
  display: grid;
  gap: 0.85rem;
}

.project-stakeholders-panel__invitation {
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-radius: 0.9rem;
  background: #fff;
  padding: 0.9rem;
}

.project-stakeholders-panel__invitation-prompt {
  margin: 0 0 0.6rem;
  font-weight: 600;
}

.project-stakeholders-panel__details {
  margin-top: 0.15rem;
}

.project-stakeholders-panel__details summary {
  cursor: pointer;
  color: var(--muted);
  font-size: 0.9rem;
  font-weight: 600;
}

.project-stakeholders-panel__details-body {
  display: grid;
  gap: 0.35rem;
  margin-top: 0.6rem;
}

@media (max-width: 840px) {
  .project-stakeholders-panel__card-head {
    flex-direction: column;
  }
}
</style>
