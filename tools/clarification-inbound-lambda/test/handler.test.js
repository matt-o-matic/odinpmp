import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { buildInboundPayloadFromEmail, readSesVerdicts } from '../src/email.js';
import { createHandler } from '../src/handler.js';
import { forwardInboundPayload } from '../src/webhook.js';

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));

async function readFixture(name) {
  const fixturePath = path.join(FIXTURES_DIR, name);
  return fs.readFile(fixturePath);
}

function buildRawEmailWithAttachment({ attachmentContent, attachmentName = 'oversized.txt' } = {}) {
  const encodedAttachment = Buffer.from(attachmentContent).toString('base64');

  return Buffer.from(`Return-Path: <reviewer@example.com>
Message-ID: <message-3@reply.odinpmp.com>
In-Reply-To: <thread-3@reply.odinpmp.com>
Date: Mon, 17 May 2026 12:00:00 -0400
From: Reviewer Example <reviewer@example.com>
To: clarification+replytoken@reply.odinpmp.com
Subject: Re: Clarification needed for Apollo
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="mix-oversized"

--mix-oversized
Content-Type: text/plain; charset="UTF-8"

The attachment is too large for the webhook payload.
--mix-oversized
Content-Type: text/plain; name="${attachmentName}"
Content-Disposition: attachment; filename="${attachmentName}"
Content-Transfer-Encoding: base64

${encodedAttachment}
--mix-oversized--
`, 'utf8');
}

test('buildInboundPayloadFromEmail maps a text-only reply into the existing clarification webhook schema', async () => {
  const payload = await buildInboundPayloadFromEmail({
    rawEmail: await readFixture('text-reply.eml'),
  });

  assert.deepEqual(payload.attachments, []);
  assert.equal(payload.fromEmail, 'reviewer@example.com');
  assert.equal(payload.htmlBody, '');
  assert.equal(payload.inReplyTo, '<thread-1@reply.odinpmp.com>');
  assert.equal(payload.messageId, '<message-1@reply.odinpmp.com>');
  assert.equal(payload.provider, 'aws-ses');
  assert.equal(payload.subject, 'Re: Clarification needed for Apollo');
  assert.match(payload.textBody, /Approved\. Please proceed/);
  assert.equal(payload.toEmail, 'clarification+replytoken@reply.odinpmp.com');
});

test('buildInboundPayloadFromEmail preserves html content and small attachments', async () => {
  const payload = await buildInboundPayloadFromEmail({
    rawEmail: await readFixture('html-attachment-reply.eml'),
  });

  assert.equal(payload.attachments.length, 1);
  assert.deepEqual(payload.attachments[0], {
    contentBase64: Buffer.from('approval-evidence').toString('base64'),
    contentType: 'text/plain',
    fileName: 'approval.txt',
  });
  assert.match(payload.htmlBody, /<strong>Approved<\/strong>/);
  assert.match(payload.textBody, /See the attachment/);
});

test('buildInboundPayloadFromEmail drops attachments that exceed the payload cap and appends an operator note', async () => {
  const payload = await buildInboundPayloadFromEmail({
    maxAttachmentBytes: 10,
    rawEmail: buildRawEmailWithAttachment({
      attachmentContent: 'this attachment body is larger than ten bytes',
    }),
  });

  assert.deepEqual(payload.attachments, []);
  assert.match(payload.textBody, /Oversized attachments were not forwarded to Odin/);
});

test('forwardInboundPayload treats webhook 4xx responses as terminal non-retryable outcomes', async () => {
  const result = await forwardInboundPayload({
    fetchImpl: async () => new Response(JSON.stringify({ ok: false }), {
      headers: {
        'content-type': 'application/json',
      },
      status: 409,
    }),
    payload: {
      attachments: [],
      fromEmail: 'reviewer@example.com',
      htmlBody: '',
      inReplyTo: '',
      messageId: '<message-1@reply.odinpmp.com>',
      provider: 'aws-ses',
      subject: 'Re: Clarification needed for Apollo',
      textBody: 'Approved',
      toEmail: 'clarification+replytoken@reply.odinpmp.com',
    },
    webhookSecret: 'inbound-secret',
    webhookUrl: 'https://odinpmp.com/api/public/clarification-mail/inbound',
  });

  assert.deepEqual(result, {
    retryable: false,
    statusCode: 409,
  });
});

