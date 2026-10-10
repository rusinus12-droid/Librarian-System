'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.join(__dirname, '../src/parts');
const artifactPath = process.argv.includes('--artifact') ? path.join(__dirname, '../dist/LIBRA World Manager Full.js') : process.env.LIBRA_MANAGEMENT_TEST_DIST;
const core = fs.readFileSync(path.join(root, '01-core-runtime-compat-state-debug.js'), 'utf8');
const storageFile = fs.readFileSync(path.join(root, '01f-lore-consolidation.js'), 'utf8');
const storage = storageFile.slice(storageFile.indexOf("    const LIBRA_DATA_STORAGE_PREFIX ="), storageFile.indexOf('\n    try {\n        if (typeof globalThis', storageFile.indexOf('    const LibraDataStorage =')));
const clone = value => JSON.parse(JSON.stringify(value));
const scope = 'char:fixture-char|chat:fixture-chat|persona:persona-a';
const entry = { key: 'fixture-memory', comment: 'lmai_memory', content: 'synthetic fixture' };
async function load(options = {}) {
  const store = options.store || new Map(), writes = [], reads = [];
  const control = { mode: options.mode || 'ok', failReads: false, persona: 'persona-a', selectedPersona: 0 };
  const runtime = {
    async getArgument() { return undefined; }, async getCharacter() { return null; },
    async registerSetting() {}, async registerButton() {}, async addRisuReplacer() {}, async onUnload() {},
    async requestPluginPermission() { return true; },
    async getDatabase() { if(control.failPersona) throw new Error('persona_unavailable'); return { selectedPersona:control.selectedPersona,personas:control.noPersonas ? [] : [{id:control.persona}] }; },
    async getCurrentCharacterIndex() { return 0; }, async getCurrentChatIndex() { return 0; },
    pluginStorage: {
      async getItem(key) { reads.push(key); if(control.failReads) throw new Error('private_read_error'); return store.get(key) ?? null; },
      async setItem(key,value) {
        writes.push({key,value});
        if(control.mode !== 'reject' && control.mode !== 'ack_without_write') store.set(key,control.mode === 'mismatch' ? 'different' : value);
        if(control.mode === 'throw_after_write') throw new Error('write_reply_lost');
        if(control.mode === 'readback_error') control.failReads = true;
        return control.mode === 'false_after_write' || control.mode === 'reject' ? false : (control.mode === 'undefined_after_write' ? undefined : true);
      }
    }
  };
  if(options.noStorage) delete runtime.pluginStorage;
  const context = vm.createContext({risuai:runtime, Risuai:runtime, safeClone:clone, recordRuntimeDebug(){},
    stableHash:value=>crypto.createHash('sha256').update(String(value)).digest('hex'),
    LibraLoreConsolidator:{unpackRawFromLore:value=>value},
    URL, setTimeout, clearTimeout, setInterval, clearInterval, AbortController, TextEncoder, TextDecoder, performance,
    crypto: { randomUUID: crypto.randomUUID }, console: {log(){},warn(){},error(){},debug(){}},
    fetch: async()=>{ throw new Error('no external network'); } });
  const selectedArtifact = options.artifact ? path.join(__dirname, '../dist/LIBRA World Manager Full.js') : artifactPath;
  if (selectedArtifact) {
    let code = fs.readFileSync(selectedArtifact, 'utf8');
    code = code.replace('        const scopeKeyForAsync =', '        globalThis.__seedPersonaCache = id => { _personaCache = { at: Date.now(), id, db: null }; };\n        const scopeKeyForAsync =');
    const close = code.lastIndexOf('\n})();'); assert(close >= 0);
    code = code.slice(0, close) + '\nglobalThis.api={RisuCompat,LibraDataStorage' + (options.extraExports ? ',' + options.extraExports : '') + '};\n' + code.slice(close);
    if (options.transformCode) code = options.transformCode(code);
    await vm.runInContext(code, context, { timeout: 20000 });
  } else {
    vm.runInContext(core + '\n' + storage.replace('        const scopeKeyForAsync =', '        globalThis.__seedPersonaCache = id => { _personaCache = { at: Date.now(), id, db: null }; };\n        const scopeKeyForAsync =') + '\nglobalThis.api={RisuCompat,LibraDataStorage};',context);
  }
  // Measure the requested operation separately from bundle initialization reads.
  reads.length = 0; writes.length = 0;
  return { api:context.api,store,writes,reads,control,runtime,seedPersona:context.__seedPersonaCache,testGlobals:context };
}
module.exports = { load, scope, entry };
const checks=[];
async function test(name,fn){try{await fn();checks.push({name,ok:true});}catch(error){checks.push({name,ok:false,error:error.message});process.exitCode=1;}}
if (require.main === module) (async()=>{
  await test('strict compat read distinguishes absent from exception; default remains compatible',async()=>{
    const f=await load();assert.equal(await f.api.RisuCompat.pluginStorage.getItem('missing',{strict:true}),null);
    f.control.failReads=true;await assert.rejects(f.api.RisuCompat.pluginStorage.getItem('key',{strict:true}),/storage_read/);
    assert.equal(await f.api.RisuCompat.pluginStorage.getItem('key'),null);
  });
  await test('strict compat read rejects unavailable storage API',async()=>{
    const f=await load({noStorage:true});await assert.rejects(f.api.RisuCompat.pluginStorage.getItem('key',{strict:true}),/storage_read/);
  });
  await test('strict compat read rejects incomplete chunk manifest',async()=>{
    const f=await load();f.store.set('key',JSON.stringify({__libraChunkedStorageV1:true,chunks:['absent'],length:8}));
    await assert.rejects(f.api.RisuCompat.pluginStorage.getItem('key',{strict:true}),/storage_read/);
    assert.equal(await f.api.RisuCompat.pluginStorage.getItem('key'),null);
  });
  await test('verified reader distinguishes canonical missing and malformed/mismatched payload',async()=>{
    const f=await load(), st=f.api.LibraDataStorage;assert.equal(typeof st.readVerified,'function');
    const absent=await st.readVerified(scope);assert.equal(absent.ok,true);assert.equal(absent.missing,true);assert.equal(absent.raw,null);
    for(const value of ['bad','[]','{}',JSON.stringify({scopeKey:'other',entries:[]})]){
      f.store.set(st.storageKeyFor(scope),value);const result=await st.readVerified(scope);assert.equal(result.ok,false);assert.equal(result.missing,false);
    }
    f.store.set(st.storageKeyFor(scope),JSON.stringify({version:'1.0',scopeKey:scope,entries:[entry]}));
    const current=await st.readVerified(scope);assert.equal(current.ok,true);assert.deepEqual(clone(current.entries),[entry]);
  });
  for(const mode of ['ok','undefined_after_write','false_after_write','throw_after_write'])await test(`exact readback confirms ${mode}`,async()=>{
    const f=await load({mode}),st=f.api.LibraDataStorage;assert.equal(typeof st.saveVerified,'function');
    const input=clone([entry]),result=await st.saveVerified(scope,input,{expectedRaw:null,isCurrent:async()=>true});
    assert.equal(result.ok,true);assert.equal(result.verified,true);assert.equal(f.writes.length,1);
    assert.deepEqual(clone(st.getShadowEntries(scope)),[entry]);assert.deepEqual(input,[entry]);
  });
  for(const mode of ['reject','ack_without_write','mismatch','readback_error'])await test(`unverified ${mode} does not publish shadow or perform compensating write`,async()=>{
    const f=await load({mode}),st=f.api.LibraDataStorage;assert.equal(typeof st.saveVerified,'function');
    const result=await st.saveVerified(scope,[entry],{expectedRaw:null,isCurrent:async()=>true});
    assert.equal(result.ok,false);assert.equal(result.uncertain,true);assert.equal(f.writes.length,1);assert.equal(st.isHydrated(scope),false);assert.equal(st.getShadowEntries(scope).length,0);
  });
  for(const phase of ['before_read','after_read','before_write','after_write','after_readback'])await test(`identity invalidation at ${phase} prevents publication`,async()=>{
    const f=await load(),st=f.api.LibraDataStorage;assert.equal(typeof st.saveVerified,'function');
    const result=await st.saveVerified(scope,[entry],{expectedRaw:null,isCurrent:async at=>at!==phase});
    assert.equal(result.ok,false);assert.equal(result.reason,'stale_identity');assert.equal(st.getShadowEntries(scope).length,0);assert.equal(st.isHydrated(scope),false);
    assert.equal(f.writes.length,['after_write','after_readback'].includes(phase)?1:0);
    assert(f.writes.every(write=>write.key===st.storageKeyFor(scope)));
  });
  await test('unreadable current canonical data prevents all writes',async()=>{
    const f=await load(),st=f.api.LibraDataStorage;assert.equal(typeof st.saveVerified,'function');f.control.failReads=true;
    const result=await st.saveVerified(scope,[entry],{isCurrent:async()=>true});assert.equal(result.ok,false);assert.equal(f.writes.length,0);
  });
  await test('preimage mismatch does not overwrite a concurrent canonical revision',async()=>{
    const f=await load(),st=f.api.LibraDataStorage;assert.equal(typeof st.saveVerified,'function');
    f.store.set(st.storageKeyFor(scope),JSON.stringify({scopeKey:scope,entries:[]}));
    const result=await st.saveVerified(scope,[entry],{expectedRaw:null,isCurrent:async()=>true});assert.equal(result.ok,false);assert.equal(result.reason,'canonical_changed');assert.equal(f.writes.length,0);
  });
  await test('fresh persona proof bypasses existing two-second cache and rejects unavailable identity',async()=>{
    const f=await load(),st=f.api.LibraDataStorage;assert.equal(await st.resolvePersonaId({},{}),'');f.control.persona='persona-b';
    assert.equal(await st.resolvePersonaId({},{},{fresh:true,strict:true}),'persona-b');
    assert.equal(await st.resolvePersonaId({},{}),'', 'fresh management proof must not migrate general runtime keys');
    f.control.failPersona=true;await assert.rejects(st.resolvePersonaId({},{},{fresh:true,strict:true}),/persona/);
  });
  await test('fresh proof rejects an unresolved selected persona rather than using default',async()=>{
    const f=await load(),st=f.api.LibraDataStorage;f.control.selectedPersona=9;
    await assert.rejects(st.resolvePersonaId({},{},{fresh:true,strict:true}),/persona/);
  });
  await test('verified storage survives a fresh runtime on the same synthetic backing store',async()=>{
    const first=await load(),st=first.api.LibraDataStorage;
    assert.equal((await st.saveVerified(scope,[entry],{expectedRaw:null,isCurrent:async()=>true})).ok,true);
    const fresh=await load({store:first.store});const result=await fresh.api.LibraDataStorage.readVerified(scope);
    assert.equal(result.ok,true);assert.deepEqual(clone(result.entries),[entry]);
  });
  await test('legacy default-persona bytes block ambiguous new canonical reads and writes',async()=>{
    const f=await load(),st=f.api.LibraDataStorage,legacy=scope.replace(/persona:.+$/,'persona:default');
    const raw=JSON.stringify({version:'1.0',scopeKey:legacy,entries:[entry]});f.store.set(st.storageKeyFor(legacy),raw);
    const read=await st.readVerified(scope);assert.equal(read.ok,false);assert.equal(read.reason,'legacy_persona_ambiguous');
    const write=await st.saveVerified(scope,[entry],{expectedRaw:null,isCurrent:async()=>true});
    assert.equal(write.ok,false);assert.equal(write.reason,'legacy_persona_ambiguous');assert.equal(f.writes.length,0);
    assert.equal(f.store.get(st.storageKeyFor(legacy)),raw);assert.equal(f.store.has(st.storageKeyFor(scope)),false);
    assert.equal(st.isHydrated(scope),false);
  });
  await test('fresh no-persona proof cannot inherit stale persona cache',async()=>{
    const f=await load(),st=f.api.LibraDataStorage;f.seedPersona('old-persona');f.control.noPersonas=true;
    const key=await st.scopeKeyForAsync({id:'fixture-char'},{id:'fixture-chat'},{fresh:true,strict:true});
    assert.equal(key,'char:fixture-char|chat:fixture-chat|persona:default');
    assert.equal(st.scopeKeyFor({id:'fixture-char'},{id:'fixture-chat'}),'char:fixture-char|chat:fixture-chat|persona:old-persona');
  });
  for(const unresolved of ['char:unknown|chat:fixture-chat|persona:p','char:c|chat:unknown|persona:p','char:charIndex:0|chat:chatIndex:0|persona:p'])await test(`management rejects unresolved identity ${unresolved}`,async()=>{
    const f=await load(),st=f.api.LibraDataStorage;
    assert.equal((await st.readVerified(unresolved)).ok,false);
    assert.equal((await st.saveVerified(unresolved,[entry],{isCurrent:async()=>true})).ok,false);
    assert.equal(f.reads.length,0);assert.equal(f.writes.length,0);
  });
  for(const kind of ['foreign','duplicate','wrong-key'])await test(`strict reader rejects ${kind} chunk manifest before reading child keys`,async()=>{
    const f=await load();const chunk='key::chunk:v1:stamp:0000';
    const manifest={__libraChunkedStorageV1:true,key:kind==='wrong-key'?'other':'key',length:2,chunks:kind==='foreign'?['other-data']:(kind==='duplicate'?[chunk,chunk]:[chunk])};
    f.store.set('key',JSON.stringify(manifest));f.store.set(chunk,'ab');f.store.set('other-data','private-other-value');
    await assert.rejects(f.api.RisuCompat.pluginStorage.getItem('key',{strict:true}),/storage_read/);
    assert.deepEqual(f.reads,['key']);
  });
  await test('strict reader reconstructs a valid same-key chunk manifest',async()=>{
    const f=await load(),chunks=['key::chunk:v1:stamp:0000','key::chunk:v1:stamp:0001'];
    f.store.set('key',JSON.stringify({__libraChunkedStorageV1:true,key:'key',length:4,chunks}));f.store.set(chunks[0],'ab');f.store.set(chunks[1],'cd');
    assert.equal(await f.api.RisuCompat.pluginStorage.getItem('key',{strict:true}),'abcd');
  });
  for (const rows of [[null], ['text'], [{}], [{comment:'native_lore',content:'external'}]]) await test(`strict management save rejects malformed/unmanaged rows ${JSON.stringify(rows)}`,async()=>{
    const f=await load(),st=f.api.LibraDataStorage;
    const result=await st.saveVerified(scope,rows,{expectedRaw:null,isCurrent:async()=>true});
    assert.equal(result.ok,false);assert.equal(result.reason,'invalid_management_payload');assert.equal(f.writes.length,0);assert.equal(st.isHydrated(scope),false);
  });
  await test('explicit empty canonical array remains a valid verified save',async()=>{
    const f=await load(),st=f.api.LibraDataStorage;
    const result=await st.saveVerified(scope,[],{expectedRaw:null,isCurrent:async()=>true});assert.equal(result.ok,true);assert.equal(result.entryCount,0);
  });
  await test('legacy save preserves shadow and host until exact canonical readback',async()=>{
    const f=await load({mode:'reject'}),st=f.api.LibraDataStorage,chat={id:'fixture-chat',bindedPersona:'persona-a',localLore:[entry]},char={id:'fixture-char'};
    const before=JSON.stringify(chat),result=await st.save(char,chat,[entry]);
    assert.equal(result.ok,false);assert.equal(result.reason,'canonical_save_unverified');assert.equal(st.getShadowEntries(scope).length,0);
    assert.equal(st.isHydrated(scope),false);assert.equal(JSON.stringify(chat),before);assert.equal(f.writes.length,1);
    assert.equal(f.store.has(st.storageKeyFor(scope)),false);
  });
  await test('verified review save preserves lineage and unrelated canonical envelope metadata',async()=>{
    const f=await load(),st=f.api.LibraDataStorage,key=st.storageKeyFor(scope),metadata={inheritedFrom:'parent-chat',hostWorldlineMeta:{parentWorldlineId:'parent-worldline',forkTurn:3,forkFingerprint:'known-prefix'},extension:{labels:['keep','unchanged']}};
    const raw=JSON.stringify({version:'1.0',scopeKey:scope,entryCount:1,entries:[entry],...metadata});f.store.set(key,raw);
    const replacement={...entry,content:'changed managed content'},saved=await st.saveVerified(scope,[replacement],{expectedRaw:raw,isCurrent:async()=>true});
    assert.equal(saved.ok,true);const after=JSON.parse(f.store.get(key));for(const [name,value]of Object.entries(metadata))assert.deepEqual(after[name],value);assert.deepEqual(after.entries,[replacement]);assert.equal(after.scopeKey,scope);
  });
  await test('inheritance metadata cannot overwrite an existing or differently scoped target',async()=>{
    const f=await load(),st=f.api.LibraDataStorage,key=st.storageKeyFor(scope),raw=JSON.stringify({scopeKey:scope,entries:[entry],inheritedFrom:'original-parent'});f.store.set(key,raw);
    const metadata={inheritedFrom:'new-parent',hostWorldlineMeta:{scopeKey:scope}};const existing=await st.saveVerified(scope,[],{expectedRaw:raw,inheritance:metadata,isCurrent:async()=>true});assert.equal(existing.ok,false);assert.equal(f.store.get(key),raw);assert.equal(f.writes.length,0);
    f.store.delete(key);const wrong=await st.saveVerified(scope,[],{expectedRaw:null,inheritance:{...metadata,hostWorldlineMeta:{scopeKey:'foreign'}},isCurrent:async()=>true});assert.equal(wrong.ok,false);assert.equal(f.store.has(key),false);assert.equal(f.writes.length,0);
  });
  console.log(JSON.stringify({passed:checks.filter(x=>x.ok).length,failed:checks.filter(x=>!x.ok).length,checks},null,2));
})().catch(error=>{console.error(error);process.exitCode=1});
