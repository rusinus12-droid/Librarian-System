'use strict';
// Real HAYAKU writer, SDK migration and recovery reader; only the host stores and
// transport are synthetic. The real server router/SQLite run without sockets.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createMemorySuiteServer } = require('../server/server.cjs');
const transport = require('./helpers/inprocess-review-transport.cjs');
const { createStore, createHayakuRuntime } = require('./fixtures/hayaku_runtime_harness.cjs');
const PROGRAM = path.resolve(__dirname, '..');
const EVIDENCE = 'hayaku.v2.recovery_evidence_';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const plain = value => JSON.parse(JSON.stringify(value));
const tests = [];
function test(name, run) { tests.push({ name, run }); }
async function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hayaku-sidecar-migration-'));
  const app = createMemorySuiteServer({ dataDir:path.join(root, 'DATA'), autoBackup:false, computeEnabled:false });
  const plugin = path.join(root, 'HAYAKU-test.js');
  const source = fs.readFileSync(process.env.LIB_HAYAKU_TEST_SOURCE || path.join(PROGRAM, 'plugins/HAYAKU_Locator_Continuity.js'), 'utf8');
  const anchor = '        updateRecoveryJournalBackgroundDecision,';
  assert(source.includes(anchor));
  fs.writeFileSync(plugin, source.replace(anchor, '        storageBridgeForMigrationTest:MemorySuiteStorageBridge,\n' + anchor));
  const calls = [], hostStore = createStore(), deviceStore = createStore();
  const baseFetch = transport(app, calls);
  const fault = { uploadKey:null, localKey:null, hits:0 };
  const setItem = hostStore.setItem;
  hostStore.setItem = async (key, value) => {
    if (fault.localKey === key) { fault.hits++; throw new Error('CONTROLLED_SIDECAR_LOCAL_WRITE_FAILURE'); }
    return setItem(key, value);
  };
  let runtime;
  const open = async () => {
    if (runtime) await runtime.dispose();
    runtime = await createHayakuRuntime({ pluginSourceFile:plugin, pluginStorage:hostStore,
      safeLocalStorage:deviceStore, autoRepair:false, afterRequestAutoRepair:false,
      nativeFetch:async (url, init) => {
        assert.equal(new URL(url).hostname, '127.0.0.1');
        if (fault.uploadKey && (init?.method || 'GET') !== 'GET' && String(init?.body || '').includes(fault.uploadKey)) {
          fault.hits++; return new Response(JSON.stringify({ ok:false,error:'CONTROLLED_SIDECAR_SERVER_WRITE_FAILURE' }), {status:503,headers:{'Content-Type':'application/json'}});
        }
        return baseFetch(url, init);
      }, arguments:{memory_suite_server_mode:'plugin_only',memory_suite_server_url:'http://127.0.0.1:47631'},
      llmResponder:async () => { throw new Error('MODEL_CALL_FORBIDDEN'); } });
    return runtime;
  };
  const serverRows = () => new Map(app.repositories.hayaku.database.prepare("SELECT key,value_json FROM kv WHERE space='plugin' AND deleted=0").all().map(row => [row.key,JSON.parse(row.value_json)]));
  const seed = async (scopeKey, recordId='sidecar-debt') => {
    const t = runtime.hayaku._test;
    const record = {recordId, scopeKey, pairIndex:1, user:{text:'Read the blue archive.'}, assistant:{text:'The blue archive contains a brass key. '.repeat(1850)}, status:'deterministic_fallback'};
    const attached = await t.attachRecoveryEvidenceSidecar(record);
    assert.equal(attached.durable, true, attached.reason);
    const saved = await t.writeRecoveryVaultDirect(scopeKey, {...t.emptyRecoveryVault(scopeKey),records:[attached.record]});
    assert.equal(saved.durable,true,saved.reason);
    const ledgerKey = 'hayaku.v2.ledger.' + scopeKey;
    // Synthetic canonical ledger: valid owner schema and exact explicit scope.
    await hostStore.setItem(ledgerKey,JSON.stringify({version:'hayaku_storage_ledger_v2',scopeKey,records:[],fixture:'synthetic'}));
    const keys = [...hostStore.values].filter(([key,value]) => key.startsWith('hayaku.v2.') && (()=>{try{return JSON.parse(value).scopeKey===scopeKey;}catch{return false;}})()).map(([key])=>key);
    return {scopeKey,record:attached.record,ref:attached.manifestRef,keys,bytes:new Map(keys.map(key=>[key,hostStore.values.get(key)]))};
  };
  try { await open(); await run({get runtime(){return runtime;},open,seed,hostStore,deviceStore,serverRows,fault,calls,app}); }
  finally { if(runtime){assert.equal(runtime.llmCalls.length,0);await runtime.dispose();} app.server.emit('close'); fs.rmSync(root,{recursive:true,force:true}); }
}
async function active(f) { const scope=await f.runtime.hayaku._test.currentChatScope();return {scopeId:scope.key,scopeKey:scope.key}; }
function bridge(f) {return f.runtime.hayaku._test.storageBridgeForMigrationTest;}
async function consumer(f, seeded) {
  const vault=await f.runtime.hayaku._test.loadRecoveryVault(seeded.scopeKey,{force:true});
  const record=vault.records.find(row=>row.recordId===seeded.record.recordId);
  assert(record,'canonical vault retains debt');
  const read=await f.runtime.hayaku._test.readVerifiedRecoveryEvidence(record,null,null,{rehydrate:false});
  assert.equal(read.ok,true,read.reason);
  assert.equal(read.user,'Read the blue archive.');
  assert.equal(read.assistant,'The blue archive contains a brass key. '.repeat(1850).trim());
  return read;
}
function exact(actual, seeded) {for(const [key,value] of seeded.bytes)assert.equal(actual.get(key),value,`destination exact readback: ${key}`);}

