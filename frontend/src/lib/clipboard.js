// Copies text to the clipboard. Tries the Clipboard API first, then a selected textarea
// with execCommand('copy'), which still works where the API is blocked: embedded browsers,
// pages without clipboard permission, or a click whose user activation has lapsed.
// Returns true when the text was copied.
export async function copyText(text) {
  const value = String(text ?? '');
  if (!value) return false;
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Fall through to the selection copy.
    }
  }
  return copyWithSelection(value);
}

function copyWithSelection(value) {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;
  const active = document.activeElement;
  // A modal <dialog> makes the rest of the page inert, so the textarea goes inside it.
  const container = active?.closest?.('dialog[open]') ?? document.body;
  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  Object.assign(area.style, { left: '-9999px', opacity: '0', position: 'fixed', top: '0' });
  container.appendChild(area);
  area.select();
  area.setSelectionRange(0, value.length);
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  area.remove();
  active?.focus?.({ preventScroll: true });
  return copied;
}
