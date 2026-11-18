// Saved reports on the Insights dashboard. A report card runs on its own through the reporting
// module's execution path, which records a run and a snapshot. The viewer's latest snapshot
// is the cache: a fresh one is served as is; a stale one is served at once while a background
// run refreshes it, so no card waits behind a Run button. Snapshots are reused only for the
// person who ran them, because each run sees what its requester may see.

import { buildOperationLogContext, logBackendError } from '../../lib/logging/backend-logger.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { executeReportForUser } from '../reporting/reporting.service.js';

export const REPORT_CARD_FRESH_MS = 15 * 60_000;
export const REPORT_CARD_ROW_LIMIT = 200;
export const REPORT_CARD_ROWS_SHOWN = 50;

const inFlightRuns = new Map();

/** Reports a dashboard on this project may show: this project's, or tenant-wide ones. */
export function reportVisibleOnProject(report, { projectId, user }) {
  if (report.projectId && report.projectId !== projectId) return false;
  return report.ownerUserId === user.id
    || report.visibility === 'tenant'
    || (report.visibility === 'project' && report.projectId === projectId);
}

function latestBy(records, field) {
  return [...records].sort((left, right) => String(left[field] ?? '').localeCompare(String(right[field] ?? ''))).at(-1) ?? null;
}

function deliverySummary(subscription) {
  if (!subscription) return null;
  return {
    channel: subscription.deliveryChannel,
    enabled: Boolean(subscription.enabled),
    format: subscription.format,
    intervalMinutes: Number(subscription.schedule?.intervalMinutes ?? 0) || null,
    nextRunAt: subscription.nextRunAt ?? null,
  };
}

/** Reports visible on this project, newest definitions last, with their latest run. */
export function listProjectReports(snapshot, { projectId, user }) {
  return snapshot.reports
    .filter((report) => reportVisibleOnProject(report, { projectId, user }))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((report) => {
      const lastRun = latestBy(snapshot.runs.filter((run) => run.reportId === report.id && run.status === 'completed'), 'finishedAt');
      const subscription = snapshot.subscriptions.find((entry) => entry.reportId === report.id && entry.ownerUserId === user.id) ?? null;
      return {
        dataset: report.dataset,
        delivery: deliverySummary(subscription),
        description: report.description ?? '',
        id: report.id,
        lastRunAt: lastRun?.finishedAt ?? null,
        name: report.name,
        projectScoped: report.projectId === projectId,
        status: report.status,
        visibility: report.visibility,
        visualization: report.visualization,
      };
    });
}

function reportSummary(report) {
  return {
    columns: report.columns,
    dataset: report.dataset,
    description: report.description ?? '',
    id: report.id,
    name: report.name,
    projectId: report.projectId ?? null,
    status: report.status,
    visualization: report.visualization,
  };
}

function cardPayload(report, { asOf, cache, refreshing, rows, truncated }) {
  return {
    asOf,
    cache,
    ok: true,
    refreshing,
    report: reportSummary(report),
    rowCount: rows.length,
    rows: rows.slice(0, REPORT_CARD_ROWS_SHOWN),
    truncated: Boolean(truncated) || rows.length > REPORT_CARD_ROWS_SHOWN,
  };
}

function runReportOnce({ dependencies, reportId, repository, tenantId, user }) {
  const key = `${tenantId}:${user.id}:${reportId}`;
  if (!inFlightRuns.has(key)) {
    const run = executeReportForUser({
      dependencies,
      input: { format: 'json', limit: REPORT_CARD_ROW_LIMIT, parameters: {} },
      reportId,
      repository,
      user,
    }).finally(() => inFlightRuns.delete(key));
    inFlightRuns.set(key, run);
  }
  return inFlightRuns.get(key);
}

export function isReportRunInFlight({ reportId, tenantId, userId }) {
  return inFlightRuns.has(`${tenantId}:${userId}:${reportId}`);
}

/**
 * The data behind one report card. `now` is injectable for tests. The caller has already
 * checked that the viewer can read the project.
 */
export async function getInsightsReportCard({ dependencies, now = new Date(), projectId, reportId, repository, tenantId, user }) {
  const snapshot = await repository.listSnapshot({ tenantId });
  const report = snapshot.reports.find((record) => record.id === reportId);
  if (!report || !reportVisibleOnProject(report, { projectId, user })) throw new HttpError(404, 'Report not found.');
  if (report.status === 'inactive') {
    return { asOf: null, cache: 'inactive', ok: true, refreshing: false, report: reportSummary(report), rowCount: 0, rows: [], truncated: false };
  }

  const ownRunIds = new Set(snapshot.runs.filter((run) => run.reportId === reportId && run.requestedBy === user.id).map((run) => run.id));
  const latest = latestBy(snapshot.snapshots.filter((entry) => entry.reportId === reportId && ownRunIds.has(entry.runId)), 'generatedAt');
  const generatedAt = Date.parse(latest?.generatedAt ?? '');
  const changedSince = Date.parse(report.updatedAt ?? '') > generatedAt;
  const fresh = latest && now.getTime() - generatedAt < REPORT_CARD_FRESH_MS && !changedSince;
  const context = { dependencies, reportId, repository, tenantId, user };

  if (latest && !fresh) {
    runReportOnce(context).catch((error) => {
      logBackendError(error, { context: buildOperationLogContext('insights.reportCardRefresh', { projectId, reportId, tenantId }) });
    });
  }
  if (latest) {
    return cardPayload(report, {
      asOf: latest.freshness?.asOf ?? latest.generatedAt,
      cache: fresh ? 'hit' : 'stale',
      refreshing: !fresh,
      rows: Array.isArray(latest.data) ? latest.data : [],
      truncated: latest.freshness?.truncated,
    });
  }

  const result = await runReportOnce(context);
  return cardPayload(report, { asOf: result.freshness?.asOf ?? now.toISOString(), cache: 'miss', refreshing: false, rows: result.rows ?? [], truncated: result.freshness?.truncated });
}
