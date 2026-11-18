import { randomUUID } from 'node:crypto';

function normalizeSessionId(sessionId) {
  return String(sessionId ?? '').trim();
}

function createAssistantTurnTimeoutError(timeoutMs = 0) {
  const error = new Error(`Assistant turn timed out after ${timeoutMs}ms.`);
  error.assistantTurnTimeout = true;
  error.code = 'assistant_turn_timeout';
  error.name = 'AssistantTurnTimeoutError';
  error.timeoutMs = timeoutMs;
  return error;
}

export function createAssistantTurnQueue({
  executionRepository = null,
  heartbeatMs = 10_000,
  leaseMs = 30_000,
  runTimeoutMs = 0,
  workerId = `assistant-worker-${randomUUID()}`,
} = {}) {
  const jobs = new Map();
  const timeoutMs = Math.max(0, Number(runTimeoutMs ?? 0) || 0);

  function get(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return null;
    }

    return jobs.get(normalizedSessionId) ?? null;
  }

  function has(sessionId) {
    return Boolean(get(sessionId));
  }

  function cancel(sessionId, reason = new Error('Assistant turn cancelled.')) {
    const job = get(sessionId);
    if (!job) {
      return null;
    }

    if (job.status === 'running' || job.status === 'queued') {
      job.cancelRequestedAt = new Date().toISOString();
      job.status = 'cancelling';
      job.abortController?.abort(reason);
      if (job.executionRunId) {
        executionRepository?.cancelRun?.(job.executionRunId).catch(() => {});
      }
    }

    return job;
  }

  function enqueue({ durable = null, sessionId, run }) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      throw new Error('Assistant turn queue requires a sessionId.');
    }

    if (typeof run !== 'function') {
      throw new Error('Assistant turn queue requires a run function.');
    }

    const existing = jobs.get(normalizedSessionId);
    if (existing) {
      return {
        existing,
        queued: false,
      };
    }

    const job = {
      abortController: new AbortController(),
      cancelRequestedAt: null,
      completedAt: null,
      createdAt: new Date().toISOString(),
      error: null,
      executionRunId: null,
      promise: null,
      runTimeoutMs: timeoutMs,
      sessionId: normalizedSessionId,
      status: 'running',
      timedOutAt: null,
    };

    let timeout = null;
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        if (!['running', 'queued'].includes(job.status)) {
          return;
        }

        job.timedOutAt = new Date().toISOString();
        job.status = 'timed_out';
        job.abortController?.abort(createAssistantTurnTimeoutError(timeoutMs));
      }, timeoutMs);
      timeout.unref?.();
    }

    let heartbeat = null;
    let claimedRun = null;
    job.promise = Promise.resolve()
      .then(async () => {
        if (!executionRepository || !durable) return true;
        const enqueued = await executionRepository.enqueueRun({
          ...durable,
          runType: durable.runType ?? 'assistant_turn',
          sessionId: normalizedSessionId,
        });
        job.executionRunId = enqueued.run.id;
        claimedRun = await executionRepository.claimRun({
          leaseMs,
          runId: enqueued.run.id,
          runTypes: [durable.runType ?? 'assistant_turn'],
          workerId,
        });
        if (!claimedRun) {
          job.status = enqueued.run.status;
          return false;
        }
        heartbeat = setInterval(() => {
          executionRepository.heartbeatRun({
            leaseMs,
            leaseToken: claimedRun.leaseToken,
            runId: claimedRun.id,
            workerId,
          }).catch(() => job.abortController.abort(new Error('Assistant durable execution lease was lost.')));
        }, Math.min(heartbeatMs, Math.max(100, Math.floor(leaseMs / 2))));
        heartbeat.unref?.();
        return true;
      })
      .then((shouldRun) => shouldRun ? run({
        abortSignal: job.abortController.signal,
        job,
      }) : null)
      .then(async (result) => {
        if (claimedRun && !['cancelling', 'cancelled', 'timed_out'].includes(job.status)) {
          await executionRepository.completeRun({
            leaseToken: claimedRun.leaseToken,
            output: result ?? null,
            runId: claimedRun.id,
            workerId,
          });
        }
        job.status = job.status === 'timed_out'
          ? 'timed_out'
          : job.status === 'cancelling'
            ? 'cancelled'
            : 'completed';
        return result;
      })
      .catch(async (error) => {
        job.error = error;
        if (claimedRun) {
          if (job.status === 'cancelling') {
            await executionRepository.cancelRun?.(claimedRun.id).catch(() => {});
          } else {
            await executionRepository.failRun?.({
              error,
              leaseToken: claimedRun.leaseToken,
              retryable: !error?.assistantTurnTimeout,
              runId: claimedRun.id,
              workerId,
            }).catch(() => {});
          }
        }
        job.status = job.status === 'timed_out'
          ? 'timed_out'
          : job.status === 'cancelling'
            ? 'cancelled'
            : 'failed';
        return null;
      })
      .finally(() => {
        if (timeout) {
          clearTimeout(timeout);
        }
        if (heartbeat) {
          clearInterval(heartbeat);
        }
        job.completedAt = new Date().toISOString();
        jobs.delete(normalizedSessionId);
      });

    jobs.set(normalizedSessionId, job);
    return {
      job,
      queued: true,
    };
  }

  async function workOnce({ run, runTypes = ['assistant_turn'] }) {
    if (!executionRepository?.claimNextRun) {
      throw new Error('Durable assistant execution repository is not configured.');
    }
    if (typeof run !== 'function') {
      throw new Error('Durable assistant worker requires a run handler.');
    }
    const claimed = await executionRepository.claimNextRun({ leaseMs, runTypes, workerId });
    if (!claimed) return null;
    const abortController = new AbortController();
    const heartbeat = setInterval(() => {
      executionRepository.heartbeatRun({
        leaseMs,
        leaseToken: claimed.leaseToken,
        runId: claimed.id,
        workerId,
      }).catch((error) => abortController.abort(error));
    }, Math.min(heartbeatMs, Math.max(100, Math.floor(leaseMs / 2))));
    heartbeat.unref?.();
    const startedAt = Date.now();
    const budgetTimeoutMs = Math.max(0, Number(claimed.budgets?.wallClockMs ?? 0));
    const budgetTimeout = budgetTimeoutMs > 0 ? setTimeout(() => {
      abortController.abort(Object.assign(new Error(`Agent run wall-clock budget exceeded after ${budgetTimeoutMs}ms.`), {
        code: 'agent_run_budget_exceeded',
        exceeded: ['wallClockMs'],
      }));
    }, budgetTimeoutMs) : null;
    budgetTimeout?.unref?.();
    try {
      const output = await run({
        abortSignal: abortController.signal,
        executionRun: claimed,
        payload: claimed.payload,
        recordTrace: (trace) => executionRepository.recordTrace({ ...trace, runId: claimed.id }),
        recordUsage: (usage) => executionRepository.consumeRunUsage({ runId: claimed.id, usage }),
      });
      await executionRepository.consumeRunUsage({
        runId: claimed.id,
        usage: { wallClockMs: Date.now() - startedAt },
      });
      const completed = await executionRepository.completeRun({
        leaseToken: claimed.leaseToken,
        output,
        runId: claimed.id,
        workerId,
      });
      return { output, run: completed };
    } catch (error) {
      const failed = await executionRepository.failRun({
        error,
        leaseToken: claimed.leaseToken,
        retryable: !error?.permanent,
        runId: claimed.id,
        workerId,
      });
      return { error, run: failed };
    } finally {
      if (budgetTimeout) clearTimeout(budgetTimeout);
      clearInterval(heartbeat);
    }
  }

  return {
    cancel,
    enqueue,
    get,
    has,
    workOnce,
  };
}
