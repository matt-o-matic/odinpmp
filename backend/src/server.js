import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { loadEnv } from './config/env.js';
import { createGoogleOAuthClient } from './lib/auth/google-oauth.js';
import { createRecaptchaVerifier, createUnavailableRecaptchaVerifier } from './lib/auth/recaptcha.js';
import { createAuditWriter } from './lib/audit/audit-writer.js';
import { createMysqlDomainEventOutboxRepository } from './lib/events/domain-event-outbox.js';
import { createApplicationObjectStorage } from './lib/files/file-storage.js';
import { createClamAvFileScanner, createNoopFileScanner } from './lib/files/file-scanner.js';
import { createFileScanProcessor, logFileScanFailure, startFileScanWorker } from './modules/vault/file-scan-worker.js';
import { createFilePreviewProcessor, logFilePreviewFailure, startFilePreviewWorker } from './modules/vault/file-preview-worker.js';
import { createSofficeConverter } from './lib/files/soffice-converter.js';
import { createTransferSigner } from './modules/vault/large-files.service.js';
import { createTenantAwareProjectAiService } from './lib/ai/tenant-aware-project-ai.js';
import { createTokenService } from './lib/auth/token-service.js';
import { ensureDevelopmentDemoUser } from './modules/auth/auth.service.js';
import { createMysqlPool } from './lib/db/mysql.js';
import { reportPendingMysqlMigrations } from './lib/database/schema-migrations.js';
import { mysqlMigrationDefinitions } from './jobs/bootstrap-schema.lib.js';
import {
  createMysqlAssistantRepository,
} from './modules/assistant/assistant.repository.js';
import { createMysqlAgentExecutionRepository } from './modules/assistant/agent-execution.repository.js';
import { createMysqlAgentMemoryRepository } from './modules/memory/agent-memory.repository.js';
import { createMysqlComplianceRepository } from './modules/compliance/compliance.repository.js';
import { createMysqlNotificationsRepository } from './modules/notifications/notifications.repository.js';
import { createOpenAiMemoryEmbeddingProvider } from './modules/memory/memory-embedding-provider.js';
import { startSearchIndexScheduler } from './modules/reporting/search-index.service.js';
import { createMysqlIdentityRepository } from './modules/identity/identity.repository.js';
import { startAssistantDurableWorker } from './modules/assistant/assistant-durable-worker.js';
import { ODIN_RUN_TYPE } from './modules/channels/odin-channel.service.js';
import { createMysqlAgentChatsRepository } from './modules/assistant/agent-chats.repository.js';
import {
  createMysqlAuthRepository,
  DEMO_PASSWORD,
} from './modules/auth/auth.repository.js';
import {
  createMysqlMetricsRepository,
} from './modules/metrics/metrics.repository.js';
import {
  createMysqlProjectsRepository,
} from './modules/projects/projects.repository.js';
import {
  createMysqlMailRepository,
} from './modules/mail/mail.repository.js';
import {
  createMysqlRankingRepository,
} from './modules/ranking/ranking.repository.js';
import {
  createMysqlWaitlistRepository,
} from './modules/waitlist/waitlist.repository.js';
import {
  createMysqlSessionsRepository,
} from './modules/sessions/sessions.repository.js';
import {
  createMysqlUsersRepository,
} from './modules/users/users.repository.js';
import {
  createMysqlTenantsRepository,
} from './modules/tenants/tenants.repository.js';
import { createMysqlJoinRequestsRepository } from './modules/tenants/join-requests.repository.js';
import { createMysqlEmailChangeRepository } from './modules/users/email-change.js';
import { createMysqlGovernanceRepository } from './modules/governance/governance.repository.js';
import { createMysqlPortfolioRepository } from './modules/portfolio/portfolio.repository.js';
import { createMysqlResourceFinanceRepository } from './modules/resource-finance/resource-finance.repository.js';
import { createMysqlWorkflowRepository } from './modules/workflows/workflows.repository.js';
import { createMysqlWorkspaceModulesRepository } from './modules/workspace-modules/workspace-modules.repository.js';
import { createMysqlBillingRepository } from './modules/billing/billing.repository.js';
import { createMysqlReportingRepository } from './modules/reporting/reporting.repository.js';
import { createMysqlInsightsRepository } from './modules/insights/insights.repository.js';
import { createMysqlMentionsRepository } from './modules/requirements/mentions/mentions.repository.js';
import { createMysqlPlatformRepository } from './modules/platform/platform.repository.js';
import { createMysqlMcpOAuthRepository } from './mcp/oauth.repository.js';
import { createMysqlConnectorRepository } from './modules/connectors/connector.repository.js';
import { createErpConnectorTransport } from './modules/connectors/connector-erp-transport.js';
import { startConnectorErpWorker } from './modules/connectors/connector-erp-worker.js';
import { startConnectorInboundWorker } from './modules/connectors/connector-inbound-worker.js';
import { createConnectorSyncTransport } from './modules/connectors/connector-sync-transport.js';
import { startConnectorSyncWorker } from './modules/connectors/connector-sync-worker.js';
import { createConnectorErasureTransport } from './modules/connectors/connector-erasure-transport.js';
import { startConnectorErasureWorker } from './modules/connectors/connector-erasure-worker.js';
import { createConnectorCredentialVault, createConnectorOAuthService } from './modules/connectors/connector-oauth.js';
import { createGracefulShutdown } from './lib/operations/graceful-shutdown.js';
import { createMysqlSharedLiveEventRepository } from './lib/events/shared-live-event-repository.js';
import { createMysqlRequirementsRepository } from './modules/requirements/requirements.repository.js';
import { createMysqlAccessRepository } from './modules/access/access.repository.js';
import { createMysqlGuestSessionsRepository } from './modules/guests/guest-sessions.repository.js';
import { createMysqlPackagesRepository } from './modules/requirements/packages/packages.repository.js';
import { createGrantAccessCheck } from './modules/requirements/packages/package-grant-access.js';
import { createMysqlRoundsRepository } from './modules/requirements/rounds/rounds.repository.js';
import { createMysqlSigningRepository } from './modules/signing/signing.repository.js';
import { createMysqlPlansRepository } from './modules/requirements/plans/plans.repository.js';
import { createReviewOriginApp } from './review-origin/app.js';
import { createRequirementsAiService } from './modules/requirements/ai/requirements-ai-service.js';
import { createSharedLiveEventBus } from './lib/events/shared-live-event-bus.js';

