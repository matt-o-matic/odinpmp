import { Router } from 'express';

import { createInMemoryWaitlistRepository } from './waitlist.repository.js';
import { waitlistSignupSchema } from './waitlist.schema.js';
import { createWaitlistSignup, notifyAccessRequest } from './waitlist.service.js';

// The public "Request access" form. Each address is kept once, the team is emailed about new
// requests, and the answer never says whether an address had asked before.

const LIMIT_PER_WINDOW = 5;
const WINDOW_MS = 60 * 60 * 1000;
const MAX_TRACKED_ADDRESSES = 10_000;

// Submissions per client address in the last hour, kept in memory for this process.
function createAttemptLimiter({ limit = LIMIT_PER_WINDOW, windowMs = WINDOW_MS, now = () => Date.now() } = {}) {
  const attempts = new Map();
  return function allow(key) {
    const at = now();
    const recent = (attempts.get(key) ?? []).filter((time) => at - time < windowMs);
    if (recent.length >= limit) {
      attempts.set(key, recent);
      return false;
    }
    recent.push(at);
    attempts.delete(key);
    attempts.set(key, recent);
    // Forget the least recently seen addresses rather than grow without bound.
    while (attempts.size > MAX_TRACKED_ADDRESSES) attempts.delete(attempts.keys().next().value);
    return true;
  };
}

export function createWaitlistRouter({ waitlistRepository, mailRepository, accessRequestNotifyEmails = [], waitlistRateLimit } = {}) {
  const router = Router();
  const repository = waitlistRepository ?? createInMemoryWaitlistRepository();
  const allow = createAttemptLimiter(waitlistRateLimit);

  router.post('/', async (request, response, next) => {
    try {
      if (!allow(request.ip ?? 'unknown')) {
        response.status(429).json({ ok: false, error: 'Too many requests from this connection. Try again in an hour.' });
        return;
      }

      const payload = waitlistSignupSchema.parse(request.body);
      // The hidden field only bots fill in: answer as if it worked, and keep nothing.
      if (payload.website.trim()) {
        response.status(201).json({ ok: true });
        return;
      }

      const { created, signup } = await createWaitlistSignup(payload, repository);
      if (created) {
        await notifyAccessRequest({ mailRepository, recipients: accessRequestNotifyEmails }, signup);
      }

      response.status(201).json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
