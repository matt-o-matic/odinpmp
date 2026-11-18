import { createHash } from 'node:crypto';

import { PROJECT_CAPABILITIES, getTenantMembership, requireProjectCapability } from '../../lib/auth/project-capabilities.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { isEngagementProject } from '../../lib/projects/project-kind.js';
import { assertRecordsNotHeld } from '../compliance/legal-hold.js';
import { inDeletedProject, loadDeletedProjectIds } from './deleted-project-scope.js';
import { formatReportExport } from './report-export.js';
import { findEmailOptOuts, isOptedOut } from '../users/notification-preferences.js';
import { CONSULTING_MODULE } from '../workspace-modules/workspace-modules.repository.js';
import { isModuleEnabled } from '../workspace-modules/workspace-modules.service.js';
import { buildChannelSearchDocuments, loadChannelSearchSources } from './channel-search-documents.js';
import { buildCommentDocuments, buildFileDocuments, projectWorkItems, splitLongDocuments, workItemDocument } from './search-documents.js';
import { ensureSearchIndexFresh } from './search-index-freshness.js';
import { embedSearchChanges, planSearchChanges, refreshAllSearchIndexes, searchEmbeddingProviderOf, updateSearchFileTexts } from './search-index.service.js';

const DATASET_COLUMNS = Object.freeze({
  executive: ['projectId', 'projectName', 'status', 'progressPercent', 'epicCount', 'storyCount', 'taskCount', 'openRiskCount', 'criticalRiskCount', 'pendingApprovalCount', 'allocatedHoursPerWeek', 'budget', 'forecast', 'actualCost'],
  portfolio: ['projectId', 'projectName', 'portfolioNodeId', 'portfolioName', 'objectiveId', 'objectiveTitle', 'demandStatus', 'scenario', 'strategicScore', 'riskScore', 'costScore', 'benefitValue', 'benefitUnit'],
  project: ['projectId', 'projectName', 'status', 'startDate', 'endDate', 'progressPercent', 'epicCount', 'storyCount', 'taskCount'],
  work_items: ['projectId', 'projectName', 'itemType', 'itemId', 'name', 'status', 'assigneeId', 'priority', 'points', 'startDate', 'endDate', 'progress'],
  sprint: ['projectId', 'projectName', 'sprintId', 'sprintName', 'status', 'startDate', 'endDate', 'goal'],
  resource: ['resourceId', 'resourceName', 'poolId', 'location', 'roles', 'skills', 'capacityHoursPerWeek', 'allocatedHoursPerWeek', 'utilizationPercent', 'overallocated'],
  financial: ['projectId', 'projectName', 'entryId', 'entryKind', 'category', 'status', 'effectiveDate', 'amount', 'currency'],
  risk: ['projectId', 'projectName', 'itemId', 'kind', 'title', 'impact', 'probability', 'status', 'ownerId', 'dueDate'],
  agent_governance: ['projectId', 'projectName', 'goalId', 'title', 'status', 'ownerUserId', 'activeMonitorCount', 'runCount', 'unreadNotificationCount'],
  workflow: ['projectId', 'projectName', 'itemType', 'itemId', 'transitionKey', 'fromState', 'toState', 'occurredAt', 'slaDueAt', 'slaOverdue', 'pendingApprovalCount'],
});

function tenantIdFor(user) { const tenantId = user?.memberships?.[0]?.tenantId; if (!tenantId) throw new HttpError(403, 'This account is not assigned to a tenant.'); return tenantId; }
function tenantRole(user, tenantId) { return String(getTenantMembership(user, tenantId)?.role ?? '').toLowerCase(); }
function canManage(user, tenantId) { return ['admin', 'manager'].includes(tenantRole(user, tenantId)); }
function requireManager(user, tenantId) { if (!canManage(user, tenantId)) throw new HttpError(404, 'Reporting record not found.'); }
function flattenProject(project) {
  const records = [];
  for (const epic of project.epics ?? []) { records.push({ item: epic, itemType: 'epic' }); for (const story of epic.stories ?? []) { records.push({ item: story, itemType: 'story' }); for (const task of story.tasks ?? []) records.push({ item: task, itemType: 'task' }); } }
  return records;
}
function progress(records) { if (!records.length) return 0; return Math.round(records.reduce((sum, record) => sum + Number(record.item.progress ?? (String(record.item.status).toLowerCase().includes('complete') || String(record.item.status).toLowerCase() === 'done' ? 100 : 0)), 0) / records.length * 100) / 100; }
function projectUrl(projectId, suffix = '') { return `/projects/${encodeURIComponent(projectId)}${suffix}`; }
function text(value) { return String(value ?? '').trim(); }
function latestIso(values) { const valid = values.filter(Boolean).sort(); return valid.at(-1) ?? new Date(0).toISOString(); }

