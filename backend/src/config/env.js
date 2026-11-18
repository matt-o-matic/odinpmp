import { z } from 'zod';
import { validateMcpPublicUrl } from '../mcp/http.js';

const optionalBoolean = z.preprocess((value) => {
  if (value == null || value === '') {
    return undefined;
  }
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true' || value === '1') return true;
    if (value.toLowerCase() === 'false' || value === '0') return false;
  }
  return value;
}, z.boolean().optional());

// The built-in secret only signs tokens when NODE_ENV says development or test (loadEnv).
export const DEVELOPMENT_JWT_SECRET = 'odinpmp-dev-secret';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3001),
    DATABASE_URL: z.string().trim().optional(),
    JWT_ISSUER: z.string().trim().default('odinpmp-backend'),
    JWT_SECRET: z.string().trim().default(DEVELOPMENT_JWT_SECRET),
    // Creates the demo login (demo@odinpmp.local) at startup. Never in production.
    SEED_DEMO_USER: optionalBoolean,
    BACKEND_PUBLIC_URL: z.string().trim().optional(),
    MCP_PUBLIC_URL: z.string().trim().optional(),
    MCP_ALLOWED_ORIGINS: z.string().trim().optional(),
    FRONTEND_APP_URL: z.string().trim().default('http://localhost:5173/app'),
    // invoice-gen's address, for links from the Billing panel to it (docs/invoice-gen-connection).
    INVOICE_GEN_BASE_URL: z.string().trim().url().optional(),
    // Web Push for browser and phone notifications (docs/odin-chat/plan.md, Delivery). Without
    // all three, push is off. `npm run job:generate-vapid-keys` prints a key pair.
    WEB_PUSH_VAPID_PUBLIC_KEY: z.string().trim().optional(),
    WEB_PUSH_VAPID_PRIVATE_KEY: z.string().trim().optional(),
    WEB_PUSH_SUBJECT: z.string().trim().optional(),
    CORS_ALLOWED_ORIGINS: z.string().trim().optional(),
    JSON_BODY_LIMIT_BYTES: z.coerce.number().int().positive().max(5 * 1024 * 1024).optional(),
    GOOGLE_OAUTH_CLIENT_ID: z.string().trim().optional(),
    GOOGLE_OAUTH_CLIENT_SECRET: z.string().trim().optional(),
    GOOGLE_OAUTH_REDIRECT_URI: z.string().trim().optional(),
    RECAPTCHA_SITE_KEY: z.string().trim().optional(),
    RECAPTCHA_SECRET_KEY: z.string().trim().optional(),
    // Comma-separated addresses emailed about each "Request access" submission from the marketing site.
    ACCESS_REQUEST_NOTIFY_EMAILS: z.string().trim().optional(),
    OPENAI_API_KEY: z.string().trim().optional(),
    OPENAI_MODEL: z.string().trim().optional(),
    OPENAI_MEMORY_EMBEDDING_MODEL: z.string().trim().optional(),
    OPENAI_MEMORY_EMBEDDING_DIMENSIONS: z.coerce.number().int().min(64).max(3072).optional(),
    // Semantic search (docs/semantic-search/plan.md): the model and size of the search index's
    // embeddings, how often the index is refreshed (0 turns the schedule off; searches still
    // refresh a stale index), and the cosine similarity below which a row is not a match.
    SEARCH_EMBEDDING_MODEL: z.string().trim().optional(),
    SEARCH_EMBEDDING_DIMENSIONS: z.coerce.number().int().min(64).max(3072).optional(),
    SEARCH_INDEX_INTERVAL_MS: z.coerce.number().int().min(0).optional(),
    SEARCH_SEMANTIC_MIN_SIMILARITY: z.coerce.number().min(0).max(1).optional(),
    REQUIREMENTS_SUMMARY_MODEL: z.string().trim().optional(),
    REQUIREMENTS_SUMMARY_REASONING_EFFORT: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
    ASSISTANT_TURN_TIMEOUT_MS: z.coerce.number().int().nonnegative().optional(),
    // The assistant's tool-call budget: each task in a turn's plan adds this many calls to the
    // turn's shared pool, up to the ceiling.
    ASSISTANT_TOOL_CALLS_PER_TASK: z.coerce.number().int().positive().optional(),
    ASSISTANT_MAX_TOOL_CALLS: z.coerce.number().int().positive().optional(),
    // Reasoning effort for simple turns and for everything else (gpt-6-luna scales with effort).
    ASSISTANT_REASONING_SIMPLE: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
    ASSISTANT_REASONING_COMPLEX: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
    ASSISTANT_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().optional(),
    // Decisions API checks around the agent loop (triage, pre-write, completion).
    ASSISTANT_DECISIONS_ENABLED: z.enum(['true', 'false']).optional(),
    ASSISTANT_DECISIONS_MODEL: z.string().trim().optional(),
    ASSISTANT_DECISIONS_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
    ASSISTANT_WRITE_CHECK_THRESHOLD: z.coerce.number().min(0).max(1).optional(),
    // On turns where the user asked for changes, only writes that look plainly unrelated are held.
    ASSISTANT_WRITE_CHECK_THRESHOLD_CHANGE: z.coerce.number().min(0).max(1).optional(),
    // A chat's conversation grows until a request would pass this many tokens, then older turns
    // are condensed into a summary.
    ASSISTANT_COMPACT_AT_TOKENS: z.coerce.number().int().min(8000).max(1000000).optional(),
    VAULT_STORAGE_PATH: z.string().trim().optional(),
    AVATAR_STORAGE_PATH: z.string().trim().optional(),
    OBJECT_STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
    OBJECT_STORAGE_BUCKET: z.string().trim().optional(),
    OBJECT_STORAGE_REGION: z.string().trim().optional(),
    OBJECT_STORAGE_ENDPOINT: z.string().trim().url().optional(),
    OBJECT_STORAGE_FORCE_PATH_STYLE: optionalBoolean,
    OBJECT_STORAGE_PREFIX: z.string().trim().max(240).optional(),
    // Where browsers reach the bucket for signed upload and download URLs, when not at
    // OBJECT_STORAGE_ENDPOINT (a MinIO container on another host name, say).
    OBJECT_STORAGE_PUBLIC_ENDPOINT: z.string().trim().url().optional(),
    // The largest file anyone can upload (docs/engagements/qna.md, Q-05): 1 GB.
    FILE_UPLOAD_MAX_BYTES: z.coerce.number().int().positive().max(5 * 1024 * 1024 * 1024).optional(),
    // Signs the short-lived backend URLs that move file bytes with local storage. Defaults to
    // JWT_SECRET.
    FILE_TRANSFER_SECRET: z.string().trim().min(16).optional(),
    SMTP_HOST: z.string().trim().optional(),
    SMTP_PORT: z.coerce.number().int().positive().optional(),
    SMTP_USER: z.string().trim().optional(),
    SMTP_PASS: z.string().trim().optional(),
    SMTP_STARTTLS: optionalBoolean,
    MAIL_FROM_ADDRESS: z.string().trim().optional(),
    MAIL_FROM_NAME: z.string().trim().optional(),
    MAIL_REPLY_DOMAIN: z.string().trim().optional(),
    // Minutes without a new assignment before a stakeholder's clarification digest is sent;
    // 0 sends it at the next mail queue run.
    CLARIFICATION_DIGEST_QUIET_MINUTES: z.coerce.number().int().min(0).max(1440).optional(),
    BUG_REPORTER_EMAIL_REPLIES: optionalBoolean,
    INBOUND_MAIL_WEBHOOK_SECRET: z.string().trim().optional(),
    WEBHOOK_SIGNING_MASTER_SECRET: z.string().trim().optional(),
    CONNECTOR_CREDENTIAL_ENCRYPTION_KEY: z.string().trim().optional(),
    SLO_P95_LATENCY_MS: z.coerce.number().positive().optional(),
    SLO_ERROR_RATE_PERCENT: z.coerce.number().positive().max(100).optional(),
    CLAMAV_ENABLED: optionalBoolean,
    CLAMAV_HOST: z.string().trim().optional(),
    CLAMAV_PORT: z.coerce.number().int().positive().optional(),
    CLAMAV_SOCKET_PATH: z.string().trim().optional(),
    CLAMAV_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
    // How long the scan worker waits for ClamAV to answer once a whole file is sent to it.
    CLAMAV_STREAM_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
    // Office previews (docs/engagements/plan.md, Download and preview): the LibreOffice program,
    // the largest file converted, and how long one conversion may run.
    PREVIEW_SOFFICE_PATH: z.string().trim().min(1).optional(),
    PREVIEW_MAX_BYTES: z.coerce.number().int().positive().optional(),
    PREVIEW_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
    REQUIREMENTS_AI_PROVIDER: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.enum(['openai', 'local-fixture']).optional(),
    ),
    REVIEW_PUBLIC_URL: z.string().trim().optional(),
    REVIEW_PORT: z.coerce.number().int().positive().max(65535).optional(),
    REVIEW_GRANT_SECRET: z.string().trim().optional(),
    REVIEW_PACKAGE_MAX_BYTES: z.coerce.number().int().positive().max(200 * 1024 * 1024).optional(),
    // Seals signature records (docs/document-signing). Without a key, production refuses new
    // signature requests; everything else runs.
    SIGNING_SEAL_KEY: z.string().trim().optional(),
    SIGNING_SEAL_KEY_ID: z.string().trim().max(64).optional(),
    SIGNING_SEAL_KEYS_PREVIOUS: z.string().trim().optional(),
    TRUST_PROXY: z.string().trim().optional(),
  })
  .passthrough()
  .superRefine((env, context) => {
    if (env.NODE_ENV !== 'production') {
      return;
    }

    if (env.JWT_SECRET === DEVELOPMENT_JWT_SECRET || env.JWT_SECRET.length < 32) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must be a non-default secret with at least 32 characters in production',
        path: ['JWT_SECRET'],
      });
    }

    try {
      const frontendUrl = new URL(env.FRONTEND_APP_URL);
      if (frontendUrl.protocol !== 'https:') {
        throw new Error('Production frontend URL must use HTTPS.');
      }
    } catch (_error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must be a valid HTTPS URL in production',
        path: ['FRONTEND_APP_URL'],
      });
    }

    if (env.CLAMAV_ENABLED !== true) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must be true in production so uploads fail closed',
        path: ['CLAMAV_ENABLED'],
      });
    }
    if (!env.CLAMAV_HOST && !env.CLAMAV_SOCKET_PATH) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'CLAMAV_HOST or CLAMAV_SOCKET_PATH is required in production',
        path: ['CLAMAV_HOST'],
      });
    }
    if (env.OBJECT_STORAGE_PROVIDER !== 's3') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must be s3 in production so application instances do not depend on local disk',
        path: ['OBJECT_STORAGE_PROVIDER'],
      });
    }
    if (!env.OBJECT_STORAGE_BUCKET) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'is required in production',
        path: ['OBJECT_STORAGE_BUCKET'],
      });
    }
    if (!env.OBJECT_STORAGE_REGION) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'is required in production',
        path: ['OBJECT_STORAGE_REGION'],
      });
    }
    if (!env.WEBHOOK_SIGNING_MASTER_SECRET || env.WEBHOOK_SIGNING_MASTER_SECRET.length < 32) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'must contain at least 32 characters in production', path: ['WEBHOOK_SIGNING_MASTER_SECRET'] });
    }
    if (!env.CONNECTOR_CREDENTIAL_ENCRYPTION_KEY || env.CONNECTOR_CREDENTIAL_ENCRYPTION_KEY.length < 32) context.addIssue({ code: z.ZodIssueCode.custom, message: 'must contain at least 32 characters in production', path: ['CONNECTOR_CREDENTIAL_ENCRYPTION_KEY'] });
    if (env.REQUIREMENTS_AI_PROVIDER === 'local-fixture') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'local-fixture is for local development only and is not allowed in production',
        path: ['REQUIREMENTS_AI_PROVIDER'],
      });
    }
    if (env.REVIEW_PUBLIC_URL
      && (!env.REVIEW_GRANT_SECRET || env.REVIEW_GRANT_SECRET.length < 32 || env.REVIEW_GRANT_SECRET === DEVELOPMENT_REVIEW_GRANT_SECRET)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must be a non-default secret with at least 32 characters in production when REVIEW_PUBLIC_URL is set',
        path: ['REVIEW_GRANT_SECRET'],
      });
    }
  });