const env = loadEnv();
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const defaultVaultStoragePath = path.resolve(currentDir, '../.data/vault');
const defaultAvatarStoragePath = path.resolve(currentDir, '../.data/images/users');
const defaultReviewPackageStoragePath = path.resolve(currentDir, '../.data/review-packages');
if (!env.databaseUrl) {
  throw new Error('DATABASE_URL is required. The backend no longer supports in-memory repositories at runtime.');
}
const pool = createMysqlPool(env.databaseUrl);
// Only migrations create or change schema (npm run job:bootstrap-schema). Report any the
// database lacks, once, and keep running.
await reportPendingMysqlMigrations({ executor: pool, migrations: mysqlMigrationDefinitions() });
const fileStorage = createApplicationObjectStorage(env, {
  localRoot: env.vaultStoragePath || defaultVaultStoragePath,
  namespace: 'vault',
});
const avatarStorage = createApplicationObjectStorage(env, {
  localRoot: env.avatarStoragePath || defaultAvatarStoragePath,
  namespace: 'avatars',
});
const reviewPackageStorage = createApplicationObjectStorage(env, {
  localRoot: defaultReviewPackageStoragePath,
  namespace: 'review-packages',
});
if (env.objectStorageProvider === 's3') {
  await fileStorage.verify();
}
const fileScanner = (() => {
  const enabled = Boolean(env.clamavEnabled || env.clamavHost || env.clamavSocketPath);

  if (!enabled) {
    // Development and tests: every file passes once it is read and hashed.
    console.warn('ClamAV is not configured (CLAMAV_ENABLED, CLAMAV_HOST or CLAMAV_SOCKET_PATH), so uploaded files are marked clean without a virus scan.');
    return createNoopFileScanner();
  }

  return createClamAvFileScanner({
    host: env.clamavHost || '127.0.0.1',
    port: env.clamavPort || 3310,
    socketPath: env.clamavSocketPath || '',
    streamResponseTimeoutMs: env.clamavStreamTimeoutMs,
    timeoutMs: env.clamavTimeoutMs || 30_000,
  });
})();
const fileTransferSigner = createTransferSigner(env.fileTransferSecret);
// Office previews. Without LibreOffice installed, Office files get no preview.
const sofficeConverter = createSofficeConverter({ sofficePath: env.previewSofficePath, timeoutMs: env.previewTimeoutMs });
const tokenService = createTokenService({
  issuer: env.jwtIssuer,
  secret: env.jwtSecret,
});
const googleOAuthClient = createGoogleOAuthClient({
  clientId: env.googleOauthClientId,
  clientSecret: env.googleOauthClientSecret,
  redirectUri: env.googleOauthRedirectUri,
});
const signupCaptcha = createRecaptchaVerifier({ secretKey: env.recaptchaSecretKey, siteKey: env.recaptchaSiteKey })
  ?? (env.nodeEnv === 'production' ? createUnavailableRecaptchaVerifier() : null);
