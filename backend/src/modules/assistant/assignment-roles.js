// People on a clarification (a requirements topic): one owner ('primary'), people whose
// answer is required ('required'), and others asked for input ('collaborator'). The owner
// outranks required people; a required person's answer settles a point unless someone with
// equal or higher standing disputes it. Project and tenant admins rank with required people.

export const ASSIGNMENT_ROLES = Object.freeze(['primary', 'required', 'collaborator']);

/** One of ASSIGNMENT_ROLES; anything else is 'collaborator'. */
export function normalizeAssignmentRole(value) {
  const role = String(value ?? '').trim().toLowerCase();
  return ASSIGNMENT_ROLES.includes(role) ? role : 'collaborator';
}

/** Sort rank: owner, then required, then everyone else. */
export function assignmentRoleRank(role) {
  const index = ASSIGNMENT_ROLES.indexOf(role);
  return index === -1 ? ASSIGNMENT_ROLES.length : index;
}
