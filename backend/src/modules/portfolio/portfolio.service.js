import { createHash } from 'node:crypto';

import { PROJECT_CAPABILITIES, requireProjectCapability } from '../../lib/auth/project-capabilities.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { analyzePortfolioPlans } from './portfolio-analysis.js';

function tenantIdFor(user) { const tenantId = user?.memberships?.[0]?.tenantId; if (!tenantId) throw new HttpError(403, 'This account is not assigned to a tenant.'); return tenantId; }
function tenantRole(user, tenantId) { return String(user?.memberships?.find((item) => item.tenantId === tenantId)?.role ?? '').toLowerCase(); }
function requirePortfolioWrite(user, tenantId) { if (!['admin', 'manager'].includes(tenantRole(user, tenantId))) throw new HttpError(404, 'Portfolio record not found.'); }
function byId(items) { return new Map(items.map((item) => [item.id, item])); }

function descendants(nodeId, nodes) {
  const result = new Set([nodeId]); let changed = true;
  while (changed) { changed = false; for (const node of nodes) if (node.parentId && result.has(node.parentId) && !result.has(node.id)) { result.add(node.id); changed = true; } }
  return result;
}

function boundedScore(alignment, scoring) {
  const weights = [Number(scoring?.strategicWeight ?? 0.6), Number(scoring?.riskWeight ?? 0.2), Number(scoring?.costWeight ?? 0.2)];
  const total = weights.reduce((sum, value) => sum + Math.max(0, value), 0) || 1;
  return Math.round(((alignment.strategicScore * weights[0]) + ((100 - alignment.riskScore) * weights[1]) + ((100 - alignment.costScore) * weights[2])) / total * 100) / 100;
}

function buildRollup(node, snapshot, projectMap) {
  const includedNodes = descendants(node.id, snapshot.nodes);
  const alignments = snapshot.alignments.filter((item) => includedNodes.has(item.portfolioNodeId) && projectMap.has(item.projectId));
  const projects = [...new Map(alignments.map((alignment) => [alignment.projectId, projectMap.get(alignment.projectId)])).values()];
  const countBy = (values) => values.reduce((counts, value) => ({ ...counts, [value]: (counts[value] ?? 0) + 1 }), {});
  const benefits = {};
  for (const alignment of alignments) if (alignment.benefitUnit) benefits[alignment.benefitUnit] = (benefits[alignment.benefitUnit] ?? 0) + alignment.benefitValue;
  const scores = alignments.map((alignment) => boundedScore(alignment, node.scoring));
  return {
    alignmentCount: alignments.length,
    benefits,
    demand: countBy(alignments.map((item) => item.demandStatus)),
    nodeCount: includedNodes.size,
    projectCount: projects.length,
    projectStatuses: countBy(projects.map((item) => item.status)),
    scenarios: countBy(alignments.map((item) => item.scenario)),
    score: scores.length ? Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length * 100) / 100 : 0,
  };
}

function objectiveProgress(objective) { if (objective.targetValue === 0) return objective.currentValue === 0 ? 100 : 0; return Math.max(0, Math.min(100, Math.round((objective.currentValue / objective.targetValue) * 10_000) / 100)); }

export async function getPortfolioWorkspaceForUser({ input, portfolioRepository, projectRepository, user }) {
  const tenantId = tenantIdFor(user);
  const [snapshot, projects] = await Promise.all([portfolioRepository.listSnapshot({ tenantId }), projectRepository.listProjectsForTenant({ tenantId, user })]);
  const projectMap = new Map(projects.map((project) => [project.id, project]));
  const visibleAlignments = snapshot.alignments.filter((alignment) => projectMap.has(alignment.projectId));
  const query = input.query.toLowerCase();
  let nodes = snapshot.nodes.filter((node) => (!input.status || node.status === input.status) && (!query || `${node.name} ${node.description}`.toLowerCase().includes(query)));
  const rollups = new Map(nodes.map((node) => [node.id, buildRollup(node, { ...snapshot, alignments: visibleAlignments }, projectMap)]));
  nodes.sort((left, right) => {
    if (input.sort === 'score') return rollups.get(right.id).score - rollups.get(left.id).score || left.name.localeCompare(right.name);
    if (input.sort === 'updatedAt') return right.updatedAt.localeCompare(left.updatedAt) || left.name.localeCompare(right.name);
    return left.name.localeCompare(right.name);
  });
  const total = nodes.length;
  nodes = nodes.slice(input.offset, input.offset + input.limit).map((node) => ({ ...node, rollup: rollups.get(node.id) }));
  return {
    alignments: visibleAlignments,
    analysis: analyzePortfolioPlans({ alignments: visibleAlignments, nodes: snapshot.nodes, plans: snapshot.plans ?? [], visibleProjectIds: [...projectMap.keys()] }),
    baselines: (snapshot.baselines ?? []).map((baseline) => ({ ...baseline, snapshot: {
      ...baseline.snapshot,
      alignments: (baseline.snapshot?.alignments ?? []).filter((item) => projectMap.has(item.projectId)),
      projects: (baseline.snapshot?.projects ?? []).filter((item) => projectMap.has(item.id)),
    } })),
    canApprove: tenantRole(user, tenantId) === 'admin',
    canManage: ['admin', 'manager'].includes(tenantRole(user, tenantId)),
    limit: input.limit,
    nodes,
    objectives: snapshot.objectives.slice(0, 500).map((objective) => ({ ...objective, progressPercent: objectiveProgress(objective) })),
    offset: input.offset,
    projects,
    plans: snapshot.plans ?? [],
    total,
  };
}