async function loadReportingContext({ agentExecutionRepository, authorizedProjectIds = null, governanceRepository, portfolioRepository, projectRepository, resourceFinanceRepository, tenantId, user, workflowRepository }) {
  const visibleSummaries = Array.isArray(authorizedProjectIds)
    // Engagements stay out of reporting datasets and BI feeds, as listProjectsForTenant leaves them out.
    ? (await Promise.all([...new Set(authorizedProjectIds)].slice(0, 500).map((projectId) => projectRepository.getProjectDetail({ projectId, tenantId })))).filter((project) => project && !isEngagementProject(project))
    : await projectRepository.listProjectsForTenant({ tenantId, user });
  if (visibleSummaries.length > 500) throw new HttpError(413, 'Reporting currently supports at most 500 visible projects per materialization. Narrow the tenant scope.');
  const projects = (await Promise.all(visibleSummaries.map((summary) => projectRepository.getProjectDetail({ projectId: summary.id, tenantId })))).filter(Boolean);
  const governance = new Map(await Promise.all(projects.map(async (project) => [project.id, governanceRepository?.listSnapshot ? await governanceRepository.listSnapshot({ projectId: project.id, tenantId }) : { dependencies: [], items: [], milestones: [] }])));
  const [portfolio, resources, workflows, deletedProjectIds] = await Promise.all([
    portfolioRepository?.listSnapshot ? portfolioRepository.listSnapshot({ tenantId }) : { alignments: [], nodes: [], objectives: [] },
    resourceFinanceRepository?.listSnapshot ? resourceFinanceRepository.listSnapshot({ tenantId }) : { allocations: [], calendarEntries: [], expenses: [], financialEntries: [], pools: [], resources: [], timeEntries: [] },
    workflowRepository?.listSnapshot ? workflowRepository.listSnapshot({ tenantId }) : { approvals: [], baselines: [], bindings: [], customFields: [], customValues: [], histories: [], templates: [], workflows: [] },
    loadDeletedProjectIds(projectRepository, tenantId),
  ]);
  const goals = agentExecutionRepository?.listGoals ? await agentExecutionRepository.listGoals({ tenantId }) : [];
  const goalDetails = new Map();
  if (agentExecutionRepository) for (const goal of goals) goalDetails.set(goal.id, {
    monitors: agentExecutionRepository.listMonitors ? await agentExecutionRepository.listMonitors({ goalId: goal.id, tenantId }) : [],
    notifications: agentExecutionRepository.listNotifications ? await agentExecutionRepository.listNotifications({ goalId: goal.id, tenantId }) : [],
    runs: agentExecutionRepository.listRuns ? await agentExecutionRepository.listRuns({ goalId: goal.id, tenantId }) : [],
  });
  // Resource utilization counts allocations on every project, so a deleted project's are removed here.
  const liveResources = { ...resources, allocations: (resources.allocations ?? []).filter((item) => !inDeletedProject(item, deletedProjectIds)) };
  return { goalDetails, goals, governance, portfolio, projects, resources: liveResources, workflows };
}

// The most rows one workspace's index holds; passages of long files count one each.
export const SEARCH_INDEX_ROWS = 100_000;

// Every project of the workspace for comment and file rows: the detailed ones (with their work
// items) where reporting loaded them, and engagements from the channel sources.
function searchProjects(context) {
  const byId = new Map((context.channelSources?.projects ?? []).map((project) => [project.id, project]));
  for (const project of context.projects ?? []) byId.set(project.id, project);
  return [...byId.values()];
}

export function buildSearchDocuments(context) {
  const documents = [];
  for (const project of context.projects) {
    documents.push({ content: `${project.description ?? ''} ${project.status ?? ''}`, documentType: 'project', facets: { status: project.status }, projectId: project.id, sourceId: project.id, title: project.name, updatedAt: project.updatedAt, url: projectUrl(project.id) });
    for (const record of projectWorkItems(project)) documents.push(workItemDocument(project, record));
    const snapshot = context.governance.get(project.id);
    for (const item of snapshot.items) documents.push({ content: `${item.description} ${item.responsePlan} ${item.status}`, documentType: item.kind, facets: { impact: item.impact, status: item.status }, projectId: project.id, sourceId: item.id, title: item.title, updatedAt: item.updatedAt, url: projectUrl(project.id, '/governance') });
    for (const milestone of snapshot.milestones) documents.push({ content: `${milestone.status} ${milestone.targetDate ?? ''}`, documentType: 'milestone', facets: { status: milestone.status }, projectId: project.id, sourceId: milestone.id, title: milestone.title, updatedAt: milestone.updatedAt, url: projectUrl(project.id, '/governance') });
  }
  for (const node of context.portfolio.nodes) documents.push({ content: `${node.description} ${node.governanceStage} ${node.status}`, documentType: node.kind, facets: { status: node.status }, projectId: null, sourceId: node.id, title: node.name, updatedAt: node.updatedAt, url: '/portfolio' });
  for (const objective of context.portfolio.objectives) documents.push({ content: `${objective.description ?? ''} ${objective.status} ${objective.unit}`, documentType: objective.kind, facets: { status: objective.status }, projectId: null, sourceId: objective.id, title: objective.title, updatedAt: objective.updatedAt, url: '/portfolio' });
  for (const goal of context.goals.filter((record) => record.projectId)) documents.push({ content: `${goal.status} ${JSON.stringify(goal.success)} ${JSON.stringify(goal.scope)}`, documentType: 'agent_goal', facets: { status: goal.status }, projectId: goal.projectId, sourceId: goal.id, title: goal.title, updatedAt: goal.updatedAt, url: projectUrl(goal.projectId, '/governance') });
  // Channels and posts, then comments, then files with their text, after the records above so
  // the index cap drops them first (docs/semantic-search/plan.md).
  if (context.channelSources) documents.push(...buildChannelSearchDocuments(context.channelSources));
  const allProjects = searchProjects(context);
  if (context.comments) documents.push(...buildCommentDocuments({ comments: context.comments, projects: allProjects }));
  if (context.files) documents.push(...buildFileDocuments({ channels: context.channelSources?.channels, files: context.files, folders: context.channelSources?.folders, projects: allProjects, texts: context.fileTexts }));
  const indexedAt = new Date().toISOString();
  return splitLongDocuments(documents.filter((document) => document.sourceId && document.title)).slice(0, SEARCH_INDEX_ROWS).map((document) => { const normalized = { ...document, updatedAt: document.updatedAt || indexedAt }; return { ...normalized, sourceHash: createHash('sha256').update(JSON.stringify(normalized)).digest('hex') }; });
}

function parseCsvSet(value, pattern = /^[a-z_]+$/) { return [...new Set(String(value ?? '').split(',').map((part) => part.trim()).filter((part) => part && pattern.test(part)))]; }
function parseFacets(value) { const result = {}; for (const part of String(value ?? '').split(',')) { const [key, ...rest] = part.split(':'); const facetValue = rest.join(':').trim(); if (/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key?.trim()) && facetValue) result[key.trim()] = facetValue; } return result; }
function matchesFacets(record, facets) { return Object.entries(facets).every(([key, value]) => String(record.facets?.[key] ?? '') === value); }

// The index holds every project in the tenant, built as a tenant-wide principal; searchForUser
// filters rows to the searcher's visible projects at query time, so the build can't widen access.
function searchIndexPrincipal(tenantId) { return { id: 'system:search-index', memberships: [{ role: 'admin', tenantId }] }; }

