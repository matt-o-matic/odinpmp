import { ensureMysqlAccessLinksSchema, ensureMysqlProjectTaskAccessSchema } from '../modules/access/access.repository.js';
import { ensureMysqlClarificationSchema } from '../modules/assistant/assistant.repository.js';
import { ensureMysqlAgentExecutionSchema, ensureMysqlAgentGoalAutomationSchema, ensureMysqlAgentGoalNotificationSchema, ensureMysqlAgentMonitorEditorSchema } from '../modules/assistant/agent-execution.repository.js';
import { ensureMysqlMailDeliverySchema, ensureMysqlMailSchema } from '../modules/mail/mail.repository.js';
import {
  ensureMysqlCommentActorSchema,
  ensureMysqlProjectPlanningSchema,
  ensureMysqlProjectItemActualHoursSchema,
  ensureMysqlProjectItemEstimateOverrideSchema,
  ensureMysqlProjectItemProgressSchema,
  ensureMysqlProjectItemRemainingHoursSchema,
  ensureMysqlProjectItemRevisionActorSchema,
  ensureMysqlProjectItemVersioningSchema,
  ensureMysqlProjectStatuses,
  ensureMysqlProjectTaskTypes,
  ensureMysqlTicketConfigSchema,
  ensureMysqlTicketIntakeSchema,
  ensureMysqlTicketingSchema,
} from '../modules/projects/projects.repository.js';
import { ensureMysqlTicketReopenSchema } from '../modules/projects/ticket-reopen.schema.js';
import { ensureMysqlProjectSoftDeleteSchema } from '../modules/projects/project-deletion.repository.js';
import { ensureMysqlSummarySchema } from '../modules/summaries/summaries.repository.js';
import { ensureMysqlAuditLogActorSchema } from '../lib/audit/audit-writer.js';
import { runMysqlMigrations } from '../lib/database/schema-migrations.js';
import { ensureMysqlGovernanceSchema, ensureMysqlScheduleControlSchema } from '../modules/governance/governance.repository.js';
import { ensureMysqlAgentMemoryGovernanceSchema, ensureMysqlAgentMemorySchema, ensureMysqlAgentMemorySemanticSchema } from '../modules/memory/agent-memory.repository.js';
import { ensureMysqlDomainEventOutboxSchema } from '../lib/events/domain-event-outbox.js';
import { ensureMysqlPortfolioPlanningSchema, ensureMysqlPortfolioSchema } from '../modules/portfolio/portfolio.repository.js';
import { ensureMysqlResourceCalendarRecurrenceSchema, ensureMysqlResourceEmailSchema, ensureMysqlResourceFinanceAdvancedSchema, ensureMysqlResourceFinanceControlsSchema, ensureMysqlResourceFinanceSchema, ensureMysqlResourceLinkSchema } from '../modules/resource-finance/resource-finance.repository.js';
import { ensureMysqlWorkflowAutomationSchema, ensureMysqlWorkflowHistorySequenceSchema, ensureMysqlWorkflowSchema } from '../modules/workflows/workflows.repository.js';
import { ensureMysqlReportingSchema } from '../modules/reporting/reporting.repository.js';
import { ensureMysqlReportingWarehouseSchema } from '../modules/reporting/reporting-warehouse.repository.js';
import { ensureMysqlAccessReviewCampaignSchema, ensureMysqlBreakGlassSchema, ensureMysqlIdentitySchema, ensureMysqlSamlTransactionSchema } from '../modules/identity/identity.repository.js';
import { ensureMysqlPlatformDelegationSchema, ensureMysqlPlatformIdempotencySchema, ensureMysqlPlatformSchema } from '../modules/platform/platform.repository.js';
import { ensureMysqlSharedLiveEventSchema } from '../lib/events/shared-live-event-repository.js';
import { ensureMysqlConnectorErasureSchema, ensureMysqlConnectorErpPostingSchema, ensureMysqlConnectorMarketplaceSchema, ensureMysqlConnectorOAuthSchema, ensureMysqlConnectorSchema, ensureMysqlConnectorSyncWorkerSchema, ensureMysqlConnectorWorkerSchema } from '../modules/connectors/connector.repository.js';
import { ensureMysqlComplianceGovernanceSchema, ensureMysqlComplianceSchema, ensureMysqlPrivacyErasureSchema } from '../modules/compliance/compliance.repository.js';
import {
  backfillMysqlClarificationTopics,
  ensureMysqlRequirementsDecisionsSchema,
  ensureMysqlRequirementsLinksSchema,
  ensureMysqlRequirementsTracksSchema,
  ensureMysqlReviewFeedbackSchema,
  ensureMysqlReviewPackagesSchema,
  ensureMysqlReviewRoundsSchema,
} from '../modules/requirements/requirements.repository.js';
import { ensureMysqlReviewPackageReplacementSchema, ensureMysqlReviewPackageStorageSchema } from '../modules/requirements/packages/packages.repository.js';
import { ensureMysqlReviewRoundDetailsSchema } from '../modules/requirements/rounds/rounds.repository.js';
import { ensureMysqlRequirementsPlanDetailsSchema } from '../modules/requirements/plans/plans.repository.js';
import { ensureMysqlMetricsSchema } from '../modules/metrics/metrics.repository.js';
import { ensureMysqlJoinRequestSchema } from '../modules/tenants/join-requests.repository.js';
import { ensureMysqlInsightsSchema } from '../modules/insights/insights.repository.js';
import { ensureMysqlMentionReasonSchema, ensureMysqlMentionsSchema } from '../modules/requirements/mentions/mentions.repository.js';
import { ensureMysqlWaitlistSchema } from '../modules/waitlist/waitlist.repository.js';
import { ensureMysqlAuthenticationMethods, ensureMysqlPendingRegistrationsSchema } from '../modules/auth/auth.repository.js';
import { ensureMysqlMcpOAuthSchema } from '../mcp/oauth.repository.js';
import { ensureMysqlBugReporterMailSchema } from '../modules/bug-reporter/bug-reporter.mail-repository.js';
import { ensureMysqlBugReporterReplySchema } from '../modules/bug-reporter/bug-reporter.replies-repository.js';
import { ensureMysqlItemChangeRequestsSchema } from '../modules/changes/item-change-requests.js';
import { ensureMysqlProjectChangeLogRelatedColumns, ensureMysqlProjectChangeLogSchema } from '../modules/changes/project-change-log.js';
import { ensureMysqlFileVersionsAndLinksSchema } from '../modules/vault/vault-schema.js';
import { ensureMysqlDocumentSigningSchema } from '../modules/signing/signing-schema.js';
import { ensureMysqlEngagementsSchema } from '../modules/engagements/engagements-schema.js';
import { ensureMysqlChannelsSchema } from '../modules/channels/channels-schema.js';
import { ensureMysqlOdinRepliesSchema } from '../modules/channels/odin-replies-schema.js';
import { ensureMysqlLargeFilesSchema } from '../modules/vault/large-files-schema.js';
import { ensureMysqlBillingSchema } from '../modules/billing/billing-schema.js';
import { ensureMysqlGuestSessionsSchema } from '../modules/guests/guest-sessions-schema.js';
import { ensureMysqlPursuitSchema } from '../modules/pursuit/pursuit-schema.js';
import { ensureMysqlNotificationsSchema } from '../modules/notifications/notifications-schema.js';
import { ensureMysqlDirectMessagesSchema } from '../modules/chat/direct-messages-schema.js';
import { ensureMysqlRefreshGraceSchema } from '../modules/sessions/refresh-grace-schema.js';
import { ensureMysqlChannelOdinSchema } from '../modules/channels/channel-odin-schema.js';
import { ensureMysqlPostReactionsSchema } from '../modules/channels/post-reactions-schema.js';
import { ensureMysqlPostReplyToSchema } from '../modules/channels/post-reply-to-schema.js';
import { ensureMysqlPollsSchema } from '../modules/channels/polls-schema.js';
import { ensureMysqlSemanticSearchSchema } from '../modules/reporting/search-index.repository.js';
import { ensureMysqlEmailChangeSchema } from '../modules/users/email-change.js';

