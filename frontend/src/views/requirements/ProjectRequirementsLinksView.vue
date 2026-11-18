<script setup>
import { computed, reactive, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';

import RequirementsConfirmDialog from '../../components/requirements/RequirementsConfirmDialog.vue';
import RequirementsDialog from '../../components/requirements/RequirementsDialog.vue';
import { apiClient } from '../../lib/auth/index.js';
import { copyText } from '../../lib/clipboard.js';
import { useRequirementsWorkspace } from '../../lib/requirements/requirements-context.js';
import { describeRequirementsError } from '../../lib/requirements/requirements-errors.js';
import {
  canExtendLink,
  canRevokeLink,
  linkExtensionBounds,
  linkLastUsedText,
  linkStatusChip,
  linkValidityText,
  stakeholderLinkOptions,
} from '../../lib/requirements/requirements-links.js';
import { batchHasType, REQUIREMENTS_EVENT_TYPES } from '../../lib/requirements/requirements-live-updates.js';
import { endOfLocalDayIso } from '../../lib/requirements/requirements-time.js';
import { chipToneClass } from '../../lib/requirements/requirements-topics.js';

// Stakeholder links for the client portal. Admins and managers list,
// create, extend, and revoke them. A new link's URL is shown once.
const workspace = useRequirementsWorkspace();

const links = ref([]);
const loaded = ref(false);
const error = ref('');
const create = reactive({ copyStatus: '', error: '', open: false, result: null, saving: false, send: true, stakeholderId: '' });
const extend = reactive({ bounds: null, error: '', link: null, open: false, saving: false, until: '' });
const revoke = reactive({ error: '', link: null, saving: false });

const canManage = computed(() => workspace.abilities.value.manageLinks);
const projectId = computed(() => workspace.projectId.value);
const options = computed(() => stakeholderLinkOptions(workspace.stakeholders.value, links.value));
const rows = computed(() => links.value.map((link) => ({
  chip: linkStatusChip(link),
  lastUsed: linkLastUsedText(link),
  link,
  name: link.stakeholder?.name || link.stakeholder?.email || 'Stakeholder',
  validity: linkValidityText(link),
})).sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })));
const selectedOption = computed(() => options.value.find((option) => option.id === create.stakeholderId) ?? null);
const willSend = computed(() => create.send && Boolean(selectedOption.value?.email));
const sendFailure = computed(() => ({
  'mail-not-configured': 'Email isn’t set up on this server, so nothing was sent.',
  'no-email': 'This stakeholder has no email address, so nothing was sent.',
  'queue-failed': 'The email couldn’t be queued.',
})[create.result?.email?.reason] ?? '');

let sequence = 0;
async function load({ passive = true } = {}) {
  if (!canManage.value || !projectId.value) return;
  const current = ++sequence;
  try {
    const client = passive ? apiClient.passive : apiClient;
    const result = await client.listRequirementsLinks(projectId.value, workspace.token());
    if (current !== sequence) return;
    links.value = result.links ?? [];
    error.value = '';
  } catch (caught) {
    if (current !== sequence) return;
    error.value = describeRequirementsError(caught, 'Unable to load stakeholder links.').message;
  } finally {
    if (current === sequence) loaded.value = true;
  }
}

watch(() => [projectId.value, canManage.value], () => load({ passive: false }), { immediate: true });
watch(workspace.liveBatch, (batch) => {
  if (batchHasType(batch, REQUIREMENTS_EVENT_TYPES.links)) load();
});

function openCreate() {
  Object.assign(create, { copyStatus: '', error: '', open: true, result: null, saving: false, send: true, stakeholderId: options.value[0]?.id ?? '' });
}

function closeCreate() {
  create.open = false;
  create.result = null;
}

async function submitCreate() {
  if (create.result) {
    closeCreate();
    return;
  }
  if (create.saving) return;
  if (!create.stakeholderId) {
    create.error = 'Choose a stakeholder.';
    return;
  }
  create.saving = true;
  create.error = '';
  try {
    const result = await apiClient.createRequirementsLink(projectId.value, { send: willSend.value, stakeholderId: create.stakeholderId }, workspace.token());
    create.result = result;
    await load();
  } catch (caught) {
    create.error = describeRequirementsError(caught, 'Unable to create the link.').message;
  } finally {
    create.saving = false;
  }
}

async function copyUrl() {
  const url = create.result?.url ?? '';
  if (!url) return;
  create.copyStatus = (await copyText(url)) ? 'Link copied.' : 'Copying failed. Select the link and copy it.';
}

function openExtend(link) {
  const bounds = linkExtensionBounds(link);
  Object.assign(extend, { bounds, error: '', link, open: true, saving: false, until: bounds.defaultValue });
}

