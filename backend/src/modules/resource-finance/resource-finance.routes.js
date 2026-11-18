import { Router } from 'express';

import { createAuthMiddleware } from '../../lib/http/auth-middleware.js';
import {
  accountingPeriodCreateSchema, accountingPeriodUpdateSchema,
  enterpriseResourceCreateSchema, enterpriseResourceUpdateSchema,
  exchangeRateCreateSchema, exchangeRateUpdateSchema,
  expenseEntryCreateSchema, expenseEntryUpdateSchema,
  expenseReceiptCreateSchema, expenseReceiptUpdateSchema,
  expenseReceiptUploadSchema,
  financePolicyCreateSchema, financePolicyUpdateSchema,
  projectFinancialEntryCreateSchema, projectFinancialEntryUpdateSchema,
  resourceAllocationCreateSchema, resourceAllocationUpdateSchema,
  resourceAllocationLevelSchema,
  resourceCalendarEntryCreateSchema, resourceCalendarEntryUpdateSchema,
  calendarEntryListQuerySchema,
  projectAllocationCreateSchema, projectAllocationUpdateSchema,
  projectResourceCreateSchema, projectResourceUpdateSchema,
  projectTaskAccessSchema, taskAccessLinkSchema,
  projectTimeEntryCreateSchema, projectTimeEntryUpdateSchema,
  resourceFinanceQuerySchema,
  resourcePoolCreateSchema, resourcePoolUpdateSchema,
  resourceRateCreateSchema, resourceRateUpdateSchema,
  timeEntryCreateSchema, timeEntryUpdateSchema, timeEntryListQuerySchema,
  timesheetPeriodCreateSchema, timesheetPeriodUpdateSchema,
  versionedResourceFinanceDeleteSchema,
} from './resource-finance.schema.js';
import { accessServiceDeps } from '../access/access.service.js';
import {
  addProjectAllocationForUser, addProjectResourceForUser, deleteProjectAllocationForUser, deleteProjectTimeEntryForUser, deleteResourceFinanceForUser,
  getProjectTeamForUser, getResourceAccessLinkForUser, getResourceFinanceWorkspaceForUser, levelProjectAllocationForUser, levelResourceAllocationForUser,
  listCalendarEntriesForUser, listProjectTaskAccessForUser, listTimeEntriesForUser, logProjectTimeForUser, mutateResourceFinanceForUser,
  readExpenseReceiptForUser, revokeResourceAccessLinkForUser, sendTaskAccessLinkForUser, setProjectTaskAccessForUser, updateProjectAllocationForUser,
  updateProjectResourceForUser, updateProjectTimeEntryForUser, uploadExpenseReceiptForUser,
} from './resource-finance.service.js';

// The projects an MCP grant is limited to, or null for people and grants covering every project.
const grantProjectIdsOf = (request) => (request.auth.credentialSource === 'mcp' && request.auth.mcpGrant?.projectIds?.length ? request.auth.mcpGrant.projectIds : null);

