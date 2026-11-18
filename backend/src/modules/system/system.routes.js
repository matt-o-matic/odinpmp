import { Router } from 'express';

import { renderOperationalPrometheusMetrics } from '../../lib/operations/operational-state.js';

export function createSystemRouter({ operationalState } = {}) {
  const router = Router();

  const live = (_request, response) => {
    response.json({
      ok: true,
      service: 'odinpmp-backend',
    });
  };
  router.get('/health', live);
  router.get('/health/live', live);
  router.get('/health/ready', async (_request, response) => { const readiness = operationalState ? await operationalState.readiness() : { checks: {}, draining: false, ok: true }; response.status(readiness.ok ? 200 : 503).json({ ...readiness, service: 'odinpmp-backend' }); });
  router.get('/health/slo', (_request, response) => { response.json({ ok: true, service: 'odinpmp-backend', telemetry: operationalState?.snapshot?.() ?? {} }); });
  router.get('/metrics', async (_request, response) => {
    const readiness = operationalState?.readiness ? await operationalState.readiness() : null;
    response.type('text/plain; version=0.0.4; charset=utf-8').send(
      renderOperationalPrometheusMetrics({ readiness, snapshot: operationalState?.snapshot?.() ?? {} }),
    );
  });

  router.get('/api', (_request, response) => {
    response.json({
      ok: true,
      name: 'OdinPMP API',
      status: 'initialized',
    });
  });

  return router;
}
