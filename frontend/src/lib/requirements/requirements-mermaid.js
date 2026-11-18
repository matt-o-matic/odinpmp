// Renders package flows with Mermaid, loaded on first use so the app bundle does not carry
// it. Mermaid runs with securityLevel 'strict' (package-spec.md section 3, flows): labels
// are sanitized and click handlers are off. Renders run one at a time because Mermaid
// keeps global state while it lays out a diagram.

let loading = null;
let configuredTheme = '';
let queue = Promise.resolve();
let counter = 0;

export const MERMAID_CONFIG = Object.freeze({
  securityLevel: 'strict',
  startOnLoad: false,
  suppressErrorRendering: true,
});

export function loadMermaid() {
  if (!loading) {
    loading = import('mermaid')
      .then((module) => module.default ?? module)
      .catch((error) => {
        loading = null;
        throw error;
      });
  }
  return loading;
}

function removeLeftovers(id) {
  if (typeof document === 'undefined') return;
  for (const candidate of [id, `d${id}`, `i${id}`]) document.getElementById(candidate)?.remove();
}

/** Resolves with the diagram's SVG markup, or rejects with Mermaid's error. */
export function renderMermaid(source, { dark = false } = {}) {
  const job = queue.then(async () => {
    const mermaid = await loadMermaid();
    const theme = dark ? 'dark' : 'default';
    if (configuredTheme !== theme) {
      mermaid.initialize({ ...MERMAID_CONFIG, theme });
      configuredTheme = theme;
    }
    counter += 1;
    const id = `rq-mermaid-${counter}`;
    try {
      const { svg } = await mermaid.render(id, String(source ?? ''));
      return svg;
    } finally {
      removeLeftovers(id);
    }
  });
  queue = job.catch(() => {});
  return job;
}

/** First line of a Mermaid error, without its parser dump. */
export function mermaidErrorText(error) {
  const text = String(error?.message ?? error ?? '').split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}