const auditWriter = createAuditWriter({ executor: pool });
const waitlistRepository = createMysqlWaitlistRepository({ pool });
const sessionsRepository = createMysqlSessionsRepository({ pool });
const assistantRepository = createMysqlAssistantRepository({ pool });
const agentExecutionRepository = createMysqlAgentExecutionRepository({ pool });
const agentMemoryRepository = createMysqlAgentMemoryRepository({ pool });
const domainEventOutboxRepository = createMysqlDomainEventOutboxRepository({ pool });
const authRepository = createMysqlAuthRepository({ pool });
const usersRepository = createMysqlUsersRepository({ avatarStorage, pool });
const tenantsRepository = createMysqlTenantsRepository({ pool });
const joinRequestsRepository = createMysqlJoinRequestsRepository({ pool });
const emailChangeRepository = createMysqlEmailChangeRepository({ pool });
const mailRepository = createMysqlMailRepository({ pool });
const projectRepository = createMysqlProjectsRepository({
  fileScanner,
  fileStorage,
  frontendAppUrl: env.frontendAppUrl,
  mailRepository,
  pool,
});
const rankingRepository = createMysqlRankingRepository({ pool });
const metricsRepository = createMysqlMetricsRepository({ pool });
const governanceRepository = createMysqlGovernanceRepository({ pool });
const portfolioRepository = createMysqlPortfolioRepository({ pool });
const resourceFinanceRepository = createMysqlResourceFinanceRepository({ pool });
const workflowRepository = createMysqlWorkflowRepository({ pool });
const workspaceModulesRepository = createMysqlWorkspaceModulesRepository({ pool });
const billingRepository = createMysqlBillingRepository({ pool });
const reportingRepository = createMysqlReportingRepository({ pool });
const insightsRepository = createMysqlInsightsRepository({ pool });
const mentionsRepository = createMysqlMentionsRepository({ pool });
const identityRepository = createMysqlIdentityRepository({ pool });
const platformRepository = createMysqlPlatformRepository({ pool });
const connectorRepository = createMysqlConnectorRepository({ pool });
const connectorCredentialVault = createConnectorCredentialVault({ encryptionKey: env.connectorCredentialEncryptionKey, repository: connectorRepository });
const connectorOAuthService = createConnectorOAuthService({ backendPublicUrl: env.backendPublicUrl, credentialVault: connectorCredentialVault, repository: connectorRepository });
const complianceRepository = createMysqlComplianceRepository({ pool });
const requirementsRepository = createMysqlRequirementsRepository({ pool });
const packagesRepository = createMysqlPackagesRepository({ pool });
const roundsRepository = createMysqlRoundsRepository({ pool });
const signingRepository = createMysqlSigningRepository({ pool });
const plansRepository = createMysqlPlansRepository({ pool });
const requirementsAiService = createRequirementsAiService({
  capabilityDefaults: {
    requirementsSummary: { model: env.requirementsSummaryModel, reasoningEffort: env.requirementsSummaryReasoningEffort },
  },
  defaultApiKey: env.openAiApiKey,
  defaultModel: env.openAiModel || 'gpt-6-luna',
  nodeEnv: env.nodeEnv,
  provider: env.requirementsAiProvider,
  tenantsRepository,
});
const sharedLiveEventRepository = createMysqlSharedLiveEventRepository({ pool });
const resolveTenantOpenAiKey = async (tenantId) => { const config = await tenantsRepository.getOpenAiConfig?.({ tenantId }); return config?.valid_config ? config.openai_key : ''; };
const memoryEmbeddingProvider = createOpenAiMemoryEmbeddingProvider({
  apiKey: env.openAiApiKey, dimensions: env.openAiMemoryEmbeddingDimensions, model: env.openAiMemoryEmbeddingModel,
  resolveApiKey: resolveTenantOpenAiKey,
});
// The search index embeds with its own model and size (docs/semantic-search/plan.md).
const searchEmbeddingProvider = createOpenAiMemoryEmbeddingProvider({
  apiKey: env.openAiApiKey, dimensions: env.searchEmbeddingDimensions, model: env.searchEmbeddingModel,
  resolveApiKey: resolveTenantOpenAiKey,
});
const liveEventBus = createSharedLiveEventBus({ repository: sharedLiveEventRepository });
let assistantDurableWorker = null;
let connectorInboundWorker = null;
let connectorErpWorker = null;
let connectorSyncWorker = null;
let connectorErasureWorker = null;
let fileScanWorker = null;
let filePreviewWorker = null;

