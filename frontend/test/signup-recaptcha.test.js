import assert from 'node:assert/strict';
import test from 'node:test';

import { createSignupCaptcha, SIGNUP_ACTION } from '../src/lib/auth/recaptcha.js';

// A stand-in for the browser: appending Google's script "loads" a grecaptcha v3 object.
function fakeBrowser() {
  const scripts = [];
  const executed = [];
  globalThis.window = globalThis;
  globalThis.document = {
    createElement: () => ({ remove() {} }),
    head: {
      append(script) {
        scripts.push(script.src);
        globalThis.grecaptcha = {
          execute: async (siteKey, options) => { executed.push({ options, siteKey }); return `token-${executed.length}`; },
          ready: (callback) => callback(),
        };
        queueMicrotask(() => script.onload());
      },
    },
  };
  return { executed, scripts };
}

test('with a site key, each submission gets a fresh v3 token for the sign-up action', async () => {
  const browser = fakeBrowser();
  try {
    const captcha = createSignupCaptcha({ async getSignupConfig() { return { recaptchaSiteKey: 'site-key' }; } });
    await captcha.load();
    assert.deepEqual(browser.scripts, ['https://www.google.com/recaptcha/api.js?render=site-key']);
    assert.equal(await captcha.token(), 'token-1');
    assert.equal(await captcha.token(), 'token-2');
    assert.equal(browser.scripts.length, 1);
    assert.deepEqual(browser.executed, [
      { options: { action: SIGNUP_ACTION }, siteKey: 'site-key' },
      { options: { action: SIGNUP_ACTION }, siteKey: 'site-key' },
    ]);
  } finally {
    delete globalThis.grecaptcha; delete globalThis.document; delete globalThis.window;
  }
});

test('without a site key, nothing loads and the form sends no token', async () => {
  const browser = fakeBrowser();
  try {
    for (const getSignupConfig of [async () => ({ recaptchaSiteKey: null }), async () => { throw new Error('offline'); }]) {
      const captcha = createSignupCaptcha({ getSignupConfig });
      await captcha.load();
      assert.equal(await captcha.token(), '');
    }
    assert.deepEqual(browser.scripts, []);
  } finally {
    delete globalThis.grecaptcha; delete globalThis.document; delete globalThis.window;
  }
});
