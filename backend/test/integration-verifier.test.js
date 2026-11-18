import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyIntegrationDelivery } from '../src/modules/platform/integration-verifier.js';

test('integration verifier proves scoped delivery success and idempotency', () => {
  const verification = verifyIntegrationDelivery({
    projectId: 'project-1',
    snapshot: {
      deliveries: [
        { eventId: 'event-1', eventType: 'workflow.transitioned', id: 'delivery-1', payload: { projectId: 'project-1' }, status: 'delivered', subscriptionId: 'subscription-1' },
        { eventId: 'event-peer', eventType: 'workflow.transitioned', id: 'delivery-peer', payload: { projectId: 'project-2' }, status: 'dead', subscriptionId: 'subscription-1' },
      ],
      subscriptions: [{ enabled: true, id: 'subscription-1', lastDeliveredAt: '2026-07-11T12:00:00.000Z', lastFailureAt: '2026-07-11T11:00:00.000Z' }],
    },
  });

  assert.equal(verification.passed, true);
  assert.equal(verification.summary.scopedDeliveryCount, 1);
  assert.deepEqual(verification.failedCheckIds, []);
});

test('integration verifier fails pending, dead, unhealthy, missing, and duplicate evidence', () => {
  const missing = verifyIntegrationDelivery({ criteria: { subscriptionIds: ['subscription-1'] }, snapshot: { deliveries: [], subscriptions: [{ enabled: false, id: 'subscription-1' }] } });
  assert.equal(missing.checks.find((check) => check.id === 'integration.deliveries_succeeded').passed, false);
  assert.equal(missing.checks.find((check) => check.id === 'integration.subscriptions_healthy').passed, false);

  const failed = verifyIntegrationDelivery({ snapshot: {
    deliveries: [
      { eventId: 'event-1', id: 'delivery-1', payload: {}, status: 'dead', subscriptionId: 'subscription-1' },
      { eventId: 'event-1', id: 'delivery-2', payload: {}, status: 'pending', subscriptionId: 'subscription-1' },
    ],
    subscriptions: [{ enabled: true, id: 'subscription-1', lastDeliveredAt: null, lastFailureAt: '2026-07-11T12:00:00.000Z' }],
  } });
  assert.equal(failed.passed, false);
  assert.equal(failed.checks.find((check) => check.id === 'integration.no_dead_deliveries').passed, false);
  assert.equal(failed.checks.find((check) => check.id === 'integration.no_pending_deliveries').passed, false);
  assert.equal(failed.checks.find((check) => check.id === 'integration.no_duplicate_deliveries').passed, false);
});
