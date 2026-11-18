export const WEBHOOK_BODY_LIMIT = 200_000;
export const DEFAULT_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(source = process.env) {
  return {
    maxAttachmentBytes: parsePositiveInteger(source.MAX_ATTACHMENT_BYTES, DEFAULT_MAX_ATTACHMENT_BYTES),
    rawEmailBucket: String(source.RAW_EMAIL_BUCKET ?? '').trim(),
    region: String(source.AWS_REGION ?? source.AWS_DEFAULT_REGION ?? 'us-east-2').trim() || 'us-east-2',
    webhookSecret: String(source.WEBHOOK_SECRET ?? '').trim(),
    webhookUrl: String(source.WEBHOOK_URL ?? '').trim(),
  };
}