// Express `trust proxy`: which peers may set X-Forwarded-For. The default trusts only a
// proxy on the same host (such as Apache or nginx). A number is a hop count;
// "false" ignores forwarded headers; anything else is Express's address list syntax.
function parseTrustProxy(value) {
  const text = String(value ?? '').trim();
  if (!text) return 'loopback';
  if (text.toLowerCase() === 'false') return false;
  if (/^\d+$/.test(text)) return Number(text);
  return text;
}

// Same value as DEVELOPMENT_GRANT_SECRET in modules/requirements/packages/package-grants.js.
const DEVELOPMENT_REVIEW_GRANT_SECRET = 'odin-local-review-grant-secret-do-not-use-in-production';

// The review origin serves untrusted package HTML, so it must never share an origin with
// the app or the API.
function parseReviewOrigin({ appOrigin, backendOrigin, nodeEnv, port, reviewPort, value }) {
  if (!value) return '';
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_error) {
    throw new Error('Invalid environment configuration. REVIEW_PUBLIC_URL must be an http(s) origin.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== value.replace(/\/$/, '')) {
    throw new Error('Invalid environment configuration. REVIEW_PUBLIC_URL must be an exact http(s) origin with no path.');
  }
  if (nodeEnv === 'production' && parsed.protocol !== 'https:') {
    throw new Error('Invalid environment configuration. REVIEW_PUBLIC_URL must use HTTPS in production.');
  }
  if (parsed.origin === appOrigin || parsed.origin === backendOrigin) {
    throw new Error('Invalid environment configuration. REVIEW_PUBLIC_URL must be a different origin from FRONTEND_APP_URL and BACKEND_PUBLIC_URL.');
  }
  if (reviewPort === port) {
    throw new Error('Invalid environment configuration. REVIEW_PORT must differ from PORT.');
  }
  return parsed.origin;
}

