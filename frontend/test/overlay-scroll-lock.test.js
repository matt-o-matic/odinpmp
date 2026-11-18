import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acquireOverlayScrollLock,
  resetOverlayScrollLockForTests,
} from '../src/lib/ui/overlay-scroll-lock.js';

function createDocument({ bodyOverflow = '', bodyPaddingRight = '', bodyOverscrollBehavior = '' } = {}) {
  return {
    body: {
      style: {
        overflow: bodyOverflow,
        overscrollBehavior: bodyOverscrollBehavior,
        paddingRight: bodyPaddingRight,
      },
    },
    documentElement: {
      clientWidth: 980,
      style: {
        overflow: 'auto',
        overscrollBehavior: 'auto',
      },
    },
  };
}

test('acquireOverlayScrollLock locks document scrolling and restores prior inline styles', () => {
  const documentRef = createDocument({
    bodyOverflow: 'clip',
    bodyPaddingRight: '4px',
    bodyOverscrollBehavior: 'contain',
  });
  const release = acquireOverlayScrollLock({
    document: documentRef,
    window: { innerWidth: 1000 },
  });

  assert.equal(documentRef.documentElement.style.overflow, 'hidden');
  assert.equal(documentRef.documentElement.style.overscrollBehavior, 'none');
  assert.equal(documentRef.body.style.overflow, 'hidden');
  assert.equal(documentRef.body.style.overscrollBehavior, 'none');
  assert.equal(documentRef.body.style.paddingRight, '20px');

  release();

  assert.equal(documentRef.documentElement.style.overflow, 'auto');
  assert.equal(documentRef.documentElement.style.overscrollBehavior, 'auto');
  assert.equal(documentRef.body.style.overflow, 'clip');
  assert.equal(documentRef.body.style.overscrollBehavior, 'contain');
  assert.equal(documentRef.body.style.paddingRight, '4px');
});

test('acquireOverlayScrollLock keeps scroll locked until the final nested release', () => {
  const documentRef = createDocument();
  const firstRelease = acquireOverlayScrollLock({
    document: documentRef,
    window: { innerWidth: 1000 },
  });
  const secondRelease = acquireOverlayScrollLock({
    document: documentRef,
    window: { innerWidth: 1000 },
  });

  firstRelease();
  assert.equal(documentRef.body.style.overflow, 'hidden');
  assert.equal(documentRef.documentElement.style.overflow, 'hidden');

  secondRelease();
  assert.equal(documentRef.body.style.overflow, '');
  assert.equal(documentRef.documentElement.style.overflow, 'auto');
});

test.afterEach(() => {
  resetOverlayScrollLockForTests();
});
