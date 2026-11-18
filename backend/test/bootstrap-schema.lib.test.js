import assert from 'node:assert/strict';
import test from 'node:test';

import { bootstrapMysqlSchema, mysqlMigrationDefinitions } from '../src/jobs/bootstrap-schema.lib.js';
import { migrationChecksum } from '../src/lib/database/schema-migrations.js';

test('bootstrapMysqlSchema runs the schema ensure steps in canonical order', async () => {
  const calls = [];
  const executor = { kind: 'pool' };

  await bootstrapMysqlSchema({
    ensureAgentExecutionSchema: async (value) => {
      calls.push(['agentExecution', value]);
    },
    ensureAgentGoalAutomationSchema: async (value) => {
      calls.push(['agentGoalAutomation', value]);
    },
    ensureAgentGoalNotificationSchema: async (value) => {
      calls.push(['agentGoalNotifications', value]);
    },
    ensureAgentMemorySchema: async (value) => {
      calls.push(['agentMemory', value]);
    },
    ensureAgentMemoryGovernanceSchema: async (value) => {
      calls.push(['agentMemoryGovernance', value]);
    },
    ensureAgentMemorySemanticSchema: async (value) => {
      calls.push(['agentMemorySemantic', value]);
    },
    ensureConnectorSchema: async (value) => {
      calls.push(['connectorPlatform', value]);
    },
    ensureConnectorWorkerSchema: async (value) => {
      calls.push(['connectorWorker', value]);
    },
    ensureConnectorMarketplaceSchema: async (value) => {
      calls.push(['connectorMarketplace', value]);
    },
    ensureConnectorErpPostingSchema: async (value) => {
      calls.push(['connectorErpPosting', value]);
    },
    ensureConnectorSyncWorkerSchema: async (value) => {
      calls.push(['connectorSyncWorker', value]);
    },
    ensureConnectorErasureSchema: async (value) => {
      calls.push(['connectorErasure', value]);
    },
    ensureConnectorOAuthSchema: async (value) => {
      calls.push(['connectorOAuth', value]);
    },
    ensureComplianceSchema: async (value) => {
      calls.push(['compliance', value]);
    },
    ensureComplianceGovernanceSchema: async (value) => {
      calls.push(['complianceGovernance', value]);
    },
    ensurePrivacyErasureSchema: async (value) => {
      calls.push(['privacyErasure', value]);
    },
    ensureDomainEventOutboxSchema: async (value) => {
      calls.push(['domainEventOutbox', value]);
    },
    ensurePortfolioSchema: async (value) => {
      calls.push(['portfolio', value]);
    },
    ensurePortfolioPlanningSchema: async (value) => {
      calls.push(['portfolioPlanning', value]);
    },
    ensureResourceFinanceSchema: async (value) => {
      calls.push(['resourceFinance', value]);
    },
    ensureResourceFinanceAdvancedSchema: async (value) => {
      calls.push(['resourceFinanceAdvanced', value]);
    },
    ensureResourceCalendarRecurrenceSchema: async (value) => {
      calls.push(['resourceCalendarRecurrence', value]);
    },
    ensureResourceFinanceControlsSchema: async (value) => {
      calls.push(['resourceFinanceControls', value]);
    },
    ensureWorkflowSchema: async (value) => {
      calls.push(['workflow', value]);
    },
    ensureReportingSchema: async (value) => {
      calls.push(['reporting', value]);
    },
    ensureReportingWarehouseSchema: async (value) => {
      calls.push(['reportingWarehouse', value]);
    },
    ensureIdentitySchema: async (value) => {
      calls.push(['identity', value]);
    },
    ensureBreakGlassSchema: async (value) => {
      calls.push(['breakGlass', value]);
    },
    ensureAccessReviewCampaignSchema: async (value) => {
      calls.push(['accessReviewCampaigns', value]);
    },
    ensureSamlTransactionSchema: async (value) => {
      calls.push(['samlTransactions', value]);
    },
    ensurePlatformSchema: async (value) => {
      calls.push(['platform', value]);
    },
    ensurePlatformIdempotencySchema: async (value) => {
      calls.push(['platformIdempotency', value]);
    },
    ensurePlatformDelegationSchema: async (value) => {
      calls.push(['platformDelegation', value]);
    },
    ensureSharedLiveEventSchema: async (value) => {
      calls.push(['sharedLiveEvents', value]);
    },
    ensureClarificationSchema: async (value) => {
      calls.push(['clarification', value]);
    },
    ensureMailSchema: async (value) => {
      calls.push(['mail', value]);
    },
    ensureMailDeliverySchema: async (value) => {
      calls.push(['mailDelivery', value]);
    },
    ensureProjectPlanningSchema: async (value) => {
      calls.push(['projectPlanning', value]);
    },
    ensureProjectItemVersioningSchema: async (value) => {
      calls.push(['projectItemVersioning', value]);
    },
    ensureProjectStatuses: async (value) => {
      calls.push(['projectStatuses', value]);
    },
    ensureProjectTaskTypes: async (value) => {
      calls.push(['projectTaskTypes', value]);
    },
    ensureSummarySchema: async (value) => {
      calls.push(['summary', value]);
    },
    ensureGovernanceSchema: async (value) => {
      calls.push(['governance', value]);
    },
    ensureScheduleControlSchema: async (value) => {
      calls.push(['scheduleControl', value]);
    },
    ensureWorkflowAutomationSchema: async (value) => {
      calls.push(['workflowAutomation', value]);
    },
    ensureWorkflowHistorySequenceSchema: async (value) => {
      calls.push(['workflowHistorySequence', value]);
    },
    ensureTicketingSchema: async (value) => {
      calls.push(['ticketing', value]);
    },
    ensureTicketConfigSchema: async (value) => {
      calls.push(['ticketConfigLists', value]);
    },
    ensureTicketIntakeSchema: async (value) => {
      calls.push(['ticketIntake', value]);
    },
    ensureProjectItemProgressSchema: async (value) => {
      calls.push(['projectItemProgress', value]);
    },
    ensureProjectItemActualHoursSchema: async (value) => {
      calls.push(['projectItemActualHours', value]);
    },
    ensureAuditLogActorSchema: async (value) => {
      calls.push(['auditLogActor', value]);
    },
    ensureProjectItemEstimateOverrideSchema: async (value) => {
      calls.push(['projectItemEstimateOverride', value]);
    },
    ensureRequirementsTracksSchema: async (value) => {
      calls.push(['requirementsTracks', value]);
    },
    ensureRequirementsLinksSchema: async (value) => {
      calls.push(['requirementsLinks', value]);
    },
    ensureReviewPackagesSchema: async (value) => {
      calls.push(['reviewPackages', value]);
    },
    ensureReviewRoundsSchema: async (value) => {
      calls.push(['reviewRounds', value]);
    },
    ensureReviewFeedbackSchema: async (value) => {
      calls.push(['reviewFeedback', value]);
    },
    ensureRequirementsDecisionsSchema: async (value) => {
      calls.push(['requirementsDecisions', value]);
    },
    ensureReviewPackageStorageSchema: async (value) => {
      calls.push(['reviewPackageStorage', value]);
    },
    ensureReviewRoundDetailsSchema: async (value) => {
      calls.push(['reviewRoundDetails', value]);
    },
    ensureRequirementsPlanDetailsSchema: async (value) => {
      calls.push(['requirementsPlanDetails', value]);
    },
    backfillClarificationTopics: async (value) => {
      calls.push(['clarificationTopicsBackfill', value]);
    },
    ensureReviewPackageReplacementSchema: async (value) => {
      calls.push(['reviewPackageReplacement', value]);
    },
    ensureTicketReopenSchema: async (value) => {
      calls.push(['ticketReopen', value]);
    },
    ensureProjectSoftDeleteSchema: async (value) => {
      calls.push(['projectSoftDelete', value]);
    },
    ensureMetricsSchema: async (value) => {
      calls.push(['contributorMetrics', value]);
    },
    ensureJoinRequestSchema: async (value) => {
      calls.push(['workspaceJoinRequests', value]);
    },
    ensureInsightsSchema: async (value) => {
      calls.push(['projectInsightsLayouts', value]);
    },
    ensureMentionsSchema: async (value) => {
      calls.push(['requirementsMentions', value]);
    },
    ensureWaitlistSchema: async (value) => {
      calls.push(['waitlistSignups', value]);
    },
    ensureMentionReasonSchema: async (value) => {
      calls.push(['requirementsMentionReasons', value]);
    },
    ensureAgentMonitorEditorSchema: async (value) => {
      calls.push(['agentMonitorEditor', value]);
    },
    ensureAccessLinksSchema: async (value) => {
      calls.push(['accessLinks', value]);
    },
    ensureProjectTaskAccessSchema: async (value) => {
      calls.push(['projectTaskAccess', value]);
    },
    ensureResourceEmailSchema: async (value) => {
      calls.push(['resourceEmail', value]);
    },
    ensureProjectItemRemainingHoursSchema: async (value) => {
      calls.push(['projectItemRemainingHours', value]);
    },
    ensureProjectItemRevisionActorSchema: async (value) => {
      calls.push(['projectItemRevisionActor', value]);
    },
    ensureCommentActorSchema: async (value) => {
      calls.push(['commentActor', value]);
    },
    ensureAuthenticationMethods: async (value) => {
      calls.push(['authenticationMethods', value]);
    },
    ensurePendingRegistrationsSchema: async (value) => {
      calls.push(['pendingRegistrations', value]);
    },
    ensureMcpOAuthSchema: async (value) => {
      calls.push(['mcpOAuth', value]);
    },
    ensureResourceLinkSchema: async (value) => {
      calls.push(['resourceLinks', value]);
    },
    ensureBugReporterMailSchema: async (value) => {
      calls.push(['bugReporterMailDeliveries', value]);
    },
    ensureBugReporterReplySchema: async (value) => {
      calls.push(['bugReporterReplies', value]);
    },
    ensureProjectChangeLogSchema: async (value) => {
      calls.push(['projectChangeLog', value]);
    },
    ensureProjectChangeLogRelatedColumns: async (value) => {
      calls.push(['projectChangeLogRelated', value]);
    },
    ensureItemChangeRequestsSchema: async (value) => {
      calls.push(['itemChangeRequests', value]);
    },
    ensureFileVersionsAndLinksSchema: async (value) => {
      calls.push(['fileVersionsAndLinks', value]);
    },
    ensureDocumentSigningSchema: async (value) => {
      calls.push(['documentSigning', value]);
    },
    ensureEngagementsSchema: async (value) => {
      calls.push(['engagements', value]);
    },
    ensureChannelsSchema: async (value) => {
      calls.push(['channels', value]);
    },
    ensureLargeFilesSchema: async (value) => {
      calls.push(['largeFiles', value]);
    },
    ensureBillingSchema: async (value) => {
      calls.push(['billing', value]);
    },
    ensureGuestSessionsSchema: async (value) => {
      calls.push(['guestSessions', value]);
    },
    ensurePursuitSchema: async (value) => {
      calls.push(['pursuit', value]);
    },
    ensureOdinRepliesSchema: async (value) => {
      calls.push(['odinReplies', value]);
    },
    ensureNotificationsSchema: async (value) => {
      calls.push(['notifications', value]);
    },
    ensureDirectMessagesSchema: async (value) => {
      calls.push(['directMessages', value]);
    },
    ensureRefreshGraceSchema: async (value) => {
      calls.push(['refreshGrace', value]);
    },
    ensureChannelOdinSchema: async (value) => {
      calls.push(['channelOdin', value]);
    },
    ensurePostReactionsSchema: async (value) => {
      calls.push(['postReactions', value]);
    },
    ensurePostReplyToSchema: async (value) => {
      calls.push(['postReplyTo', value]);
    },
    ensurePollsSchema: async (value) => {
      calls.push(['polls', value]);
    },
    ensureSemanticSearchSchema: async (value) => {
      calls.push(['semanticSearch', value]);
    },
    ensureEmailChangeSchema: async (value) => {
      calls.push(['emailChange', value]);
    },
    runMigrations: async ({ executor: actualExecutor, migrations }) => {
      assert.equal(actualExecutor, executor);
      for (const migration of migrations) await migration.up(executor);
      return { applied: migrations.map((migration) => migration.id), total: migrations.length };
    },
    executor,
  });

  assert.deepEqual(
    calls.map(([name]) => name),
    [
      'agentExecution',
      'mail',
      'clarification',
      'projectPlanning',
      'projectStatuses',
      'projectTaskTypes',
      'summary',
      'governance',
      'agentGoalAutomation',
      'agentGoalNotifications',
      'agentMemory',
      'domainEventOutbox',
      'agentMemoryGovernance',
      'portfolio',
      'resourceFinance',
      'workflow',
      'reporting',
      'identity',
      'platform',
      'sharedLiveEvents',
      'breakGlass',
      'accessReviewCampaigns',
      'samlTransactions',
      'projectItemVersioning',
      'scheduleControl',
      'workflowAutomation',
      'mailDelivery',
      'resourceFinanceAdvanced',
      'portfolioPlanning',
      'agentMemorySemantic',
      'connectorPlatform',
      'workflowHistorySequence',
      'resourceCalendarRecurrence',
      'resourceFinanceControls',
      'platformIdempotency',
      'connectorWorker',
      'platformDelegation',
      'connectorMarketplace',
      'compliance',
      'privacyErasure',
      'reportingWarehouse',
      'connectorErpPosting',
      'connectorSyncWorker',
      'complianceGovernance',
      'connectorErasure',
      'connectorOAuth',
      'ticketing',
      'ticketConfigLists',
      'ticketIntake',
      'projectItemProgress',
      'requirementsTracks',
      'requirementsLinks',
      'reviewPackages',
      'reviewRounds',
      'reviewFeedback',
      'requirementsDecisions',
      'reviewPackageStorage',
      'projectItemActualHours',
      'auditLogActor',
      'projectItemEstimateOverride',
      'reviewRoundDetails',
      'requirementsPlanDetails',
      'clarificationTopicsBackfill',
      'reviewPackageReplacement',
      'ticketReopen',
      'projectSoftDelete',
      'contributorMetrics',
      'workspaceJoinRequests',
      'projectInsightsLayouts',
      'requirementsMentions',
      'waitlistSignups',
      'requirementsMentionReasons',
      'agentMonitorEditor',
      'accessLinks',
      'projectTaskAccess',
      'resourceEmail',
      'projectItemRemainingHours',
      'projectItemRevisionActor',
      'commentActor',
      'authenticationMethods',
      'pendingRegistrations',
      'mcpOAuth',
      'resourceLinks',
      'bugReporterMailDeliveries',
      'bugReporterReplies',
      'projectChangeLog',
      'projectChangeLogRelated',
      'itemChangeRequests',
      'fileVersionsAndLinks',
      'documentSigning',
      'engagements',
      'channels',
      'largeFiles',
      'guestSessions',
      'billing',
      'pursuit',
      'odinReplies',
      'notifications',
      'directMessages',
      'refreshGrace',
      'channelOdin',
      'postReactions',
      'postReplyTo',
      'polls',
      'semanticSearch',
      'emailChange',
    ],
  );
  assert.ok(calls.every(([, value]) => value === executor));
});

test('mysqlMigrationDefinitions lists, without running them, the migrations bootstrapMysqlSchema runs', async () => {
  const definitions = mysqlMigrationDefinitions();
  let run = null;
  await bootstrapMysqlSchema({ executor: {}, runMigrations: async ({ migrations }) => { run = migrations; return {}; } });
  assert.deepEqual(run.map((migration) => [migration.id, migrationChecksum(migration)]), definitions.map((migration) => [migration.id, migrationChecksum(migration)]));
  const ids = definitions.map((migration) => migration.id);
  assert.deepEqual(ids, [...ids].sort(), 'ids run in order');
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  assert.ok(definitions.every((migration) => migration.version === 1 && typeof migration.up === 'function'));
});
