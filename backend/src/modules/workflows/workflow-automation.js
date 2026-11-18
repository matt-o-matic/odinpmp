function eventPayload(candidate, now) {
  const history = candidate.history;
  return {
    fromState: history.fromState,
    historyId: history.id,
    itemId: history.itemId,
    itemType: history.itemType,
    occurredAt: history.occurredAt,
    projectId: history.projectId,
    slaDueAt: history.slaDueAt,
    ...(candidate.eventType === 'workflow.sla.overdue' ? {
      overdueByMinutes: Math.max(0, Math.floor((now.getTime() - Date.parse(history.slaDueAt)) / 60_000)),
    } : {}),
    toState: history.toState,
    transitionKey: history.transitionKey,
  };
}

export async function materializeWorkflowAutomationEvents({
  domainEventOutboxRepository,
  limit = 200,
  now = new Date(),
  workflowRepository,
} = {}) {
  if (!domainEventOutboxRepository || !workflowRepository?.listPendingAutomationEvents) return [];
  const candidates = await workflowRepository.listPendingAutomationEvents({ limit, now });
  const results = [];
  for (const candidate of candidates) {
    const history = candidate.history;
    const enqueued = await domainEventOutboxRepository.enqueue({
      eventType: candidate.eventType,
      idempotencyKey: `${candidate.eventType}:${history.id}`,
      payload: eventPayload(candidate, now),
      projectId: history.projectId,
      tenantId: history.tenantId,
    });
    await workflowRepository.markAutomationEventEnqueued({
      enqueuedAt: now,
      eventType: candidate.eventType,
      historyId: history.id,
    });
    results.push({ created: enqueued.created, eventId: enqueued.event.id, eventType: candidate.eventType, historyId: history.id });
  }
  return results;
}
