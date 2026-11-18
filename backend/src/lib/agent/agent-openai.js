function modelSupportsReasoning(model = '') {
  return /^(gpt-([5-9]|\d{2,})|o\d)/i.test(String(model ?? '').trim());
}

export function buildReasoning(reasoningEffort, model) {
  const effort = String(reasoningEffort ?? '').trim().toLowerCase();
  if (!effort || effort === 'none' || !modelSupportsReasoning(model)) return undefined;
  return { effort };
}
