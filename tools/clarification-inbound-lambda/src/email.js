import { simpleParser } from 'mailparser';

import { DEFAULT_MAX_ATTACHMENT_BYTES, WEBHOOK_BODY_LIMIT } from './config.js';

const OVERSIZED_ATTACHMENT_NOTE = 'Oversized attachments were not forwarded to Odin. The original raw email remains available in S3 for operator review.';

function clampString(value, maxLength) {
  const normalized = String(value ?? '');
  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
}

function firstAddress(addressObject) {
  return String(addressObject?.value?.[0]?.address ?? '').trim().toLowerCase();
}

function normalizedHtml(value) {
  return typeof value === 'string' ? value : '';
}

function appendBodyNote(value, note, { html = false } = {}) {
  const normalized = String(value ?? '').trim();

  if (!note) {
    return clampString(normalized, WEBHOOK_BODY_LIMIT);
  }

  if (html) {
    const content = normalized
      ? `${normalized}\n<p>${note}</p>`
      : `<p>${note}</p>`;
    return clampString(content, WEBHOOK_BODY_LIMIT);
  }

  const content = normalized
    ? `${normalized}\n\n${note}`
    : note;
  return clampString(content, WEBHOOK_BODY_LIMIT);
}

// Headers SES adds on receipt, ahead of the message's own headers.
const SES_HEADERS = new Set(['return-path', 'received', 'received-spf', 'authentication-results', 'x-ses-spam-verdict', 'x-ses-virus-verdict', 'x-ses-receipt', 'x-ses-dkim-signature', 'x-ses-outgoing']);

function rawHeaders(rawEmail) {
  const text = Buffer.from(rawEmail ?? '').toString('latin1');
  const end = text.search(/\r?\n\r?\n/);
  return (end === -1 ? text : text.slice(0, end))
    .replace(/\r?\n[ \t]+/g, ' ')
    .split(/\r?\n/)
    .map((line) => {
      const colon = line.indexOf(':');
      return colon > 0 ? { name: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1).trim() } : null;
    })
    .filter(Boolean);
}

/**
 * Reads the spam, virus, SPF, DKIM and DMARC results from the header block SES adds above
 * the message. Only the first copy of each header in that block counts, so a sender cannot
 * supply its own results lower down.
 */
export function readSesVerdicts(rawEmail) {
  const verdicts = {};
  let received = 0;
  for (const { name, value } of rawHeaders(rawEmail)) {
    if (!SES_HEADERS.has(name) || (name === 'received' && ++received > 1)) break;
    if (name === 'x-ses-spam-verdict') verdicts.spam ??= value.toLowerCase();
    if (name === 'x-ses-virus-verdict') verdicts.virus ??= value.toLowerCase();
    if (name === 'authentication-results' && verdicts.authenticated === undefined) {
      const [server, ...results] = value.split(';');
      if (server.trim().toLowerCase() !== 'amazonses.com') continue;
      verdicts.authenticated = true;
      for (const result of results) {
        const match = /^\s*(spf|dkim|dmarc)\s*=\s*([a-z_]+)/i.exec(result);
        if (!match) continue;
        const method = match[1].toLowerCase();
        const outcome = match[2].toLowerCase();
        if (verdicts[method] === undefined || (method === 'dkim' && outcome === 'pass')) verdicts[method] = outcome;
      }
    }
  }
  delete verdicts.authenticated;
  return verdicts;
}

export function readAutoReplyHeaders(rawEmail) {
  const headers = rawHeaders(rawEmail);
  const first = (name) => clampString(headers.find((header) => header.name === name)?.value ?? '', 255);
  return {
    autoSubmitted: first('auto-submitted'),
    precedence: first('precedence'),
    xAutoreply: first('x-autoreply'),
  };
}

function normalizeAttachment(attachment, index) {
  return {
    contentBase64: Buffer.from(attachment.content ?? '').toString('base64'),
    contentType: clampString(attachment.contentType || 'application/octet-stream', 255),
    fileName: clampString(attachment.filename || `attachment-${index + 1}`, 255),
  };
}

export async function buildInboundPayloadFromEmail({
  provider = 'aws-ses',
  maxAttachmentBytes = DEFAULT_MAX_ATTACHMENT_BYTES,
  rawEmail,
} = {}) {
  const parsed = await simpleParser(rawEmail);
  const fromEmail = firstAddress(parsed.from);
  const toEmail = firstAddress(parsed.to);
  const messageId = clampString(parsed.messageId ?? '', 255);

  if (!fromEmail || !toEmail || !messageId) {
    throw new Error('Inbound email is missing required addressing headers or message id.');
  }

  const textBody = clampString(parsed.text ?? '', WEBHOOK_BODY_LIMIT);
  const htmlBody = clampString(normalizedHtml(parsed.html), WEBHOOK_BODY_LIMIT);
  const attachmentBytes = (parsed.attachments ?? []).reduce((total, attachment) => {
    return total + Number(attachment?.content?.length ?? 0);
  }, 0);
  const oversizedAttachments = attachmentBytes > maxAttachmentBytes;
  // Bug Reporter replies reach the reporter's report, so they never carry the operator note.
  const note = oversizedAttachments && !toEmail.startsWith('bugreport+') ? OVERSIZED_ATTACHMENT_NOTE : '';

  return {
    attachments: oversizedAttachments
      ? []
      : (parsed.attachments ?? []).map(normalizeAttachment),
    autoReplyHeaders: readAutoReplyHeaders(rawEmail),
    fromEmail,
    htmlBody: note
      ? appendBodyNote(htmlBody, note, { html: true })
      : htmlBody,
    inReplyTo: clampString(parsed.inReplyTo ?? '', 255),
    messageId,
    provider: clampString(provider, 80),
    subject: clampString(parsed.subject ?? '', 255),
    textBody: note
      ? appendBodyNote(textBody, note)
      : textBody,
    toEmail,
    verdicts: readSesVerdicts(rawEmail),
  };
}
