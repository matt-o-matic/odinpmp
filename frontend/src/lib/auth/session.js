import { reactive } from 'vue';

import { isWorkingCancellation } from '../api/activity-tracker.js';
import { BROWSER_SESSION_MARKER, withWorkingMode } from '../api/client.js';

const AUTH_RESTORE_TIMEOUT_MS = 5 * 1000;
// Coming back to the window refreshes the session only when the last refresh is older than this.
// Each refresh rotates the refresh token, so refreshing on every window switch made races between
// windows (and lost answers) likely; API calls still refresh on a 401 at any time.
export const RETURN_REFRESH_AFTER_MS = 10 * 60 * 1000;
const TWO_FACTOR_MARKER = 'cookie-challenge';
const DEFAULT_APP_BASE_URL = import.meta?.env?.BASE_URL ?? '/';

function randomPassword() {
  return `oauth-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeAppBaseUrl(appBaseUrl) {
  if (!appBaseUrl || appBaseUrl === '/') {
    return '/';
  }
  return appBaseUrl.endsWith('/') ? appBaseUrl : `${appBaseUrl}/`;
}

function buildAuthRedirectTarget(location, appBaseUrl) {
  const normalizedBaseUrl = normalizeAppBaseUrl(appBaseUrl);
  const fullPath = `${location.pathname ?? ''}${location.search ?? ''}${location.hash ?? ''}` || '/';
  if (normalizedBaseUrl === '/') {
    return fullPath;
  }
  const basePrefix = normalizedBaseUrl.replace(/\/$/, '');
  if (fullPath === basePrefix) {
    return '/';
  }
  return fullPath.startsWith(`${basePrefix}/`)
    ? fullPath.slice(basePrefix.length) || '/'
    : '/';
}

function buildLoginLocation(location, appBaseUrl) {
  const redirect = buildAuthRedirectTarget(location, appBaseUrl);
  const basePrefix = normalizeAppBaseUrl(appBaseUrl);
  const loginUrl = new URL(`${basePrefix.replace(/^\//, '')}login`, location.origin);
  if (!redirect.startsWith('/login')) {
    loginUrl.searchParams.set('redirect', redirect);
  }
  return loginUrl;
}

function normalizeRedirectPath(value) {
  const redirect = String(value ?? '').trim();
  return redirect && redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : '';
}

export function createSessionStore({ apiClient, appBaseUrl = DEFAULT_APP_BASE_URL, now = () => Date.now() }) {
  let lifecycleHooksBound = false;
  // When the session was last confirmed by the server (sign-in, refresh or /me).
  let confirmedAt = 0;
  let refreshInFlight = null;
  let restoreInFlight = null;
  const state = reactive({
    apiBaseUrl: apiClient.baseUrl,
    breakGlass: null,
    currentUser: null,
    impersonation: null,
    isAuthenticated: false,
    lastBackupCodes: [],
    pendingTwoFactorChallenge: '',
    pendingBreakGlassChallenge: '',
    ready: false,
    refreshToken: '',
    token: '',
    twoFactorSetupQrCode: '',
  });

  function applySession(session) {
    state.currentUser = session.user;
    state.breakGlass = null;
    state.isAuthenticated = true;
    state.pendingTwoFactorChallenge = '';
    state.pendingBreakGlassChallenge = '';
    state.impersonation = null;
    // These fixed markers preserve existing UI/store contracts without containing credentials.
    state.refreshToken = BROWSER_SESSION_MARKER;
    state.token = BROWSER_SESSION_MARKER;
    confirmedAt = now();
    bindLifecycleHooks();
  }

  // A failed refresh does not always mean the session ended: it may have lost a race with another
  // window, or its answer may have been lost, while the access cookie is still good. Ask /me
  // before signing the person out.
  async function stillSignedIn() {
    try {
      const result = await withWorkingMode(apiClient, 'passive').getCurrentUser(BROWSER_SESSION_MARKER, {
        skipAuthRedirect: true,
        timeoutMs: AUTH_RESTORE_TIMEOUT_MS,
      });
      if (!result?.user) return false;
      applySession({ user: result.user });
      return true;
    } catch (_error) {
      return false;
    }
  }

  function clearSession() {
    state.currentUser = null;
    state.breakGlass = null;
    state.isAuthenticated = false;
    state.impersonation = null;
    state.pendingTwoFactorChallenge = '';
    state.pendingBreakGlassChallenge = '';
    state.refreshToken = '';
    state.token = '';
    state.twoFactorSetupQrCode = '';
    state.lastBackupCodes = [];
  }

  async function refreshSession(failedToken = '', options = {}) {
    if (state.impersonation || state.breakGlass) {
      return state.token;
    }
    if (failedToken && failedToken !== BROWSER_SESSION_MARKER) {
      return BROWSER_SESSION_MARKER;
    }
    if (refreshInFlight) {
      return refreshInFlight;
    }

    // Refreshes run on boot, on window focus and inside other calls' 401 retries.
    refreshInFlight = withWorkingMode(apiClient, 'passive').refreshSession(BROWSER_SESSION_MARKER, {
      ...options,
      skipAuthRedirect: true,
    })
      .then((result) => {
        applySession(result.session);
        return BROWSER_SESSION_MARKER;
      })
      .catch(async (error) => {
        if (error?.status === 401 || error?.status === 403) {
          if (await stillSignedIn()) return BROWSER_SESSION_MARKER;
          clearSession();
        }
        throw error;
      })
      .finally(() => {
        refreshInFlight = null;
      });

    return refreshInFlight;
  }

  function bindLifecycleHooks() {
    if (lifecycleHooksBound || typeof window === 'undefined') {
      return;
    }
    const refreshOnReturn = () => {
      if (!state.isAuthenticated) {
        return;
      }
      if (typeof document !== 'undefined' && document.visibilityState && document.visibilityState !== 'visible') {
        return;
      }
      if (now() - confirmedAt < RETURN_REFRESH_AFTER_MS) {
        return;
      }
      void refreshSession().catch(() => null);
    };
    window.addEventListener?.('focus', refreshOnReturn);
    if (typeof document !== 'undefined') {
      document.addEventListener?.('visibilitychange', refreshOnReturn);
    }
    lifecycleHooksBound = true;
  }

  function redirectToLogin() {
    if (typeof window === 'undefined' || !window.location?.origin) {
      return;
    }
    const loginUrl = buildLoginLocation(window.location, appBaseUrl);
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const nextUrl = `${loginUrl.pathname}${loginUrl.search}${loginUrl.hash}`;
    if (currentUrl === nextUrl) {
      return;
    }
    if (typeof window.location.assign === 'function') {
      window.location.assign(loginUrl.toString());
      return;
    }
    window.location.href = loginUrl.toString();
  }

  function handleUnauthorized() {
    if (state.impersonation) {
      void restoreActorSession();
      return;
    }
    clearSession();
    redirectToLogin();
  }

  async function restoreActorSession() {
    state.currentUser = null;
    state.impersonation = null;
    state.isAuthenticated = false;
    state.refreshToken = '';
    state.token = '';
    // Passive so Cancel can't strand the app after the local session was already cleared.
    const result = await withWorkingMode(apiClient, 'passive').getCurrentUser(BROWSER_SESSION_MARKER, {
      skipAuthRedirect: true,
      timeoutMs: AUTH_RESTORE_TIMEOUT_MS,
    });
    applySession({ user: result.user });
    state.ready = true;
    return result;
  }

  return {
    state,
    async restore() {
      if (state.ready) {
        return restoreInFlight ?? Promise.resolve();
      }
      if (restoreInFlight) {
        return restoreInFlight;
      }
      bindLifecycleHooks();
      restoreInFlight = withWorkingMode(apiClient, 'passive').getCurrentUser(BROWSER_SESSION_MARKER, {
        skipAuthRedirect: true,
        timeoutMs: AUTH_RESTORE_TIMEOUT_MS,
      })
        .then((result) => applySession({ user: result.user }))
        .catch(async (error) => {
          if (error?.status !== 401) {
            clearSession();
            return;
          }
          try {
            await refreshSession('', { timeoutMs: AUTH_RESTORE_TIMEOUT_MS });
          } catch (_refreshError) {
            clearSession();
          }
        })
        .finally(() => {
          state.ready = true;
          restoreInFlight = null;
        });
      return restoreInFlight;
    },
    async login(payload) {
      const result = await withWorkingMode(apiClient, 'blocking').login(payload);
      if (result.requiresTwoFactor) {
        clearSession();
        state.pendingTwoFactorChallenge = TWO_FACTOR_MARKER;
        return result;
      }
      applySession(result.session);
      return result;
    },
    async acceptWorkspaceInvitation(inviteToken, registration = null) {
      const result = await withWorkingMode(apiClient, 'blocking').acceptWorkspaceInvitation(inviteToken, registration, registration ? undefined : state.token);
      applySession(result.session);
      return result;
    },
    async register(payload) {
      const result = await withWorkingMode(apiClient, 'blocking').register({
        ...payload,
        password: payload.password || randomPassword(),
      });
      // Password sign-ups get a session only after the emailed link is used (verifyRegistration).
      if (result.session) applySession(result.session);
      return result;
    },
    async verifyRegistration(token) {
      const result = await withWorkingMode(apiClient, 'blocking').verifyRegistration(token);
      applySession(result.session);
      return result;
    },
    async checkAvailability(payload) {
      return apiClient.checkRegistrationAvailability(payload);
    },
    async verifyTwoFactor({ code }) {
      if (!state.pendingTwoFactorChallenge) {
        throw new Error('No two-factor challenge is active.');
      }
      const result = await withWorkingMode(apiClient, 'blocking').verifyTwoFactor({ code });
      applySession(result.session);
      return result;
    },
    async consumeOAuthCallback(query) {
      const redirect = normalizeRedirectPath(query.redirect);
      if (query.requiresTwoFactor === '1' || query.requiresTwoFactor === 1) {
        clearSession();
        state.pendingTwoFactorChallenge = TWO_FACTOR_MARKER;
        return { redirect, requiresTwoFactor: true };
      }
      const result = await withWorkingMode(apiClient, 'blocking').getCurrentUser(BROWSER_SESSION_MARKER, {
        skipAuthRedirect: true,
      });
      applySession({ user: result.user });
      return { authenticated: true, redirect };
    },
    // Clears the local session once the server has revoked it. Cancelling from the working
    // dialog keeps the user signed in, because the server session is still alive.
    async logout() {
      if (state.isAuthenticated) {
        try {
          await withWorkingMode(apiClient, 'blocking').logout(state.token);
        } catch (error) {
          if (isWorkingCancellation(error)) {
            return { cancelled: true };
          }
        }
      }
      clearSession();
      return { cancelled: false };
    },
    async switchTenant(tenantId) {
      if (!state.isAuthenticated || !tenantId || state.impersonation || state.breakGlass) {
        return null;
      }
      const result = await withWorkingMode(apiClient, 'blocking').switchTenant(tenantId, BROWSER_SESSION_MARKER);
      applySession(result.session);
      return result;
    },
    handleUnauthorized,
    beginImpersonation(result) {
      if (!result?.session?.token || !result?.session?.user || !result?.grant) {
        throw new Error('A valid impersonation session is required.');
      }
      state.currentUser = result.session.user;
      state.impersonation = { ...result.grant, sessionExpiresAt: result.expiresAt };
      state.isAuthenticated = true;
      state.pendingTwoFactorChallenge = '';
      state.refreshToken = '';
      state.token = result.session.token;
      return result;
    },
    async startBreakGlass(payload) {
      const result = await withWorkingMode(apiClient, 'blocking').startBreakGlass(payload);
      clearSession();
      state.pendingBreakGlassChallenge = result.challengeToken;
      return result;
    },
    async verifyBreakGlass({ code }) {
      if (!state.pendingBreakGlassChallenge) throw new Error('No emergency access challenge is active.');
      const result = await withWorkingMode(apiClient, 'blocking').verifyBreakGlass({ challengeToken: state.pendingBreakGlassChallenge, code });
      state.breakGlass = result.breakGlass;
      state.currentUser = result.session.user;
      state.impersonation = null;
      state.isAuthenticated = true;
      state.pendingBreakGlassChallenge = '';
      state.pendingTwoFactorChallenge = '';
      state.refreshToken = '';
      state.token = result.session.token;
      bindLifecycleHooks();
      return result;
    },
    cancelBreakGlass() {
      state.pendingBreakGlassChallenge = '';
    },
    async endImpersonation() {
      if (!state.impersonation) return null;
      const active = state.impersonation;
      try {
        await withWorkingMode(apiClient, 'blocking').endImpersonation(active.id, active.version, state.token);
      } finally {
        await restoreActorSession();
      }
      return active;
    },
    async keepAlive() {
      if (!state.isAuthenticated) {
        return null;
      }
      if (state.impersonation || state.breakGlass) {
        return null;
      }
      const result = await withWorkingMode(apiClient, 'passive').keepAlive();
      applySession(result.session);
      return result;
    },
    async refreshSession(failedToken = '') {
      return refreshSession(failedToken);
    },
    async initTwoFactor() {
      const result = await withWorkingMode(apiClient, 'blocking').initTwoFactor(state.token);
      state.twoFactorSetupQrCode = result.qrCodeData;
      return result;
    },
    async enableTwoFactor(code) {
      const result = await withWorkingMode(apiClient, 'blocking').enableTwoFactor(state.token, { code });
      state.lastBackupCodes = result.backupCodes;
      state.twoFactorSetupQrCode = '';
      if (state.currentUser) {
        state.currentUser.preferences = {
          ...state.currentUser.preferences,
          twoFactorEnabled: true,
        };
      }
      return result;
    },
    async loadBackupCodes() {
      const result = await apiClient.getBackupCodes(state.token);
      state.lastBackupCodes = result.backupCodes;
      return result;
    },
    async disableTwoFactor() {
      const result = await withWorkingMode(apiClient, 'blocking').disableTwoFactor(state.token);
      state.twoFactorSetupQrCode = '';
      state.lastBackupCodes = [];
      if (state.currentUser) {
        state.currentUser.preferences = {
          ...state.currentUser.preferences,
          twoFactorEnabled: false,
        };
      }
      return result;
    },
  };
}
