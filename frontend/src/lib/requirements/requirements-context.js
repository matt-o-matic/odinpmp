// The Requirements workspace shares its overview, My open items, permissions, live-update
// batches, and messages with the views rendered inside it through provide/inject.

import { inject } from 'vue';

export const REQUIREMENTS_CONTEXT = Symbol('requirements-workspace');

export function useRequirementsWorkspace() {
  const context = inject(REQUIREMENTS_CONTEXT, null);
  if (!context) throw new Error('Requirements views must render inside RequirementsWorkspace.');
  return context;
}