async function submitExtend() {
  if (extend.saving || !extend.link) return;
  const until = endOfLocalDayIso(extend.until);
  if (!until) {
    extend.error = 'Choose a date.';
    return;
  }
  extend.saving = true;
  extend.error = '';
  try {
    await apiClient.extendRequirementsLink(projectId.value, extend.link.id, { until }, workspace.token());
    extend.open = false;
    workspace.showMessage(`Link for ${extend.link.stakeholder?.name || 'the stakeholder'} extended.`);
    await load();
  } catch (caught) {
    extend.error = describeRequirementsError(caught, 'Unable to extend the link.').message;
  } finally {
    extend.saving = false;
  }
}

function openRevoke(link) {
  Object.assign(revoke, { error: '', link, saving: false });
}

async function submitRevoke() {
  if (revoke.saving || !revoke.link) return;
  revoke.saving = true;
  revoke.error = '';
  try {
    await apiClient.revokeRequirementsLink(projectId.value, revoke.link.id, workspace.token());
    workspace.showMessage(`Link for ${revoke.link.stakeholder?.name || 'the stakeholder'} revoked.`);
    revoke.link = null;
    await load();
  } catch (caught) {
    revoke.error = describeRequirementsError(caught, 'Unable to revoke the link.').message;
  } finally {
    revoke.saving = false;
  }
}
</script>