test('plugin -> server includes generated sidecars and preserves foreign/secret exclusion',()=>fixture(async f=>{
  const scope=await active(f), a=await f.seed(scope.scopeKey), b=await f.seed('foreign-scope','other-debt');
  await f.hostStore.setItem('host.unrelated','private');await f.hostStore.setItem('hayaku.api_key','secret');
  const before=new Map([...a.bytes,...b.bytes,['host.unrelated','private'],['hayaku.api_key','secret']]);
  await f.open(); // No writer-created map or owner cache may supply discovery.
  const inventory=await bridge(f).inspectNativeBranchTargetLocalData(scope);
  const discovered=new Set(inventory.keys.map(row=>row.key));
  for(const key of a.keys)assert(discovered.has(key),`migration discovery omitted ${key}`);
  for(const key of b.keys)assert(!discovered.has(key),`foreign scope was admitted ${key}`);
  await bridge(f).setScopeMode(scope,'server_only');
  exact(f.serverRows(),a);for(const key of b.keys)assert(!f.serverRows().has(key));
  assert(!f.serverRows().has('host.unrelated'));assert(!f.serverRows().has('hayaku.api_key'));
  for(const [key,value] of before)assert.equal(f.hostStore.values.get(key),value,'source bytes remain intact');
  await consumer(f,a);
  console.log(JSON.stringify({case:'upload',keys:a.keys.length,sidecars:a.keys.filter(k=>k.startsWith(EVIDENCE)).length,bytesSha:sha(JSON.stringify([...a.bytes]))}));
}));

test('server -> plugin from cleared owner storage restores graph and recovery consumer',()=>fixture(async f=>{
  const scope=await active(f), a=await f.seed(scope.scopeKey);
  await bridge(f).setScopeMode(scope,'server_only');
  // Independent server seed allows this reverse-path test to fail on its own
  // even before upload coverage has been repaired.
  for(const [key,value] of a.bytes)if(!f.serverRows().has(key))f.app.repositories.hayaku.mutate({kind:'set',space:'plugin',key,value,operationId:crypto.randomUUID()});
  for(const key of a.keys)f.hostStore.values.delete(key);
  await f.open();
  await bridge(f).setScopeMode(scope,'plugin_only');
  exact(f.hostStore.values,a);exact(f.serverRows(),a);await consumer(f,a);
}));

