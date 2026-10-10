'use strict';
const assert = require('node:assert/strict'), vm = require('node:vm');
const values = require('./PROGRAM/tests/fixtures/timeline_caps_reason_values.cjs');
const source = '["canonical_ref_cap","semantic_event_cap"]';
const first = vm.runInNewContext(source), second = vm.runInNewContext(source);
const firstBefore = Array.from(first), secondBefore = Array.from(second);
const firstPrototype = Object.getPrototypeOf(first), secondPrototype = Object.getPrototypeOf(second);
assert.notEqual(Object.getPrototypeOf(first), Object.getPrototypeOf(second));
assert.throws(() => assert.deepEqual(first, second), assert.AssertionError,
  'original cross-realm comparator rejects equal reason values');
const compare = (a,b) => assert.deepEqual(values(a), values(b));
compare(first, second);
assert.deepEqual(values(first), ['canonical_ref_cap','semantic_event_cap']);
assert.deepEqual(Array.from(first), Array.from(second));
const misleadingOwn = ['different_reason','semantic_event_cap'];
Object.defineProperty(misleadingOwn, Symbol.iterator, {value:function*(){yield 'canonical_ref_cap';yield 'semantic_event_cap';}});
assert.throws(() => compare(first, misleadingOwn), assert.AssertionError,
  'non-enumerable own iterator cannot replace indexed reason values');
const misleadingInherited = vm.runInNewContext(`Array.prototype[Symbol.iterator]=function*(){yield 'canonical_ref_cap';yield 'semantic_event_cap';}; ['different_reason','semantic_event_cap']`);
assert.throws(() => compare(first, misleadingInherited), assert.AssertionError,
  'foreign inherited iterator cannot replace indexed reason values');
const originalKeys = Reflect.ownKeys(first); values(first);
assert.deepEqual(Reflect.ownKeys(first), originalKeys);
for (const bad of [
  ['different_reason','semantic_event_cap'], ['canonical_ref_cap'],
  ['canonical_ref_cap','semantic_event_cap','extra'],
  ['semantic_event_cap','canonical_ref_cap'],
  ['canonical_ref_cap','canonical_ref_cap']
]) assert.throws(() => compare(first, vm.runInNewContext(JSON.stringify(bad))), assert.AssertionError);
const hole = []; hole.length=2; hole[1]='semantic_event_cap';
const extra = ['canonical_ref_cap','semantic_event_cap']; extra.extra=true;
const symbol = ['canonical_ref_cap','semantic_event_cap']; symbol[Symbol('extra')]=true;
for (const bad of [null, {}, new Set(['canonical_ref_cap','semantic_event_cap']),
  {0:'canonical_ref_cap',1:'semantic_event_cap',length:2}, hole, extra, symbol,
  ['canonical_ref_cap',undefined], ['canonical_ref_cap',42]])
  assert.throws(() => values(bad), assert.AssertionError);
assert.deepEqual(Array.from(first), firstBefore);
assert.deepEqual(Array.from(second), secondBefore);
assert.equal(Object.getPrototypeOf(first), firstPrototype);
assert.equal(Object.getPrototypeOf(second), secondPrototype);
console.log(JSON.stringify({test:'timeline_cross_realm_reason_values',originalComparatorRed:true,
  equalValuesAccepted:true,orderLengthElementAndShapeNegatives:16,originalArraysUnchanged:true,
  fullTimelineRerun:'PENDING'}));
