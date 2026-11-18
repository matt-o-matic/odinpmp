export function createGracefulShutdown({ app, logger = console, pool, processRef = process, server, timeoutMs = 30_000, worker }) {
  let started = false;
  return async function shutdown(signal = 'shutdown') {
    if (started) return { alreadyStarted: true };
    started = true; logger.log(`Received ${signal}; draining odinpmp-backend.`); worker.stop(); server.closeIdleConnections?.();
    const serverClosed = new Promise((resolve) => server.close(resolve));
    const [httpIdle, workerIdle] = await Promise.all([app.locals.beginDrain({ timeoutMs }), worker.waitForIdle({ timeoutMs })]);
    if (!httpIdle || !workerIdle) server.closeAllConnections?.();
    await new Promise((resolve) => { const timer = setTimeout(resolve, Math.min(5_000, timeoutMs)); serverClosed.then(() => { clearTimeout(timer); resolve(); }); });
    await pool.end(); processRef.exitCode = httpIdle && workerIdle ? 0 : 1;
    return { alreadyStarted: false, httpIdle, workerIdle };
  };
}
