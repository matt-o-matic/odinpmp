import { Router } from 'express';

import { createAuthMiddleware } from '../../lib/http/auth-middleware.js';
import {
  customFieldDefinitionCreateSchema,
  customFieldDefinitionUpdateSchema,
  customFieldValueWriteSchema,
  customValueDeleteSchema,
  projectBaselineCreateSchema,
  projectTemplateCreateSchema,
  projectTemplateUpdateSchema,
  templateListQuerySchema,
  versionedWorkflowDeleteSchema,
  workflowApprovalDecisionSchema,
  workflowApprovalRequestSchema,
  workflowBindingCreateSchema,
  workflowBindingUpdateSchema,
  workflowDefinitionCreateSchema,
  workflowDefinitionUpdateSchema,
  workflowWorkspaceQuerySchema,
} from './workflows.schema.js';
import {
  createBaselineForUser,
  createBindingForUser,
  createWorkflowForUser,
  decideApprovalForUser,
  deleteProjectWorkflowRecordForUser,
  deleteWorkflowRecordForUser,
  getWorkflowDefinitionForUser,
  getWorkflowWorkspaceForUser,
  mutateManagedWorkflowRecordForUser,
  requestApprovalForUser,
  updateBindingForUser,
  updateWorkflowForUser,
  writeCustomFieldValueForUser,
} from './workflows.service.js';
import { createTemplateForUser, listTemplatesForUser, updateTemplateForUser } from './template-application.js';

