'use strict';
const assert = require('node:assert/strict');
const { projectNativePublicReceipt } = require('./native_public_receipt_projection.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
const key = 'libra:v1:scope:target:1:memory:1:r1';
const options = { targetScopeKey: 'target:1', allowedMemoryKeys: [key] };
const durable = { schema: 'receipt.fixture.v1', complete: true, targetScopeKey: 'target:1',
  stateTransferRebuild: { ok: true, count: 1, refs: [{ key, memoryId: 'm1', revision: 1,
    sourceDigest: 'source', artifactDigest: 'artifact' }] } };
const before = JSON.stringify(durable);
const projected = projectNativePublicReceipt(durable, options);
assert.equal(JSON.stringify(durable), before, 'projection cannot mutate durable evidence');
assert.equal(projected.redactions.length, 1);
assert.deepEqual(projected.redactions[0], { path: ['stateTransferRebuild', 'refs', 0, 'key'], value: key });
const expected = clone(durable); delete expected.stateTransferRebuild.refs[0].key;
assert.deepEqual(projected.value, expected);
const malformed = [
  ['wrong scope', key.replace('target:1', 'other')],
  ['not a memory address', 'libra:v1:scope:target:1:continuity-state'],
  ['unlisted target memory', key.replace('memory:1:', 'memory:6:')],
  ['empty key', ''], ['non-string key', 12]
];
for (const [name, value] of malformed) {
  const changed = clone(durable); changed.stateTransferRebuild.refs[0].key = value;
  assert.throws(() => projectNativePublicReceipt(changed, options), assert.AssertionError, name);
}
assert.throws(() => projectNativePublicReceipt(durable, { ...options, allowedMemoryKeys: ['foreign'] }), assert.AssertionError);
const falsePublic = [
  value => { value.complete = false; },
  value => { delete value.targetScopeKey; },
  value => { value.stateTransferRebuild.refs[0].artifactDigest = 'wrong'; },
  value => { delete value.stateTransferRebuild.refs[0].sourceDigest; },
  value => { value.stateTransferRebuild.extra = true; },
  value => { value.stateTransferRebuild.refs.push(clone(value.stateTransferRebuild.refs[0])); },
  value => { value.stateTransferRebuild.refs[0].key = key; }
];
for (const mutate of falsePublic) {
  const changed = clone(expected); mutate(changed);
  assert.throws(() => assert.deepEqual(changed, projected.value), assert.AssertionError);
}
const otherNames = { memoryKey: key, token: 'synthetic-field', nested: { Key: 'case-sensitive' } };
assert.deepEqual(projectNativePublicReceipt(otherNames, options).value, otherNames,
  'this scoped fixture exception cannot silently strip other names via a broad secret regex');
console.log(JSON.stringify({ kind: 'native-public-receipt-projection-controls', status: 'PASS',
  rejectedInvalidRedactions: malformed.length + 1, rejectedPublicMutations: falsePublic.length,
  durableUnchanged: true, otherNamesPreserved: true, productExecuted: false }));
