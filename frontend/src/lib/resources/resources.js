// Shared helpers for resource profiles: the role and skill catalogs pills suggest from, skill
// levels, rate entry, and who can own work on a project (members plus allocated resources).

export const SKILL_LEVELS = Object.freeze([
  { label: 'Learning', value: 1 },
  { label: 'Working', value: 2 },
  { label: 'Proficient', value: 3 },
  { label: 'Advanced', value: 4 },
  { label: 'Expert', value: 5 },
]);

export function skillLevelLabel(level) {
  return SKILL_LEVELS.find((entry) => entry.value === Number(level))?.label ?? 'Proficient';
}

export const DEFAULT_ROLES = Object.freeze([
  'Project Manager', 'Program Manager', 'Product Owner', 'Product Manager', 'Scrum Master', 'Business Analyst',
  'Solution Architect', 'Technical Lead', 'Full-Stack Developer', 'Frontend Developer', 'Backend Developer',
  'Mobile Developer', 'Data Engineer', 'Data Scientist', 'DevOps Engineer', 'Cloud Engineer', 'QA Engineer',
  'Test Automation Engineer', 'UX Designer', 'UI Designer', 'Security Engineer', 'Database Administrator',
  'Technical Writer', 'Support Engineer', 'Consultant', 'Account Manager', 'Executive Sponsor',
]);

export const DEFAULT_SKILLS = Object.freeze([
  'Project Management', 'Agile / Scrum', 'Requirements Engineering', 'Business Analysis', 'Stakeholder Management',
  'Solution Architecture', 'API Design and Integration', 'JavaScript', 'TypeScript', 'Vue', 'React', 'Angular',
  'Node.js', 'Python', 'Java', 'C# / .NET', 'Go', 'SQL', 'MySQL', 'PostgreSQL', 'SQL Server', 'MongoDB',
  'AWS', 'Azure', 'Google Cloud', 'Docker', 'Kubernetes', 'DevOps and CI/CD', 'Terraform', 'Linux',
  'Security', 'Testing and QA', 'Test Automation', 'UI/UX Design', 'Figma', 'Accessibility',
  'Data Engineering', 'Data Analysis', 'Machine Learning', 'AI-Assisted Development', 'Mobile Development',
  'Technical Writing', 'Training', 'ERP', 'Salesforce', 'Power BI',
]);

function dedupe(values) {
  const seen = new Map();
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text && !seen.has(text.toLowerCase())) seen.set(text.toLowerCase(), text);
  }
  return [...seen.values()];
}

/** What people already use, most used first, then the shipped catalog. */
export function suggestionsFrom(resources = [], pick, defaults = []) {
  const counts = new Map();
  for (const resource of resources) {
    for (const value of pick(resource) ?? []) {
      const text = String(value ?? '').trim();
      if (!text) continue;
      const key = text.toLowerCase();
      const entry = counts.get(key) ?? { count: 0, text };
      entry.count += 1;
      counts.set(key, entry);
    }
  }
  const used = [...counts.values()].sort((left, right) => right.count - left.count || left.text.localeCompare(right.text)).map((entry) => entry.text);
  return dedupe([...used, ...defaults]);
}

export function roleSuggestions(resources) {
  return suggestionsFrom(resources, (resource) => resource.roles, DEFAULT_ROLES);
}

export function skillSuggestions(resources) {
  return suggestionsFrom(resources, (resource) => (resource.skills ?? []).map((skill) => skill.name), DEFAULT_SKILLS);
}

/**
 * Reads a typed rate or number: blank is null, "$1,250.50" is 1250.5. Returns { value } or
 * { error } so forms can say what is wrong.
 */
export function parseAmount(raw, { label = 'Value', max = 1_000_000 } = {}) {
  const text = String(raw ?? '').trim().replace(/[$,\s]/g, '');
  if (!text) return { value: null };
  if (!/^\d*\.?\d+$|^\d+\.$/.test(text)) return { error: `${label} must be a number, like 125 or 125.50.` };
  const value = Number(text);
  if (!Number.isFinite(value) || value > max) return { error: `${label} must be between 0 and ${max.toLocaleString()}.` };
  return { value: Math.round(value * 100) / 100 };
}

export function amountText(value) {
  return value == null || value === '' ? '' : String(Number(value));
}

