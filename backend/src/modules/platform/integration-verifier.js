function uniqueStrings(values = []) {
  return [...new Set((values ?? []).map((value) => String(value ?? '').trim()).filter(Boolean))];
}

function scopedIntegrationRecords({ criteria = {}, projectId = null, snapshot = {} } = {}) {
  const eventIds = new Set(uniqueStrings(criteria.eventIds));
  const eventTypes = new Set(uniqueStrings(criteria.eventTypes));
  const subscriptionIds = new Set(uniqueStrings(criteria.subscriptionIds));
  const subscriptions = (snapshot.subscriptions ?? []).filter((subscription) => (
    subscriptionIds.size === 0 || subscriptionIds.has(subscription.id)
  ));
  const allowedSubscriptionIds = new Set(subscriptions.map((subscription) => subscription.id));
  const deliveries = (snapshot.deliveries ?? []).filter((delivery) => {
    if (!allowedSubscriptionIds.has(delivery.subscriptionId)) return false;
    if (eventIds.size > 0 && !eventIds.has(delivery.eventId)) return false;
    if (eventTypes.size > 0 && !eventTypes.has(delivery.eventType)) return false;
    if (projectId && String(delivery.payload?.projectId ?? '') !== String(projectId)) return false;
    return true;
  });
  return { deliveries, subscriptions };
}

export function verifyIntegrationDelivery({ criteria = {}, projectId = null, snapshot = {} } = {}) {
  const { deliveries, subscriptions } = scopedIntegrationRecords({ criteria, projectId, snapshot });
  const dead = deliveries.filter((delivery) => delivery.status === 'dead');
  const pending = deliveries.filter((delivery) => ['pending', 'processing'].includes(delivery.status));
  const delivered = deliveries.filter((delivery) => delivery.status === 'delivered');
  const unhealthySubscriptions = subscriptions.filter((subscription) => {
    if (!subscription.enabled) return true;
    if (!subscription.lastFailureAt) return false;
    return !subscription.lastDeliveredAt || Date.parse(subscription.lastFailureAt) > Date.parse(subscription.lastDeliveredAt);
  });
  const duplicateKeys = deliveries.reduce((result, delivery) => {
    const key = `${delivery.subscriptionId}:${delivery.eventId}`;
    result.set(key, (result.get(key) ?? 0) + 1);
    return result;
  }, new Map());
  const duplicateCount = [...duplicateKeys.values()].filter((count) => count > 1).length;
  const checks = [
    { evidence: { deadCount: dead.length, deliveryIds: dead.map((item) => item.id) }, id: 'integration.no_dead_deliveries', message: dead.length ? `${dead.length} webhook delivery or deliveries are dead-lettered.` : 'No scoped webhook deliveries are dead-lettered.', passed: dead.length === 0 },
    { evidence: { pendingCount: pending.length }, id: 'integration.no_pending_deliveries', message: pending.length ? `${pending.length} webhook delivery or deliveries are still pending.` : 'No scoped webhook deliveries are pending.', passed: pending.length === 0 },
    { evidence: { deliveredCount: delivered.length, scopedDeliveryCount: deliveries.length }, id: 'integration.deliveries_succeeded', message: deliveries.length > 0 && delivered.length === deliveries.length ? 'Every scoped webhook delivery succeeded.' : 'One or more expected webhook deliveries have not succeeded.', passed: deliveries.length > 0 && delivered.length === deliveries.length },
    { evidence: { scopedSubscriptionCount: subscriptions.length, unhealthySubscriptionIds: unhealthySubscriptions.map((item) => item.id) }, id: 'integration.subscriptions_healthy', message: subscriptions.length > 0 && unhealthySubscriptions.length === 0 ? 'Every scoped webhook subscription is enabled and healthy.' : 'One or more scoped webhook subscriptions are unavailable or unhealthy.', passed: subscriptions.length > 0 && unhealthySubscriptions.length === 0 },
    { evidence: { duplicateCount }, id: 'integration.no_duplicate_deliveries', message: duplicateCount ? `${duplicateCount} duplicate subscription/event delivery key(s) exist.` : 'No duplicate subscription/event deliveries exist.', passed: duplicateCount === 0 },
  ];
  return {
    checks,
    failedCheckIds: checks.filter((check) => !check.passed).map((check) => check.id),
    passed: checks.every((check) => check.passed),
    summary: { deadCount: dead.length, deliveredCount: delivered.length, pendingCount: pending.length, scopedDeliveryCount: deliveries.length, scopedSubscriptionCount: subscriptions.length },
    verifier: 'integration.v1',
  };
}