/**
 * The registered migrations, in the order they run. Schema is created and changed only here:
 * request code assumes every migration has run. Each `up` can be replaced, for tests.
 *
 * The runner checksums each migration's id, description, version and `up` source, and refuses
 * a recorded migration whose checksum changed: never edit a registered migration or the body
 * of its `up`; add a new migration instead.
 */
export function mysqlMigrationDefinitions({
  ensureClarificationSchema = ensureMysqlClarificationSchema,
  ensureAgentExecutionSchema = ensureMysqlAgentExecutionSchema,
  ensureAgentGoalAutomationSchema = ensureMysqlAgentGoalAutomationSchema,
  ensureAgentGoalNotificationSchema = ensureMysqlAgentGoalNotificationSchema,
  ensureAgentMemorySchema = ensureMysqlAgentMemorySchema,
  ensureAgentMemoryGovernanceSchema = ensureMysqlAgentMemoryGovernanceSchema,
  ensureAgentMemorySemanticSchema = ensureMysqlAgentMemorySemanticSchema,
  ensureDomainEventOutboxSchema = ensureMysqlDomainEventOutboxSchema,
  ensurePortfolioSchema = ensureMysqlPortfolioSchema,
  ensurePortfolioPlanningSchema = ensureMysqlPortfolioPlanningSchema,
  ensureResourceFinanceSchema = ensureMysqlResourceFinanceSchema,
  ensureResourceFinanceAdvancedSchema = ensureMysqlResourceFinanceAdvancedSchema,
  ensureResourceCalendarRecurrenceSchema = ensureMysqlResourceCalendarRecurrenceSchema,
  ensureResourceFinanceControlsSchema = ensureMysqlResourceFinanceControlsSchema,
  ensureWorkflowSchema = ensureMysqlWorkflowSchema,
  ensureWorkflowAutomationSchema = ensureMysqlWorkflowAutomationSchema,
  ensureWorkflowHistorySequenceSchema = ensureMysqlWorkflowHistorySequenceSchema,
  ensureReportingSchema = ensureMysqlReportingSchema,
  ensureReportingWarehouseSchema = ensureMysqlReportingWarehouseSchema,
  ensureIdentitySchema = ensureMysqlIdentitySchema,
  ensureBreakGlassSchema = ensureMysqlBreakGlassSchema,
  ensureAccessReviewCampaignSchema = ensureMysqlAccessReviewCampaignSchema,
  ensureSamlTransactionSchema = ensureMysqlSamlTransactionSchema,
  ensurePlatformSchema = ensureMysqlPlatformSchema,
  ensurePlatformIdempotencySchema = ensureMysqlPlatformIdempotencySchema,
  ensurePlatformDelegationSchema = ensureMysqlPlatformDelegationSchema,
  ensureSharedLiveEventSchema = ensureMysqlSharedLiveEventSchema,
  ensureConnectorSchema = ensureMysqlConnectorSchema,
  ensureConnectorWorkerSchema = ensureMysqlConnectorWorkerSchema,
  ensureConnectorMarketplaceSchema = ensureMysqlConnectorMarketplaceSchema,
  ensureConnectorErpPostingSchema = ensureMysqlConnectorErpPostingSchema,
  ensureConnectorSyncWorkerSchema = ensureMysqlConnectorSyncWorkerSchema,
  ensureConnectorErasureSchema = ensureMysqlConnectorErasureSchema,
  ensureConnectorOAuthSchema = ensureMysqlConnectorOAuthSchema,
  ensureComplianceSchema = ensureMysqlComplianceSchema,
  ensurePrivacyErasureSchema = ensureMysqlPrivacyErasureSchema,
  ensureComplianceGovernanceSchema = ensureMysqlComplianceGovernanceSchema,
  ensureMailSchema = ensureMysqlMailSchema,
  ensureMailDeliverySchema = ensureMysqlMailDeliverySchema,
  ensureProjectPlanningSchema: ensureProjectPlanning = ensureMysqlProjectPlanningSchema,
  ensureProjectItemVersioningSchema: ensureProjectItemVersioning = ensureMysqlProjectItemVersioningSchema,
  ensureProjectItemProgressSchema = ensureMysqlProjectItemProgressSchema,
  ensureProjectItemActualHoursSchema = ensureMysqlProjectItemActualHoursSchema,
  ensureAuditLogActorSchema = ensureMysqlAuditLogActorSchema,
  ensureProjectItemEstimateOverrideSchema = ensureMysqlProjectItemEstimateOverrideSchema,
  ensureProjectStatuses = ensureMysqlProjectStatuses,
  ensureProjectTaskTypes = ensureMysqlProjectTaskTypes,
  ensureSummarySchema = ensureMysqlSummarySchema,
  ensureGovernanceSchema = ensureMysqlGovernanceSchema,
  ensureScheduleControlSchema = ensureMysqlScheduleControlSchema,
  ensureTicketingSchema = ensureMysqlTicketingSchema,
  ensureTicketConfigSchema = ensureMysqlTicketConfigSchema,
  ensureTicketIntakeSchema = ensureMysqlTicketIntakeSchema,
  ensureRequirementsTracksSchema = ensureMysqlRequirementsTracksSchema,
  ensureRequirementsLinksSchema = ensureMysqlRequirementsLinksSchema,
  ensureReviewPackagesSchema = ensureMysqlReviewPackagesSchema,
  ensureReviewRoundsSchema = ensureMysqlReviewRoundsSchema,
  ensureReviewFeedbackSchema = ensureMysqlReviewFeedbackSchema,
  ensureRequirementsDecisionsSchema = ensureMysqlRequirementsDecisionsSchema,
  ensureReviewPackageStorageSchema = ensureMysqlReviewPackageStorageSchema,
  ensureReviewRoundDetailsSchema = ensureMysqlReviewRoundDetailsSchema,
  ensureRequirementsPlanDetailsSchema = ensureMysqlRequirementsPlanDetailsSchema,
  backfillClarificationTopics = backfillMysqlClarificationTopics,
  ensureReviewPackageReplacementSchema = ensureMysqlReviewPackageReplacementSchema,
  ensureTicketReopenSchema = ensureMysqlTicketReopenSchema,
  ensureProjectSoftDeleteSchema = ensureMysqlProjectSoftDeleteSchema,
  ensureMetricsSchema = ensureMysqlMetricsSchema,
  ensureJoinRequestSchema = ensureMysqlJoinRequestSchema,
  ensureInsightsSchema = ensureMysqlInsightsSchema,
  ensureMentionsSchema = ensureMysqlMentionsSchema,
  ensureWaitlistSchema = ensureMysqlWaitlistSchema,
  ensureMentionReasonSchema = ensureMysqlMentionReasonSchema,
  ensureAgentMonitorEditorSchema = ensureMysqlAgentMonitorEditorSchema,
  ensureAccessLinksSchema = ensureMysqlAccessLinksSchema,
  ensureProjectTaskAccessSchema = ensureMysqlProjectTaskAccessSchema,
  ensureResourceEmailSchema = ensureMysqlResourceEmailSchema,
  ensureProjectItemRemainingHoursSchema = ensureMysqlProjectItemRemainingHoursSchema,
  ensureProjectItemRevisionActorSchema = ensureMysqlProjectItemRevisionActorSchema,
  ensureCommentActorSchema = ensureMysqlCommentActorSchema,
  ensureAuthenticationMethods = ensureMysqlAuthenticationMethods,
  ensurePendingRegistrationsSchema = ensureMysqlPendingRegistrationsSchema,
  ensureMcpOAuthSchema = ensureMysqlMcpOAuthSchema,
  ensureResourceLinkSchema = ensureMysqlResourceLinkSchema,
  ensureBugReporterMailSchema = ensureMysqlBugReporterMailSchema,
  ensureBugReporterReplySchema = ensureMysqlBugReporterReplySchema,
  ensureProjectChangeLogSchema = ensureMysqlProjectChangeLogSchema,
  ensureProjectChangeLogRelatedColumns = ensureMysqlProjectChangeLogRelatedColumns,
  ensureItemChangeRequestsSchema = ensureMysqlItemChangeRequestsSchema,
  ensureFileVersionsAndLinksSchema = ensureMysqlFileVersionsAndLinksSchema,
  ensureDocumentSigningSchema = ensureMysqlDocumentSigningSchema,
  ensureEngagementsSchema = ensureMysqlEngagementsSchema,
  ensureChannelsSchema = ensureMysqlChannelsSchema,
  ensureLargeFilesSchema = ensureMysqlLargeFilesSchema,
  ensureBillingSchema = ensureMysqlBillingSchema,
  ensureGuestSessionsSchema = ensureMysqlGuestSessionsSchema,
  ensurePursuitSchema = ensureMysqlPursuitSchema,
  ensureOdinRepliesSchema = ensureMysqlOdinRepliesSchema,
  ensureNotificationsSchema = ensureMysqlNotificationsSchema,
  ensureDirectMessagesSchema = ensureMysqlDirectMessagesSchema,
  ensureRefreshGraceSchema = ensureMysqlRefreshGraceSchema,
  ensureChannelOdinSchema = ensureMysqlChannelOdinSchema,
  ensurePostReactionsSchema = ensureMysqlPostReactionsSchema,
  ensurePostReplyToSchema = ensureMysqlPostReplyToSchema,
  ensurePollsSchema = ensureMysqlPollsSchema,
  ensureSemanticSearchSchema = ensureMysqlSemanticSearchSchema,
  ensureEmailChangeSchema = ensureMysqlEmailChangeSchema,
} = {}) {
  return [
    { id: '0001_agent_execution', version: 1, description: 'Durable agent execution tables', up: ensureAgentExecutionSchema },
    { id: '0002_mail', version: 1, description: 'Mail delivery tables', up: ensureMailSchema },
    { id: '0003_clarifications', version: 1, description: 'Assistant clarification tables', up: ensureClarificationSchema },
    { id: '0004_project_planning', version: 1, description: 'Project planning tables', up: ensureProjectPlanning },
    { id: '0005_project_statuses', version: 1, description: 'Project status definitions', up: ensureProjectStatuses },
    { id: '0006_project_task_types', version: 1, description: 'Project task type definitions', up: ensureProjectTaskTypes },
    { id: '0007_summaries', version: 1, description: 'Project summary tables', up: ensureSummarySchema },
    { id: '0008_governance', version: 1, description: 'Project governance and dependency tables', up: ensureGovernanceSchema },
    { id: '0009_agent_goal_automation', version: 1, description: 'Versioned agent goals and monitor schedules', up: ensureAgentGoalAutomationSchema },
    { id: '0010_agent_goal_notifications', version: 1, description: 'Durable goal attention and escalation records', up: ensureAgentGoalNotificationSchema },
    { id: '0011_agent_memory', version: 1, description: 'Permission-aware project and episodic memory', up: ensureAgentMemorySchema },
    { id: '0012_domain_event_outbox', version: 1, description: 'Durable leased domain events with replay and dead-lettering', up: ensureDomainEventOutboxSchema },
    { id: '0013_agent_memory_governance', version: 1, description: 'Memory retention expiry and legal hold controls', up: ensureAgentMemoryGovernanceSchema },
    { id: '0014_portfolio_strategy', version: 1, description: 'Portfolio, program, strategy, demand, benefit, and scenario planning', up: ensurePortfolioSchema },
    { id: '0015_resource_finance', version: 1, description: 'Resource capacity, allocation, time, expense, and project financial ledgers', up: ensureResourceFinanceSchema },
    { id: '0016_workflow_enterprise', version: 1, description: 'Workflow definitions, approvals, transition history, baselines, templates, and custom fields', up: ensureWorkflowSchema },
    { id: '0017_reporting_search', version: 1, description: 'Indexed global search, saved views, report definitions, subscriptions, executions, and snapshots', up: ensureReportingSchema },
    { id: '0018_enterprise_identity', version: 1, description: 'Tenant identity policy, verified domains, groups, roles, access reviews, service credentials, and impersonation grants', up: ensureIdentitySchema },
    { id: '0019_platform_integrations', version: 1, description: 'OAuth applications, scoped access tokens, webhook subscriptions, delivery retries, and dead-letter replay', up: ensurePlatformSchema },
    { id: '0020_shared_live_events', version: 1, description: 'Cross-instance sequenced live invalidation relay with bounded retention', up: ensureSharedLiveEventSchema },
    { id: '0021_break_glass_access', version: 1, description: 'Tenant-designated MFA-protected emergency access policy', up: ensureBreakGlassSchema },
    { id: '0022_access_review_campaigns', version: 1, description: 'Recurring access certification campaigns and idempotent materialization runs', up: ensureAccessReviewCampaignSchema },
    { id: '0023_saml_transactions', version: 1, description: 'One-use SAML RelayState and InResponseTo replay protection', up: ensureSamlTransactionSchema },
    { id: '0024_project_item_versioning', version: 1, description: 'Item-level optimistic versions and immutable project item revisions', up: ensureProjectItemVersioning },
    { id: '0025_schedule_controls', version: 1, description: 'Project working calendars and immutable schedule baselines', up: ensureScheduleControlSchema },
    { id: '0026_workflow_automation_events', version: 1, description: 'Durable transition and SLA escalation event materialization', up: ensureWorkflowAutomationSchema },
    { id: '0027_mail_delivery_schema', version: 1, description: 'Fresh-schema durable mail delivery tables', up: ensureMailDeliverySchema },
    { id: '0028_resource_finance_advanced', version: 1, description: 'Rate history, timesheet periods, receipt metadata, and exchange rates', up: ensureResourceFinanceAdvancedSchema },
    { id: '0029_portfolio_scenario_planning', version: 1, description: 'Constrained portfolio scenarios, approval decisions, and immutable baselines', up: ensurePortfolioPlanningSchema },
    { id: '0030_agent_memory_semantic', version: 1, description: 'Governed semantic memory embeddings and privacy deletion propagation', up: ensureAgentMemorySemanticSchema },
    { id: '0031_connector_platform', version: 1, description: 'Governed connector catalog, mappings, conflicts, inbound events, and idempotent sync runs', up: ensureConnectorSchema },
    { id: '0032_workflow_history_sequence', version: 1, description: 'Durable monotonic workflow transition ordering for automation and SLA state', up: ensureWorkflowHistorySequenceSchema },
    { id: '0033_resource_calendar_recurrence', version: 1, description: 'Timezone and weekday recurrence for resource working patterns and leave', up: ensureResourceCalendarRecurrenceSchema },
    { id: '0034_resource_finance_controls', version: 1, description: 'Accounting periods and persisted financial threshold and approval policies', up: ensureResourceFinanceControlsSchema },
    { id: '0035_platform_api_idempotency', version: 1, description: 'Application-scoped durable idempotency records for versioned API mutations', up: ensurePlatformIdempotencySchema },
    { id: '0036_connector_inbound_worker', version: 1, description: 'Leased connector inbox processing and normalized connector object projection', up: ensureConnectorWorkerSchema },
    { id: '0037_platform_oauth_delegation', version: 1, description: 'OAuth authorization-code PKCE delegation and user-bound access tokens', up: ensurePlatformDelegationSchema },
    { id: '0038_connector_marketplace_governance', version: 1, description: 'Tenant provider policies and separation-of-duties connector approval', up: ensureConnectorMarketplaceSchema },
    { id: '0039_compliance_evidence', version: 1, description: 'Tenant compliance policy and immutable audit evidence manifests', up: ensureComplianceSchema },
    { id: '0040_privacy_erasure', version: 1, description: 'Governed privacy erasure requests and completion evidence', up: ensurePrivacyErasureSchema },
    { id: '0041_reporting_warehouse', version: 1, description: 'CDC reporting warehouse, incremental facts, cache invalidation, and distributed subscription leases', up: ensureReportingWarehouseSchema },
    { id: '0042_connector_erp_posting', version: 1, description: 'Durable outbound ERP posting and reconciliation', up: ensureConnectorErpPostingSchema },
    { id: '0043_connector_sync_worker', version: 1, description: 'Fenced provider polling and outbound synchronization runs', up: ensureConnectorSyncWorkerSchema },
    { id: '0044_compliance_governance', version: 1, description: 'Record-scoped legal holds and immutable control-owner attestations', up: ensureComplianceGovernanceSchema },
    { id: '0045_connector_provider_erasure', version: 1, description: 'Durable provider privacy erasure propagation', up: ensureConnectorErasureSchema },
    { id: '0046_connector_oauth', version: 1, description: 'PKCE connector OAuth transactions and encrypted provider credentials', up: ensureConnectorOAuthSchema },
    { id: '0047_ticketing', version: 1, description: 'Ticket work-item fields and typed work-item relations', up: ensureTicketingSchema },
    { id: '0048_ticket_config_lists', version: 1, description: 'Tenant environment and release identifier lists', up: ensureTicketConfigSchema },
    { id: '0049_ticket_intake', version: 1, description: 'Project-scoped external ticket intake invitations', up: ensureTicketIntakeSchema },
    { id: '0050_project_item_percent_complete', version: 1, description: 'Manual percent complete for in-flight work items', up: ensureProjectItemProgressSchema },
    { id: '0051_requirements_tracks', version: 1, description: 'Requirements track, origin, creator, brief source, and owner role on clarification topics', up: ensureRequirementsTracksSchema },
    { id: '0052_requirements_links', version: 1, description: 'Hashed, revocable stakeholder links for the requirements portal', up: ensureRequirementsLinksSchema },
    { id: '0053_review_packages', version: 1, description: 'Versioned review packages and their screens', up: ensureReviewPackagesSchema },
    { id: '0054_review_rounds', version: 1, description: 'Review rounds and their reviewers', up: ensureReviewRoundsSchema },
    { id: '0055_review_feedback', version: 1, description: 'Review annotations, annotation comments, verdicts, and answers', up: ensureReviewFeedbackSchema },
    { id: '0056_requirements_decisions', version: 1, description: 'Requirements decisions, Odin summaries, and track plans', up: ensureRequirementsDecisionsSchema },
    { id: '0057_review_package_storage', version: 1, description: 'Review package validation warnings, file index, and single-use upload URLs', up: ensureReviewPackageStorageSchema },
    { id: '0058_project_item_actual_hours', version: 1, description: 'Hours actually spent on work items', up: ensureProjectItemActualHoursSchema },
    { id: '0059_audit_log_actor_length', version: 1, description: 'Audit log user ids long enough for OAuth application actors', up: ensureAuditLogActorSchema },
    { id: '0060_project_item_estimate_override', version: 1, description: 'Manual overrides of rolled-up work item points and hours', up: ensureProjectItemEstimateOverrideSchema },
    { id: '0061_review_round_details', version: 1, description: 'Review round reminders, reviewer mail status, annotation numbers and history, verdict notes, answer topics, and snapshots', up: ensureReviewRoundDetailsSchema },
    { id: '0062_requirements_plan_details', version: 1, description: 'Track plan structure, internal audit, approver name, edit lineage, and proposed work', up: ensureRequirementsPlanDetailsSchema },
    { id: '0063_clarification_topics_backfill', version: 1, description: 'Every clarification without a track becomes an Experience requirements topic', up: backfillClarificationTopics },
    { id: '0064_review_package_replacement', version: 1, description: 'Upload URLs that replace an unpublished draft review package', up: ensureReviewPackageReplacementSchema },
    { id: '0065_ticket_reopen_count', version: 1, description: 'How many times a reporter reopened each ticket, and when they last did', up: ensureTicketReopenSchema },
    { id: '0066_project_soft_delete', version: 1, description: 'Soft-deleted projects: normalized deleted flag plus deleted_at and deleted_by', up: ensureProjectSoftDeleteSchema },
    { id: '0067_contributor_metrics', version: 1, description: 'Contributor leaderboard metrics table where missing, with a project on each row for per-project totals', up: ensureMetricsSchema },
    { id: '0072_workspace_join_requests', version: 1, description: 'Workspace join requests: requester, email confirmation token and state, and the admin decision', up: ensureJoinRequestSchema },
    { id: '0073_project_insights_layouts', version: 1, description: 'Per-project Insights dashboard layouts', up: ensureInsightsSchema },
    { id: '0074_requirements_mentions', version: 1, description: 'Requirements comment mentions and their email digest deliveries', up: ensureMentionsSchema },
    { id: '0075_waitlist_signups', version: 1, description: 'Access requests from the marketing site', up: ensureWaitlistSchema },
    { id: '0076_requirements_mention_reasons', version: 1, description: 'Why a digest entry was recorded: a tag, or a reply on a topic the person owns or commented on', up: ensureMentionReasonSchema },
    { id: '0077_agent_monitor_editor', version: 1, description: 'Who last set up each goal monitor, so that only monitors set up by the goal owner may make changes', up: ensureAgentMonitorEditorSchema },
    { id: '0078_access_links', version: 1, description: 'One access link per workspace and email, with hashed tokens, for people without a login', up: ensureAccessLinksSchema },
    { id: '0079_project_task_access', version: 1, description: 'Task access per project and resource without a login: their tasks or everyone\'s, kept when turned off', up: ensureProjectTaskAccessSchema },
    { id: '0080_resource_email', version: 1, description: 'An email on resource profiles without a login, indexed by workspace and address', up: ensureResourceEmailSchema },
    { id: '0081_project_item_remaining_hours', version: 1, description: 'Hours of work left on work items', up: ensureProjectItemRemainingHoursSchema },
    { id: '0082_project_item_revision_actor', version: 1, description: 'Revision actor ids long enough for resource and external actors', up: ensureProjectItemRevisionActorSchema },
    { id: '0083_comment_actor', version: 1, description: 'Comment author ids that are not users: no users foreign key, and long enough for resource actors', up: ensureCommentActorSchema },
    { id: '0084_authentication_methods', version: 1, description: 'The basic and Google sign-in methods that users reference', up: ensureAuthenticationMethods },
    { id: '0085_pending_registrations', version: 1, description: 'Password sign-ups waiting for their emailed confirmation link', up: ensurePendingRegistrationsSchema },
    { id: '0086_mcp_oauth', version: 1, description: 'MCP OAuth clients, authorization codes, token families and tokens', up: ensureMcpOAuthSchema },
    { id: '0087_resource_links', version: 1, description: 'Minimum bill rate on resource profiles; project rate and origin on resource allocations', up: ensureResourceLinkSchema },
    { id: '0088_bug_reporter_mail_deliveries', version: 1, description: 'Bug Reporter email deliveries, and mail_queue targets long enough for them', up: ensureBugReporterMailSchema },
    { id: '0089_bug_reporter_replies', version: 1, description: 'Bug Reporter reply tokens, email replies and their files, and the reply-not-added email template', up: ensureBugReporterReplySchema },
    { id: '0090_project_change_log', version: 1, description: 'An append-only log of changes to project work, with a sequence that agents read as a cursor', up: ensureProjectChangeLogSchema },
    { id: '0091_project_change_log_related_item', version: 1, description: 'The other end of a link or dependency on each change, indexed, so either item finds it in its history', up: ensureProjectChangeLogRelatedColumns },
    { id: '0092_item_change_requests', version: 1, description: 'Idempotency keys for changes agents apply, with the result each first request got', up: ensureItemChangeRequestsSchema },
    { id: '0093_file_versions_and_links', version: 1, description: 'Earlier versions of project files, and links from files to the work items that reference them', up: ensureFileVersionsAndLinksSchema },
    { id: '0094_document_signing', version: 1, description: 'Internal or external on each file, and signature requests with frozen documents, signers, sealed signatures and their audit trail', up: ensureDocumentSigningSchema },
    { id: '0095_engagements', version: 1, description: 'The kind of each project, engagement fields (status, customer, owner, conversion and closing), and the modules each workspace has switched on', up: ensureEngagementsSchema },
    { id: '0096_channels', version: 1, description: 'Channels on every project with one General channel each, their guests, discussion posts for channels and file comments, the files posts carry, and when each person last read each channel', up: ensureChannelsSchema },
    { id: '0097_large_files', version: 1, description: 'BIGINT file sizes, SHA-256 and scan status on files and versions, deleted old versions, previews, folders, the editing marker and multipart uploads', up: ensureLargeFilesSchema },
    { id: '0098_guest_sessions', version: 1, description: 'Sign-in codes and sessions for channel guests, both stored hashed; a session expires 30 days after its last use', up: ensureGuestSessionsSchema },
    { id: '0099_billing', version: 1, description: 'invoice-gen links on projects, invoice summaries, time entry claims that lock entries to an invoice, and the SOW milestone each story bills to', up: ensureBillingSchema },
    { id: '0100_pursuit', version: 1, description: 'The pursuit marker on work items, and project settings for the pursuit board and Odin (guests see the whole board, Odin answers when tagged)', up: ensurePursuitSchema },
    { id: '0101_odin_replies', version: 1, description: 'One record per post that tags @odin: who asked, the assistant turn, the latest post Odin wrote in the thread, and its status', up: ensureOdinRepliesSchema },
    { id: '0102_notifications', version: 1, description: 'Notification levels per channel and person, notification records with their place in the rolled-up email, chat digest deliveries, Web Push subscriptions and which tabs have Odin focused', up: ensureNotificationsSchema },
    { id: '0103_direct_messages', version: 1, description: 'Direct message conversations between workspace members, 2 to 8 people each, with their members and when each last read it', up: ensureDirectMessagesSchema },
    { id: '0104_refresh_grace', version: 1, description: 'Sessions remember the refresh token they replaced and when, so a refresh that raced another still gets the current session for a short time', up: ensureRefreshGraceSchema },
    { id: '0105_channel_odin', version: 1, description: 'Each channel has its own "Let Odin answer when tagged" setting, on by default and off where the project had switched Odin off', up: ensureChannelOdinSchema },
    { id: '0106_post_reactions', version: 1, description: 'Emoji reactions on posts, replies, file comments and direct messages: one row per post, person and emoji', up: ensurePostReactionsSchema },
    { id: '0107_post_reply_to', version: 1, description: 'A reply that answers another reply in its thread remembers which one, for the quote shown above it', up: ensurePostReplyToSchema },
    { id: '0108_polls', version: 1, description: 'Polls on posts in channels and direct messages, and one vote per person on each', up: ensurePollsSchema },
    { id: '0109_semantic_search', version: 1, description: 'Semantic search: cached file text for the index, and the index refresh time and version of each workspace', up: ensureSemanticSearchSchema },
    { id: '0110_email_change_requests', version: 1, description: 'Account email changes waiting for the new address to be confirmed', up: ensureEmailChangeSchema },
  ];
}

export async function bootstrapMysqlSchema({
  executor,
  // Re-run and re-record migrations whose code changed after they ran (runMysqlMigrations).
  reconcile = false,
  runMigrations = runMysqlMigrations,
  ...overrides
}) {
  return runMigrations({
    executor,
    ...(reconcile ? { reconcile: true } : {}),
    migrations: mysqlMigrationDefinitions(overrides),
  });
}