// One refresh of a workspace at a time, whoever starts it: two overlapping refreshes could write
// an older snapshot over a newer one (search-index.repository.js withSearchIndexLock).
export function refreshTenantSearchIndex({ dependencies, repository, tenantId }) {
  const run = () => refreshTenantSearchIndexNow({ dependencies, repository, tenantId });
  return repository.withSearchIndexLock ? repository.withSearchIndexLock(tenantId, run) : run();
}

async function refreshTenantSearchIndexNow({ dependencies, repository, tenantId }) {
  const principal = searchIndexPrincipal(tenantId);
  const { projectRepository } = dependencies;
  const [reporting, channelSources, comments, files] = await Promise.all([
    loadReportingContext({ ...dependencies, tenantId, user: principal }),
    loadChannelSearchSources({ projectRepository, tenantId, user: principal }),
    projectRepository?.listSearchComments ? projectRepository.listSearchComments({ tenantId }) : null,
    projectRepository?.listSearchFileSources ? projectRepository.listSearchFileSources({ tenantId }) : null,
  ]);
  const fileTexts = files ? await updateSearchFileTexts({ files, projectRepository, repository, tenantId }) : new Map();
  const documents = buildSearchDocuments({ ...reporting, channelSources, comments, fileTexts, files });
  const provider = searchEmbeddingProviderOf(dependencies);
  const { changed, deletes, reembed } = planSearchChanges({ documents, manifests: await repository.listDocumentManifests({ tenantId }), provider });
  const { semanticIndexed, semanticStatus, upserts } = await embedSearchChanges({ changed, provider, reembed, tenantId });
  if (repository.applySearchChanges) await repository.applySearchChanges({ deletes, tenantId, upserts });
  else await repository.syncDocuments({ documents, tenantId });
  return { changed: changed.length, deleted: deletes.length, indexed: documents.length, ok: true, refreshedAt: new Date().toISOString(), semanticIndexed, semanticStatus };
}

/** Refreshes every workspace's index (the scheduled refresh, startSearchIndexScheduler). */
export function refreshEverySearchIndex({ dependencies, repository }) {
  return refreshAllSearchIndexes({ refreshTenant: (tenantId) => refreshTenantSearchIndex({ dependencies, repository, tenantId }), repository });
}

export async function refreshSearchIndexForUser({ dependencies, repository, user }) {
  const tenantId = tenantIdFor(user); requireManager(user, tenantId);
  return refreshTenantSearchIndex({ dependencies, repository, tenantId });
}

// projectOnly: search the named project alone, without workspace-wide records (an MCP grant limited
// to some projects).
export async function searchForUser({ dependencies, input, projectOnly = false, repository, user }) {
  const tenantId = tenantIdFor(user);
  if (projectOnly && !input.projectId) throw new HttpError(404, 'Project not found.');
  // Engagements' channels are searched while the Consulting module is on (E-11), and an
  // engagement named by projectId answers 404 while it is off, as its project URL does.
  const includeEngagements = await isModuleEnabled(dependencies.workspaceModulesRepository, tenantId, CONSULTING_MODULE);
  if (input.projectId) {
    await requireProjectCapability({ capability: PROJECT_CAPABILITIES.READ, projectId: input.projectId, repository: dependencies.projectRepository, tenantId, user });
    const kind = dependencies.projectRepository.getProjectKind ? await dependencies.projectRepository.getProjectKind({ projectId: input.projectId }) : null;
    if (!includeEngagements && isEngagementProject(kind ?? {})) throw new HttpError(404, 'Project not found.');
  }
  await ensureSearchIndexFresh({ maxAgeMs: dependencies.searchIndexMaxAgeMs, refresh: () => refreshTenantSearchIndex({ dependencies, repository, tenantId }), repository, tenantId });
  const projects = await dependencies.projectRepository.listProjectsForTenant({ includeEngagements, tenantId, user }); const projectIds = input.projectId ? [input.projectId] : projects.map((project) => project.id);
  const types = parseCsvSet(input.types); const facets = parseFacets(input.facets);
  const expandedLimit = facets && Object.keys(facets).length ? Math.min(1000, input.offset + input.limit * 5) : input.limit;
  // Without an embedding (no key, or the call failed) the search is by keyword only.
  const provider = searchEmbeddingProviderOf(dependencies);
  let queryEmbedding = null;
  if (provider) try { queryEmbedding = await provider.embed({ content: input.query, tenantId, title: 'Search' }); } catch { queryEmbedding = null; }
  const result = await repository.searchDocuments({ includeWorkspace: !projectOnly, limit: expandedLimit, offset: facets && Object.keys(facets).length ? 0 : input.offset, projectIds, query: input.query, queryEmbedding, ...(dependencies.searchSemanticFloor != null ? { semanticFloor: dependencies.searchSemanticFloor } : {}), tenantId, types });
  const filtered = result.records.filter((record) => matchesFacets(record, facets));
  const records = Object.keys(facets).length ? filtered.slice(input.offset, input.offset + input.limit) : filtered;
  const facetCounts = {};
  // A file's id and a passage number identify a row; they are not filters.
  for (const record of filtered) for (const [key, value] of Object.entries(record.facets ?? {})) { if (key === 'fileId' || key === 'passage') continue; facetCounts[key] ??= {}; facetCounts[key][value] = (facetCounts[key][value] ?? 0) + 1; }
  return { facetCounts, indexedFreshness: latestIso(records.map((record) => record.indexedAt)), limit: input.limit, offset: input.offset, records, total: Object.keys(facets).length ? filtered.length : result.total };
}