async function snapshotOrThrow(repository, tenantId) { return repository.listSnapshot({ tenantId }); }
function ensureParent(input, recordId, records, expectedKind) {
  if (input.parentId == null) return;
  if (input.parentId === recordId) throw new HttpError(409, 'A record cannot be its own parent.');
  const parent = records.find((item) => item.id === input.parentId);
  if (!parent || (expectedKind && parent.kind !== expectedKind)) throw new HttpError(404, 'Parent record not found.');
  let cursor = parent;
  while (cursor?.parentId) { if (cursor.parentId === recordId) throw new HttpError(409, 'Hierarchy cycles are not allowed.'); cursor = records.find((item) => item.id === cursor.parentId); }
}

export async function mutatePortfolioForUser({ input, operation, portfolioRepository, projectRepository, recordId = null, resource, user }) {
  const tenantId = tenantIdFor(user); requirePortfolioWrite(user, tenantId);
  const snapshot = await snapshotOrThrow(portfolioRepository, tenantId);
  const collection = resource === 'node' ? snapshot.nodes : resource === 'objective' ? snapshot.objectives : resource === 'plan' ? (snapshot.plans ?? []) : snapshot.alignments;
  const current = recordId ? collection.find((item) => item.id === recordId) : null;
  const effectiveInput = { ...(current ?? {}), ...input };
  if (recordId && !current) throw new HttpError(404, 'Portfolio record not found.');
  if (resource === 'node') ensureParent(effectiveInput, recordId, snapshot.nodes, 'portfolio');
  if (resource === 'objective') ensureParent(effectiveInput, recordId, snapshot.objectives, 'objective');
  if (resource === 'alignment') {
    if (!snapshot.nodes.some((node) => node.id === effectiveInput.portfolioNodeId)) throw new HttpError(404, 'Portfolio record not found.');
    if (effectiveInput.objectiveId && !snapshot.objectives.some((objective) => objective.id === effectiveInput.objectiveId)) throw new HttpError(404, 'Strategy objective not found.');
    if (effectiveInput.projectId) await requireProjectCapability({ capability: PROJECT_CAPABILITIES.READ, projectId: effectiveInput.projectId, repository: projectRepository, tenantId, user });
  }
  if (resource === 'plan') {
    if (!snapshot.nodes.some((node) => node.id === effectiveInput.portfolioNodeId)) throw new HttpError(404, 'Portfolio record not found.');
    if (['approved', 'rejected'].includes(effectiveInput.status) && tenantRole(user, tenantId) !== 'admin') throw new HttpError(403, 'Only tenant administrators may approve or reject portfolio plans.');
    if (current && ['approved', 'rejected'].includes(current.status)) throw new HttpError(409, 'Decided portfolio plans are immutable. Create a new scenario plan.');
  }
  const operationInput = resource === 'plan' ? { ...input, ...(['approved', 'rejected'].includes(effectiveInput.status) ? { decidedAt: new Date().toISOString(), decidedBy: user.id } : { decidedAt: null, decidedBy: null }) } : input;
  const value = await operation(portfolioRepository, { input: operationInput, tenantId });
  if (value == null || value === false) throw new HttpError(404, 'Portfolio record not found.');
  return { ok: true, value };
}

export async function capturePortfolioBaselineForUser({ input, portfolioRepository, projectRepository, user }) {
  const tenantId = tenantIdFor(user); requirePortfolioWrite(user, tenantId);
  const [snapshot, projects] = await Promise.all([portfolioRepository.listSnapshot({ tenantId }), projectRepository.listProjectsForTenant({ tenantId, user })]);
  const node = snapshot.nodes.find((item) => item.id === input.portfolioNodeId); if (!node) throw new HttpError(404, 'Portfolio record not found.');
  const includedNodes = descendants(node.id, snapshot.nodes); const visible = new Set(projects.map((project) => project.id));
  const capturedAt = new Date().toISOString();
  const baselineSnapshot = {
    alignments: snapshot.alignments.filter((item) => includedNodes.has(item.portfolioNodeId) && visible.has(item.projectId) && item.scenario === input.scenario),
    nodes: snapshot.nodes.filter((item) => includedNodes.has(item.id)), objectives: snapshot.objectives,
    plans: (snapshot.plans ?? []).filter((item) => includedNodes.has(item.portfolioNodeId) && item.scenario === input.scenario),
    projects: projects.filter((project) => snapshot.alignments.some((item) => item.projectId === project.id && includedNodes.has(item.portfolioNodeId))).map(({ id, name, status }) => ({ id, name, status })),
  };
  const canonical = JSON.stringify(baselineSnapshot); const contentHash = createHash('sha256').update(canonical).digest('hex');
  const value = await portfolioRepository.createBaseline({ input: { ...input, capturedAt, capturedBy: user.id, snapshot: { ...baselineSnapshot, contentHash } }, tenantId });
  return { ok: true, value };
}

export async function deletePortfolioForUser({ expectedVersion, operation, portfolioRepository, user }) {
  const tenantId = tenantIdFor(user); requirePortfolioWrite(user, tenantId);
  const value = await operation(portfolioRepository, { expectedVersion, tenantId });
  if (value == null || value === false) throw new HttpError(404, 'Portfolio record not found.');
  return { ok: true };
}
