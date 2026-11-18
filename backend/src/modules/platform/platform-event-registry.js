import { HttpError } from '../../lib/errors/http-error.js';

const MAX_EVENT_BYTES = 64 * 1024;
const text = (value) => String(value ?? '').trim();

const definitions = Object.freeze({
  'agent.goal.attention': { required: ['goalId', 'kind', 'message', 'notificationId', 'severity', 'title'], version: '1.0.0' },
  'governance.changed': { required: ['action', 'entityType'], version: '1.0.0' },
  'workflow.sla.overdue': { required: ['historyId', 'itemId', 'itemType', 'projectId', 'slaDueAt', 'toState', 'transitionKey'], version: '1.0.0' },
  'workflow.transitioned': { required: ['historyId', 'itemId', 'itemType', 'projectId', 'toState', 'transitionKey'], version: '1.0.0' },
});

function normalizePayload(eventType, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new HttpError(422, `Event ${eventType} payload must be an object.`);
  const definition = definitions[eventType];
  const missing = definition.required.filter((name) => !text(payload[name]));
  if (missing.length) throw new HttpError(422, `Event ${eventType} payload is missing required fields: ${missing.join(', ')}.`);
  const normalized = structuredClone(payload); normalized.schemaVersion = definition.version;
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_EVENT_BYTES) throw new HttpError(413, `Event ${eventType} payload exceeds ${MAX_EVENT_BYTES} bytes.`);
  return normalized;
}

export const PLATFORM_EVENT_TYPES = Object.freeze(Object.keys(definitions));

export function createPlatformEventRegistry() {
  return Object.freeze({
    get(eventType) { const definition = definitions[eventType]; return definition ? { eventType, schemaUri: `urn:odin:event-schema:${eventType}:${definition.version}`, version: definition.version } : null; },
    list() { return PLATFORM_EVENT_TYPES.map((eventType) => this.get(eventType)); },
    normalize(event) {
      const definition = definitions[event?.eventType];
      if (!definition) throw new HttpError(400, 'Unsupported platform event type.');
      return { ...event, payload: normalizePayload(event.eventType, event.payload) };
    },
  });
}

export const DEFAULT_PLATFORM_EVENT_REGISTRY = createPlatformEventRegistry();
