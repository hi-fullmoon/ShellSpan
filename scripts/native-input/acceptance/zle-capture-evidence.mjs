import assert from 'node:assert/strict';

const guardKinds = ['function', 'alias', 'global-alias', 'widget', 'chord', 'scope-previous', 'scope-applied', 'metadata-lines', 'metadata-rows', 'metadata-cols', 'early-core'];
const eofPhases = ['idle', 'typing', 'malformed-control', 'partial-eof', 'armed', 'returned', 'duplicate-control', 'accepted-before-parent', 'race-key-before-eof', 'race-key-after-eof', 'user-changed', 'user-map', 'user-draft', 'changed-draft'];

export function evaluateZleCapture(mode, observations) {
  assert(['guards', 'eof', 'geometry'].includes(mode), 'Unknown actual ZLE capture mode');
  assert(Array.isArray(observations), 'Actual ZLE observations must be an array');
  const expected = mode === 'guards' ? guardKinds : mode === 'eof' ? eofPhases : undefined;
  const identities = expected ? observations.map(value => mode === 'guards' ? value.kind : value.phase) : [];
  const missing = expected?.filter(value => !identities.includes(value)) ?? [];
  const unexpected = identities.filter(value => !expected.includes(value));
  const duplicates = identities.filter((value, index) => identities.indexOf(value) !== index);
  const expectedCases = expected?.length ?? 1;
  return {
    ok: observations.length === expectedCases && observations.every(value => value.ok === true)
      && missing.length === 0 && unexpected.length === 0 && duplicates.length === 0,
    expectedCases, missing, unexpected, duplicates, observations,
  };
}
