// Reads pixel dimensions from image headers without decoding the image. Returns
// `{ width, height }` or null when the format or header is not recognized.

function pngSize(bytes) {
  if (bytes.length < 24) return null;
  if (bytes.readUInt32BE(0) !== 0x89504e47 || bytes.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { height: bytes.readUInt32BE(20), width: bytes.readUInt32BE(16) };
}

function gifSize(bytes) {
  if (bytes.length < 10) return null;
  const signature = bytes.toString('latin1', 0, 6);
  if (signature !== 'GIF87a' && signature !== 'GIF89a') return null;
  return { height: bytes.readUInt16LE(8), width: bytes.readUInt16LE(6) };
}

function jpegSize(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    let marker = bytes[offset + 1];
    while (marker === 0xff && offset + 2 < bytes.length) {
      offset += 1;
      marker = bytes[offset + 1];
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (offset + 4 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset + 2);
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      if (offset + 9 > bytes.length) return null;
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

function webpSize(bytes) {
  if (bytes.length < 30) return null;
  if (bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WEBP') return null;
  const chunk = bytes.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') {
    return { height: bytes.readUInt16LE(28) & 0x3fff, width: bytes.readUInt16LE(26) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    const bits = bytes.readUInt32LE(21);
    return { height: ((bits >> 14) & 0x3fff) + 1, width: (bits & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    return { height: bytes.readUIntLE(27, 3) + 1, width: bytes.readUIntLE(24, 3) + 1 };
  }
  return null;
}

function svgLength(value) {
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)\s*(px)?\s*$/i.exec(String(value ?? ''));
  return match ? Math.round(Number(match[1])) : null;
}

function svgSize(bytes) {
  const text = bytes.toString('utf8', 0, Math.min(bytes.length, 64 * 1024));
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0];
  if (!tag) return null;
  const attribute = (name) => new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(tag)?.[2];
  const width = svgLength(attribute('width'));
  const height = svgLength(attribute('height'));
  if (width && height) return { height, width };
  const viewBox = attribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (!width && !height && viewBox?.length === 4 && viewBox.every(Number.isFinite)) {
    return { height: Math.round(viewBox[3]), width: Math.round(viewBox[2]) };
  }
  return null;
}

export function readImageSize(bytes, extension) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  switch (extension) {
    case 'png': return pngSize(buffer);
    case 'gif': return gifSize(buffer);
    case 'jpg':
    case 'jpeg': return jpegSize(buffer);
    case 'webp': return webpSize(buffer);
    case 'svg': return svgSize(buffer);
    default: return null;
  }
}
