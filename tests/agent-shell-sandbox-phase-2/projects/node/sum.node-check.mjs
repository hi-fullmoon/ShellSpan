import assert from 'node:assert/strict';
import test from 'node:test';
import { sum } from './sum.js';

test('sum handles an empty collection and signed values', () => {
  assert.equal(sum([]), 0);
  assert.equal(sum([3, -5, 8]), 6);
});
