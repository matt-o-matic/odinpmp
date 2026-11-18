const DEFAULT_DEV_API_BASE_URL = 'http://localhost:3001';

export function resolveApiBaseUrl({
  browserOrigin = '',
  configuredBaseUrl = '',
  mode = 'development',
} = {}) {
  const explicit = String(configuredBaseUrl ?? '').trim();
  if (explicit) {
    return explicit;
  }

  if (mode === 'production') {
    const origin = String(browserOrigin ?? '').trim();
    if (origin) {
      return origin;
    }
  }

  return DEFAULT_DEV_API_BASE_URL;
}

export { DEFAULT_DEV_API_BASE_URL };
