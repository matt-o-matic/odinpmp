// reCAPTCHA v3: no checkbox. Google scores the visit in the background, and the form sends a
// fresh token with each submission. The server checks the score and the action.
export const SIGNUP_ACTION = 'signup';

let loading = null;

function loadRecaptcha(siteKey) {
  if (window.grecaptcha?.execute) return Promise.resolve(window.grecaptcha);
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(siteKey)}`;
    script.async = true;
    script.onload = () => window.grecaptcha.ready(() => resolve(window.grecaptcha));
    script.onerror = () => {
      loading = null;
      script.remove();
      reject(new Error('The CAPTCHA couldn’t load. Check your connection and try again.'));
    };
    document.head.append(script);
  });
  return loading;
}

export function createSignupCaptcha(apiClient) {
  let siteKey = null;

  return {
    // Fetches the site key and starts loading Google's script, so the score can take the
    // visit into account before the form is sent.
    async load() {
      try {
        siteKey = (await apiClient.getSignupConfig()).recaptchaSiteKey || null;
      } catch (_error) {
        // The server still checks; a missing site key only means the form submits without a token.
        siteKey = null;
      }
      if (siteKey) loadRecaptcha(siteKey).catch(() => {});
    },
    // A token for one submission, or '' when the server has no site key. Tokens are
    // single-use and expire after two minutes, so get one for each submission.
    async token() {
      if (!siteKey) return '';
      const grecaptcha = await loadRecaptcha(siteKey);
      return grecaptcha.execute(siteKey, { action: SIGNUP_ACTION });
    },
  };
}
