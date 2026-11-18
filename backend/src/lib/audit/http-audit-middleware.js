import { buildRequestLogContext, logBackendError } from '../logging/backend-logger.js';
import { runWithAuditContext } from './audit-context.js';

const MUTATING_METHODS = new Set(['DELETE', 'PATCH', 'POST', 'PUT']);

function requestIp(request = {}) {
  return String(request.ip ?? request.socket?.remoteAddress ?? 'unknown').trim().slice(0, 100) || 'unknown';
}

function auditAction(request = {}) {
  const method = String(request.method ?? 'UNKNOWN').trim().toLowerCase();
  const route = String(request.baseUrl ?? '') + String(request.route?.path ?? request.path ?? request.originalUrl ?? '');
  return `http.${method}.${route || '/'}`.slice(0, 100);
}

export function createHttpAuditMiddleware({ auditWriter = null } = {}) {
  return function httpAuditMiddleware(request, response, next) {
    if (!auditWriter?.append || !MUTATING_METHODS.has(String(request.method ?? '').toUpperCase())) {
      next();
      return;
    }

    const auditContext = { policyDecisions: [] };
    response.once('finish', () => {
      const user = request.auth?.user;
      // A route sets skipAudit only for a signal that changes nothing, such as "is typing".
      if (!user?.id || response.locals?.skipAudit === true) {
        return;
      }

      const actor = request.auth?.actor ?? user;
      const event = {
        action: auditAction(request),
        detail: {
          actor: {
            actorId: actor.id,
            effectiveUserId: user.id,
            impersonationGrantId: request.auth?.impersonation?.grantId ?? null,
          },
          breakGlass: request.auth?.breakGlass ? { policyVersion: request.auth.breakGlass.policyVersion, reason: request.auth.breakGlass.reason } : null,
          after: response.locals?.audit?.after ?? null,
          before: response.locals?.audit?.before ?? null,
          // A raw upload's body is a Buffer, whose keys are one index per byte, so binary bodies list none.
          bodyKeys: request.body && typeof request.body === 'object' && !Array.isArray(request.body) && !ArrayBuffer.isView(request.body)
            ? Object.keys(request.body).sort()
            : [],
          method: request.method,
          policyDecisions: auditContext.policyDecisions,
          requestId: request.id ?? request.requestId ?? null,
          route: request.originalUrl ?? request.url ?? null,
          source: 'http',
          statusCode: response.statusCode,
          traceId: request.get?.('traceparent') ?? request.headers?.traceparent ?? request.id ?? request.requestId ?? null,
          dataClassification: response.locals?.audit?.dataClassification ?? 'internal',
        },
        ipAddress: requestIp(request),
        projectId: request.params?.projectId ?? null,
        result: response.statusCode >= 200 && response.statusCode < 400
          ? `success:${response.statusCode}`
          : `failure:${response.statusCode}`,
        tenantId: user.tenantId ?? null,
        userId: actor.id,
      };

      void auditWriter.append(event).catch((error) => {
        logBackendError({
          context: buildRequestLogContext(request, {
            auditAction: event.action,
            auditResult: event.result,
          }),
          error,
          level: 'error',
          message: 'Failed to append HTTP audit event.',
        });
      });
    });

    runWithAuditContext(auditContext, next);
  };
}
