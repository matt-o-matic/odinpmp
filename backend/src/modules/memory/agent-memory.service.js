import { createHash } from 'node:crypto';

import { PROJECT_CAPABILITIES, getTenantMembership, hasProjectCapability, requireProjectCapability } from '../../lib/auth/project-capabilities.js';
import { HttpError } from '../../lib/errors/http-error.js';

function tenantIdFor(user) { const id = user?.memberships?.[0]?.tenantId; if (!id) throw new HttpError(403, 'This account is not assigned to a tenant.'); return id; }
function isAdmin(user, tenantId) { return user?.memberships?.some((membership) => membership.tenantId === tenantId && membership.role === 'admin'); }
function embeddingText(input) { return { content: input.content, title: input.title }; }
function withoutEmbeddingVector(memory) { return memory ? { ...memory, embedding: memory.embedding ? { contentHash: memory.embedding.contentHash, dimensions: memory.embedding.dimensions, embeddedAt: memory.embedding.embeddedAt, model: memory.embedding.model } : null } : memory; }

export async function createAgentMemoryForUser({ embeddingProvider = null, input, memoryRepository, projectRepository, user }) {
  const tenantId = tenantIdFor(user);
  if (input.projectId) await requireProjectCapability({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectId: input.projectId, repository: projectRepository, tenantId, user });
  let embedding = null; let embeddingError = null;
  if (embeddingProvider) try { embedding = await embeddingProvider.embed({ ...embeddingText(input), tenantId }); } catch (error) { embeddingError = error; }
  const memory = await memoryRepository.create({ ...input, createdBy: user.id, embedding, ownerUserId: user.id, tenantId });
  return { embeddingStatus: embedding ? 'indexed' : embeddingProvider ? 'unavailable' : 'disabled', memory: withoutEmbeddingVector(memory), ok: true, ...(embeddingError ? { warning: 'Memory was saved but semantic indexing is temporarily unavailable.' } : {}) };
}

export async function searchAgentMemoryForUser({ embeddingProvider = null, input, memoryRepository, projectRepository, user }) {
  const tenantId = tenantIdFor(user);
  const visibleProjects = await projectRepository.listProjectsForTenant({ tenantId, user });
  const visibleIds = new Set(visibleProjects.map((project) => project.id));
  const requestedIds = input.projectIds.length > 0 ? input.projectIds : [...visibleIds];
  if (requestedIds.some((id) => !visibleIds.has(id))) throw new HttpError(404, 'Project not found.');
  let queryEmbedding = null;
  if (embeddingProvider) try { queryEmbedding = await embeddingProvider.embed({ content: input.query, tenantId, title: 'Memory search query' }); } catch { queryEmbedding = null; }
  const memories = await memoryRepository.search({ ...input, ownerUserId: user.id, projectIds: requestedIds, queryEmbedding, tenantId });
  return {
    memories: memories.filter((memory) => memory.sensitivity !== 'restricted' || memory.createdBy === user.id || isAdmin(user, tenantId)).map(withoutEmbeddingVector),
    ok: true,
    retrievalMode: queryEmbedding ? 'hybrid' : 'lexical',
  };
}

function canEditProjectSummary(project, user, tenantId) {
  return hasProjectCapability({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectRole: project.role, tenantRole: getTenantMembership(user, tenantId)?.role, userCapabilities: user.capabilities });
}

export async function browseAgentMemoryForUser({ input, memoryRepository, projectRepository, user }) {
  const tenantId = tenantIdFor(user); const admin = Boolean(isAdmin(user, tenantId));
  const visibleProjects = await projectRepository.listProjectsForTenant({ tenantId, user });
  const projectsById = new Map(visibleProjects.map((project) => [project.id, project]));
  if (input.project && input.project !== 'personal' && !projectsById.has(input.project)) throw new HttpError(404, 'Project not found.');
  const projectIds = input.project === 'personal' ? [] : input.project ? [input.project] : [...projectsById.keys()];
  const editableProjectIds = visibleProjects.filter((project) => canEditProjectSummary(project, user, tenantId)).map((project) => project.id);
  const editable = new Set(editableProjectIds);
  const page = await memoryRepository.browse({ ...input, includePersonal: !input.project || input.project === 'personal', includeRestricted: admin, ownerUserId: user.id, projectIds, tenantId });
  return {
    limit: input.limit,
    memories: page.memories.map((memory) => {
      const canChange = !memory.legalHold && (memory.createdBy === user.id || admin || Boolean(memory.projectId && editable.has(memory.projectId)));
      return { ...withoutEmbeddingVector(memory), canCorrect: canChange, canForget: canChange, projectName: memory.projectId ? projectsById.get(memory.projectId)?.name ?? '' : '' };
    }),
    offset: input.offset,
    ok: true,
    permissions: { canGovern: admin, editableProjectIds },
    total: page.total,
  };
}

