// The client address as Express resolves it under the app's `trust proxy` setting
// (TRUST_PROXY). X-Forwarded-For entries count only when a trusted proxy added them, so a
// caller cannot choose its own address by sending the header.
export function getRequestIp(request) {
  const ip = request.ip || request.socket?.remoteAddress || '';
  return String(ip ?? '').trim();
}

export function getRequestUserAgent(request) {
  return String(request.headers['user-agent'] ?? '').trim();
}

export function getLocationNameForIp(ip) {
  const value = String(ip ?? '').trim();
  if (!value || value === '::1' || value === '127.0.0.1') {
    return 'Localhost';
  }

  return 'Unknown Location';
}

