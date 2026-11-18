import JSZip from 'jszip';

import { PACKAGE_LIMITS } from './package-files.js';

// Reads a package zip into entries without trusting anything the zip says about itself.
// Declared sizes are checked before any entry is inflated, and every entry is inflated
// through a byte cap, so a zip that lies about its sizes cannot exhaust memory.

class EntryLimitError extends Error {}

function problem(code, message, file = '') {
  return { code, file, message, path: '' };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

// zlib.crc32 needs Node 22; production may run Node 20.
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/**
 * Number of entries in the central directory, from the end-of-central-directory record.
 * JSZip keys entries by name, so a zip that repeats a name shows fewer entries than this.
 */
function centralDirectoryCount(bytes) {
  const minimum = 22;
  if (bytes.length < minimum) return null;
  const stop = Math.max(0, bytes.length - (minimum + 0xffff));
  for (let offset = bytes.length - minimum; offset >= stop; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      return bytes.readUInt16LE(offset + 10);
    }
  }
  return null;
}

function readCapped(file, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const helper = file.internalStream('nodebuffer');
    helper
      .on('data', (chunk) => {
        if (settled) return;
        total += chunk.length;
        if (total > maxBytes) {
          settled = true;
          helper.pause();
          reject(new EntryLimitError('limit'));
          return;
        }
        chunks.push(chunk);
      })
      .on('error', (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      })
      .on('end', () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks, total));
      })
      .resume();
  });
}

/**
 * Returns `{ entries, errors, fatal }`. Entries are `{ path, isDirectory, isSymlink, bytes }`
 * with `bytes` null for directories. `fatal` means later stages cannot run.
 */
export async function readPackageZip(bytes, { limits = PACKAGE_LIMITS } = {}) {
  const errors = [];
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);

  if (buffer.length === 0) {
    return { entries: [], errors: [problem('zip_invalid', 'The upload is empty.')], fatal: true };
  }
  if (buffer.length > limits.zipBytes) {
    return {
      entries: [],
      errors: [problem('zip_limit', `The zip is ${buffer.length} bytes; the limit is ${limits.zipBytes}.`)],
      fatal: true,
    };
  }

  const declaredCount = centralDirectoryCount(buffer);
  if (declaredCount === null) {
    return { entries: [], errors: [problem('zip_invalid', 'This is not a readable zip file.')], fatal: true };
  }
  if (declaredCount > limits.entries) {
    return {
      entries: [],
      errors: [problem('zip_limit', `The zip has ${declaredCount} entries; the limit is ${limits.entries}.`)],
      fatal: true,
    };
  }

  let zip;
  try {
    // JSZip's own CRC check inflates every entry during load, before any cap applies, so
    // CRCs are checked here after each capped read instead.
    zip = await JSZip.loadAsync(buffer, { checkCRC32: false, createFolders: false });
  } catch (error) {
    return {
      entries: [],
      errors: [problem('zip_invalid', `This is not a readable zip file (${String(error?.message ?? error).slice(0, 160)}).`)],
      fatal: true,
    };
  }

  const files = Object.values(zip.files);
  if (files.length > limits.entries) {
    return {
      entries: [],
      errors: [problem('zip_limit', `The zip has ${files.length} entries; the limit is ${limits.entries}.`)],
      fatal: true,
    };
  }
  if (files.length !== declaredCount) {
    errors.push(problem('path_invalid', 'The zip lists the same path more than once.'));
  }

  // Declared sizes first, before inflating anything.
  let declaredTotal = 0;
  for (const file of files) {
    if (file.dir) continue;
    const name = file.unsafeOriginalName ?? file.name;
    const compressedSize = Number(file._data?.compressedSize ?? 0);
    const uncompressedSize = Number(file._data?.uncompressedSize ?? 0);
    declaredTotal += uncompressedSize;
    if (uncompressedSize > limits.compressionRatio * Math.max(compressedSize, 1)) {
      errors.push(problem(
        'zip_limit',
        `${name} expands from ${compressedSize} to ${uncompressedSize} bytes, over the ${limits.compressionRatio}:1 compression ratio limit.`,
        name,
      ));
    }
  }
  if (declaredTotal > limits.totalUncompressedBytes) {
    errors.push(problem('zip_limit', `The files total ${declaredTotal} bytes uncompressed; the limit is ${limits.totalUncompressedBytes}.`));
  }
  if (errors.some((error) => error.code === 'zip_limit')) {
    return { entries: [], errors, fatal: true };
  }

  const entries = [];
  let actualTotal = 0;
  for (const file of files) {
    const path = file.unsafeOriginalName ?? file.name;
    const mode = Number(file.unixPermissions ?? 0);
    const isSymlink = (mode & S_IFMT) === S_IFLNK;
    if (file.dir) {
      entries.push({ bytes: null, isDirectory: true, isSymlink, path });
      continue;
    }
    if (isSymlink) {
      entries.push({ bytes: null, isDirectory: false, isSymlink: true, path });
      continue;
    }
    const compressedSize = Number(file._data?.compressedSize ?? 0);
    const declaredSize = Number(file._data?.uncompressedSize ?? 0);
    const cap = Math.min(
      declaredSize,
      limits.totalUncompressedBytes - actualTotal,
      limits.compressionRatio * Math.max(compressedSize, 1),
    );
    let content;
    try {
      content = await readCapped(file, Math.max(0, cap));
    } catch (error) {
      if (error instanceof EntryLimitError) {
        return {
          entries: [],
          errors: [...errors, problem('zip_limit', `${path} expands beyond its declared size or the package limits.`, path)],
          fatal: true,
        };
      }
      return {
        entries: [],
        errors: [...errors, problem('zip_invalid', `${path} could not be read (${String(error?.message ?? error).slice(0, 160)}).`, path)],
        fatal: true,
      };
    }
    const expectedCrc = file._data?.crc32;
    if (typeof expectedCrc === 'number' && (expectedCrc >>> 0) !== crc32(content)) {
      return {
        entries: [],
        errors: [...errors, problem('zip_invalid', `${path} is corrupt (checksum mismatch).`, path)],
        fatal: true,
      };
    }
    actualTotal += content.length;
    entries.push({ bytes: content, isDirectory: false, isSymlink: false, path });
  }

  return { entries, errors, fatal: false };
}