function reportVisible(report, { deletedProjectIds, projectIds, user }) { return !inDeletedProject(report, deletedProjectIds) && (report.ownerUserId === user.id || report.visibility === 'tenant' || (report.visibility === 'project' && report.projectId && projectIds.has(report.projectId))); }
function viewVisible(view, context) { return !inDeletedProject(view, context.deletedProjectIds) && (view.ownerUserId === context.user.id || view.visibility === 'tenant' || (view.visibility === 'project' && view.projectId && context.projectIds.has(view.projectId))); }
function assertManagedRecord(record, user, tenantId) { if (!record || (record.ownerUserId !== user.id && tenantRole(user, tenantId) !== 'admin')) throw new HttpError(404, 'Reporting record not found.'); }
function assertVisibilityWrite(input, user, tenantId) { if (input.visibility === 'tenant') requireManager(user, tenantId); }
function assertVisibilityScope(input) { if (input.visibility === 'project' && !input.projectId) throw new HttpError(400, 'Project-visible reporting records require a project scope.'); }
async function assertProject(input, dependencies, tenantId, user, capability = PROJECT_CAPABILITIES.READ) { if (input.projectId) await requireProjectCapability({ capability, projectId: input.projectId, repository: dependencies.projectRepository, tenantId, user }); }

export async function getReportingWorkspaceForUser({ dependencies, input, repository, user }) {
  const tenantId = tenantIdFor(user); if (input.projectId) await assertProject(input, dependencies, tenantId, user);
  const [snapshot, projects, deletedProjectIds] = await Promise.all([repository.listSnapshot({ tenantId }), dependencies.projectRepository.listProjectsForTenant({ tenantId, user }), loadDeletedProjectIds(dependencies.projectRepository, tenantId)]); const projectIds = new Set(projects.map((project) => project.id)); const context = { deletedProjectIds, projectIds, tenantId, user };
  let reports = snapshot.reports.filter((record) => reportVisible(record, context) && (!input.projectId || record.projectId === input.projectId) && (!input.status || record.status === input.status) && (!input.query || `${record.name} ${record.description}`.toLowerCase().includes(input.query.toLowerCase())));
  const total = reports.length; reports = reports.sort((a, b) => a.name.localeCompare(b.name)).slice(input.offset, input.offset + input.limit); const reportIds = new Set(reports.map((record) => record.id));
  const visibleViews = snapshot.views.filter((record) => viewVisible(record, context) && (!input.projectId || record.projectId === input.projectId));
  const latestSnapshots = new Map(); for (const item of snapshot.snapshots.filter((record) => reportIds.has(record.reportId)).sort((a, b) => a.generatedAt.localeCompare(b.generatedAt))) latestSnapshots.set(item.reportId, canManage(user, tenantId) ? { ...item, data: (item.data ?? []).filter((row) => !inDeletedProject(row, deletedProjectIds)) } : { ...item, data: (item.data ?? []).filter((row) => row.projectId && projectIds.has(row.projectId)) });
  return { canManage: canManage(user, tenantId), datasetColumns: DATASET_COLUMNS, latestSnapshots: Object.fromEntries(latestSnapshots), limit: input.limit, offset: input.offset, projects, reports, runs: snapshot.runs.filter((record) => reportIds.has(record.reportId)).slice(-100), subscriptions: snapshot.subscriptions.filter((record) => record.ownerUserId === user.id && reportIds.has(record.reportId)), total, views: visibleViews };
}

export async function createReportingRecordForUser({ dependencies, input, kind, repository, user }) {
  const tenantId = tenantIdFor(user); assertVisibilityWrite(input, user, tenantId); assertVisibilityScope(input); await assertProject(input, dependencies, tenantId, user);
  if (kind === 'report') validateReportDefinition(input);
  const method = kind === 'report' ? 'createReport' : 'createView'; const value = await repository[method]({ input, ownerUserId: user.id, tenantId }); return { ok: true, value };
}
export async function updateReportingRecordForUser({ dependencies, id, input, kind, repository, user }) {
  const tenantId = tenantIdFor(user); const snapshot = await repository.listSnapshot({ tenantId }); const collection = kind === 'report' ? 'reports' : 'views'; const current = snapshot[collection].find((record) => record.id === id); assertManagedRecord(current, user, tenantId); const effective = { ...current, ...input }; assertVisibilityWrite(effective, user, tenantId); assertVisibilityScope(effective); await assertProject(effective, dependencies, tenantId, user); if (kind === 'report') validateReportDefinition(effective);
  const method = kind === 'report' ? 'updateReport' : 'updateView'; const key = kind === 'report' ? { reportId: id } : { viewId: id }; const value = await repository[method]({ input, tenantId, ...key }); return { ok: true, value };
}
export async function deleteReportingRecordForUser({ complianceRepository, expectedVersion, id, kind, repository, user }) {
  const tenantId = tenantIdFor(user); const snapshot = await repository.listSnapshot({ tenantId }); const collection = kind === 'report' ? 'reports' : kind === 'view' ? 'views' : 'subscriptions'; const current = snapshot[collection].find((record) => record.id === id); assertManagedRecord(current, user, tenantId);
  if (kind === 'report') await assertRecordsNotHeld({ repository: complianceRepository, resources: [{ resourceId: id, resourceType: 'report' }], tenantId });
  const method = kind === 'report' ? 'deleteReport' : kind === 'view' ? 'deleteView' : 'deleteSubscription'; const key = kind === 'report' ? { reportId: id } : kind === 'view' ? { viewId: id } : { subscriptionId: id }; if (!await repository[method]({ expectedVersion, tenantId, ...key })) throw new HttpError(404, 'Reporting record not found.'); return { ok: true };
}
function validateReportDefinition(report) { const allowed = new Set(DATASET_COLUMNS[report.dataset] ?? []); const invalid = report.columns.filter((column) => !allowed.has(column)); if (invalid.length) throw new HttpError(400, `Unsupported ${report.dataset} report columns: ${invalid.join(', ')}.`); }