// Opt-in (SEED_DEMO_USER=true), and never in production: the demo password is public.
if (env.seedDemoUser) {
  const demoBootstrap = await ensureDevelopmentDemoUser(authRepository);
  if (demoBootstrap.created) {
    console.warn(`Seeded development demo login at ${demoBootstrap.user?.email ?? 'demo@odinpmp.local'} / ${DEMO_PASSWORD}`);
  }
}

const projectAiService = createTenantAwareProjectAiService({
  defaultApiKey: env.openAiApiKey,
  defaultModel: env.openAiModel || 'gpt-6-luna',
  tenantsRepository,
});
const app = createApp({
  accessRepository: createMysqlAccessRepository({ pool }),
  guestSessionsRepository: createMysqlGuestSessionsRepository({ pool }),
  agentExecutionRepository,
  agentMemoryRepository,
  domainEventOutboxRepository,
  auditWriter,
  agentChatsRepository: createMysqlAgentChatsRepository({ pool }),
  assistantAgent: env.assistantAgent,
  assistantRepository,
  openAiApiKey: env.openAiApiKey,
  port: env.port,
  assistantTurnRunTimeoutMs: env.assistantTurnTimeoutMs,
  defaultOpenAiModel: env.openAiModel || 'gpt-6-luna',
  authRepository,
  avatarStorage,
  joinRequestsRepository,
  emailChangeRepository,
  backendPublicUrl: env.backendPublicUrl,
  mcpPublicUrl: env.mcpPublicUrl,
  mcpAllowedOrigins: env.mcpAllowedOrigins,
  mcpOAuthRepository: createMysqlMcpOAuthRepository(pool),
  corsAllowedOrigins: env.corsAllowedOrigins,
  connectorRepository,
  connectorOAuthService,
  complianceRepository,
  frontendAppUrl: env.frontendAppUrl,
  filePreviews: { available: () => sofficeConverter.available() },
  fileScanner,
  fileStorage,
  fileTransferPublicUrl: env.backendPublicUrl,
  fileTransferSigner,
  fileUploadMaxBytes: env.fileUploadMaxBytes,
  previewMaxBytes: env.previewMaxBytes,
  googleOAuthClient,
  governanceRepository,
  signupCaptcha,
  bugReporterEmailReplies: env.bugReporterEmailReplies,
  clarificationDigestQuietMinutes: env.clarificationDigestQuietMinutes,
  inboundMailWebhookSecret: env.inboundMailWebhookSecret,
  jsonBodyLimitBytes: env.jsonBodyLimitBytes,
  mailReplyDomain: env.mailReplyDomain,
  mailRepository,
  memoryEmbeddingProvider,
  searchEmbeddingProvider,
  ...(env.searchSemanticMinSimilarity != null ? { searchSemanticFloor: env.searchSemanticMinSimilarity } : {}),
  metricsRepository,
  projectAiService,
  projectRepository,
  portfolioRepository,
  resourceFinanceRepository,
  workflowRepository,
  workspaceModulesRepository,
  billingRepository,
  invoiceGenBaseUrl: env.invoiceGenBaseUrl,
  reportingRepository,
  insightsRepository,
  mentionsRepository,
  identityRepository,
  liveEventBus,
  notificationsRepository: createMysqlNotificationsRepository({ pool }),
  platformRepository,
  readinessChecks: {
    assistantWorker: async () => { if (!assistantDurableWorker?.isHealthy()) throw new Error('assistant worker is not running'); },
    connectorWorker: async () => { if (!connectorInboundWorker?.isHealthy() || !connectorErpWorker?.isHealthy() || !connectorSyncWorker?.isHealthy() || !connectorErasureWorker?.isHealthy()) throw new Error('connector worker is not running'); },
    // Files wait as "Scanning" while ClamAV is down; after an hour of that the scanner is degraded.
    fileScanner: async () => { if (!fileScanWorker?.isHealthy()) throw new Error('file scan worker is not running'); if (fileScanWorker.isDegraded()) throw new Error('ClamAV has been unreachable for over an hour while files wait for a scan'); },
    database: async () => { await pool.query('SELECT 1'); },
    liveEventRelay: async () => { await liveEventBus.ready; },
  },
  slo: { errorRatePercent: env.sloErrorRatePercent, p95LatencyMs: env.sloP95LatencyMs },
  rankingRepository,
  requirementsAiService,
  requirementsRepository,
  packagesRepository,
  plansRepository,
  roundsRepository,
  signingRepository,
  signingSealKey: env.signingSealKey,
  signingSealKeyId: env.signingSealKeyId,
  signingSealKeysPrevious: env.signingSealKeysPrevious,
  nodeEnv: env.nodeEnv,
  reviewGrantSecret: env.reviewGrantSecret,
  reviewPackageMaxBytes: env.reviewPackageMaxBytes,
  reviewPackageStorage,
  reviewPublicUrl: env.reviewPublicUrl,
  sessionsRepository,
  tenantsRepository,
  tokenService,
  trustProxy: env.trustProxy,
  usersRepository,
  waitlistRepository,
  accessRequestNotifyEmails: env.accessRequestNotifyEmails,
  webhookSigningMasterSecret: env.webhookSigningMasterSecret,
  webPush: env.webPush,
});

