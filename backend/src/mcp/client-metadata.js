import { z } from 'zod';
import { HttpError } from '../lib/errors/http-error.js';

const metadataSchema = z.object({
  client_id: z.string(), client_name: z.string().trim().min(1).max(120),
  redirect_uris: z.array(z.string().url().max(2048)).min(1).max(20),
  token_endpoint_auth_method: z.string().optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  grant_types: z.array(z.string()).optional(), response_types: z.array(z.string()).optional(),
});
function reject() {
  throw new HttpError(400, 'Invalid OAuth client.', { details: { error: 'invalid_client', error_description: 'Invalid OAuth client.' } });
}

// The Client ID Metadata Documents Odin fetches: each host and the exact document paths it serves.
const TRUSTED_METADATA_DOCUMENTS = Object.freeze([
  // ChatGPT and Codex.
  { origin: 'https://chatgpt.com', path: /^\/oauth\/(?:codex\/)?(?:[A-Za-z0-9_-]+\/)?client\.json$/ },
  // Claude's hosted apps (web, Desktop, mobile) and Claude Code.
  { origin: 'https://claude.ai', path: /^\/oauth\/(?:mcp-oauth|claude-code)-client-metadata$/ },
]);

export function isTrustedClientMetadataUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash && value === url.href
      && TRUSTED_METADATA_DOCUMENTS.some(({ origin, path }) => url.origin === origin && path.test(url.pathname));
  } catch { return false; }
}

export function matchesMetadataRedirect(registered, requested) {
  if (registered === requested) return true;
  const expected = new URL(registered), actual = new URL(requested);
  if (expected.protocol !== 'http:' || actual.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(expected.hostname)) return false;
  // Native OAuth clients choose a free loopback port when they start their callback listener.
  expected.port = ''; actual.port = '';
  return expected.href === actual.href;
}

export function createClientMetadataResolver({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const cache = new Map();
  return async function resolve(clientId) {
    // Only fetch the trusted metadata paths. Never follow redirects or fetch a supplied callback URL.
    if (!isTrustedClientMetadataUrl(clientId)) reject();
    const cached = cache.get(clientId);
    if (cached?.expiresAt > now()) return structuredClone(cached.value);
    let response, reader;
    try {
      response = await fetchImpl(clientId, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' } });
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) reject();
      reader = response.body.getReader();
      const chunks = []; let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 16 * 1024) reject();
        chunks.push(Buffer.from(value));
      }
      const value = metadataSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const methods = value.token_endpoint_auth_methods_supported ?? [value.token_endpoint_auth_method ?? 'none'];
      if (value.client_id !== clientId || !methods.includes('none')
        || (value.grant_types && !value.grant_types.includes('authorization_code'))
        || (value.response_types && !value.response_types.includes('code'))) reject();
      for (const uri of value.redirect_uris) {
        const url = new URL(uri);
        if (url.username || url.password || url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) reject();
      }
      if (cache.size >= 100) cache.delete(cache.keys().next().value);
      cache.set(clientId, { value, expiresAt: now() + 300_000 });
      return structuredClone(value);
    } catch { reject(); }
    finally {
      if (reader) await reader.cancel().catch(() => {});
      else await response?.body?.cancel().catch(() => {});
    }
  };
}
