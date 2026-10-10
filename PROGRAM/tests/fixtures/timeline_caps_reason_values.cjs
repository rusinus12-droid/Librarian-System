'use strict';
const assert = require('node:assert/strict');
// Timeline values cross isolated VM realms. Preserve dense string-array values
// and their exact order while comparing them in the test's own Array realm.
module.exports = function timelineCapsReasonValues(value) {
  assert.ok(Array.isArray(value), 'timeline reasons must be an array');
  assert.deepEqual(Object.keys(value), Array.from({length: value.length}, (_, i) => String(i)),
    'timeline reasons must be a dense array without extra enumerable fields');
  assert.equal(Object.getOwnPropertySymbols(value).filter(key =>
    Object.prototype.propertyIsEnumerable.call(value, key)).length, 0,
    'timeline reasons must not carry extra enumerable symbol fields');
  const reasons = Array.from({length: value.length}, (_, index) => value[index]);
  assert.ok(reasons.every(reason => typeof reason === 'string'), 'timeline reason elements must be strings');
  return reasons;
};
