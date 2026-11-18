const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const GOOGLE_SCOPE = 'email profile';

function buildGoogleOAuthError(stage, message, extras = {}) {
  const error = new Error(message);
  error.googleOAuthStage = stage;
  error.googleOAuthProviderError = extras.providerError ?? '';
  error.googleOAuthProviderDescription = extras.providerDescription ?? '';
  error.googleOAuthStatus = extras.status ?? null;
  return error;
}

export function createGoogleOAuthClient({
  clientId,
  clientSecret,
  redirectUri,
}) {
  const configured = Boolean(clientId && clientSecret && redirectUri);

  function assertConfigured() {
    if (!configured) {
      throw new Error('Google OAuth is not configured.');
    }
  }

  function getAuthorizationUrl({ state } = {}) {
    assertConfigured();

    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', GOOGLE_SCOPE);
    url.searchParams.set('access_type', 'online');
    url.searchParams.set('include_granted_scopes', 'true');
    url.searchParams.set('prompt', 'select_account');
    if (state) {
      url.searchParams.set('state', state);
    }

    return url.toString();
  }

  async function getUserInfoFromCode(code) {
    assertConfigured();

    const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenResponse.ok) {
      const details = await tokenResponse.text();
      let providerError = '';
      let providerDescription = '';

      try {
        const parsed = JSON.parse(details);
        providerError = typeof parsed.error === 'string' ? parsed.error : '';
        providerDescription = typeof parsed.error_description === 'string' ? parsed.error_description : '';
      } catch (_error) {
        providerDescription = details;
      }

      throw buildGoogleOAuthError(
        'token',
        `Google token exchange failed. ${details}`,
        {
          providerDescription,
          providerError,
          status: tokenResponse.status,
        },
      );
    }

    const tokenPayload = await tokenResponse.json();
    const userResponse = await fetch(GOOGLE_USERINFO_URL, {
      headers: {
        Authorization: `Bearer ${tokenPayload.access_token}`,
      },
    });

    if (!userResponse.ok) {
      const details = await userResponse.text();
      throw buildGoogleOAuthError(
        'userinfo',
        `Google user lookup failed. ${details}`,
        {
          providerDescription: details,
          status: userResponse.status,
        },
      );
    }

    const user = await userResponse.json();

    return {
      email: user.email,
      emailVerified: user.verified_email === true,
      name: user.name ?? user.email,
      picture: user.picture ?? '',
    };
  }

  return {
    configured,
    getAuthorizationUrl,
    getUserInfoFromCode,
  };
}
