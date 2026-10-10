'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const acorn = require('acorn');
const { fixture, read, open } = require('./wm-native-cache-support.cjs');
// Observer only: return the original adapter promise unchanged. Register a sibling
// Promise reaction before readVerified registers its await continuation; there is
// no artificial gate, added await, or altered adapter/core/dispatch return value.
function observeAdapterPromise(code) {
  const nodes = [acorn.parse(code, { ecmaVersion: 'latest' })]; let match;
  while (nodes.length) {
    const node = nodes.pop(); if (!node || typeof node !== 'object') continue;
    if (node.type === 'CallExpression' && node.callee?.object?.name === 'WmNativeReadonlyDerivedCache' && node.callee?.property?.name === 'parseReadonly') { assert.equal(match, undefined); match = node; }
    for (const child of Object.values(node)) if (Array.isArray(child)) nodes.push(...child); else if (child && typeof child === 'object') nodes.push(child);
  }
  assert.ok(match);
  const original = code.slice(match.start, match.end);
  return code.slice(0, match.start) + '((p)=>{p.then(value=>globalThis.__INDEPENDENT_POST_ADAPTER__?.(value));return p;})(' + original + ')' + code.slice(match.end);
}
for (const mode of ['cached', 'budget-fallback', 'representation-fallback', 'fallback-reuse']) {
  for (const action of ['scope-retire', 'request-close', 'route-replace', 'guard-retire', 'unload']) {
    test(mode + ': no successful proof after ' + action + ' at adapter-to-dispatch await boundary', async () => {
      const config = mode.includes('fallback') && mode !== 'representation-fallback' ? { budgets: { maxBytes: 512 } } : undefined;
      const f = await fixture({ config, transform: observeAdapterPromise });
      if (mode === 'representation-fallback') {
        const raw = JSON.parse(f.raw); raw.entries[0].optional = 0;
        f.r.store.set(f.key, JSON.stringify(raw).replace('"optional":0', '"optional":1e400'));
      }
      let current = true;
      const owner = open(f, () => current);
      if (mode === 'fallback-reuse') assert.equal((await read(f, owner)).ok, true);
      let callbackRan = false, adapterValue;
      f.r.context.__INDEPENDENT_POST_ADAPTER__ = value => {
        callbackRan = true; adapterValue = value;
        if (action === 'scope-retire') f.d.invalidateRuntimeView(f.scope);
        if (action === 'request-close') f.cache.releaseRequest(owner);
        if (action === 'route-replace') f.r.host.pluginStorage = { ...f.r.storage };
        if (action === 'guard-retire') current = false;
        if (action === 'unload') f.cache.dispose();
      };
      const result = await read(f, owner);
      assert.equal(callbackRan, true); assert.equal(adapterValue.ok, true);
      console.log(JSON.stringify({ mode, action, adapterCached: adapterValue.cached, returnedOk: result.ok, pendingReads: f.cache.stats().pendingReads, core: f.cache.stats().core }));
      f.cache.releaseRequest(owner); await f.cache.drain();
      assert.equal(result.ok, false, 'readVerified must recheck after its adapter await before publishing a fresh proof');
    });
  }
}
test('positive control: observer with no retirement preserves accepted cache and fallback reads', async () => {
  for (const config of [undefined, { budgets: { maxBytes: 512 } }]) {
    const f = await fixture({ config, transform: observeAdapterPromise }), owner = open(f);
    let callbacks = 0; f.r.context.__INDEPENDENT_POST_ADAPTER__ = () => { callbacks++; };
    const first = await read(f, owner), second = await read(f, owner);
    assert.equal(first.ok, true); assert.equal(second.ok, true); assert.equal(callbacks, 2); assert.equal(first.entries, second.entries); assert.notEqual(first, second);
    f.cache.releaseRequest(owner); await f.cache.drain();
  }
});
test('scope retirement is followed by new readonly proof admission and fallback-slot resurrection', async () => {
  const f = await fixture({ config: { budgets: { maxBytes: 512 } }, transform: observeAdapterPromise }), owner = open(f);
  let beforeMarked, retired = false;
  f.r.context.__INDEPENDENT_POST_ADAPTER__ = value => {
    beforeMarked = f.d.isVerifiedReadonlyEntries(value.value.entries);
    f.d.invalidateRuntimeView(f.scope); retired = true;
    delete f.r.context.__INDEPENDENT_POST_ADAPTER__;
  };
  const stale = await read(f, owner); assert.equal(retired, true); assert.equal(beforeMarked, false);
  const afterMarked = f.d.isVerifiedReadonlyEntries(stale.entries), parses = f.counts.total;
  const again = await read(f, owner);
  const evidence = { returnedOk: stale.ok, beforeRetirementReadonlyMark: beforeMarked, afterRetirementReadonlyMark: afterMarked, parsesBeforeNextRead: parses, parsesAfterNextRead: f.counts.total, nextReadUsesSameEntries: again.entries === stale.entries, fallbackReuses: f.cache.stats().fallbackReuses };
  console.log('RESURRECTION ' + JSON.stringify(evidence));
  f.cache.releaseRequest(owner); await f.cache.drain();
  assert.equal(afterMarked, false, 'readVerified marked a new readonly proof only after retirement');
});
