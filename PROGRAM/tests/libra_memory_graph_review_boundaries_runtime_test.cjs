'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {fixture,QUOTE}=require('./fixtures/libra_memory_graph_reader_fixture.cjs');
const hash=text=>crypto.createHash('sha256').update(text).digest('hex');

test('source body changed after projection cannot be certified as the baseline for that old projection',async t=>{
  let atProof=async()=>{};
  const x=await fixture({hostOverrides:{reviewProofBoundary:()=>atProof()},transformSource:source=>{
    const marker='async captureSourceProof({ collected: corpusCollected, windowProofs = [], config = {}, previousOwnerProof = null, reusedOnlySourceKeys = [] }) {';
    assert.equal(source.split(marker).length,2);
    return source.replace(marker,marker+' await risuai.reviewProofBoundary();');
  }});t.after(()=>x.cleanup());
  const api=x.f.r.api,values=x.f.r.values,original=values.get(x.active.recordKey);
  let injected=false;
  atProof=async()=>{
    if(injected)return;injected=true;
    const body=JSON.parse(original);body.claims[0].text+=' changed after graph projection';
    values.set(x.active.recordKey,JSON.stringify(body));
  };
  await assert.rejects(()=>api.buildMemoryGraphCorpus({limit:1}),/SOURCE.*CHANGED|BODY_CHANGED/);
  assert.equal(injected,true);
  assert.equal([...values.keys()].some(key=>key.includes(':corpus:root:')),false,'failed source capture must not publish a root');
  values.set(x.active.recordKey,original);atProof=async()=>{};
  const built=await api.buildMemoryGraphCorpus({limit:1});
  assert.equal(built.status,'published');
  const healthy=await api.executeMemoryGraphUnifiedQuery({corpusMode:'required',queryInput:{queryText:QUOTE},semanticPolicy:{mode:'disabled'}});
  assert.equal(healthy.modelDispatchEligible,true);
  assert.equal(healthy.corpusRead.nativeReprojectionRequired,false);
  assert.equal(healthy.packet.byteInventory.counted.owner_io_in_flight,null,'transfer bytes must not masquerade as active buffers');
  assert.equal(healthy.packet.byteInventory.counted.write_barrier,null,'an unmeasured barrier must not claim zero bytes');
  // Previously deployed v1 baselines are readable only through full native
  // reprojection. A self-consistent old manifest must not reinstate that proof.
  const rootKey=[...values.keys()].find(key=>key.includes(':corpus:root:'));
  const root=JSON.parse(values.get(rootKey)),manifest=JSON.parse(values.get(root.manifestKey));
  const prefix=rootKey.slice(0,rootKey.lastIndexOf('root:'));
  const proof=JSON.parse(values.get(manifest.sourceProofs.proofKey));
  proof.proofVersion='libra.source_proof_contract.v1';
  proof.ownerProof.sourceBodyDigests=Object.fromEntries(Object.keys(proof.ownerProof.sourceBodyDigests).map(key=>[key,'legacy-uncertified-baseline']));
  const proofRaw=JSON.stringify(proof),proofDigest=hash(proofRaw),proofKey=prefix+'proof:'+proofDigest;
  values.set(proofKey,proofRaw);manifest.sourceProofs={...manifest.sourceProofs,proofVersion:proof.proofVersion,proofKey,proofDigest};
  const manifestRaw=JSON.stringify(manifest),digest=hash(manifestRaw),manifestKey=prefix+'manifest:'+digest;
  values.set(manifestKey,manifestRaw);values.set(rootKey,JSON.stringify({...root,digest,manifestKey}));
  const legacy=await api.executeMemoryGraphUnifiedQuery({corpusMode:'required',queryInput:{queryText:QUOTE},semanticPolicy:{mode:'disabled'}});
  assert.equal(legacy.modelDispatchEligible,true);assert.equal(legacy.corpusRead.nativeReprojectionRequired,true);
});

for(const mode of ['plugin_only','server_only'])test(`${mode}: native GC requires an owner fence and never uses runtime maps as deletion authority`,async t=>{
  const x=await fixture({mode});t.after(()=>x.cleanup());
  const api=x.f.r.api;
  await api.buildMemoryGraphGeneration({pageBytes:16384});
  const root=x.f.getRecords('libra.graph_root.v1')[0];assert.ok(root);
  const generation=x.f.getRecords('libra.graph_generation.v1').find(r=>r.key===root.value.manifestKey);assert.ok(generation);
  const orphanRaw=JSON.stringify({...generation.value,jobToken:'independent-publisher'}),digest=hash(orphanRaw);
  const prefix=`libra:v1:scope:${x.scopeKey}:memory-graph:v1:`;
  const orphanKey=prefix+'generation:'+digest;
  const lateRootKey=prefix+'root:independent-publisher';
  const lateRoot={...root.value,generation:digest,manifestKey:orphanKey,publicationToken:'independent-publisher'};
  if(x.server)await x.server.mutate(orphanKey,JSON.parse(orphanRaw));else x.f.r.values.set(orphanKey,orphanRaw);
  let raced=false;
  if(x.server){
    x.server.hooks.beforeBatch=async body=>{
      if(raced||!body.mutations.some(m=>m.key===orphanKey&&m.kind==='remove'))return;
      raced=true;await x.server.mutate(lateRootKey,lateRoot);
    };
  }else{
    const backend=x.f.r.context.risuai.pluginStorage,remove=backend.removeItem;
    backend.removeItem=async key=>{
      if(key===orphanKey&&!raced){raced=true;x.f.r.values.set(lateRootKey,JSON.stringify(lateRoot));}
      return remove.call(backend,key);
    };
    t.after(()=>{backend.removeItem=remove;});
  }
  const result=await api.collectMemoryGraphGarbage({dryRun:false});
  assert.equal(raced,false,'native server deletion uses the fenced owner endpoint; plugin-only never issues deletion');
  const remaining=x.f.getRecords('libra.graph_generation.v1').find(r=>r.key===orphanKey);
  if(mode==='server_only'){
    assert.equal(result.status,'completed');assert.ok(result.deletedKeys.includes(orphanKey));assert.equal(remaining,undefined);
  }else{
    assert.deepEqual(Array.from(result.deletedKeys),[]);assert.equal(result.status,'blocked_atomic_gc_unavailable');assert.ok(remaining);
  }
  assert.equal((await api.collectMemoryGraphGarbage({dryRun:true})).status,'completed');
});