export function createWorkflowsRouter({ authRepository, projectRepository, tokenService, workflowRepository }) {
  const router = Router();
  router.use(createAuthMiddleware({ authRepository, tokenService, allowMcp: true }));

  router.get('/', async (request, response, next) => {
    try {
      response.json(await getWorkflowWorkspaceForUser({
        input: workflowWorkspaceQuerySchema.parse(request.query), projectRepository, repository: workflowRepository, user: request.auth.user,
      }));
    } catch (error) { next(error); }
  });

  router.post('/definitions', async (request, response, next) => {
    try { response.status(201).json(await createWorkflowForUser({ input: workflowDefinitionCreateSchema.parse(request.body), repository: workflowRepository, user: request.auth.user })); }
    catch (error) { next(error); }
  });
  router.get('/definitions/:workflowId', async (request, response, next) => {
    try { response.json(await getWorkflowDefinitionForUser({ repository: workflowRepository, user: request.auth.user, workflowId: request.params.workflowId })); }
    catch (error) { next(error); }
  });
  router.patch('/definitions/:workflowId', async (request, response, next) => {
    try { response.json(await updateWorkflowForUser({ input: workflowDefinitionUpdateSchema.parse(request.body), projectRepository, repository: workflowRepository, user: request.auth.user, workflowId: request.params.workflowId })); }
    catch (error) { next(error); }
  });
  router.delete('/definitions/:workflowId', async (request, response, next) => {
    try { const { expectedVersion } = versionedWorkflowDeleteSchema.parse(request.body); response.json(await deleteWorkflowRecordForUser({ expectedVersion, id: { workflowId: request.params.workflowId }, method: 'deleteWorkflow', repository: workflowRepository, user: request.auth.user })); }
    catch (error) { next(error); }
  });

  router.post('/bindings', async (request, response, next) => {
    try { response.status(201).json(await createBindingForUser({ input: workflowBindingCreateSchema.parse(request.body), projectRepository, repository: workflowRepository, user: request.auth.user })); }
    catch (error) { next(error); }
  });
  router.patch('/bindings/:bindingId', async (request, response, next) => {
    try { response.json(await updateBindingForUser({ bindingId: request.params.bindingId, input: workflowBindingUpdateSchema.parse(request.body), projectRepository, repository: workflowRepository, user: request.auth.user })); }
    catch (error) { next(error); }
  });
  router.delete('/bindings/:bindingId', async (request, response, next) => {
    try { const { expectedVersion } = versionedWorkflowDeleteSchema.parse(request.body); response.json(await deleteProjectWorkflowRecordForUser({ expectedVersion, id: { bindingId: request.params.bindingId }, method: 'deleteBinding', projectRepository, repository: workflowRepository, snapshotCollection: 'bindings', user: request.auth.user })); }
    catch (error) { next(error); }
  });

  router.post('/approvals', async (request, response, next) => {
    try { response.status(201).json(await requestApprovalForUser({ input: workflowApprovalRequestSchema.parse(request.body), projectRepository, repository: workflowRepository, user: request.auth.user })); }
    catch (error) { next(error); }
  });
  router.post('/approvals/:approvalId/decision', async (request, response, next) => {
    try { response.json(await decideApprovalForUser({ approvalId: request.params.approvalId, input: workflowApprovalDecisionSchema.parse(request.body), projectRepository, repository: workflowRepository, user: request.auth.user })); }
    catch (error) { next(error); }
  });

  router.post('/baselines', async (request, response, next) => {
    try { response.status(201).json(await createBaselineForUser({ input: projectBaselineCreateSchema.parse(request.body), projectRepository, repository: workflowRepository, user: request.auth.user })); }
    catch (error) { next(error); }
  });

  function managedCrud({ createMethod, createSchema, deleteMethod, idKey, path, updateMethod, updateSchema }) {
    router.post(path, async (request, response, next) => {
      try { response.status(201).json(await mutateManagedWorkflowRecordForUser({ input: createSchema.parse(request.body), method: createMethod, repository: workflowRepository, user: request.auth.user })); }
      catch (error) { next(error); }
    });
    router.patch(`${path}/:${idKey}`, async (request, response, next) => {
      try { response.json(await mutateManagedWorkflowRecordForUser({ input: updateSchema.parse(request.body), method: updateMethod, recordId: { [idKey]: request.params[idKey] }, repository: workflowRepository, user: request.auth.user })); }
      catch (error) { next(error); }
    });
    router.delete(`${path}/:${idKey}`, async (request, response, next) => {
      try { const { expectedVersion } = versionedWorkflowDeleteSchema.parse(request.body); response.json(await deleteWorkflowRecordForUser({ expectedVersion, id: { [idKey]: request.params[idKey] }, method: deleteMethod, repository: workflowRepository, user: request.auth.user })); }
      catch (error) { next(error); }
    });
  }
  router.get('/templates', async (request, response, next) => {
    try { response.json(await listTemplatesForUser({ input: templateListQuerySchema.parse(request.query), repository: workflowRepository, user: request.auth.user })); }
    catch (error) { next(error); }
  });
  router.post('/templates', async (request, response, next) => {
    try { response.status(201).json(await createTemplateForUser({ input: projectTemplateCreateSchema.parse(request.body), repository: workflowRepository, user: request.auth.user })); }
    catch (error) { next(error); }
  });
  router.patch('/templates/:templateId', async (request, response, next) => {
    try { response.json(await updateTemplateForUser({ input: projectTemplateUpdateSchema.parse(request.body), repository: workflowRepository, templateId: request.params.templateId, user: request.auth.user })); }
    catch (error) { next(error); }
  });
  router.delete('/templates/:templateId', async (request, response, next) => {
    try { const { expectedVersion } = versionedWorkflowDeleteSchema.parse(request.body); response.json(await deleteWorkflowRecordForUser({ expectedVersion, id: { templateId: request.params.templateId }, method: 'deleteTemplate', repository: workflowRepository, user: request.auth.user })); }
    catch (error) { next(error); }
  });
  managedCrud({ createMethod: 'createCustomField', createSchema: customFieldDefinitionCreateSchema, deleteMethod: 'deleteCustomField', idKey: 'fieldId', path: '/custom-fields', updateMethod: 'updateCustomField', updateSchema: customFieldDefinitionUpdateSchema });

  router.put('/custom-values', async (request, response, next) => {
    try { response.json(await writeCustomFieldValueForUser({ input: customFieldValueWriteSchema.parse(request.body), projectRepository, repository: workflowRepository, user: request.auth.user })); }
    catch (error) { next(error); }
  });
  router.delete('/custom-values/:valueId', async (request, response, next) => {
    try { const { expectedVersion, projectId } = customValueDeleteSchema.parse(request.body); response.json(await deleteProjectWorkflowRecordForUser({ expectedVersion, id: { valueId: request.params.valueId }, method: 'deleteCustomValue', projectId, projectRepository, repository: workflowRepository, snapshotCollection: 'customValues', user: request.auth.user })); }
    catch (error) { next(error); }
  });

  return router;
}