export async function createSubscriptionForUser({ dependencies, input, repository, user }) {
  const tenantId = tenantIdFor(user); const snapshot = await repository.listSnapshot({ tenantId }); const projects = await dependencies.projectRepository.listProjectsForTenant({ tenantId, user }); const report = snapshot.reports.find((record) => record.id === input.reportId); if (!report || !reportVisible(report, { deletedProjectIds: await loadDeletedProjectIds(dependencies.projectRepository, tenantId), projectIds: new Set(projects.map((project) => project.id)), tenantId, user })) throw new HttpError(404, 'Report not found.');
  if (input.deliveryChannel === 'email' && !input.recipients.length) throw new HttpError(400, 'Email subscriptions require at least one recipient.');
  if (input.deliveryChannel === 'email' && !canManage(user, tenantId) && input.recipients.some((email) => email.toLowerCase() !== String(user.email ?? '').toLowerCase())) throw new HttpError(403, 'Only managers may deliver reports to other recipients.');
  return { ok: true, value: await repository.createSubscription({ input, ownerUserId: user.id, tenantId }) };
}
export async function updateSubscriptionForUser({ dependencies, input, repository, subscriptionId, user }) {
  const tenantId = tenantIdFor(user); const snapshot = await repository.listSnapshot({ tenantId }); const current = snapshot.subscriptions.find((record) => record.id === subscriptionId); assertManagedRecord(current, user, tenantId); const effective = { ...current, ...input }; if (effective.deliveryChannel === 'email' && !effective.recipients.length) throw new HttpError(400, 'Email subscriptions require recipients.');
  const projects = await dependencies.projectRepository.listProjectsForTenant({ tenantId, user }); const report = snapshot.reports.find((record) => record.id === effective.reportId); if (!report || !reportVisible(report, { deletedProjectIds: await loadDeletedProjectIds(dependencies.projectRepository, tenantId), projectIds: new Set(projects.map((project) => project.id)), tenantId, user })) throw new HttpError(404, 'Report not found.');
  if (effective.deliveryChannel === 'email' && !canManage(user, tenantId) && effective.recipients.some((email) => email.toLowerCase() !== String(user.email ?? '').toLowerCase())) throw new HttpError(403, 'Only managers may deliver reports to other recipients.');
  const value = await repository.updateSubscription({ input, subscriptionId, tenantId }); return { ok: true, value };
}

