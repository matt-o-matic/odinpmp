import { timingSafeEqual } from 'node:crypto';

import { HttpError } from '../errors/http-error.js';

export const AUTH_COOKIE_NAMES = Object.freeze({
  access: 'odin_access',
  csrf: 'odin_csrf',
  googleRegistration: 'odin_google_registration',
  refresh: 'odin_refresh',
  twoFactor: 'odin_two_factor',
});

const ACCESS_COOKIE_PATH = '/api';
const CSRF_COOKIE_PATH = '/';
const REFRESH_COOKIE_PATH = '/api/auth';
const TWO_FACTOR_COOKIE_PATH = '/api/auth/two-factor/verify';
const GOOGLE_REGISTRATION_COOKIE_PATH = '/api/auth/register';

function cookieSecure() {
  const configured = String(process.env.AUTH_COOKIE_SECURE ?? '').trim().toLowerCase();
  if (configured === 'true' || configured === '1') {
    return true;
  }
  if (configured === 'false' || configured === '0') {
    return false;
  }
  return process.env.NODE_ENV === 'production';
}

function parseMaxAge(token, verifier) {
  try {
    const payload = verifier(token);
    if (typeof payload?.exp !== 'number') {
      return undefined;
    }
    return Math.max(payload.exp - Math.floor(Date.now() / 1000), 0);
  } catch (_error) {
    return undefined;
  }
}

function serializeCookie(name, value, {
  httpOnly = true,
  maxAge,
  path,
  sameSite = 'Lax',
} = {}) {
  const attributes = [
    `${name}=${encodeURIComponent(String(value ?? ''))}`,
    `Path=${path}`,
    `SameSite=${sameSite}`,
  ];

  if (httpOnly) {
    attributes.push('HttpOnly');
  }
  if (cookieSecure()) {
    attributes.push('Secure');
  }
  if (Number.isFinite(maxAge)) {
    attributes.push(`Max-Age=${Math.max(Math.floor(maxAge), 0)}`);
  }

  return attributes.join('; ');
}

/** Writes a cookie with the attributes session cookies use (Secure in production). */
export function setCookie(response, name, value, options) {
  appendCookie(response, serializeCookie(name, value, options));
}

function appendCookie(response, cookie) {
  response.append('Set-Cookie', cookie);
}

export function parseRequestCookies(request) {
  const cookies = {};
  for (const part of String(request.headers?.cookie ?? '').split(';')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }
    const name = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch (_error) {
      cookies[name] = value;
    }
  }
  return cookies;
}

export function getAuthCookie(request, name) {
  return parseRequestCookies(request)[name] ?? '';
}

export function issueSessionCookies(response, session, tokenService) {
  const accessPayload = tokenService.verifySessionToken(session.token);
  const sessionId = typeof accessPayload?.jti === 'string' ? accessPayload.jti : '';
  const userId = typeof accessPayload?.sub === 'string' ? accessPayload.sub : '';
  const csrfToken = tokenService.signCsrfToken({ sessionId, userId });

  appendCookie(response, serializeCookie(AUTH_COOKIE_NAMES.access, session.token, {
    maxAge: parseMaxAge(session.token, tokenService.verifySessionToken),
    path: ACCESS_COOKIE_PATH,
  }));
  appendCookie(response, serializeCookie(AUTH_COOKIE_NAMES.refresh, session.refreshToken, {
    maxAge: parseMaxAge(session.refreshToken, tokenService.verifyRefreshToken),
    path: REFRESH_COOKIE_PATH,
  }));
  appendCookie(response, serializeCookie(AUTH_COOKIE_NAMES.csrf, csrfToken, {
    httpOnly: false,
    maxAge: parseMaxAge(csrfToken, tokenService.verifyCsrfToken),
    path: CSRF_COOKIE_PATH,
    sameSite: 'Strict',
  }));
}

export function issueTwoFactorCookie(response, challengeToken, tokenService) {
  appendCookie(response, serializeCookie(AUTH_COOKIE_NAMES.twoFactor, challengeToken, {
    maxAge: parseMaxAge(challengeToken, tokenService.verifyTwoFactorChallenge),
    path: TWO_FACTOR_COOKIE_PATH,
  }));
}

export function issueGoogleRegistrationCookie(response, profile, tokenService) {
  const proof = tokenService.signGoogleRegistrationProof(profile);
  appendCookie(response, serializeCookie(AUTH_COOKIE_NAMES.googleRegistration, proof, {
    maxAge: parseMaxAge(proof, tokenService.verifyGoogleRegistrationProof),
    path: GOOGLE_REGISTRATION_COOKIE_PATH,
  }));
}

function expireCookie(response, name, path, { httpOnly = true, sameSite = 'Lax' } = {}) {
  appendCookie(response, serializeCookie(name, '', {
    httpOnly,
    maxAge: 0,
    path,
    sameSite,
  }));
}

export function clearSessionCookies(response) {
  expireCookie(response, AUTH_COOKIE_NAMES.access, ACCESS_COOKIE_PATH);
  expireCookie(response, AUTH_COOKIE_NAMES.refresh, REFRESH_COOKIE_PATH);
  expireCookie(response, AUTH_COOKIE_NAMES.csrf, CSRF_COOKIE_PATH, {
    httpOnly: false,
    sameSite: 'Strict',
  });
  expireCookie(response, AUTH_COOKIE_NAMES.twoFactor, TWO_FACTOR_COOKIE_PATH);
}

export function clearTwoFactorCookie(response) {
  expireCookie(response, AUTH_COOKIE_NAMES.twoFactor, TWO_FACTOR_COOKIE_PATH);
}

export function clearGoogleRegistrationCookie(response) {
  expireCookie(response, AUTH_COOKIE_NAMES.googleRegistration, GOOGLE_REGISTRATION_COOKIE_PATH);
}

function safeTokenEquals(left, right) {
  const leftBuffer = Buffer.from(String(left ?? ''));
  const rightBuffer = Buffer.from(String(right ?? ''));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function requireCsrfForCookieAuth(request, tokenService, { sessionId, userId }) {
  const cookieToken = getAuthCookie(request, AUTH_COOKIE_NAMES.csrf);
  const headerToken = String(request.headers?.['x-csrf-token'] ?? '');

  if (!cookieToken || !headerToken || !safeTokenEquals(cookieToken, headerToken)) {
    throw new HttpError(403, 'CSRF validation failed.');
  }

  let payload;
  try {
    payload = tokenService.verifyCsrfToken(headerToken);
  } catch (_error) {
    throw new HttpError(403, 'CSRF validation failed.');
  }

  if (payload.sub !== userId || payload.jti !== sessionId) {
    throw new HttpError(403, 'CSRF validation failed.');
  }
}

export function publicSessionResult(result) {
  if (!result?.session) {
    return result;
  }
  return {
    ...result,
    session: {
      user: result.session.user,
    },
  };
}
