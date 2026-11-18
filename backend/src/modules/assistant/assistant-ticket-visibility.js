// External ticket review gate (D-027).
//
// An externally submitted ticket is invisible to the assistant until a human marks it
// valid. This gates AGENT VISIBILITY ONLY: pending tickets remain fully visible,
// assignable, and schedulable by humans, so D-013's "triage is not a gate" still holds.
//
// Enforcement lives here rather than in each assistant context builder, because a single
// unfiltered read path would defeat the gate (plan.md, load-bearing risk 2). Every
// assistant read of project detail goes through wrapProjectRepositoryForAssistant, so
// adding a new context builder cannot accidentally bypass it.
//
// This does not replace the untrusted-content envelope (A-001): marking a ticket valid
// asserts that it is a genuine report, not that its text is safe to treat as instructions.

const ASSISTANT_VISIBLE_REVIEW_STATES = new Set(['not_external', 'validated']);

export function isTicketVisibleToAssistant(ticket) {
  const state = String(ticket?.externalReviewState ?? 'not_external');
  return ASSISTANT_VISIBLE_REVIEW_STATES.has(state);
}

/**
 * Removes tickets the assistant may not see. Returns the project unchanged when it
 * carries no tickets, so non-ticket callers pay nothing.
 */
export function filterProjectTicketsForAssistant(project) {
  if (!project || !Array.isArray(project.tickets) || project.tickets.length === 0) {
    return project;
  }

  const visible = project.tickets.filter(isTicketVisibleToAssistant);
  if (visible.length === project.tickets.length) {
    return project;
  }

  return { ...project, tickets: visible };
}

/**
 * Wraps a projects repository so every assistant-side read of project detail has gated
 * tickets stripped. Writes and all other methods pass through untouched.
 */
export function wrapProjectRepositoryForAssistant(projectRepository) {
  if (!projectRepository || typeof projectRepository.getProjectDetail !== 'function') {
    return projectRepository;
  }

  return new Proxy(projectRepository, {
    get(target, property, receiver) {
      if (property !== 'getProjectDetail') {
        return Reflect.get(target, property, receiver);
      }

      return async (...args) => filterProjectTicketsForAssistant(await target.getProjectDetail(...args));
    },
  });
}
