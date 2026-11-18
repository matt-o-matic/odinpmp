const HEADING = /^#{1,6} /;
const LIST_ITEM = /^\s*(?:[-*+] |\d+[.)] )/;
// Citation markup the model sometimes writes as text: private-use characters around "cite" and
// source ids (U+E200 cite U+E202 turn0search0 U+E201). Unrendered, it showed as "citenone".
const CITATION_MARKUP = /[ \t]?[^\n]*|[-]/g;

// Light, deterministic cleanup of the model's markdown so it renders the way it reads. It only
// adds missing line breaks and drops citation markup; it never rewrites words. Code fences pass
// through untouched.
export function normalizeAgentMarkdown(value = '') {
  let text = String(value ?? '').replace(/\r\n?/g, '\n').replace(CITATION_MARKUP, '').trim();
  if (!text) return '';
  const fences = [];
  text = text.replace(/```[\s\S]*?```/g, (block) => `\u0000${fences.push(block) - 1}\u0000`);
  text = text
    // A heading glued to the end of a sentence ("done. ## Next") moves to its own line.
    .replace(/([.!?:)])[ \t]+(#{1,6} )/g, '$1\n\n$2')
    // A heading followed by body text on the same line ends before the first bold label.
    .replace(/^(#{1,6} [^\n]*?)[ \t]+(\*\*[^*\n]+:\*\*)/gm, '$1\n\n$2')
    // Bold section labels run together in one paragraph ("… text. **Next:** more") start paragraphs.
    .replace(/([.!?)])[ \t]+(\*\*[^*\n]{2,60}:\*\*)/g, '$1\n\n$2');

  const lines = text.split('\n');
  const output = [];
  for (const line of lines) {
    const previous = output.at(-1);
    const previousFilled = previous !== undefined && previous.trim() !== '';
    if (previousFilled && (HEADING.test(line) || (LIST_ITEM.test(line) && !LIST_ITEM.test(previous) && !/^\s{2,}/.test(previous)))) output.push('');
    if (previousFilled && HEADING.test(previous) && line.trim() !== '') output.push('');
    output.push(line);
  }
  return output.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\u0000(\d+)\u0000/g, (_, index) => fences[Number(index)]).trim();
}
