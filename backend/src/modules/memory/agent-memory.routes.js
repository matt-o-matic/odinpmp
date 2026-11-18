import { Router } from 'express';

import { createAuthMiddleware } from '../../lib/http/auth-middleware.js';
import { browseAgentMemorySchema, correctAgentMemorySchema, createAgentMemorySchema, forgetAgentMemorySchema, purgeExpiredAgentMemorySchema, searchAgentMemorySchema, updateAgentMemoryGovernanceSchema } from './agent-memory.schema.js';
import { browseAgentMemoryForUser, correctAgentMemoryForUser, createAgentMemoryForUser, forgetAgentMemoryForUser, purgeExpiredAgentMemoryForUser, searchAgentMemoryForUser, updateAgentMemoryGovernanceForUser } from './agent-memory.service.js';

function csv(value) { return String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean); }

export function createAgentMemoryRouter({ agentMemoryRepository, authRepository, memoryEmbeddingProvider, projectRepository, tokenService }) {
  const router = Router(); router.use(createAuthMiddleware({ authRepository, tokenService }));
  router.get('/', async (request, response, next) => { try { const input = searchAgentMemorySchema.parse({ limit: request.query.limit, projectIds: csv(request.query.projectIds), query: request.query.query, types: csv(request.query.types) }); response.json(await searchAgentMemoryForUser({ embeddingProvider: memoryEmbeddingProvider, input, memoryRepository: agentMemoryRepository, projectRepository, user: request.auth.user })); } catch (error) { next(error); } });
  router.get('/browse', async (request, response, next) => { try { const input = browseAgentMemorySchema.parse({ limit: request.query.limit, offset: request.query.offset, project: request.query.project, query: request.query.query, sensitivities: csv(request.query.sensitivities), sort: request.query.sort, types: csv(request.query.types) }); response.json(await browseAgentMemoryForUser({ input, memoryRepository: agentMemoryRepository, projectRepository, user: request.auth.user })); } catch (error) { next(error); } });
  router.post('/', async (request, response, next) => { try { response.status(201).json(await createAgentMemoryForUser({ embeddingProvider: memoryEmbeddingProvider, input: createAgentMemorySchema.parse(request.body), memoryRepository: agentMemoryRepository, projectRepository, user: request.auth.user })); } catch (error) { next(error); } });
  router.post('/purge-expired', async (request, response, next) => { try { response.json(await purgeExpiredAgentMemoryForUser({ input: purgeExpiredAgentMemorySchema.parse(request.body), memoryRepository: agentMemoryRepository, user: request.auth.user })); } catch (error) { next(error); } });
  router.patch('/:id/governance', async (request, response, next) => { try { response.json(await updateAgentMemoryGovernanceForUser({ id: request.params.id, input: updateAgentMemoryGovernanceSchema.parse(request.body), memoryRepository: agentMemoryRepository, user: request.auth.user })); } catch (error) { next(error); } });
  router.patch('/:id', async (request, response, next) => {
    try {
      const { correction, ...result } = await correctAgentMemoryForUser({ embeddingProvider: memoryEmbeddingProvider, id: request.params.id, input: correctAgentMemorySchema.parse(request.body), memoryRepository: agentMemoryRepository, projectRepository, user: request.auth.user });
      // The audit record carries hashes and field names, never the remembered text itself.
      if (correction) response.locals.audit = { after: { contentHash: correction.contentHash, fields: correction.fields, memoryId: request.params.id, version: correction.version }, before: { contentHash: correction.previousContentHash, version: correction.previousVersion }, dataClassification: result.memory.sensitivity };
      response.json(result);
    } catch (error) { next(error); }
  });
  router.delete('/:id', async (request, response, next) => { try { response.json(await forgetAgentMemoryForUser({ id: request.params.id, input: forgetAgentMemorySchema.parse(request.body), memoryRepository: agentMemoryRepository, projectRepository, user: request.auth.user })); } catch (error) { next(error); } });
  return router;
}
