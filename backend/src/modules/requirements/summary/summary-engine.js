import { LIVE_EVENT_CHANNELS } from '../../../lib/events/live-event-bus.js';
import { buildOperationLogContext, logBackendError } from '../../../lib/logging/backend-logger.js';
import { REQUIREMENTS_EVENTS } from '../requirements-events.js';
import {
  emptySummaryOutput,
  mapSummaryRefs,
  resolveProposedAnswerStatus,
  summaryOutputSchema,
  validateSummaryCitations,
} from './summary-output.js';
import {
  buildSummaryModelInput,
  buildSummaryRefMaps,
  canSummarizeLoneAuthor,
  countContributors,
  digestSummaryInput,
  normalizeSummaryParticipants,
  normalizeSummarySources,
  participantStanding,
} from './summary-prompt.js';
import { createSummaryScheduler } from './summary-scheduler.js';
import { createTopicSummaryLoader } from './summary-topics.js';

// The Odin summary engine (E-04). `summarizeScope` is the generic step: sources in, a
// validated run out, nothing stored. The engine around it loads a scope's input, stores
// every run as a new requirements_summaries row, publishes requirements.summary.updated,
// and schedules refreshes after human activity. Topics are built in; the rounds unit
// registers loaders for 'screen' and 'round' scopes with registerScope().

export const SUMMARY_SCOPE_TYPES = Object.freeze(['topic', 'screen', 'round']);
export const REQUIREMENTS_SUMMARY_EVENT = REQUIREMENTS_EVENTS.summary;
export const SUMMARY_FAILURE_CODES = Object.freeze({
  noValidEntries: 'no_valid_entries',
  outputInvalid: 'ai_output_invalid',
  requestFailed: 'ai_request_failed',
});

// Change reasons (as published on requirements.topics.invalidated) that count as human
// activity on a topic and schedule a refresh. Round answers posted into a topic thread use
// 'round-answer-posted'; answers through the older clarification route use 'topic-answered'.
// A recorded or edited decision changes what the topic's summary has to say about it.
// Owner and assignee changes request their own refresh (updateTopicForUser).
export const SUMMARY_ACTIVITY_REASONS = Object.freeze([
  'decision-recorded',
  'decision-updated',
  'round-answer-posted',
  'topic-answered',
  'topic-comment-deleted',
  'topic-comment-reacted',
  'topic-comment-updated',
  'topic-commented',
  'topic-email-replied',
]);

const ACTIVITY_REASONS = new Set(SUMMARY_ACTIVITY_REASONS);

function isAiNotConfigured(error) {
  return error?.statusCode === 503 || error?.details?.code === 'ai_not_configured';
}

function mapDroppedEntry(entry, { actor, source }) {
  const mapped = { ...entry };
  if (Array.isArray(mapped.sources)) mapped.sources = mapped.sources.map(source);
  if (Array.isArray(mapped.supporters)) mapped.supporters = mapped.supporters.map(actor);
  if (Array.isArray(mapped.actors)) mapped.actors = mapped.actors.map(actor);
  if (Array.isArray(mapped.positions)) mapped.positions = mapped.positions.map((position) => mapDroppedEntry(position, { actor, source }));
  return mapped;
}

function mapDroppedRecord(record, maps) {
  return record.entry ? { ...record, entry: mapDroppedEntry(record.entry, maps) } : { ...record };
}

function issueSummary(error) {
  return (error?.issues ?? []).slice(0, 5)
    .map((issue) => `${(issue.path ?? []).join('.') || '$'}: ${issue.message}`)
    .join('; ');
}

/**
 * Summarizes one scope. Sources: [{ ref, storedRef?, kind, actorRef, actorName, text,
 * createdAt, replyTo?, votes?: [{ actorRef, actorName, vote: 'up'|'down' }] }]. `ref` is
 * the label the model cites; `storedRef` is what gets saved (defaults to `ref`).
 * Participants: [{ actorRef, actorName, topicRole: 'owner'|'required'|'assigned'|null, admin? }], the people with a
 * role on the scope whether or not they have written.
 *
 * A forced refresh on unchanged input keeps the previous outstanding list: nothing new can
 * have opened or closed, so a different list would only be the model's variance.
 *
 * Returns { status, output, dropped, model, inputDigest, errorCode, contributors } with
 * status 'ok', 'failed', 'skipped' (no input, unchanged since the current summary, or
 * still too little input), or 'unavailable' (no AI provider). Nothing is stored.
 */
