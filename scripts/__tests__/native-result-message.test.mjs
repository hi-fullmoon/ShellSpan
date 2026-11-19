import {expect, it} from 'vitest';
import {isFinalNativeResult} from '../native-input/integration/result-message.mjs';

it('keeps evidence checkpoints pending until cleanup reports a final outcome', () => {
  const outcomes = [];
  const receive = value => { if (isFinalNativeResult(value)) outcomes.push(value); };
  receive({evidence: {kind: 'actual-native-parent-semantics-failure', failed: true}});
  receive({progress: 'Closing owned terminal', evidence: {closed: false}});
  expect(outcomes).toEqual([]);
  receive({ok: false, error: 'Original semantic failure after normal close'});
  expect(outcomes).toEqual([{ok: false, error: 'Original semantic failure after normal close'}]);
});

it('accepts an explicit final success after an evidence-only checkpoint', () => {
  expect(isFinalNativeResult({evidence: {closed: true}})).toBe(false);
  expect(isFinalNativeResult({ok: true})).toBe(true);
});

it.each([null, [], {}, {ok: 'true'}, {ok: false}, {ok: true, progress: 'Still closing'}])('rejects malformed or ambiguous outcome %j', value => {
  expect(() => isFinalNativeResult(value)).toThrow();
});