test('partial upload keeps source authority and retry completes both canonical and evidence',()=>fixture(async f=>{
  const scope=await active(f), a=await f.seed(scope.scopeKey);
  f.fault.uploadKey=a.keys.find(key=>key.startsWith(EVIDENCE+'chunk.'));
  await assert.rejects(()=>bridge(f).setScopeMode(scope,'server_only'));
  assert(f.fault.hits>0,'fault reached a real evidence write');
  assert.equal((await bridge(f).getScopeMode(scope)).mode,'plugin_only');exact(f.hostStore.values,a);
  f.fault.uploadKey=null;
  await bridge(f).setScopeMode(scope,'server_only');exact(f.serverRows(),a);await consumer(f,a);
}));

test('partial restore rolls local graph back, preserves server authority and retries',()=>fixture(async f=>{
  const scope=await active(f), a=await f.seed(scope.scopeKey);
  await bridge(f).setScopeMode(scope,'server_only');
  for(const [key,value] of a.bytes)if(!f.serverRows().has(key))f.app.repositories.hayaku.mutate({kind:'set',space:'plugin',key,value,operationId:crypto.randomUUID()});
  for(const key of a.keys)f.hostStore.values.delete(key);
  await f.open();f.fault.localKey=a.keys.find(key=>key.startsWith(EVIDENCE+'chunk.'));
  await assert.rejects(()=>bridge(f).setScopeMode(scope,'plugin_only'));
  assert(f.fault.hits>0,'fault reached restored evidence');
  assert.equal((await bridge(f).getScopeMode(scope)).mode,'server_only');
  for(const key of a.keys)assert(!f.hostStore.values.has(key),'partial restore rolled back');exact(f.serverRows(),a);
  f.fault.localKey=null;await bridge(f).restorePluginStorage();await bridge(f).setScopeMode(scope,'plugin_only');exact(f.hostStore.values,a);await consumer(f,a);
}));

for(const damage of ['missing','foreign'])test(`restore rejects ${damage} referenced evidence`,()=>fixture(async f=>{
  const scope=await active(f), a=await f.seed(scope.scopeKey);
  await bridge(f).setScopeMode(scope,'server_only');
  for(const [key,value] of a.bytes)if(!f.serverRows().has(key))f.app.repositories.hayaku.mutate({kind:'set',space:'plugin',key,value,operationId:crypto.randomUUID()});
  const key=a.keys.find(key=>key.startsWith(EVIDENCE+'chunk.'));
  if(damage==='missing')f.app.repositories.hayaku.mutate({kind:'remove',space:'plugin',key,operationId:crypto.randomUUID()});
  else {const value=JSON.parse(a.bytes.get(key));value.scopeKey='foreign-scope';f.app.repositories.hayaku.mutate({kind:'set',space:'plugin',key,value:JSON.stringify(value),operationId:crypto.randomUUID()});}
  for(const key of a.keys)f.hostStore.values.delete(key);await f.open();
  await assert.rejects(()=>bridge(f).setScopeMode(scope,'plugin_only'));
  assert.equal((await bridge(f).getScopeMode(scope)).mode,'server_only');
  for(const key of a.keys)assert(!f.hostStore.values.has(key),'invalid graph was not published locally');
}));

for(const damage of ['missing','corrupt'])test(`source ${damage} manifest cannot become a successful incomplete upload`,()=>fixture(async f=>{
  const scope=await active(f), a=await f.seed(scope.scopeKey),key=a.record.evidenceManifest.manifestKey;
  if(damage==='missing')f.hostStore.values.delete(key);else f.hostStore.values.set(key,'{corrupt manifest');
  await f.open();await assert.rejects(()=>bridge(f).setScopeMode(scope,'server_only'));
  assert.equal((await bridge(f).getScopeMode(scope)).mode,'plugin_only');
  for(const [k,v] of a.bytes)if(k!==key)assert.equal(f.hostStore.values.get(k),v,'source evidence and canonical bytes preserved');
  assert.equal(f.serverRows().size,0,'preflight failure writes no server payload');
}));

