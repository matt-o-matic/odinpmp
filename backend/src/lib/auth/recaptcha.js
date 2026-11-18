import { HttpError } from '../errors/http-error.js';
import { logBackendEvent } from '../logging/backend-logger.js';

const SITEVERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify';

// The action the sign-up forms pass to grecaptcha.execute. A token made for another action,
// on this site or elsewhere, is refused.
export const SIGNUP_ACTION = 'signup';

// Google scores each visit from 0.0 (likely a bot) to 1.0 (likely a person) and suggests
// 0.5 as a starting threshold.
export const DEFAULT_MIN_SCORE = 0.5;

const REFUSED = 'We couldn’t confirm this sign-up came from a person. Reload the page and try again.';

function refusalReason(result, { minScore, score }) {
  if (result?.success !== true) return 'rejected';
  if (result.action !== SIGNUP_ACTION) return 'wrong action';
  if (score === null || score < minScore) return 'low score';
  return null;
}

// Checks a reCAPTCHA v3 token with Google. Without both keys there is nothing to check against,
// so this returns null and sign-ups rely on the honeypot alone (local development and tests).
export function createRecaptchaVerifier({ siteKey = '', secretKey = '', fetchImpl = globalThis.fetch, minScore = DEFAULT_MIN_SCORE, timeoutMs = 5000 } = {}) {
  if (!siteKey || !secretKey) return null;
  return {
    siteKey,
    async verify({ token = '', remoteIp = '' } = {}) {
      if (!token) throw new HttpError(400, REFUSED);
      let result;
      try {
        const response = await fetchImpl(SITEVERIFY_URL, {
          body: new URLSearchParams({ response: token, secret: secretKey, ...(remoteIp ? { remoteip: remoteIp } : {}) }),
          method: 'POST',
          signal: AbortSignal.timeout(timeoutMs),
        });
        result = await response.json();
      } catch (_error) {
        throw new HttpError(503, 'We couldn’t check the CAPTCHA. Try again in a moment.');
      }
      const score = typeof result?.score === 'number' ? result.score : null;
      const reason = refusalReason(result, { minScore, score });
      if (reason) {
        // The score helps decide whether the threshold is right.
        logBackendEvent({
          context: { action: result?.action ?? null, errorCodes: result?.['error-codes'] ?? [], hostname: result?.hostname ?? null, minScore, score },
          level: 'warn',
          message: `Sign-up refused by reCAPTCHA: ${reason}.`,
        });
        throw new HttpError(400, REFUSED);
      }
    },
  };
}

// Production without keys refuses sign-ups instead of letting them through unchecked.
export function createUnavailableRecaptchaVerifier() {
  return {
    siteKey: '',
    async verify() {
      throw new HttpError(503, 'Sign-up is temporarily unavailable.');
    },
  };
}
