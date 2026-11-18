import { crc32 } from '../packages/package-zip.js';

// Frozen snapshots of prototype states (plan.md, "Prototypes"). The bridge captures the
// visible frame as a PNG; the reviewer's browser uploads it as a raw image/png body. Odin
// stores only bytes that are a complete, well-formed PNG, and serves them back only as
// image/png, so a snapshot can never become a page on the app origin.

export const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;
export const MAX_SNAPSHOT_SIDE = 16_384;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const VALID_COLOR_DEPTHS = Object.freeze({ 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] });
const CHUNK_OVERHEAD = 12; // length, type, and CRC around each chunk's data

/**
 * Walks every chunk: lengths stay inside the file, every CRC matches, IHDR comes first with
 * a supported size and format, there is image data (consecutive IDAT chunks, starting with a
 * zlib header), palette images carry a PLTE before it, and IEND ends the file. The image data
 * is not decompressed. Returns `{ ok: true, width, height }` or `{ ok: false, code, message }`.
 */
export function inspectPng(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  const fail = (message) => ({ code: 'snapshot_invalid', message, ok: false });
  if (buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return fail('The snapshot is not a PNG image.');

  let header = null;
  let sawPalette = false;
  let idatState = 'none'; // none, open (in the IDAT run), closed (after it)
  let offset = PNG_SIGNATURE.length;
  while (offset < buffer.length) {
    if (offset + CHUNK_OVERHEAD > buffer.length) return fail('The PNG is incomplete.');
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const end = offset + CHUNK_OVERHEAD + length;
    if (length > 0x7fffffff || end > buffer.length) return fail('The PNG is incomplete.');
    if (!/^[A-Za-z]{4}$/.test(type)) return fail('The PNG has a corrupt chunk.');
    if (crc32(buffer.subarray(offset + 4, offset + 8 + length)) !== buffer.readUInt32BE(offset + 8 + length)) {
      return fail(type === 'IHDR' ? 'The PNG header is corrupt.' : 'The PNG has a corrupt chunk.');
    }
    const data = buffer.subarray(offset + 8, offset + 8 + length);

    if (!header) {
      if (type !== 'IHDR' || length !== 13) return fail('The PNG has no valid header chunk.');
      const width = data.readUInt32BE(0);
      const height = data.readUInt32BE(4);
      if (width < 1 || height < 1 || width > MAX_SNAPSHOT_SIDE || height > MAX_SNAPSHOT_SIDE) {
        return fail(`Snapshots must be 1-${MAX_SNAPSHOT_SIDE} px on each side.`);
      }
      const [bitDepth, colorType, compression, filter, interlace] = data.subarray(8, 13);
      if (!VALID_COLOR_DEPTHS[colorType]?.includes(bitDepth) || compression !== 0 || filter !== 0 || interlace > 1) {
        return fail('The PNG header uses an unsupported format.');
      }
      header = { colorType, height, width };
    } else if (type === 'IHDR') {
      return fail('The PNG has more than one header chunk.');
    } else if (type === 'PLTE') {
      if (idatState !== 'none') return fail('The PNG palette comes after its image data.');
      sawPalette = true;
    } else if (type === 'IDAT') {
      if (idatState === 'closed') return fail('The PNG image data is split.');
      if (idatState === 'none') {
        if (header.colorType === 3 && !sawPalette) return fail('The PNG palette is missing.');
        // zlib stream header: deflate, and the check bits the format requires.
        if (length < 2 || (data[0] & 0x0f) !== 8 || ((data[0] << 8) | data[1]) % 31 !== 0) return fail('The PNG image data is corrupt.');
      }
      idatState = 'open';
    } else if (type === 'IEND') {
      if (length !== 0) return fail('The PNG has a corrupt chunk.');
      if (idatState === 'none') return fail('The PNG has no image data.');
      if (end !== buffer.length) return fail('The PNG has data after its end.');
      return { height: header.height, ok: true, width: header.width };
    } else if (idatState === 'open') {
      idatState = 'closed';
    }
    offset = end;
  }
  return fail(header ? 'The PNG is incomplete.' : 'The PNG has no valid header chunk.');
}

/** Object storage key, in the review-packages namespace, never reachable from the review origin. */
export function snapshotStorageKey(snapshotId) {
  return `review-snapshot-${snapshotId}`;
}
