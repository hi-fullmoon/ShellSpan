import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export function verifyNativeWindowReview(review, image) {
  assert(review && typeof review === 'object' && review.passed === true,
    'Actual native window visual review did not pass');
  assert.equal(review.imageSha256, createHash('sha256').update(image).digest('hex'),
    'Actual native window review does not match the captured image');
}