assistantDurableWorker = startAssistantDurableWorker({
  onError(error) {
    console.error('Assistant durable worker poll failed.', error);
  },
  queue: app.locals.assistantTurnQueue,
  runTypes: ['assistant_turn', ODIN_RUN_TYPE],
  // Durable agent goal runs: one assistant turn in a new chat on the goal's project. Odin's
  // replies in channels: one that no process started runs here; one a restart cut off gets a note.
  run: async ({ abortSignal, executionRun, payload }) => {
    if (executionRun?.runType === ODIN_RUN_TYPE) return app.locals.odinChannelService.runDurable({ abortSignal, executionRun, payload });
    const user = await authRepository.findUserById(String(payload?.userId ?? ''));
    if (!user) throw Object.assign(new Error('Goal run user no longer exists.'), { permanent: true });
    // A run that doesn't say whether it may write is read-only (monitors are; runs queued before the flag existed).
    // It searches the web only when the goal allowed it.
    return app.locals.agentChatService.runGoalTurn({
      abortSignal, allowWebResearch: payload?.input?.allowWebResearch === true, message: String(payload?.input?.message ?? ''), projectId: executionRun?.projectId ?? null, readOnly: payload?.input?.readOnly,
      title: String(payload?.input?.title ?? '') || (payload?.trigger?.goalId ? 'Goal run' : ''), user,
    });
  },

});
app.locals.stopAssistantDurableWorker = () => assistantDurableWorker.stop();
connectorInboundWorker = startConnectorInboundWorker({
  onError(error) { console.error('Connector inbound worker poll failed.', error); },
  repository: connectorRepository,
});
app.locals.stopConnectorInboundWorker = () => connectorInboundWorker.stop();
connectorErpWorker = startConnectorErpWorker({
  onError(error) { console.error('Connector ERP worker poll failed.', error); },
  repository: connectorRepository,
  resourceFinanceRepository,
  transport: createErpConnectorTransport({ secretResolver: connectorCredentialVault.resolve }),
});
app.locals.stopConnectorErpWorker = () => connectorErpWorker.stop();
connectorSyncWorker = startConnectorSyncWorker({
  onError(error) { console.error('Connector sync worker poll failed.', error); },
  projectRepository,
  repository: connectorRepository,
  transport: createConnectorSyncTransport({ secretResolver: connectorCredentialVault.resolve }),
});
app.locals.stopConnectorSyncWorker = () => connectorSyncWorker.stop();
connectorErasureWorker = startConnectorErasureWorker({ onError(error) { console.error('Connector erasure worker poll failed.', error); }, repository: connectorRepository, transport: createConnectorErasureTransport({ secretResolver: connectorCredentialVault.resolve }) });
app.locals.stopConnectorErasureWorker = () => connectorErasureWorker.stop();
fileScanWorker = startFileScanWorker({
  largeFileDeps: { fileStorage, projectRepository },
  onError: logFileScanFailure,
  processor: createFileScanProcessor({ frontendAppUrl: env.frontendAppUrl, liveEventBus, mailRepository, projectRepository, scanner: fileScanner, storage: fileStorage }),
});
app.locals.stopFileScanWorker = () => fileScanWorker.stop();
filePreviewWorker = startFilePreviewWorker({
  onError: logFilePreviewFailure,
  processor: createFilePreviewProcessor({ converter: sofficeConverter, liveEventBus, maxBytes: env.previewMaxBytes, projectRepository, storage: fileStorage }),
});
app.locals.stopFilePreviewWorker = () => filePreviewWorker.stop();
// Keeps every workspace's search index current, every minute by default (docs/semantic-search/plan.md).
app.locals.stopSearchIndexScheduler = startSearchIndexScheduler({ intervalMs: env.searchIndexIntervalMs, run: () => app.locals.refreshSearchIndexes() });

