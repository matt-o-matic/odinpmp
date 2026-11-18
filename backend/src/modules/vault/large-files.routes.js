import { pipeline } from 'node:stream/promises';

import { Router } from 'express';

import { HttpError } from '../../lib/errors/http-error.js';
import { receiveUploadPart, resolveDownloadToken } from './large-files.service.js';

// The signed backend URLs that move file bytes when storage is local disk (development and
// tests). With S3 the browser talks to S3 and these are never handed out. The token in the path
// is the whole authorization: it names one upload part or one object, and expires (an hour for a
// part, 5 minutes for a download). Bytes are streamed both ways, never held whole.
//
// A download sent inline may be shown inside the app (a PDF in the files panel's viewer), so its
// response lets the app's own origins frame it. Every other response keeps the API's headers,
// which let nothing frame it.

// One range of a Range header (bytes=a-b, bytes=a- or bytes=-n), or null to send everything.
// Returns 'invalid' for a range outside the object.
export function parseByteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  let start;
  let end;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (suffix === 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { end, start };
}

export function inlineFramePolicy(origins = []) {
  const allowed = [...new Set(origins.map((origin) => {
    try {
      return new URL(origin).origin;
    } catch {
      return null;
    }
  }).filter((origin) => origin && origin !== 'null'))];
  return `default-src 'none'; frame-ancestors ${allowed.length ? allowed.join(' ') : "'none'"}; base-uri 'none'`;
}

export function createFileTransferRouter(deps) {
  const router = Router();
  const framePolicy = inlineFramePolicy(deps.fileFrameAncestors ?? []);
  const large = {
    clock: deps.fileClock,
    fileStorage: deps.fileStorage,
    projectRepository: deps.projectRepository,
    transferSigner: deps.fileTransferSigner,
  };

  router.put('/api/file-transfers/parts/:token', async (request, response, next) => {
    try {
      const { etag, size } = await receiveUploadPart(large, request.params.token, request);
      response.setHeader('ETag', etag);
      response.setHeader('Access-Control-Expose-Headers', 'ETag');
      response.status(200).json({ ok: true, size });
    } catch (error) {
      // Stop reading a body nobody will store.
      request.unpipe?.();
      if (!request.complete) request.resume();
      next(error);
    }
  });

  router.get('/api/file-transfers/files/:token', async (request, response, next) => {
    try {
      const target = resolveDownloadToken(large, request.params.token);
      const stat = await deps.fileStorage?.stat?.(target.storageKey);
      if (!stat) throw new HttpError(404, 'File not found.');
      const range = parseByteRange(request.headers.range, stat.size);
      response.setHeader('Accept-Ranges', 'bytes');
      response.setHeader('Cache-Control', 'private, no-store');
      response.setHeader('Content-Disposition', target.disposition);
      response.setHeader('Content-Type', target.contentType || 'application/octet-stream');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      if (/^inline;/.test(target.disposition ?? '')) {
        response.removeHeader('X-Frame-Options');
        response.setHeader('Content-Security-Policy', framePolicy);
      }
      if (range === 'invalid') {
        response.setHeader('Content-Range', `bytes */${stat.size}`);
        response.status(416).end();
        return;
      }
      const { stream } = await deps.fileStorage.createReadStream(target.storageKey, range ?? {});
      if (range) {
        response.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
        response.setHeader('Content-Length', String(range.end - range.start + 1));
        response.status(206);
      } else {
        response.setHeader('Content-Length', String(stat.size));
        response.status(200);
      }
      if (request.method === 'HEAD') {
        stream.destroy?.();
        response.end();
        return;
      }
      await pipeline(stream, response);
    } catch (error) {
      if (response.headersSent) response.destroy(error);
      else next(error);
    }
  });

  return router;
}
