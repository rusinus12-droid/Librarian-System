'use strict';
const assert=require('node:assert/strict');
const {serverFixture}=require('./fixtures/libra_server_runtime_fixture.cjs');
const {waitFor}=require('./fixtures/libra_vm_harness.cjs');

const MARKER='LATEST_MICRO_T21_UNIQUE_8651';
(async()=>{
 let listener;const callbackErrors=[];
 const x=await serverFixture({mode:'plugin_only',args:{live_context_enabled:'false',classic_live_tail_enabled:'false'},
  host:{addRisuChatListener:async(_kind,handler)=>{listener=handler;return true;}}});
 try{
  const {f}=x;await f.run();
  const messages=f.chat.message.slice();
  for(let turn=6;turn<=21;turn++){
   messages.push({role:'user',chatId:`t${turn}-u`,data:`User turn ${turn} continues the scene.`});
   messages.push({role:'assistant',chatId:`t${turn}-a`,data:turn===21
    ? `Assistant turn ${turn}: ${MARKER}`:`Assistant turn ${turn} continues the scene.`});
  }
  f.chat.message=messages;f.chat.messages=messages;
  f.control.onCall=async args=>{
   try{
    const rows=args[0].messages;
    if(!String(rows[0]?.content||'').includes('[LIBRA MICRO SOURCE CONTRACT]'))
     return {type:'success',result:JSON.stringify(f.control.artifact)};
    const input=JSON.parse(rows[1].content),text=input.assistant.text;
    const offset=text.indexOf(MARKER);
    const claims=input.binding.turn===21?[{changeKind:'event',text:MARKER,actor:'',target:'',
      temporalRole:'current',certainty:'confirmed',epistemicStatus:'observed',stateChangeType:'set',
      evidence:{role:'assistant',messageId:input.assistant.messageId,startOffset:offset,
       endOffset:offset+MARKER.length,exactQuote:MARKER}}]:[];
    if(input.binding.turn===21)assert.ok(offset>=0,'T21 quote belongs to captured assistant');
    return {type:'success',result:JSON.stringify({schema:'libra.micro_producer_envelope.v1',
     personCandidates:{spans:[],relations:[]},micro:{schema:'libra.micro_memory.v1',...input.binding,claims}})};
   }catch(error){callbackErrors.push(error);throw error;}
  };
  for(const turn of [18,19,21]){
   listener({char:f.character,chat:f.chat,characterIndex:0,chatIndex:0,messageIndex:turn*2-1});
   await waitFor(()=>f.r.api.getCaptureBackendState().lastMicroPublication?.turn===turn,15000);
  }
  assert.deepEqual(callbackErrors,[],'fake Micro provider had no swallowed validation error');
  await f.r.api.saveLibraProviderConfig({responseFamily:'libra',libraResponseMode:'classic'});
  const out=await f.control.hooks.beforeRequest([{role:'user',content:`Continue the latest scene about ${MARKER}.`}],'model');
  const view=f.r.api.getLastResponseContext(),frontier=f.r.api.getLastMemoryRecallViewer()?.microFrontier;
  assert.equal(view?.receiptReadSet?.requestedTurns.at(-1),21,'requested window carries real turn IDs');
  assert.ok(view.receiptReadSet.gaps.some(row=>row.turn===20),'missing T20 remains a hole');
  assert.deepEqual(Array.from(view.receiptReadSet.refs,row=>row.turn),[18,19,21]);
  assert.equal(frontier,undefined,'retired Micro-frontier is not reported by the unified route');
  const viewer=f.r.api.getLastMemoryRecallViewer();
  assert.ok(viewer.rows.some(row=>row.family==='micro'&&row.turnRange?.start===21&&String(row.text).includes(MARKER)),'latest Micro T21 is a delivered row despite the sparse receipt array');
  const injected=out.filter(row=>row.role==='system').map(row=>String(row.content||'')).join('\n');
  assert.match(injected,new RegExp(`\\[micro:[a-z_]+\\] [^\\n]*${MARKER}`),'latest Micro enters the injected final block');
  console.log(JSON.stringify({test:'libra_receipt_sparse_micro_frontier',ready:view.receiptReadSet.refs.map(r=>r.turn),
   gaps:view.receiptReadSet.gaps.map(g=>g.turn),frontier}));
 }finally{await x.cleanup();}
})().catch(error=>{console.error(error);process.exitCode=1;});
