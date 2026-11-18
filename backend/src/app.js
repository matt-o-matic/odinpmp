import cors from 'cors';
import express from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createAssistantRouter,
  createPublicClarificationMailRouter,
} from './modules/assistant/assistant.routes.js';
import { createAgentChatService, createAgentModelResolver, createAgentSessionOpener } from './modules/assistant/agent-chat.service.js';
import { createInMemoryAgentChatsRepository } from './modules/assistant/agent-chats.repository.js';
import { createCommentsRouter } from './modules/comments/comments.routes.js';
import { createEngagementGuard } from './modules/engagements/engagement-guard.js';
import { createEngagementActionsRouter, createEngagementsRouter } from './modules/engagements/engagements.routes.js';
import { createInMemoryWorkspaceModulesRepository } from './modules/workspace-modules/workspace-modules.repository.js';
import { createInMemoryBillingRepository } from './modules/billing/billing.repository.js';
import { createProjectBillingRouter } from './modules/billing/billing.routes.js';
import { createWorkspaceModulesRouter } from './modules/workspace-modules/workspace-modules.routes.js';
import { createAuthMiddleware } from './lib/http/auth-middleware.js';
import { createHttpAuditMiddleware } from './lib/audit/http-audit-middleware.js';
import { createLiveEventBus } from './lib/events/live-event-bus.js';
import { createProjectMutationEventsMiddleware, createWorkspaceMutationEventsMiddleware, projectIdsNamedByWrite } from './lib/events/project-live-events.js';
import {
  createInMemoryDomainEventOutboxRepository,
  dispatchDomainEventOutbox,
} from './lib/events/domain-event-outbox.js';
import { errorHandler } from './lib/http/error-handler.js';
import { notFoundHandler } from './lib/http/not-found-handler.js';
import { createAssistantTurnQueue } from './modules/assistant/assistant-turn-queue.js';
import { createPublicTicketIntakeRouter, createPublicTicketMailRouter } from './modules/projects/ticket-intake.routes.js';
import { PUBLIC_TICKET_SUBMISSION_BODY_LIMIT_BYTES } from './modules/projects/projects.schema.js';
import { createInboundMailBodyParser, createInboundMailRouter } from './modules/mail/inbound-mail.routes.js';
import { wrapProjectRepositoryForAssistant } from './modules/assistant/assistant-ticket-visibility.js';
import { createInMemoryAgentExecutionRepository } from './modules/assistant/agent-execution.repository.js';
import { createInMemoryAccessRepository } from './modules/access/access.repository.js';
import { createInMemoryGuestSessionsRepository } from './modules/guests/guest-sessions.repository.js';
import { createChannelGuestsRouter, createGuestRouter } from './modules/guests/guests.routes.js';
import { createGuestNotificationDirectory } from './modules/guests/guest-notifications.js';
import { createPublicAccessRouter } from './modules/access/access.routes.js';
import { createAuthRouter } from './modules/auth/auth.routes.js';
import { createInMemorySessionsRepository } from './modules/sessions/sessions.repository.js';
import { createInMemoryAssistantRepository } from './modules/assistant/assistant.repository.js';
import { createInMemoryMetricsRepository } from './modules/metrics/metrics.repository.js';
import { createMetricsRouter } from './modules/metrics/metrics.routes.js';
import { createInMemoryInsightsRepository } from './modules/insights/insights.repository.js';
import { createInMemoryMentionsRepository } from './modules/requirements/mentions/mentions.repository.js';
import { createInsightsRouter } from './modules/insights/insights.routes.js';
import { createPursuitRouter } from './modules/pursuit/pursuit.routes.js';
import { createBillingSowLinkReader, describeSowForOdin, readSowLink } from './modules/pursuit/sow-link.js';
import { createPursuitGuestTaskSource } from './modules/pursuit/pursuit-guest-tasks.js';
import { createChangesRouter } from './modules/changes/changes.routes.js';
import { createProjectsRouter } from './modules/projects/projects.routes.js';
import { createProjectTicketConfigRouter } from './modules/projects/project-ticket-config.routes.js';
import { createRankingRouter } from './modules/ranking/ranking.routes.js';
import { createSystemRouter } from './modules/system/system.routes.js';
import { createTenantsRouter } from './modules/tenants/tenants.routes.js';
import { createInMemoryJoinRequestsRepository } from './modules/tenants/join-requests.repository.js';
import { createJoinRequestAdminRouter, createWorkspaceAccessRouter } from './modules/tenants/join-requests.routes.js';
import { createInMemoryEmailChangeRepository } from './modules/users/email-change.js';
import { createEmailChangeRouter, createUsersRouter } from './modules/users/users.routes.js';
import { createVaultRouter } from './modules/vault/vault.routes.js';
import { createChannelFileEventsMiddleware } from './modules/channels/channel-events.js';
import { createChannelsRouter } from './modules/channels/channels.routes.js';
import { createOdinChannelService } from './modules/channels/odin-channel.service.js';
import { createInMemoryNotificationsRepository } from './modules/notifications/notifications.repository.js';
import { createChannelNotificationLevelRouter, createMemberNotificationsRouter } from './modules/notifications/notifications.routes.js';
import { createNotificationsService } from './modules/notifications/notifications.service.js';
import { createPushSender } from './modules/notifications/web-push.js';
import { createChatRouter } from './modules/chat/chat.routes.js';
import { createFileTransferRouter } from './modules/vault/large-files.routes.js';
import { createTransferSigner } from './modules/vault/large-files.service.js';
import { createInMemorySigningRepository } from './modules/signing/signing.repository.js';
import { createSigningRouter } from './modules/signing/signing.routes.js';
import { createSigningSealer } from './modules/signing/signing-seal.js';
import { createWaitlistRouter } from './modules/waitlist/waitlist.routes.js';
import { createGovernanceRouter } from './modules/governance/governance.routes.js';
import { createHomeRouter } from './modules/home/home.routes.js';
import { createInMemoryGovernanceRepository } from './modules/governance/governance.repository.js';
import { createAgentGoalsRouter } from './modules/assistant/agent-goals.routes.js';
import { materializeDueGoalMonitors, materializeGoalEvent } from './modules/assistant/agent-monitors.js';
import { createInMemoryAgentMemoryRepository } from './modules/memory/agent-memory.repository.js';
import { createAgentMemoryRouter } from './modules/memory/agent-memory.routes.js';
import { createInMemoryPortfolioRepository } from './modules/portfolio/portfolio.repository.js';
import { createPortfolioRouter } from './modules/portfolio/portfolio.routes.js';
import { createInMemoryResourceFinanceRepository } from './modules/resource-finance/resource-finance.repository.js';
import { createResourceFinanceRouter } from './modules/resource-finance/resource-finance.routes.js';
import { createInMemoryWorkflowRepository } from './modules/workflows/workflows.repository.js';
import { materializeWorkflowAutomationEvents } from './modules/workflows/workflow-automation.js';
import { createWorkflowsRouter } from './modules/workflows/workflows.routes.js';
import { createWorkspaceEventsRouter } from './modules/workspace/workspace-events.routes.js';
import { createInMemoryReportingRepository } from './modules/reporting/reporting.repository.js';
import { createReportingRouter } from './modules/reporting/reporting.routes.js';
import { refreshEverySearchIndex } from './modules/reporting/reporting.service.js';
import { materializeDueReportSubscriptions } from './modules/reporting/reporting.service.js';
import { createInMemoryIdentityRepository } from './modules/identity/identity.repository.js';
import { createIdentityRouter } from './modules/identity/identity.routes.js';
import { materializeDueAccessReviewCampaigns } from './modules/identity/identity.service.js';
import { createPlatformAdminRouter, createPlatformV1Router } from './modules/platform/platform.routes.js';
import { createInMemoryPlatformRepository } from './modules/platform/platform.repository.js';
import { dispatchWebhookDeliveries, materializeWebhookEvent } from './modules/platform/platform.service.js';
import { postPublicWebhook } from './lib/http/public-webhook-client.js';
import { createOperationalMiddleware, createOperationalState } from './lib/operations/operational-state.js';
import { createScimRouter } from './modules/identity/scim.routes.js';
import { createEnterpriseOidcService } from './modules/identity/oidc.service.js';
import { createEnterpriseOidcRouter } from './modules/identity/oidc.routes.js';
import { createEnterpriseSamlService } from './modules/identity/saml.service.js';
import { createConnectorAdminRouter, createConnectorPublicRouter } from './modules/connectors/connector.routes.js';
import { createInMemoryConnectorRepository } from './modules/connectors/connector.repository.js';
import { createComplianceRouter } from './modules/compliance/compliance.routes.js';
import { createInMemoryComplianceRepository } from './modules/compliance/compliance.repository.js';
import { createInMemoryRequirementsRepository } from './modules/requirements/requirements.repository.js';
import { attachRequirementsBridge, createRequirementsAssistantBridge } from './modules/requirements/requirements-bridge.js';
import { createPublicRequirementsRouter, createRequirementsRouter, createRequirementsSignalsRouter, requirementsServiceDeps } from './modules/requirements/requirements.routes.js';
import { createRequirementsSummaryEngine } from './modules/requirements/summary/summary-engine.js';
import { DEVELOPMENT_GRANT_SECRET } from './modules/requirements/packages/package-grants.js';
import { createInMemoryObjectStorage } from './modules/requirements/packages/package-storage.js';
import { createInMemoryPackagesRepository } from './modules/requirements/packages/packages.repository.js';
import { createInMemoryPlansRepository } from './modules/requirements/plans/plans.repository.js';
import { createPublicPackageUploadRouter, packageServiceDeps } from './modules/requirements/packages/packages.routes.js';
import { issuePackageGrant } from './modules/requirements/packages/packages.service.js';
import { registerRoundSummaryScopes } from './modules/requirements/rounds/round-summaries.js';
import { createInMemoryRoundsRepository } from './modules/requirements/rounds/rounds.repository.js';
import { createRoundsRouter } from './modules/requirements/rounds/rounds.routes.js';
import { createInMemoryMcpOAuthRepository } from './mcp/oauth.repository.js';
import { createMcpOAuthService } from './mcp/oauth.service.js';
import { createMcpHttpRouter } from './mcp/http.js';

