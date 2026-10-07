const assert = require('node:assert/strict');
const isNumber = require('is-number');

assert.equal(isNumber('42'), true);
assert.equal(isNumber('ordinary-text'), false);
process.stdout.write('real dependency execution completed\n');
