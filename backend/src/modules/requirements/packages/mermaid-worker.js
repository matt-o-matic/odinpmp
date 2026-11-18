import { parentPort } from 'node:worker_threads';

// Parses Mermaid sources with the real `mermaid` parser. Mermaid's sanitizer needs a DOM,
// so this worker installs a jsdom window as its global. That global stays inside this
// worker thread and never touches the main process, where libraries use `window` to
// detect a browser. jsdom runs no scripts and loads no resources by default.

let loading = null;

async function loadMermaid() {
  const { JSDOM, VirtualConsole } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    virtualConsole: new VirtualConsole(),
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({ logLevel: 'fatal', securityLevel: 'strict', startOnLoad: false });
  return mermaid;
}

function describe(error) {
  return String(error?.message ?? error ?? 'Mermaid could not parse this diagram.')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(0, 4)
    .join(' | ')
    .slice(0, 500);
}

parentPort.on('message', async ({ id, sources }) => {
  try {
    loading ??= loadMermaid();
    const mermaid = await loading;
    const results = [];
    for (const source of sources) {
      try {
        await mermaid.parse(String(source ?? ''));
        results.push({ ok: true });
      } catch (error) {
        results.push({ error: describe(error), ok: false });
      }
    }
    parentPort.postMessage({ id, results });
  } catch (error) {
    loading = null;
    parentPort.postMessage({ error: describe(error), id });
  }
});
