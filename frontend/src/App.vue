<script setup>
import { computed, onBeforeUnmount, onMounted, provide, reactive, ref, watch } from 'vue';
import { RouterLink, RouterView, useRouter, useRoute } from 'vue-router';
import { Collapse, Dropdown } from 'bootstrap';

import {
  accessNoticeMessage,
  canManageIdentity as userCanManageIdentity,
  canManageIntegrations as userCanManageIntegrations,
  canRankProjects as userCanRankProjects,
  canViewAgentMemory as userCanViewAgentMemory,
  isWorkspaceAdmin,
} from './lib/auth/access.js';
import { apiClient, authSession } from './lib/auth/index.js';
import ApiWorkingIndicator from './components/ApiWorkingIndicator.vue';
import AssistantWorkspace from './components/assistant/AssistantWorkspace.vue';
import NotificationBell from './components/notifications/NotificationBell.vue';
import { useMediaQuery } from './lib/requirements/review-viewport.js';
import { assistantStore } from './lib/assistant/index.js';
import { unreadLabel } from './lib/chat/chat.js';
import { chatUnread } from './lib/chat/chat-unread.js';
import { buildAssistantRouteQuery, parseAssistantRouteQuery } from './lib/assistant/assistant-routing.js';
import { projectStore } from './lib/projects/index.js';
import { workspaceModules } from './lib/workspace/index.js';
import { menuProjects } from './lib/projects/project-register.js';
import { menuEngagements, menuTickets, ticketMenuLocation, WORK_MENU_RECENT } from './lib/workspace/work-menu.js';
import { focusForNow } from './lib/ui/focus-origin.js';
import { DARK_MODE_CONTEXT, createDarkModeController } from './lib/ui/theme.js';
import { createSearchSuggestions, signedInKey, suggestionIcon, suggestionOption } from './lib/search/search-suggestions.js';

const route = useRoute();
const router = useRouter();

// The client portal has its own header (route meta `portal`). Odin Chat and the
// guest view have their own whole-page layout (route meta `chatLayout`, components/chat).
const isPortalRoute = computed(() => route.meta?.portal === true);
const isChatLayout = computed(() => route.meta?.chatLayout === true);
// Wide screens (Bootstrap lg) show the whole top bar, with the bell in its slot after search.
const wideTopBar = useMediaQuery('(min-width: 992px)');
const showChrome = computed(() => {
  return authSession.state.isAuthenticated
    && route.name !== 'oauth-callback'
    && route.name !== 'clarification-portal'
    && route.name !== 'workspace-invitation'
    && !isPortalRoute.value
    && !isChatLayout.value;
});
const currentUser = computed(() => authSession.state.currentUser);
const isAdmin = computed(() => isWorkspaceAdmin(currentUser.value));
const canManageIdentity = computed(() => userCanManageIdentity(currentUser.value));
const canManageIntegrations = computed(() => userCanManageIntegrations(currentUser.value));
const canRankProjects = computed(() => userCanRankProjects(currentUser.value));
const canViewAgentMemory = computed(() => userCanViewAgentMemory(currentUser.value));
const accessNotice = computed(() => accessNoticeMessage(route.query.notice));
const showEngagements = computed(() => workspaceModules.state.consulting);
// Layout A: the groups the top bar's menus hold, by route name, so each
// menu shows as current while one of its pages is open.
const WORK_ROUTES = /^(projects|project-|engagement|tickets)/;
const PLAN_ROUTES = /^(portfolio|ranking|resources|finance|workflow)/;
const INSIGHTS_ROUTES = /^(reporting|leaderboard)$/;
const routeName = computed(() => String(route.name ?? ''));
const workActive = computed(() => WORK_ROUTES.test(routeName.value));
const planActive = computed(() => PLAN_ROUTES.test(routeName.value));
const insightsActive = computed(() => INSIGHTS_ROUTES.test(routeName.value));
const chatUnreadCount = computed(() => chatUnread.state.unread);
const searchInput = ref(null);
const navbarQuery = ref('');
// Results as you type: after a pause, the best few matches open
// under the box; Enter with none chosen opens the search page.
const navbarSuggestions = createSearchSuggestions({
  search: (filters) => (apiClient.passive ?? apiClient).searchEnterprise(filters, authSession.state.token),
});
const suggestFocused = ref(false);
const suggestActive = ref(-1);
const suggestOptions = computed(() => {
  const text = navbarQuery.value.trim();
  if (!text || navbarSuggestions.state.query !== text) return [];
  const results = navbarSuggestions.state.results.map(suggestionOption);
  if (!results.length && !navbarSuggestions.state.error) return [];
  return [...results, { detail: 'Search page', key: 'search', kind: 'search', label: `See all results for “${text}”`, to: { name: 'search', query: { q: text } } }];
});
const suggestOpen = computed(() => suggestFocused.value && suggestOptions.value.length > 0);
const suggestOptionId = (index) => `app-search-option-${index}`;
// Another person, or another workspace, starts with an empty box.
watch(() => signedInKey(authSession.state.currentUser), () => {
  navbarSuggestions.clear();
  navbarQuery.value = '';
  suggestActive.value = -1;
});
const endingImpersonation = ref(false);
const projectDropdownBusy = ref(false);
const tenantSwitchBusy = ref(false);
const avatarFailed = ref(false);
const assistantRouteState = computed(() => parseAssistantRouteQuery(route.query));
const {
  darkMode,
  toggleDarkMode,
} = createDarkModeController({
  currentUserRef: currentUser,
  storage: typeof localStorage !== 'undefined' ? localStorage : null,
  target: typeof document !== 'undefined' ? document.documentElement : null,
});
provide(DARK_MODE_CONTEXT, { darkMode, toggleDarkMode });