for(const damage of ['missing_chunk','corrupt_chunk','missing_all_evidence'])test(`source ${damage} blocks before target writes and retry preserves both graphs`,()=>fixture(async f=>{
  const scope=await active(f), a=await f.seed(scope.scopeKey);
  const chunkKey=a.keys.find(key=>key.startsWith(EVIDENCE+'chunk.'));
  if(damage==='missing_chunk')f.hostStore.values.delete(chunkKey);
  else if(damage==='corrupt_chunk')f.hostStore.values.set(chunkKey,'{corrupt chunk');
  else for(const key of a.keys.filter(key=>key.startsWith(EVIDENCE)))f.hostStore.values.delete(key);
  const sourceBefore=new Map(a.keys.filter(key=>f.hostStore.values.has(key)).map(key=>[key,f.hostStore.values.get(key)]));
  f.app.repositories.hayaku.mutate({kind:'set',space:'plugin',key:'hayaku.v2.ledger.healthy-target',value:'HEALTHY_TARGET_BYTES',operationId:crypto.randomUUID()});
  const targetBefore=f.serverRows();
  await f.open();await assert.rejects(()=>bridge(f).setScopeMode(scope,'server_only'));
  assert.equal((await bridge(f).getScopeMode(scope)).mode,'plugin_only');
  assert.deepEqual(f.serverRows(),targetBefore,'source graph rejection leaves existing target bytes unchanged');
  for(const [key,value] of sourceBefore)assert.equal(f.hostStore.values.get(key),value,'source bytes preserved after rejection');
  for(const [key,value] of a.bytes)f.hostStore.values.set(key,value);
  await bridge(f).setScopeMode(scope,'server_only');exact(f.serverRows(),a);await consumer(f,a);
  assert.equal(f.serverRows().get('hayaku.v2.ledger.healthy-target'),'HEALTHY_TARGET_BYTES');
}));

test('manifest read failure cannot fall back and bind foreign evidence to current scope',()=>fixture(async f=>{
  const scope=await active(f);await f.seed(scope.scopeKey);const foreign=await f.seed('foreign-scope','other-debt');
  await f.open();const read=f.hostStore.getItem;let refused=0;
  f.hostStore.getItem=async key=>{if(key===foreign.record.evidenceManifest.manifestKey && refused++<2)throw new Error('CONTROLLED_MANIFEST_SCOPE_READ_FAILURE');return read(key);};
  await assert.rejects(()=>bridge(f).inspectNativeBranchTargetLocalData(scope),/CONTROLLED_MANIFEST_SCOPE_READ_FAILURE/);
  assert.equal((await bridge(f).getScopeMode(scope)).mode,'plugin_only');
  for(const key of foreign.keys)assert(!f.serverRows().has(key),'no foreign evidence transmitted');
  refused=0;
  const failed=await bridge(f).setGlobalMode('server_only');
  assert.equal(failed.failed.length,1,'global migration reports incomplete scope');
  assert.equal(failed.failed[0].reason,'MEMORY_SUITE_SCOPE_SYNC_INCOMPLETE');
  assert.equal((await bridge(f).getScopeMode(scope)).mode,'plugin_only','failed scope preserves source authority');
  f.hostStore.getItem=read;
  const inventory=await bridge(f).inspectNativeBranchTargetLocalData(scope);
  for(const key of foreign.keys)assert(!inventory.keys.some(row=>row.key===key));
  const retried=await bridge(f).setGlobalMode('server_only');assert.equal(retried.failed.length,0);
  assert.equal((await bridge(f).getScopeMode(scope)).mode,'server_only');
  for(const key of foreign.keys)assert(!f.serverRows().has(key));
}));

test('global follower transition preserves evidence in both directions and repeated target',()=>fixture(async f=>{
  const scope=await active(f), a=await f.seed(scope.scopeKey);
  const up=await bridge(f).setGlobalMode('server_only');assert.equal(up.failed.length,0);exact(f.serverRows(),a);
  const again=await bridge(f).setGlobalMode('server_only');assert.equal(again.failed.length,0);exact(f.serverRows(),a);
  for(const key of a.keys)f.hostStore.values.delete(key);await f.open();
  const down=await bridge(f).setGlobalMode('plugin_only');assert.equal(down.failed.length,0);exact(f.hostStore.values,a);await consumer(f,a);
}));