async function requireChangeableMemory({ id, memoryRepository, projectRepository, tenantId, user, verb }) {
  const memory = await memoryRepository.get({ id, tenantId });
  if (!memory) throw new HttpError(404, 'Memory not found.');
  const admin = isAdmin(user, tenantId);
  if (memory.sensitivity === 'restricted' && memory.createdBy !== user.id && !admin) throw new HttpError(404, 'Memory not found.');
  if (memory.legalHold) throw new HttpError(423, `Memory is under legal hold and cannot be ${verb}.`);
  if (memory.createdBy !== user.id && !admin) {
    if (!memory.projectId) throw new HttpError(404, 'Memory not found.');
    await requireProjectCapability({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectId: memory.projectId, repository: projectRepository, tenantId, user });
  }
  return memory;
}

function contentHash(memory) { return createHash('sha256').update(`${memory.title}\n${memory.content}`).digest('hex'); }

export async function correctAgentMemoryForUser({ embeddingProvider = null, id, input, memoryRepository, projectRepository, user }) {
  const tenantId = tenantIdFor(user);
  const current = await requireChangeableMemory({ id, memoryRepository, projectRepository, tenantId, user, verb: 'corrected' });
  const { expectedVersion, ...requested } = input;
  const changes = Object.fromEntries(Object.entries(requested).filter(([key, value]) => value !== undefined && value !== current[key]));
  if (Object.keys(changes).length === 0) return { correction: null, embeddingStatus: 'unchanged', memory: withoutEmbeddingVector(current), ok: true };
  const next = { ...current, ...changes };
  const textChanged = next.title !== current.title || next.content !== current.content;
  let embedding; let embeddingStatus = 'unchanged';
  if (textChanged) {
    embedding = null; embeddingStatus = embeddingProvider ? 'unavailable' : 'disabled';
    if (embeddingProvider) try { embedding = await embeddingProvider.embed({ ...embeddingText(next), tenantId }); embeddingStatus = 'indexed'; } catch { embedding = null; }
  }
  const correction = { at: new Date().toISOString(), by: user.id, fields: Object.keys(changes).sort(), previousContentHash: contentHash(current), previousVersion: current.version };
  try {
    const memory = await memoryRepository.correct({ changes, correction, embedding, expectedVersion, id, tenantId });
    if (!memory) throw new HttpError(404, 'Memory not found.');
    return { correction: { ...correction, contentHash: contentHash(memory), version: memory.version }, embeddingStatus, memory: withoutEmbeddingVector(memory), ok: true };
  } catch (error) {
    if (error?.code === 'agent_memory_version_conflict') throw new HttpError(409, error.message, { details: { actualVersion: error.actualVersion, code: error.code, expectedVersion: error.expectedVersion } });
    throw error;
  }
}

export async function forgetAgentMemoryForUser({ id, input, memoryRepository, projectRepository, user }) {
  const tenantId = tenantIdFor(user);
  // The same checks as a correction, so nobody forgets a restricted memory they cannot see.
  await requireChangeableMemory({ id, memoryRepository, projectRepository, tenantId, user, verb: 'forgotten' });
  try {
    const forgotten = await memoryRepository.forget({ expectedVersion: input.expectedVersion, id, tenantId });
    if (!forgotten) throw new HttpError(404, 'Memory not found.');
    return { forgottenMemoryId: id, ok: true, version: forgotten.version };
  } catch (error) {
    if (error?.code === 'agent_memory_version_conflict') throw new HttpError(409, error.message, { details: { actualVersion: error.actualVersion, code: error.code, expectedVersion: error.expectedVersion } });
    throw error;
  }
}

export async function updateAgentMemoryGovernanceForUser({ id, input, memoryRepository, user }) {
  const tenantId = tenantIdFor(user);
  if (!isAdmin(user, tenantId)) throw new HttpError(404, 'Memory not found.');
  try {
    const memory = await memoryRepository.updateGovernance({ ...input, id, tenantId });
    if (!memory) throw new HttpError(404, 'Memory not found.');
    return { memory, ok: true };
  } catch (error) {
    if (error?.code === 'agent_memory_version_conflict') throw new HttpError(409, error.message, { details: { actualVersion: error.actualVersion, code: error.code, expectedVersion: error.expectedVersion } });
    throw error;
  }
}

export async function purgeExpiredAgentMemoryForUser({ input, memoryRepository, user }) {
  const tenantId = tenantIdFor(user);
  if (!isAdmin(user, tenantId)) throw new HttpError(404, 'Memory not found.');
  const purgedCount = await memoryRepository.purgeExpired({ cutoffAt: input.cutoffAt, tenantId });
  return { ok: true, purgedCount };
}
