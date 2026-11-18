<script setup>
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import NotificationLevelSettings from '../components/users/NotificationLevelSettings.vue';
import TwoFactorSettings from '../components/users/TwoFactorSettings.vue';
import { apiClient, authSession } from '../lib/auth/index.js';
import { normalizeAvatarUpload } from '../lib/users/avatar-upload.js';
import { START_PAGES } from '../lib/chat/chat.js';
import { EMAIL_NOTIFICATION_TOGGLES, effectiveEmailNotifications, preferencesForSave } from '../lib/users/notification-preferences.js';

const PROFILE_TABS = [
  { key: 'profile', label: 'Profile', pane: 'profile-info' },
  { key: 'contact', label: 'Contact', pane: 'contact-info' },
  { key: 'preferences', label: 'Preferences', pane: 'preferences' },
  // Channel levels apply at once, so this tab has nothing for Save Changes.
  { key: 'notifications', label: 'Notifications', pane: 'notification-levels' },
  { key: 'security', label: 'Security', pane: 'security' },
];

const route = useRoute();
const router = useRouter();

function tabFromQuery(value) {
  return PROFILE_TABS.some((tab) => tab.key === value) ? value : 'profile';
}

const activeTab = ref(tabFromQuery(route.query.tab));
watch(() => route.query.tab, (value) => { activeTab.value = tabFromQuery(value); });

// The tab is kept in the URL so /user?tab=security (and the old /settings link) open it directly.
function selectTab(key) {
  activeTab.value = key;
  const { tab: _tab, ...query } = route.query;
  router.replace({ query: key === 'profile' ? query : { ...query, tab: key } });
}

async function moveTab(step) {
  const index = PROFILE_TABS.findIndex((tab) => tab.key === activeTab.value);
  const next = PROFILE_TABS[(index + step + PROFILE_TABS.length) % PROFILE_TABS.length];
  selectTab(next.key);
  await nextTick();
  document.getElementById(`${next.pane}-tab`)?.focus();
}

const busy = ref(false);
const loading = ref(false);
const errorMessage = ref('');
const successMessage = ref('');
// A new email address waits for its emailed link; until then the account keeps its own.
const pendingEmail = ref('');
const sessions = ref([]);
const avatarInput = ref(null);
const avatarPreview = ref('');
const timezones = ref([]);

const canEditSecurity = computed(() => authSession.state.currentUser?.authMethod === 'basic');

const form = reactive({
  aboutMe: '',
  base64Avatar: '',
  confirmNewPassword: '',
  currentPassword: '',
  department: '',
  email: '',
  firstName: '',
  language: 'en',
  lastName: '',
  newPassword: '',
  preferences: {
    darkMode: false,
    // Where Odin opens: Odin, or Odin Chat.
    startPage: 'odin',
    ...effectiveEmailNotifications(),
  },
  profileDisplayName: '',
  phone: '',
  timezone: 'America/New_York',
  title: '',
});

function resolvePicture(picture) {
  const value = String(picture ?? '').trim();
  if (!value) return '';
  if (/^(https?:|data:)/i.test(value)) return value;
  const base = authSession.state.apiBaseUrl?.replace(/\/$/, '') ?? '';
  return `${base}${value.startsWith('/') ? '' : '/'}${value}`;
}

const currentPicture = computed(() => resolvePicture(avatarPreview.value || form.base64Avatar || authSession.state.currentUser?.picture));

function loadTimezones() {
  const supported = typeof Intl !== 'undefined' && typeof Intl.supportedValuesOf === 'function'
    ? Intl.supportedValuesOf('timeZone')
    : [];

  if (supported.length > 0) {
    timezones.value = supported;
    return;
  }

  timezones.value = [
    'UTC',
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'Europe/London',
  ];
}

function normalizeNameSeed(profile) {
  const name = String(profile?.name ?? authSession.state.currentUser?.name ?? '').trim();
  if (!name) return { first: '', last: '' };
  const parts = name.split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: parts[0] };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

