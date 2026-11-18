import { Router } from 'express';

import { createAuthMiddleware } from '../../lib/http/auth-middleware.js';
import {
  capturePortfolioBaselineSchema, createPortfolioAlignmentSchema, createPortfolioNodeSchema, createPortfolioPlanSchema, createStrategyObjectiveSchema, portfolioQuerySchema,
  updatePortfolioAlignmentSchema, updatePortfolioNodeSchema, updatePortfolioPlanSchema, updateStrategyObjectiveSchema, versionedPortfolioDeleteSchema,
} from './portfolio.schema.js';
import { capturePortfolioBaselineForUser, deletePortfolioForUser, getPortfolioWorkspaceForUser, mutatePortfolioForUser } from './portfolio.service.js';

export function createPortfolioRouter({ authRepository, portfolioRepository, projectRepository, tokenService }) {
  const router = Router(); router.use(createAuthMiddleware({ authRepository, tokenService }));
  const mutate = (request, input, resource, operation, recordId = null) => mutatePortfolioForUser({ input, operation, portfolioRepository, projectRepository, recordId, resource, user: request.auth.user });
  const remove = (request, expectedVersion, operation) => deletePortfolioForUser({ expectedVersion, operation, portfolioRepository, user: request.auth.user });
  router.get('/', async (request, response, next) => { try { response.json(await getPortfolioWorkspaceForUser({ input: portfolioQuerySchema.parse(request.query), portfolioRepository, projectRepository, user: request.auth.user })); } catch (error) { next(error); } });
  router.post('/nodes', async (request, response, next) => { try { response.status(201).json(await mutate(request, createPortfolioNodeSchema.parse(request.body), 'node', (repo, args) => repo.createNode(args))); } catch (error) { next(error); } });
  router.patch('/nodes/:nodeId', async (request, response, next) => { try { response.json(await mutate(request, updatePortfolioNodeSchema.parse(request.body), 'node', (repo, args) => repo.updateNode({ ...args, nodeId: request.params.nodeId }), request.params.nodeId)); } catch (error) { next(error); } });
  router.delete('/nodes/:nodeId', async (request, response, next) => { try { const input = versionedPortfolioDeleteSchema.parse(request.body); response.json(await remove(request, input.expectedVersion, (repo, args) => repo.deleteNode({ ...args, nodeId: request.params.nodeId }))); } catch (error) { next(error); } });
  router.post('/objectives', async (request, response, next) => { try { response.status(201).json(await mutate(request, createStrategyObjectiveSchema.parse(request.body), 'objective', (repo, args) => repo.createObjective(args))); } catch (error) { next(error); } });
  router.patch('/objectives/:objectiveId', async (request, response, next) => { try { response.json(await mutate(request, updateStrategyObjectiveSchema.parse(request.body), 'objective', (repo, args) => repo.updateObjective({ ...args, objectiveId: request.params.objectiveId }), request.params.objectiveId)); } catch (error) { next(error); } });
  router.delete('/objectives/:objectiveId', async (request, response, next) => { try { const input = versionedPortfolioDeleteSchema.parse(request.body); response.json(await remove(request, input.expectedVersion, (repo, args) => repo.deleteObjective({ ...args, objectiveId: request.params.objectiveId }))); } catch (error) { next(error); } });
  router.post('/alignments', async (request, response, next) => { try { response.status(201).json(await mutate(request, createPortfolioAlignmentSchema.parse(request.body), 'alignment', (repo, args) => repo.createAlignment(args))); } catch (error) { next(error); } });
  router.patch('/alignments/:alignmentId', async (request, response, next) => { try { response.json(await mutate(request, updatePortfolioAlignmentSchema.parse(request.body), 'alignment', (repo, args) => repo.updateAlignment({ ...args, alignmentId: request.params.alignmentId }), request.params.alignmentId)); } catch (error) { next(error); } });
  router.delete('/alignments/:alignmentId', async (request, response, next) => { try { const input = versionedPortfolioDeleteSchema.parse(request.body); response.json(await remove(request, input.expectedVersion, (repo, args) => repo.deleteAlignment({ ...args, alignmentId: request.params.alignmentId }))); } catch (error) { next(error); } });
  router.post('/plans', async (request, response, next) => { try { response.status(201).json(await mutate(request, createPortfolioPlanSchema.parse(request.body), 'plan', (repo, args) => repo.createPlan(args))); } catch (error) { next(error); } });
  router.patch('/plans/:planId', async (request, response, next) => { try { response.json(await mutate(request, updatePortfolioPlanSchema.parse(request.body), 'plan', (repo, args) => repo.updatePlan({ ...args, planId: request.params.planId }), request.params.planId)); } catch (error) { next(error); } });
  router.delete('/plans/:planId', async (request, response, next) => { try { const input = versionedPortfolioDeleteSchema.parse(request.body); response.json(await remove(request, input.expectedVersion, (repo, args) => repo.deletePlan({ ...args, planId: request.params.planId }))); } catch (error) { next(error); } });
  router.post('/baselines', async (request, response, next) => { try { response.status(201).json(await capturePortfolioBaselineForUser({ input: capturePortfolioBaselineSchema.parse(request.body), portfolioRepository, projectRepository, user: request.auth.user })); } catch (error) { next(error); } });
  return router;
}