function parseAllowedOrigins(value = '', frontendAppUrl = '') {
  const configuredOrigins = String(value ?? '').split(',').map((origin) => origin.trim()).filter(Boolean);
  const frontendOrigin = new URL(frontendAppUrl).origin;
  const origins = [...new Set([frontendOrigin, ...configuredOrigins])];

  return origins.map((origin) => {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || !['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`Invalid environment configuration. CORS_ALLOWED_ORIGINS: ${origin} must be an exact http(s) origin`);
    }
    return parsed.origin;
  });
}

function parseEmailList(value = '', name = 'env') {
  const emails = [...new Set(String(value ?? '').split(',').map((email) => email.trim().toLowerCase()).filter(Boolean))];
  for (const email of emails) {
    if (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(email)) {
      throw new Error(`Invalid environment configuration. ${name}: ${email} is not an email address`);
    }
  }
  return emails;
}

export function loadEnv(source = process.env) {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('; ');

    throw new Error(`Invalid environment configuration. ${message}`);
  }

  // The source is public, so the built-in secret is known to everyone. Outside an environment
  // that says it is for development or tests, a missing or short secret stops the server.
  const declaredEnv = String(source.NODE_ENV ?? '').trim();
  if ((parsed.data.JWT_SECRET === DEVELOPMENT_JWT_SECRET || parsed.data.JWT_SECRET.length < 32) && declaredEnv !== 'development' && declaredEnv !== 'test') {
    throw new Error('Invalid environment configuration. JWT_SECRET: set it to at least 32 random characters, or set NODE_ENV=development (or test) to use the built-in development secret.');
  }

  let corsAllowedOrigins;
  let backendPublicUrl;
  let mcpPublicUrl = '';
  let mcpAllowedOrigins = [];
  try {
    corsAllowedOrigins = parseAllowedOrigins(parsed.data.CORS_ALLOWED_ORIGINS, parsed.data.FRONTEND_APP_URL);
    const defaultBackendUrl = parsed.data.NODE_ENV === 'production'
      ? new URL(parsed.data.FRONTEND_APP_URL).origin
      : `http://localhost:${parsed.data.PORT}`;
    const configuredBackendUrl = new URL(parsed.data.BACKEND_PUBLIC_URL || defaultBackendUrl);
    if (configuredBackendUrl.origin !== configuredBackendUrl.toString().replace(/\/$/, '')
      || !['http:', 'https:'].includes(configuredBackendUrl.protocol)
      || (parsed.data.NODE_ENV === 'production' && configuredBackendUrl.protocol !== 'https:')) {
      throw new Error('Invalid environment configuration. BACKEND_PUBLIC_URL must be an exact HTTPS origin in production and an exact http(s) origin otherwise.');
    }
    backendPublicUrl = configuredBackendUrl.origin;
    if (parsed.data.MCP_PUBLIC_URL) {
      const mcpUrl = validateMcpPublicUrl(parsed.data.MCP_PUBLIC_URL);
      if (parsed.data.NODE_ENV === 'production' && mcpUrl.protocol !== 'https:') throw new Error('MCP_PUBLIC_URL must use HTTPS in production.');
      if (mcpUrl.origin !== backendPublicUrl) throw new Error('MCP_PUBLIC_URL must use BACKEND_PUBLIC_URL origin.');
      mcpPublicUrl = mcpUrl.href;
      mcpAllowedOrigins = parseAllowedOrigins(parsed.data.MCP_ALLOWED_ORIGINS, parsed.data.FRONTEND_APP_URL);
    }
  } catch (error) {
    throw error instanceof Error ? error : new Error('Invalid environment configuration. CORS_ALLOWED_ORIGINS is invalid.');
  }
  const reviewPort = parsed.data.REVIEW_PORT ?? 3002;
  const reviewPublicUrl = parseReviewOrigin({
    appOrigin: new URL(parsed.data.FRONTEND_APP_URL).origin,
    backendOrigin: backendPublicUrl,
    nodeEnv: parsed.data.NODE_ENV,
    port: parsed.data.PORT,
    reviewPort,
    value: parsed.data.REVIEW_PUBLIC_URL ?? '',
  });

  return {
    nodeEnv: parsed.data.NODE_ENV,
    port: parsed.data.PORT,
    backendPublicUrl,
    mcpPublicUrl,
    mcpAllowedOrigins,
    databaseUrl: parsed.data.DATABASE_URL ?? '',
    jwtIssuer: parsed.data.JWT_ISSUER,
    jwtSecret: parsed.data.JWT_SECRET,
    seedDemoUser: parsed.data.SEED_DEMO_USER === true && parsed.data.NODE_ENV !== 'production',
    frontendAppUrl: parsed.data.FRONTEND_APP_URL,
    invoiceGenBaseUrl: (parsed.data.INVOICE_GEN_BASE_URL ?? '').replace(/\/+$/, ''),
    webPush: {
      privateKey: parsed.data.WEB_PUSH_VAPID_PRIVATE_KEY ?? '',
      publicKey: parsed.data.WEB_PUSH_VAPID_PUBLIC_KEY ?? '',
      subject: parsed.data.WEB_PUSH_SUBJECT ?? '',
    },
    corsAllowedOrigins,
    jsonBodyLimitBytes: parsed.data.JSON_BODY_LIMIT_BYTES ?? 1024 * 1024,
    googleOauthClientId: parsed.data.GOOGLE_OAUTH_CLIENT_ID ?? '',
    googleOauthClientSecret: parsed.data.GOOGLE_OAUTH_CLIENT_SECRET ?? '',
    googleOauthRedirectUri: parsed.data.GOOGLE_OAUTH_REDIRECT_URI ?? '',
    recaptchaSiteKey: parsed.data.RECAPTCHA_SITE_KEY ?? '',
    recaptchaSecretKey: parsed.data.RECAPTCHA_SECRET_KEY ?? '',
    accessRequestNotifyEmails: parseEmailList(parsed.data.ACCESS_REQUEST_NOTIFY_EMAILS, 'ACCESS_REQUEST_NOTIFY_EMAILS'),
    openAiApiKey: parsed.data.OPENAI_API_KEY ?? '',
    openAiModel: parsed.data.OPENAI_MODEL ?? '',
    openAiMemoryEmbeddingModel: parsed.data.OPENAI_MEMORY_EMBEDDING_MODEL ?? 'text-embedding-3-small',
    openAiMemoryEmbeddingDimensions: parsed.data.OPENAI_MEMORY_EMBEDDING_DIMENSIONS ?? 256,
    searchEmbeddingModel: parsed.data.SEARCH_EMBEDDING_MODEL || 'text-embedding-3-large',
    searchEmbeddingDimensions: parsed.data.SEARCH_EMBEDDING_DIMENSIONS ?? 1024,
    searchIndexIntervalMs: parsed.data.SEARCH_INDEX_INTERVAL_MS ?? 60_000,
    searchSemanticMinSimilarity: parsed.data.SEARCH_SEMANTIC_MIN_SIMILARITY ?? null,
    // The Odin summary on requirements topics and rounds.
    requirementsSummaryModel: parsed.data.REQUIREMENTS_SUMMARY_MODEL || 'gpt-6-luna',
    requirementsSummaryReasoningEffort: parsed.data.REQUIREMENTS_SUMMARY_REASONING_EFFORT ?? 'max',
    assistantTurnTimeoutMs: parsed.data.ASSISTANT_TURN_TIMEOUT_MS ?? 0,
    assistantAgent: {
      decisionsEnabled: parsed.data.ASSISTANT_DECISIONS_ENABLED !== 'false',
      decisionsModel: parsed.data.ASSISTANT_DECISIONS_MODEL || 'gpt-6-luna',
      decisionsTimeoutMs: parsed.data.ASSISTANT_DECISIONS_TIMEOUT_MS ?? 4000,
      maxOutputTokens: parsed.data.ASSISTANT_MAX_OUTPUT_TOKENS ?? 32000,
      maxToolCalls: parsed.data.ASSISTANT_MAX_TOOL_CALLS ?? 420,
      reasoningComplex: parsed.data.ASSISTANT_REASONING_COMPLEX ?? 'max',
      reasoningSimple: parsed.data.ASSISTANT_REASONING_SIMPLE ?? 'max',
      toolCallsPerTask: parsed.data.ASSISTANT_TOOL_CALLS_PER_TASK ?? 40,
      writeCheckThreshold: parsed.data.ASSISTANT_WRITE_CHECK_THRESHOLD ?? 0.3,
      writeCheckThresholdOnChange: parsed.data.ASSISTANT_WRITE_CHECK_THRESHOLD_CHANGE ?? 0.1,
      compactAtTokens: parsed.data.ASSISTANT_COMPACT_AT_TOKENS ?? 120000,
    },
    vaultStoragePath: parsed.data.VAULT_STORAGE_PATH ?? '',
    avatarStoragePath: parsed.data.AVATAR_STORAGE_PATH ?? '',
    objectStorageProvider: parsed.data.OBJECT_STORAGE_PROVIDER,
    objectStorageBucket: parsed.data.OBJECT_STORAGE_BUCKET ?? '',
    objectStorageRegion: parsed.data.OBJECT_STORAGE_REGION ?? '',
    objectStorageEndpoint: parsed.data.OBJECT_STORAGE_ENDPOINT ?? '',
    objectStorageForcePathStyle: parsed.data.OBJECT_STORAGE_FORCE_PATH_STYLE ?? false,
    objectStoragePrefix: parsed.data.OBJECT_STORAGE_PREFIX ?? 'odin',
    objectStoragePublicEndpoint: parsed.data.OBJECT_STORAGE_PUBLIC_ENDPOINT ?? '',
    fileUploadMaxBytes: parsed.data.FILE_UPLOAD_MAX_BYTES ?? 1_073_741_824,
    fileTransferSecret: parsed.data.FILE_TRANSFER_SECRET ?? parsed.data.JWT_SECRET,
    smtpHost: parsed.data.SMTP_HOST ?? '',
    smtpPort: parsed.data.SMTP_PORT ?? 587,
    smtpUser: parsed.data.SMTP_USER ?? '',
    smtpPass: parsed.data.SMTP_PASS ?? '',
    smtpStartTls: parsed.data.SMTP_STARTTLS ?? true,
    mailFromAddress: parsed.data.MAIL_FROM_ADDRESS ?? 'noreply@odinpmp.com',
    mailFromName: parsed.data.MAIL_FROM_NAME ?? 'OdinPMP',
    mailReplyDomain: parsed.data.MAIL_REPLY_DOMAIN ?? '',
    clarificationDigestQuietMinutes: parsed.data.CLARIFICATION_DIGEST_QUIET_MINUTES ?? 20,
    bugReporterEmailReplies: parsed.data.BUG_REPORTER_EMAIL_REPLIES ?? false,
    inboundMailWebhookSecret: parsed.data.INBOUND_MAIL_WEBHOOK_SECRET ?? '',
    webhookSigningMasterSecret: parsed.data.WEBHOOK_SIGNING_MASTER_SECRET ?? (parsed.data.JWT_SECRET.length >= 32 ? parsed.data.JWT_SECRET : 'odin-local-webhook-signing-master-secret'),
    connectorCredentialEncryptionKey: parsed.data.CONNECTOR_CREDENTIAL_ENCRYPTION_KEY ?? '',
    sloP95LatencyMs: parsed.data.SLO_P95_LATENCY_MS ?? 1000,
    sloErrorRatePercent: parsed.data.SLO_ERROR_RATE_PERCENT ?? 1,
    clamavEnabled: parsed.data.CLAMAV_ENABLED ?? false,
    clamavHost: parsed.data.CLAMAV_HOST ?? '',
    clamavPort: parsed.data.CLAMAV_PORT ?? 3310,
    clamavSocketPath: parsed.data.CLAMAV_SOCKET_PATH ?? '',
    clamavTimeoutMs: parsed.data.CLAMAV_TIMEOUT_MS ?? 30_000,
    clamavStreamTimeoutMs: parsed.data.CLAMAV_STREAM_TIMEOUT_MS ?? 15 * 60_000,
    previewSofficePath: parsed.data.PREVIEW_SOFFICE_PATH ?? 'soffice',
    previewMaxBytes: parsed.data.PREVIEW_MAX_BYTES ?? 100 * 1024 * 1024,
    previewTimeoutMs: parsed.data.PREVIEW_TIMEOUT_MS ?? 120_000,
    requirementsAiProvider: parsed.data.REQUIREMENTS_AI_PROVIDER ?? 'openai',
    reviewPublicUrl,
    reviewPort,
    reviewGrantSecret: parsed.data.REVIEW_GRANT_SECRET || DEVELOPMENT_REVIEW_GRANT_SECRET,
    reviewPackageMaxBytes: parsed.data.REVIEW_PACKAGE_MAX_BYTES ?? 50 * 1024 * 1024,
    signingSealKey: parsed.data.SIGNING_SEAL_KEY ?? '',
    signingSealKeyId: parsed.data.SIGNING_SEAL_KEY_ID ?? '',
    signingSealKeysPrevious: parsed.data.SIGNING_SEAL_KEYS_PREVIOUS ?? '',
    trustProxy: parseTrustProxy(parsed.data.TRUST_PROXY),
  };
}