test('forwardInboundPayload throws on webhook 5xx responses so Lambda retries can handle transient failures', async () => {
  await assert.rejects(
    forwardInboundPayload({
      fetchImpl: async () => new Response('upstream unavailable', { status: 503 }),
      payload: {
        attachments: [],
        fromEmail: 'reviewer@example.com',
        htmlBody: '',
        inReplyTo: '',
        messageId: '<message-1@reply.odinpmp.com>',
        provider: 'aws-ses',
        subject: 'Re: Clarification needed for Apollo',
        textBody: 'Approved',
        toEmail: 'clarification+replytoken@reply.odinpmp.com',
      },
      webhookSecret: 'inbound-secret',
      webhookUrl: 'https://odinpmp.com/api/public/clarification-mail/inbound',
    }),
    /503/,
  );
});

test('createHandler reads raw email from S3 and forwards the parsed payload to the existing Odin webhook', async () => {
  const fetchCalls = [];
  const handler = createHandler({
    config: {
      maxAttachmentBytes: 1024,
      rawEmailBucket: 'odinpmp-clarification-inbound',
      region: 'us-east-2',
      webhookSecret: 'inbound-secret',
      webhookUrl: 'https://odinpmp.com/api/public/clarification-mail/inbound',
    },
    fetchImpl: async (url, options) => {
      fetchCalls.push({ options, url });
      return new Response(JSON.stringify({ ok: true }), {
        headers: {
          'content-type': 'application/json',
        },
        status: 201,
      });
    },
    s3Client: {
      async send(command) {
        assert.equal(command.input.Bucket, 'odinpmp-clarification-inbound');
        assert.equal(command.input.Key, 'clarification/inbound/message-1.eml');
        return {
          Body: Readable.from([await readFixture('text-reply.eml')]),
        };
      },
    },
  });

  const result = await handler({
    Records: [
      {
        s3: {
          bucket: {
            name: 'odinpmp-clarification-inbound',
          },
          object: {
            key: 'clarification%2Finbound%2Fmessage-1.eml',
          },
        },
      },
    ],
  });

  assert.equal(result.processed, 1);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://odinpmp.com/api/public/clarification-mail/inbound');
  const payload = JSON.parse(fetchCalls[0].options.body);
  assert.equal(payload.messageId, '<message-1@reply.odinpmp.com>');
  assert.equal(payload.toEmail, 'clarification+replytoken@reply.odinpmp.com');
});

test('buildInboundPayloadFromEmail forwards the SES verdicts and the automatic reply headers', async () => {
  const payload = await buildInboundPayloadFromEmail({ rawEmail: await readFixture('bugreport-reply.eml') });

  assert.deepEqual(payload.verdicts, { spam: 'pass', virus: 'pass', spf: 'pass', dkim: 'pass', dmarc: 'pass' });
  assert.deepEqual(payload.autoReplyHeaders, { autoSubmitted: 'auto-replied', precedence: 'bulk', xAutoreply: 'yes' });
  assert.equal(payload.toEmail, 'bugreport+0123456789abcdef0123456789abcdef01234567@reply.odinpmp.com');
});

test('readSesVerdicts ignores results a sender places below the SES header block', () => {
  const forged = Buffer.from([
    'Return-Path: <attacker@example.net>',
    'Received: from attacker by inbound-smtp.us-east-2.amazonaws.com with SMTP id synthetic',
    'X-SES-Spam-Verdict: FAIL',
    'X-SES-Virus-Verdict: PASS',
    'Authentication-Results: amazonses.com; spf=fail; dkim=none; dmarc=fail',
    'X-SES-Spam-Verdict: PASS',
    'Authentication-Results: amazonses.com; spf=pass; dkim=pass; dmarc=pass',
    'From: attacker@example.net',
    '',
    'body',
  ].join('\r\n'));
  assert.deepEqual(readSesVerdicts(forged), { spam: 'fail', virus: 'pass', spf: 'fail', dkim: 'none', dmarc: 'fail' });

  const noSesBlock = Buffer.from('From: attacker@example.net\r\nX-SES-Spam-Verdict: PASS\r\nAuthentication-Results: amazonses.com; spf=pass; dkim=pass\r\n\r\nbody');
  assert.deepEqual(readSesVerdicts(noSesBlock), {});
});

test('buildInboundPayloadFromEmail never adds the operator note to a Bug Reporter reply', async () => {
  const raw = buildRawEmailWithAttachment({ attachmentContent: 'x'.repeat(64) })
    .toString('utf8')
    .replace('clarification+replytoken@reply.odinpmp.com', 'bugreport+0123456789abcdef0123456789abcdef01234567@reply.odinpmp.com');
  const payload = await buildInboundPayloadFromEmail({ maxAttachmentBytes: 10, rawEmail: Buffer.from(raw) });

  assert.deepEqual(payload.attachments, []);
  assert.doesNotMatch(payload.textBody, /Oversized attachments/);
});