async function loadProfile() {
  if (!authSession.state.token) {
    return;
  }

  loading.value = true;
  errorMessage.value = '';
  successMessage.value = '';

  try {
    const result = await apiClient.getUserProfile(authSession.state.token);
    const profile = result.user;
    const seed = normalizeNameSeed(profile);

    form.profileDisplayName = profile.profileDisplayName || profile.name || '';
    form.firstName = profile.firstName || seed.first;
    form.lastName = profile.lastName || seed.last;
    form.title = profile.title || '';
    form.department = profile.department || '';
    form.aboutMe = profile.bio || '';
    form.email = profile.email || authSession.state.currentUser?.email || '';
    form.phone = profile.phone || '';
    form.timezone = profile.timezone || 'America/New_York';
    form.base64Avatar = profile.picture || '';
    form.preferences = {
      ...form.preferences,
      ...(profile.preferences ?? {}),
      ...effectiveEmailNotifications(profile.preferences),
    };
    form.language = profile.preferences?.language || form.language;

    sessions.value = result.sessions ?? [];
    pendingEmail.value = result.pendingEmail ?? '';
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to load profile.';
  } finally {
    loading.value = false;
  }
}

function triggerAvatarPick() {
  avatarInput.value?.click();
}

async function handleAvatarSelected(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  errorMessage.value = '';

  try {
    const normalized = await normalizeAvatarUpload(file);
    avatarPreview.value = normalized.dataUrl;
    form.base64Avatar = normalized.dataUrl;
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to process the selected image.';
  }

  event.target.value = '';
}

async function saveProfile() {
  if (!authSession.state.token) {
    return;
  }

  busy.value = true;
  errorMessage.value = '';
  successMessage.value = '';

  try {
    const payload = {
      ...form,
      preferences: preferencesForSave({
        ...form.preferences,
        language: form.language,
      }),
    };
    // Saving a new password is a password change, which blocks like other credential actions.
    const client = form.newPassword ? apiClient.blocking : apiClient;
    const result = await client.updateUserProfile(payload, authSession.state.token);
    const asked = String(form.email ?? '').trim().toLowerCase();
    pendingEmail.value = result.pendingEmail ?? '';
    form.email = result.user?.email ?? form.email;
    successMessage.value = pendingEmail.value && asked === pendingEmail.value
      ? `Saved. We sent a link to ${pendingEmail.value}. Your email changes when you open it.`
      : 'Saved.';

    // Keep navbar/user session in sync.
    if (authSession.state.currentUser) {
      authSession.state.currentUser = {
        ...authSession.state.currentUser,
        ...result.user,
        preferences: {
          ...(authSession.state.currentUser.preferences ?? {}),
          ...(result.user?.preferences ?? {}),
        },
      };
    }
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to save profile.';
  } finally {
    busy.value = false;
  }
}

async function killSession(sessionId) {
  if (!authSession.state.token) return;
  busy.value = true;
  errorMessage.value = '';
  successMessage.value = '';

  try {
    await apiClient.killUserSession({ tgtSession: sessionId }, authSession.state.token);
    await loadProfile();
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to terminate session.';
  } finally {
    busy.value = false;
  }
}

onMounted(() => {
  loadTimezones();
  loadProfile();
});
</script>