function securityHeaders(_request, response, next) {
  response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  response.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=()');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  next();
}

function createCorsOptions(allowedOrigins = []) {
  const origins = new Set(allowedOrigins);
  return {
    allowedHeaders: ['Authorization', 'Content-Type', 'X-CSRF-Token', 'X-Odin-Client-Id', 'X-Request-Id'],
    credentials: true,
    exposedHeaders: ['X-Request-Id'],
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    origin(origin, callback) {
      if (!origin || origins.has(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
  };
}

export function createApp(deps = {}) {
  const app = express();
  const operationalState = deps.operationalState ?? createOperationalState({ dependencyChecks: deps.readinessChecks, slo: deps.slo });
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const corsAllowedOrigins = deps.corsAllowedOrigins ?? (() => {
    try {
      return [new URL(deps.frontendAppUrl ?? 'http://localhost:5173/app').origin];
    } catch (_error) {
      return [];
    }
  })();

  app.disable('x-powered-by');
  app.set('trust proxy', deps.trustProxy ?? 'loopback');
  app.use(securityHeaders);
  const applyCors = cors(createCorsOptions(corsAllowedOrigins));
  app.use((req, res, next) => {
    if (deps.mcpPublicUrl && (req.path === '/mcp' || req.path.startsWith('/api/mcp/') || req.path.startsWith('/.well-known/oauth-'))) return next();
    return applyCors(req, res, next);
  });
  app.use(createOperationalMiddleware({ state: operationalState }));
  // Route-specific limits go ahead of the global parser, which then skips the parsed body.
  // The SES Lambda forwards up to 10 MiB of reply attachments (~14 MB as base64). Apache sets
  // no LimitRequestBody, so these limits are the binding ones.
  app.use(
    ['/api/projects/import', '/api/projects/import/inspect', '/api/tenants/restore', '/api/public/clarification-mail/inbound', '/api/public/ticket-mail/inbound'],
    express.json({ limit: 15 * 1024 * 1024 }),
  );
  // A file or a new version of one, as base64 inside JSON: fileUploadSchema's limit and its fields.
  app.use(/^\/api\/projects\/[^/]+\/files(?:\/[^/]+\/versions)?$/, express.json({ limit: 21 * 1024 * 1024 }));
  app.use('/api/public/ticket-intake', express.json({ limit: PUBLIC_TICKET_SUBMISSION_BODY_LIMIT_BYTES }));
  app.use('/api/public/inbound-mail', createInboundMailBodyParser({ inboundMailWebhookSecret: deps.inboundMailWebhookSecret }));
  // Assistant messages can carry attached files and images.
  app.use('/api/assistant/chats', express.json({ limit: 12 * 1024 * 1024 }));
  app.use(express.json({ limit: Number(deps.jsonBodyLimitBytes ?? 1024 * 1024) }));
  app.use((request, response, next) => {
    const incomingRequestId = String(request.headers['x-request-id'] ?? '').trim();
    const requestId = incomingRequestId || randomUUID();

    request.id = requestId;
    request.requestId = requestId;
    response.setHeader('X-Request-Id', requestId);

    next();
  });
  app.use(createHttpAuditMiddleware({ auditWriter: deps.auditWriter }));

  const sessionsRepository = deps.sessionsRepository ?? createInMemorySessionsRepository();
  const assistantRepository = deps.assistantRepository ?? createInMemoryAssistantRepository();
  const governanceRepository = deps.governanceRepository ?? createInMemoryGovernanceRepository();
  const agentExecutionRepository = deps.agentExecutionRepository ?? createInMemoryAgentExecutionRepository();
  const agentMemoryRepository = deps.agentMemoryRepository ?? createInMemoryAgentMemoryRepository();
  const domainEventOutboxRepository = deps.domainEventOutboxRepository ?? createInMemoryDomainEventOutboxRepository();
  const portfolioRepository = deps.portfolioRepository ?? createInMemoryPortfolioRepository();
  const resourceFinanceRepository = deps.resourceFinanceRepository ?? createInMemoryResourceFinanceRepository();
  const workflowRepository = deps.workflowRepository ?? createInMemoryWorkflowRepository();
  const workspaceModulesRepository = deps.workspaceModulesRepository ?? createInMemoryWorkspaceModulesRepository();
  // invoice-gen's records on projects; in memory, claims change the finance repository's entries.
  const billingRepository = deps.billingRepository ?? createInMemoryBillingRepository({
    recordChanges: (entries) => deps.projectRepository?.recordProjectChanges?.(entries),
    resourceFinanceRepository,
  });
  const metricsRepository = deps.metricsRepository ?? createInMemoryMetricsRepository();
  const reportingRepository = deps.reportingRepository ?? createInMemoryReportingRepository();
  const insightsRepository = deps.insightsRepository ?? createInMemoryInsightsRepository({ projectRepository: deps.projectRepository });
  const identityRepository = deps.identityRepository ?? createInMemoryIdentityRepository();
  const platformRepository = deps.platformRepository ?? createInMemoryPlatformRepository();
  const connectorRepository = deps.connectorRepository ?? createInMemoryConnectorRepository();
  const complianceRepository = deps.complianceRepository ?? createInMemoryComplianceRepository();
  const requirementsRepository = deps.requirementsRepository ?? createInMemoryRequirementsRepository({ assistantRepository });
  const accessRepository = deps.accessRepository ?? createInMemoryAccessRepository();
  const guestSessionsRepository = deps.guestSessionsRepository ?? createInMemoryGuestSessionsRepository();
  const packagesRepository = deps.packagesRepository ?? createInMemoryPackagesRepository({ requirementsRepository });
  const roundsRepository = deps.roundsRepository ?? createInMemoryRoundsRepository({ requirementsRepository });
  const signingRepository = deps.signingRepository ?? createInMemorySigningRepository({ requirementsRepository });
  const signingSealer = deps.signingSealer ?? createSigningSealer({
    key: deps.signingSealKey,
    keyId: deps.signingSealKeyId,
    previousKeys: deps.signingSealKeysPrevious,
    production: deps.nodeEnv === 'production',
  });
  const mentionsRepository = deps.mentionsRepository ?? createInMemoryMentionsRepository();
  const plansRepository = deps.plansRepository ?? createInMemoryPlansRepository({ requirementsRepository });
  const emailChangeRepository = deps.emailChangeRepository ?? createInMemoryEmailChangeRepository();
  const joinRequestsRepository = deps.joinRequestsRepository
    ?? (deps.authRepository?.state ? createInMemoryJoinRequestsRepository({ authRepository: deps.authRepository }) : null);
  const enterpriseOidcService = deps.enterpriseOidcService ?? createEnterpriseOidcService({ authRepository: deps.authRepository, callbackBaseUrl: deps.backendPublicUrl ?? deps.frontendAppUrl ?? 'http://localhost:3001', identityRepository, oidcClient: deps.oidcClient, secretResolver: deps.oidcSecretResolver, sessionsRepository, tenantsRepository: deps.tenantsRepository, tokenService: deps.tokenService });
  const enterpriseSamlService = deps.enterpriseSamlService ?? createEnterpriseSamlService({ authRepository: deps.authRepository, callbackBaseUrl: deps.backendPublicUrl ?? deps.frontendAppUrl ?? 'http://localhost:3001', identityRepository, samlFactory: deps.samlFactory, secretResolver: deps.samlSecretResolver, sessionsRepository, tenantsRepository: deps.tenantsRepository, tokenService: deps.tokenService });
  const assistantTurnQueue = deps.assistantTurnQueue ?? createAssistantTurnQueue({
    executionRepository: agentExecutionRepository,
    runTimeoutMs: deps.assistantTurnRunTimeoutMs ?? 0,
  });
  const liveEventBus = deps.liveEventBus ?? createLiveEventBus();
  app.locals.sessionsRepository = sessionsRepository;
  app.locals.auditWriter = deps.auditWriter ?? null;
  app.locals.assistantRepository = assistantRepository;
  app.locals.agentExecutionRepository = agentExecutionRepository;
  app.locals.agentMemoryRepository = agentMemoryRepository;
  app.locals.domainEventOutboxRepository = domainEventOutboxRepository;
  app.locals.identityRepository = identityRepository;
  app.locals.platformRepository = platformRepository;
  app.locals.mcpOAuthRepository = deps.mcpOAuthRepository ?? createInMemoryMcpOAuthRepository();
  if (deps.mcpPublicUrl) {
    const oauth = createMcpOAuthService({ repository: app.locals.mcpOAuthRepository,
      platformRepository, authRepository: deps.authRepository, identityRepository, resourceUrl: deps.mcpPublicUrl });
    app.locals.mcpOAuthService = oauth;
    app.use(createMcpHttpRouter({ oauth, resourceUrl: deps.mcpPublicUrl, frontendAppUrl: deps.frontendAppUrl ?? 'http://localhost:5173/app',
      allowedOrigins: deps.mcpAllowedOrigins ?? [], authRepository: deps.authRepository, tokenService: deps.tokenService, projectRepository: deps.projectRepository,
      ...(deps.mcpTrafficLimiter ? { trafficLimiter: deps.mcpTrafficLimiter } : {}) }));
  }
  app.locals.connectorRepository = connectorRepository;
  app.locals.complianceRepository = complianceRepository;
  app.locals.requirementsRepository = requirementsRepository;
  app.locals.accessRepository = accessRepository;
  // Odin summaries, written by requirementsAiService.summarize() when it has one.
  const requirementsSummaries = deps.requirementsSummaries ?? createRequirementsSummaryEngine({
    assistantRepository,
    clock: deps.requirementsClock ?? (() => new Date()),
    liveEventBus,
    projectRepository: deps.projectRepository,
    requirementsRepository,
    summaryAi: typeof deps.requirementsAiService?.summarize === 'function' ? deps.requirementsAiService : null,
  });
  app.locals.requirementsSummaries = requirementsSummaries;
  // Odin summaries for screens in a round and for whole rounds.
  registerRoundSummaryScopes(requirementsSummaries, {
    assistantRepository,
    liveEventBus,
    packagesRepository,
    projectRepository: deps.projectRepository,
    requirementsRepository,
    roundsRepository,
  });
  attachRequirementsBridge(assistantRepository, createRequirementsAssistantBridge({
    clock: deps.requirementsClock ?? (() => new Date()),
    frontendAppUrl: deps.frontendAppUrl ?? 'http://localhost:5173/app',
    liveEventBus,
    requirementsRepository,
    summaries: requirementsSummaries,
  }));
  app.locals.assistantTurnQueue = assistantTurnQueue;
  app.locals.liveEventBus = liveEventBus;
  app.locals.stopLiveEventBus = () => liveEventBus.stop?.();
  app.locals.operationalState = operationalState;
  // Notifications: records, levels, the per-person stream and Web Push.
  const notificationsRepository = deps.notificationsRepository ?? createInMemoryNotificationsRepository();
  const pushSender = deps.pushSender ?? createPushSender({
    config: deps.webPush ?? {},
    ...(deps.pushEndpointAllowed ? { endpointAllowed: deps.pushEndpointAllowed } : {}),
    ...(deps.pushRetryDelaysMs ? { retryDelaysMs: deps.pushRetryDelaysMs } : {}),
    ...(deps.webPushSend ? { sendNotification: deps.webPushSend } : {}),
    ...(deps.notificationsClock ? { now: deps.notificationsClock } : {}),
    repository: notificationsRepository,
  });
  const notifications = createNotificationsService({
    authRepository: deps.authRepository,
    frontendAppUrl: deps.frontendAppUrl ?? '',
    // Guests are kept by workspace access link (guests/guest-notifications.js); its deps are built below.
    guestDirectory: deps.notificationGuestDirectory ?? createGuestNotificationDirectory(() => resolvedDeps),
    liveEventBus,
    ...(deps.notificationsClock ? { now: deps.notificationsClock } : {}),
    projectRepository: deps.projectRepository,
    pushSender,
    repository: notificationsRepository,
  });
  // A work item given a new assignee tells them, however it was saved.
  const stopAssignmentNotifications = deps.projectRepository?.observeItemRevisions?.((revision) => notifications.notifyItemRevision(revision)) ?? (() => {});
  app.locals.notifications = notifications;
  app.locals.notificationsRepository = notificationsRepository;
  app.locals.pushSender = pushSender;
  // Agent-facing paths read project detail with gated external tickets stripped.
  const agentProjectRepository = wrapProjectRepositoryForAssistant(deps.projectRepository);
  // The assistant: chats whose tools call Odin's REST API as the signed-in user.
  const agentChatsRepository = deps.agentChatsRepository ?? createInMemoryAgentChatsRepository();
  // The workspace's OpenAI client, shared by the assistant and the ticket review classifier.
  const agentModelResolver = deps.agentModelResolver ?? createAgentModelResolver({
    defaultApiKey: deps.openAiApiKey ?? '',
    defaultModel: deps.defaultOpenAiModel ?? '',
    openAiFactory: deps.openAiFactory ?? null,
    tenantsRepository: deps.tenantsRepository,
  });
  const agentChatService = deps.agentChatService ?? createAgentChatService({
    agentConfig: deps.assistantAgent ?? {},
    chatsRepository: agentChatsRepository,
    domainEventOutboxRepository,
    governanceRepository,
    liveEventBus,
    modelResolver: agentModelResolver,
    openSession: deps.agentSessionOpener ?? createAgentSessionOpener({
      // Tools call this app over loopback; tests set app.locals.agentApiOrigin after listening.
      apiOrigin: deps.agentApiOrigin ?? (() => app.locals.agentApiOrigin ?? `http://127.0.0.1:${deps.port ?? 3001}`),
      sessionsRepository,
      tokenService: deps.tokenService,
    }),
    projectRepository: agentProjectRepository,
    turnQueue: assistantTurnQueue,
  });
  app.locals.agentChatService = agentChatService;
  // A guest's @odin turn sees the pursuit tasks the guest view shows them (guest-tasks.js). The
  // source is built with the other deps further down.
  const odinGuestTasks = { available: true, listTasks: (args) => resolvedDeps.guestTaskSource?.listTasks?.(args) ?? [] };
  app.locals.odinGuestTasks = odinGuestTasks;
  // Odin in channels: a post that tags @odin gets an answer in its thread, as the person who asked.
  const odinChannelService = deps.odinChannelService ?? createOdinChannelService({
    agentChatService,
    agentConfig: deps.assistantAgent ?? {},
    authRepository: deps.authRepository,
    liveEventBus,
    modelResolver: agentModelResolver,
    notifications,
    projectRepository: agentProjectRepository,
    guestTasks: odinGuestTasks,
    // A member's turn knows the SOW billing holds (pursuit/sow-link.js).
    sowState: async ({ projectId, tenantId }) => describeSowForOdin(await readSowLink({ projectId, reader: resolvedDeps.sowLinkReader, tenantId })),
    ...(deps.odinTurnTimeoutMs !== undefined ? { timeoutMs: deps.odinTurnTimeoutMs } : {}),
  });
  app.locals.odinChannelService = odinChannelService;
  app.locals.materializeDueGoalMonitors = (options = {}) => materializeDueGoalMonitors({
    authRepository: deps.authRepository,
    executionRepository: agentExecutionRepository,
    frontendAppUrl: deps.frontendAppUrl,
    governanceRepository,
    platformRepository,
    portfolioRepository,
    resourceFinanceRepository,
    workflowRepository,
    mailRepository: deps.mailRepository,
    projectRepository: agentProjectRepository,
    ...options,
  });
  app.locals.materializeGoalEvent = (options = {}) => materializeGoalEvent({
    authRepository: deps.authRepository,
    executionRepository: agentExecutionRepository,
    frontendAppUrl: deps.frontendAppUrl,
    governanceRepository,
    mailRepository: deps.mailRepository,
    platformRepository,
    projectRepository: agentProjectRepository,
    resourceFinanceRepository,
    workflowRepository,
    ...options,
  });
  app.locals.materializeDueReportSubscriptions = (options = {}) => materializeDueReportSubscriptions({
    authRepository: deps.authRepository,
    dependencies: {
      agentExecutionRepository,
      governanceRepository,
      portfolioRepository,
      projectRepository: deps.projectRepository,
      resourceFinanceRepository,
      workflowRepository,
    },
    frontendAppUrl: deps.frontendAppUrl,
    mailRepository: deps.mailRepository,
    repository: reportingRepository,
    ...options,
  });
  app.locals.materializeReportingWarehouse = (options = {}) => reportingRepository.materializeWarehouseChanges(options);
  app.locals.materializeDueAccessReviewCampaigns = (options = {}) => materializeDueAccessReviewCampaigns({
    repository: identityRepository,
    ...options,
  });
  app.locals.materializeWorkflowAutomationEvents = (options = {}) => materializeWorkflowAutomationEvents({
    domainEventOutboxRepository,
    workflowRepository,
    ...options,
  });
  const dispatchProjectAutomationEvent = (event) => Promise.all([
    reportingRepository.captureWarehouseChange({ event }),
    app.locals.materializeGoalEvent({ event: event.payload, eventId: event.id, eventType: event.eventType, projectId: event.projectId, tenantId: event.tenantId }),
    materializeWebhookEvent({ event, repository: platformRepository }),
  ]);
  app.locals.dispatchDomainEvents = (options = {}) => dispatchDomainEventOutbox({
    handlers: {
      'governance.changed': dispatchProjectAutomationEvent,
      'workflow.sla.overdue': dispatchProjectAutomationEvent,
      'workflow.transitioned': dispatchProjectAutomationEvent,
    },
    repository: domainEventOutboxRepository,
    ...options,
  });
  app.locals.dispatchWebhookDeliveries = (options = {}) => dispatchWebhookDeliveries({
    masterSecret: deps.webhookSigningMasterSecret ?? 'odin-local-webhook-signing-master-secret',
    postWebhook: deps.postWebhook ?? postPublicWebhook,
    repository: platformRepository,
    ...options,
  });
  const resolvedDeps = {
    ...deps,
    accessRepository,
    guestSessionsRepository,
    assistantRepository,
    agentChatService,
    agentModelResolver,
    agentChatsRepository,
    odinChannelService,
    agentMemoryRepository,
    domainEventOutboxRepository,
    governanceRepository,
    portfolioRepository,
    resourceFinanceRepository,
    workflowRepository,
    workspaceModulesRepository,
    billingRepository,
    // The engagement Insights' SOW and activity cards read billing's link and channel posts.
    sowLinkReader: deps.sowLinkReader ?? createBillingSowLinkReader({ billingRepository }),
    channelActivityReader: deps.channelActivityReader ?? (deps.projectRepository?.listChannelPostActivity ? (args) => deps.projectRepository.listChannelPostActivity(args) : null),
    metricsRepository,
    reportingRepository,
    insightsRepository,
    identityRepository,
    platformRepository,
    connectorRepository,
    complianceRepository,
    requirementsRepository,
    requirementsAiService: deps.requirementsAiService ?? null,
    requirementsClock: deps.requirementsClock ?? (() => new Date()),
    requirementsSummaries,
    mentionsRepository,
    packagesRepository,
    plansRepository,
    roundsRepository,
    signingRepository,
    signingSealer,
    // Signs the backend URLs that move file bytes with local storage. Without a configured secret
    // each process makes its own, so its links work only on it.
    fileTransferSigner: deps.fileTransferSigner ?? createTransferSigner(deps.fileTransferSecret || randomBytes(32).toString('base64url')),
    fileTransferPublicUrl: deps.fileTransferPublicUrl ?? deps.backendPublicUrl ?? '',
    // The app's origins, which may show an inline file transfer (a PDF preview) in a frame.
    fileFrameAncestors: corsAllowedOrigins,
    packageStorage: deps.reviewPackageStorage ?? createInMemoryObjectStorage(),
    reviewGrantSecret: deps.reviewGrantSecret ?? DEVELOPMENT_GRANT_SECRET,
    reviewPublicUrl: deps.reviewPublicUrl ?? '',
    enterpriseOidcService,
    enterpriseSamlService,
    assistantTurnQueue,
    liveEventBus,
    notifications,
    notificationsRepository,
    operationalState,
    pushSender,
    sessionsRepository,
    joinRequestsRepository,
    emailChangeRepository,
  };
  // The AI Workspace administers requirements topics through the bridge.
  // Guests see their pursuit tasks through the pursuit board's visibility rule (guest-tasks.js).
  resolvedDeps.guestTaskSource = deps.guestTaskSource ?? createPursuitGuestTaskSource(resolvedDeps);
  assistantRepository.requirementsBridge?.bindServices?.(() => requirementsServiceDeps(resolvedDeps));
  const agentMonitorSweepIntervalMs = Number(deps.agentMonitorSweepIntervalMs ?? 60_000);
  if (agentMonitorSweepIntervalMs > 0) {
    const timer = setInterval(() => app.locals.materializeDueGoalMonitors().catch(() => {}), agentMonitorSweepIntervalMs);
    timer.unref?.();
    app.locals.stopAgentMonitorSweeper = () => clearInterval(timer);
  } else {
    app.locals.stopAgentMonitorSweeper = () => {};
  }
  const domainEventSweepIntervalMs = Number(deps.domainEventSweepIntervalMs ?? 60_000);
  if (domainEventSweepIntervalMs > 0) {
    const timer = setInterval(() => app.locals.dispatchDomainEvents().catch(() => {}), domainEventSweepIntervalMs);
    timer.unref?.();
    app.locals.stopDomainEventSweeper = () => clearInterval(timer);
  } else {
    app.locals.stopDomainEventSweeper = () => {};
  }
  const workflowAutomationSweepIntervalMs = Number(deps.workflowAutomationSweepIntervalMs ?? 60_000);
  if (workflowAutomationSweepIntervalMs > 0) {
    const timer = setInterval(() => app.locals.materializeWorkflowAutomationEvents()
      .then(() => app.locals.dispatchDomainEvents()).catch(() => {}), workflowAutomationSweepIntervalMs);
    timer.unref?.();
    app.locals.stopWorkflowAutomationSweeper = () => clearInterval(timer);
  } else {
    app.locals.stopWorkflowAutomationSweeper = () => {};
  }
  const reportSubscriptionSweepIntervalMs = Number(deps.reportSubscriptionSweepIntervalMs ?? 60_000);
  if (reportSubscriptionSweepIntervalMs > 0) {
    const timer = setInterval(() => app.locals.materializeDueReportSubscriptions().catch(() => {}), reportSubscriptionSweepIntervalMs);
    timer.unref?.();
    app.locals.stopReportSubscriptionSweeper = () => clearInterval(timer);
  } else {
    app.locals.stopReportSubscriptionSweeper = () => {};
  }
  const reportingWarehouseSweepIntervalMs = Number(deps.reportingWarehouseSweepIntervalMs ?? 15_000);
  if (reportingWarehouseSweepIntervalMs > 0) {
    const timer = setInterval(() => app.locals.materializeReportingWarehouse().catch(() => {}), reportingWarehouseSweepIntervalMs);
    timer.unref?.();
    app.locals.stopReportingWarehouseSweeper = () => clearInterval(timer);
  } else {
    app.locals.stopReportingWarehouseSweeper = () => {};
  }
  const accessReviewCampaignSweepIntervalMs = Number(deps.accessReviewCampaignSweepIntervalMs ?? 60_000);
  if (accessReviewCampaignSweepIntervalMs > 0) {
    const timer = setInterval(() => app.locals.materializeDueAccessReviewCampaigns().catch(() => {}), accessReviewCampaignSweepIntervalMs);
    timer.unref?.();
    app.locals.stopAccessReviewCampaignSweeper = () => clearInterval(timer);
  } else {
    app.locals.stopAccessReviewCampaignSweeper = () => {};
  }
  // Deletes Bug Reporter reply contents 30 days after settling, and expires unsettled replies.
  const bugReporterReplySweepIntervalMs = Number(deps.bugReporterReplySweepIntervalMs ?? 3_600_000);
  if (bugReporterReplySweepIntervalMs > 0 && deps.mailRepository?.purgeReplies) {
    const timer = setInterval(() => deps.mailRepository.purgeReplies().catch(() => {}), bugReporterReplySweepIntervalMs);
    timer.unref?.();
    app.locals.stopBugReporterReplySweeper = () => clearInterval(timer);
  } else {
    app.locals.stopBugReporterReplySweeper = () => {};
  }
  const webhookSweepIntervalMs = Number(deps.webhookSweepIntervalMs ?? 30_000);
  if (webhookSweepIntervalMs > 0) {
    const timer = setInterval(() => app.locals.dispatchWebhookDeliveries().catch(() => {}), webhookSweepIntervalMs);
    timer.unref?.();
    app.locals.stopWebhookSweeper = () => clearInterval(timer);
  } else {
    app.locals.stopWebhookSweeper = () => {};
  }

  app.get('/images/users/:fileName', async (request, response, next) => {
    const fileName = request.params.fileName;
    const match = /^[a-z0-9_-]+\.(png|jpe?g|webp)$/i.exec(fileName);
    if (!match || !resolvedDeps.avatarStorage?.read) {
      next();
      return;
    }

    try {
      const asset = await resolvedDeps.avatarStorage.read(fileName);
      const ext = match[1].toLowerCase();
      response.setHeader('Content-Type', ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`);
      response.setHeader('Cache-Control', 'no-store');
      response.status(200).send(asset.bytes);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.name === 'NoSuchKey' || error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404) {
        response.status(404).end();
        return;
      }
      next(error);
    }
  });

  // Static images shipped with the backend (default avatar, etc.)
  app.use('/images', express.static(path.resolve(currentDir, '../public/images'), { fallthrough: true }));

  app.use(createSystemRouter(resolvedDeps));
  app.use('/api/auth/sso', createEnterpriseOidcRouter(resolvedDeps));
  app.use('/api/auth', createAuthRouter(resolvedDeps));
  app.use('/api/assistant', createAssistantRouter(resolvedDeps));
  app.use('/api/agent-goals', createAgentGoalsRouter({ ...resolvedDeps, agentExecutionRepository }));
  app.use('/api/home', createHomeRouter({ ...resolvedDeps, agentExecutionRepository }));
  app.use('/api/agent-memory', createAgentMemoryRouter(resolvedDeps));
  app.use('/api/portfolio', createPortfolioRouter(resolvedDeps));
  app.use('/api/workspace/events', createWorkspaceEventsRouter(resolvedDeps));
  app.use('/api/me', createMemberNotificationsRouter(resolvedDeps));
  app.use('/api/workspace/modules', createWorkspaceModulesRouter(resolvedDeps));
  app.use('/api/engagements', createEngagementsRouter(resolvedDeps));
  // Odin Chat: the sidebar, Mentions, Threads and direct messages.
  app.use('/api/chat', createChatRouter({ ...resolvedDeps, liveEventBus }));
  // Writes outside /api/projects/:projectId still refresh the screens that show them, including
  // those an MCP client or the assistant makes (see lib/events/project-live-events.js).
  app.use('/api/resource-planning', createWorkspaceMutationEventsMiddleware({ area: 'resources', liveEventBus, projectIdsOf: projectIdsNamedByWrite }));
  app.use('/api/resource-planning', createResourceFinanceRouter(resolvedDeps));
  app.use('/api/workflows', createWorkspaceMutationEventsMiddleware({ area: 'workflows', liveEventBus, projectIdsOf: projectIdsNamedByWrite }));
  app.use('/api/workflows', createWorkflowsRouter(resolvedDeps));
  app.use('/api/reporting', createReportingRouter(resolvedDeps));
  // The scheduled search index refresh (server.js), with the same dependencies as search.
  app.locals.refreshSearchIndexes = () => {
    const { authRepository: _authRepository, reportingRepository: searchRepository, tokenService: _tokenService, ...dependencies } = resolvedDeps;
    return refreshEverySearchIndex({ dependencies, repository: searchRepository });
  };
  app.use('/api/identity', createIdentityRouter(resolvedDeps));
  app.use('/api/integrations', createPlatformAdminRouter(resolvedDeps));
  app.use('/api/connectors', createConnectorAdminRouter(resolvedDeps));
  app.use('/api/compliance', createComplianceRouter({ ...resolvedDeps, complianceRepository }));
  app.use('/api/v1', createPlatformV1Router(resolvedDeps));
  app.use('/api/scim/v2', createScimRouter(resolvedDeps));
  // Review rounds sit ahead of the generic project mutation events: annotation saves arrive
  // per keypress and publish their own requirements.* events instead.
  // Engagement URLs: 404 with the Consulting module off, read-only once lost (engagement-guard.js).
  const engagementGuard = createEngagementGuard({
    projectRepository: deps.projectRepository,
    requireAuth: createAuthMiddleware({ allowMcp: true, authRepository: deps.authRepository, tokenService: deps.tokenService }),
    workspaceModulesRepository,
  });
  app.use('/api/projects/:projectId', engagementGuard.project);
  app.use('/api/files/:fileId', engagementGuard.file);
  app.use('/api/projects/:projectId/requirements/rounds', createRoundsRouter(resolvedDeps));
  app.use('/api/projects/:projectId', createProjectMutationEventsMiddleware({ liveEventBus }));
  // Channels: their routes, and for the vault's routes a guard that
  // keeps archived channels' libraries read-only and publishes channel.updated for file writes.
  const channelFileEvents = createChannelFileEventsMiddleware({
    liveEventBus,
    projectRepository: deps.projectRepository,
    requireAuth: createAuthMiddleware({ allowMcp: true, authRepository: deps.authRepository, tokenService: deps.tokenService }),
  });
  app.use('/api/projects/:projectId', channelFileEvents);
  app.use('/api/files/:fileId', channelFileEvents);
  app.use('/api/projects/:projectId', createChannelGuestsRouter(resolvedDeps));
  app.use('/api/projects/:projectId', createChannelsRouter(resolvedDeps));
  app.use('/api/projects/:projectId', createChannelNotificationLevelRouter(resolvedDeps));
  app.use('/api/projects', createEngagementActionsRouter(resolvedDeps));
  app.use('/api/projects/:projectId/billing', createProjectBillingRouter(resolvedDeps));
  app.use('/api/projects/:projectId/signing-requests', createSigningRouter(resolvedDeps));
  // A new project has no listeners of its own yet; the project list hears of it here.
  app.post('/api/projects', createWorkspaceMutationEventsMiddleware({ area: 'projects', liveEventBus }));
  app.use('/api/projects/:projectId/requirements', createRequirementsRouter(resolvedDeps));
  app.use('/api/projects', createPursuitRouter(resolvedDeps));
  app.use('/api/projects', createInsightsRouter(resolvedDeps));
  app.use('/api/projects', createChangesRouter(resolvedDeps));
  app.use('/api/projects', createProjectTicketConfigRouter(resolvedDeps));
  app.use('/api/requirements', createRequirementsSignalsRouter(resolvedDeps));
  app.use('/api/projects', createProjectsRouter(resolvedDeps));
  app.use('/api/projects', createGovernanceRouter(resolvedDeps));
  app.use(createCommentsRouter(resolvedDeps));
  app.use('/api/metrics', createMetricsRouter(resolvedDeps));
  app.use('/api/public/clarification-mail', createPublicClarificationMailRouter(resolvedDeps));
  app.use('/api/public/requirements', createPublicRequirementsRouter(resolvedDeps));
  app.use('/api/public/access', createPublicAccessRouter(resolvedDeps));
  // Channel guests' own routes. Their session works here only.
  app.use('/api/guest', createGuestRouter({ ...resolvedDeps, liveEventBus }));
  app.use('/api/public/requirements-uploads', createPublicPackageUploadRouter(resolvedDeps));
  app.locals.packagesRepository = resolvedDeps.packagesRepository;
  app.locals.roundsRepository = roundsRepository;
  app.locals.mentionsRepository = mentionsRepository;
  app.locals.plansRepository = plansRepository;
  app.locals.packageStorage = resolvedDeps.packageStorage;
  app.locals.issuePackageGrant = (options) => issuePackageGrant(packageServiceDeps(resolvedDeps), options);
  app.use('/api/public/ticket-intake', createPublicTicketIntakeRouter({
    frontendAppUrl: deps.frontendAppUrl,
    liveEventBus,
    mailReplyDomain: deps.mailReplyDomain,
    mailRepository: deps.mailRepository,
    projectRepository: deps.projectRepository,
    ticketConfigRepository: deps.tenantsRepository,
  }));
  app.use('/api/public/ticket-mail', createPublicTicketMailRouter({
    inboundMailWebhookSecret: deps.inboundMailWebhookSecret,
    liveEventBus,
    mailReplyDomain: deps.mailReplyDomain,
    projectRepository: deps.projectRepository,
  }));
  app.use('/api/public/inbound-mail', createInboundMailRouter({ ...resolvedDeps, liveEventBus }));
  app.use('/api/public/connectors', createConnectorPublicRouter(resolvedDeps));
  app.use('/api/ranking', createRankingRouter(resolvedDeps));
  if (joinRequestsRepository) {
    app.use('/api/workspace-access', createWorkspaceAccessRouter(resolvedDeps));
    app.use('/api/tenants/user-requests', createJoinRequestAdminRouter(resolvedDeps));
  }
  app.use('/api/tenants', createTenantsRouter(resolvedDeps));
  app.use('/api/account/email-change', createEmailChangeRouter(resolvedDeps));
  app.use('/api/users', createUsersRouter(resolvedDeps));
  app.use(createVaultRouter(resolvedDeps));
  app.use(createFileTransferRouter(resolvedDeps));
  app.use('/api/public/waitlist', createWaitlistRouter(resolvedDeps));

  app.locals.beginDrain = async ({ timeoutMs = 30_000 } = {}) => {
    operationalState.setDraining(true);
    app.locals.stopAgentMonitorSweeper?.();
    app.locals.stopDomainEventSweeper?.();
    app.locals.stopWorkflowAutomationSweeper?.();
    app.locals.stopReportSubscriptionSweeper?.();
    app.locals.stopReportingWarehouseSweeper?.();
    app.locals.stopAccessReviewCampaignSweeper?.();
    app.locals.stopWebhookSweeper?.();
    app.locals.stopBugReporterReplySweeper?.();
    app.locals.requirementsSummaries?.stop?.();
    stopAssignmentNotifications();
    await pushSender.drain?.();
    await app.locals.stopLiveEventBus?.();
    return operationalState.waitForIdle({ timeoutMs });
  };

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
