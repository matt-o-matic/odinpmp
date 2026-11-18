import net from 'node:net';

function connectClamd({ host, port, socketPath, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = socketPath
      ? net.connect({ path: socketPath })
      : net.connect({ host, port });

    const timer = setTimeout(() => {
      socket.destroy(new Error('ClamAV scan timed out.'));
    }, timeoutMs);

    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
  });
}

async function readClamdResponse(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('ClamAV response timed out.'));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('end', onEnd);
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    function onEnd() {
      cleanup();
      resolve(buffer);
    }

    function onData(chunk) {
      buffer += chunk.toString('utf8');

      // clamd terminates responses with a newline.
      if (buffer.includes('\n') || buffer.includes('\0')) {
        cleanup();
        resolve(buffer);
      }
    }

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('end', onEnd);
  });
}

function encodeChunkLength(length) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(length, 0);
  return header;
}

// A connection ClamAV never answered: the file stays pending and the worker tries again later.
function unavailable(error) {
  return Object.assign(new Error(`ClamAV is unavailable: ${error?.message ?? error}`), { cause: error, code: 'scanner_unavailable' });
}

function parseClamdVerdict(response) {
  const normalized = String(response ?? '').replace(/\0/g, '').trim();
  if (/\bOK$/i.test(normalized)) return { clean: true, response: normalized, scanner: 'clamav' };
  if (/FOUND$/i.test(normalized)) return { clean: false, response: normalized, scanner: 'clamav' };
  // "INSTREAM size limit exceeded. ERROR" and the like: ClamAV answered but could not scan.
  throw Object.assign(new Error(`ClamAV could not scan the file: ${normalized || '<empty>'}`), { code: 'scan_error' });
}

/**
 * Sends a stream to clamd with INSTREAM, one chunk at a time, waiting for the socket to drain so
 * no more than a chunk or two is ever held. Each chunk also goes to onChunk, so the caller can
 * hash the file in the same pass. ClamAV may answer early (a size limit, say) and close; what it
 * said is the result.
 */
async function streamToClamd({ host, onChunk, port, readable, responseTimeoutMs, socketPath, timeoutMs }) {
  let socket;
  try {
    socket = await connectClamd({ host, port, socketPath, timeoutMs });
  } catch (error) {
    readable.destroy?.();
    throw unavailable(error);
  }
  let response = '';
  let closed = false;
  let socketError = null;
  const answered = new Promise((resolve) => {
    socket.on('data', (chunk) => { response += chunk.toString('utf8'); });
    socket.once('error', (error) => { socketError = error; });
    socket.once('close', () => { closed = true; resolve(); });
  });
  const write = (buffer) => new Promise((resolve, reject) => {
    if (closed) {
      resolve(false);
      return;
    }
    socket.write(buffer, (error) => (error ? reject(error) : resolve(true)));
  });
  try {
    await write(Buffer.from('zINSTREAM\0', 'utf8'));
    for await (const chunk of readable) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      onChunk?.(bytes);
      // clamd takes chunks of at most its StreamMaxLength; 64 KiB keeps each write small.
      for (let offset = 0; offset < bytes.length && !closed; offset += 64 * 1024) {
        const slice = bytes.subarray(offset, offset + 64 * 1024);
        if (!await write(Buffer.concat([encodeChunkLength(slice.length), slice]))) break;
      }
      if (closed) break;
    }
    if (!closed) {
      await write(encodeChunkLength(0));
      socket.end();
    }
  } catch (error) {
    // A write ClamAV refused because it already answered; anything else from the read side.
    if (!closed && !socketError) {
      socket.destroy();
      readable.destroy?.();
      throw error;
    }
  } finally {
    readable.destroy?.();
  }
  const timer = setTimeout(() => socket.destroy(new Error('ClamAV response timed out.')), responseTimeoutMs);
  try {
    await answered;
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
  if (!response) {
    throw socketError ? unavailable(socketError) : unavailable(new Error('ClamAV closed the connection without an answer.'));
  }
  return parseClamdVerdict(response);
}

/** The noop scanner: every file is clean. Used when ClamAV is not configured (development and tests). */
export function createNoopFileScanner() {
  return {
    enabled: false,
    name: 'noop',
    async scanBytes() {
      return {
        clean: true,
        scanner: 'noop',
      };
    },
    // Reads the whole stream, so the caller's hash covers the file, and passes it.
    async scanStream(readable, { onChunk } = {}) {
      for await (const chunk of readable) onChunk?.(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return { clean: true, scanner: 'noop' };
    },
  };
}

export function createClamAvFileScanner({
  host = '127.0.0.1',
  port = 3310,
  socketPath = '',
  // How long to wait, once a whole stream is sent, for ClamAV's answer: a 1 GB file takes minutes.
  streamResponseTimeoutMs = 15 * 60_000,
  timeoutMs = 30_000,
} = {}) {
  return {
    enabled: true,
    name: socketPath ? 'clamav-socket' : 'clamav-tcp',
    async scanStream(readable, { onChunk } = {}) {
      return streamToClamd({ host, onChunk, port, readable, responseTimeoutMs: streamResponseTimeoutMs, socketPath, timeoutMs });
    },
    async scanBytes(bytes) {
      // Prefer INSTREAM so we don't need to persist the bytes on disk.
      const socket = await connectClamd({
        host,
        port,
        socketPath,
        timeoutMs,
      });

      try {
        socket.write(Buffer.from('zINSTREAM\0', 'utf8'));

        const chunkSize = 16 * 1024;
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          const chunk = bytes.subarray(offset, offset + chunkSize);
          socket.write(encodeChunkLength(chunk.length));
          socket.write(chunk);
        }

        socket.write(encodeChunkLength(0));
        socket.end();

      const response = await readClamdResponse(socket, timeoutMs);
      const normalized = String(response ?? '').trim();

        if (/OK\b/i.test(normalized)) {
          return { clean: true, response: normalized, scanner: 'clamav' };
        }

        if (/FOUND\b/i.test(normalized)) {
          return { clean: false, response: normalized, scanner: 'clamav' };
        }

        // Unexpected response; treat as failure so uploads remain gated.
        throw new Error(`Unexpected ClamAV response: ${normalized || '<empty>'}`);
      } finally {
        socket.destroy();
      }
    },
  };
}