export async function summarizeScope({
  context = {},
  force = false,
  participants = [],
  previous = null,
  projectId = null,
  scopeId,
  scopeType,
  sources = [],
  subject = {},
  summaryAi = null,
  tenantId = null,
  track = null,
}) {
  const normalized = normalizeSummarySources(sources);
  const roles = normalizeSummaryParticipants(participants);
  const inputDigest = digestSummaryInput({ context, participants: roles, scopeType, sources: normalized, subject, track });
  const contributors = countContributors(normalized);
  const base = { contributors, dropped: [], errorCode: null, inputDigest, model: null, output: null, scopeId, scopeType, track };
  const unchanged = previous?.inputDigest === inputDigest;

  if (normalized.length === 0 && !previous) return { ...base, reason: 'no-input', status: 'skipped' };
  if (!force && unchanged) return { ...base, reason: 'unchanged', status: 'skipped' };

  // On a topic, fewer than two people, unless the one person can answer for it: "Not enough
  // input yet", without a model call. A round or screen is summarized from one reviewer
  // too, so their annotations and comments still get feedback themes.
  if (scopeType === 'topic' && contributors < 2 && !canSummarizeLoneAuthor(normalized, roles)) {
    if (!force && previous?.output?.insufficientInput === true) return { ...base, reason: 'still-insufficient', status: 'skipped' };
    return { ...base, output: emptySummaryOutput({ insufficientInput: true }), status: 'ok' };
  }

  if (typeof summaryAi?.summarize !== 'function') return { ...base, reason: 'ai-not-configured', status: 'unavailable' };

  const maps = buildSummaryRefMaps(normalized, roles);
  const modelInput = buildSummaryModelInput({ context, maps, previous, scopeType, sources: normalized, subject, track });

  let raw;
  let model = summaryAi.provider ?? null;
  try {
    const response = await summaryAi.summarize({ modelInput, projectId, scopeId, scopeType, tenantId });
    raw = response?.output;
    model = response?.model ?? model;
  } catch (error) {
    if (isAiNotConfigured(error)) return { ...base, reason: 'ai-not-configured', status: 'unavailable' };
    const errorCode = error?.name === 'AiStructuredOutputValidationError'
      ? SUMMARY_FAILURE_CODES.outputInvalid
      : SUMMARY_FAILURE_CODES.requestFailed;
    return { ...base, error, errorCode, errorDetail: String(error?.message ?? '').slice(0, 300), model, status: 'failed' };
  }

  const parsed = summaryOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ...base, errorCode: SUMMARY_FAILURE_CODES.outputInvalid, errorDetail: issueSummary(parsed.error), model, status: 'failed' };
  }

  const validated = validateSummaryCitations(parsed.data, {
    actorRefs: modelInput.actorRefs,
    sourceRefs: modelInput.citableSourceRefs,
  });
  const toStored = {
    actor: (value) => maps.actorByLabel.get(value) ?? value,
    source: (value) => maps.storedBySourceLabel.get(value) ?? value,
  };
  const dropped = validated.dropped.map((record) => mapDroppedRecord(record, toStored));
  if (validated.failed) {
    return { ...base, dropped, errorCode: SUMMARY_FAILURE_CODES.noValidEntries, errorDetail: 'Every cited entry was dropped.', model, status: 'failed' };
  }
  const output = mapSummaryRefs(validated.output, toStored);
  const owners = new Set(roles.filter((role) => participantStanding(role) === 'owner').map((role) => role.actorRef));
  const authorities = new Set(roles.filter((role) => participantStanding(role) === 'required').map((role) => role.actorRef));
  output.proposedAnswerStatus = resolveProposedAnswerStatus({
    contributors,
    hasAuthority: authorities.size > 0,
    hasOwner: owners.size > 0,
    loneAuthority: contributors === 1 && authorities.has(normalized[0]?.actorRef),
    loneOwner: contributors === 1 && owners.has(normalized[0]?.actorRef),
    proposedAnswer: output.proposedAnswer,
    status: output.proposedAnswerStatus,
  });
  if (force && unchanged && previous?.output && previous.output.insufficientInput !== true) {
    output.outstanding = (previous.output.outstanding ?? []).map((entry) => ({ ...entry }));
  }
  return { ...base, dropped, model, output, status: 'ok' };
}

