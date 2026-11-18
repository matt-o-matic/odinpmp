// The stakeholder portal shell shares its data, live updates, and link-problem handling
// with the inbox, question, and review pages through provide/inject.

import { inject } from 'vue';

export const PORTAL_CONTEXT = Symbol('requirements-portal');

export function usePortal() {
  const context = inject(PORTAL_CONTEXT, null);
  if (!context) throw new Error('Portal pages must render inside RequirementsPortalView.');
  return context;
}

/** The Odin mark from the public folder, under the app's base path. */
export function odinMarkUrl(base = '/') {
  return `${String(base || '/').replace(/\/?$/, '/')}brand/odin-mark.png`;
}