const avatarSrc = computed(() => {
  const picture = currentUser.value?.picture ?? '';
  if (!picture) {
    return '';
  }

  if (/^(https?:|data:)/i.test(picture)) {
    return picture;
  }

  const base = authSession.state.apiBaseUrl?.replace(/\/$/, '') ?? '';
  return `${base}${picture.startsWith('/') ? '' : '/'}${picture}`;
});
const showAvatarImage = computed(() => Boolean(avatarSrc.value) && !avatarFailed.value);

watch(avatarSrc, () => {
  avatarFailed.value = false;
});

const dropdownProjects = computed(() => menuProjects(projectStore.state.projects, WORK_MENU_RECENT));
// The Work menu's other columns: recent engagements (with the Consulting module) and tickets.
const workMenu = reactive({ engagements: [], engagementsLoaded: false, tickets: [], ticketsLoaded: false });
const dropdownEngagements = computed(() => menuEngagements(workMenu.engagements));
const dropdownTickets = computed(() => menuTickets(workMenu.tickets));
const workMenuLoadedAt = { engagements: 0, tickets: 0 };

// Each column loads as the menu opens, at most every PROJECT_MENU_REFRESH_MS. A failed load
// shows the column's empty line rather than "Loading…" forever.
function warmWorkColumn(key, load) {
  if (Date.now() - workMenuLoadedAt[key] < PROJECT_MENU_REFRESH_MS) return null;
  workMenuLoadedAt[key] = Date.now();
  return load(authSession.state.token)
    .then((list) => { workMenu[key] = list; })
    .catch(() => null)
    .finally(() => { workMenu[`${key}Loaded`] = true; });
}

// Someone else signing in on this tab never sees the last person's list.
watch(() => authSession.state.currentUser?.id, () => {
  Object.assign(workMenu, { engagements: [], engagementsLoaded: false, tickets: [], ticketsLoaded: false });
  Object.assign(workMenuLoadedAt, { engagements: 0, tickets: 0 });
});

async function warmWorkMenu() {
  if (!authSession.state.token) return;
  await Promise.all([
    warmProjectDropdown(),
    showEngagements.value ? warmWorkColumn('engagements', async (token) => (await apiClient.passive.listEngagements(token))?.engagements ?? []) : null,
    warmWorkColumn('tickets', async (token) => (await apiClient.passive.listTickets({ limit: WORK_MENU_RECENT }, token))?.tickets ?? []),
  ]);
}

// Once loaded, the menu refreshes in place as it opens, at most this often, so projects made
// elsewhere (by MCP clients too) appear without every screen holding a live stream open.
const PROJECT_MENU_REFRESH_MS = 15_000;
let projectMenuLoadedAt = 0;

async function warmProjectDropdown() {
  if (!authSession.state.token || projectDropdownBusy.value) {
    return;
  }

  if (projectStore.state.projects.length > 0) {
    if (Date.now() - projectMenuLoadedAt < PROJECT_MENU_REFRESH_MS) return;
    projectMenuLoadedAt = Date.now();
    await projectStore.loadProjects({ background: true }).catch(() => null);
    return;
  }

  projectDropdownBusy.value = true;
  try {
    // Warms the menu on boot and hover; the user hasn't asked for anything yet.
    await projectStore.loadProjects({ background: true });
    projectMenuLoadedAt = Date.now();
  } finally {
    projectDropdownBusy.value = false;
  }
}

async function handleEndImpersonation() {
  if (!authSession.state.impersonation || endingImpersonation.value) return;
  endingImpersonation.value = true;
  try {
    await authSession.endImpersonation();
    await router.replace({ name: 'home' });
  } finally {
    endingImpersonation.value = false;
  }
}

async function handleLogout() {
  const { cancelled } = await authSession.logout();
  if (!cancelled) {
    router.push({ name: 'login' });
  }
}