<template>
  <div class="rq-stack">
    <nav class="rq-breadcrumb" aria-label="Breadcrumb">
      <ol>
        <li><RouterLink :to="{ name: 'project-requirements', params: { projectId } }">Requirements</RouterLink></li>
        <li aria-current="page">Stakeholder links</li>
      </ol>
    </nav>

    <div class="rq-row rq-row--between rq-row--wrap">
      <h2 class="rq-title rq-title--md" tabindex="-1" data-rq-focus>Stakeholder links</h2>
      <button v-if="canManage && options.length" class="primary-button primary-button--compact" type="button" @click="openCreate">
        <i class="bi bi-link-45deg" aria-hidden="true"></i>New link
      </button>
    </div>

    <p v-if="!canManage" class="rq-empty mb-0">Only project admins and managers can manage stakeholder links.</p>

    <template v-else>
      <p class="rq-xs rq-muted mb-0">A link stays valid while its stakeholder has an open topic or round, then for 14 more days. Extend or revoke it here.</p>

      <div v-if="error" class="error-banner rq-row rq-row--between" role="alert">
        <span>{{ error }}</span>
        <button class="ghost-button ghost-button--compact" type="button" @click="load({ passive: false })">Try again</button>
      </div>
      <p v-else-if="!loaded" class="rq-small rq-muted mb-0">Loading links…</p>
      <div v-else-if="!options.length && !rows.length" class="rq-empty">
        <p><strong>No stakeholders on this project yet.</strong></p>
        <p class="rq-small">Add stakeholders in the project settings, then create a link for each one who should take part.</p>
        <RouterLink class="ghost-button ghost-button--compact" :to="{ name: 'project-detail', params: { projectId }, query: { projectSettings: 'stakeholders' } }">
          Open project stakeholders
        </RouterLink>
      </div>
      <p v-else-if="!rows.length" class="rq-empty mb-0">No stakeholder links yet.</p>
      <div v-else class="rq-panel rq-panel--flush rq-register">
        <table class="rq-table rq-small">
          <caption class="visually-hidden">Stakeholder links</caption>
          <thead>
            <tr>
              <th scope="col">Stakeholder</th>
              <th scope="col">Status</th>
              <th scope="col">Valid</th>
              <th scope="col">Last used</th>
              <th scope="col"><span class="visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.link.id">
              <td>
                <strong>{{ row.name }}</strong>
                <span class="rq-xs rq-muted d-block">{{ [row.link.stakeholder?.roleTitle, row.link.stakeholder?.email].filter(Boolean).join(' · ') }}</span>
              </td>
              <td><span class="rq-chip" :class="chipToneClass(row.chip.tone)">{{ row.chip.label }}</span></td>
              <td class="rq-xs">{{ row.validity }}</td>
              <td class="rq-xs rq-muted">{{ row.lastUsed }}</td>
              <td>
                <div class="rq-row rq-row--tight rq-row--wrap" style="justify-content: flex-end">
                  <button
                    v-if="canExtendLink(row.link)"
                    class="ghost-button ghost-button--compact"
                    type="button"
                    :aria-label="`Extend the link for ${row.name}`"
                    @click="openExtend(row.link)"
                  >
                    Extend
                  </button>
                  <button
                    v-if="canRevokeLink(row.link)"
                    class="ghost-button ghost-button--compact ghost-button--danger"
                    type="button"
                    :aria-label="`Revoke the link for ${row.name}`"
                    @click="openRevoke(row.link)"
                  >
                    Revoke
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <RequirementsDialog :busy="create.saving" :open="create.open" :title="create.result ? (create.result.email?.sent ? 'Link sent' : 'Link created') : 'New stakeholder link'" @close="closeCreate" @submit="submitCreate">
      <template v-if="!create.result">
        <div class="rq-field">
          <label for="rq-link-stakeholder">Stakeholder</label>
          <select id="rq-link-stakeholder" v-model="create.stakeholderId" class="form-select">
            <option v-for="option in options" :key="option.id" :value="option.id">{{ option.name }}<template v-if="option.email"> ({{ option.email }})</template></option>
          </select>
          <p v-if="selectedOption?.link" class="rq-field__hint">
            {{ selectedOption.name }} already has a link. A new one is added; earlier links keep working unless you revoke them.
          </p>
        </div>
        <div v-if="selectedOption?.email" class="form-check">
          <input id="rq-link-send" v-model="create.send" class="form-check-input" type="checkbox" />
          <label class="form-check-label" for="rq-link-send">Email the link to {{ selectedOption.email }}</label>
        </div>
        <p v-else-if="selectedOption" class="rq-field__hint mb-0">{{ selectedOption.name }} has no email address. Copy the link and send it yourself.</p>
        <p v-if="create.error" class="error-banner mb-0" role="alert">{{ create.error }}</p>
      </template>
      <template v-else>
        <p v-if="create.result.email?.sent" class="success-banner mb-0" role="status">Sent to {{ create.result.email.recipient }}.</p>
        <p v-else-if="sendFailure" class="error-banner mb-0" role="alert">{{ sendFailure }} Copy the link and send it yourself.</p>
        <p class="rq-small mb-0">
          <template v-if="create.result.email?.sent">You can also copy the link. This is the only time it is shown.</template>
          <template v-else>This is the only time the full link is shown. Copy it now and send it to {{ create.result.link?.stakeholder?.name || 'the stakeholder' }}.</template>
        </p>
        <code class="rq-secret" data-testid="rq-new-link-url">{{ create.result.url }}</code>
        <div class="rq-row rq-row--tight">
          <button class="ghost-button ghost-button--compact" type="button" data-autofocus @click="copyUrl">
            <i class="bi bi-clipboard" aria-hidden="true"></i>Copy link
          </button>
          <span class="rq-xs rq-muted" role="status">{{ create.copyStatus }}</span>
        </div>
      </template>
      <template #footer>
        <template v-if="!create.result">
          <button class="ghost-button" type="button" :disabled="create.saving" @click="closeCreate">Cancel</button>
          <button class="primary-button" type="submit" :disabled="create.saving">
            <template v-if="willSend">{{ create.saving ? 'Sending…' : 'Send link' }}</template>
            <template v-else>{{ create.saving ? 'Creating…' : 'Create link' }}</template>
          </button>
        </template>
        <button v-else class="primary-button" type="submit">Done</button>
      </template>
    </RequirementsDialog>

    <RequirementsDialog :busy="extend.saving" :open="extend.open" title="Extend link" @close="extend.open = false" @submit="submitExtend">
      <div class="rq-field">
        <label for="rq-link-until">Keep valid until</label>
        <input
          id="rq-link-until"
          v-model="extend.until"
          class="form-control"
          :max="extend.bounds?.max"
          :min="extend.bounds?.min"
          type="date"
        />
        <p class="rq-field__hint">The link also stays valid while {{ extend.link?.stakeholder?.name || 'the stakeholder' }} has open work, whichever is later.</p>
      </div>
      <p v-if="extend.error" class="error-banner mb-0" role="alert">{{ extend.error }}</p>
      <template #footer>
        <button class="ghost-button" type="button" :disabled="extend.saving" @click="extend.open = false">Cancel</button>
        <button class="primary-button" type="submit" :disabled="extend.saving">{{ extend.saving ? 'Saving…' : 'Extend link' }}</button>
      </template>
    </RequirementsDialog>

    <RequirementsConfirmDialog
      :busy="revoke.saving"
      confirm-label="Revoke link"
      :error="revoke.error"
      :open="Boolean(revoke.link)"
      title="Revoke this link?"
      @close="revoke.link = null"
      @confirm="submitRevoke"
    >
      <p class="mb-0">{{ revoke.link?.stakeholder?.name || 'The stakeholder' }} loses access right away, including through links already sent by email.</p>
    </RequirementsConfirmDialog>
  </div>
</template>
