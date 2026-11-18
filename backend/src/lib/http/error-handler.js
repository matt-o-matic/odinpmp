import { ZodError } from 'zod';

import { HttpError } from '../errors/http-error.js';
import { buildRequestLogContext, logBackendError } from '../logging/backend-logger.js';

export function errorHandler(error, request, response, _next) {
  // A service's own 413 HttpError keeps its specific message (handled below).
  if (error?.type === 'entity.too.large' || (error?.statusCode === 413 && !(error instanceof HttpError))) {
    logBackendError({
      context: buildRequestLogContext(request),
      error,
      level: 'warn',
      message: 'Request body exceeded the configured size limit.',
    });
    response.status(413).json({
      ok: false,
      error: 'Request body is too large.',
    });
    return;
  }

  if (error?.type && Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
    logBackendError({
      context: buildRequestLogContext(request),
      error,
      level: 'warn',
      message: 'Request body could not be read.',
    });
    response.status(error.status).json({
      ok: false,
      error: 'Invalid request body.',
    });
    return;
  }

  if (error instanceof ZodError) {
    logBackendError({
      context: buildRequestLogContext(request),
      error,
      level: 'warn',
      message: 'Request payload validation failed.',
    });
    response.status(400).json({
      ok: false,
      error: 'Invalid request payload.',
      details: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
    return;
  }

  if (error instanceof HttpError) {
    logBackendError({
      context: buildRequestLogContext(request),
      error,
      level: error.statusCode >= 500 ? 'error' : 'warn',
      message: 'HTTP request failed.',
    });
    response.status(error.statusCode).json({
      ok: false,
      error: error.message,
      details: error.details,
    });
    return;
  }

  logBackendError({
    context: buildRequestLogContext(request),
    error,
    message: 'Unhandled request error.',
  });
  response.status(500).json({
    ok: false,
    error: 'Internal server error.',
  });
}
