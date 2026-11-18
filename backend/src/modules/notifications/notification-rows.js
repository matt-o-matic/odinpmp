// How notifications rows read from MySQL (migration 0102), shared by the notifications and
// digest repositories.

export const iso = (value) => (value ? new Date(value).toISOString() : null);

export const NOTIFICATION_COLUMNS = `id, tenant_id, principal_type, principal_id, kind, project_id, channel_id, conversation_id, post_id, thread_id,
  file_id, item_id, actor_type, actor_id, summary_json, collapse_key, collapse_count, read_at, digest_state, digest_after,
  digest_delivery_id, digest_sent_at, digest_error, created_at, updated_at`;

export function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value ?? '{}'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function notificationFromRow(row) {
  return {
    actorId: row.actor_id,
    actorType: row.actor_type,
    channelId: row.channel_id ?? null,
    collapseCount: Number(row.collapse_count ?? 1),
    collapseKey: row.collapse_key ?? null,
    conversationId: row.conversation_id ?? null,
    createdAt: iso(row.created_at),
    digestAfter: iso(row.digest_after),
    digestDeliveryId: row.digest_delivery_id ?? null,
    digestError: row.digest_error ?? '',
    digestSentAt: iso(row.digest_sent_at),
    digestState: row.digest_state,
    fileId: row.file_id ?? null,
    id: row.id,
    itemId: row.item_id ?? null,
    kind: row.kind,
    postId: row.post_id ?? null,
    principalId: row.principal_id,
    principalType: row.principal_type,
    projectId: row.project_id ?? null,
    readAt: iso(row.read_at),
    summary: parseJsonObject(row.summary_json),
    tenantId: row.tenant_id,
    threadId: row.thread_id ?? null,
    updatedAt: iso(row.updated_at),
  };
}