function projectMap(context) { return new Map(context.projects.map((project) => [project.id, project])); }
function moneyByKind(entries, projectId, kind) { return entries.filter((entry) => entry.projectId === projectId && entry.entryKind === kind && ['approved', 'posted'].includes(entry.status)).reduce((sum, entry) => sum + Number(entry.amount ?? 0), 0); }
function datasetRows(dataset, context, { financeAuthorized, now }) {
  const projectsById = projectMap(context); const projectStats = new Map(context.projects.map((project) => { const work = flattenProject(project); return [project.id, { epicCount: work.filter((r) => r.itemType === 'epic').length, progressPercent: progress(work), storyCount: work.filter((r) => r.itemType === 'story').length, taskCount: work.filter((r) => r.itemType === 'task').length }]; }));
  if (dataset === 'project') return context.projects.map((project) => ({ endDate: project.endDate, projectId: project.id, projectName: project.name, startDate: project.startDate, status: project.status, ...projectStats.get(project.id) }));
  if (dataset === 'work_items') return context.projects.flatMap((project) => flattenProject(project).map(({ item, itemType }) => ({ assigneeId: item.assigneeId, endDate: item.targetEndDate, itemId: item.id, itemType, name: item.name, points: item.points, priority: item.priority, progress: item.progress, projectId: project.id, projectName: project.name, startDate: item.targetStartDate, status: item.status })));
  if (dataset === 'sprint') return context.projects.flatMap((project) => (project.sprints ?? []).map((sprint) => ({ endDate: sprint.endDate, goal: sprint.goal, projectId: project.id, projectName: project.name, sprintId: sprint.id, sprintName: sprint.name, startDate: sprint.startDate, status: sprint.status })));
  if (dataset === 'risk') return context.projects.flatMap((project) => context.governance.get(project.id).items.map((item) => ({ dueDate: item.dueDate, impact: item.impact, itemId: item.id, kind: item.kind, ownerId: item.ownerId, probability: item.probability, projectId: project.id, projectName: project.name, status: item.status, title: item.title })));
  if (dataset === 'portfolio') return context.portfolio.alignments.filter((item) => projectsById.has(item.projectId)).map((item) => ({ ...item, objectiveTitle: context.portfolio.objectives.find((record) => record.id === item.objectiveId)?.title ?? '', portfolioName: context.portfolio.nodes.find((record) => record.id === item.portfolioNodeId)?.name ?? '', projectName: projectsById.get(item.projectId)?.name ?? item.projectId }));
  if (dataset === 'resource') return context.resources.resources.map((resource) => { const active = context.resources.allocations.filter((item) => item.resourceId === resource.id && ['approved', 'active'].includes(item.status)); const allocatedHoursPerWeek = active.reduce((sum, item) => sum + Number(item.hoursPerWeek), 0); return { allocatedHoursPerWeek, capacityHoursPerWeek: resource.capacityHoursPerWeek, location: resource.location, overallocated: allocatedHoursPerWeek > resource.capacityHoursPerWeek, poolId: resource.poolId, resourceId: resource.id, resourceName: resource.name, roles: resource.roles, skills: resource.skills.map((skill) => skill.name), utilizationPercent: resource.capacityHoursPerWeek ? Math.round(allocatedHoursPerWeek / resource.capacityHoursPerWeek * 10000) / 100 : 0 }; });
  if (dataset === 'financial') { if (!financeAuthorized) throw new HttpError(404, 'Report not found.'); return context.resources.financialEntries.filter((entry) => projectsById.has(entry.projectId)).map((entry) => ({ amount: entry.amount, category: entry.category, currency: entry.currency, effectiveDate: entry.effectiveDate, entryId: entry.id, entryKind: entry.entryKind, projectId: entry.projectId, projectName: projectsById.get(entry.projectId).name, status: entry.status })); }
  if (dataset === 'agent_governance') return context.goals.filter((goal) => projectsById.has(goal.projectId)).map((goal) => { const detail = context.goalDetails.get(goal.id); return { activeMonitorCount: detail.monitors.filter((item) => item.enabled).length, goalId: goal.id, ownerUserId: goal.ownerUserId, projectId: goal.projectId, projectName: projectsById.get(goal.projectId).name, runCount: detail.runs.length, status: goal.status, title: goal.title, unreadNotificationCount: detail.notifications.filter((item) => item.status === 'unread').length }; });
  if (dataset === 'workflow') {
    const visibleHistories = context.workflows.histories.filter((item) => projectsById.has(item.projectId));
    const latestHistoryIds = new Set();
    const latestByItem = new Map();
    for (const item of visibleHistories) {
      const key = `${item.projectId}:${item.itemType}:${item.itemId}`;
      const latest = latestByItem.get(key);
      if (!latest || `${item.occurredAt}:${item.id}` > `${latest.occurredAt}:${latest.id}`) latestByItem.set(key, item);
    }
    for (const item of latestByItem.values()) latestHistoryIds.add(item.id);
    return visibleHistories.map((item) => ({ fromState: item.fromState, itemId: item.itemId, itemType: item.itemType, occurredAt: item.occurredAt, pendingApprovalCount: context.workflows.approvals.filter((approval) => approval.projectId === item.projectId && approval.itemId === item.itemId && approval.status === 'pending').length, projectId: item.projectId, projectName: projectsById.get(item.projectId).name, slaDueAt: item.slaDueAt, slaOverdue: Boolean(latestHistoryIds.has(item.id) && item.slaDueAt && Date.parse(item.slaDueAt) < now.getTime()), toState: item.toState, transitionKey: item.transitionKey }));
  }
  if (dataset === 'executive') return context.projects.map((project) => { const governance = context.governance.get(project.id); const allocations = context.resources.allocations.filter((item) => item.projectId === project.id && ['approved', 'active'].includes(item.status)); return { actualCost: financeAuthorized ? moneyByKind(context.resources.financialEntries, project.id, 'actual_cost') : null, allocatedHoursPerWeek: allocations.reduce((sum, item) => sum + Number(item.hoursPerWeek), 0), budget: financeAuthorized ? moneyByKind(context.resources.financialEntries, project.id, 'budget') : null, criticalRiskCount: governance.items.filter((item) => item.kind === 'risk' && item.impact === 'critical' && !['closed', 'accepted'].includes(item.status)).length, forecast: financeAuthorized ? moneyByKind(context.resources.financialEntries, project.id, 'forecast') : null, openRiskCount: governance.items.filter((item) => item.kind === 'risk' && !['closed', 'accepted'].includes(item.status)).length, pendingApprovalCount: context.workflows.approvals.filter((item) => item.projectId === project.id && item.status === 'pending').length, projectId: project.id, projectName: project.name, status: project.status, ...projectStats.get(project.id) }; });
  return [];
}
function applyFilters(rows, filters) { return rows.filter((row) => Object.entries(filters ?? {}).every(([key, expected]) => expected == null || expected === '' || (Array.isArray(expected) ? expected.map(String).includes(String(row[key])) : String(row[key]) === String(expected)))); }
function selectColumns(rows, columns) { return rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column] ?? null]))); }
export async function executeReportForUser({ dependencies, input, reportId, repository, user }) {
  const tenantId = tenantIdFor(user); const [snapshot, visibleProjects, deletedProjectIds] = await Promise.all([repository.listSnapshot({ tenantId }), dependencies.projectRepository.listProjectsForTenant({ tenantId, user }), loadDeletedProjectIds(dependencies.projectRepository, tenantId)]); const report = snapshot.reports.find((record) => record.id === reportId); const projectIds = new Set(visibleProjects.map((project) => project.id)); if (!report || !reportVisible(report, { deletedProjectIds, projectIds, tenantId, user })) throw new HttpError(404, 'Report not found.');
  validateReportDefinition(report); const run = await repository.createRun({ format: input.format, parameters: input.parameters, reportId, requestedBy: user.id, tenantId });
  try {
    const context = await loadReportingContext({ ...dependencies, tenantId, user }); let rows = datasetRows(report.dataset, context, { financeAuthorized: canManage(user, tenantId), now: new Date() }); if (report.projectId) rows = rows.filter((row) => row.projectId === report.projectId); rows = applyFilters(rows, { ...report.filters, ...input.parameters }).slice(0, input.limit); rows = selectColumns(rows, report.columns);
    const freshness = { asOf: new Date().toISOString(), rowLevelSecurity: 'visible-project-set', source: 'transactional-read-model', truncated: rows.length === input.limit };
    const reportSnapshot = await repository.createSnapshot({ data: rows, freshness, reportId, runId: run.id, tenantId }); const exported = await formatReportExport({ columns: report.columns, format: input.format, rows, title: report.name }); await repository.finishRun({ rowCount: rows.length, runId: run.id, status: 'completed', tenantId });
    return { content: ['json', 'csv'].includes(input.format) ? exported.buffer.toString('utf8') : exported.buffer.toString('base64'), contentEncoding: ['json', 'csv'].includes(input.format) ? 'utf8' : 'base64', contentType: exported.contentType, extension: exported.extension, filename: `${report.name.replace(/[^a-z0-9_-]+/gi, '_').slice(0, 80) || 'report'}.${exported.extension}`, format: input.format, freshness, ok: true, rows: input.format === 'json' ? rows : [], runId: run.id, snapshotId: reportSnapshot.id };
  } catch (error) { await repository.finishRun({ error: error.message, runId: run.id, status: 'failed', tenantId }); throw error; }
}