async function handleTenantSwitch(tenantId) {
  if (!tenantId || tenantId === currentUser.value?.tenantId || tenantSwitchBusy.value) return;
  tenantSwitchBusy.value = true;
  try {
    await authSession.switchTenant(tenantId);
    window.location.assign(import.meta.env.BASE_URL || '/');
  } finally {
    tenantSwitchBusy.value = false;
  }
}

function handleAvatarError() {
  avatarFailed.value = true;
}

async function dismissAccessNotice() {
  const { notice: _notice, ...query } = route.query;
  await router.replace({ hash: route.hash, name: route.name, params: route.params, query });
}

function closeCollapsedNavbar() {
  // The collapsed (mobile) menu would otherwise stay open over the next page.
  const menu = typeof document !== 'undefined' ? document.getElementById('navbarSupportedContent') : null;
  if (menu?.classList.contains('show')) Collapse.getOrCreateInstance(menu, { toggle: false }).hide();
}

// A choice in a menu closes that menu, and the collapsed (phone) menu too. A link that the router
// handles doesn't close a Bootstrap dropdown on its own.
function closeMenus() {
  for (const toggle of document.querySelectorAll('.app-menu [data-bs-toggle="dropdown"]')) Dropdown.getInstance(toggle)?.hide();
  closeCollapsedNavbar();
}

// Ctrl+K (Cmd+K on a Mac) goes to search from anywhere in Odin. In the collapsed (phone) menu,
// the menu opens first.
function onShortcut(event) {
  if (!showChrome.value || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'k') return;
  event.preventDefault();
  const input = searchInput.value;
  if (!input) return;
  if (input.offsetParent === null) {
    const menu = document.getElementById('navbarSupportedContent');
    if (menu) {
      menu.addEventListener('shown.bs.collapse', () => input.focus(), { once: true });
      Collapse.getOrCreateInstance(menu, { toggle: false }).show();
    }
    return;
  }
  input.focus();
  input.select();
}

// Focusable only for this moment: focusForNow says why a lasting tabindex on the page is a trap.
function skipToMain() {
  focusForNow(document.getElementById('main-content'));
}

async function submitNavbarSearch() {
  const chosen = suggestOpen.value ? suggestOptions.value[suggestActive.value] : null;
  if (chosen) {
    await openSuggestion(chosen);
    return;
  }
  const q = navbarQuery.value.trim();
  if (!q) return;
  closeCollapsedNavbar();
  suggestFocused.value = false;
  await router.push({ name: 'search', query: { q } });
}

async function openSuggestion(option) {
  suggestFocused.value = false;
  suggestActive.value = -1;
  searchInput.value?.blur();
  closeCollapsedNavbar();
  await router.push(option.to);
}

function onSearchInput() {
  suggestFocused.value = true;
  suggestActive.value = -1;
  navbarSuggestions.update(navbarQuery.value);
}

function onSearchFocus() {
  clearTimeout(searchBlurTimer);
  suggestFocused.value = true;
}

function onSearchKeydown(event) {
  const count = suggestOptions.value.length;
  if (event.key === 'ArrowDown' && suggestOpen.value) {
    event.preventDefault();
    suggestActive.value = (suggestActive.value + 1) % count;
  } else if (event.key === 'ArrowUp' && suggestOpen.value) {
    event.preventDefault();
    suggestActive.value = suggestActive.value <= 0 ? count - 1 : suggestActive.value - 1;
  } else if (event.key === 'Escape' && suggestOpen.value) {
    event.preventDefault();
    suggestFocused.value = false;
  }
}

// A click on a result lands before the blur closes the list; focusing again cancels the close.
let searchBlurTimer = null;
function onSearchBlur() {
  clearTimeout(searchBlurTimer);
  searchBlurTimer = setTimeout(() => { suggestFocused.value = false; }, 150);
}

watch(() => (route.name === 'search' ? route.query.q : null), (q) => {
  if (typeof q === 'string') navbarQuery.value = q;
}, { immediate: true });

async function pushAssistantRoute(state) {
  await router.push({
    hash: route.hash,
    name: route.name,
    params: route.params,
    query: buildAssistantRouteQuery(route.query, state),
  });
}

async function replaceAssistantRoute(state) {
  await router.replace({
    hash: route.hash,
    name: route.name,
    params: route.params,
    query: buildAssistantRouteQuery(route.query, state),
  });
}

// Opens the assistant: on a project page, that project's latest chat; elsewhere, the chat that
// was last open.
async function openAssistantWorkspace() {
  const projectId = route.params.projectId ? String(route.params.projectId) : null;
  await pushAssistantRoute({
    mode: projectId ? 'project-context' : 'create-project',
    open: true,
    projectId,
    sessionId: projectId ? null : assistantStore.state.chat?.id ?? null,
  });
}

