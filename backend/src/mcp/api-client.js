const ERROR_MESSAGES = {
  400: 'Odin rejected the request. Check field values and hierarchy.',
  401: 'Odin credential is invalid, expired, or revoked. Authenticate again or renew the client credential.',
  403: 'Odin denied this operation for the current user.',
  404: 'Odin resource was not found or is not accessible to the current user.',
  409: 'Odin reported a conflict. Read the latest state before retrying.',
  413: 'Odin request or response exceeds the supported size.',
  429: 'Odin rate limit reached. Wait before trying again.',
};

// Odin refusals a tool can act on. Only the code is read from the reply; the message is fixed
// here, so upstream text still never reaches the model.
const KNOWN_REFUSALS = {
  billing_not_allowed: 'Billing is shown to project admins and managers, and workspace admins and managers. Ask one of them.',
  channel_archived: 'That channel is archived, so its files and folders are read-only. Ask someone with decision rights to restore it first.',
  file_not_in_tree: 'This file belongs to a work item or a requirements topic, not to the project\'s files or a channel library, so it cannot be moved or renamed here.',
  decision_rights_required: 'Only a project admin or manager (or a workspace admin or manager) can do this. Ask one of them.',
  folder_cycle: 'A folder cannot go inside itself or one of its own folders.',
  folder_name_taken: 'A folder with that name is already there. Choose another name, or use the folder that is there.',
  folder_not_empty: 'That folder still has files or folders in it. Move them out first: only an empty folder can be deleted.',
  guest_is_member: 'This person is a member of the workspace, so they join the project instead of a channel: add them with odin_update_project_members.',
  guest_name_required: 'This person is not a stakeholder on the project yet. Pass their name so Odin can add them.',
  guests_will_see:'Moving the file there shows it to guests from outside the team in that channel. Ask the user, then call again with shareWithGuests: true.',
  invalid_folder: 'That folder is not in that channel. List the folders with odin_list_file_folders.',
  billing_not_linked: 'This project has no SOW linked from invoice-gen, so there are no milestones to assign. Link the SOW in invoice-gen first.',
  invalid_assignments: 'Some assignments name a story that is not on this project, a milestone the SOW does not have, or the same story twice. Read the milestones and stories with odin_get_project_billing and try again.',
  module_disabled: 'The Consulting module is switched off for this workspace, so billing is not available.',
  time_entry_invoiced: 'This time entry is on an invoice, so nobody can change or delete it. Void the invoice or take the entry off the draft in invoice-gen first.',
};

export class OdinApiError extends Error {
  constructor(status, code, message, { details, outcomeUnknown = false } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.outcomeUnknown = outcomeUnknown;
    // Built by MCP tools only; upstream response bodies never populate details.
    if (details !== undefined) this.details = details;
  }
}

export function createOdinApiClient({ baseUrl, token, fetchImpl = fetch, timeoutMs = 15000, maxResponseBytes = 8 * 1024 * 1024, internalProof }) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new Error('ODIN_MCP_BASE_URL must be an absolute Odin origin URL.'); }
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || !['', '/'].includes(base.pathname)) {
    throw new Error('ODIN_MCP_BASE_URL must be an HTTP(S) origin without credentials, path, query, or fragment.');
  }
  if (base.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) {
    throw new Error('Use HTTPS for Odin except on loopback local test servers.');
  }
  if (typeof token !== 'string' || !token.trim() || /\s/.test(token)) throw new Error('ODIN_MCP_ACCESS_TOKEN must contain an existing Odin session token.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('Invalid request timeout.');
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1) throw new Error('Invalid response size limit.');

  return {
    // okFalseIsResult: the route answers ok: false for a result that is not wholly a success (a
    // batch with a stale change), not for an error, so the reply comes back instead of a 400.
    async request(method, pathname, { body, okFalseIsResult = false, query = {} } = {}) {
      // Tools construct fixed routes; never accept an arbitrary destination from a tool call.
      if (!pathname.startsWith('/api/') || /[?#\\]/.test(pathname) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(pathname)) throw new Error('Invalid Odin API route.');
      const url = new URL(base.origin + pathname);
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
      }
      const serialized = body === undefined ? undefined : JSON.stringify(body);
      if (serialized && Buffer.byteLength(serialized) > 1024 * 1024) throw new OdinApiError(413, 'request_too_large', ERROR_MESSAGES[413]);
      const write = method !== 'GET';
      try {
        const response = await fetchImpl(url, {
          method, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
          headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(serialized ? { 'Content-Type': 'application/json' } : {}),
            ...(internalProof ? { 'X-Odin-MCP-Internal': internalProof({ token, method, path: url.pathname + url.search }) } : {}) },
          body: serialized,
        });
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          throw new OdinApiError(response.status, 'redirect_rejected', 'Odin redirected the request. Check the configured origin; redirects are not followed.', { outcomeUnknown: write });
        }
        let size = 0;
        const chunks = [];
        for await (const chunk of response.body ?? []) {
          size += chunk.byteLength;
          if (size > maxResponseBytes) throw new OdinApiError(413, 'response_too_large', 'Odin response is too large. Narrow the query.', { outcomeUnknown: write && (response.ok || response.status >= 500) });
          chunks.push(Buffer.from(chunk));
        }
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
          if (response.ok) throw new OdinApiError(response.status, 'invalid_response', 'Odin returned an invalid JSON response.', { outcomeUnknown: write });
        }
        if (response.ok && (!data || typeof data !== 'object' || Array.isArray(data))) {
          throw new OdinApiError(response.status, 'invalid_response', 'Odin returned an invalid JSON response.', { outcomeUnknown: write });
        }
        if (!response.ok || (data?.ok === false && !okFalseIsResult)) {
          const status = response.ok ? 400 : response.status;
          const known = Object.hasOwn(KNOWN_REFUSALS, data?.details?.code ?? '') ? data.details.code : null;
          if (known) throw new OdinApiError(status, known, KNOWN_REFUSALS[known]);
          // Return actionable classifications, never raw upstream text, HTML, secrets, or stack traces.
          throw new OdinApiError(status, `http_${status}`, ERROR_MESSAGES[status] ?? 'Odin could not complete the request.', { outcomeUnknown: write && status >= 500 });
        }
        return data;
      } catch (error) {
        if (error instanceof OdinApiError) throw error;
        const timeout = ['TimeoutError', 'AbortError'].includes(error?.name);
        throw new OdinApiError(null, timeout ? 'timeout' : 'network_error', timeout ? 'Odin request timed out.' : 'Cannot reach the configured Odin API.', { outcomeUnknown: write });
      }
    },
  };
}
