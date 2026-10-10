'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {setup,clone}=require('./libra_typed_consumer_projection_support.cjs');
const reference=process.env.LIBRA_BINDING_REFERENCE_ROOT;assert.ok(reference,'explicit independent reference required');
const root=path.resolve(__dirname,'..');
const memoryChange=(r,fn)=>{
  const e=r.chat.localLore.find(x=>x.key==='lmai_memory::promise'),m=e.content.match(/^\[META:(\{[^\r\n]*\})\]\s*([\s\S]*)$/),meta=JSON.parse(m[1]);let body=m[2];
  const next=fn(meta,body);if(next!==undefined)body=next;
  r.api.IntegrityMetaManager.annotateMemoryMeta(meta,body,{domain:'memory',recordSchema:'libra.memory.entry.v1',recordId:'promise',scopeKey:r.snapshot.scopeKey,turn:meta.t});
  e.content='[META:'+JSON.stringify(meta)+']\n'+body;
};
const entity=(r,fn,options={})=>r.change('lmai_entity',fn,{id:'promise',...options});
const graph=(r,fn,options={})=>r.change('lmai_world_graph',fn,options);
const story=(r,fn,options={})=>r.change('lmai_narrative',fn,options);
const codex=(r,fn)=>r.change('lmai_world_additional',fn);
const by=(family,id,subtype)=>r=>r.select(family,id,subtype);
const mem=by('memory','promise'),ent=by('entity','promise'),world=by('world','world_old_tower'),narr=by('narrative','8'),fact=by('world','wc-oath');
const scenarios=[
 ['same-ID signed memory content',mem,r=>memoryChange(r,(m,b)=>b+' changed current body')],
 ['same-ID signed entity content',ent,r=>entity(r,e=>e.currentState.summary='Changed current state')],
 ['entity rename and aliases',ent,r=>entity(r,e=>{e.name='Renamed person';e.meta.aliases=['Minji','민지'];})],
 ['related relation signed change',ent,r=>r.change('lmai_relation',e=>e.currentStatus.summary='Changed relationship')],
 ['related relation unsigned corruption',ent,r=>r.change('lmai_relation',e=>e.currentStatus.summary='Corrupt relation',{sign:false})],
 ['ambiguous relation alias',ent,r=>r.change('lmai_entity',e=>e.meta.aliases=['Minji'],{id:'partner'}),r=>r.change('lmai_relation',e=>e.entityA='Minji')],
 ['inherited parent name',world,r=>graph(r,g=>g.nodes[0][1].name='Changed inherited parent')],
 ['inherited parent rule',world,r=>graph(r,g=>g.nodes[0][1].rules.custom.oath='Changed inherited oath')],
 ['signed narrative parent',narr,r=>story(r,n=>n.storylines[0].continuityBrief='Changed narrative')],
 ['unsigned graph parent corruption',world,r=>graph(r,g=>g.nodes[0][1].name='Corrupt signed graph',{sign:false})],
 ['unsigned narrative parent corruption',narr,r=>story(r,n=>n.storylines[0].name='Corrupt signed narrative',{sign:false})],
 ['record deletion',ent,r=>{r.chat.localLore=r.chat.localLore.filter(e=>!(e.comment==='lmai_entity'&&JSON.parse(e.content).id==='promise'));}],
 ...['tombstone','hiddenFromPrompt','inactive','superseded'].map(kind=>['record '+kind,ent,r=>entity(r,e=>{if(kind==='inactive')e.active=false;else if(kind==='superseded')e.meta.status='superseded';else e.meta[kind]=true;})]),
 ['duplicate identity',ent,r=>{r.chat.localLore.push(clone(r.chat.localLore.find(e=>e.key==='lmai_entity::민지')));}],
 ['duplicate singleton graph',world,r=>{r.chat.localLore.push({...clone(r.chat.localLore.find(e=>e.comment==='lmai_world_graph')),key:'duplicate-graph'});}],
 ['duplicate singleton narrative',narr,r=>{r.chat.localLore.push({...clone(r.chat.localLore.find(e=>e.comment==='lmai_narrative')),key:'duplicate-narrative'});}],
 ['duplicate graph node',world,r=>graph(r,g=>g.nodes.push(clone(g.nodes[1])))],
 ['missing parent',world,r=>graph(r,g=>g.nodes[1][1].parent='missing-parent')],
 ['cyclic parent',world,r=>graph(r,g=>g.nodes[0][1].parent='world_old_tower')],
 ['changed narrative memoryRefs',narr,r=>story(r,n=>n.storylines[0].memoryRefs=['nonexistent-memory'])],
 ['deleted narrative memoryRef source',narr,r=>{r.chat.localLore=r.chat.localLore.filter(e=>e.key!=='lmai_memory::promise');}],
 ['codex disabled',fact,r=>codex(r,c=>c.worldCodex[0].injectionDisabled=true)],
 ['codex deletedItemKeys',fact,r=>codex(r,c=>c.deletedItemKeys=['codex:id:wc-oath'])],
 ['memory TTL advances',mem,r=>{r.nextOptions={currentTurn:30};},r=>memoryChange(r,m=>{m.ttl=20;})],
 ['memory ephemeral drift',mem,r=>{r.nextOptions={ephemeralDriftExclusion:{scopeKey:r.snapshot.worldlineScopeKey,reason:'rollback',turns:new Set([4]),metadata:new Map([[4,{reason:'rollback'}]])}};}],
 ['branch revocation',mem,r=>{r.chat.branchId='another-branch';}],
 ['scope revocation',mem,r=>{r.chat.id='foreign-chat';}],
 ['viewer revocation',mem,r=>{r.nextOptions={viewerId:'foreign-viewer'};}]
];
for(const filename of ['LIBRA World Manager Full.js','LIBRA World Manager.js']){
 const label=filename.includes('Full')?'Full':'Min';
 test(label+': production binding negative matrix matches independent reference and excludes stale direct/projection/hybrid payload',async()=>{
  const runtimes=[await setup(path.join(reference,'dist',filename)),await setup(path.join(root,'dist',filename))];
  for(const [name,choose,change,before]of scenarios){
   const outcomes=[];
   for(const r of runtimes){
    r.reset();r.chat.id='anchor-memo';delete r.chat.branchId;r.nextOptions={};
    if(before)before(r);r.snapshot=r.snap();r.all=r.corpus.enumerate(r.snapshot);r.eligible=r.all.filter(u=>r.corpus.adapters[u.family].eligibility(u,r.snapshot).eligible);
    const unit=choose(r);assert.ok(unit,name+' starts eligible');const composition=r.compose([unit]);change(r);
    const modes=[];
    for(const mode of ['direct','projection','hybrid']){
     const output=r.finish(composition,mode,()=>r.snap(r.nextOptions));
     assert.equal(output.directBlocks.length+output.projectionEntries.length,0,name+' '+mode+' excludes stale binding');
     assert.ok(output.trace.drops.length,name+' rejects visibly');modes.push(clone(output));
    }
    outcomes.push(modes);
   }
   assert.deepEqual(outcomes[1],outcomes[0],name+' exact negative parity');
  }
 });
 test(label+': final formatter, request, receipt and later verification boundaries stay fresh on production policy',async()=>{
  const runtimes=[await setup(path.join(reference,'dist',filename)),await setup(path.join(root,'dist',filename))];
  const results=[];
  for(const r of runtimes){
   const rows=[];r.policy=clone(r.policy);
   for(const mode of ['direct','projection','hybrid']){
    for(const action of ['exclusion','secret','earlier-block','nonce']){
     r.reset();r.snapshot=r.snap();r.all=r.corpus.enumerate(r.snapshot);r.eligible=r.all.filter(u=>r.corpus.adapters[u.family].eligibility(u,r.snapshot).eligible);delete r.policy.exclusions;
     let current=true;const entityUnit=ent(r),memory=mem(r),adapter=r.corpus.adapters.entity,original=adapter.formatter;
     const selection=action==='earlier-block'?[memory,entityUnit]:[entityUnit],com=r.compose(selection,[],()=>current);
     adapter.formatter=(...args)=>{const blocks=original(...args);
      if(action==='exclusion')r.policy.exclusions={identities:[entityUnit.identity]};
      if(action==='secret')entity(r,e=>e.meta.secret=true);
      if(action==='earlier-block')memoryChange(r,(m,b)=>b+' changed during later formatter');
      if(action==='nonce')current=false;
      return blocks;
     };
     let output;try{output=r.finish(com,mode);}finally{adapter.formatter=original;}
     if(action==='earlier-block'){assert.ok(!output.directBlocks.some(b=>b.identity===memory.identity));assert.ok(!output.projectionEntries.some(e=>e.content.includes(memory.identity)));}
     else assert.equal(output.directBlocks.length+output.projectionEntries.length,0,action+' '+mode);
     rows.push({mode,action,output:clone(output)});
    }
    r.reset();delete r.policy.exclusions;r.snapshot=r.snap();r.all=r.corpus.enumerate(r.snapshot);r.eligible=r.all.filter(u=>r.corpus.adapters[u.family].eligibility(u,r.snapshot).eligible);
    const com=r.compose([mem(r)]),output=r.finish(com,mode);assert.equal(r.consumer.verified(output),true);
    memoryChange(r,(m,b)=>b+' changed after finalize');assert.equal(r.consumer.verified(output),false,'source change before verified');
    const forged=r.consumer.finalize({sections:clone(com.sections),currentSnapshot:()=>r.snap(),policy:r.policy,mode,budget:{maxTokens:100000,maxChars:400000}});
    assert.equal(forged.ok,false);assert.equal(forged.trace.status,'unverified_sections');rows.push({mode,lateSourceRejected:true,forged:clone(forged)});
   }
   results.push(rows);
  }
  assert.deepEqual(results[1],results[0]);
 });
}
for(const filename of ['LIBRA World Manager Full.js','LIBRA World Manager.js']){
 const label=filename.includes('Full')?'Full':'Min';
 test(label+': rolled-back state/summary/codex and mixed live narrative evidence retain production payload and anchor parity',async()=>{
  const results=[];
  for(const dir of [reference,root]){
   const r=await setup(path.join(dir,'dist',filename));
   story(r,n=>{const s=n.storylines[0];s.turns=[3,4];s.evidenceTurns=[3,4];s.recentEvents=[{turn:3,text:'LIVE_3_CANARY'},{turn:4,text:'ROLLED_4_CANARY'}];});
   codex(r,c=>c.worldCodex[0].updatedTurn=4);
   r.snapshot=r.snap();r.all=r.corpus.enumerate(r.snapshot);r.eligible=r.all.filter(u=>r.corpus.adapters[u.family].eligibility(u,r.snapshot).eligible);
   const chosen=[mem(r),world(r),narr(r),fact(r),by('world','4','state_turn')(r),by('world','summary-4','state_summary')(r)];assert.ok(chosen.every(Boolean));
   const stale=r.compose(chosen);
   const pairs=[1,2,3,4].map(t=>({pairIndex:t,userText:'u'+t,assistantText:'a'+t}));
   await r.api.LibraTurnWorldline.observe(r.snapshot.worldlineScopeKey,pairs,{now:1000});
   await r.api.LibraTurnWorldline.observe(r.snapshot.worldlineScopeKey,pairs.slice(0,3),{now:2000});
   const rolled=r.snap(),all=r.corpus.enumerate(rolled);
   const freshNarr=all.find(u=>u.family==='narrative'&&u.locator.id==='8');assert.ok(freshNarr.partial);
   assert.match(freshNarr.text,/LIVE_3_CANARY/);assert.ok(!freshNarr.text.includes('ROLLED_4_CANARY'));
   assert.equal(r.corpus.inspect(freshNarr,rolled).eligible,true);
   for(const unit of chosen.filter(u=>u.family==='memory'||['state_turn','state_summary','codex_fact'].includes(u.subtype)))assert.equal(r.corpus.inspect(r.corpus.resolve(unit.identity,rolled),rolled).eligible,false,unit.subtype+' rollback');
   const freshWorld=r.corpus.resolve(chosen[1].identity,rolled);assert.ok(!freshWorld.text.includes('탑은 밤에만 열린다'),'rolled-back promoted rule absent');
   const modes=[];
   for(const mode of ['direct','projection','hybrid']){
    const rejected=r.finish(stale,mode,()=>r.snap());assert.equal(rejected.directBlocks.length+rejected.projectionEntries.length,0,'old worldline binding rejected');
    const composed=r.consumer.compose({selection:[{identity:freshNarr.identity,unit:freshNarr}],snapshot:rolled,policy:r.policy});
    const output=r.finish(composed,mode,()=>r.snap());assert.equal(output.ok,true);assert.equal(r.consumer.verified(output),true);
    const payload={messages:[{role:'system',content:'[LIBRA Test Injection]\n'+output.directBlocks.map(b=>b.text).join('\n\n')}]};r.consumer.observeDelivery(output,payload,true);
    const observation=r.consumer.deliveryObservation(payload);
    if(mode==='direct'){assert.equal(observation.status,'delivered');assert.ok(observation.blocks[0].reasons.includes('narrative_partial_provenance'));assert.deepEqual(clone(observation.blocks[0].anchors.map(a=>a.ordinal)),[3]);}
    modes.push({rejected:clone(rejected),output:clone(output),observation:clone(observation)});
   }
   results.push(modes);
  }
  assert.deepEqual(results[1],results[0]);
 });
}
