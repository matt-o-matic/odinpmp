import { HttpError } from '../../lib/errors/http-error.js';

const text = (value, max = 4000) => String(value ?? '').trim().slice(0, max);
const identifier = (payload) => text(payload.id ?? payload.key ?? payload.number ?? payload.iid ?? payload.event_id ?? payload.ts, 255);
const timestamp = (payload) => text(payload.updated_at ?? payload.updatedAt ?? payload.created_at ?? payload.createdAt ?? payload.timestamp, 80) || null;

function canonical(kind, payload, fields = {}) {
  const externalId = identifier(payload);
  if (!externalId) throw new HttpError(400, `Connector ${kind} payload requires an external id.`);
  return { externalId, fields, kind, occurredAt: timestamp(payload), schemaVersion: 'odin.connector-object.v1' };
}

const definitions = [
  ['jira', 'Jira', ['issues', 'projects', 'users', 'webhooks'], 'work_item'],
  ['azure_devops', 'Azure DevOps', ['work_items', 'projects', 'users', 'webhooks'], 'work_item'],
  ['github', 'GitHub', ['issues', 'pull_requests', 'projects', 'webhooks'], 'source_work'],
  ['gitlab', 'GitLab', ['issues', 'merge_requests', 'projects', 'webhooks'], 'source_work'],
  ['slack', 'Slack', ['channels', 'messages', 'users', 'events'], 'message'],
  ['microsoft_teams', 'Microsoft Teams', ['channels', 'messages', 'users', 'events'], 'message'],
  ['google_calendar', 'Google Calendar', ['calendars', 'events', 'attendees'], 'calendar_event'],
  ['microsoft_calendar', 'Microsoft Calendar', ['calendars', 'events', 'attendees'], 'calendar_event'],
  ['google_drive', 'Google Drive', ['documents', 'folders', 'permissions', 'changes'], 'document'],
  ['microsoft_sharepoint', 'Microsoft SharePoint', ['documents', 'sites', 'permissions', 'changes'], 'document'],
  ['netsuite', 'Oracle NetSuite', ['journal_entries', 'expenses', 'vendors', 'webhooks'], 'journal_entry'],
  ['sap_s4hana', 'SAP S/4HANA', ['journal_entries', 'expenses', 'vendors', 'events'], 'journal_entry'],
];

function normalize(kind, payload) {
  if (kind === 'work_item' || kind === 'source_work') return canonical(kind, payload, {
    assignee: text(payload.assignee?.displayName ?? payload.assignee?.login ?? payload.assigned_to?.name, 240),
    description: text(payload.description ?? payload.body), dueDate: text(payload.due_date ?? payload.dueDate, 32) || null,
    projectExternalId: text(payload.project?.id ?? payload.project_id ?? payload.repository?.id, 255), status: text(payload.status ?? payload.state, 120), title: text(payload.title ?? payload.fields?.summary, 500),
  });
  if (kind === 'message') return canonical(kind, payload, { channelExternalId: text(payload.channel_id ?? payload.channel?.id, 255), message: text(payload.text ?? payload.body?.content, 8000), senderExternalId: text(payload.user ?? payload.from?.user?.id, 255), threadExternalId: text(payload.thread_ts ?? payload.replyToId, 255) });
  if (kind === 'calendar_event') return canonical(kind, payload, { attendees: (payload.attendees ?? []).slice(0, 200).map((item) => text(item.emailAddress?.address ?? item.email, 320)).filter(Boolean), end: text(payload.end?.dateTime ?? payload.end, 80), start: text(payload.start?.dateTime ?? payload.start, 80), status: text(payload.status ?? payload.showAs, 120), title: text(payload.summary ?? payload.subject, 500) });
  if (kind === 'document') return canonical(kind, payload, { contentType: text(payload.mimeType ?? payload.file?.mimeType, 160), modifiedAt: text(payload.modifiedTime ?? payload.lastModifiedDateTime, 80), name: text(payload.name, 500), parentExternalId: text(payload.parentReference?.id ?? payload.parents?.[0], 255), webUrl: text(payload.webUrl ?? payload.webViewLink, 2000) });
  return canonical(kind, payload, { amount: Number(payload.amount ?? payload.total ?? payload.transactionAmount ?? 0), currency: text(payload.currency ?? payload.currencyCode ?? payload.transactionCurrency, 3).toUpperCase(), effectiveDate: text(payload.date ?? payload.postingDate ?? payload.transactionDate, 32), entryKind: text(payload.entryKind ?? payload.entry_kind ?? 'actual_cost', 32), memo: text(payload.memo ?? payload.description ?? payload.headerText), projectExternalId: text(payload.projectId ?? payload.project?.id ?? payload.assignmentReference, 255), sourceType: text(payload.type ?? payload.recordType ?? 'journal_entry', 120) });
}

export function createConnectorAdapterRegistry() {
  const adapters = new Map(definitions.map(([key, name, capabilities, kind]) => [key, Object.freeze({
    catalog: Object.freeze({ adapterVersion: '1.0.0', authTypes: ['oauth2', 'pat', 'webhook'], capabilities, key, name }),
    normalizeInbound({ eventType, payload }) { return { eventType: text(eventType, 160), object: normalize(kind, payload) }; },
  })]));
  return Object.freeze({
    get(provider) { return adapters.get(provider) ?? null; },
    listCatalog() { return [...adapters.values()].map((adapter) => adapter.catalog); },
    normalizeInbound(provider, input) { const adapter = adapters.get(provider); if (!adapter) throw new HttpError(400, 'Unsupported connector provider.'); return adapter.normalizeInbound(input); },
    size: adapters.size,
  });
}

export const DEFAULT_CONNECTOR_ADAPTER_REGISTRY = createConnectorAdapterRegistry();
