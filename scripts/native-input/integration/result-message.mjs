import assert from 'node:assert/strict';

// Evidence can arrive before the fixture's finally block closes its sessions.
// Only an explicit final outcome may release the native runner.
export function isFinalNativeResult(value) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Invalid native result message');
  if (Object.hasOwn(value, 'ok')) {
    assert(typeof value.ok === 'boolean', 'Invalid native result outcome');
    assert(!value.progress, 'Final native result cannot also report progress');
    if (!value.ok) assert(typeof value.error === 'string' && value.error.length > 0, 'Missing native failure reason');
    return true;
  }
  assert(value.progress || (value.evidence && typeof value.evidence === 'object'), 'Missing native result outcome or evidence');
  return false;
}