export function money(value, currency = 'USD', { cents = false } = {}) {
  if (value == null || value === '') return '—';
  return new Intl.NumberFormat(undefined, { currency, maximumFractionDigits: cents ? 2 : 0, minimumFractionDigits: cents ? 2 : 0, style: 'currency' }).format(Number(value));
}

export const RESOURCE_ASSIGNEE_PREFIX = 'resource:';

export function resourceAssigneeId(resourceId) {
  return `${RESOURCE_ASSIGNEE_PREFIX}${resourceId}`;
}

export function isResourceAssignee(assigneeId) {
  return String(assigneeId ?? '').startsWith(RESOURCE_ASSIGNEE_PREFIX);
}

const LIVE = new Set(['proposed', 'approved', 'active', 'held']);

export function liveAllocations(team, projectId = team?.projectId) {
  return (team?.allocations ?? []).filter((allocation) => allocation.projectId === projectId && LIVE.has(allocation.status));
}

/**
 * Everyone who can own work on the project: its members, then allocated resources that aren't
 * already members (a resource with a login is offered as that user; one without, as itself).
 */
export function projectAssignees(members = [], team = null) {
  const people = members.map((member) => ({ ...member }));
  const seen = new Set(people.map((member) => member.id));
  for (const person of team?.people ?? []) {
    if (seen.has(person.assigneeId)) continue;
    seen.add(person.assigneeId);
    people.push({
      email: '',
      id: person.assigneeId,
      name: person.resource.name,
      resourceOnly: !person.resource.userId,
      role: null,
    });
  }
  return people;
}

/**
 * One row per person on the project for the Resources tab: project members and allocated
 * resources, joined through each resource's linked login.
 */
export function projectTeamRows({ members = [], team = null, projectId = team?.projectId } = {}) {
  const resources = new Map([...(team?.directory ?? []), ...(team?.people ?? []).map((person) => person.resource)].map((resource) => [resource.id, resource]));
  const allocationsByResource = new Map();
  for (const allocation of (team?.allocations ?? []).filter((entry) => entry.projectId === projectId)) {
    allocationsByResource.set(allocation.resourceId, [...(allocationsByResource.get(allocation.resourceId) ?? []), allocation]);
  }
  const resourceByUser = new Map([...resources.values()].filter((resource) => resource.userId).map((resource) => [resource.userId, resource]));
  const pickAllocation = (resourceId) => {
    const list = allocationsByResource.get(resourceId) ?? [];
    return list.find((entry) => LIVE.has(entry.status) && entry.scenario === 'baseline') ?? list.find((entry) => LIVE.has(entry.status)) ?? null;
  };
  const rows = [];
  const covered = new Set();
  for (const member of members) {
    const resource = resourceByUser.get(member.id) ?? null;
    if (resource) covered.add(resource.id);
    rows.push({
      access: member.role ?? 'user',
      allocation: resource ? pickAllocation(resource.id) : null,
      assigneeId: member.id,
      email: member.email ?? '',
      key: `user:${member.id}`,
      name: member.name || resource?.name || member.email,
      resource,
      userId: member.id,
    });
  }
  for (const person of team?.people ?? []) {
    if (covered.has(person.resource.id)) continue;
    rows.push({
      access: null,
      allocation: pickAllocation(person.resource.id),
      assigneeId: person.assigneeId,
      email: '',
      key: `resource:${person.resource.id}`,
      name: person.resource.name,
      resource: resources.get(person.resource.id) ?? person.resource,
      userId: person.resource.userId ?? null,
    });
  }
  return rows.sort((left, right) => left.name.localeCompare(right.name));
}

export function hoursSummary(allocation) {
  if (!allocation) return 'Not allocated';
  if (!Number(allocation.hoursPerWeek) && !Number(allocation.allocationPercent)) return 'Hours not set';
  return `${Number(allocation.hoursPerWeek)} h/wk · ${Number(allocation.allocationPercent)}%`;
}

/** Open work items each assignee owns in a project tree. */
export function openItemCounts(project) {
  const counts = new Map();
  const done = (status) => /^(done|completed|closed|cancel)/i.test(String(status ?? ''));
  const walk = (nodes) => {
    for (const node of nodes ?? []) {
      if (node?.assigneeId && !done(node.status)) counts.set(node.assigneeId, (counts.get(node.assigneeId) ?? 0) + 1);
      walk(node?.stories);
      walk(node?.tasks);
    }
  };
  walk(project?.epics);
  return counts;
}

export function initials(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts.at(-1)[0] : '')).toUpperCase() || '?';
}
