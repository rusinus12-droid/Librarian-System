'use strict';
// Exact canonical-read ownership assertions, with only a Min-compatible closure export.
// The original suite is preserved unchanged beside this focused compatibility entry.
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./libra_recall_test_runtime.cjs');
async function runtime() {
  const r = await load({ transformCode(code) {
    const i = code.lastIndexOf('})();'); assert.ok(i > 0, 'actual Full or Min closure');
    return code.slice(0, i) + '\n;globalThis.__READ_OWNERSHIP_COMPAT__=RisuCompat;\n' + code.slice(i);
  } });
  return { ...r, compat: r.context.__READ_OWNERSHIP_COMPAT__, storage: r.api.LibraDataStorage };
}
test('strict canonical reads return independent owned trees, retain raw bytes, and observe later updates', async () => {
  const r = await runtime(), scope = r.storage.scopeKeyFor(r.char, r.chat), key = r.storage.storageKeyFor(scope);
  const record = { scopeKey: scope, resetGeneration: 0, entries: [{ comment: 'lmai_memory', key: 'lmai_memory::owned',
    content: '[META:{"t":1,"ttl":-1,"imp":5}]\nUnicode 관측 \r\n evidence', custom: { array: ['first', { nested: true }] } }] };
  const raw = JSON.stringify(record);
  await r.compat.pluginStorage.setItem(key, raw);
  const first = await r.storage.readVerified(scope), second = await r.storage.readVerified(scope);
  assert.equal(first.ok, true); assert.equal(second.ok, true);
  assert.equal(first.raw, raw); assert.equal(second.raw, raw);
  first.entries[0].custom.array[1].nested = false;
  first.entries.push({ comment: 'lmai_memory', key: 'forged', content: 'FORGED' });
  assert.equal(JSON.stringify(second.entries), JSON.stringify(record.entries));
  assert.equal((await r.storage.readVerified(scope)).raw, raw);
  record.entries[0].content = '[META:{"t":1,"ttl":-1,"imp":5}]\nNew canonical body';
  record.resetGeneration = 3;
  await r.compat.pluginStorage.setItem(key, JSON.stringify(record));
  const latest = await r.storage.readVerified(scope);
  assert.equal(latest.resetGeneration, 3); assert.equal(JSON.stringify(latest.entries), JSON.stringify(record.entries));
  await r.compat.pluginStorage.setItem(key, JSON.stringify({ ...record, scopeKey: scope + '-foreign' }));
  assert.equal((await r.storage.readVerified(scope)).reason, 'canonical_invalid', 'warm runtime must not accept stale or foreign cached data');
});
test('a missing physical chunk after a successful read is rejected on the next strict read', async () => {
  const r = await runtime(), scope = r.storage.scopeKeyFor(r.char, r.chat), key = r.storage.storageKeyFor(scope);
  const raw = JSON.stringify({ scopeKey: scope, entries: [{ comment: 'lmai_memory', key: 'lmai_memory::large',
    content: '[META:{"t":1,"ttl":-1,"imp":5}]\n' + '관측 α𐐀\r\n'.repeat(100000) }] });
  await r.compat.pluginStorage.setItem(key, raw);
  const first = await r.storage.readVerified(scope); assert.equal(first.ok, true); assert.equal(first.raw, raw);
  const manifest = JSON.parse(r.store.get(key)); assert.ok(manifest.__libraChunkedStorageV1);
  r.store.delete(manifest.chunks[0]);
  const second = await r.storage.readVerified(scope);
  assert.equal(second.ok, false); assert.equal(second.reason, 'canonical_read_unavailable');
});
test('issued readonly reads reuse exact verified bytes and invalidate on same-ID updates, reset, corruption and missing chunks',async()=>{
 const r=await runtime(),scope=r.storage.scopeKeyFor(r.char,r.chat),key=r.storage.storageKeyFor(scope);
 const record={scopeKey:scope,resetGeneration:0,entries:[{comment:'lmai_memory',key:'lmai_memory::same',content:'[META:{"t":1,"ttl":-1}]\n'+'evidence '.repeat(100000),custom:{nested:['original']}}]};
 await r.compat.pluginStorage.setItem(key,JSON.stringify(record));
 const first=await r.storage.readVerified(scope,{readonly:true}),again=await r.storage.readVerified(scope,{readonly:true});
 assert.equal(first.entries===again.entries,true,'readonly parse proof must reuse byte-identical strict reads');assert(Object.isFrozen(first.entries[0].custom.nested));
 assert.throws(()=>first.entries[0].custom.nested.push('forged'),error=>error.name==='TypeError');
 const normal=await r.storage.readVerified(scope);normal.entries[0].custom.nested[0]='private mutation';assert.equal((await r.storage.readVerified(scope,{readonly:true})).entries[0].custom.nested[0],'original');
 record.entries[0].content+=' current update';record.resetGeneration=2;await r.compat.pluginStorage.setItem(key,JSON.stringify(record));
 const changed=await r.storage.readVerified(scope,{readonly:true});assert.notEqual(changed.entries,first.entries);assert.equal(changed.resetGeneration,2);
 const manifest=JSON.parse(r.store.get(key));assert(manifest.__libraChunkedStorageV1);r.store.set(manifest.chunks[0],'corrupt chunk');
 assert.equal((await r.storage.readVerified(scope,{readonly:true})).ok,false);
 await r.compat.pluginStorage.setItem(key,JSON.stringify(record));assert.equal((await r.storage.readVerified(scope,{readonly:true})).ok,true);
 const freshManifest=JSON.parse(r.store.get(key));r.store.delete(freshManifest.chunks[0]);assert.equal((await r.storage.readVerified(scope,{readonly:true})).ok,false);
});
