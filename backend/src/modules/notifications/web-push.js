import webpush from 'web-push';

import { buildOperationLogContext, logBackendError } from '../../lib/logging/backend-logger.js';

// Web Push to people's browsers and phones.
//
// - Push is on only with all three settings: WEB_PUSH_VAPID_PUBLIC_KEY, WEB_PUSH_VAPID_PRIVATE_KEY
//   and WEB_PUSH_SUBJECT (a mailto: or https: address the push services can reach us at).
// - Nobody is pushed while they have an Odin tab focused (the stream's focus heartbeat).
// - A 404 or 410 from the push service means the subscription is gone: it is expired. Any other
//   failure is tried twice more, then given up; the bell and the email digest still have it.
// - Odin posts only to the push services' own addresses, never to an address a browser made up.

export const PUSH_TTL_SECONDS = 60 * 60;
const GONE_STATUSES = new Set([404, 410]);
// The hosts of the browsers' push services: Chrome and Edge's FCM, Firefox's autopush, Apple's
// Web Push and Windows notifications.
const PUSH_SERVICE_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];

export function isPushServiceEndpoint(endpoint) {
  try {
    const url = new URL(String(endpoint));
    return url.protocol === 'https:' && PUSH_SERVICE_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

export function webPushConfigured(config = {}) {
  return Boolean(config?.publicKey && config?.privateKey && config?.subject);
}

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

/**
 * deliver(principal, message) sends `message` ({ title, body, url, tag, notificationId }) to each
 * of the principal's subscriptions unless they have Odin focused. Sends run in the background;
 * drain() waits for them (tests and shutdown).
 */
export function createPushSender({
  config = {},
  endpointAllowed = isPushServiceEndpoint,
  now = () => new Date(),
  repository,
  retryDelaysMs = [1000, 5000],
  sendNotification = (subscription, payload, options) => webpush.sendNotification(subscription, payload, options),
  sleep = wait,
} = {}) {
  const enabled = webPushConfigured(config) && Boolean(repository?.listPushSubscriptions);
  const pending = new Set();
  const vapidDetails = enabled ? { privateKey: config.privateKey, publicKey: config.publicKey, subject: config.subject } : null;

  async function sendOne(subscription, payload, urgency) {
    const target = { endpoint: subscription.endpoint, keys: { auth: subscription.keys?.auth, p256dh: subscription.keys?.p256dh } };
    for (let attempt = 0; ; attempt += 1) {
      try {
        await sendNotification(target, payload, { TTL: PUSH_TTL_SECONDS, urgency, vapidDetails });
        await repository.touchPushSubscription({ id: subscription.id, now: now() });
        return 'sent';
      } catch (error) {
        if (GONE_STATUSES.has(Number(error?.statusCode))) {
          await repository.expirePushSubscription({ id: subscription.id, now: now() });
          return 'removed';
        }
        if (attempt >= retryDelaysMs.length) {
          logBackendError({ context: buildOperationLogContext('notifications.push', { statusCode: error?.statusCode ?? null, subscriptionId: subscription.id }), error, level: 'warn', message: 'A push could not be delivered after its retries.' });
          return 'failed';
        }
        await sleep(retryDelaysMs[attempt]);
      }
    }
  }

  async function deliverNow(principal, message) {
    const summary = { failed: 0, removed: 0, sent: 0, skipped: null };
    if (!enabled) return { ...summary, skipped: 'off' };
    if (await repository.isFocused({ now: now(), principalId: principal.principalId, principalType: principal.principalType })) return { ...summary, skipped: 'focused' };
    const subscriptions = await repository.listPushSubscriptions(principal);
    if (!subscriptions.length) return { ...summary, skipped: 'none' };
    const payload = JSON.stringify(message);
    const urgency = message.kind === 'channel_post' ? 'normal' : 'high';
    for (const subscription of subscriptions) summary[await sendOne(subscription, payload, urgency)] += 1;
    return summary;
  }

  return {
    enabled,
    endpointAllowed,
    publicKey: enabled ? config.publicKey : '',
    deliver(principal, message) {
      const run = deliverNow(principal, message).catch((error) => {
        logBackendError({ context: buildOperationLogContext('notifications.push', { principalType: principal.principalType }), error, level: 'warn', message: 'Push delivery failed.' });
        return null;
      });
      pending.add(run);
      run.finally(() => pending.delete(run));
      return run;
    },
    async drain() {
      while (pending.size) await Promise.all([...pending]);
    },
  };
}

export function generateVapidKeys() {
  return webpush.generateVAPIDKeys();
}
