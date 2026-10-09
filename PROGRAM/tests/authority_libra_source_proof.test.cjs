'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {observationFixture,hash}=require('./fixtures/authority_observation_fixture.cjs');
function observe(t,f){const file=path.join(__dirname,'../server/authority/observation.cjs');assert.equal(fs.existsSync(file),true,'strict source proof backend must exist');const o=require(file).createAuthorityObserver({dataDir:f.dataDir,control:f.control});t.after(()=>o.close());return {o,capture:()=>o.observeCanonicalFacts(f.request())};}
test('strict production double encoding preserves unicode, controls and full text',t=>{
 const f=observationFixture(t,{scopeKey:'s%_😀:漢字',text:'" \\ \b\t\n\r\u0000 😀 e\u0301 漢字\u2028\u2029'}),{o,capture}=observe(t,f),c=capture();assert.equal(o.readCaptured({handle:c.handle,requestId:'request1'}).items[0].text,f.memory.text);
});
test('outer object compatibility, duplicate inner fields and missing text refuse complete unit',async t=>{
 for(const [name,raw] of [['object',JSON.stringify({text:'wrong'})],['duplicate',JSON.stringify('{"schema":"libra.canonical_memory.v1","text":"small","te\\u0078t":"large"}')],['missing',JSON.stringify(JSON.stringify({schema:'libra.canonical_memory.v1'}))]])await t.test(name,sub=>{const f=observationFixture(sub,{mutateSeed:f=>f.seed(f.key,null,{raw})}),{capture}=observe(sub,f);assert.throws(capture,{code:name==='missing'?'SOURCE_PROOF_UNAVAILABLE':'SOURCE_PROFILE_UNAVAILABLE'});});
});
test('over-one-MiB rows refuse before source payload materialization',t=>{
 const f=observationFixture(t,{text:'a'.repeat(1048577)}),{capture}=observe(t,f);assert.throws(capture,{code:'RESOURCE_LIMIT'});
});
test('record identity mismatch and unsupported archive pointer refuse instead of partial bodies',async t=>{
 for(const mode of ['identity','archive'])await t.test(mode,sub=>{const f=observationFixture(sub,{mutateSeed:f=>{if(mode==='identity')f.seed(f.key,{...f.memory,memoryId:'wrong'});else{f.manifest.memories['1'].key='libra:v1:shared-archive:a:memory:mem1:r1';f.seed(f.manifestKey,f.manifest);}}}),{capture}=observe(sub,f);assert.throws(capture,{code:'SOURCE_PROOF_UNAVAILABLE'});});
});
test('unselected canonical inventory additions and purge-recreate are relevant',t=>{
 const f=observationFixture(t),{o,capture}=observe(t,f),c=capture(),args={handle:c.handle,requestId:'request1'};f.mutate(`libra:v1:scope:${f.scopeKey}:memory:6:r1`,{text:'extra'});assert.throws(()=>o.assertCurrent(args),{code:'SOURCE_CHANGED'});
 const second=capture(),args2={handle:second.handle,requestId:'request1'};f.mutate(f.key,null,{purge:true});f.mutate(f.key,f.memory);assert.throws(()=>o.assertCurrent(args2),{code:'SOURCE_CHANGED'});
});
test('exact BLOB-key projection separates a NUL shadow key from full narrative text',t=>{
 const f=observationFixture(t,{mutateSeed:f=>f.seed(f.key,{'text\u0000shadow':'wrong',...f.memory})}),{o,capture}=observe(t,f),c=capture();assert.equal(o.readCaptured({handle:c.handle,requestId:'request1'}).items[0].text,f.memory.text);
});

test('malformed stored UTF-8 and lone escaped surrogates refuse without replacement',async t=>{
 for(const mode of ['utf8','surrogate'])await t.test(mode,sub=>{
  const f=observationFixture(sub,{mutateSeed:f=>{if(mode==='utf8'){const encoded=JSON.stringify(JSON.stringify({...f.memory,text:'UNIQUE_TEXT'})),at=encoded.indexOf('UNIQUE_TEXT'),bytes=Buffer.concat([Buffer.from(encoded.slice(0,at)),Buffer.from([0xff]),Buffer.from(encoded.slice(at+11))]);f.databases.libra.prepare('UPDATE kv SET value_json=CAST(? AS TEXT),digest=? WHERE key=?').run(bytes,hash(bytes),f.key);}else f.seed(f.key,{...f.memory,text:'\ud800'});}}),{capture}=observe(sub,f);
  assert.throws(capture,{code:'UNSUPPORTED_SOURCE_TEXT'});
 });
});
