import { createTokenBucket } from '../lib/http/token-bucket.js';

// How much MCP traffic Odin takes, and what it logs about it. Each request to /mcp builds a whole
// MCP server, so a client that floods the endpoint (ChatGPT's connector sent 300 to 640 requests
// a minute before each memory restart in October 2026) costs memory in proportion. Each grant
// gets a token bucket, and at most `maxInFlight` requests are handled at once across all grants;
// the rest wait briefly in line or are told to come back later.

export const DEFAULT_MCP_LIMITS = Object.freeze({
  // Per grant: a burst of 120 requests, then 4 a second. The in-flight cap is what bounds memory;
  // this keeps one connection from holding every slot.
  grant: { capacity: 120, refillPerSecond: 4 },
  maxInFlight: 6,
  maxQueued: 60,
  queueTimeoutMs: 10_000,
});

// A gate that lets `maxInFlight` holders through and lines up to `maxQueued` more, each for up to
// `timeoutMs`. acquire() resolves to a release function, or null when the line is full or the
// wait ran out. A release hands the slot straight to the next in line.
function createGate({ maxInFlight, maxQueued, timeoutMs }) {
  let active = 0;
  const queue = [];
  const releaser = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = queue.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve(releaser());
      } else {
        active -= 1;
      }
    };
  };
  return {
    acquire() {
      if (active < maxInFlight) {
        active += 1;
        return Promise.resolve(releaser());
      }
      if (queue.length >= maxQueued) return Promise.resolve(null);
      return new Promise((resolve) => {
        const entry = { resolve };
        entry.timer = setTimeout(() => {
          queue.splice(queue.indexOf(entry), 1);
          resolve(null);
        }, timeoutMs);
        entry.timer.unref?.();
        queue.push(entry);
      });
    },
    stats: () => ({ active, queued: queue.length }),
  };
}

export function createMcpTrafficLimiter({
  grant = DEFAULT_MCP_LIMITS.grant,
  maxInFlight = DEFAULT_MCP_LIMITS.maxInFlight,
  maxQueued = DEFAULT_MCP_LIMITS.maxQueued,
  now = () => Date.now(),
  queueTimeoutMs = DEFAULT_MCP_LIMITS.queueTimeoutMs,
} = {}) {
  const buckets = createTokenBucket({ ...grant, now });
  const gate = createGate({ maxInFlight, maxQueued, timeoutMs: queueTimeoutMs });
  return {
    /** Spends one request from the grant's bucket: { allowed, retryAfterSeconds }. */
    take: (grantKey) => buckets.take(`grant:${grantKey}`),
    /** Waits for a slot: a release function, or null when Odin is too busy to take the request. */
    acquire: () => gate.acquire(),
    stats: () => gate.stats(),
  };
}

const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : undefined);

/**
 * What a request asks of the MCP server, for the log: each JSON-RPC message's method, the tool a
 * tools/call names, and the client an initialize names. Never arguments, ids or results.
 */
export function describeMcpRequest(body) {
  const messages = (Array.isArray(body) ? body : [body]).filter((message) => message && typeof message === 'object');
  const methods = [];
  const tools = [];
  let client;
  for (const message of messages.slice(0, 20)) {
    const method = text(message.method, 80) ?? (message.result !== undefined || message.error !== undefined ? 'response' : 'unknown');
    methods.push(method);
    if (method === 'tools/call') {
      const tool = text(message.params?.name, 80);
      if (tool) tools.push(tool);
    }
    if (method === 'initialize') {
      const info = message.params?.clientInfo ?? {};
      client = { name: text(info.name, 80) ?? null, protocolVersion: text(message.params?.protocolVersion, 20) ?? null, version: text(info.version, 40) ?? null };
    }
  }
  return { ...(Array.isArray(body) ? { batch: messages.length } : {}), ...(client ? { client } : {}), methods, ...(tools.length ? { tools } : {}) };
}

/**
 * A JSON-RPC error reply for a request Odin turned away before the MCP server saw it, with the
 * HTTP status and Retry-After that tell a client when to come back.
 */
export function sendMcpRefusal(res, { message, retryAfterSeconds, status }) {
  res.setHeader('Retry-After', String(retryAfterSeconds));
  res.status(status).json({ error: { code: -32000, message }, id: null, jsonrpc: '2.0' });
}
