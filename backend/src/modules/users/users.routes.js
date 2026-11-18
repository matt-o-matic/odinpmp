import { Router } from 'express';
import { z } from 'zod';

import { createAuthMiddleware } from '../../lib/http/auth-middleware.js';
import { buildRequestLogContext } from '../../lib/logging/backend-logger.js';
import { confirmEmailChange } from './email-change.js';
import { killSessionSchema, updateProfileSchema } from './users.schema.js';
import {
  getUserProfileForUser,
  killUserSessionForUser,
  updateUserProfileForUser,
} from './users.service.js';

export function createUsersRouter({
  authRepository,
  emailChangeRepository = null,
  frontendAppUrl,
  mailRepository,
  sessionsRepository,
  tokenService,
  usersRepository,
}) {
  const router = Router();
  const emailChange = { emailChangeRepository, frontendAppUrl, mailRepository };
  const requireAuth = createAuthMiddleware({ authRepository, tokenService });

  router.use(requireAuth);

  router.get('/me', async (request, response, next) => {
    try {
      const result = await getUserProfileForUser(request.auth.user, usersRepository, sessionsRepository, emailChange);
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.put('/me', async (request, response, next) => {
    try {
      const payload = updateProfileSchema.parse(request.body);
      const result = await updateUserProfileForUser(
        request.auth.user,
        payload,
        usersRepository,
        authRepository,
        buildRequestLogContext(request),
        emailChange,
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/kill-session', async (request, response, next) => {
    try {
      const payload = killSessionSchema.parse(request.body);
      const result = await killUserSessionForUser(
        request.auth.user,
        payload.tgtSession,
        sessionsRepository,
        buildRequestLogContext(request),
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

const confirmEmailChangeSchema = z.object({ token: z.string().trim().min(16).max(200) }).strict();

/**
 * Mounted at /api/account/email-change. The emailed token is the credential, so confirming
 * needs no session; it comes in the body, never the URL.
 */
export function createEmailChangeRouter({ authRepository, emailChangeRepository = null, usersRepository }) {
  const router = Router();
  router.post('/confirm', async (request, response, next) => {
    try {
      const { token } = confirmEmailChangeSchema.parse(request.body ?? {});
      response.status(200).json(await confirmEmailChange({ authRepository, emailChangeRepository, usersRepository }, { token }));
    } catch (error) {
      next(error);
    }
  });
  return router;
}
