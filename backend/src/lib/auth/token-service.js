import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';

const SESSION_AUDIENCE = 'odinpmp-app';
const REFRESH_AUDIENCE = 'odinpmp-refresh';
const TWO_FACTOR_AUDIENCE = 'odinpmp-two-factor';
const CSRF_AUDIENCE = 'odinpmp-csrf';
const BREAK_GLASS_AUDIENCE = 'odinpmp-break-glass';
const GOOGLE_REGISTRATION_AUDIENCE = 'odinpmp-google-registration';
const DEFAULT_SESSION_TOKEN_TTL_SECONDS = 60 * 60;
const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24;
const DEFAULT_CHALLENGE_TTL_SECONDS = 60 * 10;
const DEFAULT_REFRESH_WINDOW_SECONDS = 60 * 5;

export function createTokenService({
  issuer,
  refreshTokenTtlSeconds = DEFAULT_REFRESH_TOKEN_TTL_SECONDS,
  secret,
  sessionTokenTtlSeconds = DEFAULT_SESSION_TOKEN_TTL_SECONDS,
  sessionTokenRefreshWindowSeconds = DEFAULT_REFRESH_WINDOW_SECONDS,
  twoFactorChallengeTtlSeconds = DEFAULT_CHALLENGE_TTL_SECONDS,
}) {
  if (!secret) {
    throw new Error('JWT secret is required.');
  }

  // `channel` marks a session the assistant opened for its turn ('assistant'), so changes made
  // through it are recorded as the assistant's (lib/http/request-channel.js).
  function signSessionToken(user, { channel = null, sessionId } = {}) {
    return jwt.sign(
      {
        ...(channel ? { channel } : {}),
        email: user.email,
        name: user.name,
        preferences: user.preferences ?? {},
        role: user.role ?? null,
        scopes: user.scopes ?? [],
        tenantId: user.tenantId ?? null,
        type: 'session',
      },
      secret,
      {
        audience: SESSION_AUDIENCE,
        expiresIn: sessionTokenTtlSeconds,
        issuer,
        ...(sessionId ? { jwtid: sessionId } : {}),
        subject: user.id,
      },
    );
  }

  function signImpersonationSessionToken(user, {
    actorId,
    expiresInSeconds,
    impersonationGrantId,
    sessionId,
  } = {}) {
    if (!actorId || !impersonationGrantId || !sessionId) {
      throw new Error('An actor, impersonation grant, and session id are required.');
    }
    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1) {
      throw new Error('A positive impersonation session lifetime is required.');
    }
    return jwt.sign(
      {
        actorId,
        email: user.email,
        impersonationGrantId,
        name: user.name,
        preferences: user.preferences ?? {},
        role: user.role ?? null,
        scopes: user.scopes ?? [],
        tenantId: user.tenantId ?? null,
        type: 'impersonation-session',
      },
      secret,
      {
        audience: SESSION_AUDIENCE,
        expiresIn: expiresInSeconds,
        issuer,
        jwtid: sessionId,
        subject: user.id,
      },
    );
  }

  function signRefreshToken(user, { sessionId } = {}) {
    if (!sessionId) {
      throw new Error('A session id is required to sign a refresh token.');
    }

    return jwt.sign(
      {
        email: user.email,
        tenantId: user.tenantId ?? null,
        type: 'refresh-session',
      },
      secret,
      {
        audience: REFRESH_AUDIENCE,
        expiresIn: refreshTokenTtlSeconds,
        issuer,
        jwtid: sessionId,
        subject: user.id,
      },
    );
  }

  function signTwoFactorChallenge(user) {
    return jwt.sign(
      {
        email: user.email,
        name: user.name,
        role: user.role ?? null,
        scopes: user.scopes ?? [],
        tenantId: user.tenantId ?? null,
        type: 'two-factor-challenge',
      },
      secret,
      {
        audience: TWO_FACTOR_AUDIENCE,
        expiresIn: twoFactorChallengeTtlSeconds,
        issuer,
        subject: user.id,
      },
    );
  }

  function signBreakGlassChallenge(user, { policyVersion, reason }) {
    return jwt.sign(
      {
        policyVersion,
        reason,
        tenantId: user.tenantId,
        type: 'break-glass-challenge',
      },
      secret,
      {
        audience: BREAK_GLASS_AUDIENCE,
        expiresIn: DEFAULT_CHALLENGE_TTL_SECONDS,
        issuer,
        subject: user.id,
      },
    );
  }

  function signBreakGlassSessionToken(user, { expiresInSeconds, policyVersion, reason, sessionId }) {
    if (!sessionId || !Number.isInteger(expiresInSeconds) || expiresInSeconds < 1) {
      throw new Error('A session id and positive break-glass lifetime are required.');
    }
    return jwt.sign(
      {
        email: user.email,
        name: user.name,
        policyVersion,
        preferences: user.preferences ?? {},
        reason,
        role: user.role,
        scopes: user.scopes ?? [],
        tenantId: user.tenantId,
        type: 'break-glass-session',
      },
      secret,
      {
        audience: SESSION_AUDIENCE,
        expiresIn: expiresInSeconds,
        issuer,
        jwtid: sessionId,
        subject: user.id,
      },
    );
  }

  function signCsrfToken({ sessionId, userId }) {
    if (!sessionId || !userId) {
      throw new Error('A session id and user id are required to sign a CSRF token.');
    }
    return jwt.sign(
      { type: 'csrf' },
      secret,
      {
        audience: CSRF_AUDIENCE,
        expiresIn: refreshTokenTtlSeconds,
        issuer,
        jwtid: sessionId,
        subject: userId,
      },
    );
  }

  function signGoogleRegistrationProof({ email }) {
    return jwt.sign(
      { email: String(email).trim().toLowerCase(), type: 'google-registration' },
      secret,
      { audience: GOOGLE_REGISTRATION_AUDIENCE, expiresIn: 60 * 10, issuer },
    );
  }

  function verifyGoogleRegistrationProof(token) {
    const proof = jwt.verify(token, secret, {
      audience: GOOGLE_REGISTRATION_AUDIENCE,
      issuer,
    });
    if (proof.type !== 'google-registration' || !proof.email) {
      throw new Error('Invalid Google registration proof.');
    }
    return proof;
  }

  function verifySessionToken(token) {
    return jwt.verify(token, secret, {
      audience: SESSION_AUDIENCE,
      issuer,
    });
  }

  function verifyRefreshToken(token) {
    return jwt.verify(token, secret, {
      audience: REFRESH_AUDIENCE,
      issuer,
    });
  }

  function verifyTwoFactorChallenge(token) {
    return jwt.verify(token, secret, {
      audience: TWO_FACTOR_AUDIENCE,
      issuer,
    });
  }

  function verifyBreakGlassChallenge(token) {
    return jwt.verify(token, secret, {
      audience: BREAK_GLASS_AUDIENCE,
      issuer,
    });
  }

  function verifyCsrfToken(token) {
    return jwt.verify(token, secret, {
      audience: CSRF_AUDIENCE,
      issuer,
    });
  }

  function shouldRefreshSession(token) {
    const decoded = verifySessionToken(token);
    const nowSeconds = Math.floor(Date.now() / 1000);

    return typeof decoded.exp === 'number' && decoded.exp - nowSeconds <= sessionTokenRefreshWindowSeconds;
  }

  const mcpRequestHash = ({ token, method, path }) => createHash('sha256').update(JSON.stringify([token, method, path])).digest('hex');
  function signMcpInternalProof(request) {
    return jwt.sign({ requestHash: mcpRequestHash(request) }, secret, { algorithm: 'HS256', audience: 'odinpmp-mcp-internal', issuer, expiresIn: 60 });
  }
  function verifyMcpInternalProof(proof, request) {
    const payload = jwt.verify(proof, secret, { algorithms: ['HS256'], audience: 'odinpmp-mcp-internal', issuer });
    if (payload.requestHash !== mcpRequestHash(request)) throw new Error('Invalid internal MCP request.');
  }

  return {
    signMcpInternalProof,
    verifyMcpInternalProof,
    signCsrfToken,
    signGoogleRegistrationProof,
    signBreakGlassChallenge,
    signBreakGlassSessionToken,
    signImpersonationSessionToken,
    signRefreshToken,
    signSessionToken,
    signTwoFactorChallenge,
    verifyCsrfToken,
    verifyGoogleRegistrationProof,
    verifyBreakGlassChallenge,
    verifyRefreshToken,
    verifySessionToken,
    verifyTwoFactorChallenge,
    shouldRefreshSession,
  };
}
