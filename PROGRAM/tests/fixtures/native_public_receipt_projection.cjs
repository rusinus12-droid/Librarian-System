'use strict';
// The public debug API redacts an exact `key` property recursively. This test
// projection admits only canonical memory addresses proved by the target's
// durable manifest. It never removes other fields or changes durable records.
const assert = require('node:assert/strict');
function projectNativePublicReceipt(receipt, { targetScopeKey, allowedMemoryKeys }) {
  assert.ok(typeof targetScopeKey === 'string' && targetScopeKey.length > 0);
  assert.ok(Array.isArray(allowedMemoryKeys));
  const allowed = new Set(allowedMemoryKeys);
  const prefix = `libra:v1:scope:${targetScopeKey}:memory:`;
  for (const key of allowed) {
    assert.ok(typeof key === 'string' && key.startsWith(prefix)
      && /^[1-9]\d*:r[1-9]\d*$/.test(key.slice(prefix.length)),
    'allowed redaction address is a canonical memory in the exact target scope');
  }
  const redactions = [];
  const visit = (value, path = []) => {
    if (Array.isArray(value)) return value.map((item, index) => visit(item, [...path, index]));
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === 'key') {
        assert.ok(typeof child === 'string' && allowed.has(child),
          'only a verified target-manifest memory address may be redacted');
        redactions.push({ path: [...path, key], value: child });
      } else out[key] = visit(child, [...path, key]);
    }
    return out;
  };
  return { value: visit(receipt), redactions };
}
module.exports = { projectNativePublicReceipt };
