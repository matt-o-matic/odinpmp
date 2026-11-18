import 'dotenv/config';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import nodemailer from 'nodemailer';

import { loadEnv } from '../config/env.js';
import { createMysqlPool } from '../lib/db/mysql.js';
import { buildJobLogContext, logBackendError, logBackendEvent } from '../lib/logging/backend-logger.js';
import { createMysqlAssistantRepository } from '../modules/assistant/assistant.repository.js';
import { createMysqlAccessRepository } from '../modules/access/access.repository.js';
import { createMysqlAuthRepository } from '../modules/auth/auth.repository.js';
import { createGuestNotificationDirectory } from '../modules/guests/guest-notifications.js';
import { createMysqlWorkspaceModulesRepository } from '../modules/workspace-modules/workspace-modules.repository.js';
import { flushDueClarificationInvitationDigests } from '../modules/assistant/clarification-invitation-digest.service.js';
import { createMysqlMailRepository } from '../modules/mail/mail.repository.js';
import { flushDueChatDigests } from '../modules/notifications/chat-digest.service.js';
import { createMysqlNotificationsRepository } from '../modules/notifications/notifications.repository.js';
import { createMysqlProjectsRepository } from '../modules/projects/projects.repository.js';
import { attachRequirementsBridge, createRequirementsAssistantBridge } from '../modules/requirements/requirements-bridge.js';
import { createMysqlRequirementsRepository } from '../modules/requirements/requirements.repository.js';
import { flushDueMentionDigests } from '../modules/requirements/mentions/mention-digest.service.js';
import { createMysqlMentionsRepository } from '../modules/requirements/mentions/mentions.repository.js';
import { createMysqlRoundsRepository } from '../modules/requirements/rounds/rounds.repository.js';
import { processMailQueueBatch } from './process-mail-queue.lib.js';

export const JOB_NAME = 'mail-queue';

async function acquireLock(lockName) {
  const lockPath = path.join(os.tmpdir(), lockName);

  try {
    const existing = await fs.readFile(lockPath, 'utf8').catch(() => '');
    if (existing) {
      // If a lock exists, treat it as active for a short window.
      const stat = await fs.stat(lockPath).catch(() => null);
      const ageMs = stat ? Date.now() - stat.mtimeMs : 0;
      if (ageMs < 15 * 60 * 1000) {
        return { acquired: false, lockPath };
      }
    }
  } catch {
    // ignore
  }

  await fs.writeFile(lockPath, String(process.pid), 'utf8');
  return { acquired: true, lockPath };
}

async function releaseLock(lockPath) {
  try {
    await fs.unlink(lockPath);
  } catch {
    // ignore
  }
}

function createTransport(env) {
  if (!env.smtpHost) {
    throw new Error('SMTP_HOST is not set.');
  }

  return nodemailer.createTransport({
    auth: env.smtpUser ? { user: env.smtpUser, pass: env.smtpPass } : undefined,
    host: env.smtpHost,
    port: env.smtpPort || 587,
    secure: false,
    tls: env.smtpStartTls ? { rejectUnauthorized: false } : undefined,
  });
}

export { createTransport };

export async function main() {
  const env = loadEnv(process.env);
  if (!env.databaseUrl) {
    throw new Error('DATABASE_URL is required to process the mail queue.');
  }

  const { acquired, lockPath } = await acquireLock('odinpmp-mail-queue.lock');
  if (!acquired) {
    logBackendEvent({
      context: buildJobLogContext(JOB_NAME, { lockPath }),
      message: 'Mail queue run skipped because another worker holds the lock.',
    });
    return;
  }

  const pool = createMysqlPool(env.databaseUrl);
  const assistantRepository = createMysqlAssistantRepository({ pool });
  const mailRepository = createMysqlMailRepository({ pool });
  const projectRepository = createMysqlProjectsRepository({ pool });
  const requirementsRepository = createMysqlRequirementsRepository({ pool });
  // Digest delivery issues client portal links, which needs only the repository.
  attachRequirementsBridge(assistantRepository, createRequirementsAssistantBridge({
    frontendAppUrl: env.frontendAppUrl,
    requirementsRepository,
  }));
  const logger = {
    logError({ context = {}, ...rest } = {}) {
      logBackendError({
        ...rest,
        context: buildJobLogContext(JOB_NAME, context),
      });
    },
    logEvent({ context = {}, ...rest } = {}) {
      logBackendEvent({
        ...rest,
        context: buildJobLogContext(JOB_NAME, context),
      });
    },
  };

  try {
    const transport = createTransport(env);
    // Due clarification digests are claimed, re-checked, rendered and sent directly; they do
    // not pass through the shared queue. A digest failure does not stop queued mail.
    try {
      const digests = await flushDueClarificationInvitationDigests({
        assistantRepository,
        env,
        frontendAppUrl: env.frontendAppUrl,
        logger,
        mailReplyDomain: env.mailReplyDomain,
        mailRepository,
        projectRepository,
        quietMinutes: env.clarificationDigestQuietMinutes,
        transport,
      });
      if (digests.due) logger.logEvent({ context: digests, message: 'Clarification digests processed.' });
    } catch (error) {
      logger.logError({ error, level: 'warn', message: 'Clarification digests could not be processed; queued mail is still sent.' });
    }
    // Mention digests follow the same rules and quiet period, and fail independently.
    try {
      const mentions = await flushDueMentionDigests({
        assistantRepository,
        authRepository: createMysqlAuthRepository({ pool }),
        env,
        frontendAppUrl: env.frontendAppUrl,
        logger,
        mailRepository,
        mentionsRepository: createMysqlMentionsRepository({ pool }),
        projectRepository,
        quietMinutes: env.clarificationDigestQuietMinutes,
        roundsRepository: createMysqlRoundsRepository({ pool }),
        transport,
      });
      if (mentions.due) logger.logEvent({ context: mentions, message: 'Mention digests processed.' });
    } catch (error) {
      logger.logError({ error, level: 'warn', message: 'Mention digests could not be processed; queued mail is still sent.' });
    }
    // The rolled-up chat email, under the same rules.
    try {
      const chat = await flushDueChatDigests({
        authRepository: createMysqlAuthRepository({ pool }),
        env,
        frontendAppUrl: env.frontendAppUrl,
        // Guests by workspace access link, with their real channel links, as the app has them.
        guestDirectory: createGuestNotificationDirectory({
          accessRepository: createMysqlAccessRepository({ pool }),
          assistantRepository,
          projectRepository,
          workspaceModulesRepository: createMysqlWorkspaceModulesRepository({ pool }),
        }),
        logger,
        mailRepository,
        notificationsRepository: createMysqlNotificationsRepository({ pool }),
        projectRepository,
        quietMinutes: env.clarificationDigestQuietMinutes,
        transport,
      });
      if (chat.due) logger.logEvent({ context: chat, message: 'Chat digests processed.' });
    } catch (error) {
      logger.logError({ error, level: 'warn', message: 'Chat digests could not be processed; queued mail is still sent.' });
    }

    await processMailQueueBatch({
      assistantRepository,
      env,
      logger,
      mailRepository,
      transport,
    });
  } finally {
    await releaseLock(lockPath);
    await pool.end();
  }
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  main().catch((error) => {
    logBackendError({
      context: buildJobLogContext(JOB_NAME),
      error,
      message: 'Mail queue job failed.',
    });
    process.exitCode = 1;
  });
}
