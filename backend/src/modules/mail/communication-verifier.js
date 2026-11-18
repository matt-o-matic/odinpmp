function check(id, passed, evidence) {
  return { evidence, id, passed: Boolean(passed) };
}

export function verifyCommunicationDelivery({ criteria = {}, deliveries = [], notifications = [] } = {}) {
  const requireEmail = criteria.requireEmail === true;
  const requireNotification = criteria.requireNotification === true;
  const notificationIds = new Set(notifications.map((item) => item.id));
  const scopedDeliveries = deliveries.filter((item) => notificationIds.has(item.targetId));
  const keys = scopedDeliveries.map((item) => `${item.targetId}:${item.templateId ?? ''}`);
  const duplicateKeys = [...new Set(keys.filter((key, index) => keys.indexOf(key) !== index))];
  const statusCounts = scopedDeliveries.reduce((counts, item) => ({ ...counts, [item.status]: (counts[item.status] ?? 0) + 1 }), {});
  const checks = [
    check('communication.notification_present', !requireNotification || notifications.length > 0, { notificationCount: notifications.length, required: requireNotification }),
    check('communication.no_unread_attention', notifications.every((item) => item.status !== 'unread'), { unreadNotificationIds: notifications.filter((item) => item.status === 'unread').map((item) => item.id) }),
    check('communication.email_delivery_complete', !requireEmail || (scopedDeliveries.length > 0 && scopedDeliveries.every((item) => item.status === 'sent')), { deliveryCount: scopedDeliveries.length, required: requireEmail, statusCounts }),
    check('communication.no_failed_delivery', scopedDeliveries.every((item) => item.status !== 'failed'), { failedDeliveryIds: scopedDeliveries.filter((item) => item.status === 'failed').map((item) => item.id) }),
    check('communication.no_duplicate_delivery', duplicateKeys.length === 0, { duplicateKeys }),
  ];
  return {
    checks,
    failedCheckIds: checks.filter((entry) => !entry.passed).map((entry) => entry.id),
    passed: checks.every((entry) => entry.passed),
    verifier: 'communication.v1',
  };
}