async function handleAssistantDismiss() {
  assistantStore.dismiss();
  await replaceAssistantRoute({ open: false });
}

watch(
  () => [
    authSession.state.isAuthenticated,
    assistantRouteState.value.fresh,
    assistantRouteState.value.open,
    assistantRouteState.value.mode,
    assistantRouteState.value.projectId,
    assistantRouteState.value.sessionId,
  ],
  async ([isAuthenticated, fresh, open, mode, projectId, sessionId]) => {
    if (!isAuthenticated) {
      assistantStore.dismiss();
      return;
    }
    if (!open) {
      // Docked beside the page, the assistant stays open as you move around Odin.
      if (assistantStore.state.layout === 'docked' && assistantStore.state.open) return;
      assistantStore.dismiss();
      return;
    }
    assistantStore.show();
    if (sessionId) {
      if (assistantStore.state.chat?.id === sessionId) return;
      try {
        await assistantStore.openChat(sessionId);
      } catch (error) {
        // A deleted or someone else's chat: start fresh instead of showing a dead end.
        if (error?.status === 404) {
          assistantStore.clearError();
          assistantStore.startDraft({});
          await replaceAssistantRoute({ open: true });
        }
      }
      return;
    }
    if (mode === 'project-context' && projectId) {
      if (fresh || assistantStore.state.chat?.projectId !== projectId) await assistantStore.openForProject({ fresh, projectId }).catch(() => null);
      return;
    }
    if (!assistantStore.state.chat) assistantStore.startDraft({});
  },
  { immediate: true },
);

// The address follows the open chat, so a reload or a shared link reopens it.
watch(() => assistantStore.state.chat?.id, (chatId) => {
  if (chatId && assistantRouteState.value.open && assistantRouteState.value.sessionId !== chatId) {
    void replaceAssistantRoute({ open: true, sessionId: chatId });
  }
});

onMounted(() => {
  // Preload projects once so the navbar dropdown can render immediately.
  if (authSession.state.isAuthenticated) {
    warmProjectDropdown().catch(() => null);
  }
  document.addEventListener('keydown', onShortcut);
});
onBeforeUnmount(() => document.removeEventListener('keydown', onShortcut));

// The Chat badge: unread posts in the person's channels and direct messages.
watch(
  () => [authSession.state.isAuthenticated, currentUser.value?.tenantId],
  ([isAuthenticated]) => {
    if (isAuthenticated) chatUnread.start();
    else chatUnread.end();
  },
  { immediate: true },
);

// The Engagements link follows the workspace's Consulting module.
watch(
  () => [authSession.state.isAuthenticated, currentUser.value?.tenantId],
  () => { void workspaceModules.load(); },
  { immediate: true },
);
</script>

