function normalizeModel(model = '') {
  return String(model ?? '').trim().toLowerCase();
}

export function modelSupportsTemperature(model = '') {
  const normalized = normalizeModel(model);
  if (!normalized) {
    return true;
  }

  return !/^(gpt-([5-9]|\d{2,})|o\d)/i.test(normalized);
}

export function withOptionalTemperature(parameters = {}, {
  model = '',
  temperature,
} = {}) {
  const next = { ...parameters };

  if (temperature == null || Number.isNaN(Number(temperature))) {
    return next;
  }

  if (!modelSupportsTemperature(model)) {
    delete next.temperature;
    return next;
  }

  next.temperature = temperature;
  return next;
}
