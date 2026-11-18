import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_AVATAR_DATA_URL_LENGTH,
  normalizeAvatarUpload,
  scaleAvatarDimensions,
} from '../src/lib/users/avatar-upload.js';

test('scaleAvatarDimensions preserves aspect ratio while capping the largest dimension', () => {
  assert.deepEqual(scaleAvatarDimensions(1600, 800, 512), {
    height: 256,
    width: 512,
  });
  assert.deepEqual(scaleAvatarDimensions(320, 240, 512), {
    height: 240,
    width: 320,
  });
});

test('normalizeAvatarUpload recompresses resized avatars until the data URL fits the backend envelope', async () => {
  const qualities = [];

  const result = await normalizeAvatarUpload(
    { type: 'image/png' },
    {
      createCanvas(width, height) {
        return {
          getContext() {
            return {
              drawImage() {},
              fillRect() {},
              set fillStyle(_value) {},
            };
          },
          toDataURL(type, quality) {
            qualities.push({ quality, type });
            return `data:image/jpeg;base64,${'a'.repeat(quality >= 0.8 ? 140 : 80)}`;
          },
        };
      },
      loadImage: async () => ({ height: 800, width: 1600 }),
      maxDataUrlLength: 120,
      readFileAsDataUrl: async () => `data:image/png;base64,${'a'.repeat(500)}`,
    },
  );

  assert.equal(result.dataUrl.length <= 120, true);
  assert.equal(result.height, 256);
  assert.equal(result.width, 512);
  assert.deepEqual(qualities, [
    { quality: 0.92, type: 'image/jpeg' },
    { quality: 0.86, type: 'image/jpeg' },
    { quality: 0.8, type: 'image/jpeg' },
    { quality: 0.74, type: 'image/jpeg' },
  ]);
});

test('normalizeAvatarUpload throws when no output candidate fits the allowed size', async () => {
  await assert.rejects(
    () => normalizeAvatarUpload(
      { type: 'image/png' },
      {
        createCanvas() {
          return {
            getContext() {
              return {
                drawImage() {},
                fillRect() {},
                set fillStyle(_value) {},
              };
            },
            toDataURL() {
              return `data:image/jpeg;base64,${'a'.repeat(MAX_AVATAR_DATA_URL_LENGTH + 50)}`;
            },
          };
        },
        loadImage: async () => ({ height: 800, width: 1600 }),
        maxDataUrlLength: 120,
        readFileAsDataUrl: async () => `data:image/png;base64,${'a'.repeat(500)}`,
      },
    ),
    /Avatar image is too large/i,
  );
});