<template>
  <div class="app-frame">
    <a v-if="showChrome" class="skip-link" href="#main-content" tabindex="0" @click.prevent="skipToMain">Skip to main content</a>
    <nav v-if="showChrome" class="navbar navbar-expand-lg navbar-light bg-light">
      <div class="container-fluid">
        <RouterLink class="navbar-brand d-flex align-items-center gap-2" to="/" active-class="active">
          <img class="app-topbar__brand-mark" src="/brand/odin-mark.png" alt="OdinPMP" width="64" height="64" />
          <span class="app-topbar__wordmark">OdinPMP</span>
        </RouterLink>

        <!-- The one bell. On a phone it stays outside the collapsed menu, so the count shows without
             opening it; on wide screens it moves into its slot after search. -->
        <Teleport defer to="#notifications-bell-slot" :disabled="!wideTopBar">
          <NotificationBell class="app-topbar__bell" :class="wideTopBar ? '' : 'ms-auto me-2'" />
        </Teleport>

        <button
          class="navbar-toggler"
          type="button"
          data-bs-toggle="collapse"
          data-bs-target="#navbarSupportedContent"
          aria-controls="navbarSupportedContent"
          aria-expanded="false"
          aria-label="Toggle navigation"
        >
          <span class="navbar-toggler-icon"></span>
        </button>

        <div id="navbarSupportedContent" class="collapse navbar-collapse">
          <ul class="navbar-nav me-auto mb-2 mb-lg-0 align-items-lg-center app-menu">
            <li class="nav-item">
              <RouterLink class="nav-link" :to="{ name: 'home' }" exact-active-class="active" @click="closeMenus">Home</RouterLink>
            </li>

            <!-- Work: projects (recent ones and New project), engagements with the Consulting module, tickets. -->
            <!-- One column each: the main page, New, and the most recent few. -->
            <li class="nav-item dropdown" @focusin="warmWorkMenu" @mouseenter="warmWorkMenu">
              <button id="workMenu" class="nav-link dropdown-toggle app-menu__toggle" type="button" data-bs-toggle="dropdown" aria-expanded="false" :aria-current="workActive ? 'true' : undefined">
                Work
              </button>
              <div class="dropdown-menu app-work-menu" :class="{ 'app-work-menu--two': !showEngagements }" aria-labelledby="workMenu">
                <section class="app-work-menu__column" aria-labelledby="workMenuProjects">
                  <h2 id="workMenuProjects" class="dropdown-header app-work-menu__title">Projects</h2>
                  <ul class="app-work-menu__list">
                    <li><RouterLink class="dropdown-item" :to="{ name: 'projects' }" @click="closeMenus">All projects</RouterLink></li>
                    <li><RouterLink class="dropdown-item" :to="{ name: 'projects', query: { new: 'project' } }" @click="closeMenus">New project…</RouterLink></li>
                  </ul>
                  <h3 class="dropdown-header app-work-menu__recent">Recent</h3>
                  <ul class="app-work-menu__list">
                    <li v-if="projectDropdownBusy && !dropdownProjects.length"><span class="dropdown-item-text text-muted">Loading…</span></li>
                    <li v-else-if="!dropdownProjects.length"><span class="dropdown-item-text text-muted">No projects yet</span></li>
                    <li v-for="project in dropdownProjects" :key="project.id">
                      <RouterLink class="dropdown-item app-menu__project" :to="{ name: 'project-detail', params: { projectId: project.id } }" @click="closeMenus">
                        {{ project.name }}
                      </RouterLink>
                    </li>
                  </ul>
                </section>
                <section v-if="showEngagements" class="app-work-menu__column" aria-labelledby="workMenuEngagements">
                  <h2 id="workMenuEngagements" class="dropdown-header app-work-menu__title">Engagements</h2>
                  <ul class="app-work-menu__list">
                    <li><RouterLink class="dropdown-item" :to="{ name: 'engagements' }" @click="closeMenus">All engagements</RouterLink></li>
                    <li><RouterLink class="dropdown-item" :to="{ name: 'engagements', query: { new: 'engagement' } }" @click="closeMenus">New engagement…</RouterLink></li>
                  </ul>
                  <h3 class="dropdown-header app-work-menu__recent">Recent</h3>
                  <ul class="app-work-menu__list">
                    <li v-if="!workMenu.engagementsLoaded"><span class="dropdown-item-text text-muted">Loading…</span></li>
                    <li v-else-if="!dropdownEngagements.length"><span class="dropdown-item-text text-muted">No open engagements</span></li>
                    <li v-for="engagement in dropdownEngagements" :key="engagement.id">
                      <RouterLink class="dropdown-item app-menu__project" :to="{ name: 'engagement-detail', params: { projectId: engagement.id } }" @click="closeMenus">
                        {{ engagement.name }}<span v-if="engagement.customer" class="app-work-menu__detail">{{ engagement.customer }}</span>
                      </RouterLink>
                    </li>
                  </ul>
                </section>
                <section class="app-work-menu__column" aria-labelledby="workMenuTickets">
                  <h2 id="workMenuTickets" class="dropdown-header app-work-menu__title">Tickets</h2>
                  <ul class="app-work-menu__list">
                    <li><RouterLink class="dropdown-item" :to="{ name: 'tickets' }" @click="closeMenus">All tickets</RouterLink></li>
                    <li><RouterLink class="dropdown-item" :to="{ name: 'tickets', query: { new: 'ticket' } }" @click="closeMenus">New ticket…</RouterLink></li>
                  </ul>
                  <h3 class="dropdown-header app-work-menu__recent">Recent</h3>
                  <ul class="app-work-menu__list">
                    <li v-if="!workMenu.ticketsLoaded"><span class="dropdown-item-text text-muted">Loading…</span></li>
                    <li v-else-if="!dropdownTickets.length"><span class="dropdown-item-text text-muted">No tickets yet</span></li>
                    <li v-for="ticket in dropdownTickets" :key="ticket.id">
                      <RouterLink class="dropdown-item app-menu__project" :to="ticketMenuLocation(ticket)" @click="closeMenus">
                        {{ ticket.name }}<span v-if="ticket.projectName" class="app-work-menu__detail">{{ ticket.projectName }}</span>
                      </RouterLink>
                    </li>
                  </ul>
                </section>
              </div>
            </li>

            <li class="nav-item">
              <RouterLink class="nav-link app-menu__chat" :to="{ name: 'chat-home' }" data-testid="topbar-chat" @click="closeMenus">
                <span>Chat<span v-if="chatUnreadCount > 0" class="visually-hidden">, {{ chatUnreadCount }} unread</span></span>
                <span v-if="chatUnreadCount > 0" class="app-menu__badge" aria-hidden="true">{{ unreadLabel(chatUnreadCount) }}</span>
              </RouterLink>
            </li>

            <!-- Plan: portfolio and the workspace-wide planning pages. -->
            <li class="nav-item dropdown">
              <button id="planMenu" class="nav-link dropdown-toggle app-menu__toggle" type="button" data-bs-toggle="dropdown" aria-expanded="false" :aria-current="planActive ? 'true' : undefined">
                Plan
              </button>
              <ul class="dropdown-menu app-menu__list" aria-labelledby="planMenu">
                <li><RouterLink class="dropdown-item" :to="{ name: 'portfolio' }" @click="closeMenus">Portfolio</RouterLink></li>
                <li v-if="canRankProjects"><RouterLink class="dropdown-item" :to="{ name: 'ranking' }" @click="closeMenus">Rank projects</RouterLink></li>
                <li><RouterLink class="dropdown-item" :to="{ name: 'resources' }" @click="closeMenus">Resources</RouterLink></li>
                <!-- Finance is for workspace managers and admins, the same people who rank projects. -->
                <li v-if="canRankProjects"><RouterLink class="dropdown-item" :to="{ name: 'finance' }" @click="closeMenus">Finance</RouterLink></li>
                <li><RouterLink class="dropdown-item" :to="{ name: 'workflows' }" @click="closeMenus">Workflows</RouterLink></li>
              </ul>
            </li>

            <li class="nav-item dropdown">
              <button id="insightsMenu" class="nav-link dropdown-toggle app-menu__toggle" type="button" data-bs-toggle="dropdown" aria-expanded="false" :aria-current="insightsActive ? 'true' : undefined">
                Insights
              </button>
              <ul class="dropdown-menu app-menu__list" aria-labelledby="insightsMenu">
                <li><RouterLink class="dropdown-item" :to="{ name: 'reporting' }" @click="closeMenus">Reports</RouterLink></li>
                <li><RouterLink class="dropdown-item" :to="{ name: 'leaderboard' }" @click="closeMenus">Leaderboard</RouterLink></li>
              </ul>
            </li>
          </ul>

          <form class="app-search d-flex align-items-center gap-2 my-2 my-lg-0 me-lg-3" role="search" aria-label="Workspace" @submit.prevent="submitNavbarSearch">
            <div class="app-search__field">
              <input
                ref="searchInput"
                v-model="navbarQuery"
                class="form-control"
                type="search"
                maxlength="500"
                placeholder="Search"
                aria-label="Search workspace"
                aria-keyshortcuts="Control+K"
                role="combobox"
                autocomplete="off"
                aria-autocomplete="list"
                aria-controls="app-search-results"
                :aria-expanded="suggestOpen"
                :aria-activedescendant="suggestOpen && suggestActive >= 0 ? suggestOptionId(suggestActive) : undefined"
                data-testid="app-search"
                @blur="onSearchBlur"
                @focus="onSearchFocus"
                @input="onSearchInput"
                @keydown="onSearchKeydown"
              />
              <kbd class="app-search__key" aria-hidden="true">Ctrl K</kbd>
              <ul v-show="suggestOpen" id="app-search-results" class="app-search__results" role="listbox" aria-label="Search results">
                <li
                  v-for="(option, index) in suggestOptions"
                  :id="suggestOptionId(index)"
                  :key="option.key"
                  class="app-search__result"
                  :class="{ 'app-search__result--active': index === suggestActive, 'app-search__result--all': option.kind === 'search' }"
                  role="option"
                  :aria-selected="index === suggestActive"
                  @mousedown.prevent="openSuggestion(option)"
                  @mouseenter="suggestActive = index"
                >
                  <i :class="['bi', option.kind === 'search' ? 'bi-search' : suggestionIcon(option.documentType)]" aria-hidden="true"></i>
                  <span class="app-search__result-label">{{ option.label }}</span>
                  <span v-if="option.kind !== 'search'" class="app-search__result-detail">{{ option.detail }}</span>
                </li>
                <li v-if="navbarSuggestions.state.error" class="app-search__result app-search__result--note" role="presentation">Results couldn’t load. See all results instead.</li>
              </ul>
            </div>
            <button class="btn btn-outline-success" type="submit">Search</button>
          </form>

          <!-- The notifications bell: after search, before AI Workspace. -->
          <div id="notifications-bell-slot" class="app-topbar__bell me-lg-2" data-slot="notifications-bell"></div>

          <button class="btn btn-dark btn-sm me-3 app-assistant-launch" type="button" @click="openAssistantWorkspace()">
            <i class="bi bi-stars me-1"></i> AI Workspace
          </button>

          <button
            class="theme-toggle me-2"
            type="button"
            :aria-label="darkMode ? 'Switch to light mode' : 'Switch to dark mode'"
            @click="toggleDarkMode"
          >
            <i :class="darkMode ? 'bi bi-sun' : 'bi bi-moon'"></i>
          </button>

          <ul class="navbar-nav mb-2 mb-lg-0 align-items-center">
            <li class="nav-item dropdown">
              <a class="nav-link dropdown-toggle" href="#" role="button" data-bs-toggle="dropdown" aria-expanded="false" aria-label="Account menu">
                <img
                  v-if="showAvatarImage"
                  :src="avatarSrc"
                  alt="User Profile"
                  class="profile-pic"
                  @error="handleAvatarError"
                />
                <span v-else class="profile-pic profile-pic--fallback" aria-hidden="true">
                  <i class="bi bi-person-fill"></i>
                </span>
              </a>
              <ul class="dropdown-menu dropdown-menu-end">
                <li>
                  <RouterLink class="dropdown-item" to="/user">{{ currentUser?.name }}</RouterLink>
                </li>
                <li v-if="canViewAgentMemory">
                  <RouterLink class="dropdown-item" to="/ai-memory">What the AI remembers</RouterLink>
                </li>
                <template v-if="currentUser?.tenants?.length > 1">
                  <li><hr class="dropdown-divider" /></li>
                  <li><h2 class="dropdown-header">Workspace</h2></li>
                  <li v-for="tenant in currentUser.tenants" :key="tenant.id">
                    <button class="dropdown-item d-flex justify-content-between gap-3" type="button" :disabled="tenantSwitchBusy || authSession.state.impersonation || authSession.state.breakGlass || tenant.id === currentUser.tenantId" @click="handleTenantSwitch(tenant.id)">
                      <span>{{ tenant.name }}</span><i v-if="tenant.id === currentUser.tenantId" class="bi bi-check-lg" aria-label="Current workspace"></i>
                    </button>
                  </li>
                  <li><hr class="dropdown-divider" /></li>
                </template>
                <li v-if="!authSession.state.impersonation && !authSession.state.breakGlass">
                  <RouterLink class="dropdown-item" to="/workspace-access">Request workspace access</RouterLink>
                </li>
                <li v-if="isAdmin">
                  <RouterLink class="dropdown-item" to="/admin">Tenant Admin</RouterLink>
                </li>
                <li v-if="isAdmin">
                  <RouterLink class="dropdown-item" to="/admin/compliance">Compliance</RouterLink>
                </li>
                <li v-if="isAdmin">
                  <RouterLink class="dropdown-item" to="/admin/ticketing">Ticket environments &amp; releases</RouterLink>
                </li>
                <li v-if="canManageIdentity">
                  <RouterLink class="dropdown-item" to="/admin/identity">Identity &amp; access</RouterLink>
                </li>
                <li v-if="canManageIntegrations">
                  <RouterLink class="dropdown-item" to="/admin/integrations">API &amp; integrations</RouterLink>
                </li>
                <li>
                  <button class="dropdown-item" type="button" @click="handleLogout">Logout</button>
                </li>
              </ul>
            </li>
          </ul>
        </div>
      </div>
    </nav>

    <aside v-if="showChrome && authSession.state.impersonation" class="alert alert-warning d-flex flex-wrap align-items-center justify-content-between gap-2 rounded-0 mb-0" role="status">
      <span><strong>Impersonation active:</strong> acting as {{ currentUser?.name }} until {{ new Date(authSession.state.impersonation.sessionExpiresAt).toLocaleTimeString() }}.</span>
      <button class="btn btn-sm btn-outline-dark" type="button" :disabled="endingImpersonation" @click="handleEndImpersonation">End impersonation</button>
    </aside>
    <aside v-if="showChrome && accessNotice" class="alert alert-info d-flex flex-wrap align-items-center justify-content-between gap-2 rounded-0 mb-0" role="status">
      <span><i class="bi bi-info-circle me-1" aria-hidden="true"></i>{{ accessNotice }}</span>
      <button class="btn btn-sm btn-outline-dark" type="button" @click="dismissAccessNotice">Dismiss</button>
    </aside>
    <aside v-if="showChrome && authSession.state.breakGlass" class="alert alert-danger d-flex flex-wrap align-items-center justify-content-between gap-2 rounded-0 mb-0" role="alert">
      <span><strong>Emergency access active:</strong> this audited session expires at {{ new Date(authSession.state.breakGlass.expiresAt).toLocaleTimeString() }}.</span>
      <button class="btn btn-sm btn-outline-dark" type="button" @click="handleLogout">End emergency session</button>
    </aside>

    <!-- Odin Chat and the guest view lay out the whole page, their own main included. -->
    <RouterView v-if="isChatLayout" />
    <main v-else id="main-content" class="app-main" :class="{ 'app-main--auth': !showChrome && !isPortalRoute, 'app-main--portal': isPortalRoute }">
      <RouterView />
    </main>

    <!-- In Odin Chat, Odin's conversation shows the AI Workspace in the page instead. -->
    <AssistantWorkspace
      v-if="!isChatLayout && (assistantRouteState.open || assistantStore.state.open)"
      @dismiss="handleAssistantDismiss"
    />

    <ApiWorkingIndicator />
  </div>