function escapeHtml(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }
export async function materializeDueReportSubscriptions({ authRepository, dependencies, frontendAppUrl = '', limit = 50, mailRepository = null, now = new Date(), repository }) {
  const due = await repository.claimDueSubscriptions({ limit, now }); const results = [];
  for (const subscription of due) {
    const scheduledAt = new Date(subscription.scheduledFor); const nextRunAt = new Date(Math.max(now.getTime(), scheduledAt.getTime()) + Number(subscription.schedule.intervalMinutes) * 60_000);
    const user = await authRepository?.findUserById?.(subscription.ownerUserId);
    if (!user || !user.memberships?.some((membership) => membership.tenantId === subscription.tenantId)) {
      await repository.completeSubscriptionClaim({ expectedVersion: subscription.version, lastRunAt: now, leaseToken: subscription.leaseToken, nextRunAt, subscriptionId: subscription.id, tenantId: subscription.tenantId });
      results.push({ fencingToken: subscription.fencingToken, status: 'owner_unavailable', subscriptionId: subscription.id }); continue;
    }
    try {
      const result = await executeReportForUser({ dependencies, input: { format: subscription.format, limit: 10_000, parameters: {} }, reportId: subscription.reportId, repository, user });
      if (subscription.deliveryChannel === 'email' && mailRepository?.queueMail) {
        const reportUrl = `${String(frontendAppUrl).replace(/\/$/, '')}/reports?report=${encodeURIComponent(subscription.reportId)}&run=${encodeURIComponent(result.runId)}`;
        const optOuts = await findEmailOptOuts({ emails: subscription.recipients, kind: 'summaries', read: authRepository?.listUserPreferences?.bind(authRepository) });
        for (const recipientEmail of subscription.recipients.filter((email) => !isOptedOut(optOuts, { email }))) await mailRepository.queueMail({ body: `<p>Your scheduled OdinPMP report is ready.</p><p><a href="${escapeHtml(reportUrl)}">Open report</a></p><p>Format: ${escapeHtml(subscription.format.toUpperCase())}</p>`, recipientEmail, subject: 'Scheduled OdinPMP report ready', targetId: `report:${subscription.id}:${scheduledAt.toISOString()}:${recipientEmail}`, templateId: 'report_delivery' });
      }
      if (!await repository.completeSubscriptionClaim({ expectedVersion: subscription.version, lastRunAt: now, leaseToken: subscription.leaseToken, nextRunAt, subscriptionId: subscription.id, tenantId: subscription.tenantId })) throw new Error('Scheduled report lease was lost before completion.');
      results.push({ fencingToken: subscription.fencingToken, runId: result.runId, status: 'completed', subscriptionId: subscription.id });
    } catch (error) {
      await repository.completeSubscriptionClaim({ expectedVersion: subscription.version, lastRunAt: now, leaseToken: subscription.leaseToken, nextRunAt, subscriptionId: subscription.id, tenantId: subscription.tenantId });
      results.push({ error: error.message, fencingToken: subscription.fencingToken, status: 'failed', subscriptionId: subscription.id });
    }
  }
  return results;
}

export async function getBiFeedForUser({ dataset, dependencies, input, user }) {
  const tenantId = tenantIdFor(user); const context = await loadReportingContext({ ...dependencies, tenantId, user }); const allowed = DATASET_COLUMNS[dataset]; if (!allowed) throw new HttpError(404, 'BI dataset not found.'); let rows = datasetRows(dataset, context, { financeAuthorized: canManage(user, tenantId), now: new Date() }); if (input.projectId) { await assertProject(input, dependencies, tenantId, user); rows = rows.filter((row) => row.projectId === input.projectId); } const total = rows.length; rows = selectColumns(rows.slice(input.offset, input.offset + input.limit), allowed); return { columns: allowed, freshness: { asOf: new Date().toISOString(), rowLevelSecurity: 'visible-project-set', source: 'transactional-read-model' }, limit: input.limit, nextOffset: input.offset + rows.length < total ? input.offset + rows.length : null, offset: input.offset, rows, total };
}

function trendSummary(facts) {
  const grouped = new Map();
  for (const fact of facts) { const key = `${fact.eventType}:${fact.projectId ?? ''}`; if (!grouped.has(key)) grouped.set(key, []); grouped.get(key).push(fact); }
  return [...grouped.values()].map((series) => {
    const points = series.sort((a, b) => a.metricDate.localeCompare(b.metricDate)); const values = points.map((point) => point.occurrenceCount); const mean = values.reduce((sum, value) => sum + value, 0) / values.length; const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length; const standardDeviation = Math.sqrt(variance);
    const slope = values.length < 2 ? 0 : (values.at(-1) - values[0]) / (values.length - 1); const forecastNextPeriod = Math.max(0, Math.round((values.at(-1) + slope) * 100) / 100);
    return { anomalies: points.filter((point) => standardDeviation > 0 && Math.abs(point.occurrenceCount - mean) > standardDeviation * 2).map((point) => ({ metricDate: point.metricDate, occurrenceCount: point.occurrenceCount })), eventType: points[0].eventType, forecastNextPeriod, movingAverage: Math.round(values.slice(-7).reduce((sum, value) => sum + value, 0) / Math.min(7, values.length) * 100) / 100, projectId: points[0].projectId, slope: Math.round(slope * 10_000) / 10_000, total: values.reduce((sum, value) => sum + value, 0) };
  }).sort((a, b) => b.total - a.total || a.eventType.localeCompare(b.eventType));
}

export async function getReportingAnalyticsForUser({ dependencies, input, repository, user }) {
  const tenantId = tenantIdFor(user); if (input.projectId) await assertProject(input, dependencies, tenantId, user);
  const projects = await dependencies.projectRepository.listProjectsForTenant({ tenantId, user }); const projectIds = input.projectId ? [input.projectId] : projects.map((project) => project.id);
  await repository.materializeWarehouseChanges({ limit: 5000 }); const [sourceSequenceId, checkpointSequenceId] = await Promise.all([repository.getWarehouseSequence({ tenantId }), repository.getWarehouseCheckpoint({ tenantId })]);
  const cacheKey = createHash('sha256').update(JSON.stringify({ days: input.days, projectIds: [...projectIds].sort() })).digest('hex'); const cached = await repository.readReportingCache({ cacheKey, sourceSequenceId, tenantId }); if (cached) return { ...cached, cache: 'hit' };
  const cutoff = new Date(); cutoff.setUTCDate(cutoff.getUTCDate() - input.days + 1); const cutoffDate = cutoff.toISOString().slice(0, 10); const facts = (await repository.getReportingAnalytics({ projectIds, tenantId })).filter((fact) => fact.metricDate >= cutoffDate); const result = { asOf: new Date().toISOString(), cache: 'miss', days: input.days, facts, freshness: { checkpointSequenceId, lagEvents: Math.max(0, sourceSequenceId - checkpointSequenceId), source: 'cdc-incremental-warehouse', sourceSequenceId }, trends: trendSummary(facts) };
  if (checkpointSequenceId === sourceSequenceId) await repository.writeReportingCache({ cacheKey, sourceSequenceId, tenantId, value: result }); return result;
}

