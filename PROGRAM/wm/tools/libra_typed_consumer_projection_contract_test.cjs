'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),crypto=require('node:crypto');
const {setup,expose,clone,plain,retained,withoutPersistent}=require('./libra_typed_consumer_projection_support.cjs');
const root=path.resolve(__dirname,'..'), reference=process.env.LIBRA_BINDING_REFERENCE_ROOT;
assert.ok(reference,'supply LIBRA_BINDING_REFERENCE_ROOT for an independent adopted reference');
const pins={'LIBRA World Manager Full.js':'1b7dfcc5eeee71379da32e4cea0fffaecdbc30068fbf19d99de06293cf5acaa4','LIBRA World Manager.js':'f8cae3a6515c7b438740dc59e0ea9412a40abe246431e339c13f3ccfa8e0a8c4'};
for(const [filename,pin] of Object.entries(pins)){
  const oldDist=path.join(reference,'dist',filename),newDist=path.join(root,'dist',filename),label=filename.includes('Full')?'Full':'Min';
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(oldDist)).digest('hex'),pin,'pinned independent '+label);
  test(label+': public API bytes, all 17 projected fields, eligibility, formatter and anchors match adopted artifact',async()=>{
    const old=await setup(oldDist),r=await setup(newDist);
    assert.equal(JSON.stringify(r.original),JSON.stringify(old.original),'identical signed source bytes and clock');
    assert.deepEqual(plain(r.all),plain(old.all),'full enumerate object/property/value contract');
    assert.deepEqual(Object.keys(r.corpus),Object.keys(old.corpus),'no helper added to public API');
    assert.equal(typeof r.project,'function'); assert.equal(old.project,null);
    for(const source of old.all){
      const projected=r.project(r.snapshot,r.policy,[source.identity]);
      assert.equal(projected.length,1);
      assert.deepEqual(Object.keys(projected[0]),retained);
      assert.deepEqual(plain(projected[0]),plain(withoutPersistent(source)));
      for(const key of ['persistentContentHash','persistentDependencyHash'])assert.equal(Object.hasOwn(projected[0],key),false);
      assert.deepEqual(plain(r.corpus.enumerateBindings(r.snapshot,r.policy,[source.identity])),plain(old.corpus.enumerateBindings(old.snapshot,old.policy,[source.identity])));
      assert.deepEqual(plain(r.corpus.resolve(source.identity,r.snapshot)),plain(old.corpus.resolve(source.identity,old.snapshot)));
      assert.deepEqual(plain(r.corpus.adapters[source.family].eligibility(projected[0],r.snapshot)),plain(old.corpus.adapters[source.family].eligibility(source,old.snapshot)));
      assert.deepEqual(plain(r.corpus.adapters[source.family].formatter(projected[0],r.snapshot)),plain(old.corpus.adapters[source.family].formatter(source,old.snapshot)));
      assert.deepEqual(plain(r.corpus.observeAnchors(projected[0],r.snapshot,projected[0].text)),plain(old.corpus.observeAnchors(source,old.snapshot,source.text)));
    }
    for(const ids of [[],['unknown'],['malformed'],[JSON.stringify(['foreign','world','node','world_main'])]])assert.deepEqual(plain(r.project(r.snapshot,r.policy,ids)),[]);
    const id=r.eligible[0].identity;assert.equal(r.project(r.snapshot,r.policy,[id,id]).length,1);
    assert.deepEqual(plain(r.project(r.snapshot,r.policy,undefined)),[]);
    const fakePolicy={consumerBindingProjection:true,skipPersistentHashes:true,bindingOnly:true,projection:'consumer',bindingIdentities:[id]};
    assert.deepEqual(plain(r.corpus.enumerate(r.snapshot,fakePolicy)),plain(old.corpus.enumerate(old.snapshot,fakePolicy)));
    assert.deepEqual(plain(r.corpus.enumerateBindings(r.snapshot,{...fakePolicy},[id])),plain(old.corpus.enumerateBindings(old.snapshot,{...fakePolicy},[id])));
  });
  test(label+': capability is per-call across nested enumeration, policy cloning, exceptions and derived record poisoning',async()=>{
    const r=await setup(newDist),unit=r.select('world','world_old_tower'),adapter=r.corpus.adapters.world,original=adapter.representation;
    let nesting=false,nested=0;
    adapter.representation=(...args)=>{
      if(!nesting){nesting=true;try{const units=r.corpus.enumerateBindings(r.snapshot,{...r.policy},[unit.identity]);assert.equal(units.length,1);assert.ok(units[0].persistentContentHash);assert.ok(units[0].persistentDependencyHash);nested++;}finally{nesting=false;}}
      return original(...args);
    };
    try {const u=r.project(r.snapshot,r.policy,[unit.identity])[0];assert.equal(Object.hasOwn(u,'persistentContentHash'),false);assert.ok(nested>0);}finally{adapter.representation=original;}
    adapter.representation=()=>{throw Error('deliberate projected representation failure');};
    assert.throws(()=>r.project(r.snapshot,r.policy,[unit.identity]),/deliberate projected/);adapter.representation=original;
    assert.deepEqual(plain(r.corpus.resolve(unit.identity,r.snapshot)),plain(unit),'full resolution after thrown projected pass');
    for(let pass=0;pass<3;pass++){
      const u=r.project(r.snapshot,r.policy,[unit.identity])[0];
      u.record.name='POISONED';u.parentRecord.nodes[0][1].rules.custom.oath='POISONED_PARENT';
      const fresh=r.project(r.snapshot,r.policy,[unit.identity])[0];
      assert.deepEqual(plain(fresh),plain(withoutPersistent(unit)));
      assert.equal(r.corpus.inspect(unit,r.snapshot).eligible,true);
      assert.ok(!JSON.stringify(adapter.formatter(unit,r.snapshot)).includes('POISONED'));
    }
    assert.deepEqual(plain(r.corpus.enumerate(r.snapshot)),plain(r.all));
  });
  test(label+': production final bytes and complete observation JSON match independent adopted artifact',async()=>{
    const old=await setup(oldDist),r=await setup(newDist);
    for(const mode of ['direct','projection','hybrid']){
      const outputs=[];
      for(const q of [old,r]){
        const opaque=[{key:'opaque-first',text:'NATIVE FIRST',required:true,bindings:q.eligible.filter(u=>u.family==='world')},{key:'opaque-second',text:'NATIVE SECOND',required:true,bindings:q.eligible.filter(u=>u.family==='entity')}];
        const typed=q.eligible.map(unit=>({key:'typed-core:'+unit.identity,unit,required:true}));
        const composition=q.compose([], [...opaque,...typed]),output=q.finish(composition,mode);
        assert.equal(output.ok,true);assert.equal(q.consumer.verified(output),true);
        for(let i=0;i<3;i++)assert.equal(q.consumer.verified(output),true);
        const payload={messages:[{role:'system',content:'[LIBRA Context Injection]\n'+output.directBlocks.map(b=>b.text).join('\n\n')},{role:'user',content:'Continue'}]};
        q.consumer.observeDelivery(output,payload,true);const observation=q.consumer.deliveryObservation(payload);
        if(mode==='direct'){assert.equal(observation.status,'delivered');assert.ok(observation.knownAnchorCount>0);assert.equal(observation.blocks.length,output.directBlocks.length);assert.ok(observation.blocks.some(b=>b.anchors.length));}
        outputs.push({output:plain(output),payload,observation:plain(observation)});
      }
      assert.deepEqual(outputs[1],outputs[0],mode+' payload and observations');
    }
  });
}
for(const filename of Object.keys(pins)){
 const label=filename.includes('Full')?'Full':'Min';
 test(label+': full index keys, row acceptance, HME source fingerprints, lineage and retrieval ranks survive projected passes',async()=>{
  const provider={spaceFingerprint:'binding-projection-parity-v1',provider:'offline-fixture',model:'tiny-3',modelRevision:'rev1',endpoint:'fixture://no-network',dimension:3,queryMode:'search_query',documentMode:'search_document',options:{normalize:true}};
  const {record}=require('./libra_typed_recall_index_test.cjs');
  const results=[];
  for(const dir of [reference,root]){
   const r=await setup(path.join(dir,'dist',filename));
   if(r.project)for(let i=0;i<3;i++)r.project(r.snapshot,r.policy,r.all.map(u=>u.identity));
   const units=r.corpus.enumerate(r.snapshot),keys=r.eligible.map(u=>r.index.rowKey(r.snapshot,u,provider));
   const handle=await r.index.open(r.snapshot,provider,{storage:{maxRowBytes:8192,maxJobBytes:1048576,maxExpectedBytes:1048576,maxExpectedRows:128}});
   const rows=r.eligible.map(u=>record(r,u,provider));
   assert.equal((await r.index.publish(handle,rows,r.snapshot)).ok,true);
   const read=r.index.read(handle,r.eligible);assert.equal(read.rows.length,r.eligible.length);
   for(const unit of r.eligible)assert.equal(r.index.validate(rows.find(row=>row.identity===unit.identity),unit,provider,provider.documentMode).ok,true);
   r.api.MemoryEngine.CONFIG.hmeAssociativeGraphMode='balanced';r.api.MemoryEngine.CONFIG.hybridMemoryEngineEnabled=true;r.api.MemoryEngine.CONFIG.hybridScopeIndexEnabled=true;
   const maintained=await r.api.MemoryEngine.maintainHmeTypedSourceGraph(r.snapshot);assert.equal(maintained.maintenance.readbackVerified,true);
   const graphRows=[...r.store].filter(([k])=>k.endsWith(':typed-graph'));assert.equal(graphRows.length,1);
   const graph=JSON.parse(graphRows[0][1]);assert.ok(graph.graph.nodes.length>0);
   for(const node of graph.graph.nodes){assert.ok(node.sourceFingerprint);assert.ok(node.contentHash);}
   const retrieval=await r.context.__QUEUE_TEST__.dual.retrieve('민지 펜던트 약속 탑',r.snapshot,null,r.policy);
   assert.ok(retrieval.selection.length>0);assert.equal(r.state.calls.length,0);
   r.change('lmai_narrative',n=>{n.storylines=n.storylines.filter(s=>s.id!==9);n.storylines[0].turns=[4,5];});
   const lineage=r.corpus.deriveLineage(r.snapshot,r.snap());
   results.push({units:plain(units),keys,rows:plain(read.rows),graph,lineage:plain(lineage),ranking:plain(retrieval.selection.map(s=>({identity:s.identity,rrf:s.rrf,ranks:s.ranks,unit:s.unit}))) });
  }
  assert.equal(JSON.stringify(results[1]),JSON.stringify(results[0]));
 });
}
for(const filename of Object.keys(pins)){
 const label=filename.includes('Full')?'Full':'Min';
 test(label+': actual registered hook payload, final observations, receipt trace and physical I/O match adopted artifact',async()=>{
  const request=()=>({messages:[{role:'system',content:'Host scenario: A enters the city.'},{role:'user',content:'A asks about the pendant promise, the city oath and what happened.'}],maxContextTokens:128000,maxResponseTokens:4096});
  for(const mode of ['direct','projection','hybrid']){
   const rows=[];
   for(const dir of [reference,root]){
    const r=await setup(path.join(dir,'dist',filename));
    r.chat.message=Array.from({length:10},(_,i)=>[{role:'user',data:'A asks about the pendant '+i},{role:'assistant',data:'A replies in the city '+i}]).flat();
    const key=r.api.LibraDataStorage.storageKeyFor(r.api.LibraDataStorage.scopeKeyFor(r.char,r.chat));
    r.store.set(key,JSON.stringify({scopeKey:r.api.LibraDataStorage.scopeKeyFor(r.char,r.chat),entries:clone(r.original)}));
    r.api.MemoryEngine.CONFIG.injectionUnknownHostCapTokens=8000;r.api.MemoryEngine.CONFIG.injectionBudgetMaxTokens=16000;
    r.api.MemoryEngine.CONFIG.libraInjectionMode=mode;r.api.MemoryEngine.CONFIG.libraProjectionAlwaysActive=true;
    const before=r.store.get(key),io={reads:0,writes:0},get=r.storage.getItem,set=r.storage.setItem;
    r.storage.getItem=async(...args)=>{io.reads++;return get(...args);};r.storage.setItem=async(...args)=>{io.writes++;return set(...args);};
    const payload=await r.api.libraBeforeRequestReplacer(request(),'model'),last=r.context.__QUEUE_TEST__.rollout.inspect().last,observation=r.consumer.deliveryObservation(payload);
    assert.equal(r.store.get(key),before,'hook must not rewrite canonical input');assert.equal(r.state.calls.length,0);
    assert.equal(last.consumer.ok,true);assert.ok(io.reads>0,'actual physical reads continue');
    if(mode==='direct'){assert.equal(observation.status,'delivered');assert.ok(observation.emittedBlockCount>0);assert.ok(observation.knownAnchorCount>0);}
    rows.push({payload:JSON.stringify(payload),observation:plain(observation),consumer:plain(last.consumer),io});
   }
   assert.deepEqual(rows[1],rows[0],mode+' actual hook parity including observations and I/O');
  }
 });
}
