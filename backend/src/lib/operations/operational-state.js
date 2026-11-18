function percentile(values, quantile) { if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]; }

export function createOperationalState({ clock = () => Date.now(), dependencyChecks = {}, maxSamples = 1000, slo = {} } = {}) {
  const startedAt = clock(); const samples = []; const statusCounts = new Map(); let activeRequests = 0; let draining = false; let completedRequests = 0;
  const targets = { errorRatePercent: Number(slo.errorRatePercent ?? 1), p95LatencyMs: Number(slo.p95LatencyMs ?? 1000) };
  const waiters = new Set();
  function notifyIdle() { if (activeRequests !== 0) return; for (const resolve of waiters) resolve(true); waiters.clear(); }
  return {
    beginRequest() { activeRequests += 1; const beganAt = clock(); let ended = false; return (statusCode = 200) => { if (ended) return; ended = true; activeRequests = Math.max(0, activeRequests - 1); completedRequests += 1; const durationMs = Math.max(0, clock() - beganAt); samples.push(durationMs); if (samples.length > maxSamples) samples.shift(); const family = `${Math.floor(Number(statusCode || 500) / 100)}xx`; statusCounts.set(family, (statusCounts.get(family) ?? 0) + 1); notifyIdle(); }; },
    isDraining() { return draining; },
    setDraining(value = true) { draining = Boolean(value); return draining; },
    async readiness({ timeoutMs = 2000 } = {}) { const checks = {}; for (const [name, check] of Object.entries(dependencyChecks)) { const started = clock(); let timeout; try { await Promise.race([Promise.resolve().then(check), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('timed out')), timeoutMs); })]); checks[name] = { latencyMs: Math.max(0, clock() - started), ok: true }; } catch (error) { checks[name] = { error: String(error?.message ?? error).slice(0, 300), latencyMs: Math.max(0, clock() - started), ok: false }; } finally { clearTimeout(timeout); } } return { checks, draining, ok: !draining && Object.values(checks).every((check) => check.ok) }; },
    snapshot() { const latencyMs = { p50: percentile(samples, 0.5), p95: percentile(samples, 0.95), p99: percentile(samples, 0.99), sampleCount: samples.length }; const errorRatePercent = completedRequests ? (((statusCounts.get('5xx') ?? 0) / completedRequests) * 100) : 0; const breaches = []; if (latencyMs.sampleCount && latencyMs.p95 > targets.p95LatencyMs) breaches.push('p95_latency'); if (completedRequests && errorRatePercent > targets.errorRatePercent) breaches.push('error_rate'); return { activeRequests, completedRequests, draining, latencyMs, slo: { breaches, observed: { errorRatePercent, p95LatencyMs: latencyMs.p95 }, ok: breaches.length === 0, targets }, startedAt: new Date(startedAt).toISOString(), statusCounts: Object.fromEntries(statusCounts), uptimeSeconds: Math.max(0, Math.floor((clock() - startedAt) / 1000)) }; },
    waitForIdle({ timeoutMs = 30_000 } = {}) { if (activeRequests === 0) return Promise.resolve(true); return new Promise((resolve) => { const timer = setTimeout(() => { waiters.delete(done); resolve(false); }, timeoutMs); const done = (value) => { clearTimeout(timer); resolve(value); }; waiters.add(done); }); },
  };
}

export function createOperationalMiddleware({ state }) {
  return function operationalMiddleware(request, response, next) {
    const isHealth = request.path === '/health' || request.path.startsWith('/health/');
    if (state.isDraining() && !isHealth) { response.setHeader('Retry-After', '5'); response.status(503).json({ error: 'Service is draining.', ok: false }); return; }
    if (isHealth) { next(); return; }
    const finish = state.beginRequest(); response.once('finish', () => finish(response.statusCode)); response.once('close', () => finish(response.statusCode || 499)); next();
  };
}

function metric(name, value, labels = '') {
  return `${name}${labels ? `{${labels}}` : ''} ${Number(value) || 0}`;
}

export function renderOperationalPrometheusMetrics({ readiness = null, snapshot = {} } = {}) {
  const lines = [
    '# HELP odin_http_requests_total Completed HTTP requests since process start.',
    '# TYPE odin_http_requests_total counter',
    metric('odin_http_requests_total', snapshot.completedRequests),
    '# HELP odin_http_active_requests In-flight HTTP requests.',
    '# TYPE odin_http_active_requests gauge',
    metric('odin_http_active_requests', snapshot.activeRequests),
    '# HELP odin_http_latency_milliseconds Recent bounded latency percentiles.',
    '# TYPE odin_http_latency_milliseconds gauge',
    metric('odin_http_latency_milliseconds', snapshot.latencyMs?.p50, 'quantile="0.50"'),
    metric('odin_http_latency_milliseconds', snapshot.latencyMs?.p95, 'quantile="0.95"'),
    metric('odin_http_latency_milliseconds', snapshot.latencyMs?.p99, 'quantile="0.99"'),
    '# HELP odin_http_error_rate_percent Observed HTTP 5xx percentage.',
    '# TYPE odin_http_error_rate_percent gauge',
    metric('odin_http_error_rate_percent', snapshot.slo?.observed?.errorRatePercent),
    '# HELP odin_slo_target Configured service-level targets.',
    '# TYPE odin_slo_target gauge',
    metric('odin_slo_target', snapshot.slo?.targets?.p95LatencyMs, 'objective="p95_latency_ms"'),
    metric('odin_slo_target', snapshot.slo?.targets?.errorRatePercent, 'objective="error_rate_percent"'),
    '# HELP odin_slo_breach Whether a service-level objective is currently breached.',
    '# TYPE odin_slo_breach gauge',
    metric('odin_slo_breach', snapshot.slo?.breaches?.includes('p95_latency') ? 1 : 0, 'objective="p95_latency"'),
    metric('odin_slo_breach', snapshot.slo?.breaches?.includes('error_rate') ? 1 : 0, 'objective="error_rate"'),
    '# HELP odin_process_draining Whether this instance is draining.',
    '# TYPE odin_process_draining gauge',
    metric('odin_process_draining', snapshot.draining ? 1 : 0),
    '# HELP odin_process_uptime_seconds Process uptime.',
    '# TYPE odin_process_uptime_seconds gauge',
    metric('odin_process_uptime_seconds', snapshot.uptimeSeconds),
  ];
  for (const [family, count] of Object.entries(snapshot.statusCounts ?? {})) {
    lines.push(metric('odin_http_status_family_total', count, `family="${family}"`));
  }
  if (readiness) {
    lines.push('# HELP odin_readiness Whether this instance and each dependency are ready.');
    lines.push('# TYPE odin_readiness gauge');
    lines.push(metric('odin_readiness', readiness.ok ? 1 : 0));
    for (const [name, check] of Object.entries(readiness.checks ?? {})) {
      const safeName = String(name).replace(/[^a-zA-Z0-9_.:-]/g, '_');
      lines.push(metric('odin_dependency_ready', check.ok ? 1 : 0, `dependency="${safeName}"`));
      lines.push(metric('odin_dependency_latency_milliseconds', check.latencyMs, `dependency="${safeName}"`));
    }
  }
  return `${lines.join('\n')}\n`;
}