if (!env.openAiApiKey) {
  console.warn('OPENAI_API_KEY is not set. Project AI routes will only use OpenAI if a tenant OpenAI config is saved; otherwise they fall back deterministically.');
  console.warn('Assistant workspace turns require a tenant OpenAI key or OPENAI_API_KEY and will fail loudly until one is configured.');
}

const server = app.listen(env.port, () => {
  console.log(`odinpmp-backend listening on http://localhost:${env.port}`);
});

const workerGroup = {
  stop() { assistantDurableWorker.stop(); connectorInboundWorker.stop(); connectorErpWorker.stop(); connectorSyncWorker.stop(); connectorErasureWorker.stop(); fileScanWorker.stop(); filePreviewWorker.stop(); },
  async waitForIdle(options) { const results = await Promise.all([assistantDurableWorker.waitForIdle(options), connectorInboundWorker.waitForIdle(options), connectorErpWorker.waitForIdle(options), connectorSyncWorker.waitForIdle(options), connectorErasureWorker.waitForIdle(options), fileScanWorker.waitForIdle(options), filePreviewWorker.waitForIdle(options)]); return results.every(Boolean); },
};
// The review origin serves package files on its own port and host (REVIEW_PUBLIC_URL).
let reviewServer = null;
if (env.reviewPublicUrl) {
  const reviewApp = createReviewOriginApp({
    publicOrigin: new URL(env.reviewPublicUrl).origin,
    frontendAppUrl: env.frontendAppUrl,
    grantSecret: env.reviewGrantSecret,
    mayViewGrant: createGrantAccessCheck({ assistantRepository, projectRepository, requirementsRepository, roundsRepository }),
    packagesRepository,
    storage: reviewPackageStorage,
  });
  reviewServer = reviewApp.listen(env.reviewPort, () => {
    console.log(`odinpmp review origin listening on http://localhost:${env.reviewPort} for ${env.reviewPublicUrl}`);
  });
}

const shutdown = createGracefulShutdown({ app, pool, server, worker: workerGroup });
process.once('SIGTERM', () => { reviewServer?.close(); void shutdown('SIGTERM'); });
process.once('SIGINT', () => { reviewServer?.close(); void shutdown('SIGINT'); });