</template>

<style scoped>
/* Layout A: the menus' buttons look like the bar's links. */
.app-menu__toggle { border: 0; background: transparent; }
/* The group of the open page. Not a class: Bootstrap keeps its own on the toggle. */
.app-menu__toggle[aria-current="true"] { color: var(--bs-navbar-active-color); }
.app-menu__list { min-width: 14rem; max-height: min(70vh, 32rem); overflow-y: auto; }
.app-menu__project { max-width: 22rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Work: three columns side by side on a wide screen, one under another in the phone menu. */
.app-work-menu { width: min(54rem, calc(100vw - 2rem)); max-height: min(75vh, 34rem); padding: 0.5rem; overflow-y: auto; }
.app-work-menu.show { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.25rem; }
.app-work-menu--two { width: min(37rem, calc(100vw - 2rem)); }
.app-work-menu--two.show { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.app-work-menu__column { min-width: 0; padding: 0.25rem 0; }
.app-work-menu__column + .app-work-menu__column { border-left: 1px solid var(--line); }
.app-work-menu__list { margin: 0; padding: 0; list-style: none; }
.app-work-menu__title { color: var(--ink); font-size: 0.8rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
/* assets/legacy/header.css sizes h3 with !important. */
.app-work-menu .app-work-menu__recent { margin: 0.35rem 0 0; padding: 0.35rem 1rem 0.2rem; border: 0; color: var(--muted); font-size: 0.7rem !important; font-weight: 600; letter-spacing: 0.04em; line-height: 1.4; text-transform: uppercase; }
.app-work-menu .dropdown-item { display: block; max-width: none; border-radius: 0.3rem; }
.app-work-menu__detail { display: block; overflow: hidden; color: var(--muted); font-size: 0.75rem; text-overflow: ellipsis; }
.app-menu__chat { display: inline-flex; align-items: center; gap: 0.35rem; }
.app-menu__badge { min-width: 1.4rem; padding: 0.05rem 0.4rem; border-radius: 999px; background: var(--accent); color: #fff; font-size: 0.72rem; font-weight: 700; line-height: 1.3; text-align: center; }
.app-search__field { position: relative; flex: 1 1 auto; }
.app-search__field .form-control { padding-right: 3.5rem; }
.app-search__results { position: absolute; top: calc(100% + 0.25rem); left: 0; z-index: 1060; width: min(32rem, calc(100vw - 2rem)); max-height: 24rem; margin: 0; padding: 0.25rem; overflow-y: auto; list-style: none; border: 1px solid var(--line); border-radius: 0.5rem; background: var(--surface); box-shadow: var(--shadow-strong); }
.app-search__result { display: grid; grid-template-columns: 1.25rem minmax(0, 1fr); column-gap: 0.5rem; align-items: center; padding: 0.4rem 0.5rem; border-radius: 0.35rem; color: var(--ink); cursor: pointer; }
.app-search__result--active { background: var(--surface-soft); }
.app-search__result--all { border-top: 1px solid var(--line); border-radius: 0 0 0.35rem 0.35rem; color: var(--muted); }
.app-search__result--note { grid-template-columns: 1fr; color: var(--muted); cursor: default; font-size: 0.85rem; }
.app-search__result-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.app-search__result-detail { grid-column: 2; overflow: hidden; color: var(--muted); font-size: 0.78rem; text-overflow: ellipsis; white-space: nowrap; }
.app-search__key { position: absolute; top: 50%; right: 0.5rem; padding: 0.05rem 0.3rem; border: 1px solid var(--line); border-radius: 0.3rem; background: var(--surface-soft); color: var(--muted); font-size: 0.68rem; transform: translateY(-50%); pointer-events: none; }
.app-topbar__bell:empty { display: none; }
@media (max-width: 991.98px) {
  .app-search__key { display: none; }
  .app-menu .dropdown-menu { border: 0; box-shadow: none; }
  .app-work-menu,
  .app-work-menu--two { width: auto; max-height: none; }
  .app-work-menu.show,
  .app-work-menu--two.show { grid-template-columns: minmax(0, 1fr); }
  .app-work-menu__column + .app-work-menu__column { border-top: 1px solid var(--line); border-left: 0; }
}
html.dark .app-menu__badge { color: #0b1220; }
</style>
