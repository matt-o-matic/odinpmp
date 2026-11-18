import { AsyncLocalStorage } from 'node:async_hooks';

// How the current request reached Odin, for the project change log's `via`: 'app' for a person in
// Odin, 'assistant' for Odin's assistant acting for them, 'mcp:<client>' for an MCP connection,
// 'api:<application>' for an OAuth application such as Bug Reporter.
// The auth middleware sets it for the rest of the request. Outside a request it is null, and
// changes are recorded as 'system'.

const storage = new AsyncLocalStorage();

export function runWithRequestChannel(channel, callback) {
  return storage.run(channel, callback);
}

export function currentRequestChannel() {
  return storage.getStore() ?? null;
}

const slug = (name) => String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/** An MCP connection's channel, named from its client registration: "ChatGPT" is mcp:chatgpt. */
export function mcpChannel(clientName) {
  return `mcp:${slug(clientName) || 'client'}`;
}

/** An OAuth application's channel: "Bug Reporter" is api:bug-reporter. */
export function apiChannel(applicationName) {
  return `api:${slug(applicationName) || 'application'}`;
}
