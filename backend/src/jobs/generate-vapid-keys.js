import { generateVapidKeys } from '../modules/notifications/web-push.js';

// Prints a new VAPID key pair for Web Push (npm run job:generate-vapid-keys), as the lines to put
// in the backend settings. Run it once per environment; changing the keys later turns off every
// device's notifications until it turns them on again. Nothing is stored.

const { privateKey, publicKey } = generateVapidKeys();
process.stdout.write(`WEB_PUSH_VAPID_PUBLIC_KEY=${publicKey}\nWEB_PUSH_VAPID_PRIVATE_KEY=${privateKey}\nWEB_PUSH_SUBJECT=mailto:replace-with-an-ops-address\n`);
