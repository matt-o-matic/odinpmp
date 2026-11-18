import { buildOperationLogContext, logBackendError } from '../../../lib/logging/backend-logger.js';
import { isProjectSoftDeleted } from '../../projects/project-deletion.service.js';
import { sendRoundEmail } from './round-invitations.js';

// Review reminders (journey 4). A round published with `reminder: { daysBefore }` emails
// every reviewer who has not submitted once the reminder window opens and before the round
// is due. Each reviewer is reminded at most once per round.
//
// The email is queued first and the reviewer row is marked reminded afterwards. The queue
// keeps one reminder per reviewer (its mail_queue target id is the reviewer row id, with the
// reminder template), so whatever stops a run between the two steps, a queue error or the
// process ending, the next run finds the reviewer still due, queues nothing new, and marks
// the row. The job's lock keeps runs from overlapping.

// The reviewer row id (a UUID: mail_queue.mail_target_id is VARCHAR(36) in production).
// With the reminder template it identifies exactly one reminder per reviewer per round.
export function reminderTargetId(reviewerId) {
  return reviewerId;
}

/**
 * Sends due reminders. `deps` needs roundsRepository, packagesRepository,
 * projectRepository, assistantRepository, requirementsRepository, mailRepository, and
 * frontendAppUrl. Returns counts per outcome.
 */
export async function processRoundReminders(deps, { limit = 200, now = new Date() } = {}) {
  const due = await deps.roundsRepository.listDueReminders({ limit, now });
  const summary = { due: due.length, failed: 0, notSent: 0, queued: 0, skipped: 0 };
  const projects = new Map();
  const packages = new Map();

  for (const { reviewer, round } of due) {
    try {
      const projectKey = `${round.tenantId}|${round.projectId}`;
      // A deleted project's reviewers stay due, so restoring the project resumes reminders.
      if (await isProjectSoftDeleted(deps.projectRepository, { projectId: round.projectId, tenantId: round.tenantId })) {
        summary.skipped += 1;
        continue;
      }
      if (!projects.has(projectKey)) projects.set(projectKey, await deps.projectRepository.getProjectDetail({ projectId: round.projectId, tenantId: round.tenantId }));
      if (!packages.has(round.packageId)) packages.set(round.packageId, await deps.packagesRepository.getPackage({ packageId: round.packageId, projectId: round.projectId, tenantId: round.tenantId }));
      const result = await sendRoundEmail(deps, {
        createdBy: 'system:reminder',
        kind: 'reminder',
        now,
        pkg: packages.get(round.packageId),
        projectId: round.projectId,
        projectName: projects.get(projectKey)?.name ?? '',
        reviewer,
        round,
        targetId: reminderTargetId(reviewer.id),
        tenantId: round.tenantId,
      });
      // Nothing is recorded for a queue error, so the reviewer stays due for the next run.
      if (result.mailStatus === 'failed') {
        summary.failed += 1;
        continue;
      }
      // Queued (now, or by an earlier run that stopped before this step) or not sendable at all.
      if (!await deps.roundsRepository.markReminded({ now, reviewerId: reviewer.id })) {
        summary.skipped += 1;
      } else if (result.mailStatus === 'queued') {
        summary.queued += 1;
      } else {
        summary.notSent += 1;
      }
    } catch (error) {
      summary.failed += 1;
      logBackendError({
        context: buildOperationLogContext('requirements.rounds.reminder', { reviewerId: reviewer.id, roundId: round.id }),
        error,
        level: 'warn',
        message: 'A review reminder could not be sent.',
      });
    }
  }
  return summary;
}
