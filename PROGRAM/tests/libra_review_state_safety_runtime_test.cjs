'use strict';
const assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {serverFixture,fiveMore}=require('./fixtures/libra_server_runtime_fixture.cjs');
const ev=(ref,quote)=>[{ref,quote}];
const fact=(id,subject,kind,values,ref,quote,domain='character')=>({tempFactId:id,subjectTempRef:subject,claimKind:kind,domain,values,text:quote,temporalRole:'current_sequence',certainty:'confirmed',evidenceSpans:ev(ref,quote)});
(async()=>{
 for(const mode of ['plugin_only','mirror','server_only']){
  const server=mode==='plugin_only'?null:await serverFixture({mode});let f=server?.f||await fixture();
  try{
   const gold='민아는 금발 머리를 지녔다.',full='김민아는 붉은 눈을 지녔다.',touch='민아는 머리를 만졌다.',old='민아는 좁은 방에 있다.';
   f.chat.message[3].data+=' '+[gold,full,touch].join(' ');f.chat.message[9].data+=' '+old;
   // Exactly 240 chars before the feature starts with whitespace. Ownership
   // offsets must not be shifted by Core.string() trimming that prefix.
   f.chat.message[9].data+=' '+' '+ '문'.repeat(234)+' 민아의 흰 머리카락이 내려왔다.';
   const first=f.control.artifact;first.schema='libra.canonical_artifact.v5';
   first.entities.push({tempId:'full',name:'김민아',type:'person',kind:'person',evidenceSpans:ev('t2-a',full)},
    {tempId:'oldroom',name:'좁은 방',type:'world',kind:'location',evidenceSpans:ev('t5-a',old)});
   first.facts=first.facts.filter(f=>f.claimKind!=='location');
   first.facts.push(fact('oldloc','mina','location',{locationRef:'oldroom'},'t5-a',old),
    fact('gold','mina','character_appearance',{appearance:['금발 머리']},'t2-a',gold),
    fact('missing','mina','character_appearance',{appearance:['은발 머리']},'t2-a',touch),
    fact('wrongowner','mina','character_appearance',{appearance:['붉은 눈']},'t2-a',full),
    fact('fullowner','full','character_appearance',{appearance:['붉은 눈']},'t2-a',full));
   assert.equal((await f.run()).completed,1);
   const memory=f.getMemory(),head=f.getHead(),oldId=head.characters.find(c=>c.name==='민아').state.locationRef;
   assert.equal(memory.canonicalArtifact.facts.find(f=>f.tempFactId==='missing').claimKind,'character_note');
   assert.equal(memory.canonicalArtifact.facts.find(f=>f.tempFactId==='wrongowner').claimKind,'character_note');
   assert.ok(head.characters.find(c=>c.name==='민아').state.appearance.includes('금발 머리'));
   assert.ok(!head.characters.find(c=>c.name==='민아').state.appearance.includes('붉은 눈'));
   assert.ok(head.characters.find(c=>c.name==='김민아').state.appearance.includes('붉은 눈'));
   assert.ok(head.characters.find(c=>c.name==='민아').state.appearance.includes('흰 머리카락'),'source completion retains valid attributes after a whitespace-prefixed evidence window');
   fiveMore(f);const quote='민아는 폐공장 앞에 서 있다. 이곳은 어둡다.';
   f.chat.message[19].data+=' '+quote;
   const next=f.control.artifact;next.schema='libra.canonical_artifact.v5';next.facts=next.facts.filter(f=>f.claimKind!=='location');
   next.entities.push({tempId:'here',name:'이곳',type:'world',kind:'location',evidenceSpans:ev('t10-a',quote)});
   next.facts.push(fact('newloc','mina','location',{locationRef:'here'},'t10-a',quote),fact('here_desc','here','world_description',{description:['이곳은 어둡다.']},'t10-a',quote,'world'));
   // Micro must hold this same proposal instead of inventing a global "이곳" ID.
   f.control.onCall=async()=>{
    const {receipt}=await f.r.api.debugReadActiveCompletedTurnReceipt(10),body=receipt.assistant.text,at=body.indexOf(quote);
    return {type:'success',result:JSON.stringify({schema:'libra.micro_producer_envelope.v1',personCandidates:{spans:[],relations:[]},micro:{schema:'libra.micro_memory.v1',scopeKey:receipt.scopeKey,worldlineId:receipt.worldlineId,sessionEpoch:receipt.sessionEpoch,turn:10,sourceRevisionId:receipt.revisionId,sourceDigest:receipt.sourceDigest,
     claims:[{changeKind:'person',text:quote,actor:'민아',target:'',temporalRole:'current',certainty:'confirmed',epistemicStatus:'observed',stateChangeType:'set',stateIntent:{domain:'character',target:{entityName:'민아'},field:'locationRef',operation:'set',value:'이곳'},evidence:{role:'assistant',messageId:receipt.assistant.chatId,startOffset:at,endOffset:at+quote.length,exactQuote:quote}}]}})};
   };
   const inventory=await f.r.api.listReanalysisRanges({kind:'micro'});
   assert.equal((await f.r.api.reanalyzeSelectedRanges({...inventory,ranges:inventory.ranges.filter(r=>r.start===10)})).ok,true);
   const admission=await f.r.api.debugAdmitActiveMicroStateClaim(10,0);
   assert.equal(admission.status,'pending');assert.equal(admission.reason,'registry_location_unresolved');
   f.control.onCall=null;assert.equal((await f.run()).completed,1);
   assert.ok(f.getMemory(6).canonicalArtifact.facts.some(f=>f.tempFactId==='here_desc'),'unresolved observation stays in canonical memory');
   assert.ok(f.getHead().unifiedApplied.pending.some(p=>p.reason==='location_context_unresolved'));
   const room=f.getHead().world.find(w=>w.id===oldId);
   assert.ok(!room?.state?.description?.includes('이곳은 어둡다.'),'new-place description never becomes an old-room fact');
   assert.ok(!f.getHead().world.some(w=>w.name==='이곳'),'unresolved deictic does not create a globally reusable location');
   const stable=()=>JSON.stringify([f.getHead().characters,f.getHead().world,f.getHead().unifiedApplied.pending]);const before=stable();
   assert.equal((await f.r.api.rebuildWorldManagerState()).ok,true);assert.equal(stable(),before);
   if(server){f=await server.restart();assert.equal(stable(),before);}
   else{const restart=await fixture({snapshot:{chat:f.chat,values:[...f.r.values]}});try{assert.equal(JSON.stringify([restart.getHead().characters,restart.getHead().world,restart.getHead().unifiedApplied.pending]),before);}finally{await restart.r.cleanup();}}
   console.log('PASS',mode,'review location hold, shorthand colour, whole-name ownership, memory retention and replay/restart');
  }finally{if(server)await server.cleanup();else await f.r.cleanup();}
 }
 // A legacy store may already contain a generic location name. Seed that
 // historical shape through the normal writer with only the old allocation
 // policy restored, then load it into an unmodified current runtime.
 const legacy=await fixture({transformSource:s=>s.replace("else{pending.push({entity:e.tempId,reason:'location_context_unresolved'});continue;}","else{/* fixture: pre-review generic-place allocation */}")});
 let current;
 try{
  const old='민아는 방에 있다.';legacy.chat.message[9].data+=' '+old;
  const a=legacy.control.artifact;a.schema='libra.canonical_artifact.v5';a.facts=a.facts.filter(f=>f.claimKind!=='location');
  a.entities.push({tempId:'old_generic',name:'방',type:'world',kind:'location',evidenceSpans:ev('t5-a',old)});
  a.facts.push(fact('oldgenericloc','mina','location',{locationRef:'old_generic'},'t5-a',old));
  assert.equal((await legacy.run()).completed,1);
  const oldId=legacy.getHead().characters.find(c=>c.name==='민아').state.locationRef;
  assert.equal(legacy.getHead().world.find(w=>w.id===oldId).name,'방');
  current=await fixture({snapshot:{chat:legacy.chat,values:[...legacy.r.values]}});fiveMore(current);
  const quote='민아는 폐공장의 방에 서 있다. 방은 어둡다.';current.chat.message[11].data+=' '+quote;
  current.control.onCall=async()=>{
   const {receipt}=await current.r.api.debugReadActiveCompletedTurnReceipt(6),body=receipt.assistant.text,at=body.indexOf(quote);
   return {type:'success',result:JSON.stringify({schema:'libra.micro_producer_envelope.v1',personCandidates:{spans:[],relations:[]},micro:{schema:'libra.micro_memory.v1',scopeKey:receipt.scopeKey,worldlineId:receipt.worldlineId,sessionEpoch:receipt.sessionEpoch,turn:6,sourceRevisionId:receipt.revisionId,sourceDigest:receipt.sourceDigest,
    claims:[{changeKind:'world',text:quote,actor:'민아',target:'방',temporalRole:'current',certainty:'confirmed',epistemicStatus:'observed',stateChangeType:'set',stateIntent:{domain:'world',target:{entityName:'방'},field:'description',operation:'set',value:'방은 어둡다.'},evidence:{role:'assistant',messageId:receipt.assistant.chatId,startOffset:at,endOffset:at+quote.length,exactQuote:quote}}]}})};
  };
  const inventory=await current.r.api.listReanalysisRanges({kind:'micro'});
  assert.equal((await current.r.api.reanalyzeSelectedRanges({...inventory,ranges:inventory.ranges.filter(r=>r.start===6)})).ok,true);
  assert.equal((await current.r.api.debugAdmitActiveMicroStateClaim(6,0)).status,'pending','omitted kind must not bypass a known location context check');
  current.control.onCall=null;const next=current.control.artifact;next.schema='libra.canonical_artifact.v5';next.facts=next.facts.filter(f=>f.claimKind!=='location');
  next.entities.push({tempId:'generic_other',name:'방',type:'world',kind:'other',evidenceSpans:ev('t6-a',quote)});
  next.facts.push(fact('ambiguous_desc','generic_other','world_description',{description:['방은 어둡다.']},'t6-a',quote,'world'));
  assert.equal((await current.run()).completed,1);
  assert.ok(!current.getHead().world.find(w=>w.id===oldId)?.state?.description?.includes('방은 어둡다.'));
  assert.ok(current.getHead().unifiedApplied.pending.some(p=>p.reason==='location_context_unresolved'));
  console.log('PASS legacy generic location cannot bypass the new checks through omitted/other kind');
 }finally{if(current)await current.r.cleanup();await legacy.r.cleanup();}
})().catch(e=>{console.error(e);process.exitCode=1;});