<template>
  <div class="container-fluid mt-4 mb-5" style="padding-bottom: 110px">
    <h1 class="mb-4"><i class="bi bi-person-circle me-2"></i>User Profile Configuration</h1>

    <div v-if="errorMessage" class="alert alert-danger">{{ errorMessage }}</div>
    <div v-if="successMessage" class="alert alert-success save-alert">{{ successMessage }}</div>

    <div class="row">
      <div class="col-12 col-md-3 mb-4">
        <div class="card shadow-sm">
          <div class="card-body text-center">
            <div class="profile-image-container mx-auto">
              <img v-if="currentPicture" :src="currentPicture" alt="User Avatar" />
              <div v-else class="rounded-circle border bg-light d-inline-block" style="width: 120px; height: 120px;"></div>
              <div class="upload-icon-container" role="button" tabindex="0" aria-label="Change profile photo" @click="triggerAvatarPick" @keydown.enter.prevent="triggerAvatarPick" @keydown.space.prevent="triggerAvatarPick">
                <i class="bi bi-camera" aria-hidden="true"></i>
              </div>
            </div>

            <input ref="avatarInput" type="file" accept="image/*" hidden @change="handleAvatarSelected" />

            <h5 class="mb-0">{{ form.profileDisplayName }}</h5>
            <small class="text-muted">{{ form.email }}</small>

            <div v-if="activeTab !== 'notifications'" class="mt-3 d-grid gap-2">
              <button class="btn btn-sm btn-primary" type="button" :disabled="busy" @click="saveProfile">
                {{ busy ? 'Saving…' : 'Save Changes' }}
              </button>
            </div>
          </div>
        </div>

        <div class="card shadow-sm mt-3">
          <div class="card-body">
            <div class="d-flex justify-content-between align-items-center">
              <h6 class="mb-0">Active Sessions</h6>
              <button class="btn btn-sm btn-outline-secondary" type="button" :disabled="busy" @click="loadProfile">
                Refresh
              </button>
            </div>

            <div v-if="loading" class="d-flex justify-content-center py-3">
              <div class="spinner-border spinner-border-sm" role="status" aria-label="Loading"></div>
            </div>

            <div v-else class="list-group list-group-flush mt-2">
              <div v-for="session in sessions" :key="session.id" class="list-group-item position-relative">
                <div class="small text-muted">{{ session.locationName }}</div>
                <div class="small">{{ session.ipAddr }}</div>
                <div class="small text-muted">{{ new Date(session.expiryDate).toLocaleString() }}</div>
                <button
                  class="btn btn-sm btn-outline-danger mt-2"
                  type="button"
                  :disabled="busy"
                  @click="killSession(session.id)"
                >
                  End session
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="col-12 col-md-9">
        <div class="card shadow-sm">
          <div class="card-body">
            <ul class="nav nav-tabs" role="tablist" @keydown.right.prevent="moveTab(1)" @keydown.left.prevent="moveTab(-1)">
              <li v-for="tab in PROFILE_TABS" :key="tab.key" class="nav-item" role="presentation">
                <button
                  :id="`${tab.pane}-tab`"
                  class="nav-link"
                  :class="{ active: activeTab === tab.key }"
                  type="button"
                  role="tab"
                  :aria-controls="tab.pane"
                  :aria-selected="activeTab === tab.key ? 'true' : 'false'"
                  :tabindex="activeTab === tab.key ? 0 : -1"
                  @click="selectTab(tab.key)"
                >
                  {{ tab.label }}
                </button>
              </li>
            </ul>

            <div class="tab-content p-3 border border-top-0">
              <div id="profile-info" class="tab-pane fade" :class="{ 'show active': activeTab === 'profile' }" role="tabpanel" aria-labelledby="profile-info-tab">
                <div class="row form-section">
                  <div class="col-md-6 mb-3">
                    <label class="form-label">Display Name</label>
                    <input v-model="form.profileDisplayName" class="form-control" type="text" />
                  </div>
                  <div class="col-md-6 mb-3"></div>
                  <div class="col-md-6 mb-3">
                    <label class="form-label">First Name</label>
                    <input v-model="form.firstName" class="form-control" type="text" />
                  </div>
                  <div class="col-md-6 mb-3">
                    <label class="form-label">Last Name</label>
                    <input v-model="form.lastName" class="form-control" type="text" />
                  </div>
                  <div class="col-md-6 mb-3">
                    <label class="form-label">Title</label>
                    <input v-model="form.title" class="form-control" type="text" />
                  </div>
                  <div class="col-md-6 mb-3">
                    <label class="form-label">Department</label>
                    <input v-model="form.department" class="form-control" type="text" />
                  </div>
                  <div class="col-12 mb-3">
                    <label class="form-label">About Me</label>
                    <textarea v-model="form.aboutMe" class="form-control" rows="4"></textarea>
                  </div>
                </div>
              </div>

              <div id="contact-info" class="tab-pane fade" :class="{ 'show active': activeTab === 'contact' }" role="tabpanel" aria-labelledby="contact-info-tab">
                <div class="row form-section">
                  <div class="col-md-6 mb-3">
                    <label class="form-label" for="profile-email">Email Address</label>
                    <input id="profile-email" v-model="form.email" class="form-control" type="email" :aria-describedby="pendingEmail ? 'profile-email-pending' : undefined" />
                    <small v-if="pendingEmail" id="profile-email-pending" class="form-text">Waiting for you to confirm {{ pendingEmail }}. Open the link we sent there; until then this address stays.</small>
                  </div>
                  <div class="col-md-6 mb-3">
                    <label class="form-label">Phone Number</label>
                    <input v-model="form.phone" class="form-control" type="text" />
                  </div>
                  <div class="col-md-6 mb-3">
                    <label class="form-label">Time Zone</label>
                    <select v-model="form.timezone" class="form-select">
                      <option v-for="tz in timezones" :key="tz" :value="tz">{{ tz }}</option>
                    </select>
                  </div>
                </div>
              </div>

              <div id="preferences" class="tab-pane fade" :class="{ 'show active': activeTab === 'preferences' }" role="tabpanel" aria-labelledby="preferences-tab">
                <div class="row form-section">
                  <div class="col-md-6 mb-3">
                    <label class="form-label">Language</label>
                    <select v-model="form.language" class="form-select">
                      <option value="en">English</option>
                    </select>
                  </div>
                  <div class="col-md-6 mb-3 d-flex align-items-end">
                    <div class="form-check">
                      <input id="darkMode" v-model="form.preferences.darkMode" class="form-check-input" type="checkbox" />
                      <label class="form-check-label" for="darkMode">Dark mode</label>
                    </div>
                  </div>
                  <div class="col-md-6 mb-3">
                    <label class="form-label" for="startPage">Start page</label>
                    <select id="startPage" v-model="form.preferences.startPage" class="form-select" aria-describedby="startPage-help">
                      <option v-for="page in START_PAGES" :key="page.value" :value="page.value">{{ page.label }}</option>
                    </select>
                    <p id="startPage-help" class="notification-settings__help">Where Odin opens when you sign in or open it from its address.</p>
                  </div>

                  <fieldset class="col-12 notification-settings">
                    <legend class="notification-settings__legend">Email me when</legend>
                    <div v-for="toggle in EMAIL_NOTIFICATION_TOGGLES" :key="toggle.key" class="form-check notification-settings__item">
                      <input :id="toggle.id" v-model="form.preferences[toggle.key]" class="form-check-input" type="checkbox" :aria-describedby="toggle.id + '-help'" />
                      <label class="form-check-label" :for="toggle.id">{{ toggle.label }}</label>
                      <p :id="toggle.id + '-help'" class="notification-settings__help">{{ toggle.help }}</p>
                    </div>
                    <p class="notification-settings__note">Emails you need in order to act, such as confirmation links, invitations and answers to your own requests, are always sent. Choose Save Changes to apply your choices.</p>
                  </fieldset>
                </div>
              </div>

              <div id="notification-levels" class="tab-pane fade" :class="{ 'show active': activeTab === 'notifications' }" role="tabpanel" aria-labelledby="notification-levels-tab">
                <NotificationLevelSettings v-if="activeTab === 'notifications'" />
              </div>

              <div id="security" class="tab-pane fade" :class="{ 'show active': activeTab === 'security' }" role="tabpanel" aria-labelledby="security-tab">
                <div class="row form-section">
                  <div class="col-12 mb-3">
                    <TwoFactorSettings />
                  </div>

                  <template v-if="canEditSecurity">
                    <div class="col-12">
                      <h2 class="security-heading">Change password</h2>
                    </div>
                    <div class="col-md-6 mb-3">
                      <label class="form-label">Current Password</label>
                      <input v-model="form.currentPassword" class="form-control" type="password" />
                    </div>
                    <div class="col-md-6 mb-3"></div>
                    <div class="col-md-6 mb-3">
                      <label class="form-label">New Password</label>
                      <input v-model="form.newPassword" class="form-control" type="password" />
                    </div>
                    <div class="col-md-6 mb-3">
                      <label class="form-label">Confirm New Password</label>
                      <input v-model="form.confirmNewPassword" class="form-control" type="password" />
                    </div>
                  </template>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped src="../assets/legacy/users.css"></style>

<style scoped>
.notification-settings {
  margin: 0.5rem 0 0;
  padding-top: 0;
  padding-bottom: 0;
  border: 0;
}

.notification-settings__legend {
  margin-bottom: 0.5rem;
  font-size: 1rem;
  font-weight: 600;
}

.notification-settings__item {
  min-height: 2.75rem;
  margin-bottom: 0.5rem;
}

.notification-settings__item .form-check-input {
  width: 1.25rem;
  height: 1.25rem;
  margin-top: 0.1rem;
}

.notification-settings__item .form-check-label {
  padding-left: 0.35rem;
  font-size: 0.875rem;
}

.notification-settings__help,
.notification-settings__note {
  margin: 0.15rem 0 0 0.35rem;
  color: var(--bs-secondary-color);
  font-size: 0.8125rem;
}

.notification-settings__note {
  margin: 0.75rem 0 0;
}

.security-heading {
  margin: 0.5rem 0 0.75rem;
  font-size: 1rem;
  line-height: 1.2;
}
</style>
