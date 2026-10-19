'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture,QUOTE}=require('./fixtures/libra_memory_graph_reader_fixture.cjs');
const options={corpusMode:'auto',queryInput:{queryText:QUOTE},semanticPolicy:{mode:'disabled'},laneBudget:{maxPages:128,maxBytes:262144}};
const released=api=>{
  const pool=api.inspectMemoryGraphStore().resources;
  for(const key of ['retainedBytes','sessions','ioBytes','reads','decodeBytes'])assert.equal(pool[key],0,key);
};

test('projection-local reuse still rejects byte-identical server ABA at the final physical read',async t=>{
  const x=await fixture({mode:'server_only'});t.after(()=>x.cleanup());
  const api=x.f.r.api,key=x.active.recordKey,body=x.server.storedRows().find(row=>row.key===key).value;
  let mutations=0;
  x.server.hooks.beforeServerRequest=async(url,init)=>{
    if(!url.endsWith('/v1/kv/get-many')||!JSON.parse(init.body).keys.includes(key))return;
    mutations++;
    await x.server.mutate(key,{...body,externalRevisionMarker:mutations});
    await x.server.mutate(key,body);
  };
  await assert.rejects(api.executeMemoryGraphUnifiedQuery(options),/LIBRA_GRAPH_READER_BODY_CHANGED/);
  assert.equal(mutations,3,'only the existing two bounded projection retries are allowed');
  released(api);
  x.server.hooks.beforeServerRequest=null;
  const graph=await x.project();
  assert.ok(graph.units.some(row=>row.family==='micro'&&row.text===QUOTE));
  released(api);
  const calls=x.f.control.calls.length;
  const output=await x.f.control.hooks.beforeRequest([{role:'user',content:'은빛 열쇠의 현재 보관자는 누구야?'}],'model');
  assert.ok(output.length>1);assert.ok(JSON.stringify(output).includes(QUOTE));
  assert.equal(api.getRuntime().lastMemoryInjectionMeta.finalVerification.status,'verified');
  assert.equal(x.f.control.calls.length,calls);
});

test('a local body changing during projection cannot become deliverable through cached reads',async t=>{
  const x=await fixture({includeMicro:false});t.after(()=>x.cleanup());const api=x.f.r.api;
  const backend=x.f.r.context.risuai.pluginStorage,get=backend.getItem;
  const key=[...x.f.r.values.keys()].find(key=>key.endsWith(':manifest')),raw=x.f.r.values.get(key);
  let revision=0;
  backend.getItem=async function(storageKey){
    if(storageKey===key)x.f.r.values.set(key,JSON.stringify({...JSON.parse(raw),externalRevisionMarker:++revision}));
    return get.call(this,storageKey);
  };
  t.after(()=>{backend.getItem=get;});
  await assert.rejects(api.executeMemoryGraphUnifiedQuery(options),/LIBRA_GRAPH_READER_BODY_CHANGED/);
  released(api);backend.getItem=get;x.f.r.values.set(key,raw);
  assert.equal((await api.executeMemoryGraphUnifiedQuery(options)).modelDispatchEligible,true);released(api);
});

test('a valid body larger than the paged HTTP allowance still passes physical readback and RAG delivery',async t=>{
  const x=await fixture({mode:'server_only'});t.after(()=>x.cleanup());
  const key=x.server.storedRows().find(row=>row.key.endsWith(':manifest')).key;
  await x.server.mutate(key,{...x.server.getManifest(),readerValidationPadding:'x'.repeat(300*1024)});
  const limit=256*1024;
  const response=await x.server.send('POST','/v1/kv/get-many',{namespace:'libra',space:'plugin',keys:[key],paged:true,maxResponseBytes:limit});
  assert.ok(response.result.oversizedKeys.includes(key));
  x.server.hooks.beforeServerRequest=async(url,init)=>{
    if(url.endsWith('/v1/kv/get-many'))init.body=JSON.stringify({...JSON.parse(init.body),maxResponseBytes:limit});
  };
  const graph=await x.project();assert.ok(graph.units.some(row=>row.family==='micro'&&row.text===QUOTE));
  const output=await x.f.control.hooks.beforeRequest([{role:'user',content:'은빛 열쇠의 현재 보관자는 누구야?'}],'model');
  assert.ok(output.length>1);assert.ok(JSON.stringify(output).includes(QUOTE));
  assert.equal(x.f.r.api.getRuntime().lastMemoryInjectionMeta.finalVerification.status,'verified');
});

test('an explicit build restarts after a real source change and never resets its cumulative budget',async t=>{
  let changed=false,inject=false,mutate=()=>{};
  const anchor='async captureSourceProof({ collected: corpusCollected, windowProofs = [], config = {}, previousOwnerProof = null, reusedOnlySourceKeys = [] }) {';
  const x=await fixture({includeMicro:false,hostOverrides:{beforeCorpusProof(){if(inject&&!changed){changed=true;mutate();}}},
    transformSource:source=>{assert.equal(source.split(anchor).length,2);return source.replace(anchor,anchor+' await risuai.beforeCorpusProof();');}});
  t.after(()=>x.cleanup());const api=x.f.r.api;
  const key=[...x.f.r.values.keys()].find(key=>key.endsWith(':manifest'));
  mutate=()=>x.f.r.values.set(key,JSON.stringify({...JSON.parse(x.f.r.values.get(key)),externalRevisionMarker:Date.now()}));
  inject=true;
  const result=await api.buildMemoryGraphCorpus({incremental:false});
  assert.equal(changed,true);assert.equal(result.status,'published');assert.equal(result.sourceChangeRetries,1);
  released(api);
  const baseline=await api.buildMemoryGraphCorpus({incremental:false});released(api);
  changed=false;
  await assert.rejects(api.buildMemoryGraphCorpus({incremental:false,resourceBudget:{maxSourceBytes:baseline.resourceAccess.sourceBytes+1}}),/LIBRA_GRAPH_RESOURCE_(SOURCE|VALUE)_BYTE_BUDGET/);
  assert.equal(changed,true);released(api);
});