const SERVICE_ACCOUNT_DATASETS = new Set(['agent_governance', 'executive', 'portfolio', 'project', 'risk', 'sprint', 'work_items', 'workflow']);
export async function getBiFeedForServiceAccount({ account, dataset, dependencies, input }) {
  if (!SERVICE_ACCOUNT_DATASETS.has(dataset)) throw new HttpError(403, 'This BI dataset is not available to service accounts.');
  const authorizedProjectIds = [...new Set(account.projectIds ?? [])];
  if (!authorizedProjectIds.length) throw new HttpError(403, 'The service account has no authorized project scope.');
  if (input.projectId && !authorizedProjectIds.includes(input.projectId)) throw new HttpError(404, 'BI dataset not found.');
  const context = await loadReportingContext({ ...dependencies, authorizedProjectIds, tenantId: account.tenantId, user: null }); const allowed = DATASET_COLUMNS[dataset]; let rows = datasetRows(dataset, context, { financeAuthorized: false, now: new Date() }); if (input.projectId) rows = rows.filter((row) => row.projectId === input.projectId); const total = rows.length; rows = selectColumns(rows.slice(input.offset, input.offset + input.limit), allowed); return { columns: allowed, freshness: { asOf: new Date().toISOString(), rowLevelSecurity: 'service-account-project-set', source: 'transactional-read-model' }, limit: input.limit, nextOffset: input.offset + rows.length < total ? input.offset + rows.length : null, offset: input.offset, rows, total };
}

function sum(rows, field) { return rows.reduce((total, row) => total + Number(row[field] ?? 0), 0); }
function countBy(rows, field) { return rows.reduce((result, row) => { const key = String(row[field] ?? 'unknown'); result[key] = (result[key] ?? 0) + 1; return result; }, {}); }
export async function getStandardDashboardsForUser({ dependencies, projectId = null, user }) {
  const tenantId = tenantIdFor(user); if (projectId) await assertProject({ projectId }, dependencies, tenantId, user); const context = await loadReportingContext({ ...dependencies, tenantId, user }); const filter = (rows) => projectId ? rows.filter((row) => row.projectId === projectId) : rows; const financeAuthorized = canManage(user, tenantId); const now = new Date();
  const executive = filter(datasetRows('executive', context, { financeAuthorized, now })); const portfolio = filter(datasetRows('portfolio', context, { financeAuthorized, now })); const projects = filter(datasetRows('project', context, { financeAuthorized, now })); const work = filter(datasetRows('work_items', context, { financeAuthorized, now })); const sprints = filter(datasetRows('sprint', context, { financeAuthorized, now })); const resources = datasetRows('resource', context, { financeAuthorized, now }); const risks = filter(datasetRows('risk', context, { financeAuthorized, now })); const agents = filter(datasetRows('agent_governance', context, { financeAuthorized, now })); const workflows = filter(datasetRows('workflow', context, { financeAuthorized, now })); const financial = financeAuthorized ? filter(datasetRows('financial', context, { financeAuthorized, now })) : [];
  const visibleProjectIds = new Set(context.projects.map((item) => item.id)); const pendingApprovalCount = context.workflows.approvals.filter((item) => visibleProjectIds.has(item.projectId) && (!projectId || item.projectId === projectId) && item.status === 'pending').length;
  return { asOf: now.toISOString(), executive: { actualCost: sum(executive, 'actualCost'), allocatedHoursPerWeek: sum(executive, 'allocatedHoursPerWeek'), budget: sum(executive, 'budget'), byStatus: countBy(executive, 'status'), forecast: sum(executive, 'forecast'), pendingApprovals: sum(executive, 'pendingApprovalCount'), projectCount: executive.length }, portfolio: { alignmentCount: portfolio.length, benefitValue: sum(portfolio, 'benefitValue'), byDemandStatus: countBy(portfolio, 'demandStatus'), byScenario: countBy(portfolio, 'scenario') }, project: { byStatus: countBy(projects, 'status'), epicCount: sum(projects, 'epicCount'), projectCount: projects.length, storyCount: sum(projects, 'storyCount'), taskCount: sum(projects, 'taskCount'), workItemCount: work.length }, sprint: { activeCount: sprints.filter((row) => row.status === 'active').length, byStatus: countBy(sprints, 'status'), total: sprints.length }, resource: { averageUtilizationPercent: resources.length ? Math.round(sum(resources, 'utilizationPercent') / resources.length * 100) / 100 : 0, overallocatedCount: resources.filter((row) => row.overallocated).length, resourceCount: resources.length }, financial: { authorized: financeAuthorized, byCurrency: financial.reduce((result, row) => ({ ...result, [row.currency]: (result[row.currency] ?? 0) + Number(row.amount) }), {}), byKind: financial.reduce((result, row) => ({ ...result, [row.entryKind]: (result[row.entryKind] ?? 0) + Number(row.amount) }), {}) }, risk: { byImpact: countBy(risks, 'impact'), criticalOpenCount: risks.filter((row) => row.impact === 'critical' && !['closed', 'accepted'].includes(row.status)).length, openCount: risks.filter((row) => !['closed', 'accepted'].includes(row.status)).length, total: risks.length }, agentGovernance: { activeGoalCount: agents.filter((row) => row.status === 'active').length, goalCount: agents.length, runCount: sum(agents, 'runCount'), unreadNotificationCount: sum(agents, 'unreadNotificationCount') }, workflow: { overdueSlaCount: workflows.filter((row) => row.slaOverdue).length, pendingApprovalCount, transitionCount: workflows.length }, freshness: { rowLevelSecurity: 'visible-project-set', source: 'transactional-read-model' } };
}

export { DATASET_COLUMNS };