test('legacy evidence keeps its original manifest hash and byte representation',()=>fixture(async f=>{
  const legacy=require('./fixtures/hayaku_evidence_3_0_57.json');
  for(const [key,value] of Object.entries(legacy.evidence))await f.hostStore.setItem(key,JSON.stringify(value));
  const [manifestKey,manifest]=Object.entries(legacy.evidence).find(([key])=>key.startsWith(EVIDENCE+'manifest.'));
  const input={scopeKey:manifest.scopeKey,recordId:manifest.recordId,pairIndex:manifest.pairIndex,
    user:'Find ribbon.',assistant:'Alice found a blue ribbon.',userCanonicalHash:manifest.userCanonicalHash,assistantCanonicalHash:manifest.assistantCanonicalHash};
  const out=await f.runtime.hayaku._test.writeRecoveryEvidenceSidecar(input);assert.equal(out.ok,true,out.reason);
  assert.equal(out.manifestRef.manifestHash,manifest.manifestHash);assert.equal(out.manifestRef.manifestKey,manifestKey);
  for(const [key,value] of Object.entries(legacy.evidence))assert.equal(f.hostStore.values.get(key),JSON.stringify(value));
}));

test('ordinary server-only vault commit validates server evidence without local copies',()=>fixture(async f=>{
  const scope=await active(f), a=await f.seed(scope.scopeKey);
  await bridge(f).setScopeMode(scope,'server_only');
  const t=f.runtime.hayaku._test;
  const attached=await t.attachRecoveryEvidenceSidecar({scopeKey:scope.scopeKey,recordId:'server-vault-debt',pairIndex:2,
    user:{text:'Server-only question'},assistant:{text:'Server-only evidence'}});
  assert.equal(attached.durable,true,attached.reason);
  assert(!f.hostStore.values.has(attached.record.evidenceManifest.manifestKey));
  const vault=await t.loadRecoveryVault(scope.scopeKey,{force:true});
  const saved=await t.writeRecoveryVaultDirect(scope.scopeKey,{...vault,records:[...vault.records,attached.record]});
  assert.equal(saved.durable,true,saved.reason);
  const reread=await t.loadRecoveryVault(scope.scopeKey,{force:true});
  const debt=reread.records.find(row=>row.recordId==='server-vault-debt');assert(debt);
  const verified=await t.readVerifiedRecoveryEvidence(debt,null,null,{rehydrate:false});assert.equal(verified.ok,true,verified.reason);
  assert.equal(verified.assistant,'Server-only evidence');exact(f.hostStore.values,a);
}));

test('new server-only evidence is server-owned before its vault reference is published',()=>fixture(async f=>{
  const scope=await active(f), a=await f.seed(scope.scopeKey);
  await bridge(f).setScopeMode(scope,'server_only');
  const input={scopeKey:scope.scopeKey,recordId:'new-server-debt',user:'New question',assistant:'New answer'};
  const out=await f.runtime.hayaku._test.writeRecoveryEvidenceSidecar(input);
  assert.equal(out.durable,true,out.reason);
  assert(f.serverRows().has(out.manifestRef.manifestKey),'new manifest stored on server');
  assert(!f.hostStore.values.has(out.manifestRef.manifestKey),'server-only evidence not left local-only');
  const read=await f.runtime.hayaku._test.readRecoveryEvidenceSidecar(out.manifestRef,input);assert.equal(read.ok,true,read.reason);
}));

(async()=>{let failed=0;for(const {name,run} of tests){try{await run();console.log('PASS '+name);}catch(error){failed++;console.error('FAIL '+name+'\n'+(error.stack||error));}}console.log(JSON.stringify({tests:tests.length,failed,sockets:0,externalApis:0,modelCalls:0}));if(failed)process.exitCode=1;})().catch(error=>{console.error(error);process.exitCode=1;});
