// A project is a delivery project (every project made before 0095) or an engagement: a sales
// engagement that stays out of delivery views until someone converts it (docs/engagements/plan.md).

export const PROJECT_KIND_DELIVERY = 'delivery';
export const PROJECT_KIND_ENGAGEMENT = 'engagement';
export const ENGAGEMENT_STATUSES = Object.freeze(['open', 'won', 'lost']);

export function projectKindOf(project) {
  return project?.kind === PROJECT_KIND_ENGAGEMENT ? PROJECT_KIND_ENGAGEMENT : PROJECT_KIND_DELIVERY;
}

export function isEngagementProject(project) {
  return projectKindOf(project) === PROJECT_KIND_ENGAGEMENT;
}

// SQL condition for delivery projects only; `alias` is the projects table alias ('' for none).
export function deliveryProjectSql(alias = 'p') {
  return `${alias ? `${alias}.` : ''}kind = '${PROJECT_KIND_DELIVERY}'`;
}

// The engagement fields a project record carries; all null on a delivery project that was
// never an engagement.
export function engagementFieldsOf(project) {
  return {
    closedAt: project?.closedAt ?? null,
    convertedAt: project?.convertedAt ?? null,
    convertedBy: project?.convertedBy ?? null,
    engagementCustomer: project?.engagementCustomer ?? null,
    engagementOwnerId: project?.engagementOwnerId ?? null,
    engagementStatus: project?.engagementStatus ?? null,
    kind: projectKindOf(project),
  };
}
