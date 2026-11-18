// Mirrors oauthRedirectUri in backend/src/modules/platform/platform.schema.js so the form can
// explain a rejected URI before saving. The backend remains the authority.

export const MAX_REDIRECT_URIS = 20;
const MAX_REDIRECT_URI_LENGTH = 2000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

export function redirectUriError(value) {
  const candidate = String(value ?? '').trim();
  if (!candidate) return 'Enter a redirect URI.';
  if (candidate.length > MAX_REDIRECT_URI_LENGTH) return `Redirect URIs can be at most ${MAX_REDIRECT_URI_LENGTH} characters.`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return 'Enter a full URL, such as https://app.example.com/oauth/callback.';
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
  if (!secure) return 'Use HTTPS, or HTTP only for localhost, 127.0.0.1 or [::1].';
  if (url.username || url.password) return 'Redirect URIs can’t include a username or password.';
  if (url.hash) return 'Redirect URIs can’t include a #fragment.';
  return '';
}

// Returns { error, uris } after adding one URI to a list, rejecting duplicates and overflow.
export function addRedirectUri(list, value) {
  const uris = Array.isArray(list) ? list : [];
  const candidate = String(value ?? '').trim();
  const error = redirectUriError(candidate);
  if (error) return { error, uris };
  if (uris.includes(candidate)) return { error: 'That redirect URI is already listed.', uris };
  if (uris.length >= MAX_REDIRECT_URIS) return { error: `An application can have at most ${MAX_REDIRECT_URIS} redirect URIs.`, uris };
  return { error: '', uris: [...uris, candidate] };
}