export function createResourceFinanceRouter(deps) {
  const { authRepository, complianceRepository, fileScanner, fileStorage, projectRepository, resourceFinanceRepository, tenantsRepository = null, tokenService } = deps;
  // Task access links for people without a login (docs/task-access/plan.md).
  const access = accessServiceDeps(deps);
  const router = Router();
  // MCP credentials reach only the routes mcp/route-access.js allows.
  router.use(createAuthMiddleware({ allowMcp: true, authRepository, tokenService }));

  router.get('/', async (request, response, next) => {
    try {
      response.json(await getResourceFinanceWorkspaceForUser({
        authRepository, tenantsRepository,
        input: resourceFinanceQuerySchema.parse(request.query), projectRepository,
        repository: resourceFinanceRepository, user: request.auth.user,
      }));
    } catch (error) { next(error); }
  });

  function registerCrud({ createMethod, createSchema, idKey, path, resourceType, updateMethod, updateSchema, deleteMethod }) {
    router.post(path, async (request, response, next) => {
      try {
        response.status(201).json(await mutateResourceFinanceForUser({
          authRepository,
          complianceRepository,
          input: createSchema.parse(request.body), operation: (repository, args) => repository[createMethod](args),
          projectRepository, repository: resourceFinanceRepository, resourceType, user: request.auth.user,
        }));
      } catch (error) { next(error); }
    });
    router.patch(`${path}/:${idKey}`, async (request, response, next) => {
      try {
        const recordId = request.params[idKey];
        response.json(await mutateResourceFinanceForUser({
          authRepository,
          complianceRepository,
          input: updateSchema.parse(request.body), operation: (repository, args) => repository[updateMethod]({ ...args, [idKey]: recordId }),
          projectRepository, recordId, repository: resourceFinanceRepository, resourceType, user: request.auth.user,
        }));
      } catch (error) { next(error); }
    });
    router.delete(`${path}/:${idKey}`, async (request, response, next) => {
      try {
        const recordId = request.params[idKey];
        const { expectedVersion } = versionedResourceFinanceDeleteSchema.parse(request.body);
        const receipt = resourceType === 'expenseReceipt'
          ? (await resourceFinanceRepository.listSnapshot({ tenantId: request.auth.user.memberships?.[0]?.tenantId })).expenseReceipts.find((item) => item.id === recordId)
          : null;
        const result = await deleteResourceFinanceForUser({
          complianceRepository, expectedVersion, operation: (repository, args) => repository[deleteMethod]({ ...args, [idKey]: recordId }),
          recordId, repository: resourceFinanceRepository, resourceType, user: request.auth.user,
        });
        if (receipt?.storageKey && fileStorage?.delete) await fileStorage.delete(receipt.storageKey).catch(() => {});
        response.json(result);
      } catch (error) { next(error); }
    });
  }

  router.get('/projects/:projectId/team', async (request, response, next) => {
    try {
      response.json(await getProjectTeamForUser({
        authRepository, grantProjectIds: grantProjectIdsOf(request), tenantsRepository,
        projectId: request.params.projectId, projectRepository, repository: resourceFinanceRepository, user: request.auth.user,
      }));
    } catch (error) { next(error); }
  });

  // Someone without a login, added to the project in one step (the MCP and assistant tool).
  router.post('/projects/:projectId/resources', async (request, response, next) => {
    try {
      response.status(201).json(await addProjectResourceForUser({
        authRepository, grantProjectIds: grantProjectIdsOf(request), tenantsRepository,
        input: projectResourceCreateSchema.parse(request.body), projectId: request.params.projectId,
        projectRepository, repository: resourceFinanceRepository, user: request.auth.user,
      }));
    } catch (error) { next(error); }
  });

  // The routes the MCP and assistant tools call: lists across the user's projects, and changes
  // held to the project in the path.
  function handle(method, path, status, run) {
    router[method](path, async (request, response, next) => {
      try { response.status(status).json(await run(request)); } catch (error) { next(error); }
    });
  }
  const scoped = (request) => ({ authRepository, complianceRepository, grantProjectIds: grantProjectIdsOf(request), projectId: request.params.projectId, projectRepository, repository: resourceFinanceRepository, tenantsRepository, user: request.auth.user });
  handle('get', '/time-entries', 200, (request) => listTimeEntriesForUser({ input: timeEntryListQuerySchema.parse(request.query), projectRepository, repository: resourceFinanceRepository, user: request.auth.user }));
  handle('get', '/calendar-entries', 200, (request) => listCalendarEntriesForUser({ input: calendarEntryListQuerySchema.parse(request.query), repository: resourceFinanceRepository, user: request.auth.user }));
  handle('post', '/projects/:projectId/time-entries', 201, (request) => logProjectTimeForUser({ ...scoped(request), input: projectTimeEntryCreateSchema.parse(request.body) }));
  handle('patch', '/projects/:projectId/time-entries/:timeEntryId', 200, (request) => updateProjectTimeEntryForUser({ ...scoped(request), input: projectTimeEntryUpdateSchema.parse(request.body), timeEntryId: request.params.timeEntryId }));
  handle('delete', '/projects/:projectId/time-entries/:timeEntryId', 200, (request) => deleteProjectTimeEntryForUser({ ...scoped(request), ...versionedResourceFinanceDeleteSchema.parse(request.body), timeEntryId: request.params.timeEntryId }));
  handle('patch', '/projects/:projectId/resources/:resourceId', 200, (request) => updateProjectResourceForUser({ ...scoped(request), input: projectResourceUpdateSchema.parse(request.body), resourceId: request.params.resourceId }));
  handle('post', '/projects/:projectId/allocations', 201, (request) => addProjectAllocationForUser({ ...scoped(request), input: projectAllocationCreateSchema.parse(request.body) }));
  handle('patch', '/projects/:projectId/allocations/:allocationId', 200, (request) => updateProjectAllocationForUser({ ...scoped(request), allocationId: request.params.allocationId, input: projectAllocationUpdateSchema.parse(request.body) }));
  handle('delete', '/projects/:projectId/allocations/:allocationId', 200, (request) => deleteProjectAllocationForUser({ ...scoped(request), allocationId: request.params.allocationId, ...versionedResourceFinanceDeleteSchema.parse(request.body) }));
  handle('post', '/projects/:projectId/allocations/:allocationId/level', 200, (request) => levelProjectAllocationForUser({ ...scoped(request), allocationId: request.params.allocationId, input: resourceAllocationLevelSchema.parse(request.body) }));

  // Task access for people without a login, and their access links.
  const withAccess = (request) => ({ access, projectId: request.params.projectId, projectRepository, repository: resourceFinanceRepository, user: request.auth.user });
  handle('get', '/projects/:projectId/task-access', 200, (request) => listProjectTaskAccessForUser(withAccess(request)));
  handle('put', '/projects/:projectId/task-access/:resourceId', 200, (request) => setProjectTaskAccessForUser({ ...withAccess(request), input: projectTaskAccessSchema.parse(request.body ?? {}), resourceId: request.params.resourceId }));
  router.post('/projects/:projectId/task-access/:resourceId/link', async (request, response, next) => {
    try {
      // A copied link's URL is in this response and nowhere else.
      response.setHeader('Cache-Control', 'no-store');
      response.status(200).json(await sendTaskAccessLinkForUser({ ...withAccess(request), input: taskAccessLinkSchema.parse(request.body ?? {}), resourceId: request.params.resourceId }));
    } catch (error) { next(error); }
  });
  handle('get', '/resources/:resourceId/access-link', 200, (request) => getResourceAccessLinkForUser({ ...withAccess(request), resourceId: request.params.resourceId }));
  handle('post', '/resources/:resourceId/access-link/revoke', 200, (request) => revokeResourceAccessLinkForUser({ ...withAccess(request), resourceId: request.params.resourceId }));

  registerCrud({ createMethod: 'createPool', createSchema: resourcePoolCreateSchema, deleteMethod: 'deletePool', idKey: 'poolId', path: '/pools', resourceType: 'pool', updateMethod: 'updatePool', updateSchema: resourcePoolUpdateSchema });
  registerCrud({ createMethod: 'createAccountingPeriod', createSchema: accountingPeriodCreateSchema, deleteMethod: 'deleteAccountingPeriod', idKey: 'accountingPeriodId', path: '/accounting-periods', resourceType: 'accountingPeriod', updateMethod: 'updateAccountingPeriod', updateSchema: accountingPeriodUpdateSchema });
  registerCrud({ createMethod: 'createFinancePolicy', createSchema: financePolicyCreateSchema, deleteMethod: 'deleteFinancePolicy', idKey: 'financePolicyId', path: '/finance-policies', resourceType: 'financePolicy', updateMethod: 'updateFinancePolicy', updateSchema: financePolicyUpdateSchema });
  registerCrud({ createMethod: 'createResource', createSchema: enterpriseResourceCreateSchema, deleteMethod: 'deleteResource', idKey: 'resourceId', path: '/resources', resourceType: 'resource', updateMethod: 'updateResource', updateSchema: enterpriseResourceUpdateSchema });
  registerCrud({ createMethod: 'createCalendarEntry', createSchema: resourceCalendarEntryCreateSchema, deleteMethod: 'deleteCalendarEntry', idKey: 'calendarEntryId', path: '/calendar-entries', resourceType: 'calendar', updateMethod: 'updateCalendarEntry', updateSchema: resourceCalendarEntryUpdateSchema });
  registerCrud({ createMethod: 'createAllocation', createSchema: resourceAllocationCreateSchema, deleteMethod: 'deleteAllocation', idKey: 'allocationId', path: '/allocations', resourceType: 'allocation', updateMethod: 'updateAllocation', updateSchema: resourceAllocationUpdateSchema });
  router.post('/allocations/:allocationId/level', async (request, response, next) => {
    try {
      response.json(await levelResourceAllocationForUser({
        allocationId: request.params.allocationId,
        input: resourceAllocationLevelSchema.parse(request.body),
        projectRepository,
        repository: resourceFinanceRepository,
        user: request.auth.user,
      }));
    } catch (error) { next(error); }
  });
  registerCrud({ createMethod: 'createFinancialEntry', createSchema: projectFinancialEntryCreateSchema, deleteMethod: 'deleteFinancialEntry', idKey: 'financialEntryId', path: '/financial-entries', resourceType: 'financial', updateMethod: 'updateFinancialEntry', updateSchema: projectFinancialEntryUpdateSchema });
  registerCrud({ createMethod: 'createTimeEntry', createSchema: timeEntryCreateSchema, deleteMethod: 'deleteTimeEntry', idKey: 'timeEntryId', path: '/time-entries', resourceType: 'time', updateMethod: 'updateTimeEntry', updateSchema: timeEntryUpdateSchema });
  registerCrud({ createMethod: 'createExpense', createSchema: expenseEntryCreateSchema, deleteMethod: 'deleteExpense', idKey: 'expenseId', path: '/expenses', resourceType: 'expense', updateMethod: 'updateExpense', updateSchema: expenseEntryUpdateSchema });
  registerCrud({ createMethod: 'createResourceRate', createSchema: resourceRateCreateSchema, deleteMethod: 'deleteResourceRate', idKey: 'resourceRateId', path: '/resource-rates', resourceType: 'resourceRate', updateMethod: 'updateResourceRate', updateSchema: resourceRateUpdateSchema });
  registerCrud({ createMethod: 'createTimesheetPeriod', createSchema: timesheetPeriodCreateSchema, deleteMethod: 'deleteTimesheetPeriod', idKey: 'timesheetPeriodId', path: '/timesheet-periods', resourceType: 'timesheetPeriod', updateMethod: 'updateTimesheetPeriod', updateSchema: timesheetPeriodUpdateSchema });
  registerCrud({ createMethod: 'createExpenseReceipt', createSchema: expenseReceiptCreateSchema, deleteMethod: 'deleteExpenseReceipt', idKey: 'expenseReceiptId', path: '/expense-receipts', resourceType: 'expenseReceipt', updateMethod: 'updateExpenseReceipt', updateSchema: expenseReceiptUpdateSchema });
  registerCrud({ createMethod: 'createExchangeRate', createSchema: exchangeRateCreateSchema, deleteMethod: 'deleteExchangeRate', idKey: 'exchangeRateId', path: '/exchange-rates', resourceType: 'exchangeRate', updateMethod: 'updateExchangeRate', updateSchema: exchangeRateUpdateSchema });

  router.post('/expenses/:expenseId/receipt-content', async (request, response, next) => {
    try { response.status(201).json(await uploadExpenseReceiptForUser({ expenseId: request.params.expenseId, fileScanner, fileStorage, input: expenseReceiptUploadSchema.parse(request.body), projectRepository, repository: resourceFinanceRepository, user: request.auth.user })); }
    catch (error) { next(error); }
  });
  router.get('/expense-receipts/:expenseReceiptId/content', async (request, response, next) => {
    try {
      const { asset, receipt } = await readExpenseReceiptForUser({ expenseReceiptId: request.params.expenseReceiptId, fileStorage, projectRepository, repository: resourceFinanceRepository, user: request.auth.user });
      response.setHeader('Content-Type', receipt.contentType); response.setHeader('Content-Length', String(asset.size)); response.setHeader('Content-Disposition', `attachment; filename="${receipt.fileName.replace(/["\\\r\n]/g, '_')}"`); response.send(asset.bytes);
    } catch (error) { next(error); }
  });

  return router;
}