export function summaryScopeKey({ projectId, scopeId, scopeType, tenantId }) {
  return `${tenantId}|${projectId}|${scopeType}|${scopeId}`;
}

export function createRequirementsSummaryEngine({
  assistantRepository,
  clock = () => new Date(),
  delayMs = 20_000,
  liveEventBus = null,
  maxAttempts = 3,
  maxWaitMs = 120_000,
  projectRepository = null,
  requirementsRepository,
  retryDelaysMs = [30_000, 120_000],
  summaryAi = null,
  timers = undefined,
}) {
  const loaders = new Map();
  const listeners = [];
  // Activity time already checked per scope, so a skipped run (nothing changed) does not
  // get rescheduled on every read.
  const checkedThrough = new Map();

  // Listeners never hold up or fail the caller; their errors are logged.
  function emit(name, payload) {
    for (const listener of listeners) {
      if (typeof listener[name] !== 'function') continue;
      Promise.resolve()
        .then(() => listener[name](payload))
        .catch((error) => {
          logBackendError({
            context: buildOperationLogContext(`requirements.summary.${name}`, { projectId: payload?.projectId ?? payload?.job?.projectId }),
            error,
            level: 'warn',
            message: 'Odin summary listener failed.',
          });
        });
    }
  }

  function jobFor({ projectId, scopeId, scopeType, tenantId }) {
    return { projectId, scopeId, scopeType, tenantId };
  }

  async function publishUpdated(job, row, audience) {
    if (!liveEventBus) return;
    const payload = {
      scopeId: job.scopeId,
      scopeType: job.scopeType,
      status: row.status,
      summaryId: row.id,
      track: row.track ?? null,
      type: REQUIREMENTS_SUMMARY_EVENT,
    };
    liveEventBus.publish(LIVE_EVENT_CHANNELS.project(job.projectId), payload);

    const stakeholderIds = audience?.stakeholderIds;
    if (Array.isArray(stakeholderIds) && stakeholderIds.length === 0) return;
    try {
      const links = await requirementsRepository.listAccessLinks({ projectId: job.projectId, tenantId: job.tenantId });
      for (const link of links) {
        if (link.revokedAt) continue;
        if (Array.isArray(stakeholderIds) && !stakeholderIds.includes(link.stakeholderId)) continue;
        liveEventBus.publish(LIVE_EVENT_CHANNELS.publicRequirements(link.id), payload);
      }
    } catch (error) {
      logBackendError({
        context: buildOperationLogContext('requirements.summary.publishPortal', { projectId: job.projectId, tenantId: job.tenantId }),
        error,
        level: 'warn',
        message: 'Odin summary portal event failed.',
      });
    }
  }

  async function runJob(job, { forced }) {
    const loader = loaders.get(job.scopeType);
    if (!loader) return { reason: 'unknown-scope', retryable: false, status: 'skipped' };
    const key = summaryScopeKey(job);
    const startedAt = clock();
    const input = await loader.load(job);
    if (!input) return { reason: 'scope-missing', retryable: false, status: 'skipped' };

    const previous = await requirementsRepository.getCurrentSummary({
      projectId: job.projectId,
      scopeId: job.scopeId,
      scopeType: job.scopeType,
      tenantId: job.tenantId,
    });
    const result = await summarizeScope({
      ...input,
      force: forced,
      previous,
      projectId: job.projectId,
      scopeId: job.scopeId,
      scopeType: job.scopeType,
      summaryAi,
      tenantId: job.tenantId,
    });

    if (result.status === 'skipped' || result.status === 'unavailable') {
      checkedThrough.set(key, startedAt.valueOf());
      return { reason: result.reason, retryable: false, status: result.status };
    }

    if (result.status === 'failed') {
      logBackendError({
        context: buildOperationLogContext('requirements.summary.run', {
          errorCode: result.errorCode,
          projectId: job.projectId,
          scopeId: job.scopeId,
          scopeType: job.scopeType,
          tenantId: job.tenantId,
        }),
        error: result.error ?? new Error(result.errorDetail || result.errorCode),
        level: 'warn',
        message: 'Odin summary refresh failed; the previous summary stays current.',
      });
    }

    const row = await requirementsRepository.createSummary({
      projectId: job.projectId,
      summary: {
        // The run reflects the discussion as of its start, so later activity always
        // compares as newer.
        createdAt: startedAt,
        dropped: result.dropped,
        errorMessage: result.status === 'failed' ? `${result.errorCode}: ${result.errorDetail ?? ''}`.trim() : '',
        inputDigest: result.inputDigest,
        model: result.model,
        output: result.output,
        scopeId: job.scopeId,
        scopeType: job.scopeType,
        status: result.status,
        track: input.track ?? null,
      },
      tenantId: job.tenantId,
    });
    checkedThrough.set(key, startedAt.valueOf());
    await publishUpdated(job, row, input.audience);
    if (result.status === 'ok') emit('onSummaryStored', { job, previous, summary: row });
    return { retryable: result.status === 'failed', status: result.status, summary: row };
  }

  const scheduler = createSummaryScheduler({
    delayMs,
    maxAttempts,
    maxWaitMs,
    now: () => clock().valueOf(),
    onError(error, job) {
      logBackendError({
        context: buildOperationLogContext('requirements.summary.schedule', { scopeId: job?.scopeId, scopeType: job?.scopeType }),
        error,
        level: 'warn',
        message: 'Odin summary refresh crashed.',
      });
    },
    retryDelaysMs,
    run: runJob,
    timers,
  });

  const engine = {
    summaryAi,

    registerScope(scopeType, loader) {
      if (!SUMMARY_SCOPE_TYPES.includes(scopeType)) throw new Error(`Unknown summary scope type: ${scopeType}.`);
      if (typeof loader?.load !== 'function') throw new Error('A summary scope loader needs load(job).');
      loaders.set(scopeType, loader);
    },

    /**
     * Adds a listener: onTopicActivity({ projectId, reason, tenantId, topicIds }) for every
     * topic change reason, and onSummaryStored({ job, previous, summary }) after each 'ok'
     * run is stored. Other scopes use it to follow topics they depend on.
     */
    subscribe(listener) {
      if (listener && typeof listener === 'object') listeners.push(listener);
    },

    /** Debounced refresh after human activity. */
    requestRefresh(job) {
      return scheduler.schedule(summaryScopeKey(job), jobFor(job));
    },

    /** Immediate refresh (the refresh endpoint). Resolves with the run's result. */
    refreshNow(job) {
      return scheduler.runNow(summaryScopeKey(job), jobFor(job));
    },

    isPending(job) {
      return scheduler.isPending(summaryScopeKey(job));
    },

    schedulerState(job) {
      return scheduler.state(summaryScopeKey(job));
    },

    /** Schedules topic refreshes for change reasons that are human activity. */
    noteTopicActivity({ projectId, reason, tenantId, topicIds = [] }) {
      emit('onTopicActivity', { projectId, reason, tenantId, topicIds });
      if (!ACTIVITY_REASONS.has(reason)) return;
      for (const topicId of topicIds) {
        if (topicId) engine.requestRefresh({ projectId, scopeId: topicId, scopeType: 'topic', tenantId });
      }
    },

    /**
     * Read-time recovery (for example after a restart drops the timers): schedules a topic
     * whose latest activity is newer than its latest run when nothing is scheduled.
     * `topics`: [{ id, lastActivityAt, status, humanComments }]; `attempts`: latest run of
     * any status per topic.
     */
    ensureFresh({ attempts = [], projectId, tenantId, topics = [] }) {
      const lastRunByTopic = new Map(attempts.filter((run) => run.scopeType === 'topic').map((run) => [run.scopeId, run.createdAt]));
      for (const topic of topics) {
        if (!topic?.id || topic.status === 'dismissed') continue;
        const lastRun = lastRunByTopic.get(topic.id) ?? null;
        if (!lastRun && !(topic.humanComments > 0)) continue;
        const activityMs = Date.parse(topic.lastActivityAt ?? '') || 0;
        const lastRunMs = lastRun ? Date.parse(lastRun) || 0 : 0;
        if (activityMs <= lastRunMs) continue;
        const job = { projectId, scopeId: topic.id, scopeType: 'topic', tenantId };
        const key = summaryScopeKey(job);
        if ((checkedThrough.get(key) ?? 0) >= activityMs || scheduler.isPending(key)) continue;
        scheduler.schedule(key, job);
      }
    },

    flush() {
      return scheduler.flush();
    },

    stop() {
      scheduler.stop();
    },
  };

  engine.registerScope('topic', createTopicSummaryLoader({ assistantRepository, projectRepository, requirementsRepository }));
  return engine;
}
