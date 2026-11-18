import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';

import { loadConfig } from './config.js';
import { buildInboundPayloadFromEmail } from './email.js';
import { forwardInboundPayload } from './webhook.js';

function decodeS3Key(value) {
  return decodeURIComponent(String(value ?? '').replaceAll('+', ' '));
}

async function readBodyToBuffer(body) {
  if (!body) {
    return Buffer.alloc(0);
  }

  if (Buffer.isBuffer(body)) {
    return body;
  }

  if (typeof body.transformToByteArray === 'function') {
    return Buffer.from(await body.transformToByteArray());
  }

  if (typeof body.transformToString === 'function') {
    return Buffer.from(await body.transformToString());
  }

  if (typeof body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  throw new Error('Unsupported S3 object body type.');
}

async function processRecord({
  config,
  fetchImpl,
  record,
  s3Client,
} = {}) {
  const bucket = String(record?.s3?.bucket?.name ?? '').trim();
  const key = decodeS3Key(record?.s3?.object?.key ?? '');

  if (!bucket || !key) {
    return { processed: false, skipped: true, terminal: false };
  }

  if (config.rawEmailBucket && bucket !== config.rawEmailBucket) {
    console.warn(`Skipping inbound email from unexpected bucket ${bucket}. Expected ${config.rawEmailBucket}.`);
    return { processed: false, skipped: true, terminal: false };
  }

  const response = await s3Client.send(new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  }));
  const rawEmail = await readBodyToBuffer(response.Body);
  const payload = await buildInboundPayloadFromEmail({
    maxAttachmentBytes: config.maxAttachmentBytes,
    rawEmail,
  });
  const delivery = await forwardInboundPayload({
    fetchImpl,
    payload,
    webhookSecret: config.webhookSecret,
    webhookUrl: config.webhookUrl,
  });

  return {
    processed: true,
    skipped: false,
    terminal: delivery.statusCode >= 400 && delivery.statusCode < 500,
  };
}

export function createHandler({
  config = loadConfig(),
  fetchImpl = globalThis.fetch,
  s3Client = new S3Client({ region: config.region }),
} = {}) {
  return async function handler(event = {}) {
    const summary = {
      processed: 0,
      skipped: 0,
      terminalFailures: 0,
    };

    for (const record of event.Records ?? []) {
      const outcome = await processRecord({
        config,
        fetchImpl,
        record,
        s3Client,
      });

      if (outcome.processed) {
        summary.processed += 1;
      }
      if (outcome.skipped) {
        summary.skipped += 1;
      }
      if (outcome.terminal) {
        summary.terminalFailures += 1;
      }
    }

    return summary;
  };
}

export const handler = createHandler();
export default handler;
